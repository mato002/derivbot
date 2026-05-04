class DerivWebSocketClient {
  constructor({
    appId = "1089",
    symbol = "R_100",
    onTick = () => {},
    onStatus = () => {},
    reconnectMs = 1400,
  } = {}) {
    this.appId = appId;
    this.symbol = symbol;
    this.onTick = onTick;
    this.onStatus = onStatus;
    this.reconnectMs = reconnectMs;
    this.ws = null;
    this.subscriptionId = null;
    this.manualClose = false;
    this.reconnectTimer = null;
    this.url = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(this.appId)}`;
  }

  connect() {
    this.manualClose = false;
    this.clearReconnect();
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.onStatus("connecting");
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.onStatus("connected");
      this.subscribeTicks(this.symbol);
    };
    this.ws.onmessage = (event) => this.handleMessage(event.data);
    this.ws.onerror = () => this.onStatus("error");
    this.ws.onclose = () => {
      this.subscriptionId = null;
      this.onStatus("disconnected");
      if (!this.manualClose) this.reconnectTimer = window.setTimeout(() => this.connect(), this.reconnectMs);
    };
  }

  subscribeTicks(symbol) {
    this.symbol = symbol || this.symbol;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ ticks: this.symbol, subscribe: 1 }));
  }

  unsubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.subscriptionId) return;
    this.ws.send(JSON.stringify({ forget: this.subscriptionId }));
  }

  setSymbol(symbol) {
    const next = String(symbol || "").trim() || "R_100";
    if (next === this.symbol) return;
    this.symbol = next;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
      return;
    }
    this.unsubscribe();
    this.subscribeTicks(this.symbol);
  }

  disconnect() {
    this.manualClose = true;
    this.clearReconnect();
    try {
      this.unsubscribe();
    } catch (_e) {
      // ignore
    }
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  handleMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_e) {
      return;
    }
    if (payload?.error) {
      this.onStatus("error");
      return;
    }
    if (payload?.msg_type === "tick" && payload?.tick) {
      this.subscriptionId = payload?.subscription?.id || this.subscriptionId;
      this.onTick({
        time: Number(payload.tick.epoch),
        price: Number(payload.tick.quote),
        symbol: payload.tick.symbol,
      });
    }
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

window.AnalysisWebSocket = { DerivWebSocketClient };
