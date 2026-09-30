// ============================================================
// CRYPTOBOT ML — RAW LEARNING V0.6 AI FIRST-TOUCH + V0.5 CONTROL
// RESEARCH ONLY / NO TRADING / NO EFFECT ON LIVE SYSTEM
//
// CPU FIX:
// - NO historical 500-row backfill loops.
// - Collect only the latest snapshot for each coin.
// - One batch INSERT statement per run.
// - Labels are filled with 3 set-based UPDATE statements (5m/15m/30m).
// - No per-row future-price SELECT loops.
// - Existing ml_raw_dataset is preserved.
//
// FIRST TRAINING:
// - Uses ONLY rows with a ready 30m future return.
// - Chronological split: oldest 70% TRAIN, newest 30% TEST.
// - No random split: reduces leakage from adjacent minute snapshots.
// - Simple logistic classifier: predicts UP vs DOWN after 30m.
// - Mechanical >=65 score is NOT used.
// - Training is research-only and does not affect trading/signals.
// ============================================================

export interface Env {
  DB: D1Database;
}

const MODULE = "raw-learning";

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
    CREATE TABLE IF NOT EXISTS ml_raw_dataset (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_snapshot_id INTEGER NOT NULL UNIQUE,
      coin TEXT NOT NULL,
      snapshot_ts INTEGER NOT NULL,
      snapshot_datetime TEXT,
      price REAL NOT NULL,

      chart_signed REAL,
      order_flow_signed REAL,
      open_interest REAL,
      funding REAL,
      premium REAL,

      price_5m REAL,
      return_5m_pct REAL,
      label_5m_ready INTEGER NOT NULL DEFAULT 0,

      price_15m REAL,
      return_15m_pct REAL,
      label_15m_ready INTEGER NOT NULL DEFAULT 0,

      price_30m REAL,
      return_30m_pct REAL,
      label_30m_ready INTEGER NOT NULL DEFAULT 0,

      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_ml_raw_dataset_coin_ts
    ON ml_raw_dataset (coin, snapshot_ts)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_ml_raw_dataset_labels
    ON ml_raw_dataset (
      label_5m_ready,
      label_15m_ready,
      label_30m_ready,
      snapshot_ts
    )
  `).run();

  // Helps the set-based future-price lookups.
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_coin_ts
    ON market_snapshots (coin, ts)
  `).run();
}

// ============================================================
// COLLECT — latest snapshot per coin only
// ============================================================

async function collectLatestPerCoin(env: Env): Promise<number> {
  // At most ~20 rows with the current tracked universe.
  // One SQL statement; no JS row loop.
  const result: any = await env.DB.prepare(`
    INSERT OR IGNORE INTO ml_raw_dataset (
      source_snapshot_id,
      coin,
      snapshot_ts,
      snapshot_datetime,
      price,
      chart_signed,
      order_flow_signed,
      open_interest,
      funding,
      premium
    )
    SELECT
      s.id,
      s.coin,
      s.ts,
      s.datetime,
      s.price,
      s.chart_signed,
      s.order_flow_signed,
      s.open_interest,
      s.funding,
      s.premium
    FROM market_snapshots s
    INNER JOIN (
      SELECT coin, MAX(ts) AS max_ts
      FROM market_snapshots
      GROUP BY coin
    ) latest
      ON latest.coin = s.coin
     AND latest.max_ts = s.ts
    WHERE s.price IS NOT NULL
      AND s.price > 0
      AND NOT EXISTS (
        SELECT 1
        FROM ml_raw_dataset r
        WHERE r.source_snapshot_id = s.id
      )
  `).run();

  return Math.max(0, Math.trunc(num(result?.meta?.changes)));
}

// ============================================================
// LABELS — set based, no per-row loops
// ============================================================

async function fill5m(env: Env): Promise<number> {
  const result: any = await env.DB.prepare(`
    UPDATE ml_raw_dataset
    SET
      price_5m = (
        SELECT s.price
        FROM market_snapshots s
        WHERE s.coin = ml_raw_dataset.coin
          AND s.ts >= ml_raw_dataset.snapshot_ts + 300000
          AND s.ts <= ml_raw_dataset.snapshot_ts + 420000
          AND s.price IS NOT NULL
          AND s.price > 0
        ORDER BY s.ts ASC
        LIMIT 1
      ),
      return_5m_pct = (
        (
          SELECT s.price
          FROM market_snapshots s
          WHERE s.coin = ml_raw_dataset.coin
            AND s.ts >= ml_raw_dataset.snapshot_ts + 300000
            AND s.ts <= ml_raw_dataset.snapshot_ts + 420000
            AND s.price IS NOT NULL
            AND s.price > 0
          ORDER BY s.ts ASC
          LIMIT 1
        ) / price - 1.0
      ) * 100.0,
      label_5m_ready = 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE label_5m_ready = 0
      AND snapshot_ts <= ? - 300000
      AND EXISTS (
        SELECT 1
        FROM market_snapshots s
        WHERE s.coin = ml_raw_dataset.coin
          AND s.ts >= ml_raw_dataset.snapshot_ts + 300000
          AND s.ts <= ml_raw_dataset.snapshot_ts + 420000
          AND s.price IS NOT NULL
          AND s.price > 0
      )
  `).bind(Date.now()).run();

  return Math.max(0, Math.trunc(num(result?.meta?.changes)));
}

async function fill15m(env: Env): Promise<number> {
  const result: any = await env.DB.prepare(`
    UPDATE ml_raw_dataset
    SET
      price_15m = (
        SELECT s.price
        FROM market_snapshots s
        WHERE s.coin = ml_raw_dataset.coin
          AND s.ts >= ml_raw_dataset.snapshot_ts + 900000
          AND s.ts <= ml_raw_dataset.snapshot_ts + 1020000
          AND s.price IS NOT NULL
          AND s.price > 0
        ORDER BY s.ts ASC
        LIMIT 1
      ),
      return_15m_pct = (
        (
          SELECT s.price
          FROM market_snapshots s
          WHERE s.coin = ml_raw_dataset.coin
            AND s.ts >= ml_raw_dataset.snapshot_ts + 900000
            AND s.ts <= ml_raw_dataset.snapshot_ts + 1020000
            AND s.price IS NOT NULL
            AND s.price > 0
          ORDER BY s.ts ASC
          LIMIT 1
        ) / price - 1.0
      ) * 100.0,
      label_15m_ready = 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE label_15m_ready = 0
      AND snapshot_ts <= ? - 900000
      AND EXISTS (
        SELECT 1
        FROM market_snapshots s
        WHERE s.coin = ml_raw_dataset.coin
          AND s.ts >= ml_raw_dataset.snapshot_ts + 900000
          AND s.ts <= ml_raw_dataset.snapshot_ts + 1020000
          AND s.price IS NOT NULL
          AND s.price > 0
      )
  `).bind(Date.now()).run();

  return Math.max(0, Math.trunc(num(result?.meta?.changes)));
}

async function fill30m(env: Env): Promise<number> {
  const result: any = await env.DB.prepare(`
    UPDATE ml_raw_dataset
    SET
      price_30m = (
        SELECT s.price
        FROM market_snapshots s
        WHERE s.coin = ml_raw_dataset.coin
          AND s.ts >= ml_raw_dataset.snapshot_ts + 1800000
          AND s.ts <= ml_raw_dataset.snapshot_ts + 1920000
          AND s.price IS NOT NULL
          AND s.price > 0
        ORDER BY s.ts ASC
        LIMIT 1
      ),
      return_30m_pct = (
        (
          SELECT s.price
          FROM market_snapshots s
          WHERE s.coin = ml_raw_dataset.coin
            AND s.ts >= ml_raw_dataset.snapshot_ts + 1800000
            AND s.ts <= ml_raw_dataset.snapshot_ts + 1920000
            AND s.price IS NOT NULL
            AND s.price > 0
          ORDER BY s.ts ASC
          LIMIT 1
        ) / price - 1.0
      ) * 100.0,
      label_30m_ready = 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE label_30m_ready = 0
      AND snapshot_ts <= ? - 1800000
      AND EXISTS (
        SELECT 1
        FROM market_snapshots s
        WHERE s.coin = ml_raw_dataset.coin
          AND s.ts >= ml_raw_dataset.snapshot_ts + 1800000
          AND s.ts <= ml_raw_dataset.snapshot_ts + 1920000
          AND s.price IS NOT NULL
          AND s.price > 0
      )
  `).bind(Date.now()).run();

  return Math.max(0, Math.trunc(num(result?.meta?.changes)));
}


type RawWeights = {
  bias: number;
  chart: number;
  orderFlow: number;
  funding: number;
  premium: number;
};

type RawFeatures = {
  chart: number;
  orderFlow: number;
  funding: number;
  premium: number;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-clamp(z, -20, 20)));
}

function rawFeatures(row: any): RawFeatures {
  // Score-like values are scaled to roughly -1..1.
  // Funding/premium are much smaller raw values, so use conservative scaling.
  return {
    chart: clamp(num(row.chart_signed) / 100, -1, 1),
    orderFlow: clamp(num(row.order_flow_signed) / 100, -1, 1),
    funding: clamp(num(row.funding) * 10000, -1, 1),
    premium: clamp(num(row.premium) * 1000, -1, 1),
  };
}

