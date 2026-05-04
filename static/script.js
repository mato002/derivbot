const toastEl = document.getElementById("toast");
let lastSeenResult = "-";
let profitChart;

function escapeHtml(text) {
  const s = String(text ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Deriv-style stacked notifications (contract purchased / win / loss). */
function showTradeAlert(alert) {
  const stack = document.getElementById("tradeNotifyStack");
  if (!stack || !alert) return;
  const el = document.createElement("div");
  el.className = "trade-notify";
  if (alert.kind === "opened") {
    el.classList.add("trade-notify--open");
  } else if (alert.kind === "closed") {
    el.classList.add(alert.won ? "trade-notify--win" : "trade-notify--loss");
  }
  el.innerHTML = `
    <button type="button" class="trade-notify-close" aria-label="Dismiss">&times;</button>
    <div class="trade-notify-title">${escapeHtml(alert.title)}</div>
    <div class="trade-notify-body">${escapeHtml(alert.body)}</div>
  `;
  const removeEl = () => {
    try {
      el.remove();
    } catch (_e) {
      /* ignore */
    }
  };
  el.querySelector(".trade-notify-close")?.addEventListener("click", removeEl);
  stack.appendChild(el);
  if (alert.kind === "closed") {
    const dur = Number(alert.duration_sec ?? NaN);
    const durText = Number.isFinite(dur) ? ` (${dur.toFixed(2)}s)` : "";
    showToast(`${alert.title}: ${alert.body}${durText}`, 3200);
  }
  while (stack.children.length > 5) {
    stack.removeChild(stack.firstChild);
  }
  window.setTimeout(removeEl, 6800);
}

function showToast(message, durationMs = 2300) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  window.setTimeout(() => toastEl.classList.add("hidden"), durationMs);
}

function setLoading(button, isLoading) {
  if (button) {
    button.disabled = isLoading;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.detail || payload?.error || "";
    } catch (_e) {
      // ignore non-json error bodies
    }
    throw new Error(detail ? `${detail} (${response.status})` : `Request failed (${response.status})`);
  }
  return response.json();
}

/** Last `/auth/deriv/me` payload (no tokens); used by account UI. */
let lastDerivMe = null;
/** Last resolved Deriv account balance (for dashboard Balance card). */
let lastDerivBalance = null;
let accountSwitchInFlight = false;

function updateAccountModeBar(auth) {
  void auth;
}

function formatAccountBalance(row) {
  if (!row) return "--";
  const bal = Number(row.balance ?? NaN);
  if (!Number.isFinite(bal)) return "--";
  const ccy = row.currency ?? "";
  return `${bal.toFixed(2)} ${ccy}`.trim();
}

function wireProfileMenuOnce() {
  const wrap = document.getElementById("profileMenuWrap");
  const btn = document.getElementById("profileMenuBtn");
  const menu = document.getElementById("profileMenuDropdown");
  const logoutInMenu = document.getElementById("logoutDerivMenuBtn");
  if (!wrap || !btn || !menu || wrap.dataset.wired === "1") return;
  wrap.dataset.wired = "1";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) {
      menu.classList.add("hidden");
    }
  });
  logoutInMenu?.addEventListener("click", async () => {
    try {
      await requestJson("/auth/deriv/logout", { method: "POST" });
      showToast("Logged out");
      await refreshAuthState();
    } catch (error) {
      showToast(`Logout failed: ${error.message}`);
    } finally {
      menu.classList.add("hidden");
    }
  });
}

function wireHeaderWalletMenuOnce() {
  const btn = document.getElementById("headerWalletBtn");
  const menu = document.getElementById("headerWalletDropdown");
  const logoutBtn = document.getElementById("headerWalletLogoutBtn");
  const loginBtn = document.getElementById("headerWalletLoginBtn");
  if (!btn || !menu || btn.dataset.wired === "1") return;
  btn.dataset.wired = "1";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const next = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !next);
    btn.setAttribute("aria-expanded", next ? "true" : "false");
  });
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  });
  logoutBtn?.addEventListener("click", async () => {
    try {
      await requestJson("/auth/deriv/logout", { method: "POST" });
      showToast("Logged out");
      await refreshAuthState();
    } catch (error) {
      showToast(`Logout failed: ${error.message}`);
    } finally {
      menu.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  });
  loginBtn?.addEventListener("click", () => {
    window.location.href = "/auth/deriv/login";
  });
}

async function switchDerivAccount(accountId) {
  await requestJson("/auth/deriv/select-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: accountId }),
  });
}

function renderProfileMenu(auth) {
  const wrap = document.getElementById("profileMenuWrap");
  const btn = document.getElementById("profileMenuBtn");
  const menu = document.getElementById("profileMenuDropdown");
  const current = document.getElementById("profileMenuCurrent");
  const list = document.getElementById("profileMenuAccounts");
  if (!wrap || !btn || !menu || !current || !list) return;

  if (!auth?.logged_in || !auth?.account) {
    wrap.classList.add("hidden");
    menu.classList.add("hidden");
    current.textContent = "Not logged in";
    list.innerHTML = "";
    return;
  }

  wrap.classList.remove("hidden");
  const active = auth.account;
  const tag = active.kind === "real" ? "Real" : "Demo";
  const balLine = formatAccountBalance(active);
  btn.textContent = `${tag} • ${balLine}`;
  current.textContent = `${active.account} (${tag})`;

  list.innerHTML = "";
  const rows = (auth.accounts || []).filter((row) => row && row.account);
  rows.forEach((row) => {
    const rowBtn = document.createElement("button");
    rowBtn.type = "button";
    rowBtn.className = "profile-menu__account-row";
    if (row.account === active.account) {
      rowBtn.classList.add("profile-menu__account-row--active");
    }
    const rowTag = row.kind === "real" ? "Real" : "Demo";
    rowBtn.innerHTML = `
      <span class="profile-menu__row-main">${escapeHtml(row.account || "Account")} (${rowTag})</span>
      <span class="profile-menu__row-sub">${escapeHtml(formatAccountBalance(row))}</span>
    `;
    rowBtn.addEventListener("click", async () => {
      if (accountSwitchInFlight || row.account === active.account) {
        menu.classList.add("hidden");
        return;
      }
      try {
        accountSwitchInFlight = true;
        await switchDerivAccount(row.account);
        showToast(`Switched to ${rowTag} account`);
        await refreshAuthState();
      } catch (err) {
        showToast(err.message || "Could not switch account");
      } finally {
        accountSwitchInFlight = false;
        menu.classList.add("hidden");
      }
    });
    list.appendChild(rowBtn);
  });
}

function renderHeaderWalletMenu(auth) {
  const btn = document.getElementById("headerWalletBtn");
  const loginBtn = document.getElementById("headerWalletLoginBtn");
  const menu = document.getElementById("headerWalletDropdown");
  const current = document.getElementById("headerWalletCurrent");
  const list = document.getElementById("headerWalletAccounts");
  const chipEl = document.getElementById("headerWalletBalance");
  if (!btn || !menu || !current || !list || !chipEl || !loginBtn) return;

  if (!auth?.logged_in || !auth?.account) {
    btn.classList.add("hidden");
    loginBtn.classList.remove("hidden");
    menu.classList.add("hidden");
    current.textContent = "Not logged in";
    list.innerHTML = "";
    chipEl.textContent = "--";
    return;
  }

  btn.classList.remove("hidden");
  loginBtn.classList.add("hidden");
  const active = auth.account;
  const tag = active.kind === "real" ? "Real" : "Demo";
  const balLine = formatAccountBalance(active);
  current.textContent = `${active.account} (${tag})`;
  if (balLine && balLine !== "--") {
    chipEl.textContent = balLine;
  }

  list.innerHTML = "";
  const rows = (auth.accounts || []).filter((row) => row && row.account);
  rows.forEach((row) => {
    const rowBtn = document.createElement("button");
    rowBtn.type = "button";
    rowBtn.className = "profile-menu__account-row";
    if (row.account === active.account) {
      rowBtn.classList.add("profile-menu__account-row--active");
    }
    const rowTag = row.kind === "real" ? "Real" : "Demo";
    rowBtn.innerHTML = `
      <span class="profile-menu__row-main">${escapeHtml(row.account || "Account")} (${rowTag})</span>
      <span class="profile-menu__row-sub">${escapeHtml(formatAccountBalance(row))}</span>
    `;
    rowBtn.addEventListener("click", async () => {
      if (accountSwitchInFlight || row.account === active.account) {
        menu.classList.add("hidden");
        btn.setAttribute("aria-expanded", "false");
        return;
      }
      try {
        accountSwitchInFlight = true;
        await switchDerivAccount(row.account);
        showToast(`Switched to ${rowTag} account`);
        await refreshAuthState();
      } catch (err) {
        showToast(err.message || "Could not switch account");
      } finally {
        accountSwitchInFlight = false;
        menu.classList.add("hidden");
        btn.setAttribute("aria-expanded", "false");
      }
    });
    list.appendChild(rowBtn);
  });
}

async function refreshAuthState() {
  if (accountSwitchInFlight) return;
  const authAccountEl = document.getElementById("authAccount");
  const derivAccountBalanceEl = document.getElementById("derivBalance");
  const loginBtn = document.getElementById("loginDerivBtn");
  const chipEl = document.getElementById("headerWalletBalance");

  function setDerivAccountMetric(text) {
    if (derivAccountBalanceEl) {
      derivAccountBalanceEl.textContent = text;
    }
  }

  let headerWalletText = "--";

  try {
    const auth = await requestJson("/auth/deriv/me");
    lastDerivMe = auth;
    updateAccountModeBar(auth);
    renderProfileMenu(auth);
    renderHeaderWalletMenu(auth);

    if (!loginBtn) {
      if (chipEl) chipEl.textContent = headerWalletText;
      return;
    }

    if (auth.logged_in && auth.account) {
      const account = auth.account.account ?? "Account";
      const currency = auth.account.currency ?? "";
      const tag = auth.account.kind === "real" ? "Real" : "Demo";
      if (authAccountEl) {
        authAccountEl.textContent = `${account} ${currency} (${tag})`.trim();
      }
      loginBtn.classList.add("hidden");
      try {
        const balanceData = await requestJson("/auth/deriv/balance");
        const balance = Number(balanceData.balance?.balance ?? 0).toFixed(2);
        const balanceCurrency = balanceData.balance?.currency ?? currency ?? "";
        const line = `${balance} ${balanceCurrency}`.trim();
        const balNum = Number(balanceData.balance?.balance ?? NaN);
        lastDerivBalance = Number.isFinite(balNum) ? balNum : null;
        headerWalletText = line;
        if (derivAccountBalanceEl) {
          setDerivAccountMetric(`Deriv balance: ${line}`);
        }
      } catch (_error) {
        lastDerivBalance = null;
        headerWalletText = "--";
        if (derivAccountBalanceEl) {
          setDerivAccountMetric("Deriv balance: unavailable");
        }
      }
    } else {
      lastDerivBalance = null;
      renderProfileMenu({ logged_in: false, account: null, accounts: [] });
      renderHeaderWalletMenu({ logged_in: false, account: null, accounts: [] });
      if (authAccountEl) {
        authAccountEl.textContent = "Not logged in";
      }
      loginBtn.classList.remove("hidden");
      headerWalletText = "--";
      if (derivAccountBalanceEl) {
        setDerivAccountMetric("Deriv balance: --");
      }
    }
  } catch (_error) {
    lastDerivMe = null;
    lastDerivBalance = null;
    renderProfileMenu({ logged_in: false, account: null, accounts: [] });
    renderHeaderWalletMenu({ logged_in: false, account: null, accounts: [] });
    if (authAccountEl) {
      authAccountEl.textContent = "Auth unavailable";
    }
    headerWalletText = "--";
    if (derivAccountBalanceEl) {
      setDerivAccountMetric("Deriv balance: unavailable");
    }
    updateAccountModeBar({ logged_in: false, accounts: [] });
  }

  if (chipEl) {
    chipEl.textContent = headerWalletText;
  }
}

