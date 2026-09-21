// ============================================================
// CRYPTOBOT ML — RAW LEARNING V0.5 FORWARD VALIDATION
// RESEARCH ONLY / NO TRADING / NO EFFECT ON MECHANICAL SYSTEM
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
// CRON ENTRY
// ============================================================

export async function updateRawML(env: Env): Promise<any> {
  await ensureTables(env);
  await ensureForwardTable(env);

  const snapshotsAdded = await collectLatestPerCoin(env);

  // CPU-safe raw labels.
  const labels5 = await fill5m(env);
  const labels15 = await fill15m(env);
  const labels30 = await fill30m(env);

  // Frozen forward validation: predict newest snapshots, then resolve old ones.
  const forwardPredictionsAdded = await createForwardPredictions(env);
  const forwardResolved = await resolveForwardPredictions(env);

  await markHealth(env);

  return {
    module: MODULE,
    version: "V0.5 FORWARD VALIDATION",
    mode: "RAW_DATASET_STREAM",
    trading: "REAL_TRADING_DISABLED",
    snapshots_added: snapshotsAdded,
    labels_5m_added: labels5,
    labels_15m_added: labels15,
    labels_30m_added: labels30,
    forward_predictions_added: forwardPredictionsAdded,
    forward_resolved: forwardResolved,
  };
}

// ============================================================
// STATUS
// ============================================================

export async function getRawMLStatus(env: Env): Promise<any> {
  await ensureTables(env);
  await ensureForwardTable(env);

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

  const totalRows = Math.max(0, Math.trunc(num(totals?.total_rows)));
  const ready5 = Math.max(0, Math.trunc(num(totals?.ready_5m)));
  const ready15 = Math.max(0, Math.trunc(num(totals?.ready_15m)));
  const ready30 = Math.max(0, Math.trunc(num(totals?.ready_30m)));
  const coins = Math.max(0, Math.trunc(num(totals?.coins)));

  return {
    module: MODULE,
    version: "V0.5 FORWARD VALIDATION",
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
    training_note:
      "Training runs only when /ml-raw status is requested; normal cron collection does not train the model.",
    mechanical_score_filter: "NONE",
    trading: "REAL_TRADING_DISABLED",
  };
}
