(function initAnalysisUiModule() {
  const Candles = window.AnalysisCandles;
  const Indicators = window.AnalysisIndicators;
  const WS = window.AnalysisWebSocket;
  const Chart = window.AnalysisChart;
  if (!Candles || !Indicators || !WS || !Chart || typeof LightweightCharts === "undefined") return;

  function fmt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : "-";
  }

  function mockMarkers(candles) {
    if (!Array.isArray(candles) || candles.length < 24) return [];
    const out = [];
    const step = Math.max(16, Math.floor(candles.length / 7));
    for (let i = step; i < candles.length; i += step) {
      const c = candles[i];
      const buy = i % (step * 2) === 0;
      const win = i % 3 !== 0;
      out.push({
        time: Number(c.time),
        position: buy ? "belowBar" : "aboveBar",
        shape: buy ? "arrowUp" : "arrowDown",
        color: buy ? "#18b663" : "#dc3f3f",
        text: `${buy ? "BUY" : "SELL"} ${win ? "WIN" : "LOSS"} @ ${fmt(c.close)}`,
      });
    }
    return out;
  }

  const ANALYSIS_MARKETS = [
    { category: "Continuous Indices", name: "Volatility 10 Index", symbol: "R_10" },
    { category: "Continuous Indices", name: "Volatility 25 Index", symbol: "R_25" },
    { category: "Continuous Indices", name: "Volatility 50 Index", symbol: "R_50" },
    { category: "Continuous Indices", name: "Volatility 75 Index", symbol: "R_75" },
    { category: "Continuous Indices", name: "Volatility 100 Index", symbol: "R_100" },
    { category: "Continuous Indices", name: "Volatility 10 (1s) Index", symbol: "1HZ10V" },
    { category: "Continuous Indices", name: "Volatility 25 (1s) Index", symbol: "1HZ25V" },
    { category: "Continuous Indices", name: "Volatility 50 (1s) Index", symbol: "1HZ50V" },
    { category: "Continuous Indices", name: "Volatility 75 (1s) Index", symbol: "1HZ75V" },
    { category: "Continuous Indices", name: "Volatility 100 (1s) Index", symbol: "1HZ100V" },
    { category: "Continuous Indices", name: "Jump 10 Index", symbol: "JD10" },
    { category: "Continuous Indices", name: "Jump 25 Index", symbol: "JD25" },
    { category: "Continuous Indices", name: "Jump 50 Index", symbol: "JD50" },
    { category: "Continuous Indices", name: "Jump 75 Index", symbol: "JD75" },
    { category: "Continuous Indices", name: "Jump 100 Index", symbol: "JD100" },
    { category: "Continuous Indices", name: "Boom 300 Index", symbol: "BOOM300N" },
    { category: "Continuous Indices", name: "Boom 500 Index", symbol: "BOOM500" },
    { category: "Continuous Indices", name: "Boom 600 Index", symbol: "BOOM600N" },
    { category: "Continuous Indices", name: "Boom 900 Index", symbol: "BOOM900N" },
    { category: "Continuous Indices", name: "Boom 1000 Index", symbol: "BOOM1000" },
    { category: "Continuous Indices", name: "Crash 300 Index", symbol: "CRASH300N" },
    { category: "Continuous Indices", name: "Crash 500 Index", symbol: "CRASH500" },
    { category: "Continuous Indices", name: "Crash 600 Index", symbol: "CRASH600N" },
    { category: "Continuous Indices", name: "Crash 900 Index", symbol: "CRASH900N" },
    { category: "Continuous Indices", name: "Crash 1000 Index", symbol: "CRASH1000" },
    { category: "Continuous Indices", name: "Range Break 100", symbol: "RDBULL" },
    { category: "Continuous Indices", name: "Range Break 200", symbol: "RDBEAR" },
    { category: "Continuous Indices", name: "Step Index", symbol: "STPRNG" },
    { category: "Continuous Indices", name: "Drift Switch 10", symbol: "DSI10" },
    { category: "Continuous Indices", name: "Drift Switch 20", symbol: "DSI20" },
    { category: "Continuous Indices", name: "Drift Switch 30", symbol: "DSI30" },
  ];

  const ANALYSIS_CATEGORIES = ["Continuous Indices"];

  class AnalysisChartApp {
    constructor() {
      this.symbolEl = document.getElementById("analysisSymbol");
      this.timeframeEl = document.getElementById("analysisTimeframe");
      this.priceEl = document.getElementById("priceChart");
      this.rsiEl = document.getElementById("rsiChart");
      this.statsEl = document.getElementById("analysisStats");
      this.signalValueEl = document.getElementById("signalValue");
      this.signalReasonEl = document.getElementById("signalReason");
      this.signalTrendEl = document.getElementById("signalTrend");
      this.signalStreamEl = document.getElementById("signalStream");
      this.marketPickerToggleEl = document.getElementById("analysisMarketPickerToggle");
      this.marketPickerCloseEl = document.getElementById("analysisMarketPickerClose");
      this.marketPickerOverlayEl = document.getElementById("analysisMarketPickerOverlay");
      this.marketPickerCategoriesEl = document.getElementById("analysisMarketPickerCategories");
      this.marketPickerListEl = document.getElementById("analysisMarketPickerList");
      this.marketSearchEl = document.getElementById("analysisMarketSearchInput");
      this.currentSymbolLabelEl = document.getElementById("analysisCurrentSymbol");
      this.activeCategory = "Continuous Indices";
      this.maxCandles = 500;
      this.maxTicks = 6000;
      this.tickBuffer = [];
      this.candles = [];
      this.timeframe = "tick";
      this.symbol = "R_100";
      this.chart = null;
      this.ws = null;
      this.markerSet = [];
    }

    mount() {
      if (!this.priceEl || !this.rsiEl) return;
      this.setupMarketPicker();
      this.chart = Chart.create({ priceEl: this.priceEl, rsiEl: this.rsiEl });
      this.bind();
      this.connect();
      this.chart.resize();
      window.addEventListener("resize", () => this.chart.resize());
    }

    setupMarketPicker() {
      if (!this.symbolEl) return;
      this.symbolEl.innerHTML = ANALYSIS_MARKETS.map((m) => `<option value="${m.symbol}">${m.name}</option>`).join("");
      if (!ANALYSIS_MARKETS.some((m) => m.symbol === this.symbolEl.value)) {
        this.symbolEl.value = "R_100";
      }
      this.syncCurrentSymbolLabel(this.symbolEl.value);

      if (
        !this.marketPickerOverlayEl ||
        !this.marketPickerCategoriesEl ||
        !this.marketPickerListEl
      ) return;

      this.renderCategoryList();
      this.renderMarketList();

      this.marketPickerToggleEl?.addEventListener("click", () => {
        this.marketPickerOverlayEl.classList.toggle("hidden");
        this.marketPickerCloseEl?.classList.toggle("hidden", this.marketPickerOverlayEl.classList.contains("hidden"));
      });
      this.marketPickerCloseEl?.addEventListener("click", () => {
        this.marketPickerOverlayEl.classList.add("hidden");
        this.marketPickerCloseEl?.classList.add("hidden");
      });
      this.marketSearchEl?.addEventListener("input", () => this.renderMarketList());
    }

    syncCurrentSymbolLabel(symbol) {
      const row = ANALYSIS_MARKETS.find((m) => m.symbol === symbol);
      if (this.currentSymbolLabelEl) this.currentSymbolLabelEl.textContent = row?.name || symbol || "-";
    }

    renderCategoryList() {
      if (!this.marketPickerCategoriesEl) return;
      this.marketPickerCategoriesEl.innerHTML = "";
      ANALYSIS_CATEGORIES.forEach((cat) => {
        const row = document.createElement("div");
        row.className = `market-picker-cat ${cat === this.activeCategory ? "market-picker-cat--active" : ""}`;
        row.textContent = cat;
        row.addEventListener("click", () => {
          this.activeCategory = cat;
          this.renderCategoryList();
          this.renderMarketList();
        });
        this.marketPickerCategoriesEl.appendChild(row);
      });
    }

    renderMarketList() {
      if (!this.marketPickerListEl) return;
      const q = String(this.marketSearchEl?.value || "").trim().toLowerCase();
      this.marketPickerListEl.innerHTML = "";
      const rows = ANALYSIS_MARKETS.filter((m) => m.category === this.activeCategory).filter(
        (m) => !q || m.name.toLowerCase().includes(q),
      );
      rows.forEach((m) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `market-picker-item ${m.symbol === this.symbol ? "market-picker-item--active" : ""}`;
        btn.innerHTML = `<span>${m.name}</span><span>☆</span>`;
        btn.addEventListener("click", () => {
          this.symbolEl.value = m.symbol;
          this.symbolEl.dispatchEvent(new Event("change"));
          this.marketPickerOverlayEl?.classList.add("hidden");
          this.marketPickerCloseEl?.classList.add("hidden");
        });
        this.marketPickerListEl.appendChild(btn);
      });
    }

    bind() {
      this.symbolEl?.addEventListener("change", () => {
        this.symbol = this.symbolEl.value || "R_100";
        this.syncCurrentSymbolLabel(this.symbol);
        this.tickBuffer = [];
        this.candles = [];
        this.markerSet = [];
        this.chart.setData({ candlesData: [], maData: [], rsiData: [], markers: [] });
        this.ws?.setSymbol(this.symbol);
        this.renderMarketList();
      });

      this.timeframeEl?.addEventListener("change", () => {
        this.timeframe = this.timeframeEl.value || "tick";
        this.candles = Candles.rebuildFromTicks(this.tickBuffer, this.timeframe, this.maxCandles);
        this.fullRender();
      });
    }

    connect() {
      this.symbol = this.symbolEl?.value || "R_100";
      this.timeframe = this.timeframeEl?.value || "tick";
      this.ws = new WS.DerivWebSocketClient({
        appId: "1089",
        symbol: this.symbol,
        onTick: (tick) => this.onTick(tick),
        onStatus: (status) => this.onStatus(status),
      });
      this.ws.connect();
    }

    onStatus(status) {
      if (!this.signalStreamEl) return;
      const map = {
        connecting: "Connecting...",
        connected: "Live",
        disconnected: "Reconnecting...",
        error: "Connection issue",
      };
      this.signalStreamEl.textContent = map[status] || status;
    }

    onTick(tick) {
      if (!Number.isFinite(tick?.time) || !Number.isFinite(tick?.price)) return;
      this.tickBuffer.push(tick);
      if (this.tickBuffer.length > this.maxTicks) this.tickBuffer = this.tickBuffer.slice(-this.maxTicks);
      const { candles } = Candles.updateWithTick(this.candles, tick, this.timeframe, this.maxCandles);
      this.candles = candles;
      this.incrementalRender();
    }

    incrementalRender() {
      if (!this.candles.length) return;
      const maData = Indicators.movingAverage(this.candles, 20);
      const rsiData = Indicators.rsi(this.candles, 14);
      const last = this.candles[this.candles.length - 1];
      this.chart.updateLast({
        candle: {
          time: Number(last.time),
          open: Number(last.open),
          high: Number(last.high),
          low: Number(last.low),
          close: Number(last.close),
        },
        maPoint: maData[maData.length - 1] || null,
        rsiPoint: rsiData[rsiData.length - 1] || null,
      });
      if (this.candles.length % 20 === 0 || !this.markerSet.length) {
        this.markerSet = mockMarkers(this.candles);
        this.chart.candles.setMarkers(this.markerSet);
      }
      this.renderStatsAndSignal(maData, rsiData);
    }

    fullRender() {
      const maData = Indicators.movingAverage(this.candles, 20);
      const rsiData = Indicators.rsi(this.candles, 14);
      this.markerSet = mockMarkers(this.candles);
      this.chart.setData({
        candlesData: this.candles.map((c) => ({
          time: Number(c.time),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
        })),
        maData,
        rsiData,
        markers: this.markerSet,
      });
      this.chart.fit();
      this.renderStatsAndSignal(maData, rsiData);
    }

    renderStatsAndSignal(maData, rsiData) {
      const last = this.candles[this.candles.length - 1];
      const ma = maData[maData.length - 1]?.value;
      const rsi = rsiData[rsiData.length - 1]?.value;
      if (this.statsEl) {
        this.statsEl.innerHTML = `Last: <strong>${fmt(last?.close)}</strong> &nbsp; RSI(14): <strong>${fmt(rsi)}</strong> &nbsp; MA(20): <strong>${fmt(ma)}</strong>`;
      }

      let signal = "HOLD";
      let reason = "No active confluence";
      let trend = "Sideways";
      const prevMa = maData[maData.length - 2]?.value;
      if (Number.isFinite(ma) && Number.isFinite(prevMa)) trend = ma >= prevMa ? "Uptrend" : "Downtrend";
      if (Number.isFinite(rsi) && Number.isFinite(ma) && Number.isFinite(last?.close)) {
        if (rsi < 30 && last.close < ma) {
          signal = "BUY";
          reason = "RSI < 30 AND price below MA";
        } else if (rsi > 70 && last.close > ma) {
          signal = "SELL";
          reason = "RSI > 70 AND price above MA";
        }
      }
      if (this.signalValueEl) this.signalValueEl.textContent = signal;
      if (this.signalReasonEl) this.signalReasonEl.textContent = reason;
      if (this.signalTrendEl) this.signalTrendEl.textContent = trend;
    }
  }

  window.AnalysisChartApp = AnalysisChartApp;
})();
