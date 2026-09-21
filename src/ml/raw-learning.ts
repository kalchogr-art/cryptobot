// ============================================================
// CRYPTOBOT ML — RAW LEARNING V0.2 DATASET COLLECTOR
// RESEARCH ONLY / NO TRADING / NO EFFECT ON MECHANICAL SYSTEM
//
// Goal:
// - Learn later from ALL market states, not only mechanical >=65 signals.
// - Uses existing market_snapshots as the raw source.
// - Copies each snapshot once into an independent ML dataset.
// - Fills future labels when +5m / +15m / +30m prices become available.
// - Does NOT train a model yet. First we build a clean dataset.
// ============================================================

export interface Env {
  DB: D1Database;
}

const MODULE = "raw-learning";
const COLLECT_LIMIT = 500;
const LABEL_LIMIT = 500;

function finiteOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(entry: number, future: number): number {
  return ((future / entry) - 1) * 100;
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
}

async function collectSnapshots(env: Env): Promise<number> {
  const rows: any = await env.DB.prepare(`
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
    LEFT JOIN ml_raw_dataset r
      ON r.source_snapshot_id = s.id
    WHERE r.source_snapshot_id IS NULL
      AND s.price IS NOT NULL
      AND s.price > 0
    ORDER BY s.ts ASC, s.id ASC
    LIMIT ?
  `).bind(COLLECT_LIMIT).all();

  let inserted = 0;

  for (const row of rows?.results ?? []) {
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.id,
      row.coin,
      row.ts,
      row.datetime ?? null,
      row.price,
      finiteOrNull(row.chart_signed),
      finiteOrNull(row.order_flow_signed),
      finiteOrNull(row.open_interest),
      finiteOrNull(row.funding),
      finiteOrNull(row.premium)
    ).run();

    if (result?.meta?.changes > 0) inserted += 1;
  }

  return inserted;
}

async function findFuturePrice(
  env: Env,
  coin: string,
  targetTs: number
): Promise<{ price: number; ts: number } | null> {
  // Accept the nearest snapshot from target time to +2 minutes.
  // This avoids using an earlier price and tolerates occasional missed cron runs.
  const row: any = await env.DB.prepare(`
    SELECT price, ts
    FROM market_snapshots
    WHERE coin = ?
      AND ts >= ?
      AND ts <= ?
      AND price IS NOT NULL
      AND price > 0
    ORDER BY ts ASC
    LIMIT 1
  `).bind(coin, targetTs, targetTs + 120000).first();

  if (!row) return null;

  const price = finiteOrNull(row.price);
  const ts = finiteOrNull(row.ts);
  if (price === null || ts === null) return null;

  return { price, ts };
}

