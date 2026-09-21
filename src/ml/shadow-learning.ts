// ============================================================
// CRYPTOBOT ML — SHADOW LEARNING V0.4
// SHADOW / RESEARCH ONLY — NO TRADING
//
// Purpose:
// - Learns ONLY from completed signal_65_crossings.
// - Compares ML probability against the existing >=65 mechanical signals.
// - Predicts BEFORE learning each crossing, then updates online.
// - Does NOT modify mechanical score, signals, paper trades or forward shadows.
// - Uses only rows where first_barrier is TP or SL.
// - TIME / no-barrier rows are excluded from training for now.
//
// Features (direction-normalized to the signal side):
//   score, chart, orderFlow, oiChange, funding
//
// model.ts remains the shared ML math module.
// ============================================================

import {
  INITIAL_WEIGHTS,
  predictTP,
  learnOne,
  type MLFeatures,
  type MLWeights,
} from "./model";

export interface Env {
  DB: D1Database;
}

const MODULE = "shadow-learning";
const MODEL_KEY = "cross65_tp_vs_sl_v1";
const LEARNING_RATE = 0.03;
const MAX_ROWS_PER_RUN = 100;

type ShadowFeatures = MLFeatures & {
  oiChange: number;
};

type ShadowWeights = MLWeights & {
  oiChange: number;
};

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sideDirection(side: unknown): number {
  return String(side).toUpperCase() === "SHORT" ? -1 : 1;
}

function featureVector(row: any): ShadowFeatures {
  const dir = sideDirection(row.side);

  // Direction-normalized and scaled to roughly -1..1.
  return {
    score: clamp(Math.abs(finite(row.crossing_score)) / 100, 0, 1),
    chart: clamp((finite(row.chart_signed) * dir) / 100, -1, 1),
    orderFlow: clamp(
      (finite(row.order_flow_persistent_signed) * dir) / 100,
      -1,
      1
    ),
    oiChange: clamp(
      (finite(row.oi_change_signed) * dir) / 100,
      -1,
      1
    ),
    funding: clamp(
      (finite(row.funding_premium_signed) * dir) / 100,
      -1,
      1
    ),
  };
}

function predictShadowTP(x: ShadowFeatures, w: ShadowWeights) {
  // Reuse model.ts for the original 4 features and add OI explicitly.
  const base = predictTP(x, w);
  const baseP = clamp(base.probability, 0.000001, 0.999999);
  const baseLogit = Math.log(baseP / (1 - baseP));
  const z = baseLogit + w.oiChange * x.oiChange;
  const probability = 1 / (1 + Math.exp(-clamp(z, -20, 20)));
  return {
    probability,
    prediction: probability >= 0.5 ? "TP" : "NOT_TP",
  };
}

function learnShadowOne(
  x: ShadowFeatures,
  y: 0 | 1,
  w: ShadowWeights,
  learningRate = LEARNING_RATE
): ShadowWeights {
  const p = predictShadowTP(x, w).probability;
  const e = y - p;
  return {
    bias: w.bias + learningRate * e,
    score: w.score + learningRate * e * x.score,
    chart: w.chart + learningRate * e * x.chart,
    orderFlow: w.orderFlow + learningRate * e * x.orderFlow,
    oiChange: w.oiChange + learningRate * e * x.oiChange,
    funding: w.funding + learningRate * e * x.funding,
  };
}

function labelFromRow(row: any): 0 | 1 | null {
  const barrier = String(row.first_barrier ?? "").toUpperCase();
  if (barrier === "TP") return 1;
  if (barrier === "SL") return 0;
  return null;
}