wireProfileMenuOnce();
wireHeaderWalletMenuOnce();

function initAuthButtons() {
  const loginBtn = document.getElementById("loginDerivBtn");
  const headerLoginBtn = document.getElementById("headerWalletLoginBtn");
  const onLogin = () => {
    window.location.href = "/auth/deriv/login";
  };
  loginBtn?.addEventListener("click", onLogin);
  headerLoginBtn?.addEventListener("click", onLogin);
}

function applyHybridBannerFromStatus(status) {
  const hybridBanner = document.getElementById("hybridBanner");
  if (!hybridBanner) return;
  if (status.hybrid_paused) {
    hybridBanner.classList.remove("hidden");
    hybridBanner.textContent =
      "Hybrid mode: automatic bot entries are paused briefly after a manual trade.";
  } else {
    hybridBanner.classList.add("hidden");
  }
}

function applyConfluenceLive(status) {
  const cf = status.confluence;
  const modeEl = document.getElementById("confMarketMode");
  const sigEl = document.getElementById("confSignal");
  const pctEl = document.getElementById("confConfidence");
  const fill = document.getElementById("confMeterFill");
  const entryEl = document.getElementById("confEntry");
  const ul = document.getElementById("confReasons");
  if (!modeEl) return;
  if (!cf) {
    modeEl.textContent = "—";
    if (sigEl) sigEl.textContent = "—";
    if (pctEl) pctEl.textContent = "0";
    if (fill) fill.style.width = "0%";
    if (entryEl) entryEl.textContent = "—";
    if (ul) ul.innerHTML = "";
    return;
  }
  modeEl.textContent = cf.marketMode ?? "—";
  if (sigEl) sigEl.textContent = cf.signal ?? "—";
  const pct = Math.min(100, Math.max(0, Number(cf.confidence ?? 0)));
  if (pctEl) pctEl.textContent = String(Math.round(pct));
  if (fill) fill.style.width = `${pct}%`;
  if (entryEl) entryEl.textContent = cf.entry_allowed ? "Allowed" : "Blocked";
  if (ul) {
    ul.innerHTML = "";
    (cf.reasons || []).forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      ul.appendChild(li);
    });
  }
}

async function refreshDiagnostics() {
  const oauthEl = document.getElementById("diagOauthClient");
  if (!oauthEl) return;
  const wsEl = document.getElementById("diagWsAppId");
  const loginEl = document.getElementById("diagLoginState");
  const marketEl = document.getElementById("diagMarketData");
  const detailEl = document.getElementById("diagDetail");
  const setState = (el, text, state) => {
    if (!el) return;
    el.textContent = text;
    el.classList.add("diag-state");
    el.classList.remove("diag-state--ok", "diag-state--warn", "diag-state--error");
    el.classList.add(`diag-state--${state}`);
  };
  try {
    const d = await requestJson("/diagnostics");
    setState(
      oauthEl,
      d.oauth_client_configured ? `Configured (${d.oauth_client_preview || "hidden"})` : "Missing",
      d.oauth_client_configured ? "ok" : "error"
    );
    setState(wsEl, d.ws_app_id_numeric ? String(d.ws_app_id) : `${d.ws_app_id} (invalid)`, d.ws_app_id_numeric ? "ok" : "error");
    setState(
      loginEl,
      d.logged_in ? `${d.active_account?.account ?? "Logged in"} (${d.active_account?.kind ?? "?"})` : "Not logged in",
      d.logged_in ? "ok" : "warn"
    );
    setState(marketEl, d.market_data_ok ? "OK" : "Error", d.market_data_ok ? "ok" : "error");
    if (detailEl) {
      detailEl.textContent = d.market_data_ok
        ? "Market-data WebSocket handshake and tick fetch succeeded."
        : (d.market_data_error || "Market-data ping failed.");
    }
  } catch (error) {
    setState(oauthEl, "Unavailable", "warn");
    setState(wsEl, "Unavailable", "warn");
    setState(loginEl, "Unavailable", "warn");
    setState(marketEl, "Unavailable", "warn");
    if (detailEl) detailEl.textContent = error.message || "Diagnostics failed.";
  }
}

function syncConfluenceFormFromStatus(status) {
  const root = document.getElementById("confEnabled");
  if (!root) return;
  const strat = status.strategy || {};
  const ccfg = strat.confluence || {};
  const pick = (k, def = true) => (ccfg[k] === undefined ? def : !!ccfg[k]);
  const el = (id) => document.getElementById(id);
  const cE = el("confEnabled");
  if (cE) cE.checked = pick("enabled", true);
  const cT = el("confTrend");
  if (cT) cT.checked = pick("use_trend", true);
  const cS = el("confSr");
  if (cS) cS.checked = pick("use_sr", true);
  const cR = el("confRsi");
  if (cR) cR.checked = pick("use_rsi", true);
  const cC = el("confCandle");
  if (cC) cC.checked = pick("use_candles", true);
  const cRg = el("confRange");
  if (cRg) cRg.checked = pick("use_range", true);
}

