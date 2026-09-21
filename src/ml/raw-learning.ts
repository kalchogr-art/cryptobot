// ============================================================
// CRYPTOBOT ML — RAW LEARNING V0.3 FIRST TRAINING
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
  // Keep training bounded for Worker CPU. 2700-ish current rows are fine,
  // but cap the experiment to the latest 5000 labelled rows.
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

  const rows = data?.results ?? [];
  if (rows.length < 100) {
    return {
      status: "WAITING_FOR_DATA",
      labelled_rows: rows.length,
      required_minimum: 100,
    };
  }

  const split = Math.max(1, Math.floor(rows.length * 0.70));
  const train = rows.slice(0, split);
  const test = rows.slice(split);

  let w: RawWeights = {
    bias: 0,
    chart: 0,
    orderFlow: 0,
    funding: 0,
    premium: 0,
  };

  // One chronological pass only. No repeated epochs for this first test.
  for (const row of train) {
    const ret = num(row.return_30m_pct);
    const y: 0 | 1 = ret > 0 ? 1 : 0;
    w = learnRaw(rawFeatures(row), y, w, 0.03);
  }

  let correct = 0;
  let upActual = 0;
  let downActual = 0;

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

  for (const row of test) {
    const ret = num(row.return_30m_pct);
    const actualUp = ret > 0;
    if (actualUp) upActual += 1;
    else downActual += 1;

    const pUp = rawProbability(rawFeatures(row), w);
    const predictedUp = pUp >= 0.5;
    if (predictedUp === actualUp) correct += 1;

    for (const t of thresholds) {
      const confidence = Math.max(pUp, 1 - pUp);
      if (confidence < t) continue;

      const b = buckets[String(t)];
      b.selected += 1;
      if (predictedUp) b.long += 1;
      else b.short += 1;
      if (predictedUp === actualUp) b.correct += 1;
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

  const testAccuracy =
    test.length > 0
      ? Number(((correct / test.length) * 100).toFixed(2))
      : null;

  const majorityBaseline =
    test.length > 0
      ? Number(
          ((Math.max(upActual, downActual) / test.length) * 100).toFixed(2)
        )
      : null;

  return {
    status: "OK",
    target: "30M_DIRECTION_UP_VS_DOWN",
    mechanical_score_used: false,
    split: "CHRONOLOGICAL_70_30",
    total_rows: rows.length,
    train_rows: train.length,
    test_rows: test.length,
    test_period: {
      first_ts: test[0]?.snapshot_ts ?? null,
      last_ts: test[test.length - 1]?.snapshot_ts ?? null,
    },
    test_result: {
      correct,
      accuracy_pct: testAccuracy,
      actual_up: upActual,
      actual_down: downActual,
      majority_class_baseline_pct: majorityBaseline,
      beats_majority_baseline:
        testAccuracy != null &&
        majorityBaseline != null &&
        testAccuracy > majorityBaseline,
    },
    confidence_filters: filters,
    weights: w,
    warning:
      "First research test only. Adjacent minute snapshots remain correlated; do not use this result for trading decisions.",
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
// CRON ENTRY
// ============================================================

export async function updateRawML(env: Env): Promise<any> {
  await ensureTables(env);

  const snapshotsAdded = await collectLatestPerCoin(env);

  // Only 3 batch UPDATEs regardless of dataset size.
  const labels5 = await fill5m(env);
  const labels15 = await fill15m(env);
  const labels30 = await fill30m(env);

  await markHealth(env);

  return {
    module: MODULE,
    version: "V0.3 FIRST TRAINING",
    mode: "RAW_DATASET_STREAM",
    trading: "REAL_TRADING_DISABLED",
    snapshots_added: snapshotsAdded,
    labels_5m_added: labels5,
    labels_15m_added: labels15,
    labels_30m_added: labels30,
  };
}

// ============================================================
// STATUS
// ============================================================

export async function getRawMLStatus(env: Env): Promise<any> {
  await ensureTables(env);

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

  const totalRows = Math.max(0, Math.trunc(num(totals?.total_rows)));
  const ready5 = Math.max(0, Math.trunc(num(totals?.ready_5m)));
  const ready15 = Math.max(0, Math.trunc(num(totals?.ready_15m)));
  const ready30 = Math.max(0, Math.trunc(num(totals?.ready_30m)));
  const coins = Math.max(0, Math.trunc(num(totals?.coins)));

  return {
    module: MODULE,
    version: "V0.3 FIRST TRAINING",
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
    training_note:
      "Training runs only when /ml-raw status is requested; normal cron collection does not train the model.",
    mechanical_score_filter: "NONE",
    trading: "REAL_TRADING_DISABLED",
  };
}