async function ensureTables(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS ml_module_health (
      module TEXT PRIMARY KEY,
      runs INTEGER NOT NULL DEFAULT 0,
      last_run TEXT,
      status TEXT NOT NULL DEFAULT 'NEW'
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS ml_shadow_model (
      model_key TEXT PRIMARY KEY,
      bias REAL NOT NULL DEFAULT 0,
      weight_score REAL NOT NULL DEFAULT 0,
      weight_chart REAL NOT NULL DEFAULT 0,
      weight_order_flow REAL NOT NULL DEFAULT 0,
      weight_oi_change REAL NOT NULL DEFAULT 0,
      weight_funding REAL NOT NULL DEFAULT 0,
      samples_trained INTEGER NOT NULL DEFAULT 0,
      tp_labels INTEGER NOT NULL DEFAULT 0,
      sl_labels INTEGER NOT NULL DEFAULT 0,
      learning_rate REAL NOT NULL DEFAULT 0.03,
      last_crossing_ts INTEGER,
      last_crossing_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS ml_shadow_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crossing_id INTEGER NOT NULL UNIQUE,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      crossing_ts INTEGER NOT NULL,
      crossing_datetime TEXT,
      crossing_score REAL NOT NULL,

      feature_score REAL NOT NULL,
      feature_chart REAL NOT NULL,
      feature_order_flow REAL NOT NULL,
      feature_oi_change REAL NOT NULL,
      feature_funding REAL NOT NULL,

      predicted_tp_probability REAL NOT NULL,
      predicted_class INTEGER NOT NULL,
      actual_label INTEGER NOT NULL,
      actual_barrier TEXT NOT NULL,
      prediction_correct INTEGER NOT NULL,

      model_samples_before INTEGER NOT NULL,
      model_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // V0.4 safe migration for databases created by V0.2/V0.3.
  try {
    await env.DB.prepare(`
      ALTER TABLE ml_shadow_model
      ADD COLUMN weight_oi_change REAL NOT NULL DEFAULT 0
    `).run();
  } catch (_) {}

  try {
    await env.DB.prepare(`
      ALTER TABLE ml_shadow_predictions
      ADD COLUMN feature_oi_change REAL NOT NULL DEFAULT 0
    `).run();
  } catch (_) {}

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_ml_shadow_predictions_ts
    ON ml_shadow_predictions (crossing_ts DESC)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_ml_shadow_predictions_coin
    ON ml_shadow_predictions (coin, crossing_ts DESC)
  `).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO ml_shadow_model (
      model_key,
      bias,
      weight_score,
      weight_chart,
      weight_order_flow,
      weight_oi_change,
      weight_funding,
      samples_trained,
      tp_labels,
      sl_labels,
      learning_rate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
  `).bind(
    MODEL_KEY,
    INITIAL_WEIGHTS.bias,
    INITIAL_WEIGHTS.score,
    INITIAL_WEIGHTS.chart,
    INITIAL_WEIGHTS.orderFlow,
    0,
    INITIAL_WEIGHTS.funding,
    LEARNING_RATE
  ).run();
}

async function loadModel(env: Env): Promise<{
  weights: ShadowWeights;
  samples: number;
  tpLabels: number;
  slLabels: number;
}> {
  const row: any = await env.DB.prepare(`
    SELECT *
    FROM ml_shadow_model
    WHERE model_key = ?
    LIMIT 1
  `).bind(MODEL_KEY).first();

  if (!row) {
    return {
      weights: { ...INITIAL_WEIGHTS, oiChange: 0 },
      samples: 0,
      tpLabels: 0,
      slLabels: 0,
    };
  }

  return {
    weights: {
      bias: finite(row.bias),
      score: finite(row.weight_score),
      chart: finite(row.weight_chart),
      orderFlow: finite(row.weight_order_flow),
      oiChange: finite(row.weight_oi_change),
      funding: finite(row.weight_funding),
    },
    samples: Math.max(0, Math.trunc(finite(row.samples_trained))),
    tpLabels: Math.max(0, Math.trunc(finite(row.tp_labels))),
    slLabels: Math.max(0, Math.trunc(finite(row.sl_labels))),
  };
}

async function saveModel(
  env: Env,
  weights: ShadowWeights,
  samples: number,
  tpLabels: number,
  slLabels: number,
  lastRow: any
): Promise<void> {
  await env.DB.prepare(`
    UPDATE ml_shadow_model
    SET
      bias = ?,
      weight_score = ?,
      weight_chart = ?,
      weight_order_flow = ?,
      weight_oi_change = ?,
      weight_funding = ?,
      samples_trained = ?,
      tp_labels = ?,
      sl_labels = ?,
      learning_rate = ?,
      last_crossing_ts = ?,
      last_crossing_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE model_key = ?
  `).bind(
    weights.bias,
    weights.score,
    weights.chart,
    weights.orderFlow,
    weights.oiChange,
    weights.funding,
    samples,
    tpLabels,
    slLabels,
    LEARNING_RATE,
    lastRow?.crossing_ts ?? null,
    lastRow?.id ?? null,
    MODEL_KEY
  ).run();
}

async function markHealth(env: Env): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO ml_module_health (module, runs, last_run, status)
    VALUES (?, 1, CURRENT_TIMESTAMP, 'OK')
    ON CONFLICT(module) DO UPDATE SET
      runs = runs + 1,
      last_run = CURRENT_TIMESTAMP,
      status = 'OK'
  `).bind(MODULE).run();
}

export async function updateMLShadowLearning(env: Env): Promise<any> {
  await ensureTables(env);

  // Only fully resolved TP/SL examples are valid labels.
  // LEFT JOIN prevents the same crossing from ever being learned twice.
  const pending: any = await env.DB.prepare(`
    SELECT c.*
    FROM signal_65_crossings c
    LEFT JOIN ml_shadow_predictions p
      ON p.crossing_id = c.id
    WHERE c.outcome_complete = 1
      AND c.first_barrier IN ('TP', 'SL')
      AND p.crossing_id IS NULL
    ORDER BY c.crossing_ts ASC, c.id ASC
    LIMIT ?
  `).bind(MAX_ROWS_PER_RUN).all();

  let model = await loadModel(env);
  let weights: ShadowWeights = { ...model.weights };
  let samples = model.samples;
  let tpLabels = model.tpLabels;
  let slLabels = model.slLabels;

  let processed = 0;
  let correct = 0;
  let lastRow: any = null;

  for (const row of pending?.results ?? []) {
    const label = labelFromRow(row);
    if (label === null) continue;

    const features = featureVector(row);

    // IMPORTANT: prediction is generated using the model as it existed
    // BEFORE this crossing is learned. This keeps the stored result honest.
    const prediction = predictShadowTP(features, weights);
    const probability = prediction.probability;
    const predictedClass = prediction.prediction === "TP" ? 1 : 0;
    const isCorrect = predictedClass === label ? 1 : 0;

    await env.DB.prepare(`
      INSERT OR IGNORE INTO ml_shadow_predictions (
        crossing_id,
        coin,
        side,
        crossing_ts,
        crossing_datetime,
        crossing_score,
        feature_score,
        feature_chart,
        feature_order_flow,
        feature_oi_change,
        feature_funding,
        predicted_tp_probability,
        predicted_class,
        actual_label,
        actual_barrier,
        prediction_correct,
        model_samples_before,
        model_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.id,
      row.coin,
      row.side,
      row.crossing_ts,
      row.crossing_datetime ?? null,
      finite(row.crossing_score),
      features.score,
      features.chart,
      features.orderFlow,
      features.oiChange,
      features.funding,
      probability,
      predictedClass,
      label,
      label === 1 ? "TP" : "SL",
      isCorrect,
      samples,
      MODEL_KEY
    ).run();

    // Online update happens only AFTER the out-of-sample-style prediction.
    weights = learnShadowOne(features, label, weights, LEARNING_RATE);

    samples += 1;
    if (label === 1) tpLabels += 1;
    else slLabels += 1;

    processed += 1;
    correct += isCorrect;
    lastRow = row;
  }

  if (processed > 0) {
    await saveModel(
      env,
      weights,
      samples,
      tpLabels,
      slLabels,
      lastRow
    );
  }

  await markHealth(env);

  return {
    module: MODULE,
    mode: "SHADOW_LEARNING",
    trading: "REAL_TRADING_DISABLED",
    model_key: MODEL_KEY,
    processed_this_run: processed,
    correct_this_run: correct,
    accuracy_this_run:
      processed > 0 ? Number((correct / processed).toFixed(4)) : null,
    samples_trained_total: samples,
    tp_labels: tpLabels,
    sl_labels: slLabels,
    learning_rate: LEARNING_RATE,
    weights,
  };
}

