/** Session trade analytics dashboard (display-only). */
(function () {
  function settledRows(history) {
    return (history || [])
      .filter((h) => {
        const r = String(h.result || "").toLowerCase();
        return r === "win" || r === "loss";
      })
      .slice()
      .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  }

  function computeStreaks(rows) {
    let longestWin = 0;
    let longestLoss = 0;
    let curWin = 0;
    let curLoss = 0;
    rows.forEach((row) => {
      const r = String(row.result || "").toLowerCase();
      if (r === "win") {
        curWin += 1;
        curLoss = 0;
        longestWin = Math.max(longestWin, curWin);
      } else if (r === "loss") {
        curLoss += 1;
        curWin = 0;
        longestLoss = Math.max(longestLoss, curLoss);
      }
    });
    return { longestWin, longestLoss };
  }

  function computeFromHistory(history, status) {
    const rows = settledRows(history);
    const wins = rows.filter((h) => String(h.result || "").toLowerCase() === "win");
    const losses = rows.filter((h) => String(h.result || "").toLowerCase() === "loss");
    const grossWin = wins.reduce((s, h) => s + Math.max(0, Number(h.profit ?? 0)), 0);
    const grossLoss = losses.reduce((s, h) => s + Math.abs(Math.min(0, Number(h.profit ?? 0))), 0);
    const winRate = rows.length ? (wins.length / rows.length) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const streaks = computeStreaks(rows);

    const sessionProfit = Number(status?.profit ?? 0);
    const balance = Number(status?.balance ?? 0);
    const startEquity = Number(status?.risk?.session_start_equity ?? NaN);
    const base = Number.isFinite(startEquity) && startEquity > 0
      ? startEquity
      : balance - sessionProfit > 0
        ? balance - sessionProfit
        : balance;
    const roi = base > 0 ? (sessionProfit / base) * 100 : 0;

    let cumulative = 0;
    const equitySeries = rows.map((h) => {
      cumulative += Number(h.profit ?? 0);
      return Number(cumulative.toFixed(2));
    });
    const winLossSeries = rows.map((h) => (String(h.result || "").toLowerCase() === "win" ? 1 : -1));

    return {
      winRate,
      profitFactor,
      avgWin,
      avgLoss,
      longestWinStreak: streaks.longestWin,
      longestLossStreak: streaks.longestLoss,
      roi,
      sessionProfit,
      trades: rows.length,
      equitySeries,
      winLossSeries,
      grossWin,
      grossLoss,
    };
  }

  function mergeSessionStats(metrics, statsPayload) {
    const session = statsPayload?.expectancy?.session;
    if (!session || !session.trades) return metrics;
    const m = { ...metrics };
    m.winRate = Number(session.win_rate ?? 0) * 100;
    m.avgWin = Number(session.avg_win ?? m.avgWin);
    m.avgLoss = Number(session.avg_loss ?? m.avgLoss);
    const gw = Number(session.wins ?? 0) * m.avgWin;
    const gl = Number(session.losses ?? 0) * m.avgLoss;
    m.grossWin = gw;
    m.grossLoss = gl;
    m.profitFactor = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
    m.trades = Number(session.trades ?? m.trades);
    return m;
  }

  function formatPct(n) {
    return `${Number(n).toFixed(1)}%`;
  }

  function formatMoney(n, signed) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    const prefix = signed && v > 0 ? "+" : "";
    return `${prefix}$${Math.abs(v).toFixed(2)}`;
  }

  function formatPF(n) {
    if (!Number.isFinite(n)) return "—";
    if (n === Infinity) return "∞";
    return Number(n).toFixed(2);
  }

  function renderSparkline(container, values, color, { fill = false } = {}) {
    if (!container) return;
    const vals = (values || []).map(Number).filter((v) => Number.isFinite(v));
    if (vals.length < 2) {
      container.innerHTML = '<svg viewBox="0 0 120 32" class="dash-mini-chart dash-mini-chart--empty" preserveAspectRatio="none"><line x1="0" y1="16" x2="120" y2="16" stroke="rgba(255,255,255,0.08)" /></svg>';
      return;
    }
    const w = 120;
    const h = 32;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const pts = vals
      .map((v, i) => {
        const x = (i / (vals.length - 1)) * w;
        const y = h - ((v - min) / span) * (h - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const fillPath = fill
      ? `<polygon fill="url(#grad-${container.id || "spark"})" fill-opacity="0.25" points="0,${h} ${pts} ${w},${h}"/>`
      : "";
    const gradId = `grad-${container.id || "spark"}`;
    container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" class="dash-mini-chart" preserveAspectRatio="none">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="transparent"/></linearGradient></defs>
      ${fillPath}
      <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${pts}"/>
    </svg>`;
  }

  function renderWinRateBar(container, winRate) {
    if (!container) return;
    const pct = Math.min(100, Math.max(0, Number(winRate) || 0));
    container.innerHTML = `<div class="dash-bar-chart"><div class="dash-bar-chart__win" style="width:${pct}%"></div><div class="dash-bar-chart__loss" style="width:${100 - pct}%"></div></div>`;
  }

  function renderFactorBar(container, pf) {
    if (!container) return;
    const v = Number.isFinite(pf) ? Math.min(pf, 3) : 0;
    const pct = (v / 3) * 100;
    const tone = pf >= 1.5 ? "good" : pf >= 1 ? "ok" : "bad";
    container.innerHTML = `<div class="dash-meter dash-meter--${tone}"><div class="dash-meter__fill" style="width:${pct}%"></div></div>`;
  }

  function renderStreakBlocks(container, count, tone) {
    if (!container) return;
    const n = Math.min(8, Math.max(0, Number(count) || 0));
    const blocks = Array.from({ length: 8 }, (_, i) =>
      `<span class="dash-streak-block${i < n ? ` dash-streak-block--${tone}` : ""}"></span>`
    ).join("");
    container.innerHTML = `<div class="dash-streak-blocks">${blocks}</div>`;
  }

  function renderRoiBar(container, roi) {
    if (!container) return;
    const v = Number(roi) || 0;
    const pct = Math.min(100, Math.abs(v) * 2);
    const tone = v > 0 ? "good" : v < 0 ? "bad" : "flat";
    container.innerHTML = `<div class="dash-meter dash-meter--${tone}"><div class="dash-meter__fill" style="width:${pct}%"></div></div>`;
  }

  function setMetric(id, text, tone) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove("is-good", "is-bad", "is-neutral");
    if (tone) el.classList.add(`is-${tone}`);
  }

  function render(metrics) {
    const root = document.getElementById("dashAnalytics");
    if (!root || !metrics) return;

    const wrTone = metrics.winRate >= 55 ? "good" : metrics.winRate >= 45 ? "neutral" : "bad";
    setMetric("analyticsWinRate", formatPct(metrics.winRate), wrTone);

    const pf = metrics.profitFactor;
    const pfTone = pf >= 1.5 ? "good" : pf >= 1 ? "neutral" : "bad";
    setMetric("analyticsProfitFactor", formatPF(pf), pfTone);

    setMetric("analyticsAvgWin", formatMoney(metrics.avgWin, true), "good");
    setMetric("analyticsAvgLoss", formatMoney(metrics.avgLoss, false), "bad");
    setMetric("analyticsWinStreak", String(metrics.longestWinStreak), metrics.longestWinStreak > 0 ? "good" : "neutral");
    setMetric("analyticsLossStreak", String(metrics.longestLossStreak), metrics.longestLossStreak > 0 ? "bad" : "neutral");

    const roiTone = metrics.roi > 0 ? "good" : metrics.roi < 0 ? "bad" : "neutral";
    setMetric("analyticsRoi", `${metrics.roi >= 0 ? "+" : ""}${metrics.roi.toFixed(2)}%`, roiTone);

    renderWinRateBar(document.getElementById("chartWinRate"), metrics.winRate);
    renderFactorBar(document.getElementById("chartProfitFactor"), pf === Infinity ? 3 : pf);
    renderSparkline(document.getElementById("chartAvgWin"), [0, metrics.avgWin * 0.4, metrics.avgWin], "#4ade80");
    renderSparkline(document.getElementById("chartAvgLoss"), [0, metrics.avgLoss * 0.5, metrics.avgLoss], "#f87171");
    renderStreakBlocks(document.getElementById("chartWinStreak"), metrics.longestWinStreak, "win");
    renderStreakBlocks(document.getElementById("chartLossStreak"), metrics.longestLossStreak, "loss");
    renderRoiBar(document.getElementById("chartRoi"), metrics.roi);

    const eqColor = metrics.sessionProfit >= 0 ? "#4ade80" : "#f87171";
    renderSparkline(document.getElementById("chartEquityCurve"), metrics.equitySeries, eqColor, { fill: true });
    renderSparkline(document.getElementById("chartWinLoss"), metrics.winLossSeries, "#93c5fd");

    const tradesEl = document.getElementById("analyticsTradeCount");
    if (tradesEl) tradesEl.textContent = `${metrics.trades} settled`;

    const winRateVisible = document.getElementById("winRateCardVisible");
    if (winRateVisible) winRateVisible.textContent = formatPct(metrics.winRate);

    const winRateCard = document.getElementById("winRateCard");
    if (winRateCard) winRateCard.textContent = formatPct(metrics.winRate);
  }

  async function refresh(history, status, requestJson) {
    if (!document.getElementById("dashAnalytics")) return null;
    let metrics = computeFromHistory(history, status);
    if (typeof requestJson === "function") {
      try {
        const stats = await requestJson("/stats");
        metrics = mergeSessionStats(metrics, stats);
      } catch (_e) {
        /* use history-only */
      }
    }
    render(metrics);
    return metrics;
  }

  window.TradeAnalytics = {
    refresh,
    computeFromHistory,
    render,
  };
})();