async function fillLabels(env: Env): Promise<{
  rows_checked: number;
  labels_5m_added: number;
  labels_15m_added: number;
  labels_30m_added: number;
}> {
  const now = Date.now();

  const rows: any = await env.DB.prepare(`
    SELECT *
    FROM ml_raw_dataset
    WHERE
      (label_5m_ready = 0 AND snapshot_ts <= ?)
      OR (label_15m_ready = 0 AND snapshot_ts <= ?)
      OR (label_30m_ready = 0 AND snapshot_ts <= ?)
    ORDER BY snapshot_ts ASC
    LIMIT ?
  `).bind(
    now - 5 * 60 * 1000,
    now - 15 * 60 * 1000,
    now - 30 * 60 * 1000,
    LABEL_LIMIT
  ).all();

  let labels5 = 0;
  let labels15 = 0;
  let labels30 = 0;
  let checked = 0;

  for (const row of rows?.results ?? []) {
    checked += 1;

    const entryPrice = finiteOrNull(row.price);
    const baseTs = finiteOrNull(row.snapshot_ts);
    if (entryPrice === null || entryPrice <= 0 || baseTs === null) continue;

    let p5: number | null = null;
    let r5: number | null = null;
    let ready5 = Number(row.label_5m_ready) === 1 ? 1 : 0;

    let p15: number | null = null;
    let r15: number | null = null;
    let ready15 = Number(row.label_15m_ready) === 1 ? 1 : 0;

    let p30: number | null = null;
    let r30: number | null = null;
    let ready30 = Number(row.label_30m_ready) === 1 ? 1 : 0;

    if (!ready5 && baseTs <= now - 5 * 60 * 1000) {
      const future = await findFuturePrice(env, row.coin, baseTs + 5 * 60 * 1000);
      if (future) {
        p5 = future.price;
        r5 = pct(entryPrice, future.price);
        ready5 = 1;
        labels5 += 1;
      }
    }

    if (!ready15 && baseTs <= now - 15 * 60 * 1000) {
      const future = await findFuturePrice(env, row.coin, baseTs + 15 * 60 * 1000);
      if (future) {
        p15 = future.price;
        r15 = pct(entryPrice, future.price);
        ready15 = 1;
        labels15 += 1;
      }
    }

    if (!ready30 && baseTs <= now - 30 * 60 * 1000) {
      const future = await findFuturePrice(env, row.coin, baseTs + 30 * 60 * 1000);
      if (future) {
        p30 = future.price;
        r30 = pct(entryPrice, future.price);
        ready30 = 1;
        labels30 += 1;
      }
    }

    if (
      (p5 !== null && Number(row.label_5m_ready) !== 1) ||
      (p15 !== null && Number(row.label_15m_ready) !== 1) ||
      (p30 !== null && Number(row.label_30m_ready) !== 1)
    ) {
      await env.DB.prepare(`
        UPDATE ml_raw_dataset
        SET
          price_5m = COALESCE(?, price_5m),
          return_5m_pct = COALESCE(?, return_5m_pct),
          label_5m_ready = ?,

          price_15m = COALESCE(?, price_15m),
          return_15m_pct = COALESCE(?, return_15m_pct),
          label_15m_ready = ?,

          price_30m = COALESCE(?, price_30m),
          return_30m_pct = COALESCE(?, return_30m_pct),
          label_30m_ready = ?,

          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        p5, r5, ready5,
        p15, r15, ready15,
        p30, r30, ready30,
        row.id
      ).run();
    }
  }

  return {
    rows_checked: checked,
    labels_5m_added: labels5,
    labels_15m_added: labels15,
    labels_30m_added: labels30,
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

export async function updateRawML(env: Env): Promise<any> {
  await ensureTables(env);

  const collected = await collectSnapshots(env);
  const labels = await fillLabels(env);

  await markHealth(env);

  return {
    module: MODULE,
    mode: "RAW_DATASET_COLLECTOR",
    trading: "REAL_TRADING_DISABLED",
    snapshots_added: collected,
    ...labels,
  };
}

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
      SUM(label_30m_ready) AS ready_30m,
      AVG(return_5m_pct) AS avg_return_5m,
      AVG(return_15m_pct) AS avg_return_15m,
      AVG(return_30m_pct) AS avg_return_30m
    FROM ml_raw_dataset
  `).first();

  const byCoin: any = await env.DB.prepare(`
    SELECT
      coin,
      COUNT(*) AS rows,
      SUM(label_5m_ready) AS ready_5m,
      SUM(label_15m_ready) AS ready_15m,
      SUM(label_30m_ready) AS ready_30m
    FROM ml_raw_dataset
    GROUP BY coin
    ORDER BY coin ASC
  `).all();

  const totalRows = Math.max(0, Math.trunc(Number(totals?.total_rows ?? 0)));
  const ready30 = Math.max(0, Math.trunc(Number(totals?.ready_30m ?? 0)));

  return {
    module: MODULE,
    runs: Math.max(0, Math.trunc(Number(health?.runs ?? 0))),
    last_run: health?.last_run ?? null,
    status: health?.status ?? "NEW",

    easy_read: {
      what_is_this:
        "Независим ML dataset от всички market snapshots. Тук няма филтър ≥65.",
      total_market_states_collected: totalRows,
      coins_seen: Math.max(0, Math.trunc(Number(totals?.coins ?? 0))),
      future_results_ready: {
        after_5m: Math.max(0, Math.trunc(Number(totals?.ready_5m ?? 0))),
        after_15m: Math.max(0, Math.trunc(Number(totals?.ready_15m ?? 0))),
        after_30m: ready30,
      },
      first_snapshot: totals?.first_snapshot ?? null,
      latest_snapshot: totals?.latest_snapshot ?? null,
      ready_for_first_training:
        ready30 >= 1000,
      simple_conclusion:
        ready30 >= 1000
          ? "Имаме поне 1000 записа с известен 30-минутен резултат. Можем да започнем първия Raw ML training експеримент."
          : `Събираме чист dataset. За първия training тест целим поне 1000 записа с готов 30-минутен резултат; в момента са ${ready30}.`,
    },

    averages_research_only: {
      return_5m_pct:
        totals?.avg_return_5m == null
          ? null
          : Number(Number(totals.avg_return_5m).toFixed(5)),
      return_15m_pct:
        totals?.avg_return_15m == null
          ? null
          : Number(Number(totals.avg_return_15m).toFixed(5)),
      return_30m_pct:
        totals?.avg_return_30m == null
          ? null
          : Number(Number(totals.avg_return_30m).toFixed(5)),
    },

    by_coin: byCoin?.results ?? [],
    training: "NOT_STARTED_YET",
    mechanical_score_filter: "NONE",
    trading: "REAL_TRADING_DISABLED",
  };
}
