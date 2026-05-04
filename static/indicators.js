const AnalysisIndicators = (() => {
  function movingAverage(candles, period = 20) {
    if (!Array.isArray(candles) || period < 2) return [];
    const result = [];
    let sum = 0;
    for (let i = 0; i < candles.length; i += 1) {
      const close = Number(candles[i]?.close);
      if (!Number.isFinite(close)) continue;
      sum += close;
      if (i >= period) sum -= Number(candles[i - period]?.close) || 0;
      if (i >= period - 1) result.push({ time: Number(candles[i].time), value: sum / period });
    }
    return result;
  }

  function rsi(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return [];
    const out = [];
    let gain = 0;
    let loss = 0;

    for (let i = 1; i <= period; i += 1) {
      const change = Number(candles[i].close) - Number(candles[i - 1].close);
      if (change >= 0) gain += change;
      else loss += Math.abs(change);
    }

    let avgGain = gain / period;
    let avgLoss = loss / period;
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push({ time: Number(candles[period].time), value: 100 - 100 / (1 + rs) });

    for (let i = period + 1; i < candles.length; i += 1) {
      const change = Number(candles[i].close) - Number(candles[i - 1].close);
      const up = change > 0 ? change : 0;
      const down = change < 0 ? Math.abs(change) : 0;
      avgGain = (avgGain * (period - 1) + up) / period;
      avgLoss = (avgLoss * (period - 1) + down) / period;
      rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out.push({ time: Number(candles[i].time), value: 100 - 100 / (1 + rs) });
    }
    return out;
  }

  return { movingAverage, rsi };
})();

window.AnalysisIndicators = AnalysisIndicators;
