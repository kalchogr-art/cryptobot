// BTC TRADER WATCH V1.5.1
// LIVE LATENCY / BACKFILL / WS COVERAGE / COPY WINDOW
// READ ONLY — NO ORDERS, NO SIGNING, NO TRADING

const WS_URL = "wss://api.hyperliquid.xyz/ws";
const INFO_URL = "https://api.hyperliquid.xyz/info";

const TARGET =
  "0xbb160cb61e694570f9d570f9fcde7c61dd2143ad";

const VERSION = "BTC TRADER WATCH V1.5.1";

const AUDIT_INTERVAL_MS = 60_000;
const AUDIT_WINDOW_MS = 5 * 60_000;
const ALARM_INTERVAL_MS = 10_000;
const MAX_SAMPLES = 3000;
const MAX_IDS = 12000;
const SHADOW_NOTIONAL_USD = 100;
const SHADOW_TAKER_FEE_RATE = 0.00045; // configurable assumption, not account-specific
const SHADOW_MAX_TRADES = 1000;
const BOOK_MAX_AGE_MS = 5000; // bounded freshness; no HTTP quote fallback
const POSITION_EPS = 1e-9;
const SYNC_INTERVAL_MS = 60_000;
const SYNC_TOLERANCE = 0.000001;

type ShadowPosition = { side: "LONG" | "SHORT"; qty: number; entryPrice: number; openedAt: number; entryFees: number; traderQty: number; positionId?: string; realizedGross?: number; realizedFees?: number; closedQty?: number; initialNotional?: number; closeEvents?: number };
type ShadowTrade = { eventId?: string; side: string; openedAt: number; closedAt: number; entryPrice: number; exitPrice: number; qty: number; grossUsd: number; feesUsd: number; netUsd: number; holdSeconds: number; reason: string };


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

  private pendingLedger: ShadowTrade[] = [];
  private v15: any = { startedAt:0, position:null, pending:[], recent:[], seen:[], counters:{received:0,duplicates:0,gaps:0,opens:0,closes:0,adds:0,partials:0,reversals:0,apiRecovered:0,writeFailures:0}, lastFillAt:0,lastD1WriteAt:0, lastError:null };
  private pendingPositions: any[] = [];
  private book = {bid:0, ask:0, at:0};
  private bookMessages = 0;
  private bookStale = 0;
  private positionSeq = 0;
  private sessionStart = 0;
  private ledgerError: string | null = null;
  private sync = { status: "UNINITIALIZED", trader_side: "UNKNOWN", trader_btc_qty: null as number | null,
    signed_qty: null as number | null, last_checked_at: 0, last_error: null as string | null,
    next_attempt_at: 0, checks: 0, mismatches: 0, reversals_observed: 0,
    shadow_entry_allowed: false, waiting_reason: "AWAITING_POSITION_SNAPSHOT" };
  private syncInProgress = false;
  private syncDiagnostics = { snapshot_races: 0, snapshot_mismatch_deferred: 0,
    incomplete_positions: 0, incomplete_reasons: {} as Record<string,number>,
    additions_observed_without_copy: 0, snapshot_sign_changes: 0 };
  private syncMismatchCandidate: {signed:number;count:number} | null = null;
  // Separate observed fill continuity from API snapshots. Never interpret a
  // snapshot direction change alone as a tradable entry.
  private observed = { signed_qty: null as number | null, last_fill_time: 0,
    last_fill_id: "", fills: 0, flat_opens: 0, fill_reversals: 0,
    snapshot_sign_changes: 0, unverified_direction_changes: 0,
    missed_boundaries: 0, out_of_order: 0, duplicate_or_old: 0,
    last_transition: "NONE", last_transition_at: 0 };
  private lastSnapshotSigned: number | null = null;

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
      this.pendingLedger = (await ctx.storage.get("pendingLedger")) ?? [];
      this.pendingPositions = (await ctx.storage.get("pendingPositions")) ?? [];
      this.positionSeq = (await ctx.storage.get("positionSeq")) ?? 0;
      this.v15 = (await ctx.storage.get("v15Reconstruction")) ?? this.v15;
      // V1.5.0 had a broken signed-quantity comparison, invalidating every fill.
      // Start a clean V1.5.1 observation cohort; do not delete any D1 data.
      if (this.v15.schemaVersion !== "1.5.1") {
        this.v15 = { startedAt:Date.now(), schemaVersion:"1.5.1", position:null, pending:[], recent:[], seen:[], counters:{received:0,duplicates:0,gaps:0,opens:0,closes:0,adds:0,partials:0,reversals:0,apiRecovered:0,writeFailures:0,waitingExisting:0}, lastFillAt:0,lastD1WriteAt:0,lastError:null };
      }
      if (!this.v15.startedAt) this.v15.startedAt=Date.now();
      this.sessionStart = (await ctx.storage.get("sessionStart")) ?? 0;
      this.sync = (await ctx.storage.get("positionSync")) ?? this.sync;
      this.observed = (await ctx.storage.get("observedFills")) ?? this.observed;
      this.lastSnapshotSigned = (await ctx.storage.get("lastSnapshotSigned")) ?? this.lastSnapshotSigned;
      this.syncDiagnostics = (await ctx.storage.get("syncDiagnostics")) ?? this.syncDiagnostics;
      this.syncMismatchCandidate = (await ctx.storage.get("syncMismatchCandidate")) ?? null;
      // An in-flight restart must be reconciled before any new shadow entry.
      this.sync.status = "RECHECK_REQUIRED";
      this.sync.shadow_entry_allowed = false;
      // V1.3 partial position cannot be reconstructed reliably. Start a new cohort at flat.
      if (this.shadow.position && !this.shadow.position.positionId) {
        this.shadow.position = null;
        this.shadow.skipped["V13_UNRECONSTRUCTED_POSITION_RESET"] = (this.shadow.skipped["V13_UNRECONSTRUCTED_POSITION_RESET"] || 0) + 1;
      }

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
      shadow: this.shadow,
      pendingLedger: this.pendingLedger,
      pendingPositions: this.pendingPositions,
      positionSeq: this.positionSeq,
      sessionStart: this.sessionStart,
      positionSync: this.sync,
      observedFills: this.observed,
      lastSnapshotSigned: this.lastSnapshotSigned,
      syncDiagnostics: this.syncDiagnostics,
      syncMismatchCandidate: this.syncMismatchCandidate,
      v15Reconstruction:this.v15
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

    if (message?.channel === "l2Book") {
      const b = message.data?.levels;
      const bid = Number(b?.[0]?.[0]?.px);
      const ask = Number(b?.[1]?.[0]?.px);
      if (bid > 0 && ask >= bid && Number.isFinite(bid) && Number.isFinite(ask)) {
        this.book = {bid,ask,at:Date.now()};
        this.bookMessages++;
      }
      return;
    }
    if (message?.channel !== "userFills") return;

    const data = message.data;

    const fills = Array.isArray(data?.fills)
      ? data.fills
      : Array.isArray(data)
        ? data
        : [];

    // userFills batches may be delivered newest-first. Process position
    // transitions in exchange-time order, not message array order.
    fills.sort((a:any,b:any) => Number(a?.time||0)-Number(b?.time||0) || Number(a?.tid||0)-Number(b?.tid||0));
    for (const fill of fills) {
      const source = this.take(fill, "WS");
      if (source === "WS_LIVE") {
        try { this.reconstructV15(fill, "WS_LIVE"); }
        catch (e) { this.v15.lastError=String(e); this.error(e); }
      }
    }

    await this.persist();
    await this.flushV15();
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

      ws.send(JSON.stringify({method:"subscribe",subscription:{type:"l2Book",coin:"BTC"}}));
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
      this.sync.status="RECHECK_REQUIRED";
      this.sync.shadow_entry_allowed=false;
      this.sync.next_attempt_at=0;

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

  // Price comes ONLY from the subscribed order-book stream. Never use target fill px.
  private quote(action: "BUY" | "SELL"): number | null {
    const age = Date.now() - this.book.at;
    if (!this.book.at || age > BOOK_MAX_AGE_MS) {
      this.bookStale++;
      this.shadowSkip("STALE_OR_MISSING_WS_BOOK");
      return null;
    }
    const px = action === "BUY" ? this.book.ask : this.book.bid;
    if (!(px > 0)) return null;
    this.shadow.quotes++;
    this.shadow.lastQuoteAt = this.book.at;
    return px;
  }

  private newPosition(side: "LONG" | "SHORT", px: number, traderQty: number, now: number, eventId: string) {
    const qty = SHADOW_NOTIONAL_USD / px;
    this.positionSeq++;
    this.shadow.position = {
      side, qty, entryPrice:px, openedAt:now,
      entryFees:qty*px*SHADOW_TAKER_FEE_RATE, traderQty,
      positionId:`v14:${this.sessionStart}:${this.positionSeq}:${eventId}`,
      realizedGross:0, realizedFees:0, closedQty:0,
      initialNotional:SHADOW_NOTIONAL_USD, closeEvents:0
    };
  }

  private closePart(pos: ShadowPosition, fraction: number, px: number, now: number, eventId: string) {
    fraction = Math.max(0,Math.min(1,fraction));
    if (fraction <= 0) return;
    const qty = pos.qty * fraction;
    const entryFee = pos.entryFees * fraction;
    const exitFee = qty*px*SHADOW_TAKER_FEE_RATE;
    const gross = (px-pos.entryPrice)*qty*(pos.side === "LONG" ? 1 : -1);
    const fees = entryFee+exitFee;
    const trade:ShadowTrade = {
      eventId, side:pos.side, openedAt:pos.openedAt, closedAt:now,
      entryPrice:pos.entryPrice,exitPrice:px,qty,grossUsd:gross,
      feesUsd:fees,netUsd:gross-fees,holdSeconds:(now-pos.openedAt)/1000,
      reason:fraction>=1-1e-8 ? "FULL_CLOSE" : "PARTIAL_CLOSE"
    };
    this.shadow.trades.push(trade);
    this.pendingLedger.push(trade);
    if(this.shadow.trades.length>SHADOW_MAX_TRADES) this.shadow.trades.splice(0,this.shadow.trades.length-SHADOW_MAX_TRADES);
    pos.realizedGross=(pos.realizedGross||0)+gross;
    pos.realizedFees=(pos.realizedFees||0)+fees;
    pos.closedQty=(pos.closedQty||0)+qty;
    pos.closeEvents=(pos.closeEvents||0)+1;
    pos.entryFees-=entryFee;
    pos.qty-=qty;
    if (fraction>=1-1e-8 || pos.qty<POSITION_EPS) {
      this.pendingPositions.push({
        position_id:pos.positionId,side:pos.side,opened_at:pos.openedAt,
        closed_at:now,entry_price:pos.entryPrice,exit_price:px,
        gross_usd:pos.realizedGross,fees_usd:pos.realizedFees,
        net_usd:(pos.realizedGross||0)-(pos.realizedFees||0),
        hold_seconds:(now-pos.openedAt)/1000,close_events:pos.closeEvents,
        initial_notional_usd:pos.initialNotional||SHADOW_NOTIONAL_USD
      });
      this.shadow.position=null;
    }
  }

  // Read-only exchange snapshot. It is a baseline / consistency check, NOT a historical entry.
  private invalidateIncomplete(reason: string) {
    if (!this.shadow.position) return;
    // Never write an incomplete trade to the realized P/L ledger.
    this.shadow.position = null;
    this.syncDiagnostics.incomplete_positions++;
    this.syncDiagnostics.incomplete_reasons[reason] =
      (this.syncDiagnostics.incomplete_reasons[reason] || 0) + 1;
    this.shadowSkip(reason);
  }

  private async syncPosition(force = false) {
    const now = Date.now();
    if (this.syncInProgress || (!force && now < this.sync.next_attempt_at)) return;
    this.syncInProgress = true;
    const startedFillCount = this.observed.fills;
    const startedAt = Date.now();
    try {
      const response = await fetch(INFO_URL, {
        method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({type:"clearinghouseState",user:TARGET})
      });
      if (!response.ok) throw new Error(`POSITION_SYNC_HTTP_${response.status}`);
      const data:any = await response.json();
      if (!Array.isArray(data?.assetPositions)) throw new Error("POSITION_SYNC_INVALID_RESPONSE");
      const row = data.assetPositions.find((v:any)=>String(v?.position?.coin).toUpperCase()==="BTC");
      const signed = row ? Number(row.position.szi) : 0;
      if (!Number.isFinite(signed)) throw new Error("POSITION_SYNC_INVALID_SIZE");
      this.sync.checks++;
      this.sync.last_checked_at = Date.now();
      this.sync.last_error = null;
      this.sync.next_attempt_at = Date.now()+SYNC_INTERVAL_MS;
      if (this.lastSnapshotSigned !== null &&
          this.lastSnapshotSigned * signed < -(POSITION_EPS*POSITION_EPS)) {
        this.syncDiagnostics.snapshot_sign_changes++;
        this.observed.snapshot_sign_changes++;
      }
      this.lastSnapshotSigned = signed;
      // HTTP snapshots have no exchange sequence number. If WS fills arrived
      // during the HTTP request, the snapshot is NOT a safe ordering barrier.
      if (this.observed.fills !== startedFillCount) {
        this.syncDiagnostics.snapshot_races++;
        this.sync.next_attempt_at = Date.now()+10_000;
      } else {
        this.sync.signed_qty = signed;
        this.sync.trader_btc_qty = Math.abs(signed);
        this.sync.trader_side = signed > POSITION_EPS ? "LONG" : signed < -POSITION_EPS ? "SHORT" : "FLAT";
        const pos = this.shadow.position;
        if (pos) {
          const expected = pos.side === "LONG" ? pos.traderQty : -pos.traderQty;
          if (Math.abs(expected-signed)>Math.max(SYNC_TOLERANCE,Math.abs(signed)*0.0001)) {
            // A single non-sequenced snapshot cannot prove missing fills.
            // Defer the decision and request another snapshot, without
            // manufacturing a close or deleting a valid virtual position.
            this.sync.mismatches++;
            this.syncDiagnostics.snapshot_mismatch_deferred++;
            this.syncMismatchCandidate = {signed,count:(this.syncMismatchCandidate?.count||0)+1};
            this.sync.status="SNAPSHOT_MISMATCH_PENDING";
            this.sync.waiting_reason="RECHECKING_SNAPSHOT_NOT_BOOKING_PNL";
            this.sync.shadow_entry_allowed=false;
            this.sync.next_attempt_at=Date.now()+10_000;
            if (this.syncMismatchCandidate.count >= 2) {
              this.invalidateIncomplete("CONFIRMED_POSITION_DESYNC");
              this.sync.status="TRACKING_EXISTING";
              this.sync.waiting_reason="DESYNC_WAIT_FOR_NEW_ENTRY";
              this.syncMismatchCandidate=null;
            }
          } else {
            this.syncMismatchCandidate=null;
            this.sync.status="SHADOW_TRACKING";
            this.sync.waiting_reason="NONE";
            this.sync.shadow_entry_allowed=true;
          }
        } else {
          this.syncMismatchCandidate=null;
          this.sync.status = Math.abs(signed)<=POSITION_EPS ? "FLAT_CONFIRMED" : "TRACKING_EXISTING";
          this.sync.waiting_reason = Math.abs(signed)<=POSITION_EPS ? "AWAITING_NEXT_OPEN" : "EXISTING_POSITION";
          this.sync.shadow_entry_allowed = Math.abs(signed)<=POSITION_EPS;
        }
      }
      await this.persist();
    } catch (e) {
      this.sync.last_error=String(e);
      this.sync.status="SYNC_UNAVAILABLE";
      this.sync.shadow_entry_allowed=false;
      this.sync.waiting_reason="SYNC_RETRY_PENDING";
      this.sync.next_attempt_at=Date.now()+SYNC_INTERVAL_MS;
      this.error(e);
    } finally {this.syncInProgress=false;}
  }

  private async shadowFill(fill:any) {
    const qty = Number(fill?.sz);
    if (!(qty > 0) || !Number.isFinite(qty)) { this.shadowSkip("INVALID_SIZE"); return; }
    const action = fill?.side === "B" ? "BUY" : fill?.side === "A" ? "SELL" : null;
    if (!action) { this.shadowSkip("UNSUPPORTED_SIDE"); return; }
    const rawStart = fill?.startPosition;
    const start = rawStart == null || rawStart === "" ? NaN : Number(rawStart);
    if (!Number.isFinite(start)) { this.shadowSkip("NO_START_POSITION"); return; }
    const delta = action === "BUY" ? qty : -qty;
    const end = Math.abs(start + delta) < POSITION_EPS ? 0 : start + delta;
    const fillTime = Number(fill?.time);
    const eventId = this.fillId(fill);
    const now = Date.now();
    if (fillTime < this.observed.last_fill_time ||
        (fillTime === this.observed.last_fill_time && eventId === this.observed.last_fill_id)) {
      this.observed.out_of_order++;
      this.shadowSkip("OUT_OF_ORDER_FILL_NO_SHADOW_EXECUTION");
      return;
    }
    const prev = this.observed.signed_qty;
    if (prev !== null && Math.abs(prev-start) > Math.max(SYNC_TOLERANCE,Math.abs(start)*0.0001)) {
      this.observed.missed_boundaries++;
      this.observed.last_transition = "FILL_CONTINUITY_GAP";
      this.observed.last_transition_at = now;
      // A missing fill makes a running shadow position untrustworthy.
      if (this.shadow.position) {
        this.invalidateIncomplete("POSITION_INVALIDATED_BY_FILL_GAP");
      }
      this.sync.status = "RECHECK_REQUIRED";
      this.sync.shadow_entry_allowed = false;
      this.sync.next_attempt_at = 0;
    }
    this.observed.signed_qty = end;
    this.observed.last_fill_time = fillTime;
    this.observed.last_fill_id = eventId;
    this.observed.fills++;
    const reversal = start*end < -(POSITION_EPS*POSITION_EPS);
    const flatOpen = Math.abs(start) <= POSITION_EPS && Math.abs(end) > POSITION_EPS;
    const becameFlat = Math.abs(start) > POSITION_EPS && Math.abs(end) <= POSITION_EPS;
    if (reversal) {
      this.observed.fill_reversals++;
      this.observed.last_transition = "VERIFIED_FILL_REVERSAL";
      this.observed.last_transition_at = now;
      this.sync.reversals_observed++;
    } else if (flatOpen) {
      this.observed.flat_opens++;
      this.observed.last_transition = "VERIFIED_FLAT_TO_OPEN";
      this.observed.last_transition_at = now;
    } else if (becameFlat) {
      this.observed.last_transition = "VERIFIED_CLOSE_TO_FLAT";
      this.observed.last_transition_at = now;
    }
    // Snapshot is a safety baseline. A verified exchange fill is authoritative
    // for its own start/end transition, even when a 60-second snapshot was taken
    // before/after a batch and says TRACKING_EXISTING.
    if (this.sync.status === "UNINITIALIZED" || this.sync.status === "SYNC_UNAVAILABLE") {
      this.shadowSkip("AWAITING_POSITION_SYNC"); return;
    }
    const pos = this.shadow.position;
    if (!pos) {
      this.sync.signed_qty = end;
      this.sync.trader_btc_qty = Math.abs(end);
      this.sync.trader_side = end > POSITION_EPS ? "LONG" : end < -POSITION_EPS ? "SHORT" : "FLAT";
      if (!reversal && !flatOpen) {
        this.sync.status = Math.abs(end) <= POSITION_EPS ? "FLAT_CONFIRMED" : "TRACKING_EXISTING";
        this.sync.waiting_reason = Math.abs(end) <= POSITION_EPS ? "AWAITING_NEXT_OPEN" : "EXISTING_POSITION";
        this.sync.shadow_entry_allowed = Math.abs(end) <= POSITION_EPS;
        this.shadowSkip("OBSERVED_EXISTING_POSITION");
        return;
      }
      const px = this.quote(end > 0 ? "BUY" : "SELL");
      if (px === null) {
        this.sync.status = "RECHECK_REQUIRED";
        this.sync.shadow_entry_allowed = false;
        this.sync.next_attempt_at = 0;
        this.shadowSkip("VERIFIED_ENTRY_WITHOUT_FRESH_QUOTE");
        return;
      }
      this.newPosition(end > 0 ? "LONG" : "SHORT", px, Math.abs(end), now, eventId);
      this.sync.status = "SHADOW_TRACKING";
      this.sync.shadow_entry_allowed = true;
      this.sync.waiting_reason = "NONE";
      return;
    }
    const expected = pos.side === "LONG" ? pos.traderQty : -pos.traderQty;
    if (Math.abs(expected-start) > Math.max(SYNC_TOLERANCE,Math.abs(start)*0.0001)) {
      this.shadowSkip("POSITION_DESYNC_WAIT_FOR_FLAT");
      this.invalidateIncomplete("POSITION_DESYNC_WAIT_FOR_FLAT");
      this.sync.status = "RECHECK_REQUIRED";
      this.sync.shadow_entry_allowed = false;
      this.sync.next_attempt_at = 0;
      return;
    }
    // Fixed initial $100 copy: additions by the target change the target
    // exposure denominator, but do not create an unpriced simulated order.
    // This avoids destroying a valid position when an add fill lacks a quote.
    if (start*delta > 0) {
      pos.traderQty = Math.abs(end);
      this.syncDiagnostics.additions_observed_without_copy++;
      this.sync.signed_qty=end;
      this.sync.trader_btc_qty=Math.abs(end);
      this.sync.trader_side=end>0?"LONG":"SHORT";
      this.sync.status="SHADOW_TRACKING";
      this.sync.waiting_reason="NONE";
      return;
    }
    const px = this.quote(action);
    if (px === null) {
      // The missing execution price cannot be recovered from a later quote.
      // Mark this cohort incomplete, but never book a fictitious close.
      this.invalidateIncomplete("UNPRICED_CLOSE_INCOMPLETE");
      this.sync.status = "RECHECK_REQUIRED";
      this.sync.shadow_entry_allowed = false;
      this.sync.next_attempt_at = 0;
      return;
    }
    {
      const closedTrader = Math.min(Math.abs(start),qty);
      const fraction = closedTrader/Math.max(pos.traderQty,POSITION_EPS);
      this.closePart(pos,fraction,px,now,eventId);
      if (this.shadow.position) this.shadow.position.traderQty = Math.abs(end);
      if (reversal) {
        // The closing side and the opening side have DIFFERENT executable
        // bid/ask prices. Never reuse the close quote for the new entry.
        const entryPx = this.quote(end > 0 ? "BUY" : "SELL");
        if (entryPx !== null) this.newPosition(end > 0 ? "LONG" : "SHORT",entryPx,Math.abs(end),now,eventId);
        else this.shadowSkip("REVERSAL_ENTRY_MISSING_QUOTE");
      }
    }
    this.sync.signed_qty = end;
    this.sync.trader_btc_qty = Math.abs(end);
    this.sync.trader_side = end > POSITION_EPS ? "LONG" : end < -POSITION_EPS ? "SHORT" : "FLAT";
    this.sync.status = this.shadow.position ? "SHADOW_TRACKING" : Math.abs(end) <= POSITION_EPS ? "FLAT_CONFIRMED" : "TRACKING_EXISTING";
    this.sync.shadow_entry_allowed = !!this.shadow.position || Math.abs(end) <= POSITION_EPS;
    this.sync.waiting_reason = this.shadow.position ? "NONE" : Math.abs(end) <= POSITION_EPS ? "AWAITING_NEXT_OPEN" : "EXISTING_POSITION";
  }

  // V1.5: Reconstruct the TARGET'S actual position from exchange fills.
  // No invented trades, no order placement, no quote-dependent reconstruction.
  // Copy P/L uses target fill prices as a REFERENCE ONLY, not executable copy prices.
  private reconstructV15(fill:any, source:"WS_LIVE"|"API_RECOVERY") {
    const v=this.v15;
    const id=this.fillId(fill);
    if(v.seen.includes(id)){v.counters.duplicates++;return;}
    const t=Number(fill?.time),sz=Number(fill?.sz),px=Number(fill?.px);
    const start=Number(fill?.startPosition);
    const delta=fill?.side==="B"?sz:fill?.side==="A"?-sz:NaN;
    if(!Number.isFinite(t)||!Number.isFinite(start)||!(sz>0)||!(px>0)||!Number.isFinite(delta))return;
    // Never backdate a new cohort to a position already in progress at deployment.
    if(t<v.startedAt)return;
    if(v.lastFillAt && t<v.lastFillAt){
      // Late API/WS delivery cannot be inserted into an already processed position
      // without replaying the complete ordered fill ledger. Do not create a false gap.
      v.counters.lateOutOfOrder=(v.counters.lateOutOfOrder||0)+1;return;
    }
    v.seen.push(id);
    if(v.seen.length>15000)v.seen.splice(0,v.seen.length-15000);
    v.counters.received++;
    if(source==="API_RECOVERY")v.counters.apiRecovered++;
    v.lastFillAt=t;
    const end=Math.abs(start+delta)<POSITION_EPS?0:start+delta;
    const sign=(n:number)=>n>POSITION_EPS?1:n< -POSITION_EPS?-1:0;
    const pos=v.position;
    if(pos && Math.abs(pos.targetSigned-start)>Math.max(SYNC_TOLERANCE,Math.abs(start)*0.0001)){
      v.counters.gaps++;
      v.recent.push({type:"GAP",at:t,expected:pos.targetSigned,actual:start,fill_id:id});
      v.position=null; // Never finalize an unverified position.
    }
    let current=v.position;
    if(!current){
      if(sign(start)!==0){v.counters.waitingExisting=(v.counters.waitingExisting||0)+1;return;} // Existing position; not a continuity gap.
      if(sign(end)===0)return;
      this.v15Open(end,px,t,id);
      return;
    }
    const oldSign=sign(start),newSign=sign(end);
    if(oldSign===newSign && sign(delta)===oldSign){
      // Trader adds to existing position: maintain actual weighted entry and $100 scaled copy.
      const newAbs=Math.abs(end),oldAbs=Math.abs(start);
      current.entryPrice=(current.entryPrice*oldAbs+px*sz)/newAbs;
      current.copyQty+=sz*current.copyScale;
      current.copyEntryCost+=sz*current.copyScale*px;
      current.copyEntryFees+=sz*current.copyScale*px*SHADOW_TAKER_FEE_RATE;
      current.targetSigned=end;current.targetQty=newAbs;current.adds++;
      v.counters.adds++;
      return;
    }
    const closeQty=Math.min(Math.abs(start),sz);
    const fraction=closeQty/Math.abs(start);
    const copyClosed=current.copyQty*fraction;
    const copyBasis=current.copyEntryCost*fraction;
    const copyEntryFee=current.copyEntryFees*fraction;
    const gross=(px*copyClosed-copyBasis)*oldSign;
    const exitFee=px*copyClosed*SHADOW_TAKER_FEE_RATE;
    current.realizedGross+=gross;
    current.realizedFees+=copyEntryFee+exitFee;
    current.copyQty-=copyClosed;
    current.copyEntryCost-=copyBasis;
    current.copyEntryFees-=copyEntryFee;
    current.closeFills++;
    current.targetSigned=end;
    current.targetQty=Math.abs(end);
    if(newSign===oldSign){v.counters.partials++;return;}
    // Verified target FLAT or REVERSAL; one completed target position.
    const result={position_id:current.positionId,wallet:TARGET,side:current.side,
      opened_at:current.openedAt,closed_at:t,entry_price:current.entryPrice,exit_price:px,
      gross_usd:current.realizedGross,fees_usd:current.realizedFees,
      net_usd:current.realizedGross-current.realizedFees,
      hold_seconds:(t-current.openedAt)/1000,close_events:current.closeFills,
      initial_notional_usd:SHADOW_NOTIONAL_USD,source:"TARGET_FILLS_REFERENCE",
      open_fill_id:current.openFillId,close_fill_id:id,add_fills:current.adds};
    v.pending.push(result);
    v.recent.push({type:"COMPLETE",...result});
    if(v.recent.length>50)v.recent.splice(0,v.recent.length-50);
    v.counters.closes++;
    v.position=null;
    if(newSign!==0){
      v.counters.reversals++;
      // The excess quantity after closing the old position opens the opposite side.
      this.v15Open(end,px,t,id);
    }
  }

  private v15Open(signed:number,px:number,t:number,id:string){
    const v=this.v15;
    const scale=SHADOW_NOTIONAL_USD/(Math.abs(signed)*px);
    const copyQty=Math.abs(signed)*scale;
    v.position={positionId:`v15:${t}:${id}`,side:signed>0?"LONG":"SHORT",
      openedAt:t,openFillId:id,entryPrice:px,targetSigned:signed,targetQty:Math.abs(signed),
      copyScale:scale,copyQty,copyEntryCost:copyQty*px,
      copyEntryFees:copyQty*px*SHADOW_TAKER_FEE_RATE,
      realizedGross:0,realizedFees:0,closeFills:0,adds:0};
    v.counters.opens++;
  }

  private async flushV15(){
    if(!this.v15.pending.length)return;
    const db=this.env?.DB;
    if(!db){this.v15.lastError="DB_BINDING_MISSING";return;}
    try{
      for(const row of this.v15.pending.slice(0,30)){
        await db.prepare(`INSERT OR IGNORE INTO trader_copy_positions_v15
          (position_id,wallet,side,opened_at,closed_at,entry_price,exit_price,
           gross_usd,fees_usd,net_usd,hold_seconds,close_events,initial_notional_usd,
           price_basis,open_fill_id,close_fill_id,add_fills)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          row.position_id,row.wallet,row.side,row.opened_at,row.closed_at,row.entry_price,
          row.exit_price,row.gross_usd,row.fees_usd,row.net_usd,row.hold_seconds,
          row.close_events,row.initial_notional_usd,row.source,row.open_fill_id,row.close_fill_id,row.add_fills).run();
        this.v15.pending.shift();this.v15.lastD1WriteAt=Date.now();
      }
      this.v15.lastError=null;
      await this.persist();
    }catch(e){this.v15.counters.writeFailures++;this.v15.lastError=String(e);this.error(`V15_D1_WRITE: ${String(e)}`);await this.persist();}
  }

  private async positionsV15(url:URL):Promise<Response>{
    const db=this.env?.DB;
    if(!db)return json({ok:false,error:"DB_BINDING_MISSING"},503);
    const page=Math.max(1,Math.min(100000,Number(url.searchParams.get("page")||1)||1));
    const limit=Math.max(1,Math.min(100,Number(url.searchParams.get("limit")||50)||50));
    const side=url.searchParams.get("side")||"ALL",result=url.searchParams.get("result")||"ALL",date=url.searchParams.get("date")||"";
    if(!["ALL","LONG","SHORT"].includes(side)||!["ALL","WIN","LOSS"].includes(result)||(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)))return json({ok:false,error:"INVALID_FILTER"},400);
    const where=["wallet = ?"],args:any[]=[TARGET];
    if(side!=="ALL"){where.push("side = ?");args.push(side);}
    if(result==="WIN")where.push("net_usd > 0");
    if(result==="LOSS")where.push("net_usd <= 0");
    if(date){const start=Date.parse(date+"T00:00:00Z");where.push("closed_at >= ? AND closed_at < ?");args.push(start,start+86400000);}
    const w=where.join(" AND ");
    try{
      const summary=await db.prepare(`SELECT COUNT(*) AS trades, SUM(CASE WHEN net_usd>0 THEN 1 ELSE 0 END) AS wins,
        COALESCE(SUM(net_usd),0) AS net_usd,COALESCE(SUM(gross_usd),0) AS gross_usd,
        COALESCE(SUM(fees_usd),0) AS fees_usd,COALESCE(SUM(initial_notional_usd),0) AS notional_usd,
        COALESCE(AVG(hold_seconds),0) AS avg_hold_seconds FROM trader_copy_positions_v15 WHERE ${w}`).bind(...args).first();
      const rows=await db.prepare(`SELECT * FROM trader_copy_positions_v15 WHERE ${w} ORDER BY closed_at DESC,position_id DESC LIMIT ? OFFSET ?`).bind(...args,limit,(page-1)*limit).all();
      const total=Number(summary?.trades||0),notional=Number(summary?.notional_usd||0);
      return json({ok:true,version:VERSION,record_type:"TARGET_RECONSTRUCTED_V15",total,pages:Math.ceil(total/limit),rows:rows.results||[],
        summary:{...summary,win_rate_pct:total?100*Number(summary?.wins||0)/total:null,roi_pct:notional?100*Number(summary?.net_usd||0)/notional:null},
        pending_writes:this.v15.pending.length,ledger_error:this.v15.lastError,
        warning:"REFERENCE ONLY: prices are target fills, NOT executable copy quotes; simulated fees; not real copy P/L."});
    }catch(e){return json({ok:false,error:"V15_POSITIONS_QUERY_FAILED",detail:String(e)},503);}
  }

  // D1 ledger is append-only and idempotent. A partial close is one close EVENT,
  // not an independently completed position. Pending writes survive DO restarts.
  private async flushLedger() {
    if (!this.pendingLedger.length && !this.pendingPositions.length) return;
    const db = this.env?.DB;
    if (!db) { this.ledgerError = "DB_BINDING_MISSING"; return; }
    try {
      // Small batches avoid D1 limits and prevent blocking the WebSocket too long.
      for (const trade of this.pendingLedger.slice(0, 30)) {
        if (!trade.eventId) continue;
        await db.prepare(`INSERT OR IGNORE INTO trader_shadow_close_events
          (event_id, wallet, coin, side, opened_at, closed_at, entry_price,
           exit_price, qty, gross_usd, fees_usd, net_usd, hold_seconds,
           close_reason, simulated_notional_usd, fee_rate)
          VALUES (?, ?, 'BTC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(trade.eventId, TARGET, trade.side, trade.openedAt,
            trade.closedAt, trade.entryPrice, trade.exitPrice, trade.qty,
            trade.grossUsd, trade.feesUsd, trade.netUsd, trade.holdSeconds,
            trade.reason, SHADOW_NOTIONAL_USD, SHADOW_TAKER_FEE_RATE).run();
        this.pendingLedger.shift();
      }
      for(const pos of this.pendingPositions.slice(0,30)) {
        await db.prepare(`INSERT OR IGNORE INTO trader_shadow_positions_v14
          (position_id,wallet,side,opened_at,closed_at,entry_price,exit_price,
           gross_usd,fees_usd,net_usd,hold_seconds,close_events,initial_notional_usd)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
            pos.position_id,TARGET,pos.side,pos.opened_at,pos.closed_at,
            pos.entry_price,pos.exit_price,pos.gross_usd,pos.fees_usd,
            pos.net_usd,pos.hold_seconds,pos.close_events,pos.initial_notional_usd
          ).run();
        this.pendingPositions.shift();
      }
      this.ledgerError = null;
      await this.persist();
    } catch (e) {
      this.ledgerError = String(e);
      this.error(`D1_LEDGER_WRITE: ${String(e)}`);
      await this.persist();
    }
  }

  private async ledger(url: URL): Promise<Response> {
    const db = this.env?.DB;
    if (!db) return json({ok:false,error:"DB_BINDING_MISSING"},503);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50) || 50));
    const page = Math.max(1, Math.min(100000, Number(url.searchParams.get("page") || 1) || 1));
    const side = url.searchParams.get("side") || "ALL";
    const result = url.searchParams.get("result") || "ALL";
    const date = url.searchParams.get("date") || "";
    if (!["ALL","LONG","SHORT"].includes(side) || !["ALL","WIN","LOSS"].includes(result) ||
        (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))) return json({ok:false,error:"INVALID_FILTER"},400);
    const where = ["wallet = ?"]; const params: any[] = [TARGET];
    if (side !== "ALL") { where.push("side = ?"); params.push(side); }
    if (result === "WIN") where.push("net_usd > 0");
    if (result === "LOSS") where.push("net_usd <= 0");
    if (date) { where.push("closed_at >= ? AND closed_at < ?");
      const start = Date.parse(date + "T00:00:00Z");
      if (!Number.isFinite(start)) return json({ok:false,error:"INVALID_DATE"},400);
      params.push(start, start + 86400000);
    }
    const filter = where.join(" AND ");
    try {
      const summary = await db.prepare(`SELECT COUNT(*) AS events,
        SUM(CASE WHEN net_usd > 0 THEN 1 ELSE 0 END) AS wins,
        COALESCE(SUM(net_usd),0) AS net_usd,
        COALESCE(SUM(gross_usd),0) AS gross_usd,
        COALESCE(SUM(fees_usd),0) AS fees_usd,
        COALESCE(AVG(hold_seconds),0) AS avg_hold_seconds
        FROM trader_shadow_close_events WHERE ${filter}`).bind(...params).first();
      const rows = await db.prepare(`SELECT event_id, side, opened_at, closed_at,
        entry_price, exit_price, qty, gross_usd, fees_usd, net_usd,
        hold_seconds, close_reason FROM trader_shadow_close_events
        WHERE ${filter} ORDER BY closed_at DESC, event_id DESC LIMIT ? OFFSET ?`)
        .bind(...params, limit, (page-1)*limit).all();
      const count = Number(summary?.events ?? 0);
      return json({ok:true,version:VERSION,source:"D1",record_type:"CLOSE_EVENTS_NOT_FULL_TRADES",
        filters:{date,side,result,page,limit},summary:{...summary,
          win_rate_pct:count ? 100*Number(summary?.wins ?? 0)/count : null,
          roi_pct_on_100_usd_per_event:null},
        total:count,pages:Math.ceil(count/limit),rows:rows.results ?? [],
        pending_writes:this.pendingLedger.length,ledger_error:this.ledgerError,
        warnings:["Partial closes are counted as separate events, not completed positions.",
          "No historical V1.2 events are backfilled automatically.",
          "ROI is intentionally omitted until position-level accounting is implemented."]});
    } catch (e) {return json({ok:false,error:"LEDGER_QUERY_FAILED",detail:String(e),
      hint:"Run the provided SQL migration in cryptobot-db first."},503);}
  }

  private async positionsLedger(url:URL):Promise<Response> {
    const db=this.env?.DB;
    if(!db)return json({ok:false,error:"DB_BINDING_MISSING"},503);
    const page=Math.max(1,Math.min(100000,Number(url.searchParams.get("page")||1)||1));
    const limit=Math.max(1,Math.min(100,Number(url.searchParams.get("limit")||50)||50));
    const side=url.searchParams.get("side")||"ALL";
    const result=url.searchParams.get("result")||"ALL";
    const date=url.searchParams.get("date")||"";
    if(!["ALL","LONG","SHORT"].includes(side)||!["ALL","WIN","LOSS"].includes(result)||
      (date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)))return json({ok:false,error:"INVALID_FILTER"},400);
    const where=["wallet = ?"],args:any[]=[TARGET];
    if(side!=="ALL"){where.push("side = ?");args.push(side);}
    if(result==="WIN")where.push("net_usd > 0");
    if(result==="LOSS")where.push("net_usd <= 0");
    if(date){const start=Date.parse(date+"T00:00:00Z");if(!Number.isFinite(start))return json({ok:false,error:"INVALID_DATE"},400);
      where.push("closed_at >= ? AND closed_at < ?");args.push(start,start+86400000);}
    const w=where.join(" AND ");
    try {
      const summary=await db.prepare(`SELECT COUNT(*) AS trades,
        SUM(CASE WHEN net_usd>0 THEN 1 ELSE 0 END) AS wins,
        COALESCE(SUM(net_usd),0) AS net_usd,
        COALESCE(SUM(gross_usd),0) AS gross_usd,
        COALESCE(SUM(fees_usd),0) AS fees_usd,
        COALESCE(SUM(initial_notional_usd),0) AS notional_usd,
        COALESCE(AVG(hold_seconds),0) AS avg_hold_seconds
        FROM trader_shadow_positions_v14 WHERE ${w}`).bind(...args).first();
      const rows=await db.prepare(`SELECT * FROM trader_shadow_positions_v14 WHERE ${w}
        ORDER BY closed_at DESC,position_id DESC LIMIT ? OFFSET ?`).bind(...args,limit,(page-1)*limit).all();
      const total=Number(summary?.trades||0),notional=Number(summary?.notional_usd||0);
      return json({ok:true,version:VERSION,record_type:"COMPLETED_POSITIONS_V14",total,
        pages:Math.ceil(total/limit),rows:rows.results||[],
        summary:{...summary,win_rate_pct:total?100*Number(summary?.wins||0)/total:null,
          roi_pct:notional?100*Number(summary?.net_usd||0)/notional:null},
        pending_writes:this.pendingPositions.length,ledger_error:this.ledgerError,
        warning:"ROI = sum realized net / sum initial notional, not account equity ROI."});
    }catch(e){return json({ok:false,error:"POSITIONS_QUERY_FAILED",detail:String(e)},503);}
  }

  private shadowStats() {
    const trades = this.shadow.trades;
    const net = trades.reduce((v, t) => v + t.netUsd, 0);
    const wins = trades.filter(t => t.netUsd > 0).length;
    return {
      mode: "READ_ONLY_SHADOW", version: VERSION,
      simulated_notional_usd_per_initial_entry: SHADOW_NOTIONAL_USD,
      assumed_taker_fee_rate_per_side: SHADOW_TAKER_FEE_RATE,
      price_source: "BTC l2Book WebSocket bid/ask; max quote age 5000ms",
      position_sync: {...this.sync},
      shadow_diagnostics: {...this.syncDiagnostics},
      book_ws: {messages:this.bookMessages, age_ms:this.book.at?Date.now()-this.book.at:null,
        bid:this.book.bid||null,ask:this.book.ask||null,stale_signals:this.bookStale},
      pending_completed_positions:this.pendingPositions.length,
      current_position: this.shadow.position,
      current_unrealized_net_usd: this.shadow.position && this.book.at && Date.now()-this.book.at<=BOOK_MAX_AGE_MS
        ? Number(( ( (this.shadow.position.side==="LONG"?this.book.bid-this.shadow.position.entryPrice:this.shadow.position.entryPrice-this.book.ask)*this.shadow.position.qty )
            - this.shadow.position.entryFees - this.shadow.position.qty*(this.shadow.position.side==="LONG"?this.book.bid:this.book.ask)*SHADOW_TAKER_FEE_RATE).toFixed(6)) : null,
      completed_close_events: trades.length,
      close_event_stats_include_legacy_v13: true,
      winning_close_events: wins,
      win_rate_pct: trades.length ? Number((100 * wins / trades.length).toFixed(2)) : null,
      realized_net_usd: Number(net.toFixed(6)),
      realized_gross_usd: Number(trades.reduce((v,t) => v+t.grossUsd,0).toFixed(6)),
      total_fees_usd: Number(trades.reduce((v,t) => v+t.feesUsd,0).toFixed(6)),
      quotes: this.shadow.quotes,
      ledger: {pending_writes:this.pendingLedger.length, last_error:this.ledgerError, endpoint:"/trader-watch/ledger"},
      skipped: this.shadow.skipped,
      last_quote_at: this.shadow.lastQuoteAt,
      recent_trades: trades.slice(-20),
      warnings: [
        "Indicative best bid/ask quotes; not verified executions, depth or market impact.",
        "Starts with no assumed trader position; unmatched closes are skipped.",
        "Unrealized P/L is indicative when a fresh bid/ask is available; funding is excluded.",
        "WebSocket quote age is capped at 5 seconds; unpriced closes mark a cohort incomplete, never realized.",
        "Copy policy V1.4.3: fixed $100 initial entry; target additions do not increase virtual exposure.",
        "Snapshot checks are non-sequenced; mismatches are deferred and never priced as closes.",
        "Multiple partial close events are not independent complete trades; completed positions are stored separately.",
         "Snapshot direction changes are diagnostic only. Only observed fill transitions create new shadow entries."
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

    btc.sort((a:any,b:any)=>Number(a?.time||0)-Number(b?.time||0)||Number(a?.tid||0)-Number(b?.tid||0));
    for (const fill of btc) {
      const classified=this.take(fill, "API");
      if(classified==="API_BACKFILL")this.reconstructV15(fill,"API_RECOVERY");
    }
    await this.flushV15();

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
      shadow_copy: {
        mode:"READ_ONLY_TARGET_FILL_RECONSTRUCTION",version:VERSION,
        price_source:"TARGET_EXECUTION_PRICE_REFERENCE_NOT_COPY_EXECUTION",
        position_sync:{...this.sync},
        current_position:this.v15.position,
        pending_completed_positions:this.v15.pending.length,
        reconstruction:{...this.v15.counters,started_at:this.v15.startedAt,last_fill_at:this.v15.lastFillAt,
          last_d1_write_at:this.v15.lastD1WriteAt,last_error:this.v15.lastError},
        recent_trades:this.v15.recent.slice(-20),
        warnings:["V1.5 only. Old V1.3/V1.4 results excluded.","Target fill prices are not achievable copy prices.","Position must be observed from flat or verified reversal.","Missing fill continuity invalidates a position rather than inventing a trade."]
      },

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

    if (this.sync.status === "RECHECK_REQUIRED" || this.sync.status === "UNINITIALIZED" ||
        Date.now() >= this.sync.next_attempt_at) {
      await this.syncPosition();
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
    await this.flushV15();

    await this.ctx.storage.setAlarm(
      Date.now() + ALARM_INTERVAL_MS
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/start") {
      this.state.active = true;
      this.sessionStart ||= Date.now();

      this.state.started_at ||= Date.now();

      this.connect();
      await this.syncPosition(true);

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

    if (path === "/positions") return this.positionsV15(url);

    if (path === "/ledger") {
      return this.ledger(url);
    }

    if (path === "/shadow") {
      return json({mode:"READ_ONLY_TARGET_FILL_RECONSTRUCTION",version:VERSION,
        current_position:this.v15.position,reconstruction:this.v15.counters,
        pending_writes:this.v15.pending.length,last_error:this.v15.lastError,
        recent_trades:this.v15.recent.slice(-20)});
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
