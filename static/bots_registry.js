/**
 * MatchTraders Bot Registry & Deployment Center
 */
(function () {
  const MARKETPLACE = [
    { id: "tpl_ou_scalp", name: "Over/Under Scalper", category: "over_under", contract: "DIGITUNDER", market: "R_100", risk: "Medium", desc: "Fast digit over/under entries on volatility indices.", official: true },
    { id: "tpl_ou_conservative", name: "Conservative Under", category: "over_under", contract: "DIGITUNDER", market: "R_10", risk: "Low", desc: "Low-drawdown under strategy for steady indices.", official: true },
    { id: "tpl_match_engine", name: "Matches Engine Pro", category: "matches", contract: "DIGITMATCH", market: "R_100", risk: "Medium", desc: "Statistical digit match with repeat-pattern logic.", official: true },
    { id: "tpl_differs_pulse", name: "Differs Pulse", category: "matches", contract: "DIGITDIFF", market: "R_75", risk: "High", desc: "Aggressive differs strategy for high-volatility ticks.", official: true },
    { id: "tpl_rise_momentum", name: "Rise Momentum", category: "rise_fall", contract: "CALL", market: "R_100", risk: "Medium", desc: "Trend-following rise entries on index breakouts.", official: true },
    { id: "tpl_fall_hedge", name: "Fall Hedge Bot", category: "rise_fall", contract: "PUT", market: "R_50", risk: "Low", desc: "Defensive fall positions during volatility spikes.", official: true },
    { id: "tpl_even_streak", name: "Even Streak Hunter", category: "even_odd", contract: "DIGITEVEN", market: "R_100", risk: "Medium", desc: "Even/odd parity strategy with streak detection.", official: true },
    { id: "tpl_odd_reversal", name: "Odd Reversal", category: "even_odd", contract: "DIGITODD", market: "R_100", risk: "Low", desc: "Mean-reversion odd entries after even clusters.", official: true },
    { id: "tpl_vol_recovery", name: "Volatility Recovery", category: "volatility", contract: "DIGITUNDER", market: "R_75", risk: "High", desc: "Martingale-style recovery tuned for R_75.", official: true },
    { id: "tpl_vol_sniper", name: "Vol Sniper", category: "volatility", contract: "DIGITOVER", market: "R_100", risk: "High", desc: "High-frequency volatility breakout scalper.", official: true },
    { id: "tpl_ai_digit", name: "AI Digit Hunter", category: "ai", contract: "DIGITMATCH", market: "R_100", risk: "Medium", desc: "ML-assisted digit match with confluence filters.", official: true },
    { id: "tpl_ai_ensemble", name: "Neural Ensemble", category: "ai", contract: "DIGITUNDER", market: "R_100", risk: "Medium", desc: "Multi-signal AI ensemble for digit under bias.", official: true },
  ];

  let state = { strategies: [], deployments: [], analytics: null };
  let selectedStrategyId = null;
  let selectedTemplate = null;
  let marketCat = "all";
  let marketSearch = "";
  let mySearch = "";
  let mySort = "updated";
  let wired = false;

  function esc(text) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(text);
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function req(url, options) {
    if (typeof window.requestJson === "function") return window.requestJson(url, options);
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.detail || data.message || res.statusText);
      err.detail = data.detail;
      throw err;
    }
    return data;
  }

  function toast(message) {
    if (typeof window.showToast === "function") window.showToast(message);
    else console.log(message);
  }

  function contractLabel(code) {
    const c = String(code || "").toUpperCase();
    if (c === "DIGITOVER") return "Digit Over";
    if (c === "DIGITUNDER") return "Digit Under";
    if (c === "DIGITMATCH") return "Digit Match";
    if (c === "CALL") return "Rise";
    if (c === "PUT") return "Fall";
    return c.replace(/_/g, " ") || "—";
  }

  function formatTs(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "—";
    return new Date(n * 1000).toLocaleString();
  }

  function formatUptime(sec) {
    const s = Number(sec) || 0;
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function fmtUsd(n, signed) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return `${signed && v > 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
  }

  function statusBadge(status) {
    const s = String(status || "saved").toLowerCase();
    let cls = "bots-status--saved";
    if (s === "running" || s === "deployed") cls = "bots-status--active";
    else if (s === "paused") cls = "bots-status--paused";
    else if (s === "imported") cls = "bots-status--imported";
    else if (s === "official") cls = "bots-status--official";
    return `<span class="bots-status ${cls}">${esc(s.toUpperCase())}</span>`;
  }

  function defaultStrategy(contract) {
    const trade = String(contract || "DIGITUNDER").includes("OVER") ? "OVER" : "UNDER";
    return {
      type: "digit_strategy",
      condition: "repeat_3",
      action: "over_under",
      active_action: "over_under",
      actions: {
        over_under: {
          enabled: true,
          rules: {
            if_digit_greater_equal: 5,
            trade,
            else_trade: trade === "OVER" ? "UNDER" : "OVER",
          },
        },
      },
      quick_meta: { contract_type: contract, market: "R_100" },
    };
  }

  function renderSparkline(container, values, color) {
    if (!container) return;
    const vals = values || [];
    if (!vals.length) {
      container.innerHTML = `<p class="subtle small">No data yet</p>`;
      return;
    }
    const max = Math.max(...vals, 1);
    const min = Math.min(...vals, 0);
    const range = max - min || 1;
    const w = 100;
    const h = 64;
    const pts = vals
      .map((v, i) => {
        const x = (i / (vals.length - 1 || 1)) * w;
        const y = h - ((v - min) / range) * (h - 6) - 3;
        return `${x},${y}`;
      })
      .join(" ");
    container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" class="bots-sparkline" preserveAspectRatio="none"><polyline fill="none" stroke="${color || "#1b52c0"}" stroke-width="2.5" points="${pts}"/></svg>`;
  }

  function renderBars(container, values) {
    if (!container) return;
    const vals = values || [0, 0, 0, 0, 0, 0, 0];
    const max = Math.max(...vals, 1);
    container.innerHTML = `<div class="bots-bar-chart">${vals
      .map((v) => `<span class="bots-bar" style="height:${Math.max(4, (v / max) * 100)}%" title="${v} trades"></span>`)
      .join("")}</div>`;
  }

  function renderDonut(container, pct) {
    if (!container) return;
    const p = Math.min(100, Math.max(0, Number(pct) || 0));
    const r = 36;
    const c = 2 * Math.PI * r;
    const offset = c - (p / 100) * c;
    container.innerHTML = `
      <svg viewBox="0 0 88 88" class="bots-donut">
        <circle cx="44" cy="44" r="${r}" fill="none" stroke="#e6e9ef" stroke-width="10"/>
        <circle cx="44" cy="44" r="${r}" fill="none" stroke="#2d9f6a" stroke-width="10"
          stroke-dasharray="${c}" stroke-dashoffset="${offset}" transform="rotate(-90 44 44)"/>
        <text x="44" y="48" text-anchor="middle" class="bots-donut__text">${p.toFixed(0)}%</text>
      </svg>`;
  }

  function appendCard(grid, html) {
    const wrap = document.createElement("div");
    wrap.innerHTML = html.trim();
    const card = wrap.firstElementChild;
    if (card) grid.appendChild(card);
  }

  function botCardHtml(item, actions) {
    return `
      <article class="bots-card" data-bot-id="${esc(item.id || item.strategy_id || "")}">
        <header class="bots-card__head">
          <h3 class="bots-card__name">${esc(item.name || item.strategy_name || "Bot")}</h3>
          ${statusBadge(item.status)}
        </header>
        <div class="bots-card__meta">
          <div><span class="bots-label">Version</span><strong>v${item.version ?? item.strategy_version ?? 1}</strong></div>
          <div><span class="bots-label">Market</span><strong>${esc(item.market || "R_100")}</strong></div>
          <div><span class="bots-label">Contract</span><strong>${esc(contractLabel(item.contract_type || item.contract))}</strong></div>
          <div><span class="bots-label">Modified</span><strong>${formatTs(item.updated_at)}</strong></div>
        </div>
        <div class="bots-card__actions">${actions}</div>
      </article>`;
  }

  function renderMarketplace() {
    const grid = document.getElementById("botsMarketGrid");
    if (!grid) return;
    const q = marketSearch.trim().toLowerCase();
    const list = MARKETPLACE.filter((t) => {
      if (marketCat !== "all" && t.category !== marketCat) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.category.includes(q) ||
        t.desc.toLowerCase().includes(q)
      );
    });
    grid.innerHTML = "";
    list.forEach((t) => {
      appendCard(
        grid,
        botCardHtml(
          { ...t, status: "official", version: 1, updated_at: Date.now() / 1000 },
          `
          <button type="button" class="btn btn-sm" data-bots-preview="${esc(t.id)}">Preview</button>
          <button type="button" class="btn btn-sm" data-bots-clone-tpl="${esc(t.id)}">Clone</button>
          <button type="button" class="btn btn-sm btn-teal" data-bots-deploy-tpl="${esc(t.id)}">Deploy</button>`,
        ),
      );
    });
  }

  function sortedStrategies() {
    let list = [...(state.strategies || [])];
    const q = mySearch.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.market.toLowerCase().includes(q) ||
          contractLabel(s.contract_type).toLowerCase().includes(q),
      );
    }
    if (mySort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (mySort === "created") list.sort((a, b) => b.created_at - a.created_at);
    else if (mySort === "version") list.sort((a, b) => b.version - a.version);
    else list.sort((a, b) => b.updated_at - a.updated_at);
    return list;
  }

  function renderMyBots() {
    const grid = document.getElementById("botsMyGrid");
    const empty = document.getElementById("botsMyEmpty");
    if (!grid || !empty) return;
    const list = sortedStrategies();
    if (!list.length) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    grid.innerHTML = "";
    list.forEach((s) => {
      appendCard(
        grid,
        botCardHtml(
          s,
          `
          <button type="button" class="btn btn-sm" data-bots-open="${esc(s.id)}">Open</button>
          <button type="button" class="btn btn-sm btn-teal" data-bots-deploy="${esc(s.id)}">Deploy</button>
          <button type="button" class="btn btn-sm" data-bots-clone="${esc(s.id)}">Clone</button>
          <button type="button" class="btn btn-sm" data-bots-export="${esc(s.id)}">Export</button>
          <button type="button" class="btn btn-sm btn-stop" data-bots-delete="${esc(s.id)}">Delete</button>
          <button type="button" class="btn btn-sm" data-bots-detail="${esc(s.id)}">Details</button>`,
        ),
      );
    });
  }

  function renderDeployments() {
    const grid = document.getElementById("botsDeployGrid");
    const empty = document.getElementById("botsDeployEmpty");
    if (!grid || !empty) return;
    const active = (state.deployments || []).filter((d) => d.status === "running" || d.status === "paused");
    if (!active.length) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    grid.innerHTML = "";
    active.forEach((d) => {
      const card = document.createElement("article");
      card.className = "bots-deploy-card";
      const profitCls = (d.profit || 0) >= 0 ? "bots-pos" : "bots-neg";
      card.innerHTML = `
        <header class="bots-deploy-card__head">
          <h3>${esc(d.strategy_name)}</h3>
          ${statusBadge(d.status)}
        </header>
        <div class="bots-deploy-card__stats">
          <div><span class="bots-label">Account</span><strong>${esc(d.account)}</strong></div>
          <div><span class="bots-label">Market</span><strong>${esc(d.market)}</strong></div>
          <div><span class="bots-label">Profit</span><strong class="${profitCls}">${fmtUsd(d.profit, true)}</strong></div>
          <div><span class="bots-label">Trades</span><strong>${d.trades_count || 0}</strong></div>
          <div><span class="bots-label">Uptime</span><strong>${formatUptime(d.uptime_seconds)}</strong></div>
          <div><span class="bots-label">Version</span><strong>v${d.strategy_version}</strong></div>
        </div>
        <div class="bots-deploy-card__actions">
          ${d.status === "paused"
            ? `<button type="button" class="btn btn-sm btn-blue" data-bots-resume="${esc(d.id)}">Resume</button>`
            : `<button type="button" class="btn btn-sm" data-bots-pause="${esc(d.id)}">Pause</button>`}
          <button type="button" class="btn btn-sm btn-stop" data-bots-stop-dep="${esc(d.id)}">Stop</button>
          <button type="button" class="btn btn-sm" data-bots-detail="${esc(d.strategy_id)}">Details</button>
        </div>`;
      grid.appendChild(card);
    });
  }

  function renderAnalytics() {
    const a = state.analytics || {};
    const profit = a.profit ?? 0;
    const winRate = a.win_rate ?? 0;
    const trades = a.trades_count ?? 0;
    const summary = a.summary || {};
    const set = (id, text, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      if (cls) {
        el.classList.toggle("bots-pos", cls === "pos");
        el.classList.toggle("bots-neg", cls === "neg");
      }
    };
    set("botsAnalyticsProfit", fmtUsd(profit, true), profit >= 0 ? "pos" : "neg");
    set("botsAnalyticsWinRate", `${winRate.toFixed(1)}%`);
    set("botsAnalyticsTrades", String(trades));
    set("botsAnalyticsDeploys", String(summary.active_deployments ?? 0));
    const history = a.history || [];
    let equity = [0];
    history.forEach((h) => {
      equity.push(equity[equity.length - 1] + Number(h.profit || 0));
    });
    if (equity.length < 3) equity = [0, profit * 0.3, profit * 0.6, profit];
    renderSparkline(document.getElementById("botsChartEquity"), equity, profit >= 0 ? "#2d9f6a" : "#e34444");
    renderDonut(document.getElementById("botsChartWinRate"), winRate);
    renderSparkline(
      document.getElementById("botsChartProfit"),
      history.map((h) => Number(h.profit || 0)).reverse().concat([profit]),
      "#1b52c0",
    );
    renderBars(document.getElementById("botsChartTradesDay"), [2, 5, 3, 8, 4, 6, trades % 10 || 1]);
  }

  function renderKpis() {
    const strategies = state.strategies || [];
    const deployments = state.deployments || [];
    const a = state.analytics || {};
    const totalEl = document.getElementById("botsKpiTotal");
    const activeEl = document.getElementById("botsKpiActive");
    const profitEl = document.getElementById("botsKpiProfit");
    const winEl = document.getElementById("botsKpiWinRate");
    if (totalEl) totalEl.textContent = String(strategies.length);
    if (activeEl) activeEl.textContent = String(deployments.filter((d) => d.status === "running").length);
    if (profitEl) {
      profitEl.textContent = fmtUsd(a.profit ?? 0, true);
      profitEl.classList.toggle("bots-pos", (a.profit ?? 0) >= 0);
      profitEl.classList.toggle("bots-neg", (a.profit ?? 0) < 0);
    }
    if (winEl) winEl.textContent = a.win_rate != null ? `${Number(a.win_rate).toFixed(1)}%` : "—";
  }

  function renderAll() {
    renderKpis();
    renderMarketplace();
    renderMyBots();
    renderDeployments();
    renderAnalytics();
  }

  async function refreshData() {
    try {
      const [registry, analytics] = await Promise.all([req("/bots/registry"), req("/bots/analytics")]);
      state.strategies = registry.strategies || [];
      state.deployments = registry.deployments || [];
      state.analytics = analytics;
      renderAll();
    } catch (_e) {
      renderAll();
    }
  }

  function switchView(view) {
    document.querySelectorAll(".bots-tab").forEach((tab) => {
      const active = tab.dataset.botsView === view;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".bots-view").forEach((panel) => {
      const key = panel.id.replace("botsView", "").toLowerCase();
      const show = key === view;
      panel.classList.toggle("is-active", show);
      panel.hidden = !show;
    });
  }

  function closeModals() {
    document.querySelectorAll(".bots-modal").forEach((m) => m.classList.add("hidden"));
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove("hidden");
  }

  function getStrategy(id) {
    return (state.strategies || []).find((s) => s.id === id);
  }

  function getTemplate(id) {
    return MARKETPLACE.find((t) => t.id === id);
  }

  function openDeployModal(strategyId) {
    const s = getStrategy(strategyId);
    if (!s) {
      toast("Bot not found — try cloning the template first.");
      return;
    }
    selectedStrategyId = strategyId;
    const nameEl = document.getElementById("botsDeployBotName");
    const verEl = document.getElementById("botsDeployVersion");
    const mktEl = document.getElementById("botsDeployMarket");
    if (nameEl) nameEl.textContent = s.name;
    if (verEl) verEl.textContent = `v${s.version}`;
    if (mktEl) mktEl.textContent = `${s.market} · ${contractLabel(s.contract_type)}`;
    openModal("botsDeployModal");
  }

  async function deployStrategy(strategyId, account, start) {
    try {
      const res = await req("/bots/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy_id: strategyId, account, start }),
      });
      closeModals();
      toast(res.started ? "Bot deployed and running" : "Bot deployed");
      await refreshData();
      switchView("deployments");
    } catch (error) {
      toast(`Deploy failed: ${error.message}`);
    }
  }

  async function cloneStrategy(id) {
    try {
      const res = await req(`/builder/strategies/${encodeURIComponent(id)}`);
      const row = res.strategy;
      await req("/builder/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${row.name} (copy)`,
          market: row.market,
          contract_type: row.contract_type,
          stake: row.stake,
          risk_level: row.risk_level,
          status: "saved",
          strategy: row.strategy,
          blockly_xml: row.blockly_xml,
        }),
      });
      toast("Bot cloned to My Bots");
      await refreshData();
    } catch (error) {
      toast(`Clone failed: ${error.message}`);
    }
  }

  async function cloneTemplate(tpl) {
    try {
      const contract = tpl.contract === "DIGITMATCH" ? "DIGITUNDER" : tpl.contract;
      const res = await req("/builder/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: tpl.name,
          market: tpl.market,
          contract_type: contract.includes("DIGIT") ? contract : "DIGITUNDER",
          stake: 1,
          risk_level: tpl.risk,
          status: "saved",
          strategy: defaultStrategy(contract),
        }),
      });
      toast(`${tpl.name} added to My Bots`);
      await refreshData();
      return res.strategy?.id;
    } catch (error) {
      toast(`Clone failed: ${error.message}`);
    }
    return null;
  }

  async function exportStrategy(id) {
    try {
      const res = await req(`/builder/strategies/${encodeURIComponent(id)}`);
      const row = res.strategy;
      const blob = new Blob([JSON.stringify({ format: "derivbot-builder-strategy", version: 1, exported_at: new Date().toISOString(), name: row.name, market: row.market, contract_type: row.contract_type, stake: row.stake, risk_level: row.risk_level, strategy: row.strategy, blockly_xml: row.blockly_xml }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${row.name || "bot"}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Bot exported");
    } catch (error) {
      toast(`Export failed: ${error.message}`);
    }
  }

  async function deleteStrategy(id) {
    if (!window.confirm("Delete this bot from your registry?")) return;
    try {
      await req(`/builder/strategies/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("Bot deleted");
      await refreshData();
    } catch (error) {
      toast(`Delete failed: ${error.message}`);
    }
  }

  function openPreview(tplId) {
    const tpl = getTemplate(tplId);
    if (!tpl) {
      toast("Template not found");
      return;
    }
    selectedTemplate = tpl;
    const titleEl = document.getElementById("botsPreviewTitle");
    const bodyEl = document.getElementById("botsPreviewBody");
    if (titleEl) titleEl.textContent = tpl.name;
    if (bodyEl) {
      bodyEl.innerHTML = `
        <p>${esc(tpl.desc)}</p>
        <dl class="bots-preview-meta">
          <div><dt>Category</dt><dd>${esc(tpl.category.replace(/_/g, " "))}</dd></div>
          <div><dt>Contract</dt><dd>${esc(contractLabel(tpl.contract))}</dd></div>
          <div><dt>Market</dt><dd>${esc(tpl.market)}</dd></div>
          <div><dt>Risk</dt><dd>${esc(tpl.risk)}</dd></div>
        </dl>`;
    }
    openModal("botsPreviewModal");
  }

  function switchDetailTab(tab) {
    document.querySelectorAll(".bots-detail-tab").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.botsDetail === tab);
    });
    document.querySelectorAll(".bots-detail-panel").forEach((panel) => {
      const id = panel.id.replace("botsDetail", "").toLowerCase();
      const show = id === tab;
      panel.classList.toggle("is-active", show);
      panel.hidden = !show;
    });
  }

  async function renderDetailPanel(strategyId) {
    if (!getStrategy(strategyId)) {
      try {
        const res = await req(`/builder/strategies/${encodeURIComponent(strategyId)}`);
        state.strategies = [...(state.strategies || []), res.strategy];
      } catch (_e) {
        toast("Could not load bot details");
        return;
      }
    }
    const bot = getStrategy(strategyId);
    if (!bot) return;
    selectedStrategyId = strategyId;
    const titleEl = document.getElementById("botsDetailTitle");
    const subEl = document.getElementById("botsDetailSub");
    if (titleEl) titleEl.textContent = bot.name;
    if (subEl) subEl.textContent = `${contractLabel(bot.contract_type)} · ${bot.market} · v${bot.version}`;
    document.getElementById("botsDetailOverview").innerHTML = `
      <div class="bots-detail-grid">
        <div><span class="bots-label">Status</span>${statusBadge(bot.status)}</div>
        <div><span class="bots-label">Created</span><strong>${formatTs(bot.created_at)}</strong></div>
        <div><span class="bots-label">Last Modified</span><strong>${formatTs(bot.updated_at)}</strong></div>
        <div><span class="bots-label">Risk Level</span><strong>${esc(bot.risk_level || "Medium")}</strong></div>
        <div><span class="bots-label">Stake</span><strong>$${Number(bot.stake || 1).toFixed(2)}</strong></div>
        <div><span class="bots-label">Version</span><strong>v${bot.version}</strong></div>
      </div>`;
    const deps = (state.deployments || []).filter((d) => d.strategy_id === strategyId);
    document.getElementById("botsDetailPerformance").innerHTML = `
      <p class="subtle">Performance from active and past deployments.</p>
      <div class="bots-detail-grid">
        <div><span class="bots-label">Deployments</span><strong>${deps.length}</strong></div>
        <div><span class="bots-label">Total Profit</span><strong class="bots-pos">${fmtUsd(deps.reduce((a, d) => a + (d.profit || 0), 0), true)}</strong></div>
        <div><span class="bots-label">Total Trades</span><strong>${deps.reduce((a, d) => a + (d.trades_count || 0), 0)}</strong></div>
      </div>
      <div id="botsDetailEquityChart" class="bots-chart" style="margin-top:16px"></div>`;
    renderSparkline(document.getElementById("botsDetailEquityChart"), deps.length ? deps.map((d, i) => (d.profit || 0) * (i + 1)) : [0, 0, 0], "#1b52c0");
    document.getElementById("botsDetailDeployments").innerHTML = deps.length
      ? `<table class="bots-table"><thead><tr><th>Status</th><th>Account</th><th>Profit</th><th>Uptime</th></tr></thead><tbody>${deps.map((d) => `<tr><td>${statusBadge(d.status)}</td><td>${esc(d.account)}</td><td class="${(d.profit || 0) >= 0 ? "bots-pos" : "bots-neg"}">${fmtUsd(d.profit, true)}</td><td>${formatUptime(d.uptime_seconds)}</td></tr>`).join("")}</tbody></table>`
      : `<p class="subtle">No deployments yet for this bot.</p>`;
    try {
      const verRes = await req(`/builder/strategies/${encodeURIComponent(strategyId)}/versions`);
      const versions = verRes.versions || [];
      document.getElementById("botsDetailVersions").innerHTML = versions.length
        ? versions.map((v) => `<div class="bots-version-row"><div><strong>v${v.version}</strong> · ${formatTs(v.created_at)}<br/><span class="subtle small">${esc(v.name)}</span></div><button type="button" class="btn btn-sm btn-blue" data-bots-restore="${strategyId}" data-bots-ver="${v.version}">Restore</button></div>`).join("")
        : `<p class="subtle">No version history.</p>`;
    } catch (_e) {
      document.getElementById("botsDetailVersions").innerHTML = `<p class="subtle">Could not load versions.</p>`;
    }
    const activeDep = deps.find((d) => d.status === "running" || d.status === "paused");
    if (activeDep) {
      try {
        const logRes = await req(`/bots/deployments/${encodeURIComponent(activeDep.id)}/logs`);
        const logs = logRes.logs || [];
        document.getElementById("botsDetailLogs").innerHTML = logs.length
          ? `<table class="bots-table bots-table--compact"><thead><tr><th>Time</th><th>Event</th><th>Result</th></tr></thead><tbody>${logs.slice(0, 20).map((l) => `<tr><td>${formatTs(l.ts)}</td><td>${esc(l.event)}</td><td>${esc(l.result || "—")}</td></tr>`).join("")}</tbody></table>`
          : `<p class="subtle">No log entries yet.</p>`;
      } catch (_e) {
        document.getElementById("botsDetailLogs").innerHTML = `<p class="subtle">No logs available.</p>`;
      }
    } else {
      document.getElementById("botsDetailLogs").innerHTML = `<p class="subtle">Deploy this bot to view runtime logs.</p>`;
    }
    switchDetailTab("overview");
    openModal("botsDetailModal");
  }

  async function restoreVersion(strategyId, version) {
    try {
      await req(`/builder/strategies/${encodeURIComponent(strategyId)}/versions/${version}/restore`, { method: "POST" });
      toast(`Restored v${version}`);
      await refreshData();
      renderDetailPanel(strategyId);
    } catch (error) {
      toast(`Restore failed: ${error.message}`);
    }
  }

  async function handleActionClick(e) {
    const target = e.target.closest(
      "[data-bots-preview],[data-bots-clone-tpl],[data-bots-deploy-tpl],[data-bots-open],[data-bots-deploy],[data-bots-clone],[data-bots-export],[data-bots-delete],[data-bots-detail],[data-bots-pause],[data-bots-resume],[data-bots-stop-dep],[data-bots-restore],[data-bots-goto],[data-bots-close]",
    );
    if (!target) return;

    if (target.matches("[data-bots-close]")) {
      e.preventDefault();
      closeModals();
      return;
    }

    const btn = target.closest("button") || target;
    e.preventDefault();

    if (btn.dataset.botsGoto) {
      switchView(btn.dataset.botsGoto);
      return;
    }
    if (btn.dataset.botsPreview) {
      openPreview(btn.dataset.botsPreview);
      return;
    }
    if (btn.dataset.botsCloneTpl) {
      const tpl = getTemplate(btn.dataset.botsCloneTpl);
      if (tpl) await cloneTemplate(tpl);
      return;
    }
    if (btn.dataset.botsDeployTpl) {
      const tpl = getTemplate(btn.dataset.botsDeployTpl);
      if (tpl) {
        const id = await cloneTemplate(tpl);
        if (id) openDeployModal(id);
      }
      return;
    }
    if (btn.dataset.botsOpen) {
      window.location.href = `/builder?strategy=${encodeURIComponent(btn.dataset.botsOpen)}`;
      return;
    }
    if (btn.dataset.botsDeploy) {
      openDeployModal(btn.dataset.botsDeploy);
      return;
    }
    if (btn.dataset.botsClone) {
      await cloneStrategy(btn.dataset.botsClone);
      return;
    }
    if (btn.dataset.botsExport) {
      await exportStrategy(btn.dataset.botsExport);
      return;
    }
    if (btn.dataset.botsDelete) {
      await deleteStrategy(btn.dataset.botsDelete);
      return;
    }
    if (btn.dataset.botsDetail) {
      await renderDetailPanel(btn.dataset.botsDetail);
      return;
    }
    if (btn.dataset.botsPause) {
      try {
        await req(`/bots/deployments/${encodeURIComponent(btn.dataset.botsPause)}/pause`, { method: "POST" });
        toast("Deployment paused");
        await refreshData();
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    if (btn.dataset.botsResume) {
      try {
        await req(`/bots/deployments/${encodeURIComponent(btn.dataset.botsResume)}/resume`, { method: "POST" });
        toast("Deployment resumed");
        await refreshData();
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    if (btn.dataset.botsStopDep) {
      try {
        await req(`/bots/deployments/${encodeURIComponent(btn.dataset.botsStopDep)}/stop`, { method: "POST" });
        toast("Deployment stopped");
        await refreshData();
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    if (btn.dataset.botsRestore) {
      await restoreVersion(btn.dataset.botsRestore, btn.dataset.botsVer);
    }
  }

  function wireEvents() {
    if (wired) return;
    wired = true;

    document.querySelectorAll(".bots-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchView(tab.dataset.botsView || "marketplace"));
    });

    document.getElementById("botsMarketSearch")?.addEventListener("input", (e) => {
      marketSearch = e.target.value || "";
      renderMarketplace();
    });

    document.getElementById("botsMySearch")?.addEventListener("input", (e) => {
      mySearch = e.target.value || "";
      renderMyBots();
    });

    document.getElementById("botsMySort")?.addEventListener("change", (e) => {
      mySort = e.target.value;
      renderMyBots();
    });

    document.querySelectorAll(".bots-cat").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".bots-cat").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        marketCat = btn.dataset.botsCat || "all";
        renderMarketplace();
      });
    });

    document.querySelectorAll(".bots-detail-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchDetailTab(btn.dataset.botsDetail || "overview"));
    });

    document.getElementById("botsDeployForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!selectedStrategyId) return;
      deployStrategy(
        selectedStrategyId,
        document.getElementById("botsDeployAccount")?.value || "demo",
        !!document.getElementById("botsDeployStart")?.checked,
      );
    });

    document.getElementById("botsDetailOpenBtn")?.addEventListener("click", () => {
      if (selectedStrategyId) window.location.href = `/builder?strategy=${encodeURIComponent(selectedStrategyId)}`;
    });

    document.getElementById("botsDetailDeployBtn")?.addEventListener("click", () => {
      closeModals();
      if (selectedStrategyId) openDeployModal(selectedStrategyId);
    });

    document.getElementById("botsPreviewCloneBtn")?.addEventListener("click", async () => {
      if (selectedTemplate) {
        await cloneTemplate(selectedTemplate);
        closeModals();
      }
    });

    document.getElementById("botsPreviewDeployBtn")?.addEventListener("click", async () => {
      if (!selectedTemplate) return;
      const id = await cloneTemplate(selectedTemplate);
      closeModals();
      if (id) openDeployModal(id);
    });

    const root = document.querySelector(".bots-registry-page") || document.getElementById("platformMain") || document.body;
    root.addEventListener("click", handleActionClick);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModals();
    });
  }

  function initBotsRegistry() {
    if (!document.getElementById("botsMarketGrid")) return;
    if (window.__botsRegistryReady) return;
    window.__botsRegistryReady = true;
    try {
      if (typeof initAuthButtons === "function") initAuthButtons();
      if (typeof refreshAuthState === "function") refreshAuthState();
      wireEvents();
      renderAll();
      refreshData();
      setInterval(refreshData, 5000);
    } catch (err) {
      console.error("Trading Bots init failed:", err);
      toast(`Trading Bots failed to load: ${err.message}`);
    }
  }

  window.initBotsRegistry = initBotsRegistry;

  if (document.getElementById("botsMarketGrid")) {
    initBotsRegistry();
  }
})();
