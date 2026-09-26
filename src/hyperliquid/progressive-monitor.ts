    // ============================================================
    // CRYPTOBOT V2.9.1 — WS → EXECUTION BRIDGE (DRY RUN ONLY)
    //
    // Purpose:
    // - Observe Hyperliquid markPx in real time via activeAssetCtx WebSocket.
    // - Detect LONG Progressive A / SHORT Progressive C thresholds.
    // - Record exactly when a threshold is seen.
    // - NEVER signs, NEVER calls /exchange, NEVER modifies/cancels an order.
    // - No private key is read by this module.
    //
    // Hyperliquid WS: wss://api.hyperliquid.xyz/ws
    // ============================================================

    const HL_WS = "wss://api.hyperliquid.xyz/ws";
    const MODULE_VERSION = "V2.11.0 LIVE RUNNER + WS TICK SL SHADOW";

    type Side = "LONG" | "SHORT";

    type MonitorConfig = {
      active: boolean;
      coin: string;
      side: Side;
      entryPrice: number | null;
      entrySource: "FIRST_WS_MARK" | "EXPLICIT";
      startedAt: number;
      stage: number;
      maxDirectionalReturnPct: number;
      lastPrice: number | null;
      lastMessageAt: number | null;
      messageCount: number;
      reconnectCount: number;
      connectionState: string;
      ledgerId: number | null;
      crossingId: string | null;
      ledgerStatus: string | null;
      ledgerProgressiveStageAtStart: number;
      ledgerProgressiveStopOidAtStart: number | null;
    };

    type TriggerEvent = {
      stage: number;
      coin: string;
      side: Side;
      triggerPct: number;
      targetStopPct: number;
      entryPrice: number;
      observedPrice: number;
      directionalReturnPct: number;
      detectedAt: number;
      detectedDatetime: string;
      action: "DRY_RUN_EXECUTION_BRIDGE";
      exchangeRequestSent: false;
      bridge: {
        ledgerId: number | null;
        crossingId: string | null;
        ledgerStatus: string | null;
        ledgerStageBefore: number | null;
        ledgerActiveStopOid: number | null;
        targetStage: number;
        targetStopPct: number;
        targetStopPrice: number;
        validation: string;
      };
    };

    const LONG_A = [
      { trigger: 0.15, stop: 0.07 },
      { trigger: 0.25, stop: 0.10 },
      { trigger: 0.35, stop: 0.20 },
      { trigger: 0.45, stop: 0.30 },
      { trigger: 0.75, stop: 0.50 },
      { trigger: 1.00, stop: 0.75 },
      { trigger: 1.50, stop: 1.00 },
      { trigger: 2.00, stop: 1.50 },
      { trigger: 3.00, stop: 2.00 },
    ];

    const SHORT_C = [
      { trigger: 0.25, stop: 0.07 },
      { trigger: 0.35, stop: 0.15 },
      { trigger: 0.45, stop: 0.25 },
      { trigger: 0.75, stop: 0.50 },
      { trigger: 1.00, stop: 0.75 },
      { trigger: 1.50, stop: 1.00 },
      { trigger: 2.00, stop: 1.50 },
      { trigger: 3.00, stop: 2.00 },
    ];

    function json(data: any, status = 200): Response {
      return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "cache-control": "no-store",
        },
      });
    }

    function finitePositive(v: any): number | null {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    function directionalReturnPct(side: Side, entry: number, price: number): number {
      const raw = side === "LONG"
        ? ((price / entry) - 1) * 100
        : ((entry / price) - 1) * 100;
      return Math.round(raw * 100000) / 100000;
    }

    export class ProgressiveMonitor {
      private ctx: any;
      private env: any;
      private ws: WebSocket | null = null;
      private config: MonitorConfig | null = null;
      private events: TriggerEvent[] = [];
      // V2.11.0 research-only detached WS streams. They continue after a real
      // trade closes so each ledger can be observed until entry+30m.
      private shadowSockets: Map<number, WebSocket> = new Map();

      // V2.9.5: serialize all WS price messages inside this Durable Object.
      // Previously multiple async message handlers could overlap before D1
      // persisted progressive_stage, creating duplicate live SL orders.
      private messageQueue: Promise<void> = Promise.resolve();

      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;

        this.ctx.blockConcurrencyWhile(async () => {
          this.config = (await this.ctx.storage.get("config")) ?? null;
          this.events = (await this.ctx.storage.get("events")) ?? [];
        });
      }

      private async latestOpenLedgerRow(): Promise<any | null> {
        if (!this.env?.DB) return null;
        try {
          return await this.env.DB.prepare(`
            SELECT id, crossing_id, coin, side, status, entry_fill_price, entry_fill_size,
                   progressive_stage, progressive_stop_pct, progressive_stop_price,
                   progressive_stop_oid, entry_filled_at, closed_at, close_reason, realized_pnl, updated_at
            FROM hyperliquid_execution_ledger
            WHERE status IN ('ENTRY_FILLED','PROTECTED','TPSL_FAILED_AFTER_RETRIES','MAX_HOLD_CLOSING')
              AND entry_fill_price IS NOT NULL
              AND entry_fill_price > 0
            ORDER BY COALESCE(entry_filled_at, updated_at, id) DESC
            LIMIT 1
          `).first();
        } catch {
          return null;
        }
      }

      // V2.9.7: any historical execution ledger row for a crossing means
      // that crossing belongs to the REAL execution lifecycle. It must never
      // fall back to AUTO_DRY_RUN_CROSSING after TP/SL/TIME/progressive close.
      private async ledgerRowByCrossingId(crossingId: string | null): Promise<any | null> {
        if (!this.env?.DB || crossingId == null || String(crossingId).trim() === "") return null;
        try {
          return await this.env.DB.prepare(`
            SELECT id, crossing_id, coin, side, status, entry_fill_price, entry_fill_size,
                   progressive_stage, progressive_stop_pct, progressive_stop_price,
                   progressive_stop_oid, entry_filled_at, closed_at, close_reason, realized_pnl, updated_at
            FROM hyperliquid_execution_ledger
            WHERE CAST(crossing_id AS TEXT)=?
            ORDER BY id DESC
            LIMIT 1
          `).bind(String(crossingId)).first();
        } catch {
          return null;
        }
      }

      private async ledgerRowById(id: number | null): Promise<any | null> {
        if (!this.env?.DB || !Number.isInteger(id) || Number(id) <= 0) return null;
        try {
          return await this.env.DB.prepare(`
            SELECT id, crossing_id, coin, side, status, entry_fill_price, entry_fill_size,
                   progressive_stage, progressive_stop_pct, progressive_stop_price,
                   progressive_stop_oid, entry_filled_at, closed_at, close_reason, realized_pnl, updated_at
            FROM hyperliquid_execution_ledger
            WHERE id=?
            LIMIT 1
          `).bind(id).first();
        } catch {
          return null;
        }
      }


      private async ensureWsShadowTable(): Promise<void> {
        if (!this.env?.DB) return;
        await this.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS ws_tick_sl_shadow (
            ledger_id INTEGER PRIMARY KEY,
            crossing_id TEXT,
            coin TEXT NOT NULL,
            side TEXT NOT NULL,
            entry_price REAL NOT NULL,
            entry_ts INTEGER NOT NULL,
            horizon_ts INTEGER NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            tick_count INTEGER NOT NULL DEFAULT 0,
            first_tick_ts INTEGER,
            last_tick_ts INTEGER,
            last_price REAL,
            mfe_pct REAL,
            mae_pct REAL,
            hit_sl015_ts INTEGER,
            hit_sl020_ts INTEGER,
            hit_sl025_ts INTEGER,
            hit_sl030_ts INTEGER,
            hit_sl040_ts INTEGER,
            hit_plus015_ts INTEGER,
            hit_plus025_ts INTEGER,
            hit_plus035_ts INTEGER,
            hit_plus050_ts INTEGER,
            real_close_ts INTEGER,
            real_close_reason TEXT,
            completed_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `).run();
      }

      private async seedWsShadow(ledger:any): Promise<void> {
        if (!this.env?.DB || !ledger) return;
        const ledgerId=Number(ledger.id);
        const entry=finitePositive(ledger.entry_fill_price);
        const entryTs=Number(ledger.entry_filled_at);
        const side=String(ledger.side??"").toUpperCase();
        if(!Number.isInteger(ledgerId)||ledgerId<=0||!entry||!Number.isFinite(entryTs)||entryTs<=0) return;
        if(side!=="LONG"&&side!=="SHORT") return;
        await this.ensureWsShadowTable();
        const now=Date.now();
        await this.env.DB.prepare(`
          INSERT OR IGNORE INTO ws_tick_sl_shadow (
            ledger_id,crossing_id,coin,side,entry_price,entry_ts,horizon_ts,
            active,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,1,?,?)
        `).bind(
          ledgerId,ledger.crossing_id!=null?String(ledger.crossing_id):null,
          String(ledger.coin).toUpperCase(),side,entry,entryTs,entryTs+30*60000,now,now
        ).run();
      }

      private async updateWsShadowTick(ledgerId:number, price:number, ts:number): Promise<void> {
        if(!this.env?.DB||!Number.isInteger(ledgerId)||ledgerId<=0||!Number.isFinite(price)||price<=0) return;
        await this.ensureWsShadowTable();
        const row:any=await this.env.DB.prepare(`SELECT * FROM ws_tick_sl_shadow WHERE ledger_id=? LIMIT 1`).bind(ledgerId).first();
        if(!row||Number(row.active)!==1) return;
        const horizon=Number(row.horizon_ts);
        if(ts>horizon){
          await this.env.DB.prepare(`
            UPDATE ws_tick_sl_shadow SET active=0,completed_at=?,updated_at=? WHERE ledger_id=?
          `).bind(ts,ts,ledgerId).run();
          return;
        }
        const ret=directionalReturnPct(String(row.side).toUpperCase() as Side,Number(row.entry_price),price);
        const setOnce=(col:string,condition:boolean)=>condition&&row[col]==null?ts:null;
        const sl015=setOnce("hit_sl015_ts",ret<=-0.15);
        const sl020=setOnce("hit_sl020_ts",ret<=-0.20);
        const sl025=setOnce("hit_sl025_ts",ret<=-0.25);
        const sl030=setOnce("hit_sl030_ts",ret<=-0.30);
        const sl040=setOnce("hit_sl040_ts",ret<=-0.40);
        const p015=setOnce("hit_plus015_ts",ret>=0.15);
        const p025=setOnce("hit_plus025_ts",ret>=0.25);
        const p035=setOnce("hit_plus035_ts",ret>=0.35);
        const p050=setOnce("hit_plus050_ts",ret>=0.50);
        const mfe=row.mfe_pct==null?ret:Math.max(Number(row.mfe_pct),ret);
        const mae=row.mae_pct==null?ret:Math.min(Number(row.mae_pct),ret);
        await this.env.DB.prepare(`
          UPDATE ws_tick_sl_shadow SET
            tick_count=tick_count+1,
            first_tick_ts=COALESCE(first_tick_ts,?),
            last_tick_ts=?,last_price=?,mfe_pct=?,mae_pct=?,
            hit_sl015_ts=COALESCE(hit_sl015_ts,?),
            hit_sl020_ts=COALESCE(hit_sl020_ts,?),
            hit_sl025_ts=COALESCE(hit_sl025_ts,?),
            hit_sl030_ts=COALESCE(hit_sl030_ts,?),
            hit_sl040_ts=COALESCE(hit_sl040_ts,?),
            hit_plus015_ts=COALESCE(hit_plus015_ts,?),
            hit_plus025_ts=COALESCE(hit_plus025_ts,?),
            hit_plus035_ts=COALESCE(hit_plus035_ts,?),
            hit_plus050_ts=COALESCE(hit_plus050_ts,?),
            updated_at=?
          WHERE ledger_id=?
        `).bind(ts,ts,price,mfe,mae,sl015,sl020,sl025,sl030,sl040,p015,p025,p035,p050,ts,ledgerId).run();
      }

      private async markWsShadowRealClose(ledger:any):Promise<void>{
        if(!this.env?.DB||!ledger) return;
        await this.seedWsShadow(ledger);
        await this.env.DB.prepare(`
          UPDATE ws_tick_sl_shadow
          SET real_close_ts=COALESCE(real_close_ts,?),
              real_close_reason=COALESCE(real_close_reason,?),
              updated_at=?
          WHERE ledger_id=?
        `).bind(
          Number(ledger.closed_at)||Date.now(),
          ledger.close_reason!=null?String(ledger.close_reason):String(ledger.status??"CLOSED"),
          Date.now(),Number(ledger.id)
        ).run();
      }

      private async startDetachedShadow(ledger:any):Promise<void>{
        if(!ledger) return;
        const ledgerId=Number(ledger.id);
        if(!Number.isInteger(ledgerId)||ledgerId<=0||this.shadowSockets.has(ledgerId)) return;
        await this.markWsShadowRealClose(ledger);
        const row:any=await this.env.DB?.prepare(`SELECT * FROM ws_tick_sl_shadow WHERE ledger_id=?`).bind(ledgerId).first();
        if(!row||Number(row.active)!==1) return;
        if(Date.now()>=Number(row.horizon_ts)){
          await this.env.DB.prepare(`UPDATE ws_tick_sl_shadow SET active=0,completed_at=?,updated_at=? WHERE ledger_id=?`)
            .bind(Date.now(),Date.now(),ledgerId).run();
          return;
        }
        const upstream=new WebSocket(HL_WS);
        this.shadowSockets.set(ledgerId,upstream);
        upstream.addEventListener("open",()=>{
          upstream.send(JSON.stringify({method:"subscribe",subscription:{type:"activeAssetCtx",coin:String(row.coin).toUpperCase()}}));
        });
        upstream.addEventListener("message",(ev:MessageEvent)=>{
          this.messageQueue=this.messageQueue.then(async()=>{
            let msg:any; try{msg=typeof ev.data==="string"?JSON.parse(ev.data):null}catch{return}
            if(msg?.channel!=="activeAssetCtx") return;
            const px=finitePositive(msg?.data?.ctx?.markPx??msg?.data?.ctx?.midPx);
            if(!px) return;
            const now=Date.now();
            await this.updateWsShadowTick(ledgerId,px,now);
            if(now>=Number(row.horizon_ts)){
              try{upstream.close(1000,"shadow complete")}catch{}
              this.shadowSockets.delete(ledgerId);
            }
          }).catch(()=>{});
        });
        const reconnect=()=>{
          this.shadowSockets.delete(ledgerId);
          this.ctx.storage.setAlarm(Date.now()+2000).catch(()=>{});
        };
        upstream.addEventListener("close",reconnect);
        upstream.addEventListener("error",reconnect);
      }

      private async resumeActiveShadows():Promise<void>{
        if(!this.env?.DB) return;
        await this.ensureWsShadowTable();
        const now=Date.now();
        await this.env.DB.prepare(`
          UPDATE ws_tick_sl_shadow SET active=0,completed_at=COALESCE(completed_at,?),updated_at=?
          WHERE active=1 AND horizon_ts<=?
        `).bind(now,now,now).run();
        const q:any=await this.env.DB.prepare(`
          SELECT s.*,l.status,l.closed_at,l.close_reason
          FROM ws_tick_sl_shadow s
          LEFT JOIN hyperliquid_execution_ledger l ON l.id=s.ledger_id
          WHERE s.active=1 AND s.real_close_ts IS NOT NULL AND s.horizon_ts>?
          ORDER BY s.ledger_id
        `).bind(now).all();
        for(const row of q?.results??[]) await this.startDetachedShadow(row);
      }

      private async wsShadowReport():Promise<any>{
        if(!this.env?.DB) return {success:false,error:"D1_NOT_BOUND"};
        await this.ensureWsShadowTable();
        const q:any=await this.env.DB.prepare(`SELECT * FROM ws_tick_sl_shadow ORDER BY ledger_id DESC LIMIT 500`).all();
        const rows:any[]=q?.results??[];
        const levels=[0.15,0.20,0.25,0.30,0.40];
        const summary=levels.map(sl=>{
          const key="hit_sl"+String(Math.round(sl*100)).padStart(3,"0")+"_ts";
          let tpFirst=0,slFirst=0,time=0,pending=0;
          for(const r of rows){
            const st=Number(r[key])||null, tp=Number(r.hit_plus050_ts)||null;
            if(st&&(!tp||st<tp)) slFirst++;
            else if(tp&&(!st||tp<st)) tpFirst++;
            else if(Number(r.active)===1) pending++;
            else time++;
          }
          return {sl_pct:sl,trades:rows.length,tp_first:tpFirst,sl_first:slFirst,time_no_barrier:time,pending};
        });
        return {
          success:true,module:MODULE_VERSION,mode:"WS_TICK_SL_SHADOW_READ_ONLY",
          trading:"REAL_TRADING_UNCHANGED",
          methodology:{
            source:"Hyperliquid activeAssetCtx markPx websocket",
            horizon_minutes:30,
            tested_sl_pct:levels,
            tp_reference_pct:0.50,
            starts_at:"real entry; same WS ticks while live, detached WS continues after real close",
            ordering:"first observed WS mark touch wins",
            note:"research only; no exchange action"
          },
          summary,
          active_detached_ws:[...this.shadowSockets.keys()],
          shadows:rows
        };
      }

      private progressiveStopPrice(side: Side, entry: number, protectedPct: number): number {
        return side === "LONG"
          ? entry * (1 + protectedPct / 100)
          : entry * (1 - protectedPct / 100);
      }

      private async ensureEventTable(): Promise<void> {
        if (!this.env?.DB) return;
        await this.env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS progressive_ws_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ledger_id INTEGER,
            crossing_id TEXT,
            coin TEXT NOT NULL,
            side TEXT NOT NULL,
            entry_price REAL NOT NULL,
            stage INTEGER NOT NULL,
            trigger_pct REAL NOT NULL,
            target_stop_pct REAL NOT NULL,
            target_stop_price REAL NOT NULL,
            observed_price REAL NOT NULL,
            directional_return_pct REAL NOT NULL,
            ledger_status TEXT,
            ledger_stage_before INTEGER,
            ledger_active_stop_oid INTEGER,
            validation TEXT NOT NULL,
            detected_at INTEGER NOT NULL,
            detected_datetime TEXT NOT NULL,
            action TEXT NOT NULL,
            exchange_request_sent INTEGER NOT NULL DEFAULT 0,
            UNIQUE(ledger_id, stage)
          )
        `).run();
        await this.env.DB.prepare(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_progressive_ws_crossing_stage
          ON progressive_ws_events (crossing_id, stage)
          WHERE crossing_id IS NOT NULL
        `).run();
      }

      private async persistTriggerEvent(event: TriggerEvent): Promise<void> {
        if (!this.env?.DB) return;
        await this.ensureEventTable();
        await this.env.DB.prepare(`
          INSERT OR IGNORE INTO progressive_ws_events (
            ledger_id,crossing_id,coin,side,entry_price,stage,trigger_pct,target_stop_pct,
            target_stop_price,observed_price,directional_return_pct,ledger_status,
            ledger_stage_before,ledger_active_stop_oid,validation,detected_at,
            detected_datetime,action,exchange_request_sent
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          event.bridge.ledgerId,event.bridge.crossingId,event.coin,event.side,event.entryPrice,
          event.stage,event.triggerPct,event.targetStopPct,event.bridge.targetStopPrice,
          event.observedPrice,event.directionalReturnPct,event.bridge.ledgerStatus,
          event.bridge.ledgerStageBefore,event.bridge.ledgerActiveStopOid,event.bridge.validation,
          event.detectedAt,event.detectedDatetime,event.action,0
        ).run();
      }

      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/shadow-status") {
          return json(await this.wsShadowReport());
        }

        if (url.pathname === "/start") {
          const body: any = request.method === "POST"
            ? await request.json().catch(() => ({} as any)) as any
            : {
                coin: url.searchParams.get("coin"),
                side: url.searchParams.get("side"),
                entry: url.searchParams.get("entry"),
              };

          const requestedMode = String(body?.mode ?? "").trim().toUpperCase();
          const requestedLedgerId = Number(body?.ledgerId ?? body?.ledger_id);
          let ledger: any = null;

          if (requestedMode === "LEDGER" || Number.isInteger(requestedLedgerId)) {
            ledger = Number.isInteger(requestedLedgerId)
              ? await this.ledgerRowById(requestedLedgerId)
              : await this.latestOpenLedgerRow();

            if (!ledger) {
              return json({
                success: false,
                module: MODULE_VERSION,
                error: "NO_OPEN_EXECUTION_LEDGER_ROW",
                required_statuses: [
                  "ENTRY_FILLED",
                  "PROTECTED",
                  "TPSL_FAILED_AFTER_RETRIES",
                  "MAX_HOLD_CLOSING"
                ],
                safety: "READ_ONLY_NO_EXCHANGE_ACTION",
              }, 404);
            }
          }

          // V2.9.7 crossing guard:
          // If this start request is a crossing fallback, first check whether
          // the crossing has EVER had a real execution ledger row.
          // - OPEN real ledger -> attach to that exact ledger instead of dry-run.
          // - CLOSED/terminal real ledger -> reject fallback completely.
          // - No ledger ever -> AUTO_DRY_RUN_CROSSING remains allowed.
          const requestedCrossingId =
            body?.crossingId != null ? String(body.crossingId) :
            (body?.crossing_id != null ? String(body.crossing_id) : null);

          if (!ledger && requestedCrossingId != null) {
            const historicalLedger = await this.ledgerRowByCrossingId(requestedCrossingId);
            if (historicalLedger) {
              const openStatuses = new Set([
                "ENTRY_FILLED",
                "PROTECTED",
                "TPSL_FAILED_AFTER_RETRIES",
                "MAX_HOLD_CLOSING",
              ]);

              if (openStatuses.has(String(historicalLedger.status ?? ""))) {
                ledger = historicalLedger;
              } else {
                await this.closeSocket("REAL_LEDGER_ALREADY_TERMINAL");
                if (this.config) {
                  this.config.active = false;
                  this.config.connectionState = `BLOCKED_REAL_LEDGER_${String(historicalLedger.status ?? "TERMINAL")}`;
                  await this.persist();
                }
                return json({
                  success: false,
                  module: MODULE_VERSION,
                  error: "AUTO_DRY_RUN_BLOCKED_REAL_LEDGER_EXISTS",
                  crossing_id: requestedCrossingId,
                  ledger_id: Number(historicalLedger.id),
                  ledger_status: String(historicalLedger.status ?? "UNKNOWN"),
                  message: "Crossing already belongs to a real execution lifecycle; dry-run fallback is forbidden.",
                }, 409);
              }
            }
          }

          const coin = String(ledger?.coin ?? body?.coin ?? "").trim().toUpperCase();
          const side = String(ledger?.side ?? body?.side ?? "").trim().toUpperCase() as Side;
          const explicitEntry = finitePositive(
            ledger?.entry_fill_price ?? body?.entryPrice ?? body?.entry
          );

          if (!coin) return json({ success: false, error: "COIN_REQUIRED" }, 400);
          if (side !== "LONG" && side !== "SHORT") {
            return json({ success: false, error: "SIDE_MUST_BE_LONG_OR_SHORT" }, 400);
          }

          await this.closeSocket("RESTART");

          const ledgerStage = Math.max(0, Number(ledger?.progressive_stage ?? 0) || 0);
          const ledgerOidRaw = Number(ledger?.progressive_stop_oid);
          const ledgerOid = Number.isInteger(ledgerOidRaw) && ledgerOidRaw >= 0 ? ledgerOidRaw : null;

          this.config = {
            active: true,
            coin,
            side,
            entryPrice: explicitEntry,
            entrySource: ledger ? "EXPLICIT" : (explicitEntry ? "EXPLICIT" : "FIRST_WS_MARK"),
            startedAt: Date.now(),
            stage: ledger ? ledgerStage : 0,
            maxDirectionalReturnPct: 0,
            lastPrice: null,
            lastMessageAt: null,
            messageCount: 0,
            reconnectCount: 0,
            connectionState: "CONNECTING",
            ledgerId: ledger ? Number(ledger.id) : null,
            crossingId: ledger?.crossing_id != null ? String(ledger.crossing_id) : (body?.crossingId != null ? String(body.crossingId) : (body?.crossing_id != null ? String(body.crossing_id) : null)),
            ledgerStatus: ledger?.status != null ? String(ledger.status) : null,
            ledgerProgressiveStageAtStart: ledgerStage,
            ledgerProgressiveStopOidAtStart: ledgerOid,
          };
          this.events = [];
          if (ledger) await this.seedWsShadow(ledger);

          await this.persist();
          await this.connect();

          return json({
            success: true,
            module: MODULE_VERSION,
            mode: "DRY_RUN_READ_ONLY",
            message: ledger
              ? "MONITOR_STARTED_FROM_EXECUTION_LEDGER"
              : (explicitEntry
                  ? "MONITOR_STARTED_WITH_EXPLICIT_ENTRY"
                  : "MONITOR_STARTED_ENTRY_WILL_BE_FIRST_WS_MARK"),
            status: await this.status(),
          });
        }

        if (url.pathname === "/stop") {
          if (this.config) {
            this.config.active = false;
            this.config.connectionState = "STOPPED";
          }
          await this.persist();
          await this.closeSocket("USER_STOP");
          return json({
            success: true,
            module: MODULE_VERSION,
            mode: "DRY_RUN_READ_ONLY",
            status: await this.status(),
          });
        }

        if (url.pathname === "/events") {
          if (!this.env?.DB) return json({ success:false, error:"D1_NOT_BOUND" },503);
          await this.ensureEventTable();
          const q:any=await this.env.DB.prepare(`
            SELECT * FROM progressive_ws_events
            ORDER BY detected_at DESC, id DESC LIMIT 100
          `).all();
          return json({
            success:true,module:MODULE_VERSION,mode:"DRY_RUN_READ_ONLY",
            count:Array.isArray(q?.results)?q.results.length:0,
            events:Array.isArray(q?.results)?q.results:[]
          });
        }

        if (url.pathname === "/status" || url.pathname === "/") {
          return json({
            success: true,
            module: MODULE_VERSION,
            mode: "DRY_RUN_READ_ONLY",
            safety: {
              private_key_read: false,
              signing_performed: false,
              exchange_endpoint_called: false,
              order_sent: false,
              order_modified: false,
              order_cancelled: false,
            },
            status: await this.status(),
          });
        }

        return json({ success: false, error: "NOT_FOUND", path: url.pathname }, 404);
      }

      async alarm(): Promise<void> {
        await this.resumeActiveShadows();
        if (!this.config?.active) return;

        const stale =
          !this.config.lastMessageAt ||
          Date.now() - this.config.lastMessageAt > 15_000;

        if (!this.ws || this.ws.readyState === WebSocket.CLOSED || stale) {
          this.config.reconnectCount += 1;
          this.config.connectionState = "RECONNECTING";
          await this.persist();
          await this.closeSocket("ALARM_RECONNECT");
          await this.connect();
        }

        if (this.config?.active) {
          await this.ctx.storage.setAlarm(Date.now() + 10_000);
        }
      }

      private async connect(): Promise<void> {
        if (!this.config?.active) return;

        const ws = new WebSocket(HL_WS);
        this.ws = ws;
        this.config.connectionState = "CONNECTING";
        await this.persist();

        ws.addEventListener("open", () => {
          if (!this.config?.active) {
            try { ws.close(1000, "inactive"); } catch {}
            return;
          }

          this.config.connectionState = "OPEN";
          this.persist().catch(() => {});

          ws.send(JSON.stringify({
            method: "subscribe",
            subscription: {
              type: "activeAssetCtx",
              coin: this.config.coin,
            },
          }));
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          const raw = event.data;
          this.messageQueue = this.messageQueue
            .then(() => this.onMessage(raw))
            .catch((error: any) => {
              console.log("progressive WS message failed:", error?.message ?? String(error));
            });
        });

        ws.addEventListener("close", () => {
          if (this.ws === ws) this.ws = null;
          if (this.config?.active) {
            this.config.connectionState = "CLOSED_WAITING_RECONNECT";
            this.persist().catch(() => {});
            this.ctx.storage.setAlarm(Date.now() + 2_000).catch(() => {});
          }
        });

        ws.addEventListener("error", () => {
          if (this.config?.active) {
            this.config.connectionState = "ERROR";
            this.persist().catch(() => {});
            this.ctx.storage.setAlarm(Date.now() + 2_000).catch(() => {});
          }
        });

        await this.ctx.storage.setAlarm(Date.now() + 10_000);
      }

      private async onMessage(raw: any): Promise<void> {
        if (!this.config?.active) return;

        let msg: any;
        try {
          msg = typeof raw === "string" ? JSON.parse(raw) : null;
        } catch {
          return;
        }

        // subscriptionResponse and pong are connectivity messages, not price updates.
        if (msg?.channel !== "activeAssetCtx") return;

        const data = msg?.data;
        const msgCoin = String(data?.coin ?? "").toUpperCase();
        if (msgCoin && msgCoin !== this.config.coin) return;

        // Use markPx deliberately: Hyperliquid trigger orders are evaluated from mark price.
        const price = finitePositive(data?.ctx?.markPx ?? data?.ctx?.midPx);
        if (!price) return;

        const now = Date.now();
        this.config.lastPrice = price;
        this.config.lastMessageAt = now;
        this.config.messageCount += 1;
        this.config.connectionState = "OPEN";
        if (this.config.ledgerId != null) {
          await this.updateWsShadowTick(this.config.ledgerId, price, now);
        }

        // V2.11.0: real progressive execution stops when ledger closes, but
        // research shadow detaches and continues independently to entry+30m.
        // V2.9.5: a ledger-backed monitor must stop after the real position
        // lifecycle closes its ledger row. This prevents stale post-close
        // stages/events from being recorded.
        if (this.config.ledgerId != null) {
          const liveLedger = await this.ledgerRowById(this.config.ledgerId);
          const openStatuses = new Set([
            "ENTRY_FILLED",
            "PROTECTED",
            "TPSL_FAILED_AFTER_RETRIES",
            "MAX_HOLD_CLOSING",
          ]);
          if (!liveLedger || !openStatuses.has(String(liveLedger.status ?? ""))) {
            if (liveLedger) await this.startDetachedShadow(liveLedger);
            this.config.active = false;
            this.config.connectionState = liveLedger
              ? `STOPPED_LEDGER_${String(liveLedger.status ?? "CLOSED")}_SHADOW_CONTINUES`
              : "STOPPED_LEDGER_ROW_MISSING";
            await this.persist();
            try { this.ws?.close(1000, "ledger closed; shadow detached"); } catch {}
            this.ws = null;
            return;
          }
        }

        if (!this.config.entryPrice) {
          this.config.entryPrice = price;
          this.config.entrySource = "FIRST_WS_MARK";
          await this.persist();
          return;
        }

        const ret = directionalReturnPct(
          this.config.side,
          this.config.entryPrice,
          price
        );

        this.config.maxDirectionalReturnPct = Math.max(
          this.config.maxDirectionalReturnPct,
          ret
        );

        const steps = this.config.side === "LONG" ? LONG_A : SHORT_C;

        // V2.9.1 bridge validation: when started from the execution ledger, re-read
        // the exact row on every reached threshold. This is READ ONLY: no signing,
        // no /exchange request and no D1 mutation is performed here.
        // If one WS update jumps across multiple thresholds, record all newly reached
        // stages in order. The final stage is the tightest intended protection.
        while (
          this.config.stage < steps.length &&
          ret >= steps[this.config.stage].trigger
        ) {
          const step = steps[this.config.stage];
          const targetStage = this.config.stage + 1;
          const ledgerNow = await this.ledgerRowById(this.config.ledgerId);
          const ledgerStageNow = ledgerNow ? Math.max(0, Number(ledgerNow.progressive_stage ?? 0) || 0) : null;
          const ledgerOidRaw = Number(ledgerNow?.progressive_stop_oid);
          const ledgerOidNow = Number.isInteger(ledgerOidRaw) && ledgerOidRaw >= 0 ? ledgerOidRaw : null;

          let validation = this.config.crossingId != null ? "DRY_RUN_CROSSING_READY" : "MANUAL_TEST_NO_LEDGER";
          if (this.config.ledgerId != null) {
            if (!ledgerNow) validation = "LEDGER_ROW_MISSING";
            else if (String(ledgerNow.coin ?? "").toUpperCase() !== this.config.coin) validation = "LEDGER_COIN_MISMATCH";
            else if (String(ledgerNow.side ?? "").toUpperCase() !== this.config.side) validation = "LEDGER_SIDE_MISMATCH";
            else if (Math.abs(Number(ledgerNow.entry_fill_price) - this.config.entryPrice) > Math.max(1e-12, this.config.entryPrice * 1e-9)) validation = "LEDGER_ENTRY_MISMATCH";
            else if (!["ENTRY_FILLED","PROTECTED","TPSL_FAILED_AFTER_RETRIES","MAX_HOLD_CLOSING"].includes(String(ledgerNow.status ?? ""))) validation = "LEDGER_NOT_OPEN";
            else if ((ledgerStageNow ?? 0) >= targetStage) validation = "LEDGER_ALREADY_AT_OR_ABOVE_TARGET_STAGE";
            else validation = "BRIDGE_READY_FOR_EXECUTION_FUNCTION";
          }

          const event: TriggerEvent = {
            stage: targetStage,
            coin: this.config.coin,
            side: this.config.side,
            triggerPct: step.trigger,
            targetStopPct: step.stop,
            entryPrice: this.config.entryPrice,
            observedPrice: price,
            directionalReturnPct: ret,
            detectedAt: now,
            detectedDatetime: new Date(now).toISOString(),
            action: "DRY_RUN_EXECUTION_BRIDGE",
            exchangeRequestSent: false,
            bridge: {
              ledgerId: this.config.ledgerId,
              crossingId: this.config.crossingId,
              ledgerStatus: ledgerNow?.status != null ? String(ledgerNow.status) : this.config.ledgerStatus,
              ledgerStageBefore: ledgerStageNow,
              ledgerActiveStopOid: ledgerOidNow,
              targetStage,
              targetStopPct: step.stop,
              targetStopPrice: this.progressiveStopPrice(this.config.side, this.config.entryPrice, step.stop),
              validation,
            },
          };

          // Only ledger-backed, exactly validated triggers may call execution.
          // Crossing-only DRY RUN stays completely read-only.
          if (event.bridge.ledgerId != null && event.bridge.validation === "BRIDGE_READY_FOR_EXECUTION_FUNCTION" && this.env?.SELF) {
            try {
              const execRes=await this.env.SELF.fetch("https://cryptobot.internal/internal/progressive-execute",{
                method:"POST",headers:{"content-type":"application/json"},
                body:JSON.stringify({ledgerId:event.bridge.ledgerId,targetStage:event.bridge.targetStage})
              });
              const execJson:any=await execRes.json().catch(()=>null);
              (event as any).execution={attempted:true,http_status:execRes.status,success:execRes.ok&&execJson?.success===true,response:execJson};
            } catch(error:any) {
              (event as any).execution={attempted:true,success:false,error:error?.message??String(error)};
            }
          } else {
            (event as any).execution={attempted:false,reason:event.bridge.ledgerId==null?"DRY_RUN_CROSSING_NO_LEDGER":(this.env?.SELF?"BRIDGE_VALIDATION_NOT_READY":"SELF_BINDING_MISSING")};
          }

          this.events.push(event);
          if (this.events.length > 100) this.events = this.events.slice(-100);
          try { await this.persistTriggerEvent(event); }
          catch (e:any) { console.log("progressive_ws_events persist failed:", e?.message ?? String(e)); }

          // V2.9.5:
          // - DRY-RUN/manual crossings keep the old simulation behavior.
          // - Ledger-backed LIVE mode advances the local stage only after the
          //   execution bridge confirms success (including idempotent
          //   ALREADY_AT_OR_ABOVE_TARGET_STAGE).
          // - On an execution failure, stop this loop and retry on a later WS
          //   message instead of falsely marking the stage as protected.
          if (event.bridge.ledgerId != null) {
            const ex: any = (event as any).execution;
            const bridgeSuccess = ex?.success === true;
            if (!bridgeSuccess) break;

            // V2.9.6: execution.ts may legitimately jump over one or more
            // progressive stages when market price has already crossed them.
            // Synchronize the Durable Object to the authoritative execution/D1
            // stage instead of blindly doing stage += 1.
            const executionStage = Number(
              ex?.response?.result?.stage ??
              ex?.response?.current_stage ??
              ex?.response?.target_stage ??
              event.bridge.targetStage
            );

            if (Number.isFinite(executionStage) && executionStage > this.config.stage) {
              this.config.stage = executionStage;
            } else {
              this.config.stage = Math.max(this.config.stage, event.bridge.targetStage);
            }

            // Re-read D1 after execution so the next loop iteration uses the
            // authoritative active stop OID/stage and cannot spam an already
            // completed lower stage.
            const syncedLedger = await this.ledgerRowById(event.bridge.ledgerId);
            if (syncedLedger) {
              const dbStage = Math.max(0, Number(syncedLedger.progressive_stage ?? 0) || 0);
              if (dbStage > this.config.stage) this.config.stage = dbStage;
            }
          } else {
            // Dry-run/manual monitor retains sequential simulation behavior.
            this.config.stage += 1;
          }
        }

        await this.persist();
      }

      private async status(): Promise<any> {
        const c = this.config;
        const steps = c?.side === "SHORT" ? SHORT_C : LONG_A;
        const nextStep = c && c.stage < steps.length ? steps[c.stage] : null;

        return {
          active: c?.active ?? false,
          coin: c?.coin ?? null,
          side: c?.side ?? null,
          strategy: c
            ? (c.side === "LONG" ? "LONG_PROGRESSIVE_A" : "SHORT_PROGRESSIVE_C")
            : null,
          entry_price: c?.entryPrice ?? null,
          entry_source: c?.entrySource ?? null,
          bridge_mode: c?.ledgerId != null ? "EXECUTION_LEDGER_DRY_RUN" : (c?.crossingId != null ? "AUTO_DRY_RUN_CROSSING" : "MANUAL_WS_TEST"),
          ledger: {
            id: c?.ledgerId ?? null,
            crossing_id: c?.crossingId ?? null,
            status_at_start: c?.ledgerStatus ?? null,
            progressive_stage_at_start: c?.ledgerProgressiveStageAtStart ?? 0,
            active_stop_oid_at_start: c?.ledgerProgressiveStopOidAtStart ?? null,
          },
          stage: c?.stage ?? 0,
          next_step: nextStep,
          max_directional_return_pct: c?.maxDirectionalReturnPct ?? null,
          last_mark_price: c?.lastPrice ?? null,
          last_message_at: c?.lastMessageAt ?? null,
          last_message_datetime: c?.lastMessageAt
            ? new Date(c.lastMessageAt).toISOString()
            : null,
          message_count: c?.messageCount ?? 0,
          reconnect_count: c?.reconnectCount ?? 0,
          connection_state: c?.connectionState ?? "NOT_STARTED",
          started_at: c?.startedAt ?? null,
          started_datetime: c?.startedAt
            ? new Date(c.startedAt).toISOString()
            : null,
          trigger_events: this.events,
          ws_tick_sl_shadow: {
            enabled: true,
            endpoint: "/shadow-status",
            levels_pct: [0.15,0.20,0.25,0.30,0.40],
            horizon_minutes: 30,
            detached_active_ledger_ids: [...this.shadowSockets.keys()],
          },
          websocket: HL_WS,
        };
      }

      private async persist(): Promise<void> {
        await Promise.all([
          this.ctx.storage.put("config", this.config),
          this.ctx.storage.put("events", this.events),
        ]);
      }

      private async closeSocket(reason: string): Promise<void> {
        const ws = this.ws;
        this.ws = null;
        if (!ws) return;
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, reason.slice(0, 100));
          }
        } catch {}
      }
    }
