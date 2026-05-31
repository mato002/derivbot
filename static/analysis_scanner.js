const AnalysisScanner = (() => {
  const SCAN_SYMBOLS = [
    { symbol: "R_10", name: "Vol 10" },
    { symbol: "R_25", name: "Vol 25" },
    { symbol: "R_50", name: "Vol 50" },
    { symbol: "R_75", name: "Vol 75" },
    { symbol: "R_100", name: "Vol 100" },
  ];

  function fetchTickHistory(symbol, count = 320, appId = "1089") {
    return new Promise((resolve, reject) => {
      const url = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`;
      const ws = new WebSocket(url);
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch (_e) {
          // ignore
        }
        reject(new Error("Scanner timeout"));
      }, 12000);

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            ticks_history: symbol,
            adjust_start_time: 1,
            count,
            end: "latest",
            style: "ticks",
          }),
        );
      };

      ws.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (_e) {
          return;
        }
        if (payload?.error) {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            ws.close();
            reject(new Error(payload.error.message || "History error"));
          }
          return;
        }
        if (payload?.msg_type === "history" && Array.isArray(payload.history?.prices)) {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            ws.close();
            const times = payload.history.times || [];
            const prices = payload.history.prices || [];
            const ticks = prices.map((price, i) => ({
              time: Number(times[i] || 0),
              price: Number(price),
            }));
            resolve(ticks);
          }
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error("WebSocket error"));
        }
      };
    });
  }

  async function scanSymbol(row, deps) {
    const { Candles, Indicators, Engine } = deps;
    try {
      const ticks = await fetchTickHistory(row.symbol);
      const candles = Candles.rebuildFromTicks(ticks, "tick", 400);
      const maData = Indicators.movingAverage(candles, 20);
      const rsiData = Indicators.rsi(candles, 14);
      const digitStats = new Engine.DigitStats(400);
      ticks.forEach((t) => digitStats.push(t.price));
      const last = candles[candles.length - 1];
      const result = Engine.evaluateConfluence({
        candles,
        maData,
        rsiData,
        digitStats,
        lastPrice: last?.close,
      });
      return {
        symbol: row.symbol,
        name: row.name,
        last: last?.close,
        recommendation: result.recommendation,
        confidence: result.confidence,
        confluence: result.confluenceScore,
        trend: result.trend.label,
        ok: true,
      };
    } catch (err) {
      return {
        symbol: row.symbol,
        name: row.name,
        last: null,
        recommendation: "HOLD",
        confidence: 0,
        confluence: 0,
        trend: "-",
        ok: false,
        error: String(err?.message || err),
      };
    }
  }

  async function runScan(deps, onProgress) {
    const results = [];
    for (let i = 0; i < SCAN_SYMBOLS.length; i += 1) {
      const row = SCAN_SYMBOLS[i];
      onProgress?.({ phase: "scanning", symbol: row.symbol, index: i, total: SCAN_SYMBOLS.length });
      // eslint-disable-next-line no-await-in-loop
      const item = await scanSymbol(row, deps);
      results.push(item);
    }
    results.sort((a, b) => {
      if (a.recommendation === "HOLD" && b.recommendation !== "HOLD") return 1;
      if (b.recommendation === "HOLD" && a.recommendation !== "HOLD") return -1;
      return b.confidence - a.confidence;
    });
    onProgress?.({ phase: "done", results });
    return results;
  }

  return { SCAN_SYMBOLS, fetchTickHistory, runScan };
})();

window.AnalysisScanner = AnalysisScanner;
