    // ============================================================
    // CRYPTOBOT V2.9 — PROGRESSIVE WEBSOCKET MONITOR (DRY RUN ONLY)
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
    const MODULE_VERSION = "V2.9 PROGRESSIVE WS DRY RUN";

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
      action: "DRY_RUN_MODIFY_SL";
      exchangeRequestSent: false;
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

          const coin = String(body?.coin ?? "").trim().toUpperCase();
          const side = String(body?.side ?? "").trim().toUpperCase() as Side;
          const explicitEntry = finitePositive(body?.entryPrice ?? body?.entry);

          if (!coin) return json({ success: false, error: "COIN_REQUIRED" }, 400);
          if (side !== "LONG" && side !== "SHORT") {
            return json({ success: false, error: "SIDE_MUST_BE_LONG_OR_SHORT" }, 400);
          }

          await this.closeSocket("RESTART");

          this.config = {
            active: true,
            coin,
            side,
            entryPrice: explicitEntry,
            entrySource: explicitEntry ? "EXPLICIT" : "FIRST_WS_MARK",
            startedAt: Date.now(),
            stage: 0,
            maxDirectionalReturnPct: 0,
            lastPrice: null,
            lastMessageAt: null,
            messageCount: 0,
            reconnectCount: 0,
            connectionState: "CONNECTING",
          };
          this.events = [];

          await this.persist();
          await this.connect();

          return json({
            success: true,
            module: MODULE_VERSION,
            mode: "DRY_RUN_READ_ONLY",
            message: explicitEntry
              ? "MONITOR_STARTED_WITH_EXPLICIT_ENTRY"
              : "MONITOR_STARTED_ENTRY_WILL_BE_FIRST_WS_MARK",
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

        // If one WS update jumps across multiple thresholds, record all newly reached
        // stages in order. The final stage is the tightest intended protection.
        while (
          this.config.stage < steps.length &&
          ret >= steps[this.config.stage].trigger
        ) {
          const step = steps[this.config.stage];
          const event: TriggerEvent = {
            stage: this.config.stage + 1,
            coin: this.config.coin,
            side: this.config.side,
            triggerPct: step.trigger,
            targetStopPct: step.stop,
            entryPrice: this.config.entryPrice,
            observedPrice: price,
            directionalReturnPct: ret,
            detectedAt: now,
            detectedDatetime: new Date(now).toISOString(),
            action: "DRY_RUN_MODIFY_SL",
            exchangeRequestSent: false,
          };

          this.events.push(event);
          if (this.events.length > 100) this.events = this.events.slice(-100);
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
