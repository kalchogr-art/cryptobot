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
    const MODULE_VERSION = "V2.9.3 AUTO DRY-RUN CROSSING WS";

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
    ];

    const SHORT_C = [
      { trigger: 0.25, stop: 0.07 },
      { trigger: 0.35, stop: 0.15 },
      { trigger: 0.45, stop: 0.25 },
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
                   progressive_stop_oid, entry_filled_at, updated_at
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

      private async ledgerRowById(id: number | null): Promise<any | null> {
        if (!this.env?.DB || !Number.isInteger(id) || Number(id) <= 0) return null;
        try {
          return await this.env.DB.prepare(`
            SELECT id, crossing_id, coin, side, status, entry_fill_price, entry_fill_size,
                   progressive_stage, progressive_stop_pct, progressive_stop_price,
                   progressive_stop_oid, entry_filled_at, updated_at
            FROM hyperliquid_execution_ledger
            WHERE id=?
            LIMIT 1
          `).bind(id).first();
        } catch {
          return null;
        }
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
          this.onMessage(event.data).catch(() => {});
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

          this.events.push(event);
          if (this.events.length > 100) this.events = this.events.slice(-100);
          try { await this.persistTriggerEvent(event); }
          catch (e:any) { console.log("progressive_ws_events persist failed:", e?.message ?? String(e)); }
          this.config.stage += 1;
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
