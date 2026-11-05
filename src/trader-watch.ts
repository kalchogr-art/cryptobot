// BTC TRADER WATCH V1.2
// LIVE LATENCY / BACKFILL / WS COVERAGE / COPY WINDOW
// READ ONLY — NO ORDERS, NO SIGNING, NO TRADING

const WS_URL = "wss://api.hyperliquid.xyz/ws";
const INFO_URL = "https://api.hyperliquid.xyz/info";

const TARGET =
  "0xbb160cb61e694570f9d570f9fcde7c61dd2143ad";

const VERSION = "BTC TRADER WATCH V1.2";

const AUDIT_INTERVAL_MS = 60_000;
const AUDIT_WINDOW_MS = 5 * 60_000;
const ALARM_INTERVAL_MS = 10_000;
const MAX_SAMPLES = 3000;
const MAX_IDS = 12000;
const SHADOW_NOTIONAL_USD = 100;
const SHADOW_TAKER_FEE_RATE = 0.00045; // configurable assumption, not account-specific
const SHADOW_MAX_TRADES = 1000;
const BOOK_MAX_AGE_MS = 1500;

type ShadowPosition = { side: "LONG" | "SHORT"; qty: number; entryPrice: number; openedAt: number; entryFees: number; traderQty: number };
type ShadowTrade = { side: string; openedAt: number; closedAt: number; entryPrice: number; exitPrice: number; qty: number; grossUsd: number; feesUsd: number; netUsd: number; holdSeconds: number; reason: string };


type Source = "WS_LIVE" | "WS_HISTORICAL" | "API_BACKFILL";

type Sample = {
  tid: string;
  time: number;
  received: number;
  latency_ms: number;
  coin: string;
  side: string;
  dir: string;
  px: string;
  sz: string;
  closedPnl: string;
  fee: string;
  source: Source;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * q);

  return sorted[index];
}

function latencyStats(values: number[]) {
  return {
    count: values.length,
    p50: percentile(values, 0.50),
    p90: percentile(values, 0.90),
    p99: percentile(values, 0.99),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null
  };
}

export class TraderWatch {
  private ctx: any;
  private env: any;

  private ws: WebSocket | null = null;
  private queue: Promise<void> = Promise.resolve();

  private samples: Sample[] = [];
  private ids: string[] = [];
  private shadow: { position: ShadowPosition | null; trades: ShadowTrade[]; skipped: Record<string, number>; quotes: number; lastQuoteAt: number; initialized: boolean } = {
    position: null, trades: [], skipped: {}, quotes: 0, lastQuoteAt: 0, initialized: false
  };

  private state: any = {
    version: VERSION,
    active: false,
    connected: false,

    started_at: 0,
    subscribed_at: 0,

    last_message_at: 0,
    last_fill_at: 0,
    last_audit_at: 0,

    reconnects: 0,
    ws_messages: 0,

    ws_live_fills: 0,
    ws_historical_fills: 0,

    api_checked: 0,
    api_backfill: 0,

    errors: []
  };

  constructor(ctx: any, env: any) {
    this.ctx = ctx;
    this.env = env;

    ctx.blockConcurrencyWhile(async () => {
      this.state =
        (await ctx.storage.get("state")) ?? this.state;

      this.samples =
        (await ctx.storage.get("samples")) ?? [];

      this.ids =
        (await ctx.storage.get("ids")) ?? [];
      this.shadow = (await ctx.storage.get("shadow")) ?? this.shadow;

      if (this.state.active) {
        await ctx.storage.setAlarm(Date.now() + 1000);
      }
    });
  }

  private async persist() {
    await this.ctx.storage.put({
      state: this.state,
      samples: this.samples,
      ids: this.ids,
      shadow: this.shadow
    });
  }

  private error(error: unknown) {
    this.state.errors = [
      ...(this.state.errors ?? []).slice(-9),
      {
        at: Date.now(),
        message: String(error)
      }
    ];
  }

