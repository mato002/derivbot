/**
 * MatchTraders Copy Trading Marketplace V2 — demo marketplace UI.
 * Wires active copies to existing /copy-follow and /copy-unfollow APIs.
 */
(function () {
  const STORAGE_KEY = "matchtraders_copy_v2";
  const DEMO_TRADERS = [
    {
      id: "ai_digit_hunter",
      name: "AI Digit Hunter",
      style: "Digit Match · Momentum",
      risk: "medium",
      riskLabel: "Medium",
      followers: 241,
      winRate: 68,
      roi: 24,
      monthlyReturn: 24,
      market: "R_100",
      experience: "3 years",
      drawdown: 8.2,
      totalTrades: 1842,
      avgProfit: 1.85,
      activeHours: 2,
      avatar: "AI",
      color: "#1b52c0",
    },
    {
      id: "volatility_scalper",
      name: "Volatility Scalper",
      style: "Tick Scalping · High Frequency",
      risk: "high",
      riskLabel: "High",
      followers: 189,
      winRate: 61,
      roi: 31,
      monthlyReturn: 31,
      market: "R_75",
      experience: "2 years",
      drawdown: 14.5,
      totalTrades: 3201,
      avgProfit: 0.92,
      activeHours: 1,
      avatar: "VS",
      color: "#dc2626",
    },
    {
      id: "steady_index",
      name: "Steady Index Runner",
      style: "Conservative · Index",
      risk: "low",
      riskLabel: "Low",
      followers: 412,
      winRate: 72,
      roi: 14,
      monthlyReturn: 14,
      market: "R_100",
      experience: "5 years",
      drawdown: 4.1,
      totalTrades: 956,
      avgProfit: 2.1,
      activeHours: 8,
      avatar: "SI",
      color: "#16a34a",
    },
    {
      id: "match_master",
      name: "Match Master Pro",
      style: "Digit Match · Statistical",
      risk: "medium",
      riskLabel: "Medium",
      followers: 328,
      winRate: 65,
      roi: 22,
      monthlyReturn: 22,
      market: "R_100",
      experience: "4 years",
      drawdown: 9.8,
      totalTrades: 2104,
      avgProfit: 1.62,
      activeHours: 3,
      avatar: "MM",
      color: "#7c3aed",
    },
    {
      id: "tick_wave",
      name: "Tick Wave Trader",
      style: "Wave Analysis · Aggressive",
      risk: "high",
      riskLabel: "High",
      followers: 156,
      winRate: 58,
      roi: 35,
      monthlyReturn: 35,
      market: "R_50",
      experience: "18 months",
      drawdown: 18.2,
      totalTrades: 2890,
      avgProfit: 0.78,
      activeHours: 0.5,
      avatar: "TW",
      color: "#ea580c",
    },
    {
      id: "precision_over",
      name: "Precision Over Bot",
      style: "Digit Over · Low Drawdown",
      risk: "low",
      riskLabel: "Low",
      followers: 298,
      winRate: 74,
      roi: 12,
      monthlyReturn: 12,
      market: "R_100",
      experience: "6 years",
      drawdown: 3.5,
      totalTrades: 742,
      avgProfit: 2.45,
      activeHours: 12,
      avatar: "PO",
      color: "#0891b2",
    },
    {
      id: "quantum_digits",
      name: "Quantum Digits",
      style: "ML Signals · Multi-market",
      risk: "medium",
      riskLabel: "Medium",
      followers: 367,
      winRate: 66,
      roi: 26,
      monthlyReturn: 26,
      market: "R_100",
      experience: "2 years",
      drawdown: 10.1,
      totalTrades: 1650,
      avgProfit: 1.72,
      activeHours: 4,
      avatar: "QD",
      color: "#4f46e5",
    },
    {
      id: "safe_harbor",
      name: "Safe Harbor FX",
      style: "Capital Preservation",
      risk: "low",
      riskLabel: "Low",
      followers: 521,
      winRate: 76,
      roi: 9,
      monthlyReturn: 9,
      market: "R_10",
      experience: "7 years",
      drawdown: 2.8,
      totalTrades: 488,
      avgProfit: 1.95,
      activeHours: 24,
      avatar: "SH",
      color: "#059669",
    },
    {
      id: "flash_momentum",
      name: "Flash Momentum",
      style: "Breakout · Short Duration",
      risk: "high",
      riskLabel: "High",
      followers: 203,
      winRate: 59,
      roi: 28,
      monthlyReturn: 28,
      market: "R_100",
      experience: "14 months",
      drawdown: 16.4,
      totalTrades: 2544,
      avgProfit: 1.05,
      activeHours: 1,
      avatar: "FM",
      color: "#be123c",
    },
    {
      id: "neural_edge",
      name: "Neural Edge",
      style: "AI Ensemble · Digit Match",
      risk: "medium",
      riskLabel: "Medium",
      followers: 445,
      winRate: 67,
      roi: 21,
      monthlyReturn: 21,
      market: "R_100",
      experience: "3 years",
      drawdown: 7.6,
      totalTrades: 1920,
      avgProfit: 1.58,
      activeHours: 2,
      avatar: "NE",
      color: "#2563eb",
    },
  ];

  const DEMO_RECENT_TRADES = [
    { trader: "AI Digit Hunter", market: "R_100", contract: "Digit Match", stake: 5, result: "WIN", profit: 4.2, time: "14:32:08" },
    { trader: "Steady Index Runner", market: "R_100", contract: "Digit Over", stake: 10, result: "WIN", profit: 8.5, time: "14:28:41" },
    { trader: "Volatility Scalper", market: "R_75", contract: "Digit Match", stake: 3, result: "LOSS", profit: -3, time: "14:25:12" },
    { trader: "Match Master Pro", market: "R_100", contract: "Digit Match", stake: 5, result: "WIN", profit: 3.85, time: "14:21:55" },
    { trader: "Quantum Digits", market: "R_100", contract: "Digit Under", stake: 8, result: "WIN", profit: 6.4, time: "14:18:03" },
    { trader: "Neural Edge", market: "R_100", contract: "Digit Match", stake: 5, result: "LOSS", profit: -5, time: "14:14:22" },
  ];

  let state = loadState();
  let selectedTraderId = null;
  let filterKey = "all";
  let sortKey = "rank";
  let searchQuery = "";

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_e) {
      /* ignore */
    }
    return { activeCopies: [], demoTrades: [] };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_e) {
      /* ignore */
    }
  }

  function fmtNum(n) {
    return Number(n).toLocaleString("en-US");
  }

  function fmtUsd(n, signed) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    const prefix = signed && v > 0 ? "+" : "";
    return `${prefix}$${Math.abs(v).toFixed(2)}`;
  }

  function fmtPct(n, signed) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return `${signed && v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  }

  function riskClass(risk) {
    if (risk === "low") return "copy-risk--low";
    if (risk === "high") return "copy-risk--high";
    return "copy-risk--medium";
  }

  function getTrader(id) {
    return DEMO_TRADERS.find((t) => t.id === id);
  }

  function filteredTraders() {
    let list = [...DEMO_TRADERS];
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.style.toLowerCase().includes(q) ||
          t.market.toLowerCase().includes(q),
      );
    }
    if (filterKey === "low" || filterKey === "medium" || filterKey === "high") {
      list = list.filter((t) => t.risk === filterKey);
    } else if (filterKey === "roi") {
      list.sort((a, b) => b.roi - a.roi);
    } else if (filterKey === "followers") {
      list.sort((a, b) => b.followers - a.followers);
    } else if (filterKey === "recent") {
      list.sort((a, b) => a.activeHours - b.activeHours);
    }
    if (sortKey === "roi") list.sort((a, b) => b.roi - a.roi);
    else if (sortKey === "followers") list.sort((a, b) => b.followers - a.followers);
    else if (sortKey === "winrate") list.sort((a, b) => b.winRate - a.winRate);
    else if (sortKey === "recent") list.sort((a, b) => a.activeHours - b.activeHours);
    else list.sort((a, b) => b.roi * b.winRate - a.roi * a.winRate);
    return list;
  }

  function renderSparkline(container, values, positive) {
    if (!container) return;
    const vals = values || [];
    if (!vals.length) {
      container.innerHTML = "";
      return;
    }
    const max = Math.max(...vals, 1);
    const min = Math.min(...vals, 0);
    const range = max - min || 1;
    const w = 100;
    const h = 48;
    const pts = vals
      .map((v, i) => {
        const x = (i / (vals.length - 1 || 1)) * w;
        const y = h - ((v - min) / range) * (h - 4) - 2;
        return `${x},${y}`;
      })
      .join(" ");
    const stroke = positive ? "#16a34a" : "#1b52c0";
    container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" class="copy-sparkline" preserveAspectRatio="none"><polyline fill="none" stroke="${stroke}" stroke-width="2" points="${pts}"/></svg>`;
  }

  function randomSeries(len, base, variance) {
    const out = [];
    let v = base;
    for (let i = 0; i < len; i += 1) {
      v += (Math.random() - 0.42) * variance;
      out.push(Math.max(0, v));
    }
    return out;
  }

  function renderTraderCard(trader) {
    const card = document.createElement("article");
    card.className = "copy-trader-card";
    card.innerHTML = `
      <div class="copy-trader-card__head">
        <span class="copy-trader-avatar" style="background:${trader.color}">${escapeHtml(trader.avatar)}</span>
        <div>
          <h3 class="copy-trader-card__name">${escapeHtml(trader.name)}</h3>
          <p class="copy-trader-card__style">${escapeHtml(trader.style)}</p>
        </div>
        <span class="copy-risk ${riskClass(trader.risk)}">${escapeHtml(trader.riskLabel)}</span>
      </div>
      <div class="copy-trader-card__stats">
        <div><span class="copy-mkt-label">Followers</span><strong>${fmtNum(trader.followers)}</strong></div>
        <div><span class="copy-mkt-label">Win Rate</span><strong>${trader.winRate}%</strong></div>
        <div><span class="copy-mkt-label">Monthly ROI</span><strong class="copy-pos">+${trader.monthlyReturn}%</strong></div>
        <div><span class="copy-mkt-label">Market</span><strong>${escapeHtml(trader.market)}</strong></div>
      </div>
      <div class="copy-trader-card__actions">
        <button type="button" class="btn btn-sm" data-copy-profile="${escapeHtml(trader.id)}">View Profile</button>
        <button type="button" class="btn btn-sm btn-teal" data-copy-start="${escapeHtml(trader.id)}">Copy Trader</button>
      </div>`;
    return card;
  }

  function renderTraderGrid() {
    const grid = document.getElementById("copyTraderGrid");
    if (!grid) return;
    const traders = filteredTraders();
    grid.innerHTML = "";
    traders.forEach((t) => grid.appendChild(renderTraderCard(t)));
  }

  function renderLeaderboard() {
    const body = document.getElementById("copyLeaderboardBody");
    if (!body) return;
    const sorted = [...DEMO_TRADERS].sort((a, b) => b.roi - a.roi);
    body.innerHTML = "";
    sorted.forEach((t, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="copy-rank">${i + 1}</span></td>
        <td><span class="copy-trader-avatar copy-trader-avatar--sm" style="background:${t.color}">${escapeHtml(t.avatar)}</span> ${escapeHtml(t.name)}</td>
        <td class="copy-pos">+${t.roi}%</td>
        <td>${fmtNum(t.followers)}</td>
        <td>${t.winRate}%</td>
        <td><span class="copy-risk ${riskClass(t.risk)}">${escapeHtml(t.riskLabel)}</span></td>
        <td>${escapeHtml(t.market)}</td>
        <td><button type="button" class="btn btn-sm btn-teal" data-copy-start="${escapeHtml(t.id)}">Copy</button></td>`;
      body.appendChild(tr);
    });
  }

  function computePortfolio() {
    const copies = state.activeCopies || [];
    let value = 0;
    let profit = 0;
    let today = 0;
    copies.forEach((c) => {
      const alloc = Number(c.allocation) || 0;
      const p = Number(c.profit) || 0;
      value += alloc + p;
      profit += p;
      today += p * 0.15;
    });
    const roi = value > 0 ? (profit / Math.max(value - profit, 1)) * 100 : 0;
    return {
      value,
      profit,
      today,
      month: profit * 1.4,
      roi,
      active: copies.filter((c) => c.status === "active").length,
      drawdown: copies.length ? 4.2 : 0,
    };
  }

  function renderPortfolio() {
    const p = computePortfolio();
    const set = (id, text, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      if (cls) {
        el.classList.toggle("copy-pos", cls === "pos");
        el.classList.toggle("copy-neg", cls === "neg");
      }
    };
    set("copyPortfolioValue", fmtUsd(p.value));
    set("copyPortfolioRoi", fmtPct(p.roi, true), p.roi >= 0 ? "pos" : "neg");
    set("copyPortfolioToday", fmtUsd(p.today, true), p.today >= 0 ? "pos" : "neg");
    set("copyPortfolioMonth", fmtUsd(p.month, true), p.month >= 0 ? "pos" : "neg");
    set("copyPortfolioActive", String(p.active));
    set("copyPortfolioDrawdown", fmtPct(p.drawdown), "neg");
    renderSparkline(document.getElementById("copyPortfolioChart"), randomSeries(30, p.value * 0.85 || 50, 8), p.profit >= 0);
    renderRecentTrades();
  }

  function renderRecentTrades() {
    const body = document.getElementById("copyRecentTradesBody");
    if (!body) return;
    const rows = [...DEMO_RECENT_TRADES];
    (state.demoTrades || []).slice(-10).reverse().forEach((r) => rows.unshift(r));
    body.innerHTML = "";
    rows.slice(0, 12).forEach((r) => {
      const tr = document.createElement("tr");
      const win = String(r.result).toUpperCase() === "WIN";
      tr.innerHTML = `
        <td>${escapeHtml(r.trader)}</td>
        <td>${escapeHtml(r.market)}</td>
        <td>${escapeHtml(r.contract)}</td>
        <td>${fmtUsd(r.stake)}</td>
        <td><span class="copy-result copy-result--${win ? "win" : "loss"}">${win ? "WIN" : "LOSS"}</span></td>
        <td class="${win ? "copy-pos" : "copy-neg"}">${fmtUsd(r.profit, true)}</td>
        <td>${escapeHtml(r.time)}</td>`;
      body.appendChild(tr);
    });
  }

  function renderActiveCopies() {
    const grid = document.getElementById("copyActiveGrid");
    const empty = document.getElementById("copyActiveEmpty");
    const copies = state.activeCopies || [];
    if (!grid || !empty) return;
    if (!copies.length) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    grid.innerHTML = "";
    copies.forEach((c) => {
      const trader = getTrader(c.traderId);
      if (!trader) return;
      const roi = c.allocation > 0 ? ((c.profit || 0) / c.allocation) * 100 : 0;
      const card = document.createElement("article");
      card.className = "copy-active-card";
      const paused = c.status === "paused";
      card.innerHTML = `
        <header class="copy-active-card__head">
          <span class="copy-trader-avatar copy-trader-avatar--sm" style="background:${trader.color}">${escapeHtml(trader.avatar)}</span>
          <h3>${escapeHtml(trader.name)}</h3>
          <span class="copy-active-status copy-active-status--${paused ? "paused" : "active"}">${paused ? "PAUSED" : "ACTIVE"}</span>
        </header>
        <div class="copy-active-card__stats">
          <div><span class="copy-mkt-label">Allocation</span><strong>${fmtUsd(c.allocation)}</strong></div>
          <div><span class="copy-mkt-label">Profit</span><strong class="${(c.profit || 0) >= 0 ? "copy-pos" : "copy-neg"}">${fmtUsd(c.profit || 0, true)}</strong></div>
          <div><span class="copy-mkt-label">ROI</span><strong class="${roi >= 0 ? "copy-pos" : "copy-neg"}">${fmtPct(roi, true)}</strong></div>
        </div>
        <div class="copy-active-card__actions">
          ${paused
            ? `<button type="button" class="btn btn-sm btn-blue" data-copy-resume="${escapeHtml(c.traderId)}">Resume</button>`
            : `<button type="button" class="btn btn-sm" data-copy-pause="${escapeHtml(c.traderId)}">Pause</button>`}
          <button type="button" class="btn btn-sm btn-stop" data-copy-stop="${escapeHtml(c.traderId)}">Stop Copying</button>
        </div>`;
      grid.appendChild(card);
    });
  }

  function openProfile(traderId) {
    const trader = getTrader(traderId);
    if (!trader) return;
    selectedTraderId = traderId;
    const modal = document.getElementById("copyProfileModal");
    if (!modal) return;
    document.getElementById("copyProfileTitle").textContent = trader.name;
    document.getElementById("copyProfileStyle").textContent = trader.style;
    document.getElementById("copyProfileAvatar").textContent = trader.avatar;
    document.getElementById("copyProfileAvatar").style.background = trader.color;
    document.getElementById("copyProfileExperience").textContent = trader.experience;
    document.getElementById("copyProfileFollowers").textContent = fmtNum(trader.followers);
    document.getElementById("copyProfileMarkets").textContent = trader.market;
    document.getElementById("copyProfileRisk").textContent = trader.riskLabel;
    document.getElementById("copyProfileWinRate").textContent = `${trader.winRate}%`;
    document.getElementById("copyProfileRoi").textContent = `+${trader.roi}%`;
    document.getElementById("copyProfileDrawdown").textContent = `${trader.drawdown}%`;
    document.getElementById("copyProfileTrades").textContent = fmtNum(trader.totalTrades);
    document.getElementById("copyProfileAvgProfit").textContent = fmtUsd(trader.avgProfit);
    renderSparkline(document.getElementById("copyProfileEquityChart"), randomSeries(24, 100, 12), true);
    renderSparkline(document.getElementById("copyProfileRoiChart"), randomSeries(12, trader.roi, 4), true);
    const tbody = document.getElementById("copyProfileTradesBody");
    if (tbody) {
      tbody.innerHTML = "";
      for (let i = 0; i < 5; i += 1) {
        const win = Math.random() > 0.35;
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>Digit Match · ${trader.market}</td><td><span class="copy-result copy-result--${win ? "win" : "loss"}">${win ? "WIN" : "LOSS"}</span></td><td class="${win ? "copy-pos" : "copy-neg"}">${fmtUsd(win ? trader.avgProfit : -2, true)}</td><td>Today</td>`;
        tbody.appendChild(tr);
      }
    }
    modal.classList.remove("hidden");
  }

  function openCopySettings(traderId) {
    const trader = getTrader(traderId);
    if (!trader) return;
    selectedTraderId = traderId;
    document.getElementById("copySettingsTraderName").textContent = trader.name;
    const existing = (state.activeCopies || []).find((c) => c.traderId === traderId);
    if (existing) {
      document.getElementById("copySettingsAllocation").value = existing.allocation;
      document.getElementById("copySettingsMultiplier").value = existing.multiplier;
      document.getElementById("copySettingsRiskLimit").value = existing.riskLimit;
      document.getElementById("copySettingsMaxLoss").value = existing.maxDailyLoss;
      document.getElementById("copySettingsMaxOpen").value = existing.maxOpenTrades;
    }
    document.getElementById("copySettingsModal")?.classList.remove("hidden");
  }

  function closeModals() {
    document.querySelectorAll(".copy-modal").forEach((m) => m.classList.add("hidden"));
  }

  async function startCopying(settings) {
    const trader = getTrader(selectedTraderId);
    if (!trader) return;
    const copy = {
      traderId: selectedTraderId,
      allocation: Number(settings.allocation),
      multiplier: Number(settings.multiplier),
      riskLimit: Number(settings.riskLimit),
      maxDailyLoss: Number(settings.maxDailyLoss),
      maxOpenTrades: Number(settings.maxOpenTrades),
      copyExisting: settings.copyExisting === "yes",
      status: "active",
      profit: 0,
      startedAt: Date.now(),
    };
    state.activeCopies = (state.activeCopies || []).filter((c) => c.traderId !== selectedTraderId);
    state.activeCopies.push(copy);
    saveState();
    try {
      await requestJson("/copy-follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ follower_id: `copy_${selectedTraderId}` }),
      });
    } catch (_e) {
      /* demo continues */
    }
    closeModals();
    if (typeof showToast === "function") showToast(`Now copying ${trader.name}`);
    renderAll();
    switchView("copies");
  }

  async function stopCopying(traderId) {
    state.activeCopies = (state.activeCopies || []).filter((c) => c.traderId !== traderId);
    saveState();
    try {
      await requestJson("/copy-unfollow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ follower_id: `copy_${traderId}` }),
      });
    } catch (_e) {
      /* ignore */
    }
    renderAll();
  }

  function togglePause(traderId, paused) {
    state.activeCopies = (state.activeCopies || []).map((c) =>
      c.traderId === traderId ? { ...c, status: paused ? "paused" : "active" } : c,
    );
    saveState();
    renderActiveCopies();
    renderPortfolio();
  }

  function switchView(view) {
    document.querySelectorAll(".copy-mkt-tab").forEach((tab) => {
      const active = tab.dataset.copyView === view;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".copy-mkt-view").forEach((panel) => {
      const id = panel.id.replace("copyView", "").toLowerCase();
      const show = id === view;
      panel.classList.toggle("is-active", show);
      panel.hidden = !show;
    });
  }

  function syncFromApiFeed(snap) {
    const feed = snap?.recent_copies || [];
    feed.slice(-5).forEach((row) => {
      const t = row.trade || {};
      const traderName = getTrader("ai_digit_hunter")?.name || "Platform Master";
      state.demoTrades = state.demoTrades || [];
      state.demoTrades.push({
        trader: traderName,
        market: "R_100",
        contract: t.contract_type || "Digit Match",
        stake: Number(t.stake ?? 1),
        result: String(t.result || "").toUpperCase() === "WIN" ? "WIN" : "LOSS",
        profit: Number(t.profit ?? 0),
        time: row.time || "—",
      });
    });
    state.demoTrades = (state.demoTrades || []).slice(-20);
    (state.activeCopies || []).forEach((c) => {
      const last = feed[feed.length - 1];
      if (last?.source === "copy") {
        c.profit = round2((c.profit || 0) + Number(last.trade?.profit ?? 0) * 0.1);
      }
    });
    saveState();
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function renderKpis() {
    const totalFollowers = DEMO_TRADERS.reduce((s, t) => s + t.followers, 0) + (state.activeCopies?.length || 0);
    document.getElementById("copyKpiTraders").textContent = fmtNum(152);
    document.getElementById("copyKpiFollowers").textContent = fmtNum(totalFollowers);
    document.getElementById("copyKpiTodayRoi").textContent = "+3.2%";
    document.getElementById("copyKpiCopiedTrades").textContent = fmtNum(18422 + (state.demoTrades?.length || 0));
  }

  function renderAll() {
    renderKpis();
    renderTraderGrid();
    renderLeaderboard();
    renderActiveCopies();
    renderPortfolio();
  }

  function wireEvents() {
    document.querySelectorAll(".copy-mkt-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchView(tab.dataset.copyView || "marketplace"));
    });

    document.getElementById("copyTraderSearch")?.addEventListener("input", (e) => {
      searchQuery = e.target.value || "";
      renderTraderGrid();
    });

    document.getElementById("copyTraderSort")?.addEventListener("change", (e) => {
      sortKey = e.target.value;
      renderTraderGrid();
    });

    document.querySelectorAll(".copy-mkt-filter").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".copy-mkt-filter").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        filterKey = btn.dataset.copyFilter || "all";
        renderTraderGrid();
      });
    });

    document.body.addEventListener("click", (e) => {
      const profile = e.target.closest("[data-copy-profile]");
      if (profile) {
        openProfile(profile.dataset.copyProfile);
        return;
      }
      const start = e.target.closest("[data-copy-start]");
      if (start) {
        openCopySettings(start.dataset.copyStart);
        return;
      }
      const pause = e.target.closest("[data-copy-pause]");
      if (pause) {
        togglePause(pause.dataset.copyPause, true);
        return;
      }
      const resume = e.target.closest("[data-copy-resume]");
      if (resume) {
        togglePause(resume.dataset.copyResume, false);
        return;
      }
      const stop = e.target.closest("[data-copy-stop]");
      if (stop) {
        stopCopying(stop.dataset.copyStop);
        return;
      }
      if (e.target.closest("[data-copy-close]")) closeModals();
      const goto = e.target.closest("[data-copy-goto]");
      if (goto) switchView(goto.dataset.copyGoto || "marketplace");
    });

    document.getElementById("copyProfileCopyBtn")?.addEventListener("click", () => {
      closeModals();
      if (selectedTraderId) openCopySettings(selectedTraderId);
    });

    document.getElementById("copySettingsForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const existing = document.querySelector('input[name="copyExisting"]:checked');
      startCopying({
        allocation: document.getElementById("copySettingsAllocation").value,
        multiplier: document.getElementById("copySettingsMultiplier").value,
        riskLimit: document.getElementById("copySettingsRiskLimit").value,
        maxDailyLoss: document.getElementById("copySettingsMaxLoss").value,
        maxOpenTrades: document.getElementById("copySettingsMaxOpen").value,
        copyExisting: existing?.value || "no",
      });
    });

    document.getElementById("copyBecomeProviderBtn")?.addEventListener("click", () => {
      if (typeof showToast === "function") showToast("Signal provider onboarding coming soon.");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModals();
    });
  }

  async function refreshApiFeed() {
    try {
      const snap = await requestJson("/copy-status");
      syncFromApiFeed(snap);
      renderPortfolio();
      renderRecentTrades();
    } catch (_e) {
      /* ignore */
    }
  }

  function initCopyMarketplace() {
    if (typeof initAuthButtons === "function") initAuthButtons();
    if (typeof refreshAuthState === "function") refreshAuthState();
    wireEvents();
    renderAll();
    refreshApiFeed();
    setInterval(refreshApiFeed, 5000);
  }

  window.initCopyMarketplace = initCopyMarketplace;
})();