function rawProbability(x: RawFeatures, w: RawWeights): number {
  return sigmoid(
    w.bias +
    w.chart * x.chart +
    w.orderFlow * x.orderFlow +
    w.funding * x.funding +
    w.premium * x.premium
  );
}

function learnRaw(
  x: RawFeatures,
  y: 0 | 1,
  w: RawWeights,
  lr = 0.03
): RawWeights {
  const p = rawProbability(x, w);
  const e = y - p;
  return {
    bias: w.bias + lr * e,
    chart: w.chart + lr * e * x.chart,
    orderFlow: w.orderFlow + lr * e * x.orderFlow,
    funding: w.funding + lr * e * x.funding,
    premium: w.premium + lr * e * x.premium,
  };
}

async function runFirstTraining(env: Env): Promise<any> {
  const MOVE_THRESHOLD_PCT = 0.30;

  // Latest 5000 completed 30m examples, ordered chronologically.
  // Neutral moves are excluded from training/evaluation.
  const data: any = await env.DB.prepare(`
    SELECT
      id, coin, snapshot_ts, chart_signed, order_flow_signed,
      funding, premium, return_30m_pct
    FROM ml_raw_dataset
    WHERE label_30m_ready = 1
      AND return_30m_pct IS NOT NULL
    ORDER BY snapshot_ts ASC, id ASC
    LIMIT 5000
  `).all();

  const allRows = data?.results ?? [];
  const directional = allRows.filter(
    (row: any) => Math.abs(num(row.return_30m_pct)) >= MOVE_THRESHOLD_PCT
  );

  const neutralCount = allRows.length - directional.length;

  if (directional.length < 100) {
    return {
      status: "WAITING_FOR_DIRECTIONAL_DATA",
      target: "30M_MOVE_LONG_VS_SHORT",
      move_threshold_pct: MOVE_THRESHOLD_PCT,
      total_completed_rows: allRows.length,
      directional_rows: directional.length,
      neutral_rows_excluded: neutralCount,
      required_directional_minimum: 100,
    };
  }

  const split = Math.max(1, Math.floor(directional.length * 0.70));
  const train = directional.slice(0, split);
  const test = directional.slice(split);

  let w: RawWeights = {
    bias: 0,
    chart: 0,
    orderFlow: 0,
    funding: 0,
    premium: 0,
  };

  for (const row of train) {
    const y: 0 | 1 = num(row.return_30m_pct) >= MOVE_THRESHOLD_PCT ? 1 : 0;
    w = learnRaw(rawFeatures(row), y, w, 0.03);
  }

  let correct = 0;
  let actualLong = 0;
  let actualShort = 0;

  const thresholds = [0.55, 0.60, 0.65, 0.70];
  const buckets: Record<string, {
    selected: number;
    correct: number;
    long: number;
    short: number;
  }> = {};

  for (const t of thresholds) {
    buckets[String(t)] = { selected: 0, correct: 0, long: 0, short: 0 };
  }

  const coinStats: Record<string, {
    total: number;
    correct: number;
    actualLong: number;
    actualShort: number;
    predictedLong: number;
    predictedShort: number;
  }> = {};

  for (const row of test) {
    const actualIsLong = num(row.return_30m_pct) >= MOVE_THRESHOLD_PCT;
    if (actualIsLong) actualLong += 1;
    else actualShort += 1;

    const pLong = rawProbability(rawFeatures(row), w);
    const predictedLong = pLong >= 0.5;
    const isCorrect = predictedLong === actualIsLong;
    if (isCorrect) correct += 1;

    const coin = String(row.coin ?? "UNKNOWN");
    if (!coinStats[coin]) {
      coinStats[coin] = {
        total: 0, correct: 0,
        actualLong: 0, actualShort: 0,
        predictedLong: 0, predictedShort: 0
      };
    }
    const cs = coinStats[coin];
    cs.total += 1;
    if (isCorrect) cs.correct += 1;
    if (actualIsLong) cs.actualLong += 1;
    else cs.actualShort += 1;
    if (predictedLong) cs.predictedLong += 1;
    else cs.predictedShort += 1;

    for (const t of thresholds) {
      const confidence = Math.max(pLong, 1 - pLong);
      if (confidence < t) continue;

      const b = buckets[String(t)];
      b.selected += 1;
      if (predictedLong) b.long += 1;
      else b.short += 1;
      if (isCorrect) b.correct += 1;
    }
  }

  const filters = thresholds.map((t) => {
    const b = buckets[String(t)];
    return {
      minimum_confidence: `${Math.round(t * 100)}%`,
      signals_selected: b.selected,
      long_predictions: b.long,
      short_predictions: b.short,
      correct: b.correct,
      accuracy_pct:
        b.selected > 0
          ? Number(((b.correct / b.selected) * 100).toFixed(2))
          : null,
    };
  });

  const byCoin = Object.entries(coinStats)
    .map(([coin, x]) => ({
      coin,
      test_samples: x.total,
      correct: x.correct,
      accuracy_pct:
        x.total > 0 ? Number(((x.correct / x.total) * 100).toFixed(2)) : null,
      actual_long: x.actualLong,
      actual_short: x.actualShort,
      predicted_long: x.predictedLong,
      predicted_short: x.predictedShort,
    }))
    .sort((a, b) => b.test_samples - a.test_samples);

  const testAccuracy =
    test.length > 0
      ? Number(((correct / test.length) * 100).toFixed(2))
      : null;

  const majorityBaseline =
    test.length > 0
      ? Number(
          ((Math.max(actualLong, actualShort) / test.length) * 100).toFixed(2)
        )
      : null;

  return {
    status: "OK",
    target: "30M_MOVE_LONG_VS_SHORT",
    label_definition: {
      long: `return_30m_pct >= +${MOVE_THRESHOLD_PCT}%`,
      short: `return_30m_pct <= -${MOVE_THRESHOLD_PCT}%`,
      neutral: `between -${MOVE_THRESHOLD_PCT}% and +${MOVE_THRESHOLD_PCT}% (excluded)`,
    },
    mechanical_score_used: false,
    split: "CHRONOLOGICAL_70_30_DIRECTIONAL_ONLY",
    dataset: {
      total_completed_rows: allRows.length,
      directional_rows: directional.length,
      neutral_rows_excluded: neutralCount,
      train_rows: train.length,
      test_rows: test.length,
    },
    test_result: {
      correct,
      accuracy_pct: testAccuracy,
      actual_long: actualLong,
      actual_short: actualShort,
      majority_class_baseline_pct: majorityBaseline,
      beats_majority_baseline:
        testAccuracy != null &&
        majorityBaseline != null &&
        testAccuracy > majorityBaseline,
    },
    confidence_filters: filters,
    by_coin: byCoin,
    weights: w,
    warning:
      "Research only. Neutral 30m moves are excluded. Adjacent minute observations remain correlated; do not use this result for trading decisions.",
  };
}

async function markHealth(env: Env): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO ml_module_health(module, runs, last_run, status)
    VALUES(?, 1, CURRENT_TIMESTAMP, 'OK')
    ON CONFLICT(module) DO UPDATE SET
      runs = runs + 1,
      last_run = CURRENT_TIMESTAMP,
      status = 'OK'
  `).bind(MODULE).run();
}


// ============================================================
// FORWARD VALIDATION V0.5
// Frozen model from the first V0.4 chronological experiment.
// IMPORTANT: these weights DO NOT learn/update during forward validation.
// A prediction is stored before the future 30m result is known.
// ============================================================

const FORWARD_MODEL_KEY = "raw_v04_frozen_20260921";
const FORWARD_MOVE_THRESHOLD_PCT = 0.30;

const FROZEN_FORWARD_WEIGHTS: RawWeights = {
  bias: 0.013707958318924383,
  chart: -1.297549085886353,
  orderFlow: -0.15473076917499598,
  funding: -0.12655864188528854,
  premium: -0.2055513587849824,
};

async function ensureForwardTable(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS ml_raw_forward_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_key TEXT NOT NULL,
      source_snapshot_id INTEGER NOT NULL,
      coin TEXT NOT NULL,
      snapshot_ts INTEGER NOT NULL,
      snapshot_datetime TEXT,
      entry_price REAL NOT NULL,

      feature_chart REAL,
      feature_order_flow REAL,
      feature_funding REAL,
      feature_premium REAL,

      probability_long REAL NOT NULL,
      predicted_side TEXT NOT NULL,
      confidence REAL NOT NULL,

      future_price_30m REAL,
      return_30m_pct REAL,
      actual_class TEXT,
      correct INTEGER,
      outcome_ready INTEGER NOT NULL DEFAULT 0,

      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,

      UNIQUE(model_key, source_snapshot_id)
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_ml_raw_forward_model_ts
    ON ml_raw_forward_predictions (model_key, snapshot_ts)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_ml_raw_forward_pending
    ON ml_raw_forward_predictions (model_key, outcome_ready, snapshot_ts)
  `).run();
}

