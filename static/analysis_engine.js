const AnalysisEngine = (() => {
  const RECOMMENDATIONS = ["BUY OVER", "BUY UNDER", "BUY MATCH", "BUY DIFFER", "HOLD"];

  function fmt(v, d = 2) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(d) : "-";
  }

  function extractDigit(price) {
    const s = String(Number(price).toFixed(2));
    const ch = s.replace(".", "").slice(-1);
    const d = Number(ch);
    return Number.isFinite(d) ? d : null;
  }

  class DigitStats {
    constructor(windowSize = 500) {
      this.window = Math.max(50, windowSize);
      this.digits = [];
    }

    push(price) {
      const d = extractDigit(price);
      if (d === null) return;
      this.digits.push(d);
      if (this.digits.length > this.window) this.digits.shift();
    }

    bulk(prices) {
      this.digits = [];
      (prices || []).forEach((p) => this.push(p));
    }

    probabilities() {
      const counts = Array(10).fill(0);
      const n = this.digits.length || 1;
      this.digits.forEach((d) => {
        counts[d] += 1;
      });
      return counts.map((c) => c / n);
    }

    zScores() {
      const n = this.digits.length;
      if (n < 30) return Array(10).fill(0);
      const expected = n * 0.1;
      const std = Math.sqrt(Math.max(n * 0.1 * 0.9, 1e-9));
      const probs = this.probabilities();
      return probs.map((p) => (p * n - expected) / std);
    }

    mostUnderrepresented() {
      const zs = this.zScores();
      let best = 0;
      for (let i = 1; i < 10; i += 1) {
        if (zs[i] < zs[best]) best = i;
      }
      return { digit: best, z: zs[best] };
    }

    mostOverrepresented() {
      const zs = this.zScores();
      let best = 0;
      for (let i = 1; i < 10; i += 1) {
        if (zs[i] > zs[best]) best = i;
      }
      return { digit: best, z: zs[best] };
    }

    realizedVolatility(lookback = 120) {
      if (this.digits.length < 5) return 0;
      const vals = this.digits.slice(-Math.max(5, lookback));
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1);
      return Math.sqrt(variance);
    }

    regime() {
      const vol = this.realizedVolatility();
      if (vol > 3) return "Elevated";
      if (vol < 2.2) return "Low";
      return "Moderate";
    }
  }

  function computeTrend(candles, maData) {
    if (!candles?.length || !maData?.length) return { label: "Sideways", score: 50, direction: 0 };
    const last = candles[candles.length - 1];
    const ma = maData[maData.length - 1]?.value;
    const prevMa = maData[maData.length - 2]?.value;
    if (!Number.isFinite(ma) || !Number.isFinite(last?.close)) {
      return { label: "Sideways", score: 50, direction: 0 };
    }
    const above = last.close > ma;
    const rising = Number.isFinite(prevMa) ? ma >= prevMa : above;
    if (above && rising) return { label: "Uptrend", score: 78, direction: 1 };
    if (!above && !rising) return { label: "Downtrend", score: 78, direction: -1 };
    if (above) return { label: "Bullish bias", score: 62, direction: 0.5 };
    return { label: "Bearish bias", score: 62, direction: -0.5 };
  }

  function computeMomentum(candles, rsiData) {
    const rsi = rsiData?.[rsiData.length - 1]?.value;
    const prevRsi = rsiData?.[rsiData.length - 2]?.value;
    if (!Number.isFinite(rsi)) return { label: "Neutral", score: 50, rsi: null };
    const slope = Number.isFinite(prevRsi) ? rsi - prevRsi : 0;
    if (rsi >= 60 && slope > 0) return { label: "Strengthening", score: 75, rsi, slope };
    if (rsi <= 40 && slope < 0) return { label: "Weakening", score: 75, rsi, slope };
    if (rsi >= 55) return { label: "Bullish", score: 65, rsi, slope };
    if (rsi <= 45) return { label: "Bearish", score: 65, rsi, slope };
    return { label: "Neutral", score: 50, rsi, slope };
  }

  function computePriceVolatility(candles, lookback = 40) {
    if (!candles?.length) return { label: "Unknown", score: 50, pct: 0 };
    const slice = candles.slice(-lookback);
    const closes = slice.map((c) => Number(c.close)).filter(Number.isFinite);
    if (closes.length < 5) return { label: "Unknown", score: 50, pct: 0 };
    const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
    const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length;
    const std = Math.sqrt(variance);
    const pct = mean ? (std / mean) * 100 : 0;
    if (pct > 0.08) return { label: "High", score: 72, pct };
    if (pct > 0.03) return { label: "Moderate", score: 55, pct };
    return { label: "Low", score: 38, pct };
  }

  function moduleScore(label, aligned, weight) {
    return { label, aligned, weight, points: aligned ? weight : Math.round(weight * 0.35) };
  }

  function evaluateConfluence({ candles, maData, rsiData, digitStats, lastPrice }) {
    const trend = computeTrend(candles, maData);
    const momentum = computeMomentum(candles, rsiData);
    const volatility = computePriceVolatility(candles);
    const digitVol = digitStats?.regime?.() || "Moderate";
    const under = digitStats?.mostUnderrepresented?.() || { digit: 5, z: 0 };
    const over = digitStats?.mostOverrepresented?.() || { digit: 5, z: 0 };

    const ma = maData?.[maData.length - 1]?.value;
    const rsi = momentum.rsi;
    const priceAboveMa = Number.isFinite(ma) && Number.isFinite(lastPrice) && lastPrice > ma;

    const modules = [];
    let overScore = 0;
    let underScore = 0;
    let matchScore = 0;
    let differScore = 0;

    if (priceAboveMa) {
      modules.push(moduleScore("MA20", true, 18));
      overScore += 18;
    } else if (Number.isFinite(ma)) {
      modules.push(moduleScore("MA20", false, 18));
      underScore += 12;
    }

    if (Number.isFinite(rsi)) {
      if (rsi >= 52) {
        modules.push(moduleScore("RSI", rsi >= 55, 16));
        overScore += rsi >= 55 ? 16 : 6;
      } else if (rsi <= 48) {
        modules.push(moduleScore("RSI", rsi <= 45, 16));
        underScore += rsi <= 45 ? 16 : 6;
      } else {
        modules.push(moduleScore("RSI", false, 16));
      }
    }

    if (momentum.label === "Strengthening" || momentum.label === "Bullish") {
      modules.push(moduleScore("Momentum", true, 14));
      overScore += 14;
    } else if (momentum.label === "Weakening" || momentum.label === "Bearish") {
      modules.push(moduleScore("Momentum", true, 14));
      underScore += 14;
    } else {
      modules.push(moduleScore("Momentum", false, 14));
    }

    if (under.z < -1.2) {
      modules.push(moduleScore("Digit distribution", true, 16));
      matchScore += 16 + Math.min(8, Math.abs(under.z) * 3);
      overScore += under.digit >= 5 ? 8 : 0;
      underScore += under.digit < 5 ? 8 : 0;
    } else if (over.z > 1.2) {
      modules.push(moduleScore("Digit distribution", true, 16));
      differScore += 16 + Math.min(8, over.z * 3);
    } else {
      modules.push(moduleScore("Digit distribution", false, 16));
    }

    if (volatility.label === "Moderate") {
      modules.push(moduleScore("Volatility", true, 12));
      overScore += 6;
      underScore += 6;
    } else if (volatility.label === "Low") {
      modules.push(moduleScore("Volatility", true, 12));
      matchScore += 8;
    } else {
      modules.push(moduleScore("Volatility", false, 12));
    }

    const scores = {
      "BUY OVER": overScore,
      "BUY UNDER": underScore,
      "BUY MATCH": matchScore,
      "BUY DIFFER": differScore,
      HOLD: 28,
    };

    let recommendation = "HOLD";
    let top = scores.HOLD;
    RECOMMENDATIONS.forEach((key) => {
      if (scores[key] > top) {
        top = scores[key];
        recommendation = key;
      }
    });

    const alignedCount = modules.filter((m) => m.aligned).length;
    const rawConfidence = Math.min(100, Math.round(top + alignedCount * 4));
    const confluenceScore = Math.min(100, Math.round((overScore + underScore + matchScore + differScore) / 2.2 + alignedCount * 5));

    if (rawConfidence < 42 && recommendation !== "HOLD") {
      recommendation = "HOLD";
    }

    const signalLabel = recommendation === "HOLD" ? "HOLD" : recommendation.replace("BUY ", "");

    return {
      trend,
      momentum,
      volatility: { label: volatility.label, digitRegime: digitVol, score: volatility.score, pct: volatility.pct },
      confluenceScore,
      confidence: recommendation === "HOLD" ? Math.max(35, 100 - rawConfidence) : rawConfidence,
      recommendation,
      signalLabel,
      modules,
      underDigit: under,
      overDigit: over,
      priceAboveMa,
      ma,
      rsi,
    };
  }

  function generateInsight(result) {
    if (!result) return "Collecting market data…";
    const lines = [];
    const { trend, momentum, volatility, recommendation, confidence, underDigit, overDigit, priceAboveMa, ma, rsi } = result;

    if (Number.isFinite(ma)) {
      lines.push(priceAboveMa ? "Price is above MA20." : "Price is below MA20.");
    }
    if (momentum.label === "Strengthening") lines.push("Momentum is strengthening.");
    else if (momentum.label === "Weakening") lines.push("Momentum is weakening.");
    else if (momentum.label !== "Neutral") lines.push(`Momentum is ${momentum.label.toLowerCase()}.`);
    if (volatility.label !== "Unknown") lines.push(`Volatility is ${volatility.label.toLowerCase()}.`);
    if (underDigit.z < -1) lines.push(`Digit ${underDigit.digit} is underrepresented.`);
    if (overDigit.z > 1) lines.push(`Digit ${overDigit.digit} is overrepresented.`);
    if (Number.isFinite(rsi)) lines.push(`RSI(14) reads ${fmt(rsi, 1)}.`);

    const action = recommendation === "HOLD" ? "Wait for clearer confluence." : recommendation;
    return (
      `${lines.join(" ")}\n\nSuggested action:\n${action}.\n\nConfidence:\n${Math.round(confidence)}%.`
    );
  }

  function buildSignalMarkers(history, candles) {
    if (!Array.isArray(history) || !candles?.length) return [];
    const candleTimes = new Set(candles.map((c) => Number(c.time)));
    return history
      .filter((h) => candleTimes.has(Number(h.time)))
      .slice(-12)
      .map((h) => {
        const buy = String(h.signal || "").includes("OVER") || String(h.signal || "").includes("MATCH");
        const win = h.result === "WIN";
        const loss = h.result === "LOSS";
        return {
          time: Number(h.time),
          position: buy ? "belowBar" : "aboveBar",
          shape: buy ? "arrowUp" : "arrowDown",
          color: win ? "#18b663" : loss ? "#dc3f3f" : "#4d77d9",
          text: `${h.signal || "?"} ${h.confidence ? Math.round(h.confidence) + "%" : ""}`.trim(),
        };
      });
  }

  return {
    RECOMMENDATIONS,
    DigitStats,
    extractDigit,
    computeTrend,
    computeMomentum,
    computePriceVolatility,
    evaluateConfluence,
    generateInsight,
    buildSignalMarkers,
    fmt,
  };
})();

window.AnalysisEngine = AnalysisEngine;