  private fillId(fill: any): string {
    return [
      fill?.coin ?? "",
      fill?.tid ?? "",
      fill?.hash ?? ""
    ].join(":");
  }

  private take(fill: any, source: "WS" | "API"): Source | null {
    if (String(fill?.coin).toUpperCase() !== "BTC") {
      return null;
    }

    const id = this.fillId(fill);

    if (!fill?.tid || this.ids.includes(id)) {
      return null;
    }

    const received = Date.now();
    const time = Number(fill?.time);

    if (!Number.isFinite(time) || time <= 0) {
      return null;
    }

    const latency = received - time;

    let classified: Source;

    if (source === "API") {
      classified = "API_BACKFILL";
      this.state.api_backfill++;
    } else {
      // Exclude fills predating the established subscription.
      const subscriptionStart =
        Number(this.state.subscribed_at ?? 0);

      const live =
        subscriptionStart > 0 &&
        time >= subscriptionStart;

      classified = live ? "WS_LIVE" : "WS_HISTORICAL";

      if (live) {
        this.state.ws_live_fills++;
      } else {
        this.state.ws_historical_fills++;
      }
    }

    this.ids.push(id);

    if (this.ids.length > MAX_IDS) {
      this.ids.splice(0, this.ids.length - MAX_IDS);
    }

    this.samples.push({
      tid: String(fill.tid),
      time,
      received,
      latency_ms: latency,
      coin: String(fill.coin),
      side: String(fill.side ?? ""),
      dir: String(fill.dir ?? ""),
      px: String(fill.px ?? ""),
      sz: String(fill.sz ?? ""),
      closedPnl: String(fill.closedPnl ?? ""),
      fee: String(fill.fee ?? ""),
      source: classified
    });

    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(
        0,
        this.samples.length - MAX_SAMPLES
      );
    }

    this.state.last_fill_at = received;

