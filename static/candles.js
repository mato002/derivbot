const AnalysisCandles = (() => {
  const TIMEFRAME_SECONDS = {
    tick: 0,
    "1s": 1,
    "5s": 5,
    "1m": 60,
    "5m": 300,
  };

  function timeframeToSeconds(timeframe) {
    return TIMEFRAME_SECONDS[timeframe] ?? 0;
  }

  function bucketStart(epochSec, timeframeSec) {
    if (!Number.isFinite(timeframeSec) || timeframeSec <= 0) return Math.floor(epochSec);
    return Math.floor(epochSec / timeframeSec) * timeframeSec;
  }

  function toTickCandle(tick) {
    const time = Number(tick?.time);
    const price = Number(tick?.price);
    return {
      time,
      open: price,
      high: price,
      low: price,
      close: price,
    };
  }

  function rebuildFromTicks(ticks, timeframe, maxCandles = 500) {
    const timeframeSec = timeframeToSeconds(timeframe);
    if (!Array.isArray(ticks) || !ticks.length) return [];

    if (timeframeSec <= 0) {
      return ticks.slice(-maxCandles).map((tick) => toTickCandle(tick));
    }

    const candles = [];
    let current = null;
    for (let i = 0; i < ticks.length; i += 1) {
      const epoch = Number(ticks[i]?.time);
      const price = Number(ticks[i]?.price);
      if (!Number.isFinite(epoch) || !Number.isFinite(price)) continue;
      const bucket = bucketStart(epoch, timeframeSec);
      if (!current || current.time !== bucket) {
        if (current) candles.push(current);
        current = { time: bucket, open: price, high: price, low: price, close: price };
      } else {
        current.high = Math.max(current.high, price);
        current.low = Math.min(current.low, price);
        current.close = price;
      }
    }
    if (current) candles.push(current);
    return candles.slice(-maxCandles);
  }

  function updateWithTick(candles, tick, timeframe, maxCandles = 500) {
    const timeframeSec = timeframeToSeconds(timeframe);
    const epoch = Number(tick?.time);
    const price = Number(tick?.price);
    if (!Number.isFinite(epoch) || !Number.isFinite(price)) {
      return { candles, changed: false, completedNewCandle: false };
    }

    if (!Array.isArray(candles)) candles = [];
    if (timeframeSec <= 0) {
      const next = candles.concat([{ time: epoch, open: price, high: price, low: price, close: price }]).slice(-maxCandles);
      return { candles: next, changed: true, completedNewCandle: true };
    }

    const bucket = bucketStart(epoch, timeframeSec);
    const out = candles.slice();
    const last = out[out.length - 1];
    if (!last || Number(last.time) !== bucket) {
      out.push({ time: bucket, open: price, high: price, low: price, close: price });
      if (out.length > maxCandles) out.splice(0, out.length - maxCandles);
      return { candles: out, changed: true, completedNewCandle: true };
    }

    const updated = {
      ...last,
      high: Math.max(Number(last.high), price),
      low: Math.min(Number(last.low), price),
      close: price,
    };
    out[out.length - 1] = updated;
    return { candles: out, changed: true, completedNewCandle: false };
  }

  return {
    TIMEFRAME_SECONDS,
    timeframeToSeconds,
    rebuildFromTicks,
    updateWithTick,
  };
})();

window.AnalysisCandles = AnalysisCandles;