export async function getMLShadowStatus(env: Env): Promise<any> {
  await ensureTables(env);

  const health: any = await env.DB.prepare(`
    SELECT module, runs, last_run, status
    FROM ml_module_health
    WHERE module = ?
    LIMIT 1
  `).bind(MODULE).first();

  const model: any = await env.DB.prepare(`
    SELECT *
    FROM ml_shadow_model
    WHERE model_key = ?
    LIMIT 1
  `).bind(MODEL_KEY).first();

  const stats: any = await env.DB.prepare(`
    SELECT
      COUNT(*) AS predictions,
      SUM(prediction_correct) AS correct,
      SUM(CASE WHEN actual_label = 1 THEN 1 ELSE 0 END) AS actual_tp,
      SUM(CASE WHEN actual_label = 0 THEN 1 ELSE 0 END) AS actual_sl,
      AVG(predicted_tp_probability) AS avg_predicted_tp_probability
    FROM ml_shadow_predictions
    WHERE model_key = ?
  `).bind(MODEL_KEY).first();

  const filterRows: any = await env.DB.prepare(`
    SELECT
      threshold,
      COUNT(*) AS signals,
      SUM(CASE WHEN actual_label = 1 THEN 1 ELSE 0 END) AS tp,
      SUM(CASE WHEN actual_label = 0 THEN 1 ELSE 0 END) AS sl
    FROM (
      SELECT 0.50 AS threshold, actual_label
      FROM ml_shadow_predictions
      WHERE model_key = ? AND predicted_tp_probability >= 0.50

      UNION ALL

      SELECT 0.55 AS threshold, actual_label
      FROM ml_shadow_predictions
      WHERE model_key = ? AND predicted_tp_probability >= 0.55

      UNION ALL

      SELECT 0.60 AS threshold, actual_label
      FROM ml_shadow_predictions
      WHERE model_key = ? AND predicted_tp_probability >= 0.60

      UNION ALL

      SELECT 0.65 AS threshold, actual_label
      FROM ml_shadow_predictions
      WHERE model_key = ? AND predicted_tp_probability >= 0.65

      UNION ALL

      SELECT 0.70 AS threshold, actual_label
      FROM ml_shadow_predictions
      WHERE model_key = ? AND predicted_tp_probability >= 0.70
    )
    GROUP BY threshold
    ORDER BY threshold ASC
  `).bind(MODEL_KEY, MODEL_KEY, MODEL_KEY, MODEL_KEY, MODEL_KEY).all();

  const predictions = Math.max(0, Math.trunc(finite(stats?.predictions)));
  const correct = Math.max(0, Math.trunc(finite(stats?.correct)));
  const actualTP = Math.max(0, Math.trunc(finite(stats?.actual_tp)));
  const actualSL = Math.max(0, Math.trunc(finite(stats?.actual_sl)));
  const mechanicalRate =
    predictions > 0
      ? Number(((actualTP / predictions) * 100).toFixed(2))
      : null;

  const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70];
  const rawRows = filterRows?.results ?? [];

  const mlFilters = thresholds.map((threshold) => {
    const row = rawRows.find(
      (r: any) => Math.abs(finite(r.threshold) - threshold) < 0.0001
    );

    const signals = Math.max(0, Math.trunc(finite(row?.signals)));
    const tp = Math.max(0, Math.trunc(finite(row?.tp)));
    const sl = Math.max(0, Math.trunc(finite(row?.sl)));
    const tpRate =
      signals > 0 ? Number(((tp / signals) * 100).toFixed(2)) : null;

    return {
      minimum_ml_probability: `${Math.round(threshold * 100)}%`,
      signals_selected: signals,
      tp,
      sl,
      tp_rate_pct: tpRate,
      difference_vs_all_65_pct_points:
        tpRate != null && mechanicalRate != null
          ? Number((tpRate - mechanicalRate).toFixed(2))
          : null,
    };
  });

  // Human-readable summary for quick checking from a phone/browser.
  let simpleConclusion = "Още няма достатъчно ML прогнози за сравнение.";
  if (predictions > 0) {
    const usable = mlFilters.filter((x) => x.signals_selected >= 10);
    if (usable.length === 0) {
      simpleConclusion =
        "Има данни, но още няма ML праг с поне 10 избрани сигнала. Остави модела да събира още.";
    } else {
      const best = [...usable].sort((a, b) => {
        const ar = a.tp_rate_pct ?? -1;
        const br = b.tp_rate_pct ?? -1;
        if (br !== ar) return br - ar;
        return b.signals_selected - a.signals_selected;
      })[0];

      if (
        best.tp_rate_pct != null &&
        mechanicalRate != null &&
        best.tp_rate_pct > mechanicalRate
      ) {
        simpleConclusion =
          `Засега най-добрият наблюдаван ML филтър е ${best.minimum_ml_probability}: ` +
          `${best.tp}/${best.signals_selected} TP (${best.tp_rate_pct}%), ` +
          `с ${best.difference_vs_all_65_pct_points} процентни пункта над всички ≥65. ` +
          `Това е само наблюдение, не доказателство — извадката още е малка.`;
      } else {
        simpleConclusion =
          "Засега ML филтрите с поне 10 сигнала не подобряват TP процента на всички механични ≥65 сигнали.";
      }
    }
  }

  return {
    module: MODULE,
    runs: Math.max(0, Math.trunc(finite(health?.runs))),
    last_run: health?.last_run ?? null,
    status: health?.status ?? "NEW",

    easy_read: {
      what_are_we_testing:
        "Дали ML може да отсява по-добрите сигнали измежду вече избраните механични ≥65.",
      all_mechanical_65: {
        signals: predictions,
        tp: actualTP,
        sl: actualSL,
        tp_rate_pct: mechanicalRate,
      },
      ml_filters: mlFilters,
      how_to_read:
        "Пример: ML ≥60% означава, че взимаме само ≥65 сигналите, на които ML е дал поне 60% вероятност за TP. По-висок TP % от all_mechanical_65 е подобрение върху тази извадка.",
      simple_conclusion: simpleConclusion,
      warning:
        "Малките извадки могат да подвеждат. Не използвай този резултат за промяна на реалната стратегия, докато не натрупаме значително повече независими сигнали.",
    },

    model: {
      model_key: MODEL_KEY,
      samples_trained: Math.max(
        0,
        Math.trunc(finite(model?.samples_trained))
      ),
      tp_labels: Math.max(0, Math.trunc(finite(model?.tp_labels))),
      sl_labels: Math.max(0, Math.trunc(finite(model?.sl_labels))),
      learning_rate: finite(model?.learning_rate, LEARNING_RATE),
      weights: {
        bias: finite(model?.bias),
        score: finite(model?.weight_score),
        chart: finite(model?.weight_chart),
        orderFlow: finite(model?.weight_order_flow),
        oiChange: finite(model?.weight_oi_change),
        funding: finite(model?.weight_funding),
      },
    },

    technical_evaluation: {
      predictions,
      correct,
      classification_accuracy_pct:
        predictions > 0
          ? Number(((correct / predictions) * 100).toFixed(2))
          : null,
      actual_tp: actualTP,
      actual_sl: actualSL,
      avg_predicted_tp_probability_pct:
        stats?.avg_predicted_tp_probability == null
          ? null
          : Number(
              (finite(stats.avg_predicted_tp_probability) * 100).toFixed(2)
            ),
    },

    label_definition: "TP_FIRST=1, SL_FIRST=0",
    excluded_from_training: "TIME_OR_NO_BARRIER",
    trading: "REAL_TRADING_DISABLED",
  };
}
