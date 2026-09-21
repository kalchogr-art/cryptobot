// ============================================================
// CRYPTOBOT ML — RAW LEARNING V0.2.1 CPU SAFE
// RESEARCH ONLY / NO TRADING / NO EFFECT ON MECHANICAL SYSTEM
//
// CPU FIX:
// - NO historical 500-row backfill loops.
// - Collect only the latest snapshot for each coin.
// - One batch INSERT statement per run.
// - Labels are filled with 3 set-based UPDATE statements (5m/15m/30m).
// - No per-row future-price SELECT loops.
// - Existing ml_raw_dataset from V0.2 is preserved.
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
    version: "V0.2.1 CPU SAFE",
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

  const totalRows = Math.max(0, Math.trunc(num(totals?.total_rows)));
  const ready5 = Math.max(0, Math.trunc(num(totals?.ready_5m)));
  const ready15 = Math.max(0, Math.trunc(num(totals?.ready_15m)));
  const ready30 = Math.max(0, Math.trunc(num(totals?.ready_30m)));
  const coins = Math.max(0, Math.trunc(num(totals?.coins)));

  return {
    module: MODULE,
    version: "V0.2.1 CPU SAFE",
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

    training: "NOT_STARTED_YET",
    mechanical_score_filter: "NONE",
    trading: "REAL_TRADING_DISABLED",
  };
}