function wireManualTraderUi(onAfterAction) {
  const manualRoot = document.getElementById("manualTradeBtn");
  if (!manualRoot) return;
  const manualContractEl = document.getElementById("manualContract");
  const manualBarrierEl = document.getElementById("manualBarrier");
  const manualStakeEl = document.getElementById("manualStake");
  const manualRiskModeEl = document.getElementById("manualRiskMode");
  const manualRiskPercentEl = document.getElementById("manualRiskPercent");
  const manualStopLossEl = document.getElementById("manualStopLoss");
  const manualTakeProfitEl = document.getElementById("manualTakeProfit");
  const manualBtn = document.getElementById("manualTradeBtn");
  const modeToggle = document.getElementById("manualModeToggle");
  const digitSampleEl = document.getElementById("digitPredictionSample");

  const ouOverBtn = document.getElementById("ouOverBtn");
  const ouUnderBtn = document.getElementById("ouUnderBtn");
  const digitGrid = document.getElementById("digitGrid");
  const digitPointer = document.getElementById("digitPointer");
  const paneToTradeBtn = document.getElementById("paneToTrade");
  const paneToChartBtn = document.getElementById("paneToChart");
  const liveTickDigitEl = document.getElementById("liveTickDigit");
  const liveTickPriceEl = document.getElementById("liveTickPrice");
  const liveTickPriceStrongEl = document.getElementById("liveTickPriceStrong");
  const trendEl = document.getElementById("manualTrend");
  const volatilityEl = document.getElementById("manualVolatility");
  const maEl = document.getElementById("manualMa");
  const rsiEl = document.getElementById("manualRsi");
  const payoutEl = document.getElementById("manualPotentialPayout");
  const profitEl = document.getElementById("manualPotentialProfit");
  const probEl = document.getElementById("manualImpliedProb");
  const afterStakeEl = document.getElementById("manualBalanceAfterStake");
  const riskWarningEl = document.getElementById("manualRiskWarning");
  const accountStateEl = document.getElementById("manualAccountState");
  const historyBodyEl = document.getElementById("manualHistoryBody");

  let manualEnabled = true;
  let manualModeOn = true;
  let manualSubmitting = false;
  let liveBalance = null;
  let lastQuote = null;
  let recentPoints = [];
  let manualSeries;
  let maSeries;
  let chart;
  let digitSampleSize = Number(digitSampleEl?.value ?? 120) || 120;

  function extractLastDigit(value) {
    const s = String(value ?? "");
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const ch = s[i];
      if (ch >= "0" && ch <= "9") return Number(ch);
    }
    return null;
  }

  function updateManualEnableState() {
    const disabled = !manualEnabled;
    [manualContractEl, manualBarrierEl, manualStakeEl, manualRiskModeEl, manualRiskPercentEl, manualStopLossEl, manualTakeProfitEl]
      .forEach((el) => {
        if (el) el.disabled = disabled;
      });
    if (manualBtn) manualBtn.disabled = disabled;
    if (modeToggle) modeToggle.textContent = manualEnabled ? "Manual mode" : "Auto-bot mode";
    const card = document.querySelector(".manual-trade-card");
    if (card) card.classList.toggle("manual-trade-disabled", disabled);
  }

  function syncOuButtons() {
    const v = manualContractEl?.value;
    if (ouOverBtn) ouOverBtn.classList.toggle("ou-btn--active", v === "DIGITOVER");
    if (ouUnderBtn) ouUnderBtn.classList.toggle("ou-btn--active", v === "DIGITUNDER");
  }

  function syncDigitGrid() {
    if (!digitGrid || !manualBarrierEl) return;
    const d = String(manualBarrierEl.value);
    digitGrid.querySelectorAll(".digit-cell").forEach((cell) => {
      cell.classList.toggle("digit-cell--active", cell.dataset.digit === d);
    });
  }

  function setManualPane(mode) {
    const isMobile = window.matchMedia("(max-width: 920px)").matches;
    if (!isMobile) {
      document.body.classList.remove("manual-show-chart");
      return;
    }
    document.body.classList.toggle("manual-show-chart", mode === "chart");
    if (mode === "chart") {
      window.setTimeout(() => {
        const chartEl = document.getElementById("manualPriceChart");
        if (chart && chartEl) {
          const w = Math.max(280, chartEl.clientWidth || 0);
          chart.resize(w, 260);
          chart.timeScale().fitContent();
        }
        refreshLiveContext();
      }, 80);
    }
  }


  function ensureDigitCellStructure() {
    if (!digitGrid) return;
    digitGrid.querySelectorAll(".digit-cell").forEach((cell) => {
      if (cell.querySelector(".digit-cell-digit")) return;
      const d = cell.dataset.digit ?? cell.textContent.trim();
      cell.textContent = "";
      const digitEl = document.createElement("span");
      digitEl.className = "digit-cell-digit";
      digitEl.textContent = d;
      const pctEl = document.createElement("span");
      pctEl.className = "digit-cell-pct";
      pctEl.textContent = "--";
      cell.appendChild(digitEl);
      cell.appendChild(pctEl);
    });
  }

  function renderDigitPrediction(points) {
    if (!digitGrid) return;
    ensureDigitCellStructure();
    const counts = Array.from({ length: 10 }, () => 0);
    const sample = (points || []).slice(-digitSampleSize);
    sample.forEach((p) => {
      const d = extractLastDigit(p?.price);
      if (d != null && d >= 0 && d <= 9) counts[d] += 1;
    });
    const total = counts.reduce((a, b) => a + b, 0);
    const max = Math.max(...counts);
    digitGrid.querySelectorAll(".digit-cell").forEach((cell) => {
      const d = Number(cell.dataset.digit);
      const pctEl = cell.querySelector(".digit-cell-pct");
      const pct = total > 0 && !Number.isNaN(d) ? (counts[d] / total) * 100 : 0;
      if (pctEl) pctEl.textContent = total > 0 ? `${pct.toFixed(1)}%` : "--";
      const hot = total > 0 && counts[d] === max && max > 0;
      cell.classList.toggle("digit-cell--hot", hot);
    });
  }

  function movePointerToDigit(digit) {
    if (!digitGrid || !digitPointer) return;
    const target = digitGrid.querySelector(`.digit-cell[data-digit="${digit}"]`);
    if (!target) return;
    const gridRect = digitGrid.getBoundingClientRect();
    const cellRect = target.getBoundingClientRect();
    const x = Math.round(cellRect.left - gridRect.left + cellRect.width / 2);
    digitPointer.style.transform = `translateX(${x}px)`;
    digitPointer.classList.remove("hidden");
    digitGrid.querySelectorAll(".digit-cell").forEach((cell) => {
      cell.classList.toggle("digit-cell--tick", cell === target);
    });
  }

  function computeTrend(points) {
    if (!points || points.length < 8) return "Sideways";
    const first = Number(points[Math.max(0, points.length - 15)].price ?? 0);
    const last = Number(points[points.length - 1].price ?? 0);
    if (!first || !last) return "Sideways";
    const pct = ((last - first) / first) * 100;
    if (pct > 0.08) return "Up";
    if (pct < -0.08) return "Down";
    return "Sideways";
  }

  function computeVolatility(points) {
    if (!points || points.length < 10) return null;
    const vals = points.slice(-25).map((p) => Number(p.price ?? 0)).filter((x) => x > 0);
    if (vals.length < 10) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return (Math.sqrt(variance) / mean) * 100;
  }

  function renderManualChart(points) {
    const chartEl = document.getElementById("manualPriceChart");
    if (!chartEl || typeof LightweightCharts === "undefined") return;
    if (!chart) {
      chart = LightweightCharts.createChart(chartEl, {
        layout: { background: { type: "solid", color: "#ffffff" }, textColor: "#1a2634" },
        grid: { vertLines: { color: "#e6e9ef" }, horzLines: { color: "#e6e9ef" } },
        rightPriceScale: { borderColor: "#e6e9ef" },
        timeScale: { borderColor: "#e6e9ef" },
        height: 260,
      });
      manualSeries = chart.addLineSeries({ color: "#1b52c0", lineWidth: 2 });
      maSeries = chart.addLineSeries({ color: "#4caaa4", lineWidth: 1 });
    }
    const priceData = points
      .filter((p) => p.time != null && p.price != null)
      .map((p) => ({ time: Number(p.time), value: Number(p.price) }));
    if (!priceData.length) return;
    manualSeries.setData(priceData);
    const maData = points
      .filter((p) => p.time != null && p.ma20 != null)
      .map((p) => ({ time: Number(p.time), value: Number(p.ma20) }));
    maSeries.setData(maData);
  }

  function updateRiskPreview() {
    const stake = Number(manualStakeEl?.value ?? 0);
    if (afterStakeEl) {
      if (liveBalance == null || Number.isNaN(stake)) {
        afterStakeEl.textContent = "--";
      } else {
        afterStakeEl.textContent = `${(liveBalance - stake).toFixed(2)}`;
      }
    }
    const warnings = [];
    if (liveBalance != null && stake > 0) {
      const ratio = (stake / liveBalance) * 100;
      if (ratio >= 10) warnings.push(`Stake is ${ratio.toFixed(1)}% of balance (high risk).`);
    }
    const sl = Number(manualStopLossEl?.value ?? 0);
    const tp = Number(manualTakeProfitEl?.value ?? 0);
    if (sl > 0 && tp > 0 && tp < sl * 0.5) {
      warnings.push("Take Profit is very small vs Stop Loss.");
    }
    if (riskWarningEl) {
      if (warnings.length) {
        riskWarningEl.classList.remove("hidden");
        riskWarningEl.textContent = warnings.join(" ");
      } else {
        riskWarningEl.classList.add("hidden");
        riskWarningEl.textContent = "";
      }
    }
  }

  async function refreshQuote() {
    if (!manualContractEl || !manualBarrierEl || !manualStakeEl) return;
    const stake = Number(manualStakeEl.value);
    if (!stake || stake <= 0) {
      lastQuote = null;
      if (payoutEl) payoutEl.textContent = "--";
      if (profitEl) profitEl.textContent = "--";
      if (probEl) probEl.textContent = "--";
      updateRiskPreview();
      return;
    }
    try {
      const quote = await requestJson("/manual-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_type: manualContractEl.value,
          barrier: Number(manualBarrierEl.value),
          stake,
          symbol: "R_100",
        }),
      });
      lastQuote = quote;
      if (payoutEl) payoutEl.textContent = `${Number(quote.payout ?? 0).toFixed(2)} USD`;
      if (profitEl) profitEl.textContent = `${Number(quote.profit ?? 0).toFixed(2)} USD`;
      if (probEl) probEl.textContent = `${Number(quote.implied_probability ?? 0).toFixed(2)}%`;
    } catch (_err) {
      lastQuote = null;
    } finally {
      updateRiskPreview();
    }
  }

  async function refreshLiveContext() {
    try {
      const res = await requestJson("/market-data?symbol=R_100&timeframe=tick");
      if (!res?.success) return;
      const points = res?.data?.points || [];
      if (!points.length) return;
      recentPoints = points;
      renderManualChart(points);
      renderDigitPrediction(points);
      const latest = points[points.length - 1];
      const digit = extractLastDigit(latest.price);
      if (digit != null) {
        if (liveTickDigitEl) liveTickDigitEl.textContent = String(digit);
        movePointerToDigit(digit);
      }
      const price = Number(latest.price ?? 0);
      if (liveTickPriceEl) liveTickPriceEl.textContent = `(${price.toFixed(3)})`;
      if (liveTickPriceStrongEl) liveTickPriceStrongEl.textContent = price.toFixed(3);
      if (trendEl) trendEl.textContent = computeTrend(points);
      const vol = computeVolatility(points);
      if (volatilityEl) volatilityEl.textContent = vol == null ? "--" : `${vol.toFixed(2)}%`;
      if (maEl) maEl.textContent = latest.ma20 == null ? "--" : Number(latest.ma20).toFixed(3);
      if (rsiEl) rsiEl.textContent = latest.rsi14 == null ? "--" : Number(latest.rsi14).toFixed(2);
    } catch (_error) {
      // ignore transient errors
    }
  }

  async function refreshManualHistory() {
    if (!historyBodyEl) return;
    try {
      const rows = await requestJson("/history");
      const manualRows = (rows || []).filter((r) => r.source === "manual").slice(-10).reverse();
      historyBodyEl.innerHTML = "";
      manualRows.forEach((r) => {
        const tr = document.createElement("tr");
        const ct = Number(r.profit ?? 0) >= 0 ? "profit-positive" : "profit-negative";
        const side = String(r.contract_type || "").toUpperCase() === "DIGITUNDER" ? "UNDER" : "OVER";
        const type = `${side} ${r.digit ?? "-"}`;
        const stake = Number(r.stake ?? 0);
        tr.innerHTML = `<td>${r.timestamp ?? "-"}</td><td>${type}</td><td>${stake.toFixed(2)}</td><td>${r.result ?? "-"}</td><td class="${ct}">${Number(r.profit ?? 0).toFixed(2)}</td>`;
        historyBodyEl.appendChild(tr);
      });
    } catch (_e) {
      // ignore
    }
  }

  async function submitManualTrade() {
    if (!manualContractEl || !manualBarrierEl || !manualStakeEl || !manualBtn) return;
    if (manualSubmitting) return;
    showToast(
      `${manualContractEl.value === "DIGITUNDER" ? "Under" : "Over"} · barrier ${manualBarrierEl.value} · sending…`,
      900,
    );
    manualSubmitting = true;
    setLoading(manualBtn, true);
    setLoading(ouOverBtn, true);
    setLoading(ouUnderBtn, true);
    try {
      const payload = {
        contract_type: manualContractEl.value,
        barrier: Number(manualBarrierEl.value),
        stake: Number(manualStakeEl.value),
        symbol: "R_100",
      };
      const res = await requestJson("/manual-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (typeof res.won === "boolean") {
        const secs = Number(res.duration_sec ?? NaN);
        const secText = Number.isFinite(secs) ? ` in ${secs.toFixed(2)}s` : "";
        showToast(
          res.won
            ? `Win: +${Number(res.profit_delta ?? 0).toFixed(2)} USD${secText}`
            : `Loss: ${Number(res.profit_delta ?? 0).toFixed(2)} USD${secText}`
        );
      }
      if (typeof onAfterAction === "function") await onAfterAction();
      await refreshManualHistory();
      await refreshQuote();
    } catch (error) {
      showToast(`Manual trade failed: ${error.message}`);
    } finally {
      setLoading(manualBtn, false);
      setLoading(ouOverBtn, false);
      setLoading(ouUnderBtn, false);
      manualSubmitting = false;
    }
  }

  if (ouOverBtn && manualContractEl) {
    ouOverBtn.addEventListener("click", async () => {
      manualContractEl.value = "DIGITOVER";
      syncOuButtons();
      if (!manualEnabled) return;
      await submitManualTrade();
    });
  }
  if (ouUnderBtn && manualContractEl) {
    ouUnderBtn.addEventListener("click", async () => {
      manualContractEl.value = "DIGITUNDER";
      syncOuButtons();
      if (!manualEnabled) return;
      await submitManualTrade();
    });
  }
  if (digitGrid && manualBarrierEl) {
    ensureDigitCellStructure();
    digitGrid.querySelectorAll(".digit-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        manualBarrierEl.value = cell.dataset.digit ?? "0";
        syncDigitGrid();
        refreshQuote();
      });
    });
  }
  if (paneToTradeBtn) {
    paneToTradeBtn.addEventListener("click", () => setManualPane("trade"));
  }
  if (paneToChartBtn) {
    paneToChartBtn.addEventListener("click", () => setManualPane("chart"));
  }
  if (digitSampleEl) {
    digitSampleEl.addEventListener("change", () => {
      digitSampleSize = Number(digitSampleEl.value || 120) || 120;
      renderDigitPrediction(recentPoints);
    });
  }
  document.querySelectorAll(".quick-stake-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!manualStakeEl) return;
      manualStakeEl.value = String(btn.dataset.stake ?? "1");
      refreshQuote();
    });
  });
  if (manualStakeEl) {
    manualStakeEl.addEventListener("input", () => {
      if (manualRiskModeEl?.checked) manualRiskModeEl.checked = false;
      refreshQuote();
    });
  }
  if (manualRiskModeEl) {
    manualRiskModeEl.addEventListener("change", () => {
      const stakeInput = manualStakeEl;
      if (!stakeInput) return;
      if (manualRiskModeEl.checked && liveBalance != null) {
        const pct = Number(manualRiskPercentEl?.value ?? 0);
        const calc = Math.max(0.35, (liveBalance * pct) / 100);
        stakeInput.value = calc.toFixed(2);
      }
      refreshQuote();
    });
  }
  if (manualRiskPercentEl) {
    manualRiskPercentEl.addEventListener("input", () => {
      if (manualRiskModeEl?.checked && liveBalance != null && manualStakeEl) {
        const pct = Number(manualRiskPercentEl.value ?? 0);
        manualStakeEl.value = Math.max(0.35, (liveBalance * pct) / 100).toFixed(2);
      }
      refreshQuote();
    });
  }
  [manualStopLossEl, manualTakeProfitEl].forEach((el) => el?.addEventListener("input", updateRiskPreview));

  if (manualBtn) manualBtn.addEventListener("click", submitManualTrade);

  if (modeToggle) {
    modeToggle.addEventListener("click", () => {
      manualModeOn = !manualModeOn;
      manualEnabled = manualModeOn;
      updateManualEnableState();
      showToast(manualModeOn ? "Manual mode enabled" : "Auto-bot mode selected (manual ticket locked)");
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    if (e.key === "o" || e.key === "O") {
      if (manualContractEl) manualContractEl.value = "DIGITOVER";
      syncOuButtons();
      refreshQuote();
    } else if (e.key === "u" || e.key === "U") {
      if (manualContractEl) manualContractEl.value = "DIGITUNDER";
      syncOuButtons();
      refreshQuote();
    } else if (e.key === "Enter") {
      submitManualTrade();
    }
  });

  function onStatus(status) {
    const bal = Number(status.balance ?? NaN);
    if (!Number.isNaN(bal)) {
      liveBalance = bal;
    }
    const loggedIn = !!lastDerivMe?.logged_in;
    if (accountStateEl) {
      const kind = lastDerivMe?.account?.kind === "real" ? "Real" : "Demo";
      accountStateEl.textContent = loggedIn
        ? `${lastDerivMe.account?.account ?? "Account"} (${kind})`
        : "Not logged in";
    }
    manualEnabled = loggedIn && manualModeOn;
    updateManualEnableState();
    updateRiskPreview();
  }

  if (digitGrid) {
    window.addEventListener("resize", () => {
      const d = Number(liveTickDigitEl?.textContent);
      if (!Number.isNaN(d)) movePointerToDigit(d);
    });
  }
  syncOuButtons();
  syncDigitGrid();
  setManualPane("trade");
  window.addEventListener("resize", () => setManualPane("trade"));
  updateManualEnableState();
  refreshLiveContext();
  refreshQuote();
  refreshManualHistory();
  setInterval(refreshLiveContext, 1200);

  return { onStatus, refreshQuote, refreshManualHistory };
}