    return classified;
  }

  private async onMessage(raw: unknown) {
    let message: any;

    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    this.state.last_message_at = Date.now();
    this.state.ws_messages++;

    if (message?.channel !== "userFills") {
      return;
    }

    const data = message.data;

    const fills = Array.isArray(data?.fills)
      ? data.fills
      : Array.isArray(data)
        ? data
        : [];

    for (const fill of fills) {
      const source = this.take(fill, "WS");
      if (source === "WS_LIVE") {
        try { await this.shadowFill(fill); }
        catch (e) { this.shadowSkip("QUOTE_OR_PROCESSING_ERROR"); this.error(e); }
      }
    }

    await this.persist();
  }

  private connect() {
    if (!this.state.active) return;

    if (
      this.ws &&
      (
        this.ws.readyState === WebSocket.CONNECTING ||
        this.ws.readyState === WebSocket.OPEN
      )
    ) {
      return;
    }

    const ws = new WebSocket(WS_URL);

    this.ws = ws;

    ws.addEventListener("open", () => {
      if (!this.state.active) {
        ws.close();
        return;
      }

      this.state.connected = true;
      this.state.subscribed_at = Date.now();
      this.state.last_message_at = Date.now();

      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: {
          type: "userFills",
          user: TARGET
        }
      }));

      this.persist().catch(() => {});
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      this.queue = this.queue
        .then(() => this.onMessage(event.data))
        .catch(error => {
          this.error(error);
        });
    });

    const disconnect = () => {
      if (this.ws !== ws) return;

      this.state.connected = false;
      this.ws = null;

      if (this.state.active) {
        this.ctx.storage
          .setAlarm(Date.now() + 1000)
          .catch(() => {});
      }
    };

    ws.addEventListener("close", disconnect);
    ws.addEventListener("error", disconnect);
  }

  private shadowSkip(reason: string) {
    this.shadow.skipped[reason] = (this.shadow.skipped[reason] ?? 0) + 1;
  }

  // Order-book top of book is a quoted price, NOT a guaranteed executable fill.
  // Fetch only when acting on a LIVE WS fill; never use trader's execution price.
  private async quote(side: "BUY" | "SELL"): Promise<number> {
    const r = await fetch(INFO_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin: "BTC" })
    });
    if (!r.ok) throw new Error(`BOOK_HTTP_${r.status}`);
    const book: any = await r.json();
    const levels = book?.levels;
    const level = side === "BUY" ? levels?.[1]?.[0] : levels?.[0]?.[0];
    const px = Number(level?.px);
    if (!Number.isFinite(px) || px <= 0) throw new Error("INVALID_BOOK_PRICE");
    this.shadow.quotes++;
    this.shadow.lastQuoteAt = Date.now();
    return px;
  }

  private async shadowFill(fill: any) {
    const dir = String(fill?.dir ?? "").toLowerCase();
    const qty = Number(fill?.sz);
    if (!Number.isFinite(qty) || qty <= 0) { this.shadowSkip("INVALID_SIZE"); return; }
    const openLong = dir.includes("open long");
    const openShort = dir.includes("open short");
    const closeLong = dir.includes("close long");
    const closeShort = dir.includes("close short");
    if (![openLong, openShort, closeLong, closeShort].some(Boolean)) {
      this.shadowSkip("UNSUPPORTED_DIRECTION"); return;
    }
    const side: "LONG" | "SHORT" = openLong || closeLong ? "LONG" : "SHORT";
    const isOpen = openLong || openShort;
    const pos = this.shadow.position;
    if (!isOpen && (!pos || pos.side !== side)) {
      this.shadowSkip("UNMATCHED_CLOSE_OR_PREEXISTING_POSITION"); return;
    }
    if (isOpen && pos && pos.side !== side) {
      // Ambiguous state: do not invent a reversal execution or entry.
      this.shadowSkip("OPPOSITE_OPEN_WITHOUT_MATCHED_CLOSE"); return;
    }
    const action: "BUY" | "SELL" = isOpen
      ? (side === "LONG" ? "BUY" : "SELL")
      : (side === "LONG" ? "SELL" : "BUY");
    const px = await this.quote(action);
    const now = Date.now();
    if (isOpen) {
      if (!pos) {
        const shadowQty = SHADOW_NOTIONAL_USD / px;
        this.shadow.position = {
          side, qty: shadowQty, entryPrice: px, openedAt: now,
          entryFees: shadowQty * px * SHADOW_TAKER_FEE_RATE,
          traderQty: qty
        };
      } else {
        // Follow proportional increases relative to observed trader position.
        const added = pos.qty * (qty / Math.max(pos.traderQty, 1e-12));
        const newQty = pos.qty + added;
        pos.entryPrice = (pos.entryPrice * pos.qty + px * added) / newQty;
        pos.entryFees += added * px * SHADOW_TAKER_FEE_RATE;
        pos.qty = newQty;
        pos.traderQty += qty;
      }
      return;
    }
    if (!pos) return;
    const fraction = Math.min(1, qty / Math.max(pos.traderQty, 1e-12));
    const closedQty = pos.qty * fraction;
    const entryFeePart = pos.entryFees * fraction;
    const exitFee = closedQty * px * SHADOW_TAKER_FEE_RATE;
    const gross = (px - pos.entryPrice) * closedQty * (side === "LONG" ? 1 : -1);
    const fees = entryFeePart + exitFee;
    this.shadow.trades.push({
      side, openedAt: pos.openedAt, closedAt: now,
      entryPrice: pos.entryPrice, exitPrice: px, qty: closedQty,
      grossUsd: gross, feesUsd: fees, netUsd: gross - fees,
      holdSeconds: (now - pos.openedAt) / 1000,
      reason: fraction >= 0.999999 ? "FULL_CLOSE" : "PARTIAL_CLOSE"
    });
    if (this.shadow.trades.length > SHADOW_MAX_TRADES) {
      this.shadow.trades.splice(0, this.shadow.trades.length - SHADOW_MAX_TRADES);
    }
    pos.qty -= closedQty;
    pos.traderQty = Math.max(0, pos.traderQty - qty);
    pos.entryFees -= entryFeePart;
    if (fraction >= 0.999999 || pos.qty < 1e-12) this.shadow.position = null;
  }

  private shadowStats() {
    const trades = this.shadow.trades;
    const net = trades.reduce((v, t) => v + t.netUsd, 0);
    const wins = trades.filter(t => t.netUsd > 0).length;
    return {
      mode: "READ_ONLY_SHADOW", version: VERSION,
      simulated_notional_usd_per_initial_entry: SHADOW_NOTIONAL_USD,
      assumed_taker_fee_rate_per_side: SHADOW_TAKER_FEE_RATE,
      price_source: "Hyperliquid BTC l2Book best ask/bid at signal processing time",
      current_position: this.shadow.position,
      completed_close_events: trades.length,
      winning_close_events: wins,
      win_rate_pct: trades.length ? Number((100 * wins / trades.length).toFixed(2)) : null,
      realized_net_usd: Number(net.toFixed(6)),
      realized_gross_usd: Number(trades.reduce((v,t) => v+t.grossUsd,0).toFixed(6)),
      total_fees_usd: Number(trades.reduce((v,t) => v+t.feesUsd,0).toFixed(6)),
      quotes: this.shadow.quotes,
      skipped: this.shadow.skipped,
      last_quote_at: this.shadow.lastQuoteAt,
      recent_trades: trades.slice(-20),
      warnings: [
        "Indicative best bid/ask quotes; not verified executions, depth or market impact.",
        "Starts with no assumed trader position; unmatched closes are skipped.",
        "Open positions have no unrealized P/L; funding is excluded.",
        "A quote request adds latency and may overstate achievable execution quality.",
        "Multiple partial close events are not independent complete trades."
      ]
    };
  }

  private async reconcile() {
    const now = Date.now();

    const start = now - AUDIT_WINDOW_MS;

    const response = await fetch(INFO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        type: "userFillsByTime",
        user: TARGET,
        startTime: start,
        endTime: now,
        aggregateByTime: false
      })
    });

    if (!response.ok) {
      throw new Error(
        `HYPERLIQUID_INFO_HTTP_${response.status}`
      );
    }

    const data: any = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("INVALID_API_FILLS");
    }

    const btc = data.filter(
      (fill: any) =>
        String(fill?.coin).toUpperCase() === "BTC"
    );

    this.state.api_checked += btc.length;

    for (const fill of btc) {
      this.take(fill, "API");
    }

    this.state.last_audit_at = now;

    this.state.audit_truncation_risk =
      data.length >= 1900;

    await this.persist();
  }

  private getLiveSamples(): Sample[] {
    return this.samples.filter(
      sample => sample.source === "WS_LIVE"
    );
  }

  private getCopyWindow() {
    const live = this.getLiveSamples()
      .sort((a, b) => a.time - b.time);

    let lastOpen: Sample | null = null;

    const completed: number[] = [];

    for (const fill of live) {
      const dir = fill.dir.toLowerCase();

      const isOpen =
        dir.includes("open long") ||
        dir.includes("open short");

      const isClose =
        dir.includes("close long") ||
        dir.includes("close short");

      if (isOpen) {
        if (!lastOpen) {
          lastOpen = fill;
        }
      }

      if (isClose && lastOpen) {
        const seconds =
          (fill.time - lastOpen.time) / 1000;

        if (seconds >= 0) {
          completed.push(seconds);
        }

        lastOpen = null;
      }
    }

    return {
      status: "PRELIMINARY",
      detected_intervals: completed.length,

      duration_seconds: {
        p50: percentile(completed, 0.50),
        p90: percentile(completed, 0.90),
        min: completed.length
          ? Math.min(...completed)
          : null,
        max: completed.length
          ? Math.max(...completed)
          : null
      },

      warning:
        "Partial fills, position increases and reversals are not fully reconstructed. These intervals are indicative only."
    };
  }

  private stats() {
    const live = this.getLiveSamples();

    const liveLatencies = live
      .map(sample => sample.latency_ms)
      .filter(value => value >= 0);

    const historical = this.samples.filter(
      sample => sample.source === "WS_HISTORICAL"
    );

    const backfill = this.samples.filter(
      sample => sample.source === "API_BACKFILL"
    );

    const verified = live.length + backfill.filter(
      sample =>
        sample.time >= Number(this.state.subscribed_at || 0)
    ).length;

    const coverage =
      verified > 0
        ? Number(
            ((live.length / verified) * 100).toFixed(2)
          )
        : null;

    return {
      version: VERSION,
      target: TARGET,

      connection: {
        active: this.state.active,
        connected: this.state.connected,
        started_at: this.state.started_at,
        subscribed_at: this.state.subscribed_at,
        last_message_at: this.state.last_message_at,
        reconnects: this.state.reconnects,
        ws_messages: this.state.ws_messages
      },

      live_latency_ms: latencyStats(liveLatencies),

      historical_backfill: {
        ws_historical: historical.length,
        api_backfill: backfill.length,
        api_checked_total: this.state.api_checked,
        last_audit_at: this.state.last_audit_at,
        audit_truncation_risk:
          this.state.audit_truncation_risk ?? false
      },

      ws_coverage: {
        observed_ws_live: live.length,
        observed_api_backfill_after_subscription:
          verified - live.length,
        observed_total: verified,
        percentage: coverage,
        status: "PRELIMINARY",

        warning:
          "Coverage is based on retained samples, not a complete audited fill ledger."
      },

      copy_window: this.getCopyWindow(),
      shadow_copy: this.shadowStats(),

      sample_count: this.samples.length,
      errors: this.state.errors ?? [],

      trading_enabled: false
    };
  }

  async alarm() {
    if (!this.state.active) return;

    if (
      !this.ws ||
      this.ws.readyState === WebSocket.CLOSED ||
      this.ws.readyState === WebSocket.CLOSING
    ) {
      this.state.reconnects++;
      this.connect();
    } else if (
      this.state.connected &&
      Date.now() - this.state.last_message_at > 45_000
    ) {
      try {
        this.ws.close();
      } catch {}

      this.ws = null;
      this.state.connected = false;
      this.state.reconnects++;

      this.connect();
    }

    if (
      !this.state.last_audit_at ||
      Date.now() - this.state.last_audit_at >=
        AUDIT_INTERVAL_MS
    ) {
      try {
        await this.reconcile();
      } catch (error) {
        this.error(error);
      }
    }

    await this.persist();

    await this.ctx.storage.setAlarm(
      Date.now() + ALARM_INTERVAL_MS
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/start") {
      this.state.active = true;

      this.state.started_at ||= Date.now();

      this.connect();

      await this.ctx.storage.setAlarm(
        Date.now() + ALARM_INTERVAL_MS
      );

      await this.persist();

      return json({
        ok: true,
        version: VERSION,
        active: true,
        target: TARGET
      });
    }

    if (path === "/stop") {
      this.state.active = false;
      this.state.connected = false;

      try {
        this.ws?.close(1000, "stopped");
      } catch {}

      this.ws = null;

      await this.persist();

      return json({
        ok: true,
        active: false
      });
    }

    if (path === "/audit") {
      try {
        await this.reconcile();

        return json({
          ok: true,
          ...this.stats()
        });
      } catch (error) {
        this.error(error);
        await this.persist();

        return json({
          ok: false,
          error: String(error)
        }, 502);
      }
    }

    if (path === "/status") {
      return json(this.stats());
    }

    if (path === "/shadow") {
      return json(this.shadowStats());
    }

    if (path === "/samples") {
      const limit = Math.min(
        500,
        Math.max(
          1,
          Number(url.searchParams.get("limit") || 100)
        )
      );

      return json({
        version: VERSION,
        target: TARGET,
        samples: this.samples.slice(-limit)
      });
    }

    return json({
      error: "NOT_FOUND"
    }, 404);
  }
}
