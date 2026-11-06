// BTC TRADER WATCH V4.2 — CLEAN FILL LEDGER + DETERMINISTIC REPLAY
// Cloudflare Durable Object: export class TraderWatch
// READ ONLY: this file never submits an exchange order.
// Only BTC fills from the configured public wallet are tracked.

const TARGET = '0xbb160cb61e694570f9d570f9fcde7c61dd2143ad';
const INFO_URL = 'https://api.hyperliquid.xyz/info';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const VERSION = 'BTC TRADER WATCH V4.6 VIRTUAL 10 USD X5';
const EPS = 0.00000001;
const START_NOTIONAL_USD = 100;
const AUDIT_INTERVAL_MS = 60000;
const SNAPSHOT_INTERVAL_MS = 30000;
const ALARM_INTERVAL_MS = 10000;
const MAX_API_WINDOW_MS = 4 * 60 * 1000;
const MAX_RECENT = 100;

type Action = 'OPEN' | 'ADD' | 'PARTIAL_CLOSE' | 'CLOSE' | 'REVERSAL';
type Source = 'WS_LIVE' | 'API_BACKFILL';
type RawFill = {
  coin: string;
  tid: number | string;
  hash?: string;
  time: number;
  side: 'A' | 'B';
  startPosition: number | string;
  sz: number | string;
  px: number | string;
};
type NormalFill = {
  id: string; at: number; receivedAt: number; source: Source;
  start: number; end: number; size: number; price: number;
  side: 'A' | 'B';
};
type Row = {
  id: string; at: number; receivedAt: number; source: Source;
  action: Action; start: number; end: number; size: number; price: number;
  targetSide: string; copyBefore: number; copyAfter: number;
  copied: boolean; reason: string;
};
type VirtualTrade = {id:string; at:number; action:Action; price:number; targetStart:number; targetEnd:number;
  beforeQty:number; afterQty:number; deltaQty:number; realizedUsd:number; feeUsd:number;
  equityUsd:number; cashUsd:number; usedMarginUsd:number; status:string};
type VirtualState = {startedAt:number; balanceUsd:number; initialBalanceUsd:number;
  qty:number; avgPrice:number; ratio:number; realizedUsd:number; feesUsd:number;
  closedTrades:number; wins:number; losses:number; positionRealizedUsd:number;
  positionFeesUsd:number; peakEquityUsd:number; maxDrawdownPct:number;
  lastMarkPrice:number; lastFillId:string|null; events:number; skipped:number;
  blockedAdds:number; rejectedOpens:number; recent:VirtualTrade[]};
const VIRTUAL_INITIAL_BALANCE = 50;
const VIRTUAL_MARGIN_PER_OPEN = 10;
const VIRTUAL_LEVERAGE = 5;
const VIRTUAL_OPEN_NOTIONAL = VIRTUAL_MARGIN_PER_OPEN * VIRTUAL_LEVERAGE;
// Assumed taker fee; this is a configurable simulation assumption, not a quoted live fee.
const VIRTUAL_TAKER_FEE_RATE = 0.00045;
const VIRTUAL_SLIPPAGE_BPS = 0; // 0 until live executable price evidence is available.
const VIRTUAL_MARGIN_BUFFER = 0.001;
function freshVirtual(): VirtualState { return {startedAt:Date.now(),balanceUsd:50,initialBalanceUsd:50,
 qty:0,avgPrice:0,ratio:0,realizedUsd:0,feesUsd:0,closedTrades:0,wins:0,losses:0,
 positionRealizedUsd:0,positionFeesUsd:0,peakEquityUsd:50,maxDrawdownPct:0,
 lastMarkPrice:0,lastFillId:null,events:0,skipped:0,blockedAdds:0,rejectedOpens:0,recent:[]}; }
type Stats = {
  fills: number; copyActions: number; opens: number; adds: number;
  partials: number; closes: number; reversals: number;
  duplicates: number; gaps: number; apiRecovered: number; writeFailures: number;
};
type WatchState = {
  schema: 41; epoch: number; active: boolean; connected: boolean;
  baselineAt: number; baselineSigned: number | null;
  targetSigned: number | null; copySigned: number; ratio: number;
  copyEnabled: boolean; needsAudit: boolean;
  snapshotSigned: number | null; snapshotMismatch: number | null;
  lastFillAt: number; lastAuditAt: number; lastSnapshotAt: number;
  nextApiAt: number; nextSnapshotAt: number;
  lastError: string | null; stats: Stats; recent: Row[];
  auditCursor: number; ledgerCount: number; replayGap: boolean;
  snapshotRequestAt?: number; snapshotResponseAt?: number;
  snapshotAlignedTarget?: number | null; snapshotSyncStatus?: string;
  snapshotConfirmedMismatch?: boolean;
  pipelineSamples?: any[];
  pendingSnapshots?: {requestAt:number;responseAt:number;signed:number}[];
  lastVerifiedSnapshot?: {requestAt:number;responseAt:number;verifiedAt:number;
    exchangeSigned:number;ledgerSigned:number;delta:number;status:string} | null;
  lastSnapshotCheck?: {requestAt:number;responseAt:number;checkedAt:number;
    exchangeSigned:number;ledgerSigned:number|null;delta:number|null;status:string} | null;
  snapshotChecks?: {matched:number;mismatched:number;raced:number;pendingExpired:number};
  virtualV46?: VirtualState;
};

function fresh(): WatchState {
  return {
    schema: 41, epoch: Date.now(), active: false, connected: false,
    baselineAt: 0, baselineSigned: null, targetSigned: null,
    copySigned: 0, ratio: 0, copyEnabled: false, needsAudit: false,
    snapshotSigned: null, snapshotMismatch: null,
    lastFillAt: 0, lastAuditAt: 0, lastSnapshotAt: 0,
    nextApiAt: 0, nextSnapshotAt: 0, lastError: null,
    stats: { fills: 0, copyActions: 0, opens: 0, adds: 0,
      partials: 0, closes: 0, reversals: 0, duplicates: 0,
      gaps: 0, apiRecovered: 0, writeFailures: 0 },
    recent: [], auditCursor: 0, ledgerCount: 0, replayGap: false,
    snapshotRequestAt: 0, snapshotResponseAt: 0,
    snapshotAlignedTarget: null, snapshotSyncStatus: 'NOT_CHECKED',
    snapshotConfirmedMismatch: false,
    pendingSnapshots: [], lastVerifiedSnapshot: null, lastSnapshotCheck: null,
    snapshotChecks: {matched:0,mismatched:0,raced:0,pendingExpired:0},
  };
}
const same = (a: number, b: number) => Math.abs(a - b) <= EPS;
const direction = (n: number) => same(n, 0) ? 0 : n > 0 ? 1 : -1;
const sideName = (n: number) => n > EPS ? 'LONG' : n < -EPS ? 'SHORT' : 'FLAT';
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store' },
  });