async function createForwardPredictions(env: Env): Promise<number> {
  // Only the latest snapshot for each coin is eligible on each run.
  // Existing source_snapshot_id values are protected by UNIQUE.
  const rows: any = await env.DB.prepare(`
    SELECT
      s.id,
      s.coin,
      s.ts,
      s.datetime,
      s.price,
      s.chart_signed,
      s.order_flow_signed,
      s.funding,
      s.premium
    FROM market_snapshots s
    INNER JOIN (
      SELECT coin, MAX(ts) AS max_ts
      FROM market_snapshots
      GROUP BY coin
    ) latest
      ON latest.coin = s.coin
     AND latest.max_ts = s.ts
    WHERE s.price IS NOT NULL
      AND s.price > 0
      AND NOT EXISTS (
        SELECT 1
        FROM ml_raw_forward_predictions p
        WHERE p.model_key = ?
          AND p.source_snapshot_id = s.id
      )
  `).bind(FORWARD_MODEL_KEY).all();

  let inserted = 0;

  // Max ~20 rows/run. Prediction math is tiny and no training occurs here.
  for (const row of rows?.results ?? []) {
    const x = rawFeatures(row);
    const pLong = rawProbability(x, FROZEN_FORWARD_WEIGHTS);
    const predictedSide = pLong >= 0.5 ? "LONG" : "SHORT";
    const confidence = Math.max(pLong, 1 - pLong);

    const result: any = await env.DB.prepare(`
      INSERT OR IGNORE INTO ml_raw_forward_predictions (
        model_key,
        source_snapshot_id,
        coin,
        snapshot_ts,
        snapshot_datetime,
        entry_price,
        feature_chart,
        feature_order_flow,
        feature_funding,
        feature_premium,
        probability_long,
        predicted_side,
        confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      FORWARD_MODEL_KEY,
      row.id,
      row.coin,
      row.ts,
      row.datetime ?? null,
      row.price,
      x.chart,
      x.orderFlow,
      x.funding,
      x.premium,
      pLong,
      predictedSide,
      confidence
    ).run();

    inserted += Math.max(0, Math.trunc(num(result?.meta?.changes)));
  }

  return inserted;
}

async function resolveForwardPredictions(env: Env): Promise<number> {
  // Set-based resolution. Neutral moves are retained as NEUTRAL and do not
  // count as correct/incorrect in directional accuracy.
  const now = Date.now();

  const result: any = await env.DB.prepare(`
    UPDATE ml_raw_forward_predictions
    SET
      future_price_30m = (
        SELECT s.price
        FROM market_snapshots s
        WHERE s.coin = ml_raw_forward_predictions.coin
          AND s.ts >= ml_raw_forward_predictions.snapshot_ts + 1800000
          AND s.ts <= ml_raw_forward_predictions.snapshot_ts + 1920000
          AND s.price IS NOT NULL
          AND s.price > 0
        ORDER BY s.ts ASC
        LIMIT 1
      ),

      return_30m_pct = (
        (
          SELECT s.price
          FROM market_snapshots s
          WHERE s.coin = ml_raw_forward_predictions.coin
            AND s.ts >= ml_raw_forward_predictions.snapshot_ts + 1800000
            AND s.ts <= ml_raw_forward_predictions.snapshot_ts + 1920000
            AND s.price IS NOT NULL
            AND s.price > 0
          ORDER BY s.ts ASC
          LIMIT 1
        ) / entry_price - 1.0
      ) * 100.0,

      actual_class = CASE
        WHEN (
          (
            SELECT s.price
            FROM market_snapshots s
            WHERE s.coin = ml_raw_forward_predictions.coin
              AND s.ts >= ml_raw_forward_predictions.snapshot_ts + 1800000
              AND s.ts <= ml_raw_forward_predictions.snapshot_ts + 1920000
              AND s.price IS NOT NULL
              AND s.price > 0
            ORDER BY s.ts ASC
            LIMIT 1
          ) / entry_price - 1.0
        ) * 100.0 >= 0.30 THEN 'LONG'

        WHEN (
          (
            SELECT s.price
            FROM market_snapshots s
            WHERE s.coin = ml_raw_forward_predictions.coin
              AND s.ts >= ml_raw_forward_predictions.snapshot_ts + 1800000
              AND s.ts <= ml_raw_forward_predictions.snapshot_ts + 1920000
              AND s.price IS NOT NULL
              AND s.price > 0
            ORDER BY s.ts ASC
            LIMIT 1
          ) / entry_price - 1.0
        ) * 100.0 <= -0.30 THEN 'SHORT'

        ELSE 'NEUTRAL'
      END,

      correct = CASE
        WHEN ABS(
          (
            (
              SELECT s.price
              FROM market_snapshots s
              WHERE s.coin = ml_raw_forward_predictions.coin
                AND s.ts >= ml_raw_forward_predictions.snapshot_ts + 1800000
                AND s.ts <= ml_raw_forward_predictions.snapshot_ts + 1920000
                AND s.price IS NOT NULL
                AND s.price > 0
              ORDER BY s.ts ASC
              LIMIT 1
            ) / entry_price - 1.0
          ) * 100.0
        ) < 0.30 THEN NULL

        WHEN predicted_side = CASE
          WHEN (
            (
              SELECT s.price
              FROM market_snapshots s
              WHERE s.coin = ml_raw_forward_predictions.coin
                AND s.ts >= ml_raw_forward_predictions.snapshot_ts + 1800000
                AND s.ts <= ml_raw_forward_predictions.snapshot_ts + 1920000
                AND s.price IS NOT NULL
                AND s.price > 0
              ORDER BY s.ts ASC
              LIMIT 1
            ) / entry_price - 1.0
          ) * 100.0 >= 0.30 THEN 'LONG'
          ELSE 'SHORT'
        END THEN 1
        ELSE 0
      END,

      outcome_ready = 1,
      resolved_at = CURRENT_TIMESTAMP

    WHERE model_key = ?
      AND outcome_ready = 0
      AND snapshot_ts <= ? - 1800000
      AND EXISTS (
        SELECT 1
        FROM market_snapshots s
        WHERE s.coin = ml_raw_forward_predictions.coin
          AND s.ts >= ml_raw_forward_predictions.snapshot_ts + 1800000
          AND s.ts <= ml_raw_forward_predictions.snapshot_ts + 1920000
          AND s.price IS NOT NULL
          AND s.price > 0
      )
  `).bind(FORWARD_MODEL_KEY, now).run();

  return Math.max(0, Math.trunc(num(result?.meta?.changes)));
}

async function getForwardStatus(env: Env): Promise<any> {
  const totals: any = await env.DB.prepare(`
    SELECT
      COUNT(*) AS predictions,
      SUM(CASE WHEN outcome_ready = 0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN outcome_ready = 1 THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN actual_class = 'NEUTRAL' THEN 1 ELSE 0 END) AS neutral,
      SUM(CASE WHEN actual_class IN ('LONG','SHORT') THEN 1 ELSE 0 END) AS directional,
      SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct
    FROM ml_raw_forward_predictions
    WHERE model_key = ?
  `).bind(FORWARD_MODEL_KEY).first();

  const thresholdRows: any = await env.DB.prepare(`
    SELECT
      CASE
        WHEN confidence >= 0.70 THEN '70'
        WHEN confidence >= 0.65 THEN '65'
        WHEN confidence >= 0.60 THEN '60'
        WHEN confidence >= 0.55 THEN '55'
        ELSE 'UNDER55'
      END AS bucket,
      COUNT(*) AS predictions,
      SUM(CASE WHEN outcome_ready = 0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN actual_class IN ('LONG','SHORT') THEN 1 ELSE 0 END) AS directional,
      SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct,
      SUM(CASE WHEN predicted_side = 'LONG' THEN 1 ELSE 0 END) AS predicted_long,
      SUM(CASE WHEN predicted_side = 'SHORT' THEN 1 ELSE 0 END) AS predicted_short
    FROM ml_raw_forward_predictions
    WHERE model_key = ?
    GROUP BY bucket
  `).bind(FORWARD_MODEL_KEY).all();

  const rawBuckets: Record<string, any> = {};
  for (const r of thresholdRows?.results ?? []) rawBuckets[String(r.bucket)] = r;

  const thresholds = [0.55, 0.60, 0.65, 0.70].map((t) => {
    const min = Math.round(t * 100);
    const eligible = Object.entries(rawBuckets)
      .filter(([key]) => key !== "UNDER55" && Number(key) >= min)
      .map(([, value]) => value);

    const predictions = eligible.reduce((a, r) => a + num(r.predictions), 0);
    const pending = eligible.reduce((a, r) => a + num(r.pending), 0);
    const directional = eligible.reduce((a, r) => a + num(r.directional), 0);
    const correct = eligible.reduce((a, r) => a + num(r.correct), 0);
    const predictedLong = eligible.reduce((a, r) => a + num(r.predicted_long), 0);
    const predictedShort = eligible.reduce((a, r) => a + num(r.predicted_short), 0);

    return {
      minimum_confidence: `${min}%`,
      predictions,
      pending,
      directional_resolved: directional,
      correct,
      accuracy_pct:
        directional > 0
          ? Number(((correct / directional) * 100).toFixed(2))
          : null,
      predicted_long: predictedLong,
      predicted_short: predictedShort,
    };
  });

  const coins: any = await env.DB.prepare(`
    SELECT
      coin,
      COUNT(*) AS predictions,
      SUM(CASE WHEN outcome_ready = 0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN actual_class IN ('LONG','SHORT') THEN 1 ELSE 0 END) AS directional,
      SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct,
      SUM(CASE WHEN predicted_side = 'LONG' THEN 1 ELSE 0 END) AS predicted_long,
      SUM(CASE WHEN predicted_side = 'SHORT' THEN 1 ELSE 0 END) AS predicted_short
    FROM ml_raw_forward_predictions
    WHERE model_key = ?
    GROUP BY coin
    ORDER BY coin ASC
  `).bind(FORWARD_MODEL_KEY).all();

  const byCoin = (coins?.results ?? []).map((r: any) => ({
    coin: r.coin,
    predictions: num(r.predictions),
    pending: num(r.pending),
    directional_resolved: num(r.directional),
    correct: num(r.correct),
    accuracy_pct:
      num(r.directional) > 0
        ? Number(((num(r.correct) / num(r.directional)) * 100).toFixed(2))
        : null,
    predicted_long: num(r.predicted_long),
    predicted_short: num(r.predicted_short),
  }));

  const directional = num(totals?.directional);
  const correct = num(totals?.correct);

  return {
    model_key: FORWARD_MODEL_KEY,
    model: "FROZEN_V0.4_WEIGHTS",
    move_threshold_pct: FORWARD_MOVE_THRESHOLD_PCT,
    predictions: num(totals?.predictions),
    pending: num(totals?.pending),
    resolved: num(totals?.resolved),
    neutral_resolved: num(totals?.neutral),
    directional_resolved: directional,
    correct,
    directional_accuracy_pct:
      directional > 0
        ? Number(((correct / directional) * 100).toFixed(2))
        : null,
    confidence_filters: thresholds,
    by_coin: byCoin,
    weights_frozen: FROZEN_FORWARD_WEIGHTS,
    note:
      "Predictions are created before the 30m outcome exists. Neutral outcomes are excluded from directional accuracy. Weights never update in this forward test.",
  };
}



// ============================================================
// V0.6 AI FIRST-TOUCH
// - PREVIOUS V0.5 forward model remains frozen and untouched.
// - V0.6 is a separate learned classifier.
// - Target: which barrier is touched FIRST within 10 minutes:
//     LONG  = +0.20% first
//     SHORT = -0.20% first
//     NONE  = neither (excluded from directional training/accuracy)
// - No mechanical score/side formula is used for prediction.
// - Feature transforms only normalize raw market state for ML.
// - Model is trained once from historical market states and persisted.
// - New predictions are strictly forward and are never used for trading.
// ============================================================

const V06_MODEL_KEY = "raw_v06_ai_first_touch_020_10m_20260930";
const V06_TOUCH_PCT = 0.20;
const V06_WINDOW_MS = 10 * 60_000;
const V06_TRAIN_LIMIT = 6000;

type V06Features = {
  chart: number;
  orderFlow: number;
  funding: number;
  premium: number;
  momentum1m: number;
  momentum5m: number;
  oiChange5m: number;
  btcMomentum5m: number;
};

type V06Weights = V06Features & { bias: number };

function v06ZeroWeights(): V06Weights {
  return { bias:0, chart:0, orderFlow:0, funding:0, premium:0,
    momentum1m:0, momentum5m:0, oiChange5m:0, btcMomentum5m:0 };
}

function v06Features(row:any): V06Features {
  const price=num(row.price);
  const p1=num(row.price_1m_ago);
  const p5=num(row.price_5m_ago);
  const oi=num(row.open_interest);
  const oi5=num(row.oi_5m_ago);
  const btc=num(row.btc_price);
  const btc5=num(row.btc_price_5m_ago);
  const pct=(a:number,b:number)=>b>0?((a/b)-1)*100:0;
  return {
    chart: clamp(num(row.chart_signed)/100,-1,1),
    orderFlow: clamp(num(row.order_flow_signed)/100,-1,1),
    funding: clamp(num(row.funding)*10000,-1,1),
    premium: clamp(num(row.premium)*1000,-1,1),
    momentum1m: clamp(pct(price,p1)/0.50,-1,1),
    momentum5m: clamp(pct(price,p5)/1.00,-1,1),
    oiChange5m: clamp(pct(oi,oi5)/1.00,-1,1),
    btcMomentum5m: clamp(pct(btc,btc5)/1.00,-1,1),
  };
}

function v06Probability(x:V06Features,w:V06Weights):number {
  return sigmoid(w.bias + w.chart*x.chart + w.orderFlow*x.orderFlow +
    w.funding*x.funding + w.premium*x.premium +
    w.momentum1m*x.momentum1m + w.momentum5m*x.momentum5m +
    w.oiChange5m*x.oiChange5m + w.btcMomentum5m*x.btcMomentum5m);
}

function v06Learn(x:V06Features,y:0|1,w:V06Weights,lr=0.025):V06Weights {
  const e=y-v06Probability(x,w);
  return {
    bias:w.bias+lr*e,
    chart:w.chart+lr*e*x.chart,
    orderFlow:w.orderFlow+lr*e*x.orderFlow,
    funding:w.funding+lr*e*x.funding,
    premium:w.premium+lr*e*x.premium,
    momentum1m:w.momentum1m+lr*e*x.momentum1m,
    momentum5m:w.momentum5m+lr*e*x.momentum5m,
    oiChange5m:w.oiChange5m+lr*e*x.oiChange5m,
    btcMomentum5m:w.btcMomentum5m+lr*e*x.btcMomentum5m,
  };
}

async function ensureV06Tables(env:Env):Promise<void>{
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ml_raw_v06_model (
    model_key TEXT PRIMARY KEY, trained_at TEXT NOT NULL,
    training_rows INTEGER NOT NULL, directional_rows INTEGER NOT NULL,
    test_rows INTEGER NOT NULL, test_correct INTEGER NOT NULL,
    test_accuracy REAL, majority_baseline REAL,
    weights_json TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ml_raw_v06_forward (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_key TEXT NOT NULL, source_snapshot_id INTEGER NOT NULL,
    coin TEXT NOT NULL, snapshot_ts INTEGER NOT NULL, snapshot_datetime TEXT,
    entry_price REAL NOT NULL, probability_long REAL NOT NULL,
    predicted_side TEXT NOT NULL, confidence REAL NOT NULL,
    feature_chart REAL, feature_order_flow REAL, feature_funding REAL, feature_premium REAL,
    feature_momentum_1m REAL, feature_momentum_5m REAL, feature_oi_change_5m REAL, feature_btc_momentum_5m REAL,
    first_up_ts INTEGER, first_down_ts INTEGER, actual_class TEXT, correct INTEGER,
    outcome_ready INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT,
    UNIQUE(model_key,source_snapshot_id)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ml_raw_v06_forward_pending ON ml_raw_v06_forward(model_key,outcome_ready,snapshot_ts)`).run();
}

async function getV06Model(env:Env):Promise<{weights:V06Weights,meta:any}|null>{
  const r:any=await env.DB.prepare(`SELECT * FROM ml_raw_v06_model WHERE model_key=? LIMIT 1`).bind(V06_MODEL_KEY).first();
  if(!r) return null;
  try { return {weights:JSON.parse(String(r.weights_json)),meta:r}; } catch { return null; }
}

async function trainV06Once(env:Env):Promise<any>{
  await ensureV06Tables(env);
  const existing=await getV06Model(env);
  if(existing) return {status:'FROZEN',...existing.meta,weights:existing.weights};

  // Bounded historical sample. Future touch timestamps are calculated only from
  // snapshots that already existed historically. The newest 30% is held out.
  const q:any=await env.DB.prepare(`
    WITH base AS (
      SELECT r.id,r.coin,r.snapshot_ts,r.snapshot_datetime,r.price,
             r.chart_signed,r.order_flow_signed,r.open_interest,r.funding,r.premium
      FROM ml_raw_dataset r
      WHERE r.snapshot_ts <= ? - ${V06_WINDOW_MS}
      ORDER BY r.snapshot_ts DESC
      LIMIT ${V06_TRAIN_LIMIT}
    )
    SELECT b.*,
      (SELECT s.price FROM market_snapshots s WHERE s.coin=b.coin AND s.ts<=b.snapshot_ts-60000 ORDER BY s.ts DESC LIMIT 1) price_1m_ago,
      (SELECT s.price FROM market_snapshots s WHERE s.coin=b.coin AND s.ts<=b.snapshot_ts-300000 ORDER BY s.ts DESC LIMIT 1) price_5m_ago,
      (SELECT s.open_interest FROM market_snapshots s WHERE s.coin=b.coin AND s.ts<=b.snapshot_ts-300000 ORDER BY s.ts DESC LIMIT 1) oi_5m_ago,
      (SELECT s.price FROM market_snapshots s WHERE s.coin='BTC' AND s.ts<=b.snapshot_ts ORDER BY s.ts DESC LIMIT 1) btc_price,
      (SELECT s.price FROM market_snapshots s WHERE s.coin='BTC' AND s.ts<=b.snapshot_ts-300000 ORDER BY s.ts DESC LIMIT 1) btc_price_5m_ago,
      (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=b.coin AND s.ts>b.snapshot_ts AND s.ts<=b.snapshot_ts+${V06_WINDOW_MS} AND s.price>=b.price*(1+${V06_TOUCH_PCT}/100.0)) first_up_ts,
      (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=b.coin AND s.ts>b.snapshot_ts AND s.ts<=b.snapshot_ts+${V06_WINDOW_MS} AND s.price<=b.price*(1-${V06_TOUCH_PCT}/100.0)) first_down_ts
    FROM base b ORDER BY b.snapshot_ts ASC,b.id ASC
  `).bind(Date.now()).all();
  const rows:any[]=(q?.results??[]).filter((r:any)=>r.first_up_ts!=null||r.first_down_ts!=null);
  if(rows.length<200) return {status:'WAITING_FOR_FIRST_TOUCH_DATA',directional_rows:rows.length,required:200};
  const split=Math.max(1,Math.floor(rows.length*0.70));
  const train=rows.slice(0,split), test=rows.slice(split);
  let w=v06ZeroWeights();
  const actual=(r:any):0|1 => (r.first_up_ts!=null && (r.first_down_ts==null || num(r.first_up_ts)<num(r.first_down_ts)))?1:0;
  // Multiple chronological passes over TRAIN only. No test-row learning.
  for(let epoch=0;epoch<4;epoch++) for(const r of train) w=v06Learn(v06Features(r),actual(r),w,0.02);
  let correct=0,longN=0,shortN=0;
  for(const r of test){ const y=actual(r); if(y)longN++;else shortN++; const pred=v06Probability(v06Features(r),w)>=0.5?1:0; if(pred===y)correct++; }
  const acc=test.length?correct/test.length*100:null;
  const base=test.length?Math.max(longN,shortN)/test.length*100:null;
  await env.DB.prepare(`INSERT OR REPLACE INTO ml_raw_v06_model(model_key,trained_at,training_rows,directional_rows,test_rows,test_correct,test_accuracy,majority_baseline,weights_json) VALUES(?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?)`)
    .bind(V06_MODEL_KEY,train.length,rows.length,test.length,correct,acc,base,JSON.stringify(w)).run();
  return {status:'TRAINED_AND_FROZEN',model_key:V06_MODEL_KEY,target:'FIRST_TOUCH_+0.20_VS_-0.20_WITHIN_10M',sample_limit:V06_TRAIN_LIMIT,directional_rows:rows.length,train_rows:train.length,test_rows:test.length,test_correct:correct,test_accuracy_pct:acc==null?null:Number(acc.toFixed(2)),majority_baseline_pct:base==null?null:Number(base.toFixed(2)),beats_majority_baseline:acc!=null&&base!=null&&acc>base,weights:w};
}

async function createV06Forward(env:Env):Promise<number>{
  const model=await getV06Model(env); if(!model)return 0;
  const q:any=await env.DB.prepare(`
    SELECT s.*,
      (SELECT x.price FROM market_snapshots x WHERE x.coin=s.coin AND x.ts<=s.ts-60000 ORDER BY x.ts DESC LIMIT 1) price_1m_ago,
      (SELECT x.price FROM market_snapshots x WHERE x.coin=s.coin AND x.ts<=s.ts-300000 ORDER BY x.ts DESC LIMIT 1) price_5m_ago,
      (SELECT x.open_interest FROM market_snapshots x WHERE x.coin=s.coin AND x.ts<=s.ts-300000 ORDER BY x.ts DESC LIMIT 1) oi_5m_ago,
      (SELECT x.price FROM market_snapshots x WHERE x.coin='BTC' AND x.ts<=s.ts ORDER BY x.ts DESC LIMIT 1) btc_price,
      (SELECT x.price FROM market_snapshots x WHERE x.coin='BTC' AND x.ts<=s.ts-300000 ORDER BY x.ts DESC LIMIT 1) btc_price_5m_ago
    FROM market_snapshots s
    INNER JOIN (SELECT coin,MAX(ts) max_ts FROM market_snapshots GROUP BY coin) z ON z.coin=s.coin AND z.max_ts=s.ts
    WHERE s.price>0 AND NOT EXISTS(SELECT 1 FROM ml_raw_v06_forward f WHERE f.model_key=? AND f.source_snapshot_id=s.id)
  `).bind(V06_MODEL_KEY).all();
  let n=0;
  for(const r of q?.results??[]){
    const x=v06Features(r), p=v06Probability(x,model.weights), side=p>=0.5?'LONG':'SHORT', conf=Math.max(p,1-p);
    const z:any=await env.DB.prepare(`INSERT OR IGNORE INTO ml_raw_v06_forward(model_key,source_snapshot_id,coin,snapshot_ts,snapshot_datetime,entry_price,probability_long,predicted_side,confidence,feature_chart,feature_order_flow,feature_funding,feature_premium,feature_momentum_1m,feature_momentum_5m,feature_oi_change_5m,feature_btc_momentum_5m) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(V06_MODEL_KEY,r.id,r.coin,r.ts,r.datetime??null,r.price,p,side,conf,x.chart,x.orderFlow,x.funding,x.premium,x.momentum1m,x.momentum5m,x.oiChange5m,x.btcMomentum5m).run();
    n+=Math.max(0,Math.trunc(num(z?.meta?.changes)));
  }
  return n;
}

async function resolveV06Forward(env:Env):Promise<number>{
  const now=Date.now();
  const r:any=await env.DB.prepare(`
    UPDATE ml_raw_v06_forward SET
      first_up_ts=(SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price>=ml_raw_v06_forward.entry_price*(1+${V06_TOUCH_PCT}/100.0)),
      first_down_ts=(SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price<=ml_raw_v06_forward.entry_price*(1-${V06_TOUCH_PCT}/100.0)),
      actual_class=CASE
        WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price>=ml_raw_v06_forward.entry_price*(1+${V06_TOUCH_PCT}/100.0)) IS NULL
         AND (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price<=ml_raw_v06_forward.entry_price*(1-${V06_TOUCH_PCT}/100.0)) IS NULL THEN 'NONE'
        WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price<=ml_raw_v06_forward.entry_price*(1-${V06_TOUCH_PCT}/100.0)) IS NULL THEN 'LONG'
        WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price>=ml_raw_v06_forward.entry_price*(1+${V06_TOUCH_PCT}/100.0)) IS NULL THEN 'SHORT'
        WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price>=ml_raw_v06_forward.entry_price*(1+${V06_TOUCH_PCT}/100.0)) <
             (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price<=ml_raw_v06_forward.entry_price*(1-${V06_TOUCH_PCT}/100.0)) THEN 'LONG'
        ELSE 'SHORT' END,
      correct=CASE
        WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price>=ml_raw_v06_forward.entry_price*(1+${V06_TOUCH_PCT}/100.0)) IS NULL
         AND (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price<=ml_raw_v06_forward.entry_price*(1-${V06_TOUCH_PCT}/100.0)) IS NULL THEN NULL
        WHEN predicted_side = CASE
          WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price<=ml_raw_v06_forward.entry_price*(1-${V06_TOUCH_PCT}/100.0)) IS NULL THEN 'LONG'
          WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price>=ml_raw_v06_forward.entry_price*(1+${V06_TOUCH_PCT}/100.0)) IS NULL THEN 'SHORT'
          WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price>=ml_raw_v06_forward.entry_price*(1+${V06_TOUCH_PCT}/100.0)) <
               (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v06_forward.coin AND s.ts>ml_raw_v06_forward.snapshot_ts AND s.ts<=ml_raw_v06_forward.snapshot_ts+${V06_WINDOW_MS} AND s.price<=ml_raw_v06_forward.entry_price*(1-${V06_TOUCH_PCT}/100.0)) THEN 'LONG' ELSE 'SHORT' END THEN 1 ELSE 0 END,
      outcome_ready=1,resolved_at=CURRENT_TIMESTAMP
    WHERE model_key=? AND outcome_ready=0 AND snapshot_ts<=?-${V06_WINDOW_MS}
  `).bind(V06_MODEL_KEY,now).run();
  return Math.max(0,Math.trunc(num(r?.meta?.changes)));
}

async function getV06Status(env:Env):Promise<any>{
  await ensureV06Tables(env);
  const training=await trainV06Once(env);
  const totals:any=await env.DB.prepare(`SELECT COUNT(*) predictions,SUM(outcome_ready=0) pending,SUM(outcome_ready=1) resolved,SUM(actual_class='NONE') none_resolved,SUM(actual_class IN ('LONG','SHORT')) directional_resolved,SUM(correct=1) correct FROM ml_raw_v06_forward WHERE model_key=?`).bind(V06_MODEL_KEY).first();
  const buckets:any=await env.DB.prepare(`SELECT threshold,COUNT(*) predictions,SUM(CASE WHEN outcome_ready=1 AND actual_class IN ('LONG','SHORT') THEN 1 ELSE 0 END) directional,SUM(CASE WHEN correct=1 THEN 1 ELSE 0 END) correct FROM (SELECT *,CASE WHEN confidence>=0.70 THEN '70%' WHEN confidence>=0.65 THEN '65%' WHEN confidence>=0.60 THEN '60%' WHEN confidence>=0.55 THEN '55%' ELSE '<55%' END threshold FROM ml_raw_v06_forward WHERE model_key=?) GROUP BY threshold ORDER BY threshold DESC`).bind(V06_MODEL_KEY).all();
  const d=num(totals?.directional_resolved),c=num(totals?.correct);
  return {model_key:V06_MODEL_KEY,model:'AI_LOGISTIC_FIRST_TOUCH',research_only:true,trading_enabled:false,target:`FIRST +${V06_TOUCH_PCT}% vs -${V06_TOUCH_PCT}% within 10m`,mechanical_direction_formula_used:false,training,predictions:num(totals?.predictions),pending:num(totals?.pending),resolved:num(totals?.resolved),none_resolved:num(totals?.none_resolved),directional_resolved:d,correct:c,directional_accuracy_pct:d?Number((c/d*100).toFixed(2)):null,confidence_filters:(buckets?.results??[]).map((x:any)=>({minimum_confidence:x.threshold,predictions:num(x.predictions),directional_resolved:num(x.directional),correct:num(x.correct),accuracy_pct:num(x.directional)?Number((num(x.correct)/num(x.directional)*100).toFixed(2)):null}))};
}




// ============================================================
// V0.7 REGIME + RELATIVE MOVE ML
// - Separate research layer; V0.6 and V0.5 remain untouched.
// - Same first-touch target as V0.6 for an apples-to-apples benchmark.
// - Adds BTC 1m/5m/15m regime, BTC acceleration, coin-vs-BTC relative
//   momentum/divergence, plus existing microstructure features.
// - Historical training uses one sample per coin per 5-minute episode bucket
//   to reduce adjacent-minute correlation/leakage.
// - Model trains once, freezes, then performs strict forward validation only.
// - RESEARCH ONLY / REAL TRADING DISABLED.
// ============================================================

const V07_MODEL_KEY = "raw_v07_regime_relative_touch_020_10m_ep5_20260930";
const V07_TOUCH_PCT = 0.20;
const V07_WINDOW_MS = 10 * 60_000;
const V07_EPISODE_MS = 5 * 60_000;
const V07_TRAIN_LIMIT = 8000;

type V07Features = {
  chart:number; orderFlow:number; funding:number; premium:number;
  momentum1m:number; momentum5m:number; momentum15m:number; oiChange5m:number;
  btcMomentum1m:number; btcMomentum5m:number; btcMomentum15m:number;
  btcAcceleration:number; relative1m:number; relative5m:number; relative15m:number;
  relativeAcceleration:number;
};
type V07Weights = V07Features & { bias:number };

function v07ZeroWeights():V07Weights { return {
  bias:0, chart:0, orderFlow:0, funding:0, premium:0,
  momentum1m:0, momentum5m:0, momentum15m:0, oiChange5m:0,
  btcMomentum1m:0, btcMomentum5m:0, btcMomentum15m:0,
  btcAcceleration:0, relative1m:0, relative5m:0, relative15m:0,
  relativeAcceleration:0
}; }

function v07Features(row:any):V07Features {
  const pct=(a:number,b:number)=>b>0?((a/b)-1)*100:0;
  const cp=num(row.price), c1=num(row.price_1m_ago), c5=num(row.price_5m_ago), c15=num(row.price_15m_ago);
  const bp=num(row.btc_price), b1=num(row.btc_price_1m_ago), b5=num(row.btc_price_5m_ago), b15=num(row.btc_price_15m_ago);
  const cm1=pct(cp,c1), cm5=pct(cp,c5), cm15=pct(cp,c15);
  const bm1=pct(bp,b1), bm5=pct(bp,b5), bm15=pct(bp,b15);
  const rel1=cm1-bm1, rel5=cm5-bm5, rel15=cm15-bm15;
  // Acceleration compares recent 1m pace with average 5m pace.
  const btcAcc=bm1-(bm5/5);
  const relAcc=rel1-(rel5/5);
  const oi=num(row.open_interest), oi5=num(row.oi_5m_ago);
  return {
    chart:clamp(num(row.chart_signed)/100,-1,1),
    orderFlow:clamp(num(row.order_flow_signed)/100,-1,1),
    funding:clamp(num(row.funding)*10000,-1,1),
    premium:clamp(num(row.premium)*1000,-1,1),
    momentum1m:clamp(cm1/0.50,-1,1), momentum5m:clamp(cm5/1.00,-1,1), momentum15m:clamp(cm15/2.00,-1,1),
    oiChange5m:clamp(pct(oi,oi5)/1.00,-1,1),
    btcMomentum1m:clamp(bm1/0.50,-1,1), btcMomentum5m:clamp(bm5/1.00,-1,1), btcMomentum15m:clamp(bm15/2.00,-1,1),
    btcAcceleration:clamp(btcAcc/0.35,-1,1),
    relative1m:clamp(rel1/0.50,-1,1), relative5m:clamp(rel5/1.00,-1,1), relative15m:clamp(rel15/2.00,-1,1),
    relativeAcceleration:clamp(relAcc/0.35,-1,1)
  };
}

function v07Probability(x:V07Features,w:V07Weights):number {
  return sigmoid(w.bias + w.chart*x.chart + w.orderFlow*x.orderFlow + w.funding*x.funding + w.premium*x.premium +
    w.momentum1m*x.momentum1m + w.momentum5m*x.momentum5m + w.momentum15m*x.momentum15m + w.oiChange5m*x.oiChange5m +
    w.btcMomentum1m*x.btcMomentum1m + w.btcMomentum5m*x.btcMomentum5m + w.btcMomentum15m*x.btcMomentum15m +
    w.btcAcceleration*x.btcAcceleration + w.relative1m*x.relative1m + w.relative5m*x.relative5m +
    w.relative15m*x.relative15m + w.relativeAcceleration*x.relativeAcceleration);
}

function v07Learn(x:V07Features,y:0|1,w:V07Weights,lr=0.015):V07Weights {
  const e=y-v07Probability(x,w);
  const n:any={bias:w.bias+lr*e};
  for(const k of Object.keys(x) as (keyof V07Features)[]) n[k]=w[k]+lr*e*x[k];
  return n as V07Weights;
}

async function ensureV07Tables(env:Env):Promise<void>{
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ml_raw_v07_model (
    model_key TEXT PRIMARY KEY, trained_at TEXT NOT NULL, episode_minutes INTEGER NOT NULL,
    sampled_rows INTEGER NOT NULL, directional_rows INTEGER NOT NULL, training_rows INTEGER NOT NULL,
    test_rows INTEGER NOT NULL, test_correct INTEGER NOT NULL, test_accuracy REAL, majority_baseline REAL,
    weights_json TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ml_raw_v07_forward (
    id INTEGER PRIMARY KEY AUTOINCREMENT, model_key TEXT NOT NULL, source_snapshot_id INTEGER NOT NULL,
    coin TEXT NOT NULL, snapshot_ts INTEGER NOT NULL, snapshot_datetime TEXT, entry_price REAL NOT NULL,
    probability_long REAL NOT NULL, predicted_side TEXT NOT NULL, confidence REAL NOT NULL,
    features_json TEXT NOT NULL, first_up_ts INTEGER, first_down_ts INTEGER, actual_class TEXT, correct INTEGER,
    outcome_ready INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT,
    UNIQUE(model_key,source_snapshot_id)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ml_raw_v07_forward_pending ON ml_raw_v07_forward(model_key,outcome_ready,snapshot_ts)`).run();
}