function initDashboardPage() {
  const balanceEl = document.getElementById("balance");
  if (!balanceEl) return;

  const profitEl = document.getElementById("profit");
  const statusBadgeEl = document.getElementById("statusBadge");
  const liveStakeEl = document.getElementById("liveStake");
  const lastDigitsEl = document.getElementById("lastDigits");
  const lastResultEl = document.getElementById("lastResult");
  const tradesCountEl = document.getElementById("tradesCount");
  const eventsListEl = document.getElementById("eventsList");
  const historyBodyEl = document.getElementById("historyBody");

  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const refreshDiagnosticsBtn = document.getElementById("refreshDiagnosticsBtn");
  const stakeInputEl = document.getElementById("stakeInput");
  const takeProfitInputEl = document.getElementById("takeProfitInput");
  const stopLossInputEl = document.getElementById("stopLossInput");
  const stratActionEl = document.getElementById("dashStrategyAction");
  const stratThresholdEl = document.getElementById("dashStrategyThreshold");
  const stratTrueEl = document.getElementById("dashStrategyTrue");
  const stratFalseEl = document.getElementById("dashStrategyFalse");
  const saveStrategyModeBtn = document.getElementById("saveStrategyModeBtn");

  /** When true, do not overwrite stake / TP / SL from `/status` (1s poll) so the user can edit. */
  let settingsDirty = false;
  let strategyDirty = false;
  [stakeInputEl, takeProfitInputEl, stopLossInputEl].forEach((el) => {
    if (!el) return;
    const markDirty = () => {
      settingsDirty = true;
    };
    el.addEventListener("input", markDirty);
    el.addEventListener("change", markDirty);
  });

  function strategyOptions(action) {
    return action === "rise_fall"
      ? [
          { value: "RISE", label: "Rise" },
          { value: "FALL", label: "Fall" },
        ]
      : [
          { value: "UNDER", label: "Under" },
          { value: "OVER", label: "Over" },
        ];
  }

  function fillStrategySideSelects(action, chosenTrue, chosenFalse) {
    if (!stratTrueEl || !stratFalseEl) return;
    const options = strategyOptions(action);
    stratTrueEl.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    stratFalseEl.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    stratTrueEl.value = options.some((o) => o.value === chosenTrue) ? chosenTrue : options[0].value;
    stratFalseEl.value = options.some((o) => o.value === chosenFalse) ? chosenFalse : options[1].value;
  }

  function normalizeStrategy(strategy) {
    const src = strategy && typeof strategy === "object" ? strategy : {};
    const active = src.active_action || src.action || "over_under";
    const legacyRules = src.rules && typeof src.rules === "object" ? src.rules : {};
    const ouRules = {
      if_digit_greater_equal: Number(
        src.actions?.over_under?.rules?.if_digit_greater_equal ??
          (active === "over_under" ? legacyRules.if_digit_greater_equal : 5)
      ),
      trade: String(src.actions?.over_under?.rules?.trade ?? (active === "over_under" ? legacyRules.trade : "UNDER") ?? "UNDER").toUpperCase(),
      else_trade: String(src.actions?.over_under?.rules?.else_trade ?? (active === "over_under" ? legacyRules.else_trade : "OVER") ?? "OVER").toUpperCase(),
    };
    const rfRules = {
      if_digit_greater_equal: Number(
        src.actions?.rise_fall?.rules?.if_digit_greater_equal ??
          (active === "rise_fall" ? legacyRules.if_digit_greater_equal : 5)
      ),
      trade: String(src.actions?.rise_fall?.rules?.trade ?? (active === "rise_fall" ? legacyRules.trade : "RISE") ?? "RISE").toUpperCase(),
      else_trade: String(src.actions?.rise_fall?.rules?.else_trade ?? (active === "rise_fall" ? legacyRules.else_trade : "FALL") ?? "FALL").toUpperCase(),
    };
    return {
      ...src,
      type: "digit_strategy",
      condition: "repeat_3",
      action: active === "rise_fall" ? "rise_fall" : "over_under",
      active_action: active === "rise_fall" ? "rise_fall" : "over_under",
      actions: {
        over_under: { enabled: active !== "rise_fall", rules: ouRules },
        rise_fall: { enabled: active === "rise_fall", rules: rfRules },
      },
    };
  }

  function syncStrategyForm(strategy) {
    if (!stratActionEl || !stratThresholdEl || !stratTrueEl || !stratFalseEl || strategyDirty) return;
    const normalized = normalizeStrategy(strategy);
    const action = normalized.active_action;
    const rules = normalized.actions?.[action]?.rules || {};
    stratActionEl.value = action;
    stratThresholdEl.value = String(Math.min(9, Math.max(0, Number(rules.if_digit_greater_equal ?? 5))));
    fillStrategySideSelects(action, String(rules.trade || ""), String(rules.else_trade || ""));
  }

  let lastSeenTradeAlertSeq = 0;
  let tradeAlertPollIndex = 0;

  function updateChart(history) {
    const labels = history.map((trade) => trade.timestamp ?? "");
    let cumulative = 0;
    const series = history.map((trade) => {
      cumulative += Number(trade.profit ?? 0);
      return Number(cumulative.toFixed(2));
    });

    if (!profitChart) {
      const ctx = document.getElementById("profitChart");
      profitChart = new Chart(ctx, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Profit Over Time",
              data: series,
              borderColor: "#1b52c0",
              backgroundColor: "rgba(27, 82, 192, 0.12)",
              fill: true,
              tension: 0.25,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: { legend: { labels: { color: "#3d4f66" } } },
          scales: {
            x: {
              ticks: { color: "#5c6b84" },
              grid: { color: "rgba(0,0,0,0.06)" },
            },
            y: {
              ticks: { color: "#5c6b84" },
              grid: { color: "rgba(0,0,0,0.06)" },
            },
          },
        },
      });
      return;
    }

    profitChart.data.labels = labels;
    profitChart.data.datasets[0].data = series;
    profitChart.update();
  }

  function renderHistory(history) {
    historyBodyEl.innerHTML = "";
    history.forEach((trade) => {
      const tr = document.createElement("tr");
      const resultClass = trade.result === "win" ? "result-win" : "result-loss";
      const profitClass = Number(trade.profit) >= 0 ? "profit-positive" : "profit-negative";
      tr.innerHTML = `
        <td>${trade.timestamp ?? "-"}</td>
        <td>${trade.source ?? "bot"}</td>
        <td>${trade.digit ?? "-"}</td>
        <td class="${resultClass}">${trade.result ?? "-"}</td>
        <td class="${profitClass}">${Number(trade.profit ?? 0).toFixed(2)}</td>
      `;
      historyBodyEl.appendChild(tr);
    });
  }

  function syncMobileRunChrome(status) {
    const running = !!status.running;
    const statusEl = document.getElementById("mobileRunStatus");
    const labelEl = document.getElementById("mobileRunLabel");
    const btn = document.getElementById("mobileRunBtn");
    const bar = document.querySelector(".app-bottom-bar");
    const progress = document.getElementById("mobileRunProgress");
    if (statusEl) statusEl.textContent = running ? "Bot is running" : "Bot is not running";
    if (labelEl) labelEl.textContent = running ? "Stop" : "Run";
    if (btn) {
      btn.classList.toggle("btn-run-teal--stop", running);
      btn.setAttribute("aria-pressed", running ? "true" : "false");
    }
    if (bar) bar.classList.toggle("app-bottom-bar--running", running);
    if (progress) progress.style.width = running ? "100%" : "14%";
  }

  function applyStatus(status, isFirstStatusPoll = false) {
    const running = !!status.running;
    syncMobileRunChrome(status);
    const effectiveBalance = Number.isFinite(Number(lastDerivBalance)) ? Number(lastDerivBalance) : Number(status.balance ?? 0);
    balanceEl.textContent = `$${effectiveBalance.toFixed(2)}`;
    profitEl.textContent = `$${Number(status.profit ?? 0).toFixed(2)}`;
    liveStakeEl.textContent = Number(status.stake ?? 0).toFixed(2);
    lastDigitsEl.textContent = JSON.stringify(status.last_digits ?? []);
    lastResultEl.textContent = status.last_result ?? "-";
    tradesCountEl.textContent = String(status.trades_count ?? 0);

    const activeTradesEl = document.getElementById("activeTrades");
    if (activeTradesEl) {
      activeTradesEl.textContent = String((status.active_trades ?? []).length);
    }
    applyHybridBannerFromStatus(status);

    statusBadgeEl.textContent = running ? "Running" : "Stopped";
    statusBadgeEl.classList.toggle("running", running);
    statusBadgeEl.classList.toggle("stopped", !running);

    eventsListEl.innerHTML = "";
    (status.events ?? []).forEach((eventText) => {
      const li = document.createElement("li");
      li.textContent = eventText;
      eventsListEl.appendChild(li);
    });

    if (status.settings && stakeInputEl && takeProfitInputEl && stopLossInputEl && !settingsDirty) {
      stakeInputEl.value = status.settings.stake;
      takeProfitInputEl.value = status.settings.take_profit;
      stopLossInputEl.value = status.settings.stop_loss;
    }
    if (status.strategy) {
      syncStrategyForm(status.strategy);
    }

    const ta = status.last_trade_alert;
    if (ta && typeof ta.seq === "number") {
      if (isFirstStatusPoll) {
        lastSeenTradeAlertSeq = ta.seq;
      } else if (ta.seq > lastSeenTradeAlertSeq) {
        lastSeenTradeAlertSeq = ta.seq;
        showTradeAlert(ta);
      }
    }

    if (status.last_result !== "-" && status.last_result !== "no_trade" && status.last_result !== lastSeenResult) {
      lastSeenResult = status.last_result;
    }
  }

  async function refreshDashboard() {
    try {
      const [status, history] = await Promise.all([requestJson("/status"), requestJson("/history")]);
      applyStatus(status, tradeAlertPollIndex === 0);
      tradeAlertPollIndex += 1;
      renderHistory(history);
      updateChart(history);
      if (tradeAlertPollIndex % 15 === 0) {
        await refreshAuthState();
      }
    } catch (error) {
      showToast(`Refresh error: ${error.message}`);
    }
  }

  async function startBot() {
    setLoading(startBtn, true);
    try {
      const result = await requestJson("/start-bot", { method: "POST" });
      showToast(result.message ?? "Bot started");
      await refreshDashboard();
    } catch (error) {
      showToast(`Start failed: ${error.message}`);
    } finally {
      setLoading(startBtn, false);
    }
  }

  async function stopBot() {
    setLoading(stopBtn, true);
    try {
      const result = await requestJson("/stop-bot", { method: "POST" });
      showToast(result.message ?? "Bot stopped");
      await refreshDashboard();
    } catch (error) {
      showToast(`Stop failed: ${error.message}`);
    } finally {
      setLoading(stopBtn, false);
    }
  }

  async function saveSettings() {
    setLoading(saveSettingsBtn, true);
    try {
      const payload = {
        stake: Number(stakeInputEl.value),
        take_profit: Number(takeProfitInputEl.value),
        stop_loss: Number(stopLossInputEl.value),
      };
      await requestJson("/update-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      settingsDirty = false;
      showToast("Settings saved");
      await refreshDashboard();
    } catch (error) {
      showToast(`Save failed: ${error.message}`);
    } finally {
      setLoading(saveSettingsBtn, false);
    }
  }

  async function saveStrategyMode() {
    if (!stratActionEl || !stratThresholdEl || !stratTrueEl || !stratFalseEl) return;
    setLoading(saveStrategyModeBtn, true);
    try {
      const current = normalizeStrategy(await requestJson("/load-strategy"));
      const action = stratActionEl.value === "rise_fall" ? "rise_fall" : "over_under";
      const rules = {
        if_digit_greater_equal: Math.min(9, Math.max(0, Number(stratThresholdEl.value || 5))),
        trade: String(stratTrueEl.value || (action === "rise_fall" ? "RISE" : "UNDER")).toUpperCase(),
        else_trade: String(stratFalseEl.value || (action === "rise_fall" ? "FALL" : "OVER")).toUpperCase(),
      };
      current.active_action = action;
      current.action = action;
      current.actions[action] = { enabled: true, rules };
      current.actions[action === "rise_fall" ? "over_under" : "rise_fall"].enabled = false;
      current.rules = rules;
      await requestJson("/save-strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      });
      strategyDirty = false;
      showToast(`Strategy set to ${action === "rise_fall" ? "Rise/Fall" : "Over/Under"}`);
      await refreshDashboard();
    } catch (error) {
      showToast(`Strategy save failed: ${error.message}`);
    } finally {
      setLoading(saveStrategyModeBtn, false);
    }
  }

  startBtn.addEventListener("click", startBot);
  stopBtn.addEventListener("click", stopBot);
  saveSettingsBtn.addEventListener("click", saveSettings);
  saveStrategyModeBtn?.addEventListener("click", saveStrategyMode);
  stratActionEl?.addEventListener("change", () => {
    strategyDirty = true;
    fillStrategySideSelects(stratActionEl.value, stratTrueEl?.value, stratFalseEl?.value);
  });
  stratThresholdEl?.addEventListener("input", () => {
    strategyDirty = true;
  });
  stratTrueEl?.addEventListener("change", () => {
    strategyDirty = true;
  });
  stratFalseEl?.addEventListener("change", () => {
    strategyDirty = true;
  });
  if (refreshDiagnosticsBtn) {
    refreshDiagnosticsBtn.addEventListener("click", () => refreshDiagnostics());
  }

  const mobileRunBtn = document.getElementById("mobileRunBtn");
  if (mobileRunBtn) {
    mobileRunBtn.addEventListener("click", async () => {
      const stopMode = mobileRunBtn.classList.contains("btn-run-teal--stop");
      if (stopMode) await stopBot();
      else await startBot();
    });
  }

  const riskBtn = document.getElementById("riskDisclaimerBtn");
  if (riskBtn) {
    riskBtn.addEventListener("click", () => {
      showToast(
        "Risk disclaimer: trading involves substantial risk of loss. You may lose your entire stake. Only use capital you can afford to lose.",
        11000
      );
    });
  }

  initAuthButtons();
  refreshAuthState();

  refreshDashboard();
  refreshDiagnostics();
  setInterval(refreshDashboard, 1000);
  window.setInterval(refreshDiagnostics, 15000);
  window.setInterval(refreshAuthState, 15000);
}

function initManualTraderPage() {
  if (!document.getElementById("manualTradeBtn")) return;

  let lastSeenTradeAlertSeq = 0;
  let statusPollIndex = 0;
  const ui = wireManualTraderUi(refreshManualStatus);

  async function refreshManualStatus() {
    try {
      await refreshAuthState();
      const status = await requestJson("/status");
      applyHybridBannerFromStatus(status);
      if (ui?.onStatus) ui.onStatus(status);
      const ta = status.last_trade_alert;
      if (ta && typeof ta.seq === "number") {
        if (statusPollIndex === 0) {
          lastSeenTradeAlertSeq = ta.seq;
        } else if (ta.seq > lastSeenTradeAlertSeq) {
          lastSeenTradeAlertSeq = ta.seq;
          showTradeAlert(ta);
        }
      }
      statusPollIndex += 1;
    } catch (error) {
      showToast(`Status: ${error.message}`);
    }
  }

  initAuthButtons();
  refreshAuthState();
  refreshManualStatus();
  setInterval(refreshManualStatus, 1000);
  window.setInterval(refreshAuthState, 15000);
}

function initStrategiesPage() {
  if (!document.getElementById("confSaveBtn")) return;
  const actionSelect = document.getElementById("stratActionSelect");
  const thresholdInput = document.getElementById("stratThresholdInput");
  const trueSelect = document.getElementById("stratTrueSelect");
  const falseSelect = document.getElementById("stratFalseSelect");
  const stratSaveBtn = document.getElementById("stratSaveBtn");
  const confluenceScopeNote = document.getElementById("confluenceScopeNote");
  let actionFormDirty = false;

  function optionListForAction(action) {
    return action === "rise_fall"
      ? [
          { value: "RISE", label: "Rise" },
          { value: "FALL", label: "Fall" },
        ]
      : [
          { value: "UNDER", label: "Under" },
          { value: "OVER", label: "Over" },
        ];
  }

  function hydrateTradeSelects(action, selectedTrue, selectedFalse) {
    if (!trueSelect || !falseSelect) return;
    const opts = optionListForAction(action);
    trueSelect.innerHTML = opts
      .map((o) => `<option value="${o.value}">${o.label}</option>`)
      .join("");
    falseSelect.innerHTML = opts
      .map((o) => `<option value="${o.value}">${o.label}</option>`)
      .join("");
    trueSelect.value = opts.some((o) => o.value === selectedTrue) ? selectedTrue : opts[0].value;
    falseSelect.value = opts.some((o) => o.value === selectedFalse) ? selectedFalse : opts[1].value;
  }

  function normalizeStrategyShape(strategy) {
    const s = strategy && typeof strategy === "object" ? { ...strategy } : {};
    const activeAction = s.active_action || s.action || "over_under";
    const actions = s.actions && typeof s.actions === "object" ? { ...s.actions } : {};
    const legacyRules = s.rules && typeof s.rules === "object" ? s.rules : {};
    const ouRules = {
      if_digit_greater_equal: Number(actions.over_under?.rules?.if_digit_greater_equal ?? legacyRules.if_digit_greater_equal ?? 5),
      trade: String(actions.over_under?.rules?.trade ?? legacyRules.trade ?? "UNDER").toUpperCase(),
      else_trade: String(actions.over_under?.rules?.else_trade ?? legacyRules.else_trade ?? "OVER").toUpperCase(),
    };
    const rfRules = {
      if_digit_greater_equal: Number(actions.rise_fall?.rules?.if_digit_greater_equal ?? 5),
      trade: String(actions.rise_fall?.rules?.trade ?? "RISE").toUpperCase(),
      else_trade: String(actions.rise_fall?.rules?.else_trade ?? "FALL").toUpperCase(),
    };
    return {
      type: "digit_strategy",
      condition: "repeat_3",
      action: activeAction,
      active_action: activeAction,
      actions: {
        over_under: { enabled: activeAction === "over_under", rules: ouRules },
        rise_fall: { enabled: activeAction === "rise_fall", rules: rfRules },
      },
      rules: activeAction === "rise_fall" ? rfRules : ouRules,
      confluence: s.confluence || {},
    };
  }

  function syncStrategyForm(strategy) {
    if (!actionSelect || !thresholdInput || !trueSelect || !falseSelect) return;
    const normalized = normalizeStrategyShape(strategy);
    const action = normalized.active_action === "rise_fall" ? "rise_fall" : "over_under";
    const rules = normalized.actions[action]?.rules || {};
    actionSelect.value = action;
    thresholdInput.value = String(Math.min(9, Math.max(0, Number(rules.if_digit_greater_equal ?? 5))));
    hydrateTradeSelects(action, String(rules.trade || ""), String(rules.else_trade || ""));
    if (confluenceScopeNote) {
      confluenceScopeNote.textContent =
        action === "rise_fall"
          ? "Confluence filters are advisory for Over/Under only."
          : "Confluence filters apply to Over/Under.";
    }
  }

  async function refreshStrategyForm() {
    if (actionFormDirty) return;
    try {
      const strategy = await requestJson("/load-strategy");
      syncStrategyForm(strategy);
    } catch (_err) {
      // no-op
    }
  }

  async function refreshStrategies() {
    try {
      const status = await requestJson("/status");
      applyConfluenceLive(status);
      syncConfluenceFormFromStatus(status);
      await refreshStrategyForm();
      await refreshAuthState();
    } catch (error) {
      showToast(`Strategies: ${error.message}`);
    }
  }

  const confSaveBtn = document.getElementById("confSaveBtn");
  confSaveBtn.addEventListener("click", async () => {
    setLoading(confSaveBtn, true);
    try {
      const body = {
        enabled: document.getElementById("confEnabled")?.checked ?? false,
        use_trend: document.getElementById("confTrend")?.checked ?? false,
        use_sr: document.getElementById("confSr")?.checked ?? false,
        use_rsi: document.getElementById("confRsi")?.checked ?? false,
        use_candles: document.getElementById("confCandle")?.checked ?? false,
        use_range: document.getElementById("confRange")?.checked ?? false,
      };
      await requestJson("/strategy-confluence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      showToast("Confluence settings saved");
      await refreshStrategies();
    } catch (error) {
      showToast(`Save confluence failed: ${error.message}`);
    } finally {
      setLoading(confSaveBtn, false);
    }
  });

  function markActionDirty() {
    actionFormDirty = true;
  }
  actionSelect?.addEventListener("change", () => {
    markActionDirty();
    hydrateTradeSelects(actionSelect.value, trueSelect?.value, falseSelect?.value);
    if (confluenceScopeNote) {
      confluenceScopeNote.textContent =
        actionSelect.value === "rise_fall"
          ? "Confluence filters are advisory for Over/Under only."
          : "Confluence filters apply to Over/Under.";
    }
  });
  thresholdInput?.addEventListener("input", markActionDirty);
  trueSelect?.addEventListener("change", markActionDirty);
  falseSelect?.addEventListener("change", markActionDirty);

  stratSaveBtn?.addEventListener("click", async () => {
    if (!actionSelect || !thresholdInput || !trueSelect || !falseSelect) return;
    setLoading(stratSaveBtn, true);
    try {
      const current = normalizeStrategyShape(await requestJson("/load-strategy"));
      const action = actionSelect.value === "rise_fall" ? "rise_fall" : "over_under";
      const threshold = Math.min(9, Math.max(0, Number(thresholdInput.value || 5)));
      const rules = {
        if_digit_greater_equal: threshold,
        trade: String(trueSelect.value || (action === "rise_fall" ? "RISE" : "UNDER")).toUpperCase(),
        else_trade: String(falseSelect.value || (action === "rise_fall" ? "FALL" : "OVER")).toUpperCase(),
      };
      current.active_action = action;
      current.action = action;
      current.actions[action] = { enabled: true, rules };
      current.actions[action === "rise_fall" ? "over_under" : "rise_fall"].enabled = false;
      current.rules = rules;
      await requestJson("/save-strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      });
      actionFormDirty = false;
      showToast(`Saved ${action === "rise_fall" ? "Rise/Fall" : "Over/Under"} strategy`);
      await refreshStrategies();
    } catch (error) {
      showToast(`Save strategy failed: ${error.message}`);
    } finally {
      setLoading(stratSaveBtn, false);
    }
  });

  initAuthButtons();
  refreshAuthState();
  refreshStrategies();
  setInterval(refreshStrategies, 1000);
  window.setInterval(refreshAuthState, 15000);
}

function initAnalysisPage() {
  initAuthButtons();
  refreshAuthState();
  if (window.AnalysisChartApp) {
    const app = new window.AnalysisChartApp();
    app.mount();
  } else {
    showToast("Analysis module is unavailable");
  }
  window.setInterval(refreshAuthState, 15000);
}

function initCopyPage() {
  initAuthButtons();
  refreshAuthState();

  async function refreshCopy() {
    try {
      const snap = await requestJson("/copy-status");
      const stats = document.getElementById("masterStats");
      if (stats) {
        const m = snap.master_stats || {};
        stats.innerHTML = `Master: <strong>${snap.master_id ?? "-"}</strong><br/>Followers: ${(snap.followers || []).join(", ") || "none"}<br/>Trades: ${m.trades ?? 0} &nbsp; Wins: ${m.wins ?? 0} &nbsp; Profit: ${m.profit ?? 0}`;
      }
      const body = document.getElementById("copyFeedBody");
      if (body) {
        body.innerHTML = "";
        (snap.recent_copies || []).slice().reverse().forEach((row) => {
          const tr = document.createElement("tr");
          const t = row.trade || {};
          tr.innerHTML = `
            <td>${row.time ?? "-"}</td>
            <td>${row.source ?? "-"}</td>
            <td>${row.follower ?? "-"}</td>
            <td>${t.result ?? "-"}</td>
            <td>${Number(t.profit ?? 0).toFixed(2)}</td>`;
          body.appendChild(tr);
        });
      }
    } catch (e) {
      showToast(`Copy status: ${e.message}`);
    }
  }

  document.getElementById("setMasterBtn")?.addEventListener("click", async () => {
    const masterId = document.getElementById("masterIdInput").value;
    try {
      await requestJson("/copy-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ master_id: masterId }),
      });
      showToast("Master set");
      await refreshCopy();
    } catch (e) {
      showToast(e.message);
    }
  });

  document.getElementById("followBtn")?.addEventListener("click", async () => {
    const followerId = document.getElementById("followerIdInput").value;
    try {
      await requestJson("/copy-follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ follower_id: followerId }),
      });
      showToast("Now following");
      await refreshCopy();
    } catch (e) {
      showToast(e.message);
    }
  });

  document.getElementById("unfollowBtn")?.addEventListener("click", async () => {
    const followerId = document.getElementById("followerIdInput").value;
    try {
      await requestJson("/copy-unfollow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ follower_id: followerId }),
      });
      showToast("Unfollowed");
      await refreshCopy();
    } catch (e) {
      showToast(e.message);
    }
  });

  refreshCopy();
  setInterval(refreshCopy, 2000);
}