function normalize(raw: RawFill, source: Source): NormalFill | null {
  if (raw?.coin !== 'BTC' || !['A', 'B'].includes(raw.side)) return null;
  const start = Number(raw.startPosition);
  const size = Number(raw.sz);
  const price = Number(raw.px);
  const at = Number(raw.time);
  if (![start, size, price, at].every(Number.isFinite) || size <= 0 || price <= 0 || at <= 0) return null;
  if (raw.tid === null || raw.tid === undefined) return null;
  const end = start + (raw.side === 'B' ? size : -size);
  return {
    id: 'BTC:' + String(raw.tid) + ':' + String(raw.hash || ''),
    at, receivedAt: Date.now(), source, start, end, size, price, side: raw.side,
  };
}
function actionOf(f: NormalFill): Action {
  const a = direction(f.start), b = direction(f.end);
  if (a === 0 && b !== 0) return 'OPEN';
  if (a !== 0 && b === 0) return 'CLOSE';
  if (a !== b) return 'REVERSAL';
  return Math.abs(f.end) > Math.abs(f.start) ? 'ADD' : 'PARTIAL_CLOSE';
}

export class TraderWatch {
  private s: WatchState = fresh();
  private ws: WebSocket | null = null;
  private processing: Promise<void> = Promise.resolve();
  private auditBusy = false;
  private databaseReady = false;
  private resetBusy = false;
  private readonly pipelineCap = 1200;
  private virtualReady = false;
  private incrementalActions = 0;
  private recoveryReplays = 0;
  private recoveryReason: string | null = null;
  private appendReady = false;
  private queuedJobs = 0;
  private readonly diagnosticSince = Date.now();
  private recoveryRowsWritten = 0;
  private lastRecoveryMs: number | null = null;
  private recoveryPending = false;
  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queuedJobs++;
    const next = this.processing.catch(() => {}).then(job);
    this.processing = next.catch(e => {
      this.s.lastError = 'INGEST_QUEUE: ' + String(e);
      this.s.needsAudit = true;
    }).finally(() => { this.queuedJobs--; });
    return next;
  }

  // Validate persisted projection once after a DO restart; do not rebuild history.
  private async verifyProjection(): Promise<void> {
    if (this.appendReady) return;
    await this.ensureDb();
    const counts: any = await this.env.DB.prepare(`SELECT
      (SELECT count(*) FROM trader_watch_v4_fills WHERE wallet=? AND epoch=?) AS fills,
      (SELECT count(*) FROM trader_watch_v4_actions WHERE wallet=? AND epoch=?) AS actions`)
      .bind(TARGET, this.s.epoch, TARGET, this.s.epoch).first();
    const fills = Number(counts?.fills || 0);
    const actions = Number(counts?.actions || 0);
    if (fills !== this.s.ledgerCount || actions !== fills || this.s.replayGap) {
      this.recoveryReason = `PERSISTED_PROJECTION_NOT_ALIGNED:fills=${fills},actions=${actions},checkpoint=${this.s.ledgerCount},gap=${this.s.replayGap}`;
      this.recoveryReplays++;
      await this.replay();
      if (this.s.replayGap) throw new Error('FILL_CHAIN_GAP_REQUIRES_AUDIT');
    }
    this.appendReady = true;
  }

  private async writeAction(row: Row): Promise<void> {
    await this.env.DB.prepare(`INSERT INTO trader_watch_v4_actions
      (wallet,epoch,fill_id,event_at,payload_json) VALUES (?,?,?,?,?)
      ON CONFLICT(wallet,epoch,fill_id) DO UPDATE SET payload_json=excluded.payload_json`)
      .bind(TARGET, this.s.epoch, row.id, row.at, JSON.stringify(row)).run();
  }

  private virtualEquity(v: VirtualState, mark:number): number {
    const unrealized = v.qty * (mark - v.avgPrice);
    return v.balanceUsd + unrealized;
  }
  private virtualUsedMargin(v: VirtualState, mark:number): number {
    return Math.abs(v.qty) * mark / VIRTUAL_LEVERAGE;
  }
  private virtualMark(v:VirtualState, px:number):void {
    if (!(px > 0)) return;
    v.lastMarkPrice=px;
    const eq=this.virtualEquity(v,px);
    v.peakEquityUsd=Math.max(v.peakEquityUsd,eq);
    if(v.peakEquityUsd>0) v.maxDrawdownPct=Math.max(v.maxDrawdownPct,100*(v.peakEquityUsd-eq)/v.peakEquityUsd);
  }
  private async ensureVirtual():Promise<void> {
    if(this.virtualReady) return;
    await this.ensureDb();
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_v46_virtual (
      wallet TEXT NOT NULL, epoch INTEGER NOT NULL, fill_id TEXT NOT NULL,
      event_at INTEGER NOT NULL, payload_json TEXT NOT NULL, state_json TEXT NOT NULL,
      PRIMARY KEY(wallet,epoch,fill_id))`).run();
    await this.env.DB.prepare(`CREATE INDEX IF NOT EXISTS trader_watch_v46_virtual_order
      ON trader_watch_v46_virtual(wallet,epoch,event_at)`).run();
    const last:any=await this.env.DB.prepare(`SELECT state_json FROM trader_watch_v46_virtual
      WHERE wallet=? AND epoch=? ORDER BY rowid DESC LIMIT 1`).bind(TARGET,this.s.epoch).first();
    if(last?.state_json) this.s.virtualV46=JSON.parse(last.state_json);
    else if(!this.s.virtualV46) this.s.virtualV46=freshVirtual();
    this.virtualReady=true;
  }
  private async virtualApply(f:NormalFill, action:Action):Promise<void> {
    await this.ensureVirtual();
    const v=this.s.virtualV46!;
    // The simulation starts with the NEXT new opening boundary, not with an
    // already-open position. API backfills older than activation cannot be executed.
    if(f.at < v.startedAt || f.source !== 'WS_LIVE') { v.skipped++; return; }
    if(v.lastFillId===f.id) return;
    const existing:any=await this.env.DB.prepare(`SELECT state_json FROM trader_watch_v46_virtual
      WHERE wallet=? AND epoch=? AND fill_id=?`).bind(TARGET,this.s.epoch,f.id).first();
    if(existing?.state_json) { this.s.virtualV46=JSON.parse(existing.state_json); return; }
    const before=v.qty;
    const executionPx=f.price*(1+(f.side==='B'?1:-1)*VIRTUAL_SLIPPAGE_BPS/10000);
    let status='APPLIED', delta=0, realized=0, fee=0;
    const close=(amount:number)=>{
      const q=Math.min(Math.abs(v.qty),amount);
      if(q<=EPS)return;
      const old=v.qty;
      const sign=Math.sign(old);
      const change=-sign*q;
      const profit=q*sign*(executionPx-v.avgPrice);
      const cost=q*executionPx*VIRTUAL_TAKER_FEE_RATE;
      v.balanceUsd+=profit-cost; v.realizedUsd+=profit;v.feesUsd+=cost;
      v.positionRealizedUsd+=profit;v.positionFeesUsd+=cost;
      realized+=profit;fee+=cost;delta+=change;
      v.qty+=change;
      if(Math.abs(v.qty)<EPS){
        const net=v.positionRealizedUsd-v.positionFeesUsd;
        v.closedTrades++;if(net>0)v.wins++;else if(net<0)v.losses++;
        v.qty=0;v.avgPrice=0;v.ratio=0;
        v.positionRealizedUsd=0;v.positionFeesUsd=0;
      }
    };
    const open=(signedQty:number, ratio:number)=>{
      const needed=Math.abs(signedQty)*executionPx/VIRTUAL_LEVERAGE;
      const openingFee=Math.abs(signedQty)*executionPx*VIRTUAL_TAKER_FEE_RATE;
      const free=v.balanceUsd+v.qty*(executionPx-v.avgPrice)-this.virtualUsedMargin(v,executionPx);
      if(needed+openingFee+VIRTUAL_MARGIN_BUFFER>free){
        if(Math.abs(v.qty)<EPS)v.rejectedOpens++;else v.blockedAdds++;
        status='INSUFFICIENT_VIRTUAL_MARGIN';return;
      }
      const oldAbs=Math.abs(v.qty),newAbs=Math.abs(signedQty);
      v.avgPrice=(oldAbs*v.avgPrice+newAbs*executionPx)/(oldAbs+newAbs);
      v.qty+=signedQty;delta+=signedQty;
      v.balanceUsd-=openingFee;v.feesUsd+=openingFee;v.positionFeesUsd+=openingFee;fee+=openingFee;
      v.ratio=ratio;
    };
    if(action==='OPEN'||action==='REVERSAL') {
      if(Math.abs(v.qty)>EPS)close(Math.abs(v.qty));
      if(Math.abs(v.qty)<EPS){
        const r=VIRTUAL_OPEN_NOTIONAL/(Math.abs(f.end)*executionPx);
        open(f.end*r,r);
      }
    } else if(Math.abs(v.qty)<EPS || Math.sign(v.qty)!==Math.sign(f.start)) {
      status='WAITING_FOR_FRESH_OPEN';
    } else if(action==='CLOSE')close(Math.abs(v.qty));
    else if(action==='PARTIAL_CLOSE') {
      const pct=Math.min(1,Math.abs(f.start-f.end)/Math.abs(f.start));
      close(Math.abs(v.qty)*pct);
    } else if(action==='ADD') {
      const pct=Math.abs(f.end-f.start)/Math.abs(f.start);
      open(v.qty*pct,v.ratio);
    }
    this.virtualMark(v,executionPx);
    v.lastFillId=f.id;v.events++;
    const ev:VirtualTrade={id:f.id,at:f.at,action,price:executionPx,targetStart:f.start,targetEnd:f.end,
      beforeQty:before,afterQty:v.qty,deltaQty:delta,realizedUsd:realized,feeUsd:fee,
      equityUsd:this.virtualEquity(v,executionPx),cashUsd:v.balanceUsd,
      usedMarginUsd:this.virtualUsedMargin(v,executionPx),status};
    v.recent.push(ev);v.recent=v.recent.slice(-100);
    await this.env.DB.prepare(`INSERT INTO trader_watch_v46_virtual
      (wallet,epoch,fill_id,event_at,payload_json,state_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(wallet,epoch,fill_id) DO NOTHING`)
      .bind(TARGET,this.s.epoch,f.id,f.at,JSON.stringify(ev),JSON.stringify(v)).run();
  }
  private async virtualReport():Promise<any> {
    await this.ensureVirtual();
    const v=this.s.virtualV46!;
    const mark=v.lastMarkPrice || v.avgPrice;
    const unrealized=v.qty*(mark-v.avgPrice);
    const equity=v.balanceUsd+unrealized;
    const margin=this.virtualUsedMargin(v,mark);
    return {ok:true,version:VERSION,mode:'VIRTUAL_ONLY_NO_REAL_ORDERS',
      assumptions:{initial_balance_usd:50,margin_per_fresh_open_usd:10,leverage:5,
        fresh_open_notional_usd:50,taker_fee_rate:VIRTUAL_TAKER_FEE_RATE,
        slippage_bps:VIRTUAL_SLIPPAGE_BPS,pricing:'TRADER_FILL_PRICE_PROXY_NOT_EXECUTABLE_COPY_PRICE',
        copy_rule:'PERCENTAGE_OF_BTC_QTY',
        history:'NEW_WS_FILLS_AFTER_V4_6_ACTIVATION_ONLY; NO_RETROACTIVE_TRADES',
        margin_rule:'REJECT_OPEN_OR_ADD_IF_INSUFFICIENT_FREE_EQUITY; NO_LIQUIDATION_ENGINE'},
      started_at:v.startedAt,latest_mark_price:mark,position_btc:v.qty,
      average_entry_price:v.avgPrice,used_margin_usd:margin,
      free_equity_usd:equity-margin,realized_gross_usd:v.realizedUsd,
      unrealized_usd:unrealized,fees_usd:v.feesUsd,net_realized_usd:v.realizedUsd-v.feesUsd,
      equity_usd:equity,roi_pct:100*(equity-v.initialBalanceUsd)/v.initialBalanceUsd,
      closed_trades:v.closedTrades,wins:v.wins,losses:v.losses,
      win_rate_pct:v.closedTrades?100*v.wins/v.closedTrades:null,
      max_drawdown_pct:v.maxDrawdownPct,events:v.events,skipped_historical_or_backfill:v.skipped,
      blocked_adds:v.blockedAdds,rejected_opens:v.rejectedOpens,
      recent_events:v.recent.slice(-50),trading_enabled:false};
  }

  // Apply one verified fill, keeping exactly the V4.4 ratio and reversal rules.
  private async appendFill(f: NormalFill): Promise<void> {
    const start = Number(this.s.targetSigned);
    if (!same(f.start, start)) throw new Error('APPEND_POSITION_DISCONTINUITY');
    const action = actionOf(f);
    const before = this.s.copySigned;
    let copy = before, ratio = this.s.ratio;
    let enabled = this.s.copyEnabled;
    let copied = false, reason = '';
    if (!enabled) {
      if (action === 'REVERSAL' && direction(f.end) !== 0) {
        ratio = START_NOTIONAL_USD / (Math.abs(f.end) * f.price);
        copy = f.end * ratio;
        enabled = true;
        copied = true;
        reason = 'FRESH_REVERSAL_BOUNDARY';
      } else if (direction(f.end) === 0) {
        copy = 0; ratio = 0; enabled = true;
        reason = 'PREEXISTING_POSITION_REACHED_FLAT';
      } else reason = 'PREEXISTING_POSITION_NOT_COPIED';
    } else {
      if (action === 'OPEN' || action === 'REVERSAL') {
        ratio = START_NOTIONAL_USD / (Math.abs(f.end) * f.price);
        copy = f.end * ratio;
      } else if (action === 'CLOSE') { copy = 0; ratio = 0; }
      else copy = f.end * ratio;
      copied = true; reason = 'CHAIN_VERIFIED';
    }
    const row: Row = {id:f.id,at:f.at,receivedAt:f.receivedAt,source:f.source,
      action,start:f.start,end:f.end,size:f.size,price:f.price,
      targetSide:sideName(f.end),copyBefore:before,copyAfter:copy,copied,reason};
    // Persist the action BEFORE advancing the checkpoint. Retry is idempotent.
    await this.writeAction(row);
    await this.virtualApply(f,action);
    this.s.targetSigned = f.end;
    this.s.copySigned = copy;
    this.s.ratio = ratio;
    this.s.copyEnabled = enabled;
    this.s.ledgerCount++;
    this.s.lastFillAt = f.at;
    this.s.stats.fills++;
    if (f.source === 'API_BACKFILL') this.s.stats.apiRecovered++;
    if (copied) {
      this.s.stats.copyActions++;
      const key = {OPEN:'opens',ADD:'adds',PARTIAL_CLOSE:'partials',
        CLOSE:'closes',REVERSAL:'reversals'}[action] as keyof Stats;
      this.s.stats[key]++;
    }
    this.s.recent.push(row);
    this.s.recent = this.s.recent.slice(-MAX_RECENT);
    this.incrementalActions++;
  }

  constructor(private ctx: any, private env: any) {
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('traderWatchV41');
      if (saved && saved.schema === 41) this.s = saved;
      this.s.connected = false;
      if (this.s.active) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('traderWatchV41', this.s);
  }

  private async ensureDb(): Promise<void> {
    if (this.databaseReady) return;
    if (!this.env.DB) throw new Error('DB_BINDING_MISSING');
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_v4_fills (
      wallet TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      fill_id TEXT NOT NULL,
      event_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      start_qty REAL NOT NULL,
      end_qty REAL NOT NULL,
      fill_qty REAL NOT NULL,
      price REAL NOT NULL,
      side TEXT NOT NULL,
      PRIMARY KEY (wallet, epoch, fill_id)
    )`).run();
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_v4_actions (
      wallet TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      fill_id TEXT NOT NULL,
      event_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (wallet, epoch, fill_id)
    )`).run();
    await this.env.DB.prepare(`CREATE INDEX IF NOT EXISTS trader_watch_v4_fills_order
      ON trader_watch_v4_fills(wallet, epoch, event_at)`).run();
    this.databaseReady = true;
  }

  private async info(body: unknown): Promise<any> {
    const r = await fetch(INFO_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('HYPERLIQUID_INFO_HTTP_' + r.status);
    return r.json();
  }

  // Retain snapshots across newer polls. A 30-second poll must not overwrite
  // the snapshot waiting for the 60-second API audit.
  // Only a completed API audit through responseAt can verify a snapshot.
  private async evaluateSnapshotAlignment(): Promise<void> {
    const pending = this.s.pendingSnapshots || [];
    if (!pending.length || this.s.baselineSigned === null) return;
    if (this.s.replayGap) {
      this.s.snapshotSyncStatus = 'FILL_CHAIN_GAP';
      this.s.needsAudit = true;
      return;
    }
    const ready = pending.filter(x => x.responseAt <= this.s.auditCursor);
    if (!ready.length) {
      this.s.snapshotSyncStatus = 'AWAITING_API_AUDIT';
      return;
    }
    const fills = await this.ledger();
    const {ordered,gap} = this.chain(fills);
    if (gap) {
      this.s.snapshotSyncStatus = 'FILL_CHAIN_GAP';
      this.s.needsAudit = true;
      return;
    }
    const counters = this.s.snapshotChecks || {matched:0,mismatched:0,raced:0,pendingExpired:0};
    for (const shot of ready) {
      let status = 'MATCHED_AT_SNAPSHOT_TIME';
      let aligned: number | null = Number(this.s.baselineSigned);
      let delta: number | null = null;
      // The exchange has no sequence number for the clearinghouse snapshot.
      // Reject snapshots whose request overlaps any fill, rather than guessing.
      if (ordered.some(f => f.at >= shot.requestAt && f.at <= shot.responseAt)) {
        status = 'SNAPSHOT_RACE_WITH_FILLS';
        aligned = null;
        counters.raced++;
      } else {
        for (const f of ordered) {
          if (f.at > shot.requestAt) break;
          aligned = f.end;
        }
        delta = shot.signed - Number(aligned);
        if (same(delta,0)) counters.matched++;
        else {status='CONFIRMED_MISMATCH_AFTER_AUDIT';counters.mismatched++;this.s.needsAudit=true;}
      }
      const check = {requestAt:shot.requestAt,responseAt:shot.responseAt,
        checkedAt:Date.now(),exchangeSigned:shot.signed,ledgerSigned:aligned,delta,status};
      this.s.lastSnapshotCheck = check;
      if (status === 'MATCHED_AT_SNAPSHOT_TIME') this.s.lastVerifiedSnapshot = {
        requestAt:shot.requestAt,responseAt:shot.responseAt,verifiedAt:check.checkedAt,
        exchangeSigned:shot.signed,ledgerSigned:Number(aligned),delta:0,status};
      // Current snapshot fields describe only the latest snapshot, not an old one.
      if (shot.responseAt === this.s.snapshotResponseAt) {
        this.s.snapshotSyncStatus = status;
        this.s.snapshotAlignedTarget = aligned;
        this.s.snapshotMismatch = status === 'CONFIRMED_MISMATCH_AFTER_AUDIT' ? delta : null;
        this.s.snapshotConfirmedMismatch = status === 'CONFIRMED_MISMATCH_AFTER_AUDIT';
      }
    }
    this.s.snapshotChecks = counters;
    this.s.pendingSnapshots = pending.filter(x => x.responseAt > this.s.auditCursor);
    if (this.s.pendingSnapshots.length) this.s.snapshotSyncStatus = 'AWAITING_API_AUDIT';
  }

  private async snapshot(force = false): Promise<void> {
    if (!force && Date.now() < this.s.nextSnapshotAt) return;
    this.s.nextSnapshotAt = Date.now() + SNAPSHOT_INTERVAL_MS;
    try {
      const started = Date.now();
      const data = await this.info({ type: 'clearinghouseState', user: TARGET });
      const completed = Date.now();
      const pos = data.assetPositions?.find((p: any) => p.position?.coin === 'BTC')?.position;
      const signed = pos ? Number(pos.szi) : 0;
      if (!Number.isFinite(signed)) throw new Error('INVALID_SNAPSHOT');
      this.s.snapshotSigned = signed;
      this.s.lastSnapshotAt = completed;
      this.s.snapshotRequestAt = started;
      this.s.snapshotResponseAt = completed;
      if (this.s.baselineSigned === null) {
        this.s.baselineSigned = signed;
        this.s.targetSigned = signed;
        this.s.baselineAt = completed;
        this.s.auditCursor = completed;
        this.s.copyEnabled = direction(signed) === 0;
        this.s.snapshotAlignedTarget = signed;
        this.s.snapshotSyncStatus = 'BASELINE_ESTABLISHED';
        this.s.snapshotMismatch = null;
      } else {
        this.s.snapshotSyncStatus = 'AWAITING_API_AUDIT';
        this.s.snapshotAlignedTarget = null;
        this.s.snapshotMismatch = null;
        this.s.snapshotConfirmedMismatch = false;
        const pending = this.s.pendingSnapshots || [];
        pending.push({requestAt:started,responseAt:completed,signed});
        // Bound persisted state without discarding the most recent samples.
        if (pending.length > 24) {
          const dropped = pending.length - 24;
          pending.splice(0,dropped);
          const c = this.s.snapshotChecks || {matched:0,mismatched:0,raced:0,pendingExpired:0};
          c.pendingExpired += dropped;
          this.s.snapshotChecks = c;
        }
        this.s.pendingSnapshots = pending;
        // Do not run a full-ledger comparison on every 30-second snapshot.
        // The completed API audit will verify all snapshots it covers.
      }
    } catch (e) {
      this.s.lastError = 'SNAPSHOT: ' + String(e);
      this.s.snapshotSyncStatus = 'SNAPSHOT_ERROR';
      if (String(e).includes('429')) this.s.nextSnapshotAt = Date.now() + 120000;
    }
    await this.save();
  }

  private async insertFill(f: NormalFill): Promise<boolean> {
    if (!this.s.baselineAt || f.at < this.s.baselineAt) return false;
    await this.ensureDb();
    const result = await this.env.DB.prepare(`INSERT OR IGNORE INTO trader_watch_v4_fills
      (wallet,epoch,fill_id,event_at,received_at,source,start_qty,end_qty,fill_qty,price,side)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      TARGET, this.s.epoch, f.id, f.at, f.receivedAt, f.source,
      f.start, f.end, f.size, f.price, f.side,
    ).run();
    const changed = Number(result?.meta?.changes || 0) > 0;
    if (!changed) this.s.stats.duplicates++;
    return changed;
  }

  private async ledger(): Promise<NormalFill[]> {
    await this.ensureDb();
    // D1 results may be paginated. Walk the complete epoch, not only last 5 minutes.
    const result: NormalFill[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.env.DB.prepare(`SELECT fill_id,event_at,received_at,source,
        start_qty,end_qty,fill_qty,price,side FROM trader_watch_v4_fills
        WHERE wallet=? AND epoch=? ORDER BY event_at ASC, fill_id ASC LIMIT 500 OFFSET ?`)
        .bind(TARGET, this.s.epoch, offset).all();
      const rows: any[] = page.results || [];
      for (const r of rows) result.push({
        id: r.fill_id, at: Number(r.event_at), receivedAt: Number(r.received_at),
        source: r.source, start: Number(r.start_qty), end: Number(r.end_qty),
        size: Number(r.fill_qty), price: Number(r.price), side: r.side,
      });
      if (rows.length < 500) break;
      offset += rows.length;
      if (offset > 100000) throw new Error('LEDGER_TOO_LARGE_FOR_INLINE_REPLAY');
    }
    return result;
  }

  private chain(fills: NormalFill[]): { ordered: NormalFill[]; gap: boolean } {
    const remaining = fills.slice().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const ordered: NormalFill[] = [];
    let expected = Number(this.s.baselineSigned);
    let gap = false;
    while (remaining.length) {
      // Prefer a fill that starts exactly where the preceding fill ended.
      // This resolves same-millisecond executions without relying on fill ID order.
      let index = remaining.findIndex(f => same(f.start, expected));
      if (index < 0) {
        gap = true;
        break;
      }
      const f = remaining.splice(index, 1)[0];
      ordered.push(f);
      expected = f.end;
    }
    return { ordered, gap: gap || remaining.length > 0 };
  }

  private async replay(): Promise<void> {
    if (this.s.baselineSigned === null) return;
    const fills = await this.ledger();
    const { ordered, gap } = this.chain(fills);
    let target = Number(this.s.baselineSigned);
    let copy = 0;
    let ratio = 0;
    let enabled = direction(target) === 0;
    const stats: Stats = { fills: fills.length, copyActions: 0, opens: 0,
      adds: 0, partials: 0, closes: 0, reversals: 0,
      duplicates: this.s.stats.duplicates, gaps: gap ? 1 : 0,
      apiRecovered: fills.filter(f => f.source === 'API_BACKFILL').length,
      writeFailures: this.s.stats.writeFailures };
    const actions: Row[] = [];
    for (const f of ordered) {
      const action = actionOf(f);
      const before = copy;
      let copied = false;
      let reason = '';
      if (!enabled) {
        if (action === 'REVERSAL' && direction(f.end) !== 0) {
          // New opposite-side exposure can be copied from this known boundary.
          ratio = START_NOTIONAL_USD / (Math.abs(f.end) * f.price);
          copy = f.end * ratio;
          enabled = true;
          copied = true;
          reason = 'FRESH_REVERSAL_BOUNDARY';
        } else if (direction(f.end) === 0) {
          copy = 0;
          ratio = 0;
          enabled = true;
          reason = 'PREEXISTING_POSITION_REACHED_FLAT';
        } else {
          reason = 'PREEXISTING_POSITION_NOT_COPIED';
        }
      } else {
        if (action === 'OPEN' || action === 'REVERSAL') {
          ratio = START_NOTIONAL_USD / (Math.abs(f.end) * f.price);
          copy = f.end * ratio;
        } else if (action === 'CLOSE') {
          copy = 0;
          ratio = 0;
        } else {
          copy = f.end * ratio;
        }
        copied = true;
        reason = 'CHAIN_VERIFIED';
      }
      target = f.end;
      if (copied) {
        stats.copyActions++;
        const key = { OPEN: 'opens', ADD: 'adds', PARTIAL_CLOSE: 'partials',
          CLOSE: 'closes', REVERSAL: 'reversals' }[action] as keyof Stats;
        stats[key]++;
      }
      actions.push({ id: f.id, at: f.at, receivedAt: f.receivedAt,
        source: f.source, action, start: f.start, end: f.end,
        size: f.size, price: f.price, targetSide: sideName(f.end),
        copyBefore: before, copyAfter: copy, copied, reason });
    }
    // Incomplete chain: keep only proven actions; NEVER claim live synchronization.
    this.s.replayGap = gap;
    this.s.needsAudit = gap || this.s.needsAudit;
    this.s.targetSigned = target;
    this.s.copySigned = copy;
    this.s.ratio = ratio;
    this.s.copyEnabled = enabled && !gap;
    this.s.ledgerCount = fills.length;
    this.s.lastFillAt = ordered.length ? ordered[ordered.length - 1].at : 0;
    this.s.stats = stats;
    this.s.recent = actions.slice(-MAX_RECENT);
    // Rebuild action projection from the canonical fill ledger.
    // These are virtual actions, not orders.
    await this.ensureDb();
    // D1 batch executes ordered prepared statements with far fewer round trips.
    // Never delete existing actions; retries remain idempotent.
    const recoveryStart = Date.now();
    for (let i = 0; i < actions.length; i += 80) {
      const statements = actions.slice(i, i + 80).map(row =>
        this.env.DB.prepare(`INSERT INTO trader_watch_v4_actions
          (wallet,epoch,fill_id,event_at,payload_json) VALUES (?,?,?,?,?)
          ON CONFLICT(wallet,epoch,fill_id) DO UPDATE SET
          event_at=excluded.event_at,payload_json=excluded.payload_json`)
          .bind(TARGET, this.s.epoch, row.id, row.at, JSON.stringify(row)));
      await this.env.DB.batch(statements);
      this.recoveryRowsWritten += statements.length;
    }
    this.lastRecoveryMs = Date.now() - recoveryStart;
    await this.save();
  }

  private async ingestMany(raw: RawFill[], source: Source, receivedAt?: number): Promise<void> {
    if (!this.s.baselineAt) return;
    const processingStartedAt = Date.now();
    const freshRows: { f: NormalFill; d1DoneAt: number }[] = [];
    // Check the persisted checkpoint BEFORE inserting new rows.
    await this.verifyProjection();
    for (const x of raw) {
      const f = normalize(x, source);
      if (!f) continue;
      if (await this.insertFill(f)) freshRows.push({ f, d1DoneAt: Date.now() });
    }
    const replayStartedAt = Date.now();
    let fallback = false;
    if (freshRows.length) {
      // Append only when every newly inserted fill extends the verified prefix.
      // A late historical fill or missing predecessor triggers canonical recovery.
      const pending = freshRows.slice().sort((a,b) => a.f.at-b.f.at || a.f.id.localeCompare(b.f.id));
      let expected = Number(this.s.targetSigned);
      let lastAt = this.s.lastFillAt;
      const ordered: typeof pending = [];
      while (pending.length) {
        const i = pending.findIndex(x => x.f.at >= lastAt && same(x.f.start, expected));
        if (i < 0) { fallback = true; break; }
        const item = pending.splice(i,1)[0];
        ordered.push(item);
        expected = item.f.end;
        lastAt = item.f.at;
      }
      if (fallback) {
        this.recoveryReason = 'LATE_OR_OUT_OF_ORDER_FILL';
        this.recoveryReplays++;
        this.appendReady = false;
        await this.replay();
        if (!this.s.replayGap) this.appendReady = true;
      } else {
        try {
          for (const x of ordered) await this.appendFill(x.f);
          await this.save();
        } catch (e) {
          fallback = true;
          this.recoveryReason = 'APPEND_WRITE_FAILURE: ' + String(e);
          this.recoveryReplays++;
          this.appendReady = false;
          await this.replay();
          if (!this.s.replayGap) this.appendReady = true;
        }
      }
    } else await this.save();
    const copyReadyAt = Date.now();
    if (freshRows.length) {
      const samples = this.s.pipelineSamples || [];
      const receiveTime = receivedAt ?? processingStartedAt;
      for (const {f, d1DoneAt} of freshRows) samples.push({
        id:f.id,source,event_at:f.at,
        ws_callback_at:source==='WS_LIVE'?receiveTime:null,
        processing_started_at:processingStartedAt,
        d1_write_done_at:d1DoneAt,replay_started_at:replayStartedAt,
        copy_ready_at:copyReadyAt,
        exchange_to_callback_ms:source==='WS_LIVE'?receiveTime-f.at:null,
        callback_queue_ms:source==='WS_LIVE'?processingStartedAt-receiveTime:null,
        processing_to_d1_ms:d1DoneAt-processingStartedAt,
        d1_to_copy_ready_ms:copyReadyAt-d1DoneAt,
        replay_batch_ms:fallback?copyReadyAt-replayStartedAt:0,
        exchange_to_copy_ready_ms:copyReadyAt-f.at,
        batch_new_fills:freshRows.length,
        processing_mode:fallback?'RECOVERY_REPLAY':'INCREMENTAL',
      });
      this.s.pipelineSamples=samples.slice(-this.pipelineCap);
      await this.save();
    }
  }

  private async audit(force = false): Promise<void> {
    if (this.auditBusy || !this.s.baselineAt || (!force && Date.now() < this.s.nextApiAt)) return;
    this.auditBusy = true;
    this.s.nextApiAt = Date.now() + AUDIT_INTERVAL_MS;
    try {
      // Incremental API backfill with overlapping windows; never discard
      // an older fill just because newer WS fills were already processed.
      const end = Date.now();
      let cursor = Math.max(this.s.baselineAt, this.s.auditCursor - 30000);
      let pages = 0;
      while (cursor < end && pages < 15) {
        const upper = Math.min(end, cursor + MAX_API_WINDOW_MS);
        const raw = await this.info({ type: 'userFillsByTime', user: TARGET,
          startTime: cursor, endTime: upper, aggregateByTime: false });
        if (!Array.isArray(raw)) throw new Error('INVALID_API_FILLS');
        // Hyperliquid may cap results; do not silently mark a truncated window audited.
        if (raw.length >= 1900) throw new Error('API_WINDOW_POSSIBLY_TRUNCATED');
        await this.enqueue(() => this.ingestMany(raw, 'API_BACKFILL'));
        cursor = upper;
        this.s.auditCursor = cursor;
        pages++;
      }
      this.s.lastAuditAt = Date.now();
      if (cursor < end) this.s.needsAudit = true;
      else if (!this.s.replayGap) this.s.needsAudit = false;
      await this.evaluateSnapshotAlignment();
      if (!this.s.snapshotConfirmedMismatch && !this.s.replayGap) this.s.lastError = null;
    } catch (e) {
      this.s.needsAudit = true;
      this.s.lastError = 'AUDIT: ' + String(e);
      if (String(e).includes('429')) this.s.nextApiAt = Date.now() + 120000;
    } finally {
      this.auditBusy = false;
      await this.save();
    }
  }

  private connect(): void {
    if (!this.s.active || this.ws && [0, 1].includes(this.ws.readyState)) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (!this.s.active) { ws.close(); return; }
      this.s.connected = true;
      ws.send(JSON.stringify({ method: 'subscribe',
        subscription: { type: 'userFills', user: TARGET } }));
      this.save().catch(() => {});
      this.audit(true).catch(e => { this.s.lastError = String(e); });
    });
    ws.addEventListener('message', (ev: any) => {
      const callbackAt = Date.now();
      void this.enqueue(async () => {
        const msg = JSON.parse(String(ev.data));
        if (msg.channel !== 'userFills') return;
        const payload = msg.data;
        const arr = Array.isArray(payload?.fills) ? payload.fills :
          Array.isArray(payload) ? payload : [];
        // Subscription historical events are ignored only if predating baseline.
        await this.ingestMany(arr, 'WS_LIVE', callbackAt);
        if (this.s.replayGap) { this.s.needsAudit = true; this.s.nextApiAt = 0; }
      }).catch(() => {});
    });
    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.s.connected = false;
      this.s.needsAudit = true;
      this.s.nextApiAt = 0;
      this.save().catch(() => {});
    };
    ws.addEventListener('close', down);
    ws.addEventListener('error', down);
  }

  async alarm(): Promise<void> {
    if (!this.s.active || this.resetBusy) return;
    try {
      if (!this.ws || this.ws.readyState !== 1) this.connect();
      await this.snapshot();
      await this.audit();
    } catch (e) {
      this.s.lastError = 'ALARM: ' + String(e);
    } finally {
      await this.save();
      if (this.s.active) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  // V4.4: Bounded observational samples; no order submission or strategy changes.
  private pipelineAudit(): any {
    const retained: any[] = this.s.pipelineSamples || [];
    const samples = retained.filter(x => x.processing_mode === 'INCREMENTAL' || x.processing_mode === 'RECOVERY_REPLAY');
    const incremental = samples.filter(x => x.processing_mode === 'INCREMENTAL');
    const recovery = samples.filter(x => x.processing_mode === 'RECOVERY_REPLAY');
    const summarize = (rows: any[], key: string) => {
      const a = rows.map(r => r[key]).filter((v: any) => typeof v === 'number' && Number.isFinite(v)).sort((x: number,y: number) => x-y);
      const pct = (p: number) => a.length ? a[Math.min(a.length-1, Math.ceil(p*a.length)-1)] : null;
      return {count:a.length, p50_ms:pct(.5), p90_ms:pct(.9), p95_ms:pct(.95), max_ms:a.length?a[a.length-1]:null};
    };
    const metrics = (rows: any[]) => ({
      exchange_to_ws_callback: summarize(rows, 'exchange_to_callback_ms'),
      ws_callback_queue: summarize(rows, 'callback_queue_ms'),
      processing_to_d1: summarize(rows, 'processing_to_d1_ms'),
      d1_to_copy_ready: summarize(rows, 'd1_to_copy_ready_ms'),
      replay_batch: summarize(rows, 'replay_batch_ms'),
      exchange_to_copy_ready: summarize(rows, 'exchange_to_copy_ready_ms'),
    });
    return {ok:true, version:VERSION, mode:'READ_ONLY_OBSERVABILITY',
      epoch:this.s.epoch, samples:samples.length,
      retained_legacy_samples:retained.length-samples.length,
      diagnostic_started_at:this.diagnosticSince,
      incremental_samples:incremental.length,
      recovery_samples:recovery.length,
      incremental_only:metrics(incremental),
      recovery_only:metrics(recovery),
      recovery_d1_rows_written_since_restart:this.recoveryRowsWritten,
      last_recovery_d1_batch_ms:this.lastRecoveryMs,
      incremental_actions_since_restart:this.incrementalActions,
      recovery_replays_since_restart:this.recoveryReplays,
      last_recovery_reason:this.recoveryReason,
      queued_ingest_jobs:this.queuedJobs,
      ws_live:metrics(samples.filter(x=>x.source==='WS_LIVE')),
      api_backfill:metrics(samples.filter(x=>x.source==='API_BACKFILL')),
      overall:metrics(samples),
      slowest:samples.slice().sort((a,b)=>b.exchange_to_copy_ready_ms-a.exchange_to_copy_ready_ms).slice(0,12),
      caveats:[
        'WS callback is measured when this Durable Object receives a message event, not at the Hyperliquid server.',
        'D1 timing includes serial inserts and per-batch overhead; individual fill timing is not isolated.',
        'COPY ready means incremental projection persistence (or explicit recovery replay), not a real trade.',
        'Batch completion times are shared by all new fills in that batch.',
        'API backfill has no WS callback metric and is historical, not executable in real time.',
        'Main metrics exclude legacy V4.4 samples. Incremental and recovery modes are reported separately. Historical V4.5 samples remain included.',
      ]};
  }

  // V4.3: Observability only. The "latency" below measures detection/ingestion,
  // NOT real exchange order execution or a live fill of the virtual copy.
  private async executionAudit(limit = 5000): Promise<any> {
    await this.ensureDb();
    const rows: Row[] = [];
    let offset = 0;
    const cap = Math.max(100, Math.min(20000, limit));
    while (offset < cap) {
      const page: any = await this.env.DB.prepare(`SELECT payload_json FROM trader_watch_v4_actions
        WHERE wallet=? AND epoch=? ORDER BY event_at DESC,fill_id DESC LIMIT 500 OFFSET ?`)
        .bind(TARGET, this.s.epoch, offset).all();
      const batch: any[] = page.results || [];
      for (const x of batch) {
        try { rows.push(JSON.parse(x.payload_json)); } catch {}
      }
      offset += batch.length;
      if (batch.length < 500) break;
    }
    const latency = (a: Row[]) => a.map(r => r.receivedAt - r.at)
      .filter(x => Number.isFinite(x) && x >= 0).sort((a,b) => a-b);
    const percentile = (arr: number[], p: number) => arr.length
      ? arr[Math.min(arr.length-1, Math.ceil(arr.length*p)-1)] : null;
    const describe = (a: Row[]) => {
      const ms = latency(a);
      return { count: a.length, measured: ms.length,
        p50_ms: percentile(ms,0.5), p90_ms: percentile(ms,0.9),
        p95_ms: percentile(ms,0.95), p99_ms: percentile(ms,0.99),
        max_ms: ms.length ? ms[ms.length-1] : null,
        over_5s: ms.filter(x=>x>5000).length,
        over_10s: ms.filter(x=>x>10000).length,
        over_20s: ms.filter(x=>x>20000).length,
        over_30s: ms.filter(x=>x>30000).length };
    };
    const copied = rows.filter(r => r.copied);
    const skipped = rows.filter(r => !r.copied);
    const eps = 1e-7;
    const mismatches = copied.filter(r => {
      if (!Number.isFinite(r.copyAfter) || !Number.isFinite(r.copyBefore)) return true;
      if (r.action === 'CLOSE') return Math.abs(r.copyAfter) > eps;
      if (r.action === 'OPEN' || r.action === 'REVERSAL')
        return Math.abs(Math.abs(r.copyAfter)*r.price-START_NOTIONAL_USD) > 0.1;
      // For ADD/PARTIAL_CLOSE the ratio is inherited from the active position.
      // Compare consecutive before/after against the signed source fill delta.
      const delta = r.end-r.start;
      const copyDelta = r.copyAfter-r.copyBefore;
      return Math.abs(delta) < eps || Math.sign(delta) !== Math.sign(copyDelta);
    });
    const live = rows.filter(r => r.source === 'WS_LIVE');
    const backfill = rows.filter(r => r.source === 'API_BACKFILL');
    const mostDelayed = rows.slice().sort((a,b) =>
      (b.receivedAt-b.at)-(a.receivedAt-a.at)).slice(0,15)
      .map(r => ({ id:r.id, at:r.at, receivedAt:r.receivedAt,
        delay_ms:r.receivedAt-r.at, source:r.source, action:r.action, copied:r.copied }));
    return { ok:true, version:VERSION, mode:'READ_ONLY_VIRTUAL_COPY_AUDIT',
      epoch:this.s.epoch, evaluated_actions:rows.length,
      total_ledger_actions:this.s.ledgerCount,
      sample_truncated:rows.length < this.s.ledgerCount,
      time_basis:'receivedAt - exchange fill time (NOT actual trade execution)',
      overall:describe(rows), ws_live:describe(live), api_backfill:describe(backfill),
      copied_actions:copied.length, skipped_actions:skipped.length,
      copy_math_flags:mismatches.length,
      flagged_examples:mismatches.slice(0,10).map(r=>({id:r.id,action:r.action,
        start:r.start,end:r.end,copyBefore:r.copyBefore,copyAfter:r.copyAfter})),
      action_counts: {
        OPEN:copied.filter(r=>r.action==='OPEN').length,
        ADD:copied.filter(r=>r.action==='ADD').length,
        PARTIAL_CLOSE:copied.filter(r=>r.action==='PARTIAL_CLOSE').length,
        CLOSE:copied.filter(r=>r.action==='CLOSE').length,
        REVERSAL:copied.filter(r=>r.action==='REVERSAL').length,
      },
      most_delayed:mostDelayed,
      position_check:{ target_from_fills:this.s.targetSigned,
        exchange_snapshot:this.s.snapshotSigned, copy_position:this.s.copySigned,
        replay_gap:this.s.replayGap, snapshot_sync_status:this.s.snapshotSyncStatus,
        last_verified_snapshot:this.s.lastVerifiedSnapshot || null,
        last_snapshot_check:this.s.lastSnapshotCheck || null,
        snapshot_confirmed_mismatch:this.s.snapshotConfirmedMismatch },
      limitations:['Delayed API backfills are historical simulations, not timely executable copies.',
        'Snapshot and latest fill may refer to different moments.',
        'Audit flags check arithmetic direction and fresh $100 notional, not market execution.',
        'No real orders, fills, slippage or execution fees are measured.'] };
  }

  private status() {
    return {
      ok: true, version: VERSION, target: TARGET, trading_enabled: false,
      active: this.s.active, connected: this.s.connected, epoch: this.s.epoch,
      baseline_at: this.s.baselineAt, baseline_position_btc: this.s.baselineSigned,
      target_position_from_fills_btc: this.s.targetSigned,
      exchange_snapshot_btc: this.s.snapshotSigned,
      copy_position_btc: this.s.copySigned,
      copy_initial_notional_usd: START_NOTIONAL_USD,
      virtual_v46: this.s.virtualV46 ? {started_at:this.s.virtualV46.startedAt,events:this.s.virtualV46.events,
        equity_usd:this.s.virtualV46.balanceUsd+this.s.virtualV46.qty*(this.s.virtualV46.lastMarkPrice-this.s.virtualV46.avgPrice)} : null,
      copy_ratio: this.s.ratio, copy_enabled: this.s.copyEnabled,
      needs_audit: this.s.needsAudit,
      snapshot_mismatch_btc: this.s.snapshotMismatch,
      snapshot_sync_status: this.s.snapshotSyncStatus || 'NOT_CHECKED',
      snapshot_aligned_target_btc: this.s.snapshotAlignedTarget ?? null,
      snapshot_request_at: this.s.snapshotRequestAt || null,
      snapshot_response_at: this.s.snapshotResponseAt || null,
      snapshot_confirmed_mismatch: !!this.s.snapshotConfirmedMismatch,
      pending_snapshot_count: (this.s.pendingSnapshots || []).length,
      last_verified_snapshot: this.s.lastVerifiedSnapshot || null,
      last_snapshot_check: this.s.lastSnapshotCheck || null,
      snapshot_check_counts: this.s.snapshotChecks || {matched:0,mismatched:0,raced:0,pendingExpired:0},
      last_fill_at: this.s.lastFillAt, last_audit_at: this.s.lastAuditAt,
      last_snapshot_at: this.s.lastSnapshotAt,
      stats: this.s.stats, recent_actions: this.s.recent,
      pending_d1_writes: 0, error: this.s.lastError,
      ledger_count: this.s.ledgerCount, replay_gap: this.s.replayGap,
      audit_cursor: this.s.auditCursor,
      incremental_actions_since_restart:this.incrementalActions,
      recovery_replays_since_restart:this.recoveryReplays,
      last_recovery_reason:this.recoveryReason,
      queued_ingest_jobs:this.queuedJobs,
      note: 'Snapshot is compared only to audited fill state at snapshot request time. In-flight fills are marked ambiguous. Read-only.',
    };
  }

  private async reset(): Promise<Response> {
    if (this.resetBusy) return response({ ok: false, error: 'RESET_BUSY' }, 409);
    this.resetBusy = true;
    this.s.active = false;
    this.s.connected = false;
    try { this.ws?.close(1000, 'reset'); } catch {}
    this.ws = null;
    try {
      await this.processing;
      await this.ensureDb();
      // Only delete this wallet's rows. Verify legacy schema before deletion;
      // never issue an unconditional DELETE against shared cryptobot tables.
      const legacy = [
        'trader_mirror_events_v2', 'trader_copy_positions_v15',
        'trader_shadow_close_events', 'trader_shadow_positions_v14',
      ];
      for (const name of legacy) {
        const table: any = await this.env.DB.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
        ).bind(name).first();
        if (!table) continue;
        const columns: any = await this.env.DB.prepare(`PRAGMA table_info(${name})`).all();
        const hasWallet = (columns.results || []).some((c: any) => c.name === 'wallet');
        if (!hasWallet) throw new Error('RESET_ABORT_LEGACY_TABLE_WITHOUT_WALLET: ' + name);
        await this.env.DB.prepare(`DELETE FROM ${name} WHERE lower(wallet)=?`).bind(TARGET).run();
      }
      await this.env.DB.prepare(`DELETE FROM trader_watch_v4_actions WHERE wallet=?`).bind(TARGET).run();
      await this.env.DB.prepare(`DELETE FROM trader_watch_v4_fills WHERE wallet=?`).bind(TARGET).run();
      // Previous V4 shipped incompatible table layouts. Recreate ONLY V4-owned tables.
      await this.env.DB.prepare('DROP TABLE IF EXISTS trader_watch_v4_actions').run();
      await this.env.DB.prepare('DROP TABLE IF EXISTS trader_watch_v4_fills').run();
      this.databaseReady = false;
      await this.ensureDb();
      await this.ctx.storage.deleteAll();
      this.s = fresh();
      await this.save();
      return response({ ok: true, version: VERSION, reset: true,
        counters_zero: true, active: false, next_step: 'POST /start' });
    } catch (e) {
      this.s.lastError = 'RESET_INCOMPLETE: ' + String(e);
      await this.save();
      return response({ ok: false, error: 'RESET_INCOMPLETE', detail: String(e),
        note: 'Do not start until reset succeeds.' }, 500);
    } finally {
      this.resetBusy = false;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/reset' && request.method === 'POST') return this.reset();
    if (path === '/start' && request.method === 'POST') {
      if (this.resetBusy) return response({ ok: false, error: 'RESET_BUSY' }, 409);
      try {
        await this.ensureDb();
        await this.ensureVirtual();
        await this.save();
        // Establish snapshot baseline BEFORE subscribing to live fills.
        if (!this.s.baselineAt) {
          await this.snapshot(true);
          if (!this.s.baselineAt) throw new Error('BASELINE_SNAPSHOT_UNAVAILABLE');
        }
        this.s.active = true;
        this.connect();
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
        await this.save();
        return response(this.status());
      } catch (e) { return response({ ok: false, error: String(e) }, 503); }
    }
    if (path === '/stop' && request.method === 'POST') {
      this.s.active = false;
      this.s.connected = false;
      try { this.ws?.close(1000, 'stop'); } catch {}
      this.ws = null;
      await this.save();
      return response(this.status());
    }
    if (path === '/audit' && request.method === 'POST') {
      this.s.nextApiAt = 0;
      await this.audit(true);
      await this.snapshot(true);
      return response(this.status());
    }
    if (['/status', '/v4', '/mirror'].includes(path)) return response(this.status());
    if (path === '/snapshot-audit' && request.method === 'GET') return response({
      ok:true,version:VERSION,mode:'READ_ONLY_SNAPSHOT_VERIFICATION',
      latest_snapshot:{signed:this.s.snapshotSigned,request_at:this.s.snapshotRequestAt,
        response_at:this.s.snapshotResponseAt,status:this.s.snapshotSyncStatus},
      last_verified_snapshot:this.s.lastVerifiedSnapshot || null,
      last_snapshot_check:this.s.lastSnapshotCheck || null,
      pending_snapshot_count:(this.s.pendingSnapshots || []).length,
      checks:this.s.snapshotChecks || null,
      audit_cursor:this.s.auditCursor,needs_audit:this.s.needsAudit,
      replay_gap:this.s.replayGap,trading_enabled:false});
    if (path === '/virtual-pl' && request.method === 'GET') {
      try {return response(await this.virtualReport());}
      catch(e){return response({ok:false,error:String(e)},503);}
    }
    if (path === '/pipeline-audit' && request.method === 'GET') return response(this.pipelineAudit());
    if (path === '/execution-audit' && request.method === 'GET') {
      try { return response(await this.executionAudit(Number(url.searchParams.get('limit') || 5000))); }
      catch (e) { return response({ok:false,error:String(e)},503); }
    }
    if (path === '/actions') {
      try {
        await this.ensureDb();
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)));
        const data: any = await this.env.DB.prepare(`SELECT payload_json
          FROM trader_watch_v4_actions WHERE wallet=? AND epoch=?
          ORDER BY event_at DESC LIMIT ?`).bind(TARGET, this.s.epoch, limit).all();
        return response({ ok: true, version: VERSION,
          rows: (data.results || []).map((r: any) => JSON.parse(r.payload_json)) });
      } catch (e) { return response({ ok: false, error: String(e) }, 503); }
    }
    return response({ ok: false, error: 'NOT_FOUND' }, 404);
  }
}
