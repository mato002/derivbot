(function initAnalysisUiModule() {
  const Candles = window.AnalysisCandles;
  const Indicators = window.AnalysisIndicators;
  const WS = window.AnalysisWebSocket;
  const Chart = window.AnalysisChart;
  const Engine = window.AnalysisEngine;
  const Scanner = window.AnalysisScanner;
  if (!Candles || !Indicators || !WS || !Chart || !Engine || typeof LightweightCharts === "undefined") return;

  const HISTORY_KEY = "analysis_v2_signal_history";
  const SIGNAL_COOLDOWN_MS = 45000;

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

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_e) {
      return [];
    }
  }

  function saveHistory(rows) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(-80)));
    } catch (_e) {
      // ignore
    }
  }

  function formatTime(epoch) {
    const d = new Date(Number(epoch) * 1000);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function recClass(rec) {
    const key = String(rec || "HOLD").toUpperCase();
    if (key.includes("OVER")) return "analysis-v2-rec--over";
    if (key.includes("UNDER")) return "analysis-v2-rec--under";
    if (key.includes("MATCH")) return "analysis-v2-rec--match";
    if (key.includes("DIFFER")) return "analysis-v2-rec--differ";
    return "analysis-v2-rec--hold";
  }

  class AnalysisChartApp {
    constructor() {
      this.symbolEl = document.getElementById("analysisSymbol");
      this.timeframeEl = document.getElementById("analysisTimeframe");
      this.priceEl = document.getElementById("priceChart");
      this.rsiEl = document.getElementById("rsiChart");
      this.statsEl = document.getElementById("analysisStats");
      this.marketPickerToggleEl = document.getElementById("analysisMarketPickerToggle");
      this.marketPickerCloseEl = document.getElementById("analysisMarketPickerClose");
      this.marketPickerOverlayEl = document.getElementById("analysisMarketPickerOverlay");
      this.marketPickerCategoriesEl = document.getElementById("analysisMarketPickerCategories");
      this.marketPickerListEl = document.getElementById("analysisMarketPickerList");
      this.marketSearchEl = document.getElementById("analysisMarketSearchInput");
      this.currentSymbolLabelEl = document.getElementById("analysisCurrentSymbol");
      this.headerMarketEl = document.getElementById("analysisV2Market");
      this.headerAccountEl = document.getElementById("analysisV2Account");
      this.headerConnectionEl = document.getElementById("analysisV2Connection");
      this.headerPriceEl = document.getElementById("analysisV2LastPrice");
      this.cardTrendEl = document.getElementById("analysisCardTrend");
      this.cardMomentumEl = document.getElementById("analysisCardMomentum");
      this.cardVolatilityEl = document.getElementById("analysisCardVolatility");
      this.cardSignalEl = document.getElementById("analysisCardSignal");
      this.cardConfidenceEl = document.getElementById("analysisCardConfidence");
      this.confluenceScoreEl = document.getElementById("analysisConfluenceScore");
      this.confluenceRingEl = document.getElementById("analysisConfluenceRing");
      this.confluenceBreakdownEl = document.getElementById("analysisConfluenceBreakdown");
      this.recommendationEl = document.getElementById("analysisRecommendation");
      this.recommendationConfEl = document.getElementById("analysisRecommendationConfidence");
      this.aiInsightEl = document.getElementById("analysisAiInsight");
      this.scannerBodyEl = document.getElementById("analysisScannerBody");
      this.scannerRefreshEl = document.getElementById("analysisScannerRefresh");
      this.historyBodyEl = document.getElementById("analysisSignalHistoryBody");
      this.historyCountEl = document.getElementById("analysisHistoryCount");
      this.activeCategory = "Continuous Indices";
      this.maxCandles = 500;
      this.maxTicks = 6000;
      this.tickBuffer = [];
      this.candles = [];
      this.timeframe = "tick";
      this.symbol = "R_100";
      this.chart = null;
      this.ws = null;
      this.digitStats = new Engine.DigitStats(500);
      this.signalHistory = loadHistory();
      this.lastAnalysis = null;
      this.lastSignalKey = "";
      this.lastSignalAt = 0;
      this.pendingSignal = null;
      this.scannerRunning = false;
    }

    mount() {
      if (!this.priceEl || !this.rsiEl) return;
      this.setupMarketPicker();
      this.chart = Chart.create({ priceEl: this.priceEl, rsiEl: this.rsiEl });
      this.bind();
      this.connect();
      this.renderHistory();
      this.chart.resize();
      window.addEventListener("resize", () => this.chart.resize());
      this.scannerRefreshEl?.addEventListener("click", () => this.runScanner());
      window.setTimeout(() => this.runScanner(), 2500);
      window.setInterval(() => this.runScanner(), 120000);
      this.syncAccountFromDom();
      window.setInterval(() => this.syncAccountFromDom(), 5000);
    }

    syncAccountFromDom() {
      const auth = document.getElementById("authAccount");
      if (this.headerAccountEl && auth?.textContent) {
        this.headerAccountEl.textContent = auth.textContent.trim() || "Not logged in";
      }
      const market = this.currentSymbolLabelEl?.textContent || this.symbol;
      if (this.headerMarketEl) this.headerMarketEl.textContent = market;
    }

    setupMarketPicker() {
      if (!this.symbolEl) return;
      this.symbolEl.innerHTML = ANALYSIS_MARKETS.map((m) => `<option value="${m.symbol}">${m.name}</option>`).join("");
      if (!ANALYSIS_MARKETS.some((m) => m.symbol === this.symbolEl.value)) {
        this.symbolEl.value = "R_100";
      }
      this.syncCurrentSymbolLabel(this.symbolEl.value);

      if (!this.marketPickerOverlayEl || !this.marketPickerCategoriesEl || !this.marketPickerListEl) return;

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
      const label = row?.name || symbol || "-";
      if (this.currentSymbolLabelEl) this.currentSymbolLabelEl.textContent = label;
      if (this.headerMarketEl) this.headerMarketEl.textContent = label;
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
        this.digitStats = new Engine.DigitStats(500);
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
      if (!this.headerConnectionEl) return;
      const map = {
        connecting: { text: "Connecting", cls: "analysis-v2-pill--offline" },
        connected: { text: "Live", cls: "analysis-v2-pill--live" },
        disconnected: { text: "Reconnecting", cls: "analysis-v2-pill--warn" },
        error: { text: "Issue", cls: "analysis-v2-pill--warn" },
      };
      const row = map[status] || { text: status, cls: "analysis-v2-pill--offline" };
      this.headerConnectionEl.textContent = row.text;
      this.headerConnectionEl.className = `analysis-v2-pill ${row.cls}`;
    }

    onTick(tick) {
      if (!Number.isFinite(tick?.time) || !Number.isFinite(tick?.price)) return;
      this.tickBuffer.push(tick);
      if (this.tickBuffer.length > this.maxTicks) this.tickBuffer = this.tickBuffer.slice(-this.maxTicks);
      this.digitStats.push(tick.price);
      const { candles } = Candles.updateWithTick(this.candles, tick, this.timeframe, this.maxCandles);
      this.candles = candles;
      this.resolvePendingSignal(tick);
      this.incrementalRender();
    }

    resolvePendingSignal(tick) {
      if (!this.pendingSignal) return;
      const elapsed = Number(tick.time) - Number(this.pendingSignal.time);
      if (elapsed < 1) return;
      const digit = Engine.extractDigit(tick.price);
      if (digit === null) return;
      const sig = this.pendingSignal.signal;
      let result = "OPEN";
      if (sig.includes("OVER")) result = digit > this.pendingSignal.barrier ? "WIN" : "LOSS";
      else if (sig.includes("UNDER")) result = digit < this.pendingSignal.barrier ? "WIN" : "LOSS";
      else if (sig.includes("MATCH")) result = digit === this.pendingSignal.barrier ? "WIN" : "LOSS";
      else if (sig.includes("DIFFER")) result = digit !== this.pendingSignal.barrier ? "WIN" : "LOSS";
      else result = "—";

      const idx = this.signalHistory.findIndex((h) => h.id === this.pendingSignal.id);
      if (idx >= 0) {
        this.signalHistory[idx].result = result;
        this.signalHistory[idx].resolvedAt = tick.time;
        saveHistory(this.signalHistory);
        this.renderHistory();
        const markers = Engine.buildSignalMarkers(this.signalHistory, this.candles);
        this.chart.candles.setMarkers(markers);
      }
      this.pendingSignal = null;
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
      if (this.candles.length % 25 === 0) {
        const markers = Engine.buildSignalMarkers(this.signalHistory, this.candles);
        this.chart.candles.setMarkers(markers);
      }
      this.renderAnalysis(maData, rsiData);
    }

    fullRender() {
      const maData = Indicators.movingAverage(this.candles, 20);
      const rsiData = Indicators.rsi(this.candles, 14);
      const markers = Engine.buildSignalMarkers(this.signalHistory, this.candles);
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
        markers,
      });
      this.chart.fit();
      this.renderAnalysis(maData, rsiData);
    }

    renderAnalysis(maData, rsiData) {
      const last = this.candles[this.candles.length - 1];
      const ma = maData[maData.length - 1]?.value;
      const rsi = rsiData[rsiData.length - 1]?.value;
      const result = Engine.evaluateConfluence({
        candles: this.candles,
        maData,
        rsiData,
        digitStats: this.digitStats,
        lastPrice: last?.close,
      });
      this.lastAnalysis = result;

      if (this.headerPriceEl) this.headerPriceEl.textContent = Engine.fmt(last?.close);
      if (this.statsEl) {
        this.statsEl.innerHTML = `RSI(14) <strong>${Engine.fmt(rsi)}</strong> · MA(20) <strong>${Engine.fmt(ma)}</strong>`;
      }

      if (this.cardTrendEl) this.cardTrendEl.textContent = result.trend.label;
      if (this.cardMomentumEl) this.cardMomentumEl.textContent = result.momentum.label;
      if (this.cardVolatilityEl) {
        this.cardVolatilityEl.textContent = `${result.volatility.label} / ${result.volatility.digitRegime}`;
      }
      if (this.cardSignalEl) {
        this.cardSignalEl.textContent = result.recommendation;
        this.cardSignalEl.className = `analysis-v2-card__value analysis-v2-card__value--signal ${recClass(result.recommendation)}`;
      }
      if (this.cardConfidenceEl) this.cardConfidenceEl.textContent = `${Math.round(result.confidence)}%`;

      if (this.confluenceScoreEl) this.confluenceScoreEl.textContent = String(result.confluenceScore);
      if (this.confluenceRingEl) {
        const circumference = 2 * Math.PI * 52;
        const offset = circumference - (result.confluenceScore / 100) * circumference;
        this.confluenceRingEl.style.strokeDasharray = `${circumference}`;
        this.confluenceRingEl.style.strokeDashoffset = String(offset);
      }
      if (this.confluenceBreakdownEl) {
        this.confluenceBreakdownEl.innerHTML = result.modules
          .map(
            (m) =>
              `<li class="${m.aligned ? "is-aligned" : ""}"><span>${m.label}</span><span>${m.points}/${m.weight}</span></li>`,
          )
          .join("");
      }

      if (this.recommendationEl) {
        this.recommendationEl.textContent = result.recommendation;
        this.recommendationEl.className = `analysis-v2-rec ${recClass(result.recommendation)}`;
      }
      if (this.recommendationConfEl) {
        this.recommendationConfEl.textContent = `${Math.round(result.confidence)}%`;
      }
      if (this.aiInsightEl) {
        this.aiInsightEl.textContent = Engine.generateInsight(result);
      }

      this.maybeRecordSignal(result, last);
    }

    maybeRecordSignal(result, lastCandle) {
      if (!lastCandle || result.recommendation === "HOLD") return;
      const key = `${result.recommendation}:${Math.round(result.confidence / 5)}`;
      const now = Date.now();
      if (key === this.lastSignalKey && now - this.lastSignalAt < SIGNAL_COOLDOWN_MS) return;
      if (result.confidence < 55) return;

      this.lastSignalKey = key;
      this.lastSignalAt = now;
      const barrier =
        result.recommendation.includes("MATCH") || result.recommendation.includes("DIFFER")
          ? result.underDigit.digit
          : 5;
      const entry = {
        id: `${lastCandle.time}-${result.recommendation}`,
        time: lastCandle.time,
        signal: result.recommendation,
        confidence: result.confidence,
        result: "PENDING",
        barrier,
        symbol: this.symbol,
      };
      this.signalHistory.push(entry);
      saveHistory(this.signalHistory);
      this.pendingSignal = entry;
      this.renderHistory();
      const markers = Engine.buildSignalMarkers(this.signalHistory, this.candles);
      this.chart.candles.setMarkers(markers);
    }

    renderHistory() {
      if (!this.historyBodyEl) return;
      const rows = this.signalHistory.slice().reverse().slice(0, 24);
      if (this.historyCountEl) {
        this.historyCountEl.textContent = `${this.signalHistory.length} entries`;
      }
      if (!rows.length) {
        this.historyBodyEl.innerHTML = `<tr><td colspan="4" class="subtle">Signals appear when confluence shifts</td></tr>`;
        return;
      }
      this.historyBodyEl.innerHTML = rows
        .map((r) => {
          const resCls =
            r.result === "WIN" ? "is-win" : r.result === "LOSS" ? "is-loss" : r.result === "PENDING" ? "is-pending" : "";
          return `<tr>
            <td>${formatTime(r.time)}</td>
            <td>${r.signal || "-"}</td>
            <td>${Math.round(r.confidence || 0)}%</td>
            <td class="${resCls}">${r.result || "—"}</td>
          </tr>`;
        })
        .join("");
    }

    async runScanner() {
      if (this.scannerRunning || !Scanner) return;
      this.scannerRunning = true;
      if (this.scannerRefreshEl) {
        this.scannerRefreshEl.disabled = true;
        this.scannerRefreshEl.textContent = "Scanning…";
      }
      if (this.scannerBodyEl) {
        this.scannerBodyEl.innerHTML = `<tr><td colspan="6" class="subtle">Scanning volatility indices…</td></tr>`;
      }
      try {
        const results = await Scanner.runScan({
          Candles,
          Indicators,
          Engine,
        });
        if (this.scannerBodyEl) {
          this.scannerBodyEl.innerHTML = results
            .map((r, i) => {
              const highlight = i === 0 && r.recommendation !== "HOLD" ? " analysis-v2-row--best" : "";
              return `<tr class="${highlight}">
                <td><strong>${r.name}</strong><span class="subtle small"> ${r.symbol}</span></td>
                <td>${Engine.fmt(r.last)}</td>
                <td>${r.trend}</td>
                <td class="${recClass(r.recommendation)}">${r.recommendation}</td>
                <td>${Math.round(r.confidence)}%</td>
                <td>${r.confluence}</td>
              </tr>`;
            })
            .join("");
        }
      } catch (_e) {
        if (this.scannerBodyEl) {
          this.scannerBodyEl.innerHTML = `<tr><td colspan="6" class="subtle">Scanner unavailable</td></tr>`;
        }
      } finally {
        this.scannerRunning = false;
        if (this.scannerRefreshEl) {
          this.scannerRefreshEl.disabled = false;
          this.scannerRefreshEl.textContent = "Scan";
        }
      }
    }
  }

  window.AnalysisChartApp = AnalysisChartApp;
})();