async function getV07Model(env:Env):Promise<{weights:V07Weights,meta:any}|null>{
  const r:any=await env.DB.prepare(`SELECT * FROM ml_raw_v07_model WHERE model_key=? LIMIT 1`).bind(V07_MODEL_KEY).first();
  if(!r)return null; try{return {weights:JSON.parse(String(r.weights_json)),meta:r};}catch{return null;}
}

async function trainV07Once(env:Env):Promise<any>{
  await ensureV07Tables(env); const existing=await getV07Model(env);
  if(existing)return {status:'FROZEN',...existing.meta,weights:existing.weights};
  const q:any=await env.DB.prepare(`
    WITH ranked AS (
      SELECT r.*, ROW_NUMBER() OVER(PARTITION BY r.coin, CAST(r.snapshot_ts/${V07_EPISODE_MS} AS INTEGER) ORDER BY r.snapshot_ts ASC,r.id ASC) rn
      FROM ml_raw_dataset r WHERE r.snapshot_ts<=?-${V07_WINDOW_MS}
    ), base AS (
      SELECT * FROM ranked WHERE rn=1 ORDER BY snapshot_ts DESC LIMIT ${V07_TRAIN_LIMIT}
    )
    SELECT b.*,
      (SELECT s.price FROM market_snapshots s WHERE s.coin=b.coin AND s.ts<=b.snapshot_ts-60000 ORDER BY s.ts DESC LIMIT 1) price_1m_ago,
      (SELECT s.price FROM market_snapshots s WHERE s.coin=b.coin AND s.ts<=b.snapshot_ts-300000 ORDER BY s.ts DESC LIMIT 1) price_5m_ago,
      (SELECT s.price FROM market_snapshots s WHERE s.coin=b.coin AND s.ts<=b.snapshot_ts-900000 ORDER BY s.ts DESC LIMIT 1) price_15m_ago,
      (SELECT s.open_interest FROM market_snapshots s WHERE s.coin=b.coin AND s.ts<=b.snapshot_ts-300000 ORDER BY s.ts DESC LIMIT 1) oi_5m_ago,
      (SELECT s.price FROM market_snapshots s WHERE s.coin='BTC' AND s.ts<=b.snapshot_ts ORDER BY s.ts DESC LIMIT 1) btc_price,
      (SELECT s.price FROM market_snapshots s WHERE s.coin='BTC' AND s.ts<=b.snapshot_ts-60000 ORDER BY s.ts DESC LIMIT 1) btc_price_1m_ago,
      (SELECT s.price FROM market_snapshots s WHERE s.coin='BTC' AND s.ts<=b.snapshot_ts-300000 ORDER BY s.ts DESC LIMIT 1) btc_price_5m_ago,
      (SELECT s.price FROM market_snapshots s WHERE s.coin='BTC' AND s.ts<=b.snapshot_ts-900000 ORDER BY s.ts DESC LIMIT 1) btc_price_15m_ago,
      (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=b.coin AND s.ts>b.snapshot_ts AND s.ts<=b.snapshot_ts+${V07_WINDOW_MS} AND s.price>=b.price*(1+${V07_TOUCH_PCT}/100.0)) first_up_ts,
      (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=b.coin AND s.ts>b.snapshot_ts AND s.ts<=b.snapshot_ts+${V07_WINDOW_MS} AND s.price<=b.price*(1-${V07_TOUCH_PCT}/100.0)) first_down_ts
    FROM base b ORDER BY b.snapshot_ts ASC,b.id ASC
  `).bind(Date.now()).all();
  const sampled:any[]=q?.results??[];
  const rows=sampled.filter((r:any)=>r.first_up_ts!=null||r.first_down_ts!=null);
  if(rows.length<300)return {status:'WAITING_FOR_EPISODE_DIRECTIONAL_DATA',sampled_rows:sampled.length,directional_rows:rows.length,required:300,episode_minutes:5};
  const split=Math.max(1,Math.floor(rows.length*0.70)), train=rows.slice(0,split), test=rows.slice(split);
  const actual=(r:any):0|1=>(r.first_up_ts!=null&&(r.first_down_ts==null||num(r.first_up_ts)<num(r.first_down_ts)))?1:0;
  let w=v07ZeroWeights();
  for(let epoch=0;epoch<5;epoch++)for(const r of train)w=v07Learn(v07Features(r),actual(r),w,0.012);
  let correct=0,longN=0,shortN=0; const coinStats:Record<string,any>={};
  const th=[0.55,0.60,0.65,0.70], buckets:Record<string,any>={}; th.forEach(t=>buckets[String(t)]={selected:0,correct:0,long:0,short:0});
  for(const r of test){
    const y=actual(r); y?longN++:shortN++; const p=v07Probability(v07Features(r),w), pred=p>=0.5?1:0, ok=pred===y; if(ok)correct++;
    const coin=String(r.coin??'UNKNOWN'); const cs=coinStats[coin]??(coinStats[coin]={total:0,correct:0,actualLong:0,actualShort:0,predLong:0,predShort:0});
    cs.total++; if(ok)cs.correct++; y?cs.actualLong++:cs.actualShort++; pred?cs.predLong++:cs.predShort++;
    const conf=Math.max(p,1-p); for(const t of th)if(conf>=t){const b=buckets[String(t)];b.selected++;if(ok)b.correct++;pred?b.long++:b.short++;}
  }
  const acc=test.length?correct/test.length*100:null, base=test.length?Math.max(longN,shortN)/test.length*100:null;
  await env.DB.prepare(`INSERT OR REPLACE INTO ml_raw_v07_model(model_key,trained_at,episode_minutes,sampled_rows,directional_rows,training_rows,test_rows,test_correct,test_accuracy,majority_baseline,weights_json) VALUES(?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,?)`)
    .bind(V07_MODEL_KEY,5,sampled.length,rows.length,train.length,test.length,correct,acc,base,JSON.stringify(w)).run();
  return {status:'TRAINED_AND_FROZEN',model_key:V07_MODEL_KEY,target:'FIRST_TOUCH_+0.20_VS_-0.20_WITHIN_10M',episode_sampling:'ONE_PER_COIN_PER_5M_BUCKET',sampled_rows:sampled.length,directional_rows:rows.length,train_rows:train.length,test_rows:test.length,test_correct:correct,test_accuracy_pct:acc==null?null:Number(acc.toFixed(2)),majority_baseline_pct:base==null?null:Number(base.toFixed(2)),beats_majority_baseline:acc!=null&&base!=null&&acc>base,confidence_filters:th.map(t=>{const b=buckets[String(t)];return {minimum_confidence:`${Math.round(t*100)}%`,signals_selected:b.selected,long_predictions:b.long,short_predictions:b.short,correct:b.correct,accuracy_pct:b.selected?Number((b.correct/b.selected*100).toFixed(2)):null};}),by_coin:Object.entries(coinStats).map(([coin,x]:any)=>({coin,test_samples:x.total,correct:x.correct,accuracy_pct:x.total?Number((x.correct/x.total*100).toFixed(2)):null,actual_long:x.actualLong,actual_short:x.actualShort,predicted_long:x.predLong,predicted_short:x.predShort})).sort((a,b)=>b.test_samples-a.test_samples),weights:w};
}