function initBuilderPage() {
  const blocklyDiv = document.getElementById("blocklyDiv");
  if (!blocklyDiv) return;

  const generateBtn = document.getElementById("generateStrategyBtn");
  const loadBtn = document.getElementById("loadStrategyBtn");
  const outputEl = document.getElementById("strategyOutput");
  const runBtn = document.getElementById("builderRunBtn");
  const stopBtn = document.getElementById("builderStopBtn");
  const sparklineCanvas = document.getElementById("builderProfitSparkline");
  const sidebar = document.getElementById("builderSidebar");
  const centerPane = document.getElementById("builderCenterPane");
  const snapToggleBtn = document.getElementById("builderSnapToggleBtn");
  const searchReplaceModal = document.getElementById("builderSearchReplaceModal");
  const globalsModal = document.getElementById("builderGlobalsModal");
  const tourOverlay = document.getElementById("builderTourOverlay");
  const tourCallout = document.getElementById("builderTourCallout");
  const quickModal = document.getElementById("builderQuickModal");
  const quickStep1 = document.getElementById("builderQuickStep1");
  const quickStep2 = document.getElementById("builderQuickStep2");
  const quickSearch = document.getElementById("builderQuickSearch");
  const quickTemplateList = document.getElementById("builderQuickTemplateList");
  const quickStepBadge1 = document.getElementById("builderWizardStep1");
  const quickStepBadge2 = document.getElementById("builderWizardStep2");
  const quickNextBtn = document.getElementById("builderQuickNextBtn");
  const quickBackBtn = document.getElementById("builderQuickBackBtn");
  const quickCreateBtn = document.getElementById("builderQuickCreateBtn");
  const quickCloseBtn = document.getElementById("builderQuickCloseBtn");
  const quickValidationText = document.getElementById("builderQuickValidationText");
  const quickStrategyTypeLabel = document.getElementById("builderQuickStrategyTypeLabel");
  const quickMarket = document.getElementById("builderQuickMarket");
  const quickContract = document.getElementById("builderQuickContract");
  let builderRunning = false;
  let snapOn = true;
  let quickWizardStep = 1;
  let selectedQuickTemplate = "martingale";
  let quickTemplateFilter = "all";

  if (typeof createBuilderWorkspace === "function") {
    createBuilderWorkspace();
  }

  const panels = {
    summary: document.getElementById("builderTabSummary"),
    json: document.getElementById("builderTabJson"),
    journal: document.getElementById("builderTabJournal"),
  };
  document.querySelectorAll(".builder-run-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      if (!name) return;
      document.querySelectorAll(".builder-run-tab").forEach((t) => {
        const on = t === tab;
        t.classList.toggle("builder-run-tab--active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      Object.entries(panels).forEach(([key, el]) => {
        if (!el) return;
        el.classList.toggle("hidden", key !== name);
      });
    });
  });

  function drawProfitSparkline(history) {
    if (!sparklineCanvas) return;
    const ctx = sparklineCanvas.getContext("2d");
    if (!ctx) return;
    const points = (history || []).slice(-10).map((t) => Number(t.profit ?? 0));
    ctx.clearRect(0, 0, sparklineCanvas.width, sparklineCanvas.height);
    if (!points.length) return;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = Math.max(1, max - min);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#1b52c0";
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = (i / Math.max(1, points.length - 1)) * (sparklineCanvas.width - 2) + 1;
      const y = sparklineCanvas.height - (((p - min) / span) * (sparklineCanvas.height - 4) + 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function styleJournalLevel(line, node) {
    const lower = String(line || "").toLowerCase();
    if (lower.includes("error") || lower.includes("failed") || lower.includes("execution")) {
      node.classList.add("builder-log-error");
      return;
    }
    if (lower.includes("warn")) {
      node.classList.add("builder-log-warn");
      return;
    }
    node.classList.add("builder-log-info");
  }

  function applyBuilderStatus(status, history) {
    const running = !!status.running;
    builderRunning = running;
    const statusEl = document.getElementById("builderBotStatus");
    const progressFill = document.getElementById("builderProgressFill");
    if (statusEl) statusEl.textContent = running ? "Bot is running" : "Bot is not running";
    if (progressFill) progressFill.style.width = running ? "100%" : "18%";

    const fmt = (v) => (v === undefined || v === null ? "—" : String(v));
    const stakeEl = document.getElementById("builderStatStake");
    if (stakeEl) stakeEl.textContent = fmt(Number(status.stake ?? 0).toFixed(2));
    const tradesEl = document.getElementById("builderStatTrades");
    if (tradesEl) tradesEl.textContent = fmt(status.trades_count ?? 0);
    const profitEl = document.getElementById("builderStatProfit");
    if (profitEl) profitEl.firstChild.textContent = `$${Number(status.profit ?? 0).toFixed(2)} `;
    const balEl = document.getElementById("builderStatBalance");
    if (balEl) balEl.textContent = `$${Number(status.balance ?? 0).toFixed(2)}`;
    drawProfitSparkline(history);

    const journal = document.getElementById("builderJournalList");
    if (journal) {
      journal.innerHTML = "";
      (status.events ?? [])
        .slice(-30)
        .reverse()
        .forEach((line) => {
          const li = document.createElement("li");
          li.textContent = line;
          styleJournalLevel(line, li);
          journal.appendChild(li);
        });
    }
  }

  async function refreshBuilderStatus() {
    try {
      const [status, history] = await Promise.all([requestJson("/status"), requestJson("/history")]);
      applyBuilderStatus(status, history);
    } catch (_e) {
      /* ignore */
    }
  }

  async function loadCurrentStrategy() {
    if (!outputEl) return;
    try {
      const strategy = await requestJson("/load-strategy");
      outputEl.textContent = JSON.stringify(strategy, null, 2);
      if (typeof loadStrategyIntoWorkspace === "function") {
        loadStrategyIntoWorkspace(strategy);
      }
      showToast("Strategy loaded");
    } catch (error) {
      showToast(`Load failed: ${error.message}`);
    }
  }

  async function generateAndSaveStrategy() {
    if (!generateBtn || !outputEl) return;
    setLoading(generateBtn, true);
    try {
      const strategy =
        typeof extractStrategyFromWorkspace === "function" ? extractStrategyFromWorkspace() : null;
      if (!strategy) {
        throw new Error("Unable to build strategy from workspace");
      }

      outputEl.textContent = JSON.stringify(strategy, null, 2);
      await requestJson("/save-strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(strategy),
      });
      showToast("Strategy saved");
      await refreshBuilderStatus();
    } catch (error) {
      showToast(`Save failed: ${error.message}`);
    } finally {
      setLoading(generateBtn, false);
    }
  }

  function updateQuickWizardStep(step) {
    quickWizardStep = step;
    const onStep1 = step === 1;
    quickStep1?.classList.toggle("hidden", !onStep1);
    quickStep2?.classList.toggle("hidden", onStep1);
    quickStepBadge1?.classList.toggle("builder-quick-rail-step--active", onStep1);
    quickStepBadge2?.classList.toggle("builder-quick-rail-step--active", !onStep1);
    quickStepBadge2?.classList.toggle("builder-quick-rail-step--disabled", onStep1);
    quickNextBtn?.classList.toggle("hidden", !onStep1);
    quickCreateBtn?.classList.toggle("hidden", onStep1);
    quickBackBtn?.classList.toggle("hidden", onStep1);
  }

  function renderQuickTemplateLibrary() {
    if (!quickTemplateList || typeof getBuilderTemplateLibrary !== "function") return;
    const q = String(quickSearch?.value || "").trim().toLowerCase();
    const templates = getBuilderTemplateLibrary().filter((item) => {
      const groupOk = quickTemplateFilter === "all" || item.group === quickTemplateFilter;
      const textOk = !q || item.label.toLowerCase().includes(q);
      return groupOk && textOk;
    });
    quickTemplateList.innerHTML = "";
    const grouped = templates.reduce((acc, item) => {
      const key = item.group || "other";
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});
    const order = ["accumulators", "options", "other"];
    order.forEach((groupName) => {
      const rows = grouped[groupName];
      if (!rows || !rows.length) return;
      const heading = document.createElement("div");
      heading.className = "builder-quick-template-group";
      heading.textContent = groupName === "accumulators" ? "Accumulators" : groupName === "options" ? "Options" : "Other";
      quickTemplateList.appendChild(heading);
      rows.forEach((item) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "builder-template-row";
        if (item.id === selectedQuickTemplate) row.classList.add("builder-template-row--active");
        row.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="builder-template-row__arrow">›</span>`;
        row.addEventListener("click", () => {
          selectedQuickTemplate = item.id;
          if (quickStrategyTypeLabel) quickStrategyTypeLabel.value = item.label;
          if (quickContract) quickContract.value = item.contract || "DIGITUNDER";
          const selected = getSelectedTemplate();
          if (selected) {
            const stakeEl = document.getElementById("builderQuickStake");
            const lossEl = document.getElementById("builderQuickLossThreshold");
            const profitEl = document.getElementById("builderQuickProfitThreshold");
            if (stakeEl) stakeEl.value = String(selected.stake ?? 1);
            if (lossEl) lossEl.value = String(selected.loss ?? 25);
            if (profitEl) profitEl.value = String(selected.profit ?? 20);
          }
          renderQuickTemplateLibrary();
        });
        quickTemplateList.appendChild(row);
      });
    });
  }

  function getSelectedTemplate() {
    if (typeof getBuilderTemplateLibrary !== "function") return null;
    return getBuilderTemplateLibrary().find((item) => item.id === selectedQuickTemplate) || null;
  }

  function getQuickPayload() {
    const selectedTemplate = getSelectedTemplate();
    return {
      strategyType: String(selectedTemplate?.id || selectedQuickTemplate || "martingale"),
      strategyLabel: String(selectedTemplate?.label || "Martingale"),
      threshold: Number(selectedTemplate?.threshold ?? 5),
      logicMode: String(selectedTemplate?.logicMode || "AND"),
      stake: Number(document.getElementById("builderQuickStake")?.value || 0),
      lossThreshold: Number(document.getElementById("builderQuickLossThreshold")?.value || 0),
      profitThreshold: Number(document.getElementById("builderQuickProfitThreshold")?.value || 0),
      market: String(quickMarket?.value || "R_100"),
      contractType: String(quickContract?.value || selectedTemplate?.contract || "DIGITUNDER"),
      trend: String(selectedTemplate?.trend || "BULLISH"),
      rsiOp: String(selectedTemplate?.rsiOp || "LT"),
      rsiValue: Number(selectedTemplate?.rsiValue ?? 35),
    };
  }

  function buildQuickStrategyXml(payload) {
    const selectedTemplate = getSelectedTemplate();
    const threshold = selectedTemplate?.threshold ?? 5;
    const trade = payload.contractType === "DIGITOVER" ? "buy_over_action" : "buy_under_action";
    const elseTrade = trade === "buy_under_action" ? "buy_over_action" : "buy_under_action";
    const logicMode = selectedTemplate?.logicMode ?? "AND";
    return `
<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="stake_config" x="40" y="40">
    <field name="STAKE">${payload.stake}</field>
  </block>
  <block type="analysis_trend" x="40" y="110">
    <field name="TREND">${logicMode === "OR" ? "SIDEWAYS" : "BULLISH"}</field>
  </block>
  <block type="analysis_rsi" x="40" y="180">
    <field name="OP">${trade === "buy_under_action" ? "LT" : "GT"}</field>
    <field name="VALUE">${trade === "buy_under_action" ? "35" : "65"}</field>
  </block>
  <block type="logic_gate" x="40" y="250">
    <field name="MODE">${logicMode}</field>
  </block>
  <block type="restart_condition" x="40" y="320"></block>
  <block type="repeat_3_condition" x="40" y="40"></block>
  <block type="digit_threshold" x="40" y="390">
    <field name="THRESHOLD">${threshold}</field>
  </block>
  <block type="profit_limit" x="40" y="460">
    <field name="PROFIT">${payload.profitThreshold}</field>
  </block>
  <block type="loss_limit" x="40" y="530">
    <field name="LOSS">${payload.lossThreshold}</field>
  </block>
  <block type="${trade}" x="40" y="600"></block>
  <block type="${elseTrade}" x="40" y="670"></block>
</xml>`.trim();
  }

  async function validateQuickStrategyBalance(stake) {
    const res = await requestJson("/auth/deriv/quick-validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stake }),
    });
    return res;
  }

  async function createQuickStrategy() {
    const payload = getQuickPayload();
    if (!Number.isFinite(payload.stake) || payload.stake <= 0) {
      showToast("Stake must be greater than 0");
      return;
    }
    if (!Number.isFinite(payload.lossThreshold) || payload.lossThreshold < 0) {
      showToast("Loss threshold must be >= 0");
      return;
    }
    if (!Number.isFinite(payload.profitThreshold) || payload.profitThreshold < 0) {
      showToast("Profit threshold must be >= 0");
      return;
    }
    quickValidationText.textContent = "Validating Deriv session...";
    try {
      const validation = await validateQuickStrategyBalance(payload.stake);
      if (!validation.can_trade) {
        quickValidationText.textContent = `Insufficient balance (${validation.balance} ${validation.currency})`;
        showToast("Stake exceeds current balance");
        return;
      }
      quickValidationText.textContent = `Authorized: ${validation.balance} ${validation.currency} available`;
      if (typeof injectQuickTemplateBlocks === "function") {
        injectQuickTemplateBlocks(payload);
      } else {
        const xml = buildQuickStrategyXml(payload);
        if (typeof loadBuilderXml === "function") {
          loadBuilderXml(xml);
        }
      }
      const strategy =
        typeof extractStrategyFromWorkspace === "function" ? extractStrategyFromWorkspace() : null;
      if (strategy && strategy.actions?.over_under?.rules) {
        strategy.quick_meta = {
          strategy_type: payload.strategyType,
          strategy_label: payload.strategyLabel,
          stake: payload.stake,
          loss_threshold: payload.lossThreshold,
          profit_threshold: payload.profitThreshold,
          market: payload.market,
          contract_type: payload.contractType,
          deriv_settings: validation.settings || {},
        };
        outputEl.textContent = JSON.stringify(strategy, null, 2);
      }
      quickModal?.classList.add("hidden");
      showToast("Quick strategy generated");
    } catch (error) {
      quickValidationText.textContent = "Validation failed";
      showToast(`Quick strategy failed: ${error.message}`);
    }
  }

  if (generateBtn) generateBtn.addEventListener("click", generateAndSaveStrategy);
  if (loadBtn) loadBtn.addEventListener("click", loadCurrentStrategy);

  document.getElementById("builderQuickStrategyBtn")?.addEventListener("click", () => {
    quickModal?.classList.remove("hidden");
    updateQuickWizardStep(1);
    renderQuickTemplateLibrary();
    if (quickStrategyTypeLabel) quickStrategyTypeLabel.value = getSelectedTemplate()?.label || "Martingale";
    if (quickValidationText) quickValidationText.textContent = "";
  });
  quickCloseBtn?.addEventListener("click", () => quickModal?.classList.add("hidden"));
  quickNextBtn?.addEventListener("click", () => {
    if (quickStrategyTypeLabel) quickStrategyTypeLabel.value = getSelectedTemplate()?.label || "Martingale";
    updateQuickWizardStep(2);
  });
  quickBackBtn?.addEventListener("click", () => updateQuickWizardStep(1));
  quickCreateBtn?.addEventListener("click", createQuickStrategy);
  quickSearch?.addEventListener("input", renderQuickTemplateLibrary);
  document.querySelectorAll(".builder-quick-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.filter || "all";
      quickTemplateFilter = quickTemplateFilter === next ? "all" : next;
      document.querySelectorAll(".builder-quick-filter").forEach((b) => b.classList.toggle("builder-quick-filter--active", b === btn));
      if (quickTemplateFilter === "all") {
        document.querySelectorAll(".builder-quick-filter").forEach((b) => {
          if ((b.dataset.filter || "all") === "all") b.classList.add("builder-quick-filter--active");
          else b.classList.remove("builder-quick-filter--active");
        });
      }
      renderQuickTemplateLibrary();
    });
  });

  document.getElementById("builderResetBtn")?.addEventListener("click", () => {
    if (typeof resetBuilderWorkspaceToDefault === "function") {
      resetBuilderWorkspaceToDefault();
    }
    if (typeof resetBuilderWorkspaceView === "function") {
      resetBuilderWorkspaceView();
    }
    if (outputEl && typeof extractStrategyFromWorkspace === "function") {
      outputEl.textContent = JSON.stringify(extractStrategyFromWorkspace(), null, 2);
    }
    showToast("Workspace reset to default blocks");
  });

  if (runBtn) {
    runBtn.addEventListener("click", async () => {
      setLoading(runBtn, true);
      try {
        const result = await requestJson("/start-bot", { method: "POST" });
        showToast(result.message ?? "Bot started");
        await refreshBuilderStatus();
      } catch (error) {
        showToast(`Start failed: ${error.message}`);
      } finally {
        setLoading(runBtn, false);
      }
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      setLoading(stopBtn, true);
      try {
        const result = await requestJson("/stop-bot", { method: "POST" });
        showToast(result.message ?? "Bot stopped");
        await refreshBuilderStatus();
      } catch (error) {
        showToast(`Stop failed: ${error.message}`);
      } finally {
        setLoading(stopBtn, false);
      }
    });
  }

  document.getElementById("builderCollapseSidebarBtn")?.addEventListener("click", () => {
    sidebar?.classList.toggle("builder-palette--collapsed");
  });
  document.getElementById("builderSidebarToggle")?.addEventListener("click", () => {
    sidebar?.classList.toggle("builder-palette--collapsed");
  });
  document.getElementById("builderCleanBtn")?.addEventListener("click", () => {
    if (typeof cleanBuilderWorkspaceLayout === "function") cleanBuilderWorkspaceLayout();
  });
  snapToggleBtn?.addEventListener("click", () => {
    snapOn = !snapOn;
    if (typeof setBuilderSnapToGrid === "function") setBuilderSnapToGrid(snapOn);
    snapToggleBtn.textContent = `Snap: ${snapOn ? "ON" : "OFF"}`;
  });
  document.getElementById("builderCanvasDarkModeBtn")?.addEventListener("click", () => {
    centerPane?.classList.toggle("builder-center--dark");
  });
  document.getElementById("builderZoomInBtn")?.addEventListener("click", () => {
    if (typeof zoomBuilderWorkspace === "function") zoomBuilderWorkspace(1);
  });
  document.getElementById("builderZoomOutBtn")?.addEventListener("click", () => {
    if (typeof zoomBuilderWorkspace === "function") zoomBuilderWorkspace(-1);
  });
  document.getElementById("builderFitBtn")?.addEventListener("click", () => {
    if (typeof fitBuilderWorkspace === "function") fitBuilderWorkspace();
  });
  document.getElementById("builderFloatingAi")?.addEventListener("click", () => {
    quickModal?.classList.remove("hidden");
    updateQuickWizardStep(1);
    renderQuickTemplateLibrary();
  });
  document.getElementById("builderFloatingTrash")?.addEventListener("click", () => {
    if (typeof clearBuilderWorkspace === "function") clearBuilderWorkspace();
    showToast("Workspace cleared");
  });

  const openSearchModal = () => searchReplaceModal?.classList.remove("hidden");
  const closeSearchModal = () => searchReplaceModal?.classList.add("hidden");
  document.getElementById("builderSearchReplaceBtn")?.addEventListener("click", openSearchModal);
  document.getElementById("builderCloseSearchReplaceBtn")?.addEventListener("click", closeSearchModal);
  document.getElementById("builderDoSearchReplaceBtn")?.addEventListener("click", () => {
    if (typeof builderWorkspace === "undefined" || !builderWorkspace) return;
    const search = String(document.getElementById("builderSearchInput")?.value ?? "");
    const replace = String(document.getElementById("builderReplaceInput")?.value ?? "");
    if (!search) return;
    let changed = 0;
    builderWorkspace.getAllBlocks(false).forEach((block) => {
      block.inputList?.forEach((input) => {
        input.fieldRow?.forEach((field) => {
          if (!field || typeof field.getValue !== "function" || typeof field.setValue !== "function") return;
          const current = String(field.getValue() ?? "");
          if (!current.includes(search)) return;
          field.setValue(current.replaceAll(search, replace));
          changed += 1;
        });
      });
    });
    showToast(`Replaced ${changed} parameter value(s)`);
  });

  const globalsStorageKey = "builder.global.variables";
  const openGlobalsModal = () => {
    const globalsText = document.getElementById("builderGlobalsText");
    if (globalsText) globalsText.value = localStorage.getItem(globalsStorageKey) || "";
    globalsModal?.classList.remove("hidden");
  };
  const closeGlobalsModal = () => globalsModal?.classList.add("hidden");
  document.getElementById("builderGlobalsBtn")?.addEventListener("click", openGlobalsModal);
  document.getElementById("builderCloseGlobalsBtn")?.addEventListener("click", closeGlobalsModal);
  document.getElementById("builderSaveGlobalsBtn")?.addEventListener("click", () => {
    const globalsText = document.getElementById("builderGlobalsText");
    localStorage.setItem(globalsStorageKey, String(globalsText?.value ?? ""));
    showToast("Global variables saved");
    closeGlobalsModal();
  });

  document.addEventListener("keydown", async (e) => {
    const tag = e.target?.tagName;
    if (e.ctrlKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      await generateAndSaveStrategy();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "z") {
      if (typeof builderWorkspace !== "undefined" && builderWorkspace) {
        e.preventDefault();
        builderWorkspace.undo(false);
      }
      return;
    }
    if (e.key === " " && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
      e.preventDefault();
      if (builderRunning) {
        stopBtn?.click();
      } else {
        runBtn?.click();
      }
    }
  });

  const tooltip = document.getElementById("builderCategoryTooltip");
  document.querySelectorAll("[data-section-toggle]").forEach((row) => {
    row.addEventListener("click", () => {
      const section = row.dataset.sectionToggle;
      const hidden = row.dataset.closed === "1";
      row.dataset.closed = hidden ? "0" : "1";
      row.querySelector(".builder-cat-chevron").textContent = hidden ? "⌄" : "›";
      document.querySelectorAll(`[data-parent-section="${section}"]`).forEach((child) => {
        child.classList.toggle("hidden", !hidden);
      });
    });
  });
  document.querySelectorAll("#builderCategoryList li").forEach((item) => {
    if (item.dataset.sectionToggle) return;
    item.addEventListener("mouseenter", () => {
      if (!tooltip) return;
      const title = item.dataset.tipTitle || "Category";
      const ex = item.dataset.tipExample || "";
      tooltip.innerHTML = `<strong>${escapeHtml(title)}</strong><br/><code>${escapeHtml(ex)}</code>`;
      tooltip.classList.remove("hidden");
    });
    item.addEventListener("mouseleave", () => {
      tooltip?.classList.add("hidden");
    });
    item.addEventListener("click", () => {
      const already = item.classList.contains("builder-palette-cat--active");
      document.querySelectorAll("#builderCategoryList li").forEach((row) => row.classList.remove("builder-palette-cat--active"));
      if (!already) item.classList.add("builder-palette-cat--active");
      if (typeof filterBuilderToolbox === "function") {
        const key = item.dataset.category || "";
        const mapped = {
          analysis_logics: "analysis_logics",
          trade_parameters: "trade_parameters",
          purchase_conditions: "purchase_conditions",
          sell_conditions: "sell_conditions",
          restart_conditions: "restart_conditions",
          analysis: "analysis",
          utility: "utility",
          virtual_hook_switcher: "virtual_hook_switcher",
          binarytools: "binarytools",
          contract_modifiers: "contract_modifiers",
        };
        filterBuilderToolbox(already ? "" : (mapped[key] || key || item.textContent || ""));
      }
    });
  });
  document.getElementById("builderBlockSearch")?.addEventListener("input", (e) => {
    if (typeof filterBuilderToolbox === "function") {
      filterBuilderToolbox(e.target.value || "");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      quickModal?.classList.add("hidden");
      searchReplaceModal?.classList.add("hidden");
      globalsModal?.classList.add("hidden");
    }
  });
  if (quickStrategyTypeLabel) quickStrategyTypeLabel.value = getSelectedTemplate()?.label || "Martingale";
  const initialTemplate = getSelectedTemplate();
  if (initialTemplate) {
    const initialStake = document.getElementById("builderQuickStake");
    const initialLoss = document.getElementById("builderQuickLossThreshold");
    const initialProfit = document.getElementById("builderQuickProfitThreshold");
    if (initialStake) initialStake.value = String(initialTemplate.stake ?? 1);
    if (initialLoss) initialLoss.value = String(initialTemplate.loss ?? 25);
    if (initialProfit) initialProfit.value = String(initialTemplate.profit ?? 20);
  }

  function runFirstTimeTour() {
    if (!tourOverlay || !tourCallout) return;
    if (localStorage.getItem("builder.tour.completed") === "1") return;
    const steps = [
      { target: "#builderCategoryList", text: "Trade Parameters and Purchase Conditions live here." },
      { target: "#blocklyDiv", text: "Build and connect your strategy logic blocks on this canvas." },
      { target: "#builderRunBtn", text: "Run starts your active strategy instantly." },
    ];
    let idx = 0;
    const showStep = () => {
      const step = steps[idx];
      const target = document.querySelector(step.target);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      tourCallout.textContent = `${step.text} (${idx + 1}/${steps.length})`;
      tourCallout.style.left = `${Math.max(12, rect.left + 8)}px`;
      tourCallout.style.top = `${Math.max(12, rect.top - 52)}px`;
    };
    tourOverlay.classList.remove("hidden");
    showStep();
    tourOverlay.addEventListener("click", () => {
      idx += 1;
      if (idx >= steps.length) {
        tourOverlay.classList.add("hidden");
        localStorage.setItem("builder.tour.completed", "1");
        return;
      }
      showStep();
    });
  }

  initAuthButtons();
  refreshAuthState();
  loadCurrentStrategy();
  refreshBuilderStatus();
  runFirstTimeTour();
  setInterval(refreshBuilderStatus, 1500);
  window.setInterval(refreshAuthState, 15000);
}

const __path = window.location.pathname;
if (__path === "/" || __path === "") {
  initDashboardPage();
} else if (__path === "/manual-trader") {
  initManualTraderPage();
} else if (__path === "/strategies") {
  initStrategiesPage();
} else if (__path === "/analysis") {
  initAnalysisPage();
} else if (__path === "/copy-trading") {
  initCopyPage();
} else if (__path === "/builder") {
  initBuilderPage();
}