async function createV07Forward(env:Env):Promise<number>{
  const model=await getV07Model(env); if(!model)return 0;
  const q:any=await env.DB.prepare(`SELECT s.*,
    (SELECT x.price FROM market_snapshots x WHERE x.coin=s.coin AND x.ts<=s.ts-60000 ORDER BY x.ts DESC LIMIT 1) price_1m_ago,
    (SELECT x.price FROM market_snapshots x WHERE x.coin=s.coin AND x.ts<=s.ts-300000 ORDER BY x.ts DESC LIMIT 1) price_5m_ago,
    (SELECT x.price FROM market_snapshots x WHERE x.coin=s.coin AND x.ts<=s.ts-900000 ORDER BY x.ts DESC LIMIT 1) price_15m_ago,
    (SELECT x.open_interest FROM market_snapshots x WHERE x.coin=s.coin AND x.ts<=s.ts-300000 ORDER BY x.ts DESC LIMIT 1) oi_5m_ago,
    (SELECT x.price FROM market_snapshots x WHERE x.coin='BTC' AND x.ts<=s.ts ORDER BY x.ts DESC LIMIT 1) btc_price,
    (SELECT x.price FROM market_snapshots x WHERE x.coin='BTC' AND x.ts<=s.ts-60000 ORDER BY x.ts DESC LIMIT 1) btc_price_1m_ago,
    (SELECT x.price FROM market_snapshots x WHERE x.coin='BTC' AND x.ts<=s.ts-300000 ORDER BY x.ts DESC LIMIT 1) btc_price_5m_ago,
    (SELECT x.price FROM market_snapshots x WHERE x.coin='BTC' AND x.ts<=s.ts-900000 ORDER BY x.ts DESC LIMIT 1) btc_price_15m_ago
    FROM market_snapshots s INNER JOIN(SELECT coin,MAX(ts) max_ts FROM market_snapshots GROUP BY coin)z ON z.coin=s.coin AND z.max_ts=s.ts
    WHERE s.price>0 AND NOT EXISTS(SELECT 1 FROM ml_raw_v07_forward f WHERE f.model_key=? AND f.source_snapshot_id=s.id)`)
    .bind(V07_MODEL_KEY).all();
  let n=0; for(const r of q?.results??[]){const x=v07Features(r),p=v07Probability(x,model.weights),side=p>=0.5?'LONG':'SHORT',conf=Math.max(p,1-p);
    const z:any=await env.DB.prepare(`INSERT OR IGNORE INTO ml_raw_v07_forward(model_key,source_snapshot_id,coin,snapshot_ts,snapshot_datetime,entry_price,probability_long,predicted_side,confidence,features_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(V07_MODEL_KEY,r.id,r.coin,r.ts,r.datetime??null,r.price,p,side,conf,JSON.stringify(x)).run(); n+=Math.max(0,Math.trunc(num(z?.meta?.changes)));}
  return n;
}

async function resolveV07Forward(env:Env):Promise<number>{
  const now=Date.now(); const r:any=await env.DB.prepare(`UPDATE ml_raw_v07_forward SET
    first_up_ts=(SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price>=ml_raw_v07_forward.entry_price*(1+${V07_TOUCH_PCT}/100.0)),
    first_down_ts=(SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price<=ml_raw_v07_forward.entry_price*(1-${V07_TOUCH_PCT}/100.0)),
    actual_class=CASE WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price>=ml_raw_v07_forward.entry_price*(1+${V07_TOUCH_PCT}/100.0)) IS NULL AND (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price<=ml_raw_v07_forward.entry_price*(1-${V07_TOUCH_PCT}/100.0)) IS NULL THEN 'NONE' WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price<=ml_raw_v07_forward.entry_price*(1-${V07_TOUCH_PCT}/100.0)) IS NULL THEN 'LONG' WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price>=ml_raw_v07_forward.entry_price*(1+${V07_TOUCH_PCT}/100.0)) IS NULL THEN 'SHORT' WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price>=ml_raw_v07_forward.entry_price*(1+${V07_TOUCH_PCT}/100.0)) < (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price<=ml_raw_v07_forward.entry_price*(1-${V07_TOUCH_PCT}/100.0)) THEN 'LONG' ELSE 'SHORT' END,
    correct=CASE WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price>=ml_raw_v07_forward.entry_price*(1+${V07_TOUCH_PCT}/100.0)) IS NULL AND (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price<=ml_raw_v07_forward.entry_price*(1-${V07_TOUCH_PCT}/100.0)) IS NULL THEN NULL WHEN predicted_side=CASE WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price<=ml_raw_v07_forward.entry_price*(1-${V07_TOUCH_PCT}/100.0)) IS NULL THEN 'LONG' WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price>=ml_raw_v07_forward.entry_price*(1+${V07_TOUCH_PCT}/100.0)) IS NULL THEN 'SHORT' WHEN (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price>=ml_raw_v07_forward.entry_price*(1+${V07_TOUCH_PCT}/100.0)) < (SELECT MIN(s.ts) FROM market_snapshots s WHERE s.coin=ml_raw_v07_forward.coin AND s.ts>ml_raw_v07_forward.snapshot_ts AND s.ts<=ml_raw_v07_forward.snapshot_ts+${V07_WINDOW_MS} AND s.price<=ml_raw_v07_forward.entry_price*(1-${V07_TOUCH_PCT}/100.0)) THEN 'LONG' ELSE 'SHORT' END THEN 1 ELSE 0 END,
    outcome_ready=1,resolved_at=CURRENT_TIMESTAMP WHERE model_key=? AND outcome_ready=0 AND snapshot_ts<=?-${V07_WINDOW_MS}`)
    .bind(V07_MODEL_KEY,now).run(); return Math.max(0,Math.trunc(num(r?.meta?.changes)));
}

async function getV07Status(env:Env):Promise<any>{
  await ensureV07Tables(env); const training=await trainV07Once(env);
  const totals:any=await env.DB.prepare(`SELECT COUNT(*) predictions,SUM(outcome_ready=0) pending,SUM(outcome_ready=1) resolved,SUM(actual_class='NONE') none_resolved,SUM(actual_class IN ('LONG','SHORT')) directional_resolved,SUM(correct=1) correct FROM ml_raw_v07_forward WHERE model_key=?`).bind(V07_MODEL_KEY).first();
  const rows:any=await env.DB.prepare(`SELECT confidence,predicted_side,actual_class,correct,outcome_ready,coin FROM ml_raw_v07_forward WHERE model_key=?`).bind(V07_MODEL_KEY).all();
  const all:any[]=rows?.results??[], thresholds=[0.55,0.60,0.65,0.70];
  const filters=thresholds.map(t=>{const e=all.filter(r=>num(r.confidence)>=t),d=e.filter(r=>r.actual_class==='LONG'||r.actual_class==='SHORT'),c=d.filter(r=>num(r.correct)===1).length;return {minimum_confidence:`${Math.round(t*100)}%`,predictions:e.length,pending:e.filter(r=>num(r.outcome_ready)===0).length,directional_resolved:d.length,correct:c,accuracy_pct:d.length?Number((c/d.length*100).toFixed(2)):null,predicted_long:e.filter(r=>r.predicted_side==='LONG').length,predicted_short:e.filter(r=>r.predicted_side==='SHORT').length};});
  const coins=[...new Set(all.map(r=>String(r.coin)))].sort().map(coin=>{const e=all.filter(r=>String(r.coin)===coin),d=e.filter(r=>r.actual_class==='LONG'||r.actual_class==='SHORT'),c=d.filter(r=>num(r.correct)===1).length;return {coin,predictions:e.length,pending:e.filter(r=>num(r.outcome_ready)===0).length,directional_resolved:d.length,correct:c,accuracy_pct:d.length?Number((c/d.length*100).toFixed(2)):null};});
  const d=num(totals?.directional_resolved),c=num(totals?.correct);
  return {model_key:V07_MODEL_KEY,model:'AI_LOGISTIC_REGIME_RELATIVE_FIRST_TOUCH',research_only:true,trading_enabled:false,target:`FIRST +${V07_TOUCH_PCT}% vs -${V07_TOUCH_PCT}% within 10m`,episode_sampling:'ONE_PER_COIN_PER_5M_BUCKET_FOR_TRAINING',features:['chart','orderFlow','funding','premium','momentum1m','momentum5m','momentum15m','oiChange5m','btcMomentum1m','btcMomentum5m','btcMomentum15m','btcAcceleration','relative1m','relative5m','relative15m','relativeAcceleration'],training,predictions:num(totals?.predictions),pending:num(totals?.pending),resolved:num(totals?.resolved),none_resolved:num(totals?.none_resolved),directional_resolved:d,correct:c,directional_accuracy_pct:d?Number((c/d*100).toFixed(2)):null,confidence_filters:filters,by_coin:coins};
}


// ============================================================
// CRON ENTRY
// ============================================================

export async function updateRawML(env: Env): Promise<any> {
  await ensureTables(env);
  await ensureForwardTable(env);
  await ensureV06Tables(env);
  await ensureV07Tables(env);

  const snapshotsAdded = await collectLatestPerCoin(env);

  // CPU-safe raw labels.
  const labels5 = await fill5m(env);
  const labels15 = await fill15m(env);
  const labels30 = await fill30m(env);

  // Frozen forward validation: predict newest snapshots, then resolve old ones.
  const forwardPredictionsAdded = await createForwardPredictions(env);
  const forwardResolved = await resolveForwardPredictions(env);

  // V0.6 stays research-only. Train once/freeze, then create and resolve forward predictions.
  await trainV06Once(env);
  const v06ForwardPredictionsAdded = await createV06Forward(env);
  const v06ForwardResolved = await resolveV06Forward(env);

  // V0.7 regime + relative-move model: separate frozen research benchmark.
  await trainV07Once(env);
  const v07ForwardPredictionsAdded = await createV07Forward(env);
  const v07ForwardResolved = await resolveV07Forward(env);

  await markHealth(env);

  return {
    module: MODULE,
    version: "V0.7 REGIME + RELATIVE MOVE + V0.6/V0.5 CONTROL",
    mode: "RAW_DATASET_STREAM",
    trading: "REAL_TRADING_DISABLED",
    snapshots_added: snapshotsAdded,
    labels_5m_added: labels5,
    labels_15m_added: labels15,
    labels_30m_added: labels30,
    forward_predictions_added: forwardPredictionsAdded,
    forward_resolved: forwardResolved,
    v06_forward_predictions_added: v06ForwardPredictionsAdded,
    v06_forward_resolved: v06ForwardResolved,
    v07_forward_predictions_added: v07ForwardPredictionsAdded,
    v07_forward_resolved: v07ForwardResolved,
  };
}

// ============================================================
// STATUS
// ============================================================

export async function getRawMLStatus(env: Env): Promise<any> {
  await ensureTables(env);
  await ensureForwardTable(env);
  await ensureV06Tables(env);
  await ensureV07Tables(env);

  const health: any = await env.DB.prepare(`
    SELECT module, runs, last_run, status
    FROM ml_module_health
    WHERE module = ?
    LIMIT 1
  `).bind(MODULE).first();

  const totals: any = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT coin) AS coins,
      MIN(snapshot_datetime) AS first_snapshot,
      MAX(snapshot_datetime) AS latest_snapshot,
      SUM(label_5m_ready) AS ready_5m,
      SUM(label_15m_ready) AS ready_15m,
      SUM(label_30m_ready) AS ready_30m
    FROM ml_raw_dataset
  `).first();

  const training = await runFirstTraining(env);
  const forward = await getForwardStatus(env);
  const v06 = await getV06Status(env);
  const v07 = await getV07Status(env);

  const totalRows = Math.max(0, Math.trunc(num(totals?.total_rows)));
  const ready5 = Math.max(0, Math.trunc(num(totals?.ready_5m)));
  const ready15 = Math.max(0, Math.trunc(num(totals?.ready_15m)));
  const ready30 = Math.max(0, Math.trunc(num(totals?.ready_30m)));
  const coins = Math.max(0, Math.trunc(num(totals?.coins)));

  return {
    module: MODULE,
    version: "V0.7 REGIME + RELATIVE MOVE + V0.6/V0.5 CONTROL",
    runs: Math.max(0, Math.trunc(num(health?.runs))),
    last_run: health?.last_run ?? null,
    status: health?.status ?? "NEW",

    easy_read: {
      mode: "CPU SAFE STREAMING",
      explanation:
        "Всеки run взима само най-новия snapshot за всяка монета. Не наваксва стотици стари редове наведнъж.",
      total_market_states_collected: totalRows,
      coins_seen: coins,
      future_results_ready: {
        after_5m: ready5,
        after_15m: ready15,
        after_30m: ready30,
      },
      first_snapshot: totals?.first_snapshot ?? null,
      latest_snapshot: totals?.latest_snapshot ?? null,
      ready_for_first_training: ready30 >= 1000,
      simple_conclusion:
        ready30 >= 1000
          ? "Имаме поне 1000 записа с готов 30m резултат. Можем да подготвим първия Raw ML training тест."
          : `Събираме dataset постепенно. Готови 30m резултати: ${ready30}/1000 за първия training тест.`,
    },

    cpu_safety: {
      historical_backfill_loop: false,
      per_row_label_queries: false,
      collection: "LATEST_PER_COIN_ONLY",
      label_updates_per_run: 3,
    },

    first_training: training,
    forward_validation: forward,
    ai_first_touch_v06: v06,
    regime_relative_v07: v07,
    training_note:
      "V0.5 and V0.6 remain frozen controls. V0.7 adds 5m episode sampling plus BTC regime and coin-vs-BTC relative features, freezes once, then only performs forward validation.",
    mechanical_score_filter: "NONE",
    trading: "REAL_TRADING_DISABLED",
  };
}
