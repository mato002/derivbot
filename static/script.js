const toastEl = document.getElementById("toast");
let toastHideTimer = null;
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
    showToast(`${alert.title}: ${alert.body}${durText}`, 2400);
  }
  while (stack.children.length > 5) {
    stack.removeChild(stack.firstChild);
  }
  window.setTimeout(removeEl, 5200);
}

function showToast(message, durationMs = 2000) {
  if (!toastEl) return;
  if (toastHideTimer) {
    window.clearTimeout(toastHideTimer);
    toastHideTimer = null;
  }
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  toastHideTimer = window.setTimeout(() => {
    toastEl.classList.add("hidden");
    toastHideTimer = null;
  }, durationMs);
}

function setLoading(button, isLoading) {
  if (button) {
    button.disabled = isLoading;
  }
}

function initSectionTabs() {
  const rows = document.querySelectorAll(".section-tabs");
  rows.forEach((row) => {
    const buttons = Array.from(row.querySelectorAll("button"));
    if (!buttons.length) return;
    buttons.forEach((btn, idx) => {
      if (idx === 0) btn.classList.add("is-active");
      btn.addEventListener("click", () => {
        buttons.forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
      });
    });
  });
}

function dashChartTheme() {
  const light =
    document.documentElement.classList.contains("trading-theme-light") ||
    document.body.classList.contains("trading-theme-light");
  if (light) {
    return {
      tick: "#5e7698",
      grid: "rgba(44, 87, 142, 0.1)",
      border: "rgba(44, 87, 142, 0.16)",
      tooltipBg: "#ffffff",
      tooltipBorder: "rgba(44, 87, 142, 0.16)",
      tooltipTitle: "#304866",
      tooltipBody: "#13263f",
      line: "#3970e0",
      fill: "rgba(57, 112, 224, 0.12)",
    };
  }
  return {
    tick: "#64748b",
    grid: "rgba(255,255,255,0.05)",
    border: "rgba(255,255,255,0.06)",
    tooltipBg: "#172033",
    tooltipBorder: "rgba(255,255,255,0.08)",
    tooltipTitle: "#cbd5e1",
    tooltipBody: "#fff",
    line: "#6b8cff",
    fill: "rgba(79, 125, 240, 0.14)",
  };
}

function applyDashChartTheme(chart) {
  if (!chart?.options) return;
  const t = dashChartTheme();
  const ds = chart.data?.datasets?.[0];
  if (ds) {
    ds.borderColor = t.line;
    ds.backgroundColor = t.fill;
  }
  chart.options.plugins.tooltip.backgroundColor = t.tooltipBg;
  chart.options.plugins.tooltip.borderColor = t.tooltipBorder;
  chart.options.plugins.tooltip.titleColor = t.tooltipTitle;
  chart.options.plugins.tooltip.bodyColor = t.tooltipBody;
  chart.options.scales.x.ticks.color = t.tick;
  chart.options.scales.x.grid.color = t.grid;
  chart.options.scales.x.border.color = t.border;
  chart.options.scales.y.ticks.color = t.tick;
  chart.options.scales.y.grid.color = t.grid;
  chart.options.scales.y.border.color = t.border;
  chart.update("none");
}

function initThemeToggle() {
  const btn = document.getElementById("themeToggleBtn");
  if (!btn) return;
  const key = "derivbot_theme_pref";
  const root = document.documentElement;
  const syncTheme = (light) => {
    root.classList.toggle("trading-theme-light", light);
    document.body.classList.toggle("trading-theme-light", light);
    btn.textContent = light ? "☀" : "◐";
    btn.setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
    btn.title = light ? "Switch to dark mode" : "Switch to light mode";
    applyDashChartTheme(profitChart);
  };
  try {
    const saved = localStorage.getItem(key);
    syncTheme(saved === "light");
  } catch (_e) {}
  btn.addEventListener("click", () => {
    const light = !root.classList.contains("trading-theme-light");
    syncTheme(light);
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 250);
    try {
      localStorage.setItem(key, light ? "light" : "dark");
    } catch (_e) {}
  });
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

function extractLastDigitFromPrice(value) {
  const s = String(value ?? "");
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const ch = s[i];
    if (ch >= "0" && ch <= "9") return Number(ch);
  }
  return null;
}

function bumpTickArrow(el) {
  if (!el) return;
  el.classList.remove("matches-tick-arrow--pulse");
  void el.offsetWidth;
  el.classList.add("matches-tick-arrow--pulse");
}

function applyMovementArrow(el, priorVal, currentVal, { pulse = true } = {}) {
  if (!el) return;
  el.classList.remove("matches-tick-arrow--up", "matches-tick-arrow--down", "matches-tick-arrow--flat");
  if (priorVal == null || currentVal == null || Number.isNaN(currentVal)) {
    el.textContent = "";
    return;
  }
  const eps = 1e-12;
  let dir = "flat";
  if (currentVal > priorVal + eps) dir = "up";
  else if (currentVal < priorVal - eps) dir = "down";
  if (dir === "up") {
    el.textContent = "▲";
    el.classList.add("matches-tick-arrow--up");
  } else if (dir === "down") {
    el.textContent = "▼";
    el.classList.add("matches-tick-arrow--down");
  } else {
    el.textContent = "·";
    el.classList.add("matches-tick-arrow--flat");
  }
  if (pulse) bumpTickArrow(el);
}

function renderDigitGridFromPoints(grid, points, sampleSize, trendGlyphs) {
  if (!grid) return;
  const sample = (points || []).slice(-sampleSize);
  const countsSlice = (slice) => {
    const c = Array.from({ length: 10 }, () => 0);
    slice.forEach((p) => {
      const dd = extractLastDigitFromPrice(p?.price);
      if (dd != null && dd >= 0 && dd <= 9) c[dd] += 1;
    });
    return c;
  };
  const countsAll = countsSlice(sample);
  const total = countsAll.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sample.length / 2);
  const recent = mid >= 8 ? sample.slice(mid) : sample.slice(-Math.min(30, sample.length));
  const prev = mid >= 8 ? sample.slice(0, mid) : sample.slice(0, Math.max(0, sample.length - recent.length));
  const countRecent = countsSlice(recent);
  const countPrev = countsSlice(prev);
  const maxAll = Math.max(...countsAll, 1);
  const maxC = total > 0 ? Math.max(...countsAll) : 0;
  const minC = total > 0 ? Math.min(...countsAll) : 0;
  const uniformFreq = total > 0 && maxC === minC;
  const glyphs = trendGlyphs || Array.from({ length: 10 }, () => null);

  const simplified = grid.classList.contains("manual-barrier-digit-grid");

  grid.querySelectorAll(".digit-cell").forEach((cell) => {
    const d = Number(cell.dataset.digit);
    const pctEl = cell.querySelector(".digit-cell-pct");
    const expEl = cell.querySelector(".digit-cell-exp");
    const heatEl = cell.querySelector(".digit-cell-heat");
    const barFill = cell.querySelector(".digit-cell-bar-fill");
    const trendEl = cell.querySelector(".digit-cell-trend");
    const cnt = countsAll[d];
    const pct = total > 0 && !Number.isNaN(d) ? (countsAll[d] / total) * 100 : 0;
    if (pctEl) pctEl.textContent = total > 0 ? `${pct.toFixed(1)}%` : "--";
    if (!simplified && expEl) expEl.textContent = total > 0 ? "10.0%" : "--";
    const isMost = total > 0 && !uniformFreq && cnt === maxC;
    const isLeast = total > 0 && !uniformFreq && cnt === minC;
    const z = total > 0 ? (cnt - total / 10) / Math.sqrt(Math.max((total / 10) * 0.9, 1e-9)) : 0;
    cell.classList.toggle("digit-cell--freq-most", !simplified && isMost);
    cell.classList.toggle("digit-cell--freq-least", !simplified && isLeast);
    cell.classList.toggle("matches-digit-cell--hot", total > 0 && (isMost || z >= 1.1));
    cell.classList.toggle("matches-digit-cell--cold", total > 0 && (isLeast || z <= -1.1));
    cell.classList.remove("digit-cell--hot");
    if (!simplified && heatEl) {
      let heatLabel = "·";
      if (total > 0 && !uniformFreq) {
        if (isMost || z >= 1.1) heatLabel = "HOT";
        else if (isLeast || z <= -1.1) heatLabel = "COLD";
        else heatLabel = "NEU";
      }
      heatEl.textContent = heatLabel;
    }
    if (simplified || !barFill) {
      if (simplified) return;
    }
    if (barFill) {
      const hPct = maxAll > 0 ? (cnt / maxAll) * 100 : 0;
      barFill.style.height = `${Math.max(6, hPct)}%`;
      barFill.classList.remove(
        "digit-cell-bar-fill--most",
        "digit-cell-bar-fill--mid",
        "digit-cell-bar-fill--least",
        "digit-cell-bar-fill--high",
        "digit-cell-bar-fill--low",
      );
      if (total > 0) {
        if (isMost) barFill.classList.add("digit-cell-bar-fill--most");
        else if (isLeast) barFill.classList.add("digit-cell-bar-fill--least");
        else barFill.classList.add("digit-cell-bar-fill--mid");
        barFill.style.opacity = `${Math.min(1, 0.45 + Math.abs(z) * 0.28)}`;
      } else {
        barFill.classList.add("digit-cell-bar-fill--mid");
        barFill.style.opacity = "0.5";
      }
    }
    if (!simplified && trendEl) {
      const cr = countRecent[d];
      const cp = countPrev[d];
      let t = "·";
      let tcls = "digit-cell-trend--flat";
      if (recent.length >= 8 && prev.length >= 8) {
        if (cr > cp) {
          t = "▲";
          tcls = "digit-cell-trend--up";
        } else if (cr < cp) {
          t = "▼";
          tcls = "digit-cell-trend--down";
        }
      }
      trendEl.textContent = t;
      trendEl.className = `digit-cell-trend ${tcls}`;
      if (glyphs[d] !== t) {
        void trendEl.offsetWidth;
        trendEl.classList.add("matches-digit-trend--pulse");
      }
      glyphs[d] = t;
    }
  });
  return glyphs;
}

function syncDigitGridTickHighlight(grid, digit) {
  if (!grid || digit == null || digit < 0 || digit > 9) return;
  grid.querySelectorAll(".digit-cell").forEach((cell) => {
    const d = Number(cell.dataset.digit);
    cell.classList.toggle("digit-cell--tick", d === digit);
  });
}

function moveDigitPointerToCell(grid, pointerEl, digit) {
  if (!grid || !pointerEl || digit == null || digit < 0 || digit > 9) return;
  const target = grid.querySelector(`.digit-cell[data-digit="${digit}"]`);
  if (!target) return;
  const place = () => {
    const gridRect = grid.getBoundingClientRect();
    const cellRect = target.getBoundingClientRect();
    const x = Math.round(cellRect.left - gridRect.left + cellRect.width / 2);
    pointerEl.style.transform = `translateX(${x}px)`;
    pointerEl.classList.remove("hidden");
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(place);
  else place();
}

async function fetchLiveMarketPoints(symbol = "R_100", { fresh = true } = {}) {
  const q = new URLSearchParams({ symbol, timeframe: "tick" });
  if (fresh) q.set("fresh", "1");
  const res = await requestJson(`/market-data?${q.toString()}`);
  if (!res?.success) return { points: [], stale: true };
  return { points: res?.data?.points || [], stale: !!res.stale };
}

function applyLatestTickMotion(points, state) {
  if (!points?.length) return state;
  const latest = points[points.length - 1];
  const prior = points.length > 1 ? points[points.length - 2] : null;
  const price = Number(latest.price ?? NaN);
  const digit = extractLastDigitFromPrice(latest.price);
  const priorPrice = prior ? Number(prior.price ?? NaN) : state.prevPrice;
  const priorDigit = prior ? extractLastDigitFromPrice(prior.price) : state.prevDigit;
  if (Number.isFinite(price)) {
    applyMovementArrow(state.priceArrowEl, priorPrice, price, {
      pulse: state.prevPrice != null && price !== state.prevPrice,
    });
    state.prevPrice = price;
  }
  if (digit != null) {
    applyMovementArrow(state.digitArrowEl, priorDigit, digit, {
      pulse: state.prevDigit != null && digit !== state.prevDigit,
    });
    state.prevDigit = digit;
    if (state.liveDigitEl) state.liveDigitEl.textContent = String(digit);
    if (state.pointerEl) {
      moveDigitPointerToCell(state.grid, state.pointerEl, digit);
    } else {
      syncDigitGridTickHighlight(state.grid, digit);
    }
  }
  return state;
}
/** Last resolved Deriv account balance (for dashboard Balance card). */
let lastDerivBalance = null;
let accountSwitchInFlight = false;

function resolveEffectiveBalance(status) {
  const botBal = Number(status?.balance ?? NaN);
  const derivBal = Number(lastDerivBalance);
  const trades = Number(status?.trades_count ?? 0);
  if (trades > 0 && Number.isFinite(botBal)) return botBal;
  if (Number.isFinite(derivBal)) return derivBal;
  return Number.isFinite(botBal) ? botBal : 0;
}
window.resolveEffectiveBalance = resolveEffectiveBalance;

function applySessionBalance(balance, { syncHeader = true } = {}) {
  const bal = Number(balance);
  if (!Number.isFinite(bal)) return;
  lastDerivBalance = bal;
  if (!syncHeader) return;
  const chipEl = document.getElementById("headerWalletBalance");
  if (!chipEl) return;
  const currency = lastDerivMe?.account?.currency ?? "USD";
  chipEl.textContent = `${bal.toFixed(2)} ${currency}`.trim();
  const acctCurrencyEl = document.getElementById("acctCurrency");
  if (acctCurrencyEl) acctCurrencyEl.textContent = currency;
  if (window.AccountOverview && document.getElementById("balance")) {
    const base = window.__lastDashStatus || {};
    window.AccountOverview.updateFromStatus(base, { animate: true });
  }
}

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
  const dashLoginStatusEl = document.getElementById("dashLoginStatus");
  const loginBtn = document.getElementById("loginDerivBtn");
  const headerLoginBtn = document.getElementById("headerWalletLoginBtn");
  const headerApiTokenBtn = document.getElementById("headerApiTokenBtn");
  const headerSignupBtn = document.getElementById("headerSignupBtn");
  const accessMenuBtn = document.getElementById("accessMenuBtn");
  const accessMenuLoginBtn = document.getElementById("accessMenuLoginBtn");
  const accessMenuApiTokenBtn = document.getElementById("accessMenuApiTokenBtn");
  const accessMenuSignupBtn = document.getElementById("accessMenuSignupBtn");
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
      if (dashLoginStatusEl) dashLoginStatusEl.textContent = `${tag} account`;
      const acctCurrencyEl = document.getElementById("acctCurrency");
      if (acctCurrencyEl) acctCurrencyEl.textContent = currency || "USD";
      loginBtn.classList.add("hidden");
      headerLoginBtn?.classList.add("hidden");
      headerApiTokenBtn?.classList.add("hidden");
      headerSignupBtn?.classList.add("hidden");
      accessMenuBtn?.classList.add("hidden");
      try {
        const balanceData = await requestJson("/auth/deriv/balance");
        const balance = Number(balanceData.balance?.balance ?? 0).toFixed(2);
        const balanceCurrency = balanceData.balance?.currency ?? currency ?? "";
        const line = `${balance} ${balanceCurrency}`.trim();
        const balNum = Number(balanceData.balance?.balance ?? NaN);
        if (!balanceData.stale && !balanceData.rate_limited && Number.isFinite(balNum)) {
          lastDerivBalance = balNum;
          headerWalletText = line;
        } else if (Number.isFinite(lastDerivBalance)) {
          headerWalletText = `${lastDerivBalance.toFixed(2)} ${balanceCurrency}`.trim();
        } else {
          headerWalletText = line;
          if (Number.isFinite(balNum)) lastDerivBalance = balNum;
        }
        if (derivAccountBalanceEl) {
          setDerivAccountMetric(`Deriv balance: ${headerWalletText}`);
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
      if (dashLoginStatusEl) dashLoginStatusEl.textContent = "Disconnected";
      loginBtn.classList.remove("hidden");
      headerLoginBtn?.classList.remove("hidden");
      headerApiTokenBtn?.classList.remove("hidden");
      headerSignupBtn?.classList.remove("hidden");
      accessMenuBtn?.classList.remove("hidden");
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
    if (dashLoginStatusEl) dashLoginStatusEl.textContent = "Auth unavailable";
    headerWalletText = "--";
    headerLoginBtn?.classList.remove("hidden");
    headerApiTokenBtn?.classList.remove("hidden");
    headerSignupBtn?.classList.remove("hidden");
    accessMenuBtn?.classList.remove("hidden");
    if (derivAccountBalanceEl) {
      setDerivAccountMetric("Deriv balance: unavailable");
    }
    updateAccountModeBar({ logged_in: false, accounts: [] });
  }

  if (chipEl) {
    chipEl.textContent = headerWalletText;
  }
  syncHeaderConnectionState();
  syncMatchesAccountFromAuth();
  syncTradingStatusBar(window.__lastDashStatus || {});
  if (window.AccountOverview && document.getElementById("balance")) {
    window.AccountOverview.updateFromStatus(window.__lastDashStatus || {}, { animate: true });
  }
}

function syncHeaderConnectionState() {
  const dotEl = document.getElementById("connectionStatusDot");
  const textEl = document.getElementById("connectionStatusText");
  const typeEl = document.getElementById("headerAccountType");
  const loggedIn = !!lastDerivMe?.logged_in && !!lastDerivMe?.account;
  if (textEl) {
    textEl.textContent = loggedIn ? "API Connected" : "Not connected";
    textEl.classList.toggle("is-offline", !loggedIn);
  }
  if (dotEl) {
    dotEl.classList.toggle("is-offline", !loggedIn);
  }
  if (typeEl) {
    if (loggedIn) {
      const isReal = lastDerivMe.account?.kind === "real";
      typeEl.textContent = isReal ? "Real" : "Demo";
      typeEl.classList.remove("hidden");
      typeEl.classList.toggle("header-account-type--real", isReal);
      typeEl.classList.toggle("header-account-type--demo", !isReal);
    } else {
      typeEl.textContent = "";
      typeEl.classList.add("hidden");
      typeEl.classList.remove("header-account-type--real", "header-account-type--demo");
    }
  }
}

function syncMatchesAccountFromAuth() {
  const accountStateEl = document.getElementById("matchesAccountState");
  const balanceEl = document.getElementById("matchesSessionBalance");
  const loggedIn = !!lastDerivMe?.logged_in && !!lastDerivMe?.account;
  if (accountStateEl) {
    if (loggedIn) {
      const kind = lastDerivMe.account?.kind === "real" ? "Real" : "Demo";
      const bal =
        Number.isFinite(Number(lastDerivBalance)) && Number(lastDerivBalance) >= 0
          ? ` · $${Number(lastDerivBalance).toFixed(2)}`
          : "";
      accountStateEl.textContent = `${lastDerivMe.account?.account ?? "Account"} (${kind})${bal}`;
    } else {
      accountStateEl.textContent = "Not logged in";
    }
  }
  if (balanceEl) {
    if (Number.isFinite(lastDerivBalance) && lastDerivBalance >= 0) {
      balanceEl.textContent = `$${Number(lastDerivBalance).toFixed(2)}`;
    } else if (loggedIn) {
      balanceEl.textContent = "Unavailable";
    } else {
      balanceEl.textContent = "Login to view";
    }
  }
}

wireProfileMenuOnce();
wireHeaderWalletMenuOnce();

function initAuthButtons() {
  const loginBtn = document.getElementById("loginDerivBtn");
  const headerLoginBtn = document.getElementById("headerWalletLoginBtn");
  const headerApiTokenBtn = document.getElementById("headerApiTokenBtn");
  const accessMenuBtn = document.getElementById("accessMenuBtn");
  const accessMenuDropdown = document.getElementById("accessMenuDropdown");
  const accessMenuLoginBtn = document.getElementById("accessMenuLoginBtn");
  const accessMenuApiTokenBtn = document.getElementById("accessMenuApiTokenBtn");
  const apiTokenModal = document.getElementById("apiTokenModal");
  const apiTokenInput = document.getElementById("apiTokenInput");
  const apiTokenError = document.getElementById("apiTokenError");
  const apiTokenCancelBtn = document.getElementById("apiTokenCancelBtn");
  const apiTokenSubmitBtn = document.getElementById("apiTokenSubmitBtn");
  const onLogin = () => {
    window.location.href = "/auth/deriv/login";
  };
  if (loginBtn && !loginBtn.dataset.authBound) {
    loginBtn.addEventListener("click", onLogin);
    loginBtn.dataset.authBound = "1";
  }
  if (headerLoginBtn && !headerLoginBtn.dataset.authBound) {
    headerLoginBtn.addEventListener("click", onLogin);
    headerLoginBtn.dataset.authBound = "1";
  }
  if (accessMenuLoginBtn && !accessMenuLoginBtn.dataset.authBound) {
    accessMenuLoginBtn.addEventListener("click", onLogin);
    accessMenuLoginBtn.dataset.authBound = "1";
  }
  if (accessMenuBtn && accessMenuDropdown && !accessMenuBtn.dataset.authBound) {
    accessMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      accessMenuDropdown.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!accessMenuDropdown.contains(e.target) && !accessMenuBtn.contains(e.target)) {
        accessMenuDropdown.classList.add("hidden");
      }
    });
    accessMenuBtn.dataset.authBound = "1";
  }

  if (headerApiTokenBtn && apiTokenModal && !headerApiTokenBtn.dataset.authBound) {
    const closeModal = () => {
      apiTokenModal.classList.add("hidden");
      accessMenuDropdown?.classList.add("hidden");
      if (apiTokenError) {
        apiTokenError.classList.add("hidden");
        apiTokenError.textContent = "";
      }
      if (apiTokenInput) apiTokenInput.value = "";
    };
    const openModal = () => {
      apiTokenModal.classList.remove("hidden");
      accessMenuDropdown?.classList.add("hidden");
      if (apiTokenInput) apiTokenInput.focus();
    };
    headerApiTokenBtn.addEventListener("click", openModal);
    accessMenuApiTokenBtn?.addEventListener("click", openModal);
    apiTokenCancelBtn?.addEventListener("click", closeModal);
    apiTokenModal.addEventListener("click", (e) => {
      if (e.target === apiTokenModal) closeModal();
    });
    apiTokenSubmitBtn?.addEventListener("click", async () => {
      const token = String(apiTokenInput?.value || "").trim();
      if (!token) return;
      setLoading(apiTokenSubmitBtn, true);
      /** True only after `/auth/deriv/login-token` succeeded (avoid showing errors from follow-up polls). */
      let tokenAccepted = false;
      try {
        const res = await fetch("/auth/deriv/login-token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ token }),
          credentials: "same-origin",
          redirect: "manual",
        });
        if (res.status === 405) {
          throw new Error(
            'Server returned 405 — old build may still redirect this POST as GET to "/". ' +
              "Restart uvicorn from your project folder: python -m uvicorn app:app --reload"
          );
        }
        // Old server builds returned Redirect→"/"; fetch followed with POST→405. With redirect:manual,
        // we get 3xx once — send user with GET so session cookie from the redirect response applies.
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("Location");
          window.location.href =
            loc && /^https?:\/\//i.test(loc)
              ? loc
              : loc && loc.startsWith("/")
                ? `${window.location.origin}${loc}`
                : "/";
          return;
        }
        if (!res.ok) {
          let msg = `Token login failed (${res.status})`;
          try {
            const data = await res.json();
            const d = data?.detail;
            if (typeof d === "string") msg = d;
            else if (Array.isArray(d))
              msg = d.map((x) => x?.msg || x?.type || String(x)).join("; ") || msg;
          } catch (_e) {}
          throw new Error(msg);
        }
        try {
          await res.json();
        } catch (_e) {
          /* ignore empty / non-JSON success */
        }
        tokenAccepted = true;
        closeModal();
        showToast("Token login successful");
        /* Session is already set; refresh can race or hit transient 405 from other tabs — full reload is source of truth. */
        try {
          await refreshAuthState();
        } catch (_e) {
          /* ignore */
        }
        window.location.reload();
      } catch (error) {
        if (apiTokenError && !tokenAccepted) {
          apiTokenError.textContent = error.message || "Token login failed";
          apiTokenError.classList.remove("hidden");
        }
      } finally {
        setLoading(apiTokenSubmitBtn, false);
      }
    });
    apiTokenInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apiTokenSubmitBtn?.click();
      } else if (e.key === "Escape") {
        closeModal();
      }
    });
    headerApiTokenBtn.dataset.authBound = "1";
  }
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

function renderDashDigitTape(digits) {
  const tape = document.getElementById("dashDigitTape");
  if (!tape) return;
  const arr = Array.isArray(digits) ? digits.map((d) => Number(d)) : [];
  const digitChanged = window.DashboardPolish?.noteDigitTape?.(arr) ?? false;
  if (!arr.length) {
    tape.innerHTML = '<span class="dash-digit dash-digit--empty">—</span>';
    return;
  }
  tape.innerHTML = arr
    .slice(-24)
    .map((d, i, list) => {
      const isLast = i === list.length - 1;
      const pop = isLast && digitChanged ? " dash-digit--pop" : "";
      return `<span class="dash-digit${isLast ? " dash-digit--latest" : ""}${pop}">${Number.isFinite(d) ? d : "—"}</span>`;
    })
    .join("");
}

function renderDashOpenTrades(status) {
  const list = document.getElementById("dashOpenTradesList");
  const countEl = document.getElementById("dashOpenTradesCount");
  if (!list) return;
  const active = status?.active_trades ?? [];
  const stake = Number(status?.stake ?? 0);
  if (countEl) {
    if (window.DashboardPolish) {
      window.DashboardPolish.updateCounter(countEl, active.length);
    } else {
      countEl.textContent = String(active.length);
    }
  }
  if (!active.length) {
    list.innerHTML = '<li class="dash-open-trade dash-open-trade--empty">No open positions</li>';
    return;
  }
  list.innerHTML = active
    .map((trade) => {
      const type = String(trade?.type ?? "digit").toUpperCase();
      const state = String(trade?.state ?? "open");
      const stakeLine = Number.isFinite(stake) && stake > 0 ? `$${stake.toFixed(2)}` : "—";
      return `<li class="dash-open-trade dash-open-trade--live">
        <span class="dash-open-trade__type">${type}</span>
        <span class="dash-open-trade__state">${state}</span>
        <strong class="dash-open-trade__stake">${stakeLine}</strong>
      </li>`;
    })
    .join("");
}

function resolveBotState(status) {
  if (!status?.running) return "stopped";
  const state = String(status.bot_state || "").toLowerCase();
  if (state === "paused") return "paused";
  if (status.user_paused || status.hybrid_paused || status.risk?.paused || status.session_paused) {
    return "paused";
  }
  return "running";
}

function formatRiskLevel(risk) {
  if (!risk || typeof risk !== "object") return "—";
  const dd = Number(risk.max_session_drawdown_pct ?? 10);
  if (risk.paused) return "Limit hit";
  if (dd <= 5) return "Conservative";
  if (dd <= 12) return "Moderate";
  return "Aggressive";
}

function syncTradingStatusBar(status) {
  const bar = document.getElementById("dashStatusBar");
  if (!bar) return;

  const connEl = document.getElementById("statusBarConnection");
  const connDot = document.getElementById("statusBarConnectionDot");
  const accountEl = document.getElementById("statusBarAccount");
  const balanceEl = document.getElementById("statusBarBalance");
  const openEl = document.getElementById("statusBarOpenTrades");
  const strategyEl = document.getElementById("statusBarStrategy");
  const botEl = document.getElementById("statusBarBotState");

  const loggedIn = !!lastDerivMe?.logged_in && !!lastDerivMe?.account;
  if (connEl) {
    connEl.textContent = loggedIn ? "Connected" : "Offline";
    connEl.classList.toggle("is-offline", !loggedIn);
  }
  if (connDot) {
    connDot.classList.toggle("is-offline", !loggedIn);
    connDot.classList.toggle("is-live", loggedIn);
  }

  if (accountEl) {
    if (loggedIn) {
      const account = lastDerivMe.account?.account ?? "Account";
      const tag = lastDerivMe.account?.kind === "real" ? "Real" : "Demo";
      accountEl.textContent = `${account} (${tag})`;
    } else {
      accountEl.textContent = "Not logged in";
    }
  }

  const snap = status || window.__lastDashStatus || {};
  const effectiveBalance = typeof resolveEffectiveBalance === "function"
    ? resolveEffectiveBalance(snap)
    : Number(snap.balance ?? 0);
  const currency = lastDerivMe?.account?.currency ?? "USD";

  if (balanceEl) {
    const balanceText = `${effectiveBalance.toFixed(2)} ${currency}`.trim();
    if (window.DashboardPolish) {
      window.DashboardPolish.updateDecimal(balanceEl, effectiveBalance, {
        suffix: ` ${currency}`,
        animate: true,
      });
    } else {
      balanceEl.textContent = balanceText;
      balanceEl.dataset.rawValue = String(effectiveBalance);
    }
  }

  const openCount = (snap.active_trades ?? []).length;
  if (openEl) {
    if (window.DashboardPolish) {
      window.DashboardPolish.updateCounter(openEl, openCount);
    } else {
      openEl.textContent = String(openCount);
    }
    openEl.classList.toggle("is-active", openCount > 0);
  }

  const action = snap.strategy?.active_action || snap.strategy?.action || "over_under";
  const rules = snap.strategy?.actions?.[action]?.rules || snap.strategy?.rules || {};
  const stratLabel = action === "rise_fall" ? "Rise/Fall" : "Over/Under";
  if (strategyEl) {
    strategyEl.textContent = `${stratLabel} ≥${rules.if_digit_greater_equal ?? 5}`;
  }

  const botState = resolveBotState(snap);
  if (botEl) {
    const label = botState === "running" ? "Running" : botState === "paused" ? "Paused" : "Stopped";
    const prevState = botEl.dataset.botState || "";
    if (window.DashboardPolish && prevState && prevState !== botState) {
      window.DashboardPolish.updateText(botEl, label, { dir: botState === "running" ? "up" : "neutral" });
    } else {
      botEl.textContent = label;
    }
    botEl.dataset.botState = botState;
    botEl.classList.remove("is-running", "is-paused", "is-stopped");
    botEl.classList.add(
      botState === "running" ? "is-running" : botState === "paused" ? "is-paused" : "is-stopped"
    );
  }
}

function syncCommandTerminal(status) {
  const pillsRoot = document.getElementById("cmdStatusPills");
  if (!pillsRoot) return;

  const state = resolveBotState(status);
  pillsRoot.querySelectorAll(".bot-status-pill").forEach((pill) => {
    pill.classList.toggle("is-active", pill.dataset.state === state);
  });

  const strategyEl = document.getElementById("cmdStrategyValue");
  const riskEl = document.getElementById("cmdRiskLevel");
  const profitEl = document.getElementById("cmdSessionProfit");
  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const stopBtn = document.getElementById("stopBtn");

  const action = status?.strategy?.active_action || status?.strategy?.action || "over_under";
  const rules = status?.strategy?.actions?.[action]?.rules || status?.strategy?.rules || {};
  const label = action === "rise_fall" ? "Rise/Fall" : "Over/Under";
  const strategyLine = `${label} · ≥${rules.if_digit_greater_equal ?? 5}`;

  if (strategyEl) strategyEl.textContent = strategyLine;
  const dashMode = document.getElementById("dashActiveStrategyName");
  if (dashMode) dashMode.textContent = strategyLine;
  const dashRuntime = document.getElementById("dashRuntimeBotState");
  if (dashRuntime) {
    dashRuntime.textContent = state === "running" ? "Running" : state === "paused" ? "Paused" : "Stopped";
  }

  if (riskEl) {
    riskEl.textContent = formatRiskLevel(status?.risk);
    riskEl.classList.toggle("is-elevated", formatRiskLevel(status?.risk) === "Aggressive");
  }

  const profit = Number(status?.profit ?? 0);
  if (profitEl) {
    if (window.DashboardPolish) {
      window.DashboardPolish.updateSignedMoney(profitEl, profit);
    } else {
      profitEl.textContent = `${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}`;
    }
    profitEl.classList.toggle("is-profit", profit > 0);
    profitEl.classList.toggle("is-loss", profit < 0);
    profitEl.classList.toggle("is-flat", profit === 0);
  }

  const startLabel = startBtn?.querySelector(".cmd-btn__label");
  if (startBtn) {
    const isResume = state === "paused";
    startBtn.disabled = state === "running";
    startBtn.classList.toggle("cmd-btn--resume", isResume);
    if (startLabel) startLabel.textContent = isResume ? "Resume" : "Start";
    startBtn.title = isResume ? "Resume bot" : "Start bot";
  }
  if (pauseBtn) {
    pauseBtn.disabled = state !== "running";
  }
  if (stopBtn) {
    stopBtn.disabled = state === "stopped";
  }
  syncTradingStatusBar(status);
}

function renderDashSignals(status) {
  const labelEl = document.getElementById("dashSignalLabel");
  if (!labelEl) return;
  const confEl = document.getElementById("dashSignalConfidence");
  const fillEl = document.getElementById("dashSignalMeterFill");
  const entryEl = document.getElementById("dashSignalEntry");
  const detailEl = document.getElementById("dashSignalDetail");
  const reasonsEl = document.getElementById("dashSignalReasons");
  const cf = status?.confluence;
  const pipe = status?.last_pipeline;

  if (cf && typeof cf === "object") {
    labelEl.textContent = String(cf.signal ?? "—").toUpperCase();
    labelEl.classList.toggle("dash-signal-hero__label--bull", /over|rise|call|buy/i.test(String(cf.signal ?? "")));
    labelEl.classList.toggle("dash-signal-hero__label--bear", /under|fall|put|sell/i.test(String(cf.signal ?? "")));
    const pct = Math.min(100, Math.max(0, Number(cf.confidence ?? 0)));
    if (confEl) confEl.textContent = String(Math.round(pct));
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (entryEl) {
      entryEl.textContent = cf.entry_allowed ? "ENTRY OK" : "BLOCKED";
      entryEl.classList.toggle("terminal-chip--live", !!cf.entry_allowed);
    }
    if (detailEl) {
      detailEl.textContent = `${cf.marketMode ?? "Market"} · ${cf.entry_allowed ? "Entry permitted" : "Entry blocked"}`;
    }
    if (reasonsEl) {
      reasonsEl.innerHTML = "";
      (cf.reasons || []).slice(0, 5).forEach((r) => {
        const li = document.createElement("li");
        li.textContent = r;
        reasonsEl.appendChild(li);
      });
    }
    return;
  }

  if (pipe && typeof pipe === "object") {
    const decision = pipe.decision && typeof pipe.decision === "object" ? pipe.decision : {};
    labelEl.textContent = pipe.approved ? "APPROVED" : "SKIPPED";
    labelEl.classList.remove("dash-signal-hero__label--bull", "dash-signal-hero__label--bear");
    if (confEl) confEl.textContent = pipe.approved ? "100" : "0";
    if (fillEl) fillEl.style.width = pipe.approved ? "100%" : "8%";
    if (entryEl) entryEl.textContent = pipe.approved ? "PIPELINE" : "WAIT";
    if (detailEl) {
      const parts = [
        pipe.skip_reason ? `Skip: ${pipe.skip_reason}` : "",
        decision.side ? `Side: ${decision.side}` : "",
        decision.contract_type ? String(decision.contract_type) : "",
        decision.barrier != null ? `Barrier ${decision.barrier}` : "",
      ].filter(Boolean);
      detailEl.textContent = parts.join(" · ") || "Pipeline evaluated";
    }
    if (reasonsEl) reasonsEl.innerHTML = "";
    return;
  }

  labelEl.textContent = status?.running ? "SCANNING" : "IDLE";
  labelEl.classList.remove("dash-signal-hero__label--bull", "dash-signal-hero__label--bear");
  if (confEl) confEl.textContent = "0";
  if (fillEl) fillEl.style.width = "4%";
  if (entryEl) entryEl.textContent = status?.running ? "LIVE" : "OFF";
  if (detailEl) {
    detailEl.textContent = status?.running
      ? "Bot running — awaiting confluence signal…"
      : "Start the bot to receive live signals.";
  }
  if (reasonsEl) reasonsEl.innerHTML = "";
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
    const restId = d.trading_api_deriv_app_id_preview || "—";
    const wsPart = d.ws_app_id_numeric ? String(d.ws_app_id) : `${d.ws_app_id} (legacy WS — check)`;
    setState(wsEl, `${wsPart} · REST ${restId}`, d.ws_app_id_numeric ? "ok" : "warn");
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
  const minScore = el("confMinScore");
  if (minScore) minScore.value = String(Math.round(Number(ccfg.min_score ?? 5)));
  const minConf = el("confMinConfirmations");
  if (minConf) minConf.value = String(Math.round(Number(ccfg.min_confirmations ?? 2)));
  const hist = el("confHistoryTicks");
  if (hist) hist.value = String(Math.round(Number(ccfg.history_ticks ?? 900)));
  const enforce = el("confEnforce");
  if (enforce) enforce.value = pick("enforce_confluence", true) ? "true" : "false";
}

function formatDecisionTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "—";
  return new Date(n * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function gateCell(passed) {
  if (passed === true) return '<span class="strat-gate strat-gate--ok">✓</span>';
  if (passed === false) return '<span class="strat-gate strat-gate--no">✗</span>';
  return "—";
}

function applyRuntimeSummary(runtime) {
  if (!runtime) return;
  const botState = document.getElementById("stratRuntimeBotState");
  if (botState) {
    botState.textContent = runtime.running ? "Running" : "Stopped";
    botState.className = `strat-policy-pill ${runtime.running ? "strat-policy-pill--live" : "strat-policy-pill--offline"}`;
  }
  const rulesEl = document.getElementById("stratRuntimeRules");
  if (rulesEl && runtime.rules_summary) {
    const r = runtime.rules_summary;
    const mode = runtime.active_action === "rise_fall" ? "Rise/Fall" : "Over/Under";
    rulesEl.textContent = `${mode} · threshold ${r.threshold} · ${r.trade}/${r.else_trade}`;
  }
  const depEl = document.getElementById("stratRuntimeDeployment");
  if (depEl) {
    const d = runtime.deployment;
    depEl.textContent = d
      ? `${d.strategy_name || "Bot"} v${d.strategy_version || 1} · ${d.market || "R_100"}`
      : "Manual / legacy runtime (strategy.json)";
  }
  const compatEl = document.getElementById("stratRuntimeCompat");
  if (compatEl && runtime.compatibility) {
    compatEl.textContent = runtime.compatibility.all_reachable
      ? "All signal paths reachable"
      : `${runtime.compatibility.blocked_count} blocked path(s)`;
    compatEl.classList.toggle("strat-warn", !runtime.compatibility.all_reachable);
  }
  const profileEl = document.getElementById("stratRuntimeProfile");
  if (profileEl) {
    profileEl.textContent = runtime.profile ? runtime.profile : "Custom";
  }
}

function applyPipelineStatus(status) {
  const el = document.getElementById("stratPipelineStatus");
  if (!el) return;
  const pipe = status?.last_pipeline;
  if (!pipe || typeof pipe !== "object") {
    el.textContent = status?.running ? "Bot running — waiting for pipeline activity…" : "Bot stopped.";
    return;
  }
  const decision = pipe.decision && typeof pipe.decision === "object" ? pipe.decision : {};
  const lines = [
    `Approved: ${pipe.approved ? "yes" : "no"}`,
    pipe.skip_reason ? `Skip: ${pipe.skip_reason}` : "",
    decision.side ? `Side: ${decision.side}` : "",
    decision.contract_type ? `Contract: ${decision.contract_type}` : "",
    decision.barrier != null ? `Barrier: ${decision.barrier}` : "",
  ].filter(Boolean);
  el.textContent = lines.join(" · ") || "Pipeline evaluated — no detail";
}

function renderDecisionLog(rows) {
  const body = document.getElementById("stratDecisionLogBody");
  if (!body) return;
  if (!rows?.length) {
    body.innerHTML = '<tr><td colspan="8" class="subtle">No decisions yet</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((r) => {
      const reason = String(r.skip_reason || (r.executed ? "executed" : "")).slice(0, 48);
      return `<tr>
        <td>${formatDecisionTime(r.timestamp)}</td>
        <td>${r.side || "—"}</td>
        <td>${r.barrier ?? "—"}</td>
        <td>${gateCell(r.search_passed)}</td>
        <td>${gateCell(r.confluence_passed)}</td>
        <td>${gateCell(r.risk_passed)}</td>
        <td>${gateCell(r.executed)}</td>
        <td class="subtle small">${reason || "—"}</td>
      </tr>`;
    })
    .join("");
}

function syncRiskFormFromStrategy(strategy, dirty) {
  if (dirty) return;
  const s = strategy && typeof strategy === "object" ? strategy : {};
  const risk = s.risk || {};
  const cooldown = s.cooldown || {};
  const model = s.model || {};
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = String(val);
  };
  set("stratMaxConsecLosses", risk.max_consecutive_losses ?? 2);
  set("stratMaxDrawdown", risk.max_session_drawdown_pct ?? 10);
  set("stratMaxTradesSession", risk.max_trades_per_session ?? 50);
  set("stratCooldownTicks", cooldown.cooldown_ticks ?? 10);
  set("stratVolLockout", risk.volatility_lockout_enabled === false ? "false" : "true");
  set("stratResearchMode", s.research_mode ? "true" : "false");
  set("stratProbGate", model.use_probability_gate ? "true" : "false");
  set("stratMinWinProb", Number(model.min_win_probability ?? 0.6).toFixed(2));
}

function computeTradeStreak(rows) {
  let win = 0;
  let loss = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = String(rows[i]?.result || "").toLowerCase();
    if (r === "win") {
      if (loss > 0) break;
      win += 1;
    } else if (r === "loss") {
      if (win > 0) break;
      loss += 1;
    }
  }
  if (win > 0) return `W${win}`;
  if (loss > 0) return `L${loss}`;
  return "FLAT";
}

function renderManualDigitDistribution(container, points, sampleSize) {
  if (!container) return;
  const sample = (points || []).slice(-sampleSize);
  const counts = Array.from({ length: 10 }, () => 0);
  sample.forEach((p) => {
    const d = extractLastDigitFromPrice(p?.price);
    if (d != null && d >= 0 && d <= 9) counts[d] += 1;
  });
  const total = counts.reduce((a, b) => a + b, 0);
  const maxC = total > 0 ? Math.max(...counts) : 1;
  const expectedPct = 10;
  const expectedTop = 100 - expectedPct;
  container.innerHTML = "";
  for (let d = 0; d < 10; d += 1) {
    const pct = total > 0 ? (counts[d] / total) * 100 : 0;
    const hPct = maxC > 0 ? (counts[d] / maxC) * 100 : 0;
    const col = document.createElement("div");
    col.className = "manual-dist-col";
    col.dataset.digit = String(d);
    const isHot = total > 0 && counts[d] === maxC;
    const isCold = total > 0 && counts[d] === Math.min(...counts);
    col.innerHTML = `
      <div class="manual-dist-bar-wrap">
        <span class="manual-dist-expected" style="bottom:${expectedTop}%"></span>
        <span class="manual-dist-bar ${isHot ? "manual-dist-bar--hot" : isCold ? "manual-dist-bar--cold" : ""}" style="height:${Math.max(4, hPct)}%"></span>
      </div>
      <span class="manual-dist-digit">${d}</span>
      <span class="manual-dist-pct">${total > 0 ? pct.toFixed(0) : "--"}%</span>`;
    container.appendChild(col);
  }
}

function updateManualAiSignalCard(points, sampleSize, contractType, barrier) {
  const tierEl = document.getElementById("manualAiTier");
  const recEl = document.getElementById("manualAiRecommendation");
  const recSubEl = document.getElementById("manualAiRecommendationSub");
  const confEl = document.getElementById("manualAiConfidence");
  const meterEl = document.getElementById("manualAiMeterFill");
  const biasEl = document.getElementById("manualAiBias");
  const oppEl = document.getElementById("manualAiOpportunity");
  const coldEl = document.getElementById("manualAiColdDigit");
  const hotEl = document.getElementById("manualAiHotDigit");
  const sample = (points || []).slice(-sampleSize);
  const counts = Array.from({ length: 10 }, () => 0);
  sample.forEach((p) => {
    const dd = extractLastDigitFromPrice(p?.price);
    if (dd != null && dd >= 0 && dd <= 9) counts[dd] += 1;
  });
  const n = counts.reduce((a, b) => a + b, 0);
  const trend = computeTrend(points);
  if (biasEl) biasEl.textContent = trend;
  if (n < 30) {
    if (tierEl) {
      tierEl.textContent = "Scanning";
      tierEl.className = "matches-ai-tier matches-ai-tier--scan";
    }
    if (recEl) recEl.textContent = "Analyzing digit stream…";
    if (recSubEl) recSubEl.textContent = "Need more ticks before ranking Over/Under opportunities.";
    if (confEl) confEl.textContent = "--";
    if (meterEl) meterEl.style.width = "6%";
    const confPctUi = document.getElementById("manualConfPct");
    const confFillUi = document.getElementById("manualConfMeterFill");
    const strengthUi = document.getElementById("manualSignalStrength");
    if (confPctUi) confPctUi.textContent = "--";
    if (confFillUi) {
      confFillUi.style.width = "6%";
      confFillUi.parentElement?.setAttribute("aria-valuenow", "0");
    }
    if (strengthUi) {
      strengthUi.textContent = "—";
      strengthUi.className = "manual-confidence__strength";
    }
    if (oppEl) oppEl.textContent = "--";
    if (coldEl) coldEl.textContent = "--";
    if (hotEl) hotEl.textContent = "--";
    return { confidence: 0 };
  }
  const expected = n / 10;
  const zScores = counts.map((c) => (c - expected) / Math.sqrt(Math.max(expected * 0.9, 1e-9)));
  let coldDigit = 0;
  let hotDigit = 0;
  for (let i = 1; i < 10; i += 1) {
    if (zScores[i] < zScores[coldDigit]) coldDigit = i;
    if (zScores[i] > zScores[hotDigit]) hotDigit = i;
  }
  const b = Number(barrier ?? 5);
  const side = contractType === "DIGITUNDER" ? "UNDER" : "OVER";
  const targetDigit = side === "OVER" ? coldDigit : hotDigit;
  const strengthRaw = Math.max(0, Math.abs(zScores[targetDigit]));
  const confidence = Math.min(95, Math.round((strengthRaw / 2.5) * 100));
  const coldPct = ((counts[coldDigit] / n) * 100).toFixed(1);
  const hotPct = ((counts[hotDigit] / n) * 100).toFixed(1);
  if (coldEl) coldEl.textContent = `${coldDigit} (${coldPct}%)`;
  if (hotEl) hotEl.textContent = `${hotDigit} (${hotPct}%)`;
  if (confEl) confEl.textContent = `${confidence}%`;
  if (meterEl) meterEl.style.width = `${Math.max(8, confidence)}%`;
  const confPctUi = document.getElementById("manualConfPct");
  const confFillUi = document.getElementById("manualConfMeterFill");
  const strengthUi = document.getElementById("manualSignalStrength");
  if (confPctUi) confPctUi.textContent = `${confidence}%`;
  if (confFillUi) {
    confFillUi.style.width = `${Math.max(6, confidence)}%`;
    confFillUi.parentElement?.setAttribute("aria-valuenow", String(confidence));
  }
  if (strengthUi) {
    let strength = "Weak";
    if (confidence >= 75) strength = "Very strong";
    else if (confidence >= 55) strength = "Strong";
    else if (confidence >= 35) strength = "Moderate";
    strengthUi.textContent = strength;
    strengthUi.className = "manual-confidence__strength";
    strengthUi.classList.toggle("manual-confidence__strength--high", confidence >= 55);
    strengthUi.classList.toggle("manual-confidence__strength--low", confidence < 35);
  }
  if (oppEl) oppEl.textContent = `${confidence}/100`;
  let tier = "scan";
  let tierLabel = "Scanning";
  if (confidence >= 75) {
    tier = "high";
    tierLabel = "High confidence";
  } else if (confidence >= 55) {
    tier = "medium";
    tierLabel = "Medium confidence";
  } else if (confidence >= 35) {
    tier = "low";
    tierLabel = "Low confidence";
  }
  if (tierEl) {
    tierEl.textContent = tierLabel;
    tierEl.className = "matches-ai-tier";
    tierEl.classList.add(`matches-ai-tier--${tier}`);
  }
  const recAction = side === "OVER" ? `BUY OVER · barrier ${b}` : `BUY UNDER · barrier ${b}`;
  if (recEl) recEl.textContent = confidence >= 35 ? recAction : "No strong edge — observe";
  if (recSubEl) {
    recSubEl.textContent =
      confidence >= 35
        ? `Digit ${targetDigit} is ${side === "OVER" ? "under" : "over"}represented in sample · z=${zScores[targetDigit].toFixed(2)}`
        : `Barrier ${b} · ${side} · sample ${n} ticks · market ${trend.toLowerCase()}`;
  }
  return { confidence, coldDigit, hotDigit };
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

function getManualChartHeight() {
  const stage = document.querySelector(".manual-ws-col--left .manual-chart-stage");
  if (stage) {
    const h = stage.clientHeight;
    if (h > 80) return Math.floor(h);
  }
  return 320;
}

function aggregateManualChartPoints(points, tfMinutes) {
  const sorted = (points || []).filter((p) => p.time != null && p.price != null);
  if (!sorted.length) return [];
  if (tfMinutes <= 1) return sorted.slice(-220);
  const bucketSec = tfMinutes * 60;
  const buckets = new Map();
  sorted.forEach((p) => {
    const key = Math.floor(Number(p.time) / bucketSec);
    buckets.set(key, {
      time: key,
      price: Number(p.price),
      ma20: p.ma20 != null ? Number(p.ma20) : null,
    });
  });
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

function initManualBottomTabs() {
  const tabs = document.querySelectorAll(".manual-bottom-tab");
  const panes = {
    journal: document.getElementById("manualBottomJournal"),
    history: document.getElementById("manualBottomHistory"),
  };
  if (!tabs.length) return;
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const key = tab.dataset.manualTab || "journal";
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      Object.entries(panes).forEach(([k, pane]) => {
        if (!pane) return;
        const on = k === key;
        pane.classList.toggle("is-active", on);
        pane.hidden = !on;
      });
    });
  });
}

function wireManualTraderUi(onAfterAction) {
  const manualRoot =
    document.getElementById("manualBuyOverBtn") || document.getElementById("manualTradeBtn");
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
  const manualDigitArrowEl = document.getElementById("manualDigitArrow");
  const manualPriceArrowEl = document.getElementById("manualPriceArrow");
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
  const buyOverBtn = document.getElementById("manualBuyOverBtn");
  const buyUnderBtn = document.getElementById("manualBuyUnderBtn");
  const distContainer = document.getElementById("manualDigitDistBars");
  const intelPanelEl = document.getElementById("manualIntelPanel");
  const topBalanceEl = document.getElementById("manualTopBalance");
  const connectionEl = document.getElementById("manualConnectionStatus");
  const topContractEl = document.getElementById("manualTopContractType");
  const topSymbolEl = document.getElementById("manualTopSymbol");
  const momentumEl = document.getElementById("manualMomentum");
  const journalListEl = document.getElementById("manualJournalList");
  let marketDataStale = false;
  const recentTradesEl = document.getElementById("manualRecentTrades");
  const sessionBalanceEl = document.getElementById("manualSessionBalance");
  const sessionPnlEl = document.getElementById("manualSessionPnl");
  const winRateEl = document.getElementById("manualWinRate");
  const sessionWinsEl = document.getElementById("manualSessionWins");
  const sessionLossesEl = document.getElementById("manualSessionLosses");
  const contractsTodayEl = document.getElementById("manualContractsToday");
  const largestWinEl = document.getElementById("manualLargestWin");
  const largestLossEl = document.getElementById("manualLargestLoss");
  const execBalanceAfterEl = document.getElementById("manualExecBalanceAfter");
  const execWarningEl = document.getElementById("manualExecWarning");
  const manualChartBlockEl = document.getElementById("manualChartBlock");
  const manualDistBlockEl = document.getElementById("manualDistBlock");
  const manualLeftColEl = document.querySelector(".manual-ws-col--left");
  let manualChartTf = 1;
  let manualChartView = "price";
  let manualDigitSeries = null;
  const streakEl = document.getElementById("manualStreak");
  const plSummaryEl = document.getElementById("manualPlSummary");
  const recentCountEl = document.getElementById("manualRecentContracts");
  const durationViewEl = document.getElementById("manualDurationView");
  const predictionViewEl = document.getElementById("manualPredictionView");
  const barrierHeroEl = document.getElementById("manualBarrierHero");
  const barrierHeroSideEl = document.getElementById("manualBarrierHeroSide");
  const liveDigitCompactEl = document.getElementById("manualLiveDigitCompact");
  const summaryContractEl = document.getElementById("manualSummaryContract");
  const summaryBarrierEl = document.getElementById("manualSummaryBarrier");
  const summaryStakeEl = document.getElementById("manualSummaryStake");
  const summaryDurationEl = document.getElementById("manualSummaryDuration");
  const activePanelEl = document.getElementById("manualActiveContractPanel");
  const activeStatusEl = document.getElementById("manualActiveStatus");
  const activeStatusDetailEl = document.getElementById("manualActiveStatusDetail");
  const activeCurrentTickEl = document.getElementById("manualActiveCurrentTick");
  const activeRemainingEl = document.getElementById("manualActiveRemainingTicks");
  const activeLivePayoutEl = document.getElementById("manualActiveLivePayout");
  const riskLevelEl = document.getElementById("manualRiskLevel");
  const manualTickerStripEl = document.getElementById("manualTickerStrip");
  const manualTickerEl = document.getElementById("manualTicker");
  const manualDigitRoll = [];

  let manualEnabled = true;
  let manualContractWatch = null;
  let manualContractLastPrice = null;
  let manualModeOn = true;
  let manualSubmitting = false;
  let liveBalance = null;
  let lastQuote = null;
  let recentPoints = [];
  let manualSeries;
  let maSeries;
  let chart;
  let digitSampleSize = Number(digitSampleEl?.value ?? 120) || 120;
  const manualTrendGlyphs = Array.from({ length: 10 }, () => null);
  let manualTickState = {
    prevPrice: null,
    prevDigit: null,
    priceArrowEl: manualPriceArrowEl,
    digitArrowEl: manualDigitArrowEl,
    liveDigitEl: liveTickDigitEl,
    grid: digitGrid,
    pointerEl: digitPointer,
  };
  let manualPollFresh = true;

  function updateManualEnableState() {
    const disabled = !manualEnabled;
    const loggedIn = !!lastDerivMe?.logged_in;
    [manualContractEl, manualBarrierEl, manualStakeEl, manualRiskModeEl, manualRiskPercentEl, manualStopLossEl, manualTakeProfitEl]
      .forEach((el) => {
        if (el) el.disabled = disabled;
      });
    if (manualBtn) manualBtn.disabled = disabled;
    if (buyOverBtn) buyOverBtn.disabled = disabled || manualSubmitting;
    if (buyUnderBtn) buyUnderBtn.disabled = disabled || manualSubmitting;
    if (modeToggle) modeToggle.textContent = manualEnabled ? "Manual mode" : "Auto-bot mode";
    const card = document.querySelector(".manual-trade-card");
    if (card) card.classList.toggle("manual-trade-disabled", disabled);
    if (execWarningEl) execWarningEl.classList.toggle("hidden", loggedIn);
  }

  function syncOuButtons() {
    const v = manualContractEl?.value;
    if (ouOverBtn) ouOverBtn.classList.toggle("ou-btn--active", v === "DIGITOVER");
    if (ouUnderBtn) ouUnderBtn.classList.toggle("ou-btn--active", v === "DIGITUNDER");
    if (buyOverBtn) {
      buyOverBtn.classList.toggle("manual-buy-btn--armed", v === "DIGITOVER");
      buyOverBtn.classList.toggle("manual-exec-btn--armed", v === "DIGITOVER");
    }
    if (buyUnderBtn) {
      buyUnderBtn.classList.toggle("manual-buy-btn--armed", v === "DIGITUNDER");
      buyUnderBtn.classList.toggle("manual-exec-btn--armed", v === "DIGITUNDER");
    }
  }

  function renderManualTickerStrip(points) {
    if (!manualTickerStripEl) return;
    const digits = (points || [])
      .map((p) => extractLastDigitFromPrice(p?.price))
      .filter((d) => d != null && d >= 0 && d <= 9);
    if (!digits.length) return;
    const tail = digits.slice(-36);
    const prevHead = manualDigitRoll.length ? manualDigitRoll[manualDigitRoll.length - 1] : null;
    const newHead = tail[tail.length - 1];
    const unchanged =
      manualDigitRoll.length === tail.length && manualDigitRoll.every((d, i) => d === tail[i]);
    if (unchanged) return;
    manualDigitRoll.length = 0;
    tail.forEach((d) => manualDigitRoll.push(d));
    manualTickerStripEl.innerHTML = "";
    manualDigitRoll.forEach((d, idx) => {
      const span = document.createElement("span");
      span.className = "manual-ticker-chip";
      span.classList.add(`manual-ticker-chip--d${d}`);
      span.textContent = String(d);
      const isHead = idx === manualDigitRoll.length - 1;
      if (isHead) {
        span.classList.add("manual-ticker-chip--head");
        if (prevHead !== newHead) span.classList.add("manual-ticker-chip--enter");
      }
      manualTickerStripEl.appendChild(span);
    });
    if (manualTickerEl) manualTickerEl.scrollLeft = manualTickerEl.scrollWidth;
  }

  function updateManualRiskLevel() {
    if (!riskLevelEl) return;
    const stake = Number(manualStakeEl?.value ?? 0);
    if (!stake || stake <= 0 || liveBalance == null || liveBalance <= 0) {
      riskLevelEl.textContent = "--";
      riskLevelEl.className = "";
      return;
    }
    const ratio = (stake / liveBalance) * 100;
    let level = "LOW";
    let riskCls = "manual-risk--low";
    if (ratio >= 10) {
      level = "HIGH";
      riskCls = "manual-risk--high";
    } else if (ratio >= 5) {
      level = "MEDIUM";
      riskCls = "manual-risk--medium";
    }
    riskLevelEl.textContent = level;
    riskLevelEl.className = riskCls;
  }

  function syncDigitGrid() {
    if (!digitGrid || !manualBarrierEl) return;
    const d = String(manualBarrierEl.value);
    digitGrid.querySelectorAll(".digit-cell").forEach((cell) => {
      cell.classList.toggle("digit-cell--active", cell.dataset.digit === d);
    });
  }

  function renderDigitPrediction(points) {
    renderDigitGridFromPoints(digitGrid, points, digitSampleSize, manualTrendGlyphs);
    renderManualDigitDistribution(distContainer, points, digitSampleSize);
    updateManualAiSignalCard(
      points,
      digitSampleSize,
      manualContractEl?.value,
      Number(manualBarrierEl?.value ?? 5),
    );
  }

  function syncManualTopBar() {
    const ct = manualContractEl?.value === "DIGITUNDER" ? "DIGIT UNDER" : "DIGIT OVER";
    if (topContractEl) topContractEl.textContent = ct;
    if (topSymbolEl) topSymbolEl.textContent = "R_100";
    if (topBalanceEl) {
      if (Number.isFinite(lastDerivBalance) && lastDerivBalance >= 0) {
        topBalanceEl.textContent = `$${Number(lastDerivBalance).toFixed(2)}`;
      } else if (liveBalance != null) {
        topBalanceEl.textContent = `$${Number(liveBalance).toFixed(2)}`;
      } else {
        topBalanceEl.textContent = "--";
      }
    }
    if (connectionEl) {
      const loggedIn = !!lastDerivMe?.logged_in;
      if (!loggedIn) {
        connectionEl.textContent = "Offline";
        connectionEl.className = "manual-status-pill manual-status-pill--offline";
      } else if (marketDataStale) {
        connectionEl.textContent = "Stale";
        connectionEl.className = "manual-status-pill manual-status-pill--stale";
      } else {
        connectionEl.textContent = "Online";
        connectionEl.className = "manual-status-pill manual-status-pill--online manual-status-pill--pulse";
      }
    }
    const liveCluster = document.querySelector(".manual-topbar__cluster--live");
    const marketPulse = document.getElementById("manualMarketPulse");
    const feedOn = !!lastDerivMe?.logged_in && !marketDataStale;
    if (liveCluster) liveCluster.classList.toggle("is-ticking", feedOn);
    if (marketPulse) marketPulse.classList.toggle("manual-market-pulse--on", feedOn);
  }

  function syncManualTrendClass(trendText) {
    if (!trendEl) return;
    const t = String(trendText || "");
    trendEl.classList.remove("manual-trend--up", "manual-trend--down", "manual-trend--neutral");
    if (t === "Up") trendEl.classList.add("manual-trend--up");
    else if (t === "Down") trendEl.classList.add("manual-trend--down");
    else trendEl.classList.add("manual-trend--neutral");
  }

  function syncManualTradeSummary() {
    const ct = manualContractEl?.value === "DIGITUNDER" ? "UNDER" : "OVER";
    const ctLabel = manualContractEl?.value === "DIGITUNDER" ? "Digit Under" : "Digit Over";
    const barrier = String(manualBarrierEl?.value ?? "0");
    const stake = Number(manualStakeEl?.value ?? 0);
    syncManualTopBar();
    if (summaryContractEl) summaryContractEl.textContent = ctLabel;
    if (summaryBarrierEl) summaryBarrierEl.textContent = barrier;
    if (summaryStakeEl) summaryStakeEl.textContent = stake > 0 ? `${stake.toFixed(2)} USD` : "--";
    if (summaryDurationEl) summaryDurationEl.textContent = "1 tick";
    if (durationViewEl) durationViewEl.textContent = "1 tick";
    if (predictionViewEl) predictionViewEl.textContent = barrier;
    if (barrierHeroEl) barrierHeroEl.textContent = barrier;
    if (barrierHeroSideEl) barrierHeroSideEl.textContent = ct;
    if (barrierHeroSideEl) {
      barrierHeroSideEl.classList.toggle("manual-barrier-hero__side--under", ct === "UNDER");
      barrierHeroSideEl.classList.toggle("manual-barrier-hero__side--over", ct === "OVER");
    }
    const execContract = document.getElementById("manualExecContract");
    const execBarrier = document.getElementById("manualExecBarrier");
    const execDuration = document.getElementById("manualExecDuration");
    const execStake = document.getElementById("manualExecStake");
    const execPayout = document.getElementById("manualExecPayout");
    const execProfit = document.getElementById("manualExecProfit");
    if (execContract) execContract.textContent = ctLabel;
    if (execBarrier) execBarrier.textContent = barrier;
    if (execDuration) execDuration.textContent = "1 tick";
    if (execStake) execStake.textContent = stake > 0 ? `${stake.toFixed(2)} USD` : "--";
    if (execPayout) execPayout.textContent = payoutEl?.textContent || "--";
    if (execProfit) {
      execProfit.textContent = profitEl?.textContent || "--";
      execProfit.classList.toggle("matches-pos", profitEl?.classList.contains("matches-pos"));
      execProfit.classList.toggle("matches-neg", profitEl?.classList.contains("matches-neg"));
    }
    if (execBalanceAfterEl) {
      const afterTxt = afterStakeEl?.textContent;
      if (afterTxt && afterTxt !== "--" && liveBalance != null) {
        execBalanceAfterEl.textContent = `$${afterTxt}`;
      } else if (liveBalance != null && stake > 0) {
        execBalanceAfterEl.textContent = `$${(liveBalance - stake).toFixed(2)}`;
      } else {
        execBalanceAfterEl.textContent = "--";
      }
    }
  }

  function applyManualChartViewUi() {
    if (manualLeftColEl) {
      manualLeftColEl.classList.remove("manual-view--price", "manual-view--digit", "manual-view--distribution");
      manualLeftColEl.classList.add(`manual-view--${manualChartView}`);
    }
    if (manualChartBlockEl) {
      manualChartBlockEl.classList.toggle("hidden", manualChartView === "distribution");
    }
    if (manualDistBlockEl) {
      manualDistBlockEl.classList.toggle("manual-dist-block--focus", manualChartView === "distribution");
    }
  }

  function paintManualChart(points) {
    if (!points?.length) return;
    applyManualChartViewUi();
    if (manualChartView === "distribution") {
      renderManualDigitDistribution(distContainer, points, digitSampleSize);
      return;
    }
    const bucketed = aggregateManualChartPoints(points, manualChartTf);
    const chartEl = document.getElementById("manualPriceChart");
    if (!chartEl || typeof LightweightCharts === "undefined") return;
    const colors = manualChartColors();
    if (!chart) {
      chart = LightweightCharts.createChart(chartEl, {
        layout: { background: { type: "solid", color: colors.bg }, textColor: colors.text },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: colors.grid },
        timeScale: { borderColor: colors.grid },
        height: getManualChartHeight(),
      });
      manualSeries = chart.addLineSeries({ color: colors.line, lineWidth: 2 });
      maSeries = chart.addLineSeries({ color: colors.ma, lineWidth: 1 });
      manualDigitSeries = chart.addLineSeries({
        color: colors.ma,
        lineWidth: 2,
        visible: false,
        priceScaleId: "right",
      });
    } else {
      applyManualChartTheme();
    }
    if (manualChartView === "digit") {
      const digitData = bucketed
        .map((p) => {
          const d = extractLastDigitFromPrice(p.price);
          return d != null ? { time: Number(p.time), value: d } : null;
        })
        .filter(Boolean);
      manualSeries?.applyOptions({ visible: false });
      maSeries?.applyOptions({ visible: false });
      manualDigitSeries?.applyOptions({ visible: true });
      manualDigitSeries?.setData(digitData);
    } else {
      const priceData = bucketed.map((p) => ({ time: Number(p.time), value: Number(p.price) }));
      const maData = bucketed
        .filter((p) => p.ma20 != null)
        .map((p) => ({ time: Number(p.time), value: Number(p.ma20) }));
      manualDigitSeries?.applyOptions({ visible: false });
      manualSeries?.applyOptions({ visible: true });
      maSeries?.applyOptions({ visible: true });
      manualSeries?.setData(priceData);
      maSeries?.setData(maData);
    }
    resizeManualChart();
  }

  function setManualActiveStatus(status) {
    if (!activeStatusEl) return;
    const labels = { waiting: "Waiting", live: "Live", won: "Won", lost: "Lost", settled: "Settled" };
    activeStatusEl.textContent = labels[status] || "Waiting";
    activeStatusEl.className = "manual-active-strip__status";
  }

  function renderManualActiveContract() {
    const w = manualContractWatch;
    if (!w) return;
    const tickCount = w.ticks?.length ?? 0;
    const remaining = Math.max(0, w.duration - tickCount);
    if (activeCurrentTickEl) activeCurrentTickEl.textContent = String(w.finalized ? Math.min(tickCount, w.duration) : tickCount);
    if (activeRemainingEl) activeRemainingEl.textContent = w.finalized ? "0" : String(remaining);
    if (activeStatusDetailEl) {
      activeStatusDetailEl.textContent = w.finalized
        ? w.won
          ? "Settled · WIN"
          : "Settled · LOSS"
        : tickCount > 0
          ? `Tick ${tickCount}/${w.duration}`
          : "Opening…";
    }
    if (activeLivePayoutEl) {
      const payout =
        w.livePayout != null && Number.isFinite(Number(w.livePayout))
          ? Number(w.livePayout)
          : lastQuote?.payout;
      activeLivePayoutEl.textContent =
        payout != null && Number.isFinite(Number(payout)) ? `$${Number(payout).toFixed(2)}` : "--";
    }
    let status = w.status || "waiting";
    if (!w.finalized && tickCount > 0 && status === "waiting") status = "live";
    if (w.finalized && w.won === true) status = "won";
    if (w.finalized && w.won === false) status = "lost";
    setManualActiveStatus(status);
  }

  function beginManualContractWatch(contractType, barrier, meta = {}) {
    manualContractWatch = {
      contractType,
      barrier: Number(barrier),
      duration: 1,
      ticks: [],
      watching: true,
      finalized: false,
      won: null,
      status: "waiting",
      livePayout: meta.payout ?? lastQuote?.payout ?? null,
      fastPollId: window.setInterval(() => {
        manualPollFresh = true;
        void refreshLiveContext();
      }, 400),
    };
    manualContractLastPrice = null;
    activePanelEl?.classList.remove("hidden");
    renderManualActiveContract();
  }

  function recordManualContractTick(price) {
    if (!manualContractWatch?.watching || manualContractWatch.finalized) return;
    const p = Number(price);
    if (!Number.isFinite(p)) return;
    if (manualContractLastPrice != null && p === manualContractLastPrice) return;
    manualContractLastPrice = p;
    const digit = extractLastDigitFromPrice(p);
    if (digit == null) return;
    const w = manualContractWatch;
    if (w.ticks.length >= w.duration) return;
    w.ticks.push({ digit, at: Date.now(), price: p });
    if (!w.finalized && w.status === "waiting") w.status = "live";
    renderManualActiveContract();
  }

  function finalizeManualContractWatch(won, payout) {
    if (!manualContractWatch) return;
    const w = manualContractWatch;
    if (w.fastPollId) {
      window.clearInterval(w.fastPollId);
      w.fastPollId = null;
    }
    w.watching = false;
    w.finalized = true;
    w.won = !!won;
    w.status = won ? "won" : "lost";
    if (payout != null) w.livePayout = payout;
    renderManualActiveContract();
    window.setTimeout(() => {
      if (manualContractWatch === w && w.finalized) {
        w.status = "settled";
        renderManualActiveContract();
        window.setTimeout(() => {
          if (manualContractWatch === w) {
            activePanelEl?.classList.add("hidden");
            manualContractWatch = null;
          }
        }, 3500);
      }
    }, 1200);
  }

  function updateManualSessionStats(status, manualRows) {
    const rows = manualRows || [];
    const wins = rows.filter((r) => String(r.result || "").toLowerCase() === "win").length;
    const losses = rows.filter((r) => String(r.result || "").toLowerCase() === "loss").length;
    const total = wins + losses;
    const manualPnl = rows.reduce((sum, r) => sum + Number(r.profit ?? 0), 0);
    const todayKey = new Date().toDateString();
    const todayRows = rows.filter((r) => {
      const ts = r.timestamp ? new Date(r.timestamp) : null;
      return ts && !Number.isNaN(ts.getTime()) && ts.toDateString() === todayKey;
    });
    const winProfits = rows
      .filter((r) => String(r.result || "").toLowerCase() === "win")
      .map((r) => Number(r.profit ?? 0));
    const lossProfits = rows
      .filter((r) => String(r.result || "").toLowerCase() === "loss")
      .map((r) => Number(r.profit ?? 0));
    const bestWin = winProfits.length ? Math.max(...winProfits) : null;
    const worstLoss = lossProfits.length ? Math.min(...lossProfits) : null;
    if (sessionWinsEl) sessionWinsEl.textContent = String(wins);
    if (sessionLossesEl) sessionLossesEl.textContent = String(losses);
    if (contractsTodayEl) contractsTodayEl.textContent = String(todayRows.length);
    if (largestWinEl) {
      largestWinEl.textContent = bestWin != null ? `+${bestWin.toFixed(2)}` : "—";
    }
    if (largestLossEl) {
      largestLossEl.textContent = worstLoss != null ? worstLoss.toFixed(2) : "—";
    }
    if (recentCountEl) recentCountEl.textContent = String(rows.length);
    if (plSummaryEl) {
      plSummaryEl.textContent = `${manualPnl >= 0 ? "+" : ""}${manualPnl.toFixed(2)} USD`;
      plSummaryEl.classList.toggle("matches-pos", manualPnl > 0);
      plSummaryEl.classList.toggle("matches-neg", manualPnl < 0);
    }
    if (winRateEl) winRateEl.textContent = total > 0 ? `${((wins / total) * 100).toFixed(1)}%` : "--";
    if (streakEl) streakEl.textContent = computeTradeStreak(rows);
    const hasBotPnl = status && Number.isFinite(Number(status?.profit));
    const pnl = Number(status?.profit ?? 0);
    if (sessionPnlEl) {
      sessionPnlEl.textContent = hasBotPnl ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD` : "--";
      sessionPnlEl.classList.toggle("matches-pos", pnl > 0);
      sessionPnlEl.classList.toggle("matches-neg", pnl < 0);
    }
    if (sessionBalanceEl) {
      const effectiveBal = resolveEffectiveBalance(status);
      sessionBalanceEl.textContent = `$${effectiveBal.toFixed(2)}`;
    }
    syncManualTopBar();
  }

  function renderManualRecentTrades(manualRows) {
    if (!recentTradesEl) return;
    const rows = (manualRows || []).slice(-8).reverse();
    if (!rows.length) {
      recentTradesEl.innerHTML = '<p class="subtle small terminal-trades-empty">No trades yet.</p>';
      return;
    }
    recentTradesEl.innerHTML = "";
    rows.forEach((row) => {
      const res = String(row.result || "").toLowerCase();
      const isWin = res === "win";
      const isLoss = res === "loss";
      const profit = Number(row.profit ?? 0);
      const rawCt = String(row.contract_type || "").toUpperCase();
      const side = rawCt === "DIGITUNDER" ? "U" : "O";
      const digit = row.digit ?? "-";
      const div = document.createElement("div");
      div.className = "manual-trade-line";
      div.classList.toggle("manual-trade-line--win", isWin);
      div.classList.toggle("manual-trade-line--loss", isLoss);
      div.innerHTML = `<span class="manual-trade-line__side">${side}${digit}</span><span class="manual-trade-line__pnl">${isWin || isLoss ? `${profit >= 0 ? "+" : ""}${profit.toFixed(2)}` : "—"}</span>`;
      recentTradesEl.appendChild(div);
    });
  }

  function computeVolatility(points) {
    if (!points || points.length < 10) return null;
    const vals = points.slice(-25).map((p) => Number(p.price ?? 0)).filter((x) => x > 0);
    if (vals.length < 10) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return (Math.sqrt(variance) / mean) * 100;
  }

  function manualChartColors() {
    return {
      bg: "#ffffff",
      text: "#1a2634",
      grid: "#e6e9ef",
      line: "#1b52c0",
      ma: "#4caaa4",
    };
  }

  function applyManualChartTheme() {
    if (!chart) return;
    const c = manualChartColors();
    chart.applyOptions({
      layout: { background: { type: "solid", color: c.bg }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.grid },
      timeScale: { borderColor: c.grid },
    });
    manualSeries?.applyOptions({ color: c.line });
    maSeries?.applyOptions({ color: c.ma });
    manualDigitSeries?.applyOptions({ color: c.ma });
  }

  function renderManualChart(points) {
    paintManualChart(points);
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
    updateManualRiskLevel();
    syncManualTradeSummary();
  }

  async function refreshQuote() {
    if (!manualContractEl || !manualBarrierEl || !manualStakeEl) return;
    const stake = Number(manualStakeEl.value);
    if (!stake || stake <= 0) {
      lastQuote = null;
      if (payoutEl) payoutEl.textContent = "--";
      if (profitEl) {
        profitEl.textContent = "--";
        profitEl.classList.remove("matches-pos", "matches-neg");
      }
      if (probEl) probEl.textContent = "--";
      updateRiskPreview();
      syncManualTradeSummary();
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
      const profitVal = Number(quote.profit ?? 0);
      if (profitEl) {
        profitEl.textContent = `${profitVal >= 0 ? "+" : ""}${profitVal.toFixed(2)} USD`;
        profitEl.classList.toggle("matches-pos", profitVal > 0);
        profitEl.classList.toggle("matches-neg", profitVal < 0);
      }
      if (probEl) probEl.textContent = `${Number(quote.implied_probability ?? 0).toFixed(2)}%`;
      if (manualContractWatch && !manualContractWatch.finalized) {
        manualContractWatch.livePayout = quote.payout;
        renderManualActiveContract();
      }
    } catch (_err) {
      lastQuote = null;
      if (profitEl) profitEl.classList.remove("matches-pos", "matches-neg");
    } finally {
      updateRiskPreview();
      syncManualTradeSummary();
    }
  }

  async function refreshLiveContext() {
    try {
      const { points, stale } = await fetchLiveMarketPoints("R_100", { fresh: manualPollFresh });
      manualPollFresh = !manualPollFresh;
      if (!points.length) return;
      recentPoints = points;
      renderManualChart(points);
      renderDigitPrediction(points);
      renderManualTickerStrip(points);
      const latest = points[points.length - 1];
      const price = Number(latest.price ?? 0);
      if (liveTickPriceEl) liveTickPriceEl.textContent = `(${price.toFixed(3)})`;
      if (liveTickPriceStrongEl) liveTickPriceStrongEl.textContent = price.toFixed(3);
      manualTickState = applyLatestTickMotion(points, manualTickState);
      if (trendEl) {
        const trend = computeTrend(points);
        trendEl.textContent = trend;
        syncManualTrendClass(trend);
      }
      const vol = computeVolatility(points);
      if (volatilityEl) volatilityEl.textContent = vol == null ? "--" : `${vol.toFixed(2)}%`;
      if (maEl) maEl.textContent = latest.ma20 == null ? "--" : Number(latest.ma20).toFixed(3);
      if (rsiEl) rsiEl.textContent = latest.rsi14 == null ? "--" : Number(latest.rsi14).toFixed(2);
      if (momentumEl) {
        const rsi = latest.rsi14 == null ? null : Number(latest.rsi14);
        if (rsi == null || Number.isNaN(rsi)) momentumEl.textContent = "--";
        else if (rsi >= 60) momentumEl.textContent = "Strong";
        else if (rsi <= 40) momentumEl.textContent = "Weak";
        else momentumEl.textContent = "Neutral";
      }
      marketDataStale = !!stale;
      syncManualTopBar();
      const digit = extractLastDigitFromPrice(latest.price);
      if (liveDigitCompactEl && digit != null) liveDigitCompactEl.textContent = String(digit);
      if (latest?.price != null) recordManualContractTick(latest.price);
      if (stale && manualDigitArrowEl) manualDigitArrowEl.title = "Stale tick data — retrying…";
    } catch (_error) {
      if (recentPoints.length) {
        renderDigitPrediction(recentPoints);
        manualTickState = applyLatestTickMotion(recentPoints, manualTickState);
      }
    }
  }

  function contractSideLabel(rawCt) {
    const u = String(rawCt || "").toUpperCase();
    if (u === "DIGITMATCH") return "MATCH";
    if (u === "DIGITUNDER") return "UNDER";
    return "OVER";
  }

  async function refreshManualJournal() {
    if (!journalListEl) return;
    try {
      const res = await requestJson("/journal?limit=80");
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      const manualOnly = rows.filter((r) => String(r.source || "") === "manual");
      const show = manualOnly.length ? manualOnly : rows.slice(0, 40);
      if (!show.length) {
        journalListEl.innerHTML = '<li class="terminal-trades-empty">No journal entries yet.</li>';
        return;
      }
      journalListEl.innerHTML = "";
      show.forEach((r) => {
        const li = document.createElement("li");
        const ts = r.ts != null ? new Date(Number(r.ts) * 1000).toLocaleString() : "--";
        const side = contractSideLabel(r.contract_type);
        const profit = Number(r.profit ?? 0);
        const resLabel = String(r.result || "").toUpperCase();
        li.innerHTML = `<span class="manual-journal-ts">${escapeHtml(ts)}</span> · ${escapeHtml(side)} ${r.barrier ?? r.digit ?? "-"} · $${Number(r.stake ?? 0).toFixed(2)} · <strong class="${profit >= 0 ? "profit-positive" : "profit-negative"}">${resLabel} ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}</strong>`;
        journalListEl.appendChild(li);
      });
    } catch (_e) {
      journalListEl.innerHTML = '<li class="terminal-trades-empty">Journal unavailable.</li>';
    }
  }

  async function refreshManualHistory(statusSnapshot = null) {
    try {
      const rows = await requestJson("/history");
      const manualRows = (rows || []).filter((r) => r.source === "manual");
      const manualRecent = manualRows.slice(-10);
      if (historyBodyEl) {
        historyBodyEl.innerHTML = "";
        manualRows
          .slice()
          .reverse()
          .slice(0, 50)
          .forEach((r) => {
            const tr = document.createElement("tr");
            const pnlCls = Number(r.profit ?? 0) >= 0 ? "profit-positive" : "profit-negative";
            const side = contractSideLabel(r.contract_type);
            const stake = Number(r.stake ?? 0);
            const profit = Number(r.profit ?? 0);
            tr.innerHTML = `<td>${escapeHtml(r.timestamp ?? "-")}</td><td>${escapeHtml(side)}</td><td>${escapeHtml(String(r.digit ?? "-"))}</td><td>${stake.toFixed(2)}</td><td>${escapeHtml(String(r.result ?? "-"))}</td><td class="${pnlCls}">${profit >= 0 ? "+" : ""}${profit.toFixed(2)}</td>`;
            historyBodyEl.appendChild(tr);
          });
      }
      renderManualRecentTrades(manualRecent);
      updateManualSessionStats(statusSnapshot, manualRows);
    } catch (_e) {
      // ignore
    }
  }

  async function submitManualTrade() {
    if (!manualContractEl || !manualBarrierEl || !manualStakeEl || !manualBtn) return;
    if (manualSubmitting) return;
    showToast(
      `${manualContractEl.value === "DIGITUNDER" ? "Under" : "Over"} · barrier ${manualBarrierEl.value} · sending…`,
      800,
    );
    manualSubmitting = true;
    setLoading(manualBtn, true);
    setLoading(ouOverBtn, true);
    setLoading(ouUnderBtn, true);
    setLoading(buyOverBtn, true);
    setLoading(buyUnderBtn, true);
    beginManualContractWatch(manualContractEl.value, Number(manualBarrierEl.value), {
      payout: lastQuote?.payout,
    });
    let tradeOk = false;
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
      tradeOk = true;
      if (typeof res.won === "boolean") {
        finalizeManualContractWatch(res.won, res.payout);
        const secs = Number(res.duration_sec ?? NaN);
        const secText = Number.isFinite(secs) ? ` in ${secs.toFixed(2)}s` : "";
        showToast(
          res.won
            ? `Win: +${Number(res.profit_delta ?? 0).toFixed(2)} USD${secText}`
            : `Loss: ${Number(res.profit_delta ?? 0).toFixed(2)} USD${secText}`,
          1800,
        );
      }
      if (Number.isFinite(Number(res.balance))) {
        applySessionBalance(Number(res.balance));
      }
    } catch (error) {
      showToast(`Manual trade failed: ${error.message}`, 2600);
      if (manualContractWatch && !manualContractWatch.finalized) {
        if (manualContractWatch.fastPollId) window.clearInterval(manualContractWatch.fastPollId);
        manualContractWatch = null;
        activePanelEl?.classList.add("hidden");
      }
    } finally {
      setLoading(manualBtn, false);
      setLoading(ouOverBtn, false);
      setLoading(ouUnderBtn, false);
      setLoading(buyOverBtn, false);
      setLoading(buyUnderBtn, false);
      manualSubmitting = false;
    }
    if (tradeOk) {
      const after = async () => {
        try {
          let statusSnapshot = null;
          if (typeof onAfterAction === "function") {
            await onAfterAction();
            try {
              statusSnapshot = await requestJson("/status");
            } catch (_s) {
              /* ignore */
            }
          }
          await Promise.all([refreshManualHistory(statusSnapshot), refreshManualJournal(), refreshQuote()]);
        } catch (_e) {
          /* ignore */
        }
      };
      void after();
    }
  }

  function selectManualSide(contractValue) {
    if (!manualContractEl) return;
    manualContractEl.value = contractValue;
    syncOuButtons();
    syncManualTradeSummary();
    renderDigitPrediction(recentPoints);
    refreshQuote();
  }

  if (ouOverBtn && manualContractEl) {
    ouOverBtn.addEventListener("click", () => selectManualSide("DIGITOVER"));
  }
  if (ouUnderBtn && manualContractEl) {
    ouUnderBtn.addEventListener("click", () => selectManualSide("DIGITUNDER"));
  }
  if (buyOverBtn) {
    buyOverBtn.addEventListener("click", async () => {
      selectManualSide("DIGITOVER");
      if (!manualEnabled) return;
      await submitManualTrade();
    });
  }
  if (buyUnderBtn) {
    buyUnderBtn.addEventListener("click", async () => {
      selectManualSide("DIGITUNDER");
      if (!manualEnabled) return;
      await submitManualTrade();
    });
  }
  if (digitGrid && manualBarrierEl) {
    digitGrid.querySelectorAll(".digit-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        manualBarrierEl.value = cell.dataset.digit ?? "0";
        syncDigitGrid();
        syncManualTradeSummary();
        renderDigitPrediction(recentPoints);
        refreshQuote();
      });
    });
  }
  function resizeManualChart() {
    const chartEl = document.getElementById("manualPriceChart");
    if (chart && chartEl) {
      const w = Math.max(200, chartEl.clientWidth || 0);
      const h = getManualChartHeight();
      if (w > 0 && h > 80) {
        chart.resize(w, h);
        chart.timeScale().fitContent();
      }
    }
  }
  const chartStageEl = document.querySelector(".manual-ws-col--left .manual-chart-stage");
  if (chartStageEl && typeof ResizeObserver !== "undefined") {
    const chartResizeObs = new ResizeObserver(() => resizeManualChart());
    chartResizeObs.observe(chartStageEl);
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
      selectManualSide("DIGITOVER");
    } else if (e.key === "u" || e.key === "U") {
      selectManualSide("DIGITUNDER");
    } else if (e.key >= "0" && e.key <= "9") {
      if (manualBarrierEl) {
        manualBarrierEl.value = e.key;
        syncDigitGrid();
        syncManualTradeSummary();
        renderDigitPrediction(recentPoints);
        refreshQuote();
      }
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
    syncManualTopBar();
    void refreshManualHistory(status);
  }

  if (digitGrid) {
    window.addEventListener("resize", () => {
      const d = Number(liveTickDigitEl?.textContent);
      if (!Number.isNaN(d)) moveDigitPointerToCell(digitGrid, digitPointer, d);
      resizeManualChart();
    });
  }
  document.querySelectorAll("[data-manual-tf]").forEach((btn) => {
    btn.addEventListener("click", () => {
      manualChartTf = Number(btn.dataset.manualTf || 1) || 1;
      document.querySelectorAll("[data-manual-tf]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });
      paintManualChart(recentPoints);
    });
  });
  document.querySelectorAll("[data-manual-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      manualChartView = btn.dataset.manualView || "price";
      document.querySelectorAll("[data-manual-view]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });
      paintManualChart(recentPoints);
    });
  });
  initManualBottomTabs();
  syncOuButtons();
  syncDigitGrid();
  syncManualTradeSummary();
  applyManualChartViewUi();
  updateManualEnableState();
  refreshLiveContext();
  refreshQuote();
  refreshManualHistory();
  refreshManualJournal();
  setInterval(refreshLiveContext, 1000);
  requestAnimationFrame(() => {
    resizeManualChart();
    requestAnimationFrame(resizeManualChart);
  });

  return { onStatus, refreshQuote, refreshManualHistory, refreshManualJournal };
}

function readExecutionFromInputs(minPayoutEl, maxLatencyEl) {
  return {
    min_payout_to_stake: Math.min(10, Math.max(1.01, Number(minPayoutEl?.value ?? 1.75))),
    max_proposal_latency_ms: Math.min(
      5000,
      Math.max(50, Math.round(Number(maxLatencyEl?.value ?? 1500)))
    ),
  };
}

function syncExecutionInputs(execution, minPayoutEl, maxLatencyEl, dirty) {
  if (dirty || !minPayoutEl || !maxLatencyEl) return;
  const ex = execution && typeof execution === "object" ? execution : {};
  minPayoutEl.value = Number(ex.min_payout_to_stake ?? 1.75).toFixed(2);
  maxLatencyEl.value = String(Math.round(Number(ex.max_proposal_latency_ms ?? 1500)));
}

function readSearchFromInputs(els) {
  return {
    enabled: String(els.enabledEl?.value ?? "true") === "true",
    barrier_policy: String(els.policyEl?.value ?? "efficiency"),
    min_estimated_ratio: Math.min(10, Math.max(1.01, Number(els.minRatioEl?.value ?? 1.75))),
    min_barrier_over: Math.min(9, Math.max(0, Math.round(Number(els.minOverEl?.value ?? 4)))),
    max_barrier_under: Math.min(9, Math.max(0, Math.round(Number(els.maxUnderEl?.value ?? 5)))),
    adaptive_ratio: String(els.adaptiveEl?.value ?? "false") === "true",
  };
}

function syncSearchInputs(search, els, dirty) {
  if (dirty || !els.enabledEl) return;
  const s = search && typeof search === "object" ? search : {};
  els.enabledEl.value = s.enabled === false ? "false" : "true";
  if (els.policyEl) els.policyEl.value = s.barrier_policy === "signal" ? "signal" : "efficiency";
  if (els.minRatioEl) els.minRatioEl.value = Number(s.min_estimated_ratio ?? 1.75).toFixed(2);
  if (els.minOverEl) els.minOverEl.value = String(Math.round(Number(s.min_barrier_over ?? 4)));
  if (els.maxUnderEl) els.maxUnderEl.value = String(Math.round(Number(s.max_barrier_under ?? 5)));
  if (els.adaptiveEl) els.adaptiveEl.value = s.adaptive_ratio ? "true" : "false";
}

let cachedStrategyPresets = null;

async function loadStrategyPresetOptions(selectEl) {
  if (!selectEl) return;
  try {
    if (!cachedStrategyPresets) {
      const data = await requestJson("/strategy-presets");
      cachedStrategyPresets = Array.isArray(data.presets) ? data.presets : [];
    }
    const current = selectEl.value;
    selectEl.innerHTML =
      '<option value="">Custom</option>' +
      cachedStrategyPresets
        .map((p) => `<option value="${p.id}">${p.label}</option>`)
        .join("");
    if (current && [...selectEl.options].some((o) => o.value === current)) {
      selectEl.value = current;
    }
  } catch (_err) {
    selectEl.innerHTML =
      '<option value="">Custom</option>' +
      '<option value="scalp_safe">Scalp (safe)</option>' +
      '<option value="balanced">Balanced</option>' +
      '<option value="sniper">Sniper</option>';
  }
}

function syncPresetUi(strategy, presetSelectEl, hintEl) {
  if (!presetSelectEl) return;
  const profile = String(strategy?.profile || "");
  presetSelectEl.value = profile && [...presetSelectEl.options].some((o) => o.value === profile) ? profile : "";
  if (hintEl) {
    const preset = (cachedStrategyPresets || []).find((p) => p.id === profile);
    hintEl.textContent = preset?.description || (profile ? `Active profile: ${profile}` : "");
  }
}

async function saveSearchFilters(els, saveBtn) {
  setLoading(saveBtn, true);
  try {
    const body = readSearchFromInputs(els);
    await requestJson("/strategy-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    showToast("Payout search settings saved");
    return true;
  } catch (error) {
    showToast(`Save search failed: ${error.message}`);
    return false;
  } finally {
    setLoading(saveBtn, false);
  }
}

async function saveExecutionFilters(minPayoutEl, maxLatencyEl, saveBtn) {
  setLoading(saveBtn, true);
  try {
    const body = readExecutionFromInputs(minPayoutEl, maxLatencyEl);
    await requestJson("/strategy-execution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    showToast("Execution filters saved");
    return true;
  } catch (error) {
    showToast(`Save execution failed: ${error.message}`);
    return false;
  } finally {
    setLoading(saveBtn, false);
  }
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
  const historyBodyEl = document.getElementById("historyBody");
  const balanceMirrorEl = document.getElementById("balanceMirror");
  const todayProfitEl = document.getElementById("todayProfit");
  const todayLossEl = document.getElementById("todayLoss");
  const netPlEl = document.getElementById("netPl");
  const activeTradesMirrorEl = document.getElementById("activeTradesMirror");
  const winRateCardEl = document.getElementById("winRateCard");
  const botStatusCardEl = document.getElementById("botStatusCard");

  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
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
  const saveExecutionBtn = document.getElementById("saveExecutionBtn");
  const minPayoutRatioEl = document.getElementById("dashMinPayoutRatio");
  const maxProposalLatencyEl = document.getElementById("dashMaxProposalLatency");
  const saveSearchBtn = document.getElementById("saveSearchBtn");
  const searchEls = {
    enabledEl: document.getElementById("dashSearchEnabled"),
    policyEl: document.getElementById("dashBarrierPolicy"),
    minRatioEl: document.getElementById("dashMinEstimatedRatio"),
    minOverEl: document.getElementById("dashMinBarrierOver"),
    maxUnderEl: document.getElementById("dashMaxBarrierUnder"),
    adaptiveEl: document.getElementById("dashAdaptiveRatio"),
  };
  const strategyPresetEl = document.getElementById("dashStrategyPreset");
  const applyStrategyPresetBtn = document.getElementById("applyStrategyPresetBtn");
  const presetHintEl = document.getElementById("dashPresetHint");

  /** When true, do not overwrite stake / TP / SL from `/status` (1s poll) so the user can edit. */
  let settingsDirty = false;
  let strategyDirty = false;
  let executionDirty = false;
  let searchDirty = false;
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
      execution: {
        min_payout_to_stake: Number(src.execution?.min_payout_to_stake ?? 1.75),
        max_proposal_latency_ms: Math.round(Number(src.execution?.max_proposal_latency_ms ?? 1500)),
      },
      search: src.search && typeof src.search === "object" ? { ...src.search } : undefined,
      model: src.model && typeof src.model === "object" ? { ...src.model } : undefined,
      confluence: src.confluence && typeof src.confluence === "object" ? { ...src.confluence } : undefined,
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
    syncExecutionInputs(normalized.execution, minPayoutRatioEl, maxProposalLatencyEl, executionDirty);
    syncSearchInputs(normalized.search, searchEls, searchDirty);
    syncPresetUi(normalized, strategyPresetEl, presetHintEl);
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
      const t = dashChartTheme();
      profitChart = new Chart(ctx, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Session P/L",
              data: series,
              borderColor: t.line,
              backgroundColor: t.fill,
              fill: true,
              tension: 0.32,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointHitRadius: 8,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 380 },
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: t.tooltipBg,
              borderColor: t.tooltipBorder,
              borderWidth: 1,
              titleColor: t.tooltipTitle,
              bodyColor: t.tooltipBody,
            },
          },
          scales: {
            x: {
              ticks: { color: t.tick, maxTicksLimit: 8, font: { size: 10 } },
              grid: { color: t.grid },
              border: { color: t.border },
            },
            y: {
              ticks: { color: t.tick, font: { size: 10 } },
              grid: { color: t.grid },
              border: { color: t.border },
            },
          },
        },
      });
      return;
    }

    profitChart.data.labels = labels;
    profitChart.data.datasets[0].data = series;
    profitChart.update("none");
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
    const botState = resolveBotState(status);
    const running = botState === "running";
    const paused = botState === "paused";
    const statusEl = document.getElementById("mobileRunStatus");
    const labelEl = document.getElementById("mobileRunLabel");
    const btn = document.getElementById("mobileRunBtn");
    const bar = document.querySelector(".app-bottom-bar");
    const progress = document.getElementById("mobileRunProgress");
    if (statusEl) {
      statusEl.textContent = running
        ? "Bot is running"
        : paused
          ? "Bot is paused"
          : "Bot is not running";
    }
    if (labelEl) labelEl.textContent = running ? "Stop" : paused ? "Resume" : "Run";
    if (btn) {
      btn.classList.toggle("btn-run-teal--stop", running);
      btn.classList.toggle("btn-run-teal--pause", paused);
      btn.setAttribute("aria-pressed", running || paused ? "true" : "false");
    }
    if (bar) bar.classList.toggle("app-bottom-bar--running", running);
    if (bar) bar.classList.toggle("app-bottom-bar--paused", paused);
    if (progress) progress.style.width = running ? "100%" : paused ? "55%" : "14%";
  }

  function applyStatus(status, isFirstStatusPoll = false) {
    const running = !!status.running;
    window.__lastDashStatus = status;
    syncMobileRunChrome(status);
    const effectiveBalance = resolveEffectiveBalance(status);
    if ((status.trades_count ?? 0) > 0 && Number.isFinite(Number(status.balance))) {
      applySessionBalance(Number(status.balance), { syncHeader: false });
    }
    if (window.AccountOverview) {
      window.AccountOverview.updateFromStatus(status);
    } else {
      balanceEl.textContent = `$${effectiveBalance.toFixed(2)}`;
      profitEl.textContent = `$${Number(status.profit ?? 0).toFixed(2)}`;
      statusBadgeEl.textContent = running ? "Running" : "Stopped";
      statusBadgeEl.classList.toggle("running", running);
      statusBadgeEl.classList.toggle("stopped", !running);
    }
    if (window.DashboardPolish) {
      window.DashboardPolish.updateDecimal(liveStakeEl, Number(status.stake ?? 0));
      window.DashboardPolish.updateCounter(tradesCountEl, status.trades_count ?? 0);
    } else {
      liveStakeEl.textContent = Number(status.stake ?? 0).toFixed(2);
      tradesCountEl.textContent = String(status.trades_count ?? 0);
    }
    lastDigitsEl.textContent = JSON.stringify(status.last_digits ?? []);
    const lastRes = status.last_result ?? "-";
    if (window.DashboardPolish) {
      window.DashboardPolish.updateText(lastResultEl, lastRes, { dir: String(lastRes).toLowerCase() === "win" ? "up" : String(lastRes).toLowerCase() === "loss" ? "down" : "neutral" });
    } else {
      lastResultEl.textContent = lastRes;
    }

    const activeTradesEl = document.getElementById("activeTrades");
    const activeTradeCount = (status.active_trades ?? []).length;
    if (activeTradesEl) {
      if (window.DashboardPolish) {
        window.DashboardPolish.updateCounter(activeTradesEl, activeTradeCount);
      } else {
        activeTradesEl.textContent = String(activeTradeCount);
      }
    }
    if (activeTradesMirrorEl) activeTradesMirrorEl.textContent = String(activeTradeCount);
    applyHybridBannerFromStatus(status);
    renderDashDigitTape(status.last_digits ?? []);
    renderDashOpenTrades(status);
    renderDashSignals(status);
    syncCommandTerminal(status);

    if (botStatusCardEl) botStatusCardEl.textContent = running ? "Running" : "Stopped";
    if (balanceMirrorEl) balanceMirrorEl.textContent = `$${effectiveBalance.toFixed(2)}`;
    const net = Number(status.profit ?? 0);
    const profitNow = net > 0 ? net : 0;
    const lossNow = net < 0 ? Math.abs(net) : 0;
    if (todayProfitEl) todayProfitEl.textContent = `$${profitNow.toFixed(2)}`;
    if (todayLossEl) todayLossEl.textContent = `$${lossNow.toFixed(2)}`;
    if (netPlEl) netPlEl.textContent = `$${net.toFixed(2)}`;

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
      if (window.TradeAnalytics) {
        await window.TradeAnalytics.refresh(history, status, requestJson);
      } else if (winRateCardEl) {
        const settled = history.filter((h) => {
          const r = String(h.result || "").toLowerCase();
          return r === "win" || r === "loss";
        });
        const wins = settled.filter((h) => String(h.result || "").toLowerCase() === "win").length;
        const rate = settled.length ? (wins / settled.length) * 100 : 0;
        winRateCardEl.textContent = `${rate.toFixed(1)}%`;
        const winRateVisible = document.getElementById("winRateCardVisible");
        if (winRateVisible) winRateVisible.textContent = `${rate.toFixed(1)}%`;
      }
      updateChart(history);
      if (window.ActivityStream) {
        await window.ActivityStream.refresh(requestJson);
      }
      if (tradeAlertPollIndex % 15 === 0) {
        await refreshAuthState();
      }
    } catch (error) {
      showToast(`Refresh error: ${error.message}`);
    }
  }

  async function pushSettingsFromInputs() {
    if (!stakeInputEl || !takeProfitInputEl || !stopLossInputEl) return;
    await requestJson("/update-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stake: Number(stakeInputEl.value),
        take_profit: Number(takeProfitInputEl.value),
        stop_loss: Number(stopLossInputEl.value),
      }),
    });
    settingsDirty = false;
  }

  async function startBot() {
    setLoading(startBtn, true);
    try {
      const state = resolveBotState(window.__lastDashStatus || {});
      if (state === "paused") {
        const result = await requestJson("/resume-bot", { method: "POST" });
        showToast(result.message ?? "Bot resumed");
        await refreshDashboard();
        return;
      }
      if (stakeInputEl && takeProfitInputEl && stopLossInputEl) {
        await pushSettingsFromInputs();
      }
      const result = await requestJson("/start-bot", { method: "POST" });
      showToast(result.message ?? "Bot started");
      await refreshDashboard();
    } catch (error) {
      showToast(`Start failed: ${error.message}`);
    } finally {
      setLoading(startBtn, false);
    }
  }

  async function pauseBot() {
    setLoading(pauseBtn, true);
    try {
      const result = await requestJson("/pause-bot", { method: "POST" });
      showToast(result.message ?? "Bot paused");
      await refreshDashboard();
    } catch (error) {
      showToast(`Pause failed: ${error.message}`);
    } finally {
      setLoading(pauseBtn, false);
    }
  }

  async function stopBot() {
    const ok = window.confirm(
      "Stop the bot?\n\nThe session will end and no new trades will be placed. Confirm to proceed."
    );
    if (!ok) return;
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
      if (minPayoutRatioEl && maxProposalLatencyEl) {
        current.execution = readExecutionFromInputs(minPayoutRatioEl, maxProposalLatencyEl);
        executionDirty = false;
      }
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
  pauseBtn?.addEventListener("click", pauseBot);
  stopBtn.addEventListener("click", stopBot);
  saveSettingsBtn.addEventListener("click", saveSettings);
  saveStrategyModeBtn?.addEventListener("click", saveStrategyMode);
  loadStrategyPresetOptions(strategyPresetEl);
  applyStrategyPresetBtn?.addEventListener("click", async () => {
    const preset = String(strategyPresetEl?.value || "").trim();
    if (!preset) {
      showToast("Choose a profile preset first");
      return;
    }
    setLoading(applyStrategyPresetBtn, true);
    try {
      const result = await requestJson("/strategy-preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset }),
      });
      searchDirty = false;
      executionDirty = false;
      showToast(`Applied ${result.label || preset} profile`);
      await refreshDashboard();
    } catch (error) {
      showToast(`Apply preset failed: ${error.message}`);
    } finally {
      setLoading(applyStrategyPresetBtn, false);
    }
  });
  strategyPresetEl?.addEventListener("change", () => {
    const preset = (cachedStrategyPresets || []).find((p) => p.id === strategyPresetEl.value);
    if (presetHintEl) {
      presetHintEl.textContent = preset?.description || "";
    }
  });

  saveSearchBtn?.addEventListener("click", async () => {
    const ok = await saveSearchFilters(searchEls, saveSearchBtn);
    if (ok) {
      searchDirty = false;
      await refreshDashboard();
    }
  });
  saveExecutionBtn?.addEventListener("click", async () => {
    const ok = await saveExecutionFilters(minPayoutRatioEl, maxProposalLatencyEl, saveExecutionBtn);
    if (ok) {
      executionDirty = false;
      await refreshDashboard();
    }
  });
  Object.values(searchEls).forEach((el) => {
    if (!el) return;
    const markDirty = () => {
      searchDirty = true;
    };
    el.addEventListener("input", markDirty);
    el.addEventListener("change", markDirty);
  });
  [minPayoutRatioEl, maxProposalLatencyEl].forEach((el) => {
    if (!el) return;
    const markDirty = () => {
      executionDirty = true;
    };
    el.addEventListener("input", markDirty);
    el.addEventListener("change", markDirty);
  });
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

  if (window.DashboardPolish) window.DashboardPolish.init();
  refreshDashboard().finally(() => {
    if (window.DashboardPolish) window.DashboardPolish.markReady();
  });
  refreshDiagnostics();
  setInterval(refreshDashboard, 1000);
  window.setInterval(refreshDiagnostics, 15000);
  window.setInterval(refreshAuthState, 15000);
}

function initManualTraderPage() {
  if (!document.getElementById("manualBuyOverBtn") && !document.getElementById("manualTradeBtn")) return;

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

  const stratProfilePresetEl = document.getElementById("stratProfilePreset");
  const stratApplyPresetBtn = document.getElementById("stratApplyPresetBtn");
  const stratPresetHintEl = document.getElementById("stratPresetHint");
  const minPayoutRatioEl = document.getElementById("stratMinPayoutRatio");
  const maxProposalLatencyEl = document.getElementById("stratMaxProposalLatency");
  const executionSaveBtn = document.getElementById("stratExecutionSaveBtn");
  const searchSaveBtn = document.getElementById("stratSearchSaveBtn");
  const riskSaveBtn = document.getElementById("stratRiskSaveBtn");
  const searchEls = {
    enabledEl: document.getElementById("stratSearchEnabled"),
    policyEl: document.getElementById("stratBarrierPolicy"),
    minRatioEl: document.getElementById("stratMinEstimatedRatio"),
    minOverEl: document.getElementById("stratMinBarrierOver"),
    maxUnderEl: document.getElementById("stratMaxBarrierUnder"),
    adaptiveEl: document.getElementById("stratAdaptiveRatio"),
  };

  let executionDirty = false;
  let searchDirty = false;
  let riskDirty = false;
  let confluenceDirty = false;

  async function refreshStrategyForms(strategy) {
    if (strategy) {
      syncExecutionInputs(strategy.execution, minPayoutRatioEl, maxProposalLatencyEl, executionDirty);
      syncSearchInputs(strategy.search, searchEls, searchDirty);
      syncPresetUi(strategy, stratProfilePresetEl, stratPresetHintEl);
      syncRiskFormFromStrategy(strategy, riskDirty);
    }
  }

  async function refreshStrategies() {
    try {
      const [status, runtime, decisions] = await Promise.all([
        requestJson("/status"),
        requestJson("/strategy/runtime"),
        requestJson("/strategy/signal-decisions?limit=24"),
      ]);
      applyConfluenceLive(status);
      if (!confluenceDirty) syncConfluenceFormFromStatus(status);
      applyRuntimeSummary(runtime);
      applyPipelineStatus(status);
      renderDecisionLog(decisions.decisions || []);
      await refreshStrategyForms(status.strategy);
      await refreshAuthState();
    } catch (error) {
      showToast(`Strategies: ${error.message}`);
    }
  }

  loadStrategyPresetOptions(stratProfilePresetEl);
  stratApplyPresetBtn?.addEventListener("click", async () => {
    const preset = String(stratProfilePresetEl?.value || "").trim();
    if (!preset) {
      showToast("Choose a profile preset first");
      return;
    }
    setLoading(stratApplyPresetBtn, true);
    try {
      const result = await requestJson("/strategy-preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset }),
      });
      searchDirty = false;
      executionDirty = false;
      showToast(`Applied ${result.label || preset} profile`);
      await refreshStrategies();
    } catch (error) {
      showToast(`Apply preset failed: ${error.message}`);
    } finally {
      setLoading(stratApplyPresetBtn, false);
    }
  });
  stratProfilePresetEl?.addEventListener("change", () => {
    const preset = (cachedStrategyPresets || []).find((p) => p.id === stratProfilePresetEl.value);
    if (stratPresetHintEl) {
      stratPresetHintEl.textContent = preset?.description || "";
    }
  });

  searchSaveBtn?.addEventListener("click", async () => {
    const ok = await saveSearchFilters(searchEls, searchSaveBtn);
    if (ok) {
      searchDirty = false;
      await refreshStrategies();
    }
  });
  Object.values(searchEls).forEach((el) => {
    el?.addEventListener("input", () => {
      searchDirty = true;
    });
    el?.addEventListener("change", () => {
      searchDirty = true;
    });
  });

  executionSaveBtn?.addEventListener("click", async () => {
    const ok = await saveExecutionFilters(minPayoutRatioEl, maxProposalLatencyEl, executionSaveBtn);
    if (ok) {
      executionDirty = false;
      await refreshStrategies();
    }
  });
  [minPayoutRatioEl, maxProposalLatencyEl].forEach((el) => {
    el?.addEventListener("input", () => {
      executionDirty = true;
    });
    el?.addEventListener("change", () => {
      executionDirty = true;
    });
  });

  riskSaveBtn?.addEventListener("click", async () => {
    setLoading(riskSaveBtn, true);
    try {
      await requestJson("/strategy-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_consecutive_losses: Number(document.getElementById("stratMaxConsecLosses")?.value || 2),
          max_session_drawdown_pct: Number(document.getElementById("stratMaxDrawdown")?.value || 10),
          max_trades_per_session: Number(document.getElementById("stratMaxTradesSession")?.value || 50),
          cooldown_ticks: Number(document.getElementById("stratCooldownTicks")?.value || 10),
          volatility_lockout_enabled: document.getElementById("stratVolLockout")?.value === "true",
          research_mode: document.getElementById("stratResearchMode")?.value === "true",
          use_probability_gate: document.getElementById("stratProbGate")?.value === "true",
          min_win_probability: Number(document.getElementById("stratMinWinProb")?.value || 0.6),
        }),
      });
      riskDirty = false;
      showToast("Risk policy saved");
      await refreshStrategies();
    } catch (error) {
      showToast(`Save risk failed: ${error.message}`);
    } finally {
      setLoading(riskSaveBtn, false);
    }
  });
  [
    "stratMaxConsecLosses",
    "stratMaxDrawdown",
    "stratMaxTradesSession",
    "stratCooldownTicks",
    "stratVolLockout",
    "stratResearchMode",
    "stratProbGate",
    "stratMinWinProb",
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => {
      riskDirty = true;
    });
    document.getElementById(id)?.addEventListener("input", () => {
      riskDirty = true;
    });
  });

  const confSaveBtn = document.getElementById("confSaveBtn");
  confSaveBtn?.addEventListener("click", async () => {
    setLoading(confSaveBtn, true);
    try {
      const body = {
        enabled: document.getElementById("confEnabled")?.checked ?? false,
        enforce_confluence: document.getElementById("confEnforce")?.value === "true",
        min_score: Number(document.getElementById("confMinScore")?.value || 5),
        min_confirmations: Number(document.getElementById("confMinConfirmations")?.value || 2),
        history_ticks: Number(document.getElementById("confHistoryTicks")?.value || 900),
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
      confluenceDirty = false;
      showToast("Confluence settings saved");
      await refreshStrategies();
    } catch (error) {
      showToast(`Save confluence failed: ${error.message}`);
    } finally {
      setLoading(confSaveBtn, false);
    }
  });
  [
    "confEnabled",
    "confTrend",
    "confSr",
    "confRsi",
    "confCandle",
    "confRange",
    "confMinScore",
    "confMinConfirmations",
    "confHistoryTicks",
    "confEnforce",
  ].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("change", () => {
      confluenceDirty = true;
    });
    el?.addEventListener("input", () => {
      confluenceDirty = true;
    });
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

function initTradingBotsPage() {
  const runBtn = document.getElementById("tradingBotsRunBtn");
  if (!runBtn) return;
  const stopBtn = document.getElementById("tradingBotsStopBtn");
  const statusEl = document.getElementById("tradingBotsRunStatus");
  async function refreshStatus() {
    try {
      const status = await requestJson("/status");
      const running = !!status.running;
      if (statusEl) {
        statusEl.textContent = running ? "Running" : "Not running";
        statusEl.classList.toggle("status-pill--ok", running);
        statusEl.classList.toggle("status-pill--danger", !running);
      }
    } catch (_e) {}
  }
  runBtn.addEventListener("click", async () => {
    await requestJson("/start-bot", { method: "POST" });
    await refreshStatus();
  });
  stopBtn?.addEventListener("click", async () => {
    await requestJson("/stop-bot", { method: "POST" });
    await refreshStatus();
  });
  initAuthButtons();
  refreshAuthState();
  refreshStatus();
  setInterval(refreshStatus, 2000);
  window.setInterval(refreshAuthState, 15000);
}

function initBuilderPage() {
  const blocklyDiv = document.getElementById("blocklyDiv");
  if (!blocklyDiv) return;

  const generateBtn = document.getElementById("generateStrategyBtn");
  const loadBtn = document.getElementById("loadStrategyBtn");
  const outputEl = document.getElementById("strategyOutput");
  const runBtn = document.getElementById("builderRunBtn");
  const stopBtn = document.getElementById("builderStopBtn");
  const leftPanel = document.getElementById("builderLeftPanel");
  const controlPanel = document.getElementById("builderControlPanel");
  const centerPane = document.getElementById("builderCenterPane");
  const aiDrawer = document.getElementById("builderAiDrawer");
  const aiOutput = document.getElementById("builderAiOutput");
  let builderSessionStart = null;
  window.builderSaveDirty = false;
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
    logs: document.getElementById("builderTabLogs"),
    errors: document.getElementById("builderTabErrors"),
  };

  const BUILDER_QUICK_PRESETS = [
    {
      id: "quick_digit_under",
      label: "Digit Under starter",
      contract: "DIGITUNDER",
      risk: "Low",
      desc: "Repeat-3 pattern with under bias and conservative stake.",
      templateId: "martingale",
    },
    {
      id: "quick_digit_over",
      label: "Digit Over starter",
      contract: "DIGITOVER",
      risk: "Low",
      desc: "Breakout-style over entries on volatility indices.",
      templateId: "reverse_martingale",
    },
    {
      id: "quick_vol_recovery",
      label: "Vol recovery",
      contract: "DIGITUNDER",
      risk: "Medium",
      desc: "Martingale recovery tuned for volatility markets.",
      templateId: "martingale_reset",
    },
  ];

  function contractLabel(code) {
    const c = String(code || "").toUpperCase();
    if (c === "DIGITOVER") return "Digit Over";
    if (c === "DIGITUNDER") return "Digit Under";
    return c || "—";
  }

  function riskFromTemplate(t) {
    const stake = Number(t?.stake ?? 1);
    if (stake >= 1.2) return "High";
    if (stake >= 0.9) return "Medium";
    return "Low";
  }

  function describeTemplate(t) {
    const label = t?.label || "Strategy";
    const contract = contractLabel(t?.contract);
    return `Pre-built ${label} using ${contract} with ${t?.logicMode || "AND"} logic.`;
  }

  function applyBuilderStrategyFromTemplate(item, opts = {}) {
    if (!item) return;
    if (!opts.skipConfirm && window.BuilderStorage?.previewTemplate) {
      window.BuilderStorage.previewTemplate({
        ...item,
        label: item.label || item.name,
        desc: item.desc || describeTemplate(item),
        risk: item.risk || riskFromTemplate(item),
        contract: item.contract || item.contract_type,
      });
      return;
    }
    if (typeof injectQuickTemplateBlocks !== "function") return;
    const lib =
      typeof getBuilderTemplateLibrary === "function" ? getBuilderTemplateLibrary() : [];
    const template = item.templateId
      ? lib.find((row) => row.id === item.templateId) || item
      : lib.find((row) => row.id === item.id) || item;
    if (!template?.id && !template?.label) return;
    injectQuickTemplateBlocks({
      strategyType: template.id,
      strategyLabel: template.label,
      threshold: template.threshold,
      logicMode: template.logicMode,
      stake: template.stake,
      lossThreshold: template.loss,
      profitThreshold: template.profit,
      market: "R_100",
      contractType: template.contract || item.contract || "DIGITUNDER",
      trend: template.trend,
      rsiOp: template.rsiOp,
      rsiValue: template.rsiValue,
    });
    syncBuilderStrategyHeader();
    setBuilderSaveStatus(false);
    showToast(`Loaded ${item.label || template.label}`);
    window.BuilderStorage?.refreshLibrary?.();
  }

  function renderBuilderLibraryCard(item, onUse, options = {}) {
    const actionLabel = options.actionLabel || "Use";
    const card = document.createElement("article");
    card.className = "builder-library-card";
    card.innerHTML = `
      <div class="builder-library-card__head">
        <strong class="builder-library-card__name">${escapeHtml(item.label || item.name)}</strong>
        <span class="builder-library-card__risk builder-library-card__risk--${String(item.risk || "low").toLowerCase()}">${escapeHtml(item.risk || "Low")}</span>
      </div>
      <p class="builder-library-card__contract subtle small">${escapeHtml(contractLabel(item.contract || item.contract_type))}</p>
      <p class="builder-library-card__desc subtle small">${escapeHtml(item.desc || describeTemplate(item))}</p>
      <button type="button" class="btn btn-blue btn-sm builder-library-card__use">${escapeHtml(actionLabel)}</button>`;
    card.querySelector(".builder-library-card__use")?.addEventListener("click", (e) => {
      e.stopPropagation();
      onUse(item);
    });
    return card;
  }

  function renderBuilderTemplateGroups(host, q, onPreview) {
    if (!host) return;
    const lib =
      typeof getBuilderTemplateLibrary === "function" ? getBuilderTemplateLibrary() : [];
    const match = (item) =>
      !q ||
      String(item.label || "")
        .toLowerCase()
        .includes(q) ||
      String(item.contract || "")
        .toLowerCase()
        .includes(q);

    const preview = onPreview || ((item) => applyBuilderStrategyFromTemplate(item));

    BUILDER_QUICK_PRESETS.filter(match).forEach((item) => {
      host.appendChild(
        renderBuilderLibraryCard(item, preview, { actionLabel: "Preview" })
      );
    });

    lib
      .filter((t) => match({ ...t, desc: describeTemplate(t), risk: riskFromTemplate(t) }))
      .forEach((t) => {
        const item = { ...t, desc: describeTemplate(t), risk: riskFromTemplate(t) };
        host.appendChild(renderBuilderLibraryCard(item, preview, { actionLabel: "Preview" }));
      });

    host.appendChild(
      renderBuilderLibraryCard(
        {
          label: "Template wizard",
          contract: "Guided",
          risk: "—",
          desc: "Step through markets, contract type, and risk thresholds.",
        },
        () => {
          quickModal?.classList.remove("hidden");
          updateQuickWizardStep(1);
          renderQuickTemplateLibrary();
        },
        { actionLabel: "Open" }
      )
    );
  }

  window.renderBuilderTemplateGroups = renderBuilderTemplateGroups;
  window.applyBuilderStrategyFromTemplate = applyBuilderStrategyFromTemplate;

  function syncBuilderStrategyHeader() {
    const strategy =
      typeof extractStrategyFromWorkspace === "function" ? extractStrategyFromWorkspace() : null;
    const rules = strategy?.actions?.over_under?.rules || {};
    const trade = String(rules.trade || "UNDER").toUpperCase();
    const contract = trade === "OVER" ? "DIGITOVER" : "DIGITUNDER";
    let stake = 1;
    if (typeof builderWorkspace !== "undefined" && builderWorkspace) {
      builderWorkspace.getAllBlocks(false).forEach((block) => {
        if (block.type === "stake_config") {
          const raw = Number(block.getFieldValue("STAKE"));
          if (Number.isFinite(raw) && raw > 0) stake = raw;
        }
      });
    }
    const nameEl = document.getElementById("builderStrategyName");
    const meta = strategy?.quick_meta?.strategy_label;
    if (nameEl) {
      nameEl.textContent = meta || (trade === "OVER" ? "Digit Over Strategy" : "Digit Under Strategy");
    }
    const symEl = document.getElementById("builderHeaderSymbol");
    if (symEl) symEl.textContent = strategy?.quick_meta?.market || "R_100";
    const contractEl = document.getElementById("builderHeaderContract");
    if (contractEl) contractEl.textContent = contractLabel(strategy?.quick_meta?.contract_type || contract);
    const stakeEl = document.getElementById("builderHeaderStake");
    if (stakeEl) stakeEl.textContent = `$${Number(stake).toFixed(2)}`;
  }

  function setBuilderSaveStatus(saved) {
    window.builderSaveDirty = !saved;
    const el = document.getElementById("builderSaveStatus");
    if (!el) return;
    el.textContent = saved ? "Saved" : "Unsaved";
    el.classList.toggle("builder-save-status--dirty", !saved);
  }

  window.syncBuilderStrategyHeader = syncBuilderStrategyHeader;
  window.setBuilderSaveStatus = setBuilderSaveStatus;
  window.touchBuilderEdited = touchBuilderEdited;

  function touchBuilderEdited() {
    const el = document.getElementById("builderHeaderEdited");
    const stamp = new Date().toLocaleString();
    if (el) el.textContent = `Last edited ${stamp}`;
    localStorage.setItem("builder.last.edited", String(Date.now()));
  }

  window.markBuilderStrategyDirty = () => {
    if (!window.builderSaveDirty) setBuilderSaveStatus(false);
  };

  function formatBuilderDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function updateBuilderConnectionPill() {
    const pill = document.getElementById("builderConnectionPill");
    if (!pill) return;
    if (lastDerivMe?.logged_in) {
      pill.textContent = "API connected";
      pill.classList.add("builder-connection-pill--ok");
      pill.classList.remove("builder-connection-pill--off");
    } else {
      pill.textContent = "API offline";
      pill.classList.remove("builder-connection-pill--ok");
      pill.classList.add("builder-connection-pill--off");
    }
  }

  function runBuilderAiAction(action) {
    if (!aiOutput) return;
    const strategy =
      typeof extractStrategyFromWorkspace === "function" ? extractStrategyFromWorkspace() : null;
    const blocks =
      typeof builderWorkspace !== "undefined" && builderWorkspace
        ? builderWorkspace.getAllBlocks(false)
        : [];
    const hasLoss = blocks.some((b) => b.type === "loss_limit");
    const hasProfit = blocks.some((b) => b.type === "profit_limit");
    const stakeBlock = blocks.find((b) => b.type === "stake_config");
    const stake = stakeBlock ? Number(stakeBlock.getFieldValue("STAKE")) : null;
    const messages = {
      explain: `<strong>Strategy overview</strong><p>Your workspace implements a digit ${strategy?.actions?.over_under?.rules?.trade === "OVER" ? "over" : "under"} flow with threshold ${strategy?.actions?.over_under?.rules?.if_digit_greater_equal ?? 5}. Advisory only — review blocks before running live.</p>`,
      risk: hasLoss
        ? "<strong>Risk scan</strong><p>Loss limit block detected. Still review stake sizing and consecutive loss exposure.</p>"
        : "<strong>Risk scan</strong><p>No loss-limit block found. Consider adding a sell/stop condition to cap downside.</p>",
      stake: `<strong>Stake suggestion</strong><p>Current stake ${stake ?? "—"}. For demo accounts, staying near $0.85–$1.00 reduces variance while you validate logic.</p>`,
      idea: "<strong>Idea → blocks</strong><p>Describe your entry rule in the template wizard or drag Analysis + Purchase blocks, then connect Buy Over/Under actions.</p>",
      stoploss: hasLoss
        ? "<strong>Stop-loss check</strong><p>Loss threshold block is present. Tune the LOSS field to match your session risk budget.</p>"
        : "<strong>Stop-loss check</strong><p>Missing loss_limit block. Add one from Sell conditions in the palette.</p>",
      optimize: hasProfit
        ? "<strong>Entry tuning</strong><p>Profit cap exists. Pair RSI/trend blocks with repeat-3 for cleaner entries.</p>"
        : "<strong>Entry tuning</strong><p>Add analysis_trend + analysis_rsi blocks and gate with logic_gate before purchase conditions.</p>",
    };
    aiOutput.innerHTML = messages[action] || "<p>Select an action for guidance.</p>";
  }

  function toggleAiDrawer(open) {
    if (!aiDrawer) return;
    const show = open ?? !aiDrawer.classList.contains("is-open");
    aiDrawer.classList.toggle("is-open", show);
    aiDrawer.setAttribute("aria-hidden", show ? "false" : "true");
    document.getElementById("builderAiToggleBtn")?.setAttribute("aria-expanded", show ? "true" : "false");
  }
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
    const hybridPaused = !!status.hybrid_paused;
    builderRunning = running;
    if (running && !builderSessionStart) builderSessionStart = Date.now();
    if (!running) builderSessionStart = null;

    const progressFill = document.getElementById("builderProgressFill");
    if (progressFill) progressFill.style.width = running ? "100%" : hybridPaused ? "55%" : "18%";

    const fmt = (v) => (v === undefined || v === null ? "—" : String(v));
    const stakeEl = document.getElementById("builderStatStake");
    if (stakeEl) stakeEl.textContent = `$${Number(status.stake ?? 0).toFixed(2)}`;
    const tradesEl = document.getElementById("builderStatTrades");
    if (tradesEl) tradesEl.textContent = fmt(status.trades_count ?? 0);
    const profitEl = document.getElementById("builderStatProfit");
    const profitVal = Number(status.profit ?? 0);
    if (profitEl) {
      profitEl.textContent = `${profitVal >= 0 ? "+" : ""}$${profitVal.toFixed(2)}`;
      profitEl.classList.toggle("is-profit", profitVal > 0);
      profitEl.classList.toggle("is-loss", profitVal < 0);
    }
    const balEl = document.getElementById("builderStatBalance");
    if (balEl) balEl.textContent = `$${Number(status.balance ?? 0).toFixed(2)}`;

    const runtimeBadge = document.getElementById("builderHeaderRuntime");
    const botBadge = document.getElementById("builderBotStatusBadge");
    let statusLabel = "Stopped";
    let statusClass = "stopped";
    if (running) {
      statusLabel = hybridPaused ? "Paused" : "Running";
      statusClass = hybridPaused ? "paused" : "running";
    } else if ((status.events ?? []).some((e) => String(e).toLowerCase().includes("error"))) {
      statusLabel = "Error";
      statusClass = "error";
    }
    [runtimeBadge, botBadge].forEach((el) => {
      if (!el) return;
      el.textContent = statusLabel;
      el.className = el.classList.contains("builder-runtime-badge")
        ? `builder-runtime-badge builder-runtime-badge--${statusClass}`
        : `builder-status-badge builder-status-badge--${statusClass}`;
    });

    const durationEl = document.getElementById("builderSessionDuration");
    if (durationEl) {
      durationEl.textContent = running && builderSessionStart
        ? formatBuilderDuration(Date.now() - builderSessionStart)
        : "00:00:00";
    }

    const marketEl = document.getElementById("builderCurrentMarket");
    const strategyMeta = status.strategy || {};
    if (marketEl) {
      marketEl.textContent = strategyMeta?.quick_meta?.market || strategyMeta?.symbol || "R_100";
    }

    const contractEl = document.getElementById("builderLastContract");
    const rules = strategyMeta?.actions?.over_under?.rules || {};
    if (contractEl) {
      const side = String(rules.trade || status.last_result || "—").toUpperCase();
      contractEl.textContent = side === "OVER" || side === "UNDER" ? `Digit ${side[0] + side.slice(1).toLowerCase()}` : fmt(status.last_result);
    }

    const signalEl = document.getElementById("builderLastSignal");
    const decision = status.last_model_decision || status.last_pipeline || null;
    if (signalEl) {
      signalEl.textContent = decision?.signal || decision?.action || decision?.reason || "—";
    }

    const events = status.events ?? [];
    const errorLines = events.filter((line) => {
      const lower = String(line).toLowerCase();
      return lower.includes("error") || lower.includes("failed");
    });
    const lastErrorEl = document.getElementById("builderLastError");
    if (lastErrorEl) lastErrorEl.textContent = errorLines[errorLines.length - 1] || "—";

    const journal = document.getElementById("builderJournalList");
    if (journal) {
      journal.innerHTML = "";
      if (!events.length) {
        const empty = document.createElement("li");
        empty.className = "builder-tab-empty";
        empty.textContent = "Journal is empty. Run the bot to populate events.";
        journal.appendChild(empty);
      } else {
        events
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

    const logsList = document.getElementById("builderLogsList");
    if (logsList) {
      logsList.innerHTML = "";
      const logLines = events.filter((line) => !String(line).toLowerCase().includes("error"));
      if (!logLines.length) {
        const empty = document.createElement("li");
        empty.className = "builder-tab-empty";
        empty.textContent = "No log entries yet.";
        logsList.appendChild(empty);
      } else {
        logLines
          .slice(-40)
          .reverse()
          .forEach((line) => {
            const li = document.createElement("li");
            li.textContent = line;
            styleJournalLevel(line, li);
            logsList.appendChild(li);
          });
      }
    }

    const errorsList = document.getElementById("builderErrorsList");
    if (errorsList) {
      errorsList.innerHTML = "";
      if (!errorLines.length) {
        const empty = document.createElement("li");
        empty.className = "builder-tab-empty";
        empty.textContent = "No errors recorded.";
        errorsList.appendChild(empty);
      } else {
        errorLines.reverse().forEach((line) => {
          const li = document.createElement("li");
          li.textContent = line;
          styleJournalLevel(line, li);
          errorsList.appendChild(li);
        });
      }
    }

    const logsBadge = document.getElementById("builderLogsBadge");
    const errorsBadge = document.getElementById("builderErrorsBadge");
    if (logsBadge) {
      const n = Math.min(99, events.length);
      logsBadge.textContent = String(n);
      logsBadge.classList.toggle("hidden", n === 0);
    }
    if (errorsBadge) {
      const n = Math.min(99, errorLines.length);
      errorsBadge.textContent = String(n);
      errorsBadge.classList.toggle("hidden", n === 0);
    }

    const txEmpty = document.getElementById("builderTransactionsEmpty");
    if (txEmpty) {
      const hasTx = Array.isArray(history) && history.length > 0;
      txEmpty.classList.toggle("hidden", hasTx);
    }

    syncBuilderStrategyHeader();
    updateBuilderConnectionPill();
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
      setBuilderSaveStatus(true);
      syncBuilderStrategyHeader();
    } catch (error) {
      showToast(`Load failed: ${error.message}`);
    }
  }

  async function generateAndSaveStrategy() {
    if (window.BuilderStorage?.saveStrategyFlow) {
      return window.BuilderStorage.saveStrategyFlow({ saveAs: false });
    }
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
      setBuilderSaveStatus(true);
      touchBuilderEdited();
      syncBuilderStrategyHeader();
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
      setBuilderSaveStatus(false);
      syncBuilderStrategyHeader();
      window.BuilderStorage?.refreshLibrary?.();
      showToast("Quick strategy generated");
    } catch (error) {
      quickValidationText.textContent = "Validation failed";
      showToast(`Quick strategy failed: ${error.message}`);
    }
  }

  if (generateBtn) {
    generateBtn.addEventListener("click", () => {
      if (typeof exportBuilderStrategyJson === "function") {
        const data = exportBuilderStrategyJson();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${(data.name || "strategy").replace(/\s+/g, "_")}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast("Strategy exported as JSON");
        return;
      }
      generateAndSaveStrategy();
    });
  }
  if (loadBtn) {
    loadBtn.addEventListener("click", () => {
      if (window.BuilderStorage?.openLoadModal) {
        window.BuilderStorage.openLoadModal();
        return;
      }
      loadCurrentStrategy();
    });
  }

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
    leftPanel?.classList.toggle("builder-left-panel--collapsed");
  });
  document.getElementById("builderLeftCollapseBtn")?.addEventListener("click", () => {
    leftPanel?.classList.toggle("builder-left-panel--collapsed");
  });
  document.getElementById("builderCollapseRightBtn")?.addEventListener("click", () => {
    controlPanel?.classList.toggle("builder-control-panel--collapsed");
  });
  document.getElementById("builderRightCollapseBtn")?.addEventListener("click", () => {
    controlPanel?.classList.toggle("builder-control-panel--collapsed");
  });
  document.getElementById("builderCleanBtn")?.addEventListener("click", () => {
    if (typeof cleanBuilderWorkspaceLayout === "function") cleanBuilderWorkspaceLayout();
  });
  snapToggleBtn?.addEventListener("click", () => {
    snapOn = !snapOn;
    if (typeof setBuilderSnapToGrid === "function") setBuilderSnapToGrid(snapOn);
    snapToggleBtn.setAttribute("title", `Snap to grid (${snapOn ? "on" : "off"})`);
    snapToggleBtn.classList.toggle("builder-icon-btn--active", snapOn);
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
  document.getElementById("builderAiToggleBtn")?.addEventListener("click", () => toggleAiDrawer());
  document.getElementById("builderAiCloseBtn")?.addEventListener("click", () => toggleAiDrawer(false));
  document.querySelectorAll("[data-ai-action]").forEach((btn) => {
    btn.addEventListener("click", () => runBuilderAiAction(btn.dataset.aiAction));
  });
  document.getElementById("builderHeaderRunBtn")?.addEventListener("click", () => runBtn?.click());
  document.getElementById("builderHeaderBacktestBtn")?.addEventListener("click", () => {
    showToast("Backtest opens from Strategies — advisory preview only on this screen");
  });
  document.getElementById("builderPauseBtn")?.addEventListener("click", () => {
    showToast("Pause follows hybrid cooldown when the bot is running");
  });
  document.getElementById("builderResetBotBtn")?.addEventListener("click", () => {
    document.getElementById("builderResetBtn")?.click();
  });
  document.getElementById("builderViewLogsBtn")?.addEventListener("click", () => {
    document.querySelector('.builder-run-tab[data-tab="logs"]')?.click();
  });
  document.querySelectorAll(".builder-library-group__toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const open = btn.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      const body = btn.nextElementSibling;
      body?.classList.toggle("hidden", !open);
      const chev = btn.querySelector(".builder-library-group__chev");
      if (chev) chev.textContent = open ? "⌄" : "›";
    });
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
  document.querySelectorAll("#builderCategoryList .builder-palette-cat").forEach((item) => {
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
      document
        .querySelectorAll("#builderCategoryList .builder-palette-cat")
        .forEach((row) => row.classList.remove("builder-palette-cat--active"));
      const key = item.dataset.category || "";
      if (!already) {
        item.classList.add("builder-palette-cat--active");
        if (typeof showBuilderCategory === "function") showBuilderCategory(key);
      } else if (typeof showBuilderCategory === "function") {
        showBuilderCategory("");
      }
      document.getElementById("builderBlockSearch").value = "";
    });
  });
  document.getElementById("builderBlockSearch")?.addEventListener("input", (e) => {
    document
      .querySelectorAll("#builderCategoryList .builder-palette-cat")
      .forEach((row) => row.classList.remove("builder-palette-cat--active"));
    if (typeof filterBuilderToolbox === "function") {
      filterBuilderToolbox(e.target.value || "");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      quickModal?.classList.add("hidden");
      searchReplaceModal?.classList.add("hidden");
      globalsModal?.classList.add("hidden");
      toggleAiDrawer(false);
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
  if (typeof initBuilderStorage === "function") initBuilderStorage();
  const builderStrategyParam = new URLSearchParams(window.location.search).get("strategy");
  if (builderStrategyParam && window.BuilderStorage?.loadSavedStrategy) {
    window.BuilderStorage.loadSavedStrategy(builderStrategyParam, false);
  }
  setBuilderSaveStatus(true);
  const editedTs = Number(localStorage.getItem("builder.last.edited") || 0);
  if (editedTs) {
    const el = document.getElementById("builderHeaderEdited");
    if (el) el.textContent = `Last edited ${new Date(editedTs).toLocaleString()}`;
  }
  refreshAuthState().then(() => updateBuilderConnectionPill());
  loadCurrentStrategy();
  refreshBuilderStatus();
  runFirstTimeTour();
  setInterval(refreshBuilderStatus, 1500);
  window.setInterval(() => {
    refreshAuthState().then(() => updateBuilderConnectionPill());
  }, 15000);
}

function setMatchesMobilePane(pane) {
  const nav = document.querySelector(".matches-pane-nav");
  const isLive = pane === "live";
  document.body.classList.toggle("matches-show-live", isLive);
  nav?.querySelectorAll("[data-matches-pane]").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.matchesPane === (isLive ? "live" : "trade"));
  });
  if (!isLive) window.scrollTo({ top: 0, behavior: "smooth" });
}

function initMatchesMobilePanes() {
  const nav = document.querySelector(".matches-pane-nav");
  if (!nav) return;

  const mq = window.matchMedia("(max-width: 1024px)");
  nav.querySelectorAll("[data-matches-pane]").forEach((btn) => {
    btn.addEventListener("click", () => setMatchesMobilePane(btn.dataset.matchesPane || "trade"));
  });

  const boot = () => {
    if (mq.matches) setMatchesMobilePane("trade");
    else document.body.classList.remove("matches-show-live");
  };
  boot();
  mq.addEventListener("change", boot);
}

function initMatchesPage() {
  const buyBtn = document.getElementById("matchesBuyBtn");
  if (!buyBtn) return;

  const barrierEl = document.getElementById("matchesBarrier");
  const stakeEl = document.getElementById("matchesStake");
  const durationEl = document.getElementById("matchesDurationTicks");
  const grid = document.getElementById("matchesDigitGrid");
  const tickerStripEl = document.getElementById("matchesTickerStrip");
  const tickerEl = document.getElementById("matchesTicker");
  const previewEl = document.getElementById("matchesTickPreview");
  const lastContractEl = document.getElementById("matchesLastContract");
  const livePriceEl = document.getElementById("matchesLivePrice");
  const liveDigitEl = document.getElementById("matchesLiveDigit");
  const priceArrowEl = document.getElementById("matchesPriceArrow");
  const pricePctEl = document.getElementById("matchesPricePct");
  const digitArrowEl = document.getElementById("matchesDigitArrow");
  const payoutEl = document.getElementById("matchesQuotePayout");
  const askEl = document.getElementById("matchesQuoteAsk");
  const accountStateEl = document.getElementById("matchesAccountState");
  const pnlEl = document.getElementById("matchesSessionPnl");
  const winRateEl = document.getElementById("matchesWinRate");
  const streakEl = document.getElementById("matchesStreak");
  const oppTitleEl = document.getElementById("matchesOpportunityTitle");
  const oppTextEl = document.getElementById("matchesOpportunityText");
  const oppBannerEl = document.getElementById("matchesOpportunityBanner");
  const signalLabelEl = document.getElementById("matchesSignalLabel");
  const signalDetailEl = document.getElementById("matchesSignalDetail");
  const signalFillEl = document.getElementById("matchesSignalMeterFill");
  const riskLevelEl = document.getElementById("matchesRiskLevel");
  const confidenceEl = document.getElementById("matchesConfidence");
  const expectedEdgeEl = document.getElementById("matchesExpectedEdge");
  const selectedDigitEl = document.getElementById("matchesSelectedDigit");

  let submitting = false;
  let matchesLoggedIn = false;
  const digitRoll = [];
  const lastDigitTrendGlyph = Array.from({ length: 10 }, () => null);
  const matchesDigitPointer = document.getElementById("matchesDigitPointer");
  let matchesTickState = {
    prevPrice: null,
    prevDigit: null,
    priceArrowEl,
    digitArrowEl,
    liveDigitEl: liveDigitEl,
    grid,
    pointerEl: matchesDigitPointer,
  };
  let matchesPollFresh = true;
  let prevPollDigit = null;
  const digitPctSample = 120;
  const BUY_COOLDOWN_AFTER_OK_MS = 2200;
  let buyCooldownUntil = 0;
  let lastMarketData = {};
  let lastQuoteSnapshot = null;
  let matchesContractWatch = null;
  let matchesContractLastPrice = null;

  const contractTrailEl = document.getElementById("matchesContractTrail");
  const activeContractPanelEl = document.getElementById("matchesActiveContractPanel");
  const contractTrailStripEl = document.getElementById("matchesContractTrailStrip");
  const contractTrailStatusEl = document.getElementById("matchesContractTrailStatus");
  const contractTrailNoteEl = document.getElementById("matchesContractTrailNote");
  let coachHotDigit = null;
  let coachColdDigit = null;
  let coachRisingDigit = null;
  let coachRisingDigitSecond = null;
  let marketCooldownUntil = 0;
  let quoteCooldownUntil = 0;
  let lastAiOpportunity = { confidence: 0, underDigit: null, underPct: null };

  function parseRetryAfterMs(text, fallbackMs = 30000) {
    const msg = String(text || "");
    const m = msg.match(/retry[_ -]?after[=:\s]+(\d+)/i);
    if (!m) return fallbackMs;
    const sec = Number(m[1]);
    if (!Number.isFinite(sec) || sec <= 0) return fallbackMs;
    return Math.min(sec * 1000, 120000);
  }

  function syncBuyButtonState() {
    if (!buyBtn) return;
    const cooling = Date.now() < buyCooldownUntil;
    buyBtn.disabled = !matchesLoggedIn || submitting || cooling;
    const hint = document.getElementById("matchesBuyCooldown");
    const apiWarn = document.getElementById("matchesApiWarning");
    if (apiWarn) {
      apiWarn.classList.toggle("hidden", matchesLoggedIn);
    }
    if (hint) {
      if (cooling && matchesLoggedIn) {
        hint.classList.remove("hidden");
        hint.textContent = `Next buy in ${Math.ceil((buyCooldownUntil - Date.now()) / 1000)}s (avoids double orders).`;
      } else {
        hint.classList.add("hidden");
        hint.textContent = "";
      }
    }
  }

  function syncSummaryStake() {
    const stakeSummaryEl = document.getElementById("matchesSummaryStake");
    if (!stakeSummaryEl || !stakeEl) return;
    const stake = Number(stakeEl.value ?? 0);
    stakeSummaryEl.textContent = stake > 0 ? `$${stake.toFixed(2)}` : "Enter stake";
  }

  function markTradeSummaryQuotePending() {
    if (payoutEl) payoutEl.textContent = "Updating…";
    const profitSummaryEl = document.getElementById("matchesSummaryProfit");
    if (profitSummaryEl) {
      profitSummaryEl.textContent = "Updating…";
      profitSummaryEl.classList.remove("matches-pos", "matches-neg");
    }
    syncMatchesExecBar();
  }

  function syncTradeSummary() {
    syncSummaryStake();
    const ticksEl = document.getElementById("matchesSummaryTicks");
    const barrierUi = document.getElementById("matchesSummaryBarrier");
    const tickCount = Math.max(1, Math.min(10, Math.floor(Number(durationEl?.value) || 5)));
    if (durationEl) durationEl.value = String(tickCount);
    if (ticksEl) ticksEl.textContent = `${tickCount} tick${tickCount === 1 ? "" : "s"}`;
    if (barrierUi && barrierEl) barrierUi.textContent = String(barrierEl.value ?? "0");
    syncMatchesExecBar();
  }

  function syncDurationPills() {
    if (!durationEl) return;
    const val = String(
      Math.max(1, Math.min(10, Math.floor(Number(durationEl.value) || 5)))
    );
    document.querySelectorAll(".terminal-tick-pill").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.ticks === val);
    });
    syncTradeSummary();
  }

  function syncMatchesExecBar() {
    const execBarrier = document.getElementById("matchesExecBarrier");
    const execTicks = document.getElementById("matchesExecTicks");
    const execStake = document.getElementById("matchesExecStake");
    const execPayout = document.getElementById("matchesExecPayout");
    const execProfit = document.getElementById("matchesExecProfit");
    if (barrierEl && execBarrier) execBarrier.textContent = String(barrierEl.value ?? "0");
    if (durationEl && execTicks) {
      execTicks.textContent = String(
        Math.max(1, Math.min(10, Math.floor(Number(durationEl.value) || 5)))
      );
    }
    if (stakeEl && execStake) {
      const stakeVal = Number(stakeEl.value ?? 0);
      execStake.textContent = stakeVal > 0 ? `${stakeVal.toFixed(2)} USD` : "--";
    }
    if (payoutEl && execPayout) execPayout.textContent = payoutEl.textContent || "--";
    const profitSummaryEl = document.getElementById("matchesSummaryProfit");
    if (execProfit) {
      if (profitSummaryEl) {
        execProfit.textContent = profitSummaryEl.textContent || "--";
        execProfit.classList.toggle("matches-pos", profitSummaryEl.classList.contains("matches-pos"));
        execProfit.classList.toggle("matches-neg", profitSummaryEl.classList.contains("matches-neg"));
      } else if (lastQuoteSnapshot && Number.isFinite(lastQuoteSnapshot.profit)) {
        const profitVal = lastQuoteSnapshot.profit;
        execProfit.textContent = `${profitVal >= 0 ? "+" : ""}${profitVal.toFixed(2)} USD`;
        execProfit.classList.toggle("matches-pos", profitVal > 0);
        execProfit.classList.toggle("matches-neg", profitVal < 0);
      } else {
        execProfit.textContent = "--";
        execProfit.classList.remove("matches-pos", "matches-neg");
      }
    }
  }

  function extractLastDigit(value) {
    return extractLastDigitFromPrice(value);
  }

  function syncDigitHighlight() {
    const d = String(barrierEl?.value ?? "0");
    if (selectedDigitEl) selectedDigitEl.textContent = d;
    const headDigitEl = document.getElementById("matchesSelectedDigitHead");
    if (headDigitEl) headDigitEl.textContent = d;
    if (grid) {
      grid.querySelectorAll(".digit-cell").forEach((cell) => {
        cell.classList.toggle("digit-cell--active", cell.dataset.digit === d);
      });
    }
    document.querySelectorAll(".matches-barrier-pick-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.digit === d);
    });
    syncTradeSummary();
    markTradeSummaryQuotePending();
  }

  function showActiveContractPanel() {
    activeContractPanelEl?.classList.remove("hidden");
  }

  function hideActiveContractPanel() {
    activeContractPanelEl?.classList.add("hidden");
  }

  function setActiveContractStatus(status) {
    const statusEl = document.getElementById("matchesActiveStatus");
    if (!statusEl) return;
    const labels = {
      waiting: "Waiting",
      live: "Live",
      won: "Won",
      lost: "Lost",
      settled: "Settled",
    };
    statusEl.textContent = labels[status] || "Waiting";
    statusEl.className = "matches-active-status";
    statusEl.classList.add(`matches-active-status--${status}`);
  }

  function renderActiveContractPanel() {
    const w = matchesContractWatch;
    if (!w) return;
    const idEl = document.getElementById("matchesActiveContractId");
    const typeEl = document.getElementById("matchesActiveContractType");
    const barrierElUi = document.getElementById("matchesActiveBarrier");
    const stakeUi = document.getElementById("matchesActiveStake");
    const entryEl = document.getElementById("matchesActiveEntryPrice");
    const currentTickEl = document.getElementById("matchesActiveCurrentTick");
    const remainingEl = document.getElementById("matchesActiveRemainingTicks");
    const payoutUi = document.getElementById("matchesActivePayout");

    const tickCount = w.ticks?.length ?? 0;
    const remaining = Math.max(0, w.duration - tickCount);

    if (idEl) idEl.textContent = w.contractId || "—";
    if (typeEl) typeEl.textContent = w.contractType || "Digit Match";
    if (barrierElUi) barrierElUi.textContent = String(w.barrier ?? "—");
    if (stakeUi) {
      stakeUi.textContent =
        w.stake != null && Number.isFinite(Number(w.stake)) ? `$${Number(w.stake).toFixed(2)}` : "—";
    }
    if (entryEl) {
      entryEl.textContent =
        w.entryPrice != null && Number.isFinite(Number(w.entryPrice))
          ? Number(w.entryPrice).toFixed(3)
          : "—";
    }
    if (currentTickEl) currentTickEl.textContent = String(w.finalized ? Math.min(tickCount, w.duration) : tickCount);
    if (remainingEl) remainingEl.textContent = w.finalized ? "0" : String(remaining);
    if (payoutUi) {
      payoutUi.textContent =
        w.payout != null && Number.isFinite(Number(w.payout)) ? `$${Number(w.payout).toFixed(2)}` : "—";
    }

    let status = w.status || "waiting";
    if (!w.finalized && tickCount > 0 && status === "waiting") status = "live";
    if (w.finalized && w.won === true) status = w.status === "settled" ? "settled" : "won";
    if (w.finalized && w.won === false) status = w.status === "settled" ? "settled" : "lost";
    setActiveContractStatus(status);
  }

  function beginMatchesContractWatch(barrier, durationTicks, meta = {}) {
    matchesContractWatch = {
      barrier: Number(barrier),
      duration: Math.max(1, Math.min(10, Math.floor(Number(durationTicks) || 1))),
      ticks: [],
      watching: true,
      finalized: false,
      won: null,
      status: "waiting",
      contractId: meta.contractId || `M${Date.now().toString(36).toUpperCase()}`,
      contractType: meta.contractType || "Digit Match",
      stake: meta.stake ?? null,
      payout: meta.payout ?? null,
      entryPrice: null,
      settledTimerId: null,
      fastPollId: window.setInterval(() => {
        matchesPollFresh = true;
        void pollMarket();
      }, 400),
    };
    matchesContractLastPrice = null;
    showActiveContractPanel();
    renderActiveContractPanel();
    renderMatchesContractTrail();
    setContractTrailStatus("WAITING — contract opening…", "live");
    if (contractTrailNoteEl) {
      contractTrailNoteEl.textContent = `Barrier ${barrier} · expiry on tick ${matchesContractWatch.duration} · ▼ shows latest market digit`;
    }
    if (window.matchMedia("(max-width: 1024px)").matches) {
      setMatchesMobilePane("live");
    }
    grid?.querySelectorAll(".digit-cell").forEach((c) => {
      c.classList.remove("digit-cell--contract-flash", "digit-cell--contract-expiry");
    });
  }

  function setContractTrailStatus(text, tone) {
    if (!contractTrailStatusEl) return;
    contractTrailStatusEl.textContent = text;
    contractTrailStatusEl.classList.remove(
      "matches-contract-trail__status--live",
      "matches-contract-trail__status--win",
      "matches-contract-trail__status--lose",
    );
    if (tone === "win") contractTrailStatusEl.classList.add("matches-contract-trail__status--win");
    else if (tone === "lose") contractTrailStatusEl.classList.add("matches-contract-trail__status--lose");
    else contractTrailStatusEl.classList.add("matches-contract-trail__status--live");
  }

  function flashContractDigitOnGrid(digit, isExpiry) {
    if (!grid || digit == null) return;
    const cell = grid.querySelector(`.digit-cell[data-digit="${digit}"]`);
    if (!cell) return;
    cell.classList.remove("digit-cell--contract-flash", "digit-cell--contract-expiry");
    void cell.offsetWidth;
    cell.classList.add("digit-cell--contract-flash");
    if (isExpiry) cell.classList.add("digit-cell--contract-expiry");
  }

  function renderMatchesContractTrail() {
    if (!contractTrailStripEl || !matchesContractWatch) return;
    const { barrier, duration, ticks, finalized, won } = matchesContractWatch;
    contractTrailStripEl.innerHTML = "";
    for (let i = 0; i < duration; i += 1) {
      const tick = ticks[i];
      const slot = document.createElement("div");
      slot.className = "matches-contract-tick";
      const idx = document.createElement("span");
      idx.className = "matches-contract-tick__idx";
      idx.textContent = i + 1 === duration ? `${i + 1} exp` : String(i + 1);
      const digitEl = document.createElement("span");
      digitEl.className = "matches-contract-tick__digit";
      if (tick == null) {
        slot.classList.add("matches-contract-tick--pending");
        digitEl.textContent = "·";
      } else {
        const hit = tick.digit === barrier;
        digitEl.textContent = String(tick.digit);
        slot.classList.add(hit ? "matches-contract-tick--hit" : "matches-contract-tick--miss");
        if (i + 1 === duration) slot.classList.add("matches-contract-tick--expiry");
        if (i === ticks.length - 1 && !finalized) slot.classList.add("matches-contract-tick--flash");
      }
      slot.appendChild(idx);
      slot.appendChild(digitEl);
      contractTrailStripEl.appendChild(slot);
    }
    const progressFill = document.getElementById("matchesContractProgressFill");
    const progressLabel = document.getElementById("matchesContractProgressLabel");
    if (progressFill) {
      const pct = duration > 0 ? Math.min(100, (ticks.length / duration) * 100) : 0;
      progressFill.style.width = finalized ? "100%" : `${pct}%`;
    }
    if (progressLabel) {
      progressLabel.textContent = finalized
        ? `${duration} / ${duration}`
        : `${Math.min(ticks.length, duration)} / ${duration}`;
    }
    renderActiveContractPanel();
    if (previewEl && ticks.length) {
      const last = ticks[ticks.length - 1];
      const pending = !finalized && ticks.length < duration;
      previewEl.textContent = pending
        ? `Tick ${ticks.length}/${duration}: digit ${last.digit} ${last.digit === barrier ? "= barrier (preview)" : "≠ barrier (preview)"}`
        : finalized
          ? `Settled: expiry digit ${ticks[Math.min(duration, ticks.length) - 1]?.digit ?? "—"} · barrier ${barrier} · ${won ? "WIN" : "LOSE"}`
          : previewEl.textContent;
    }
  }

  function recordMatchesContractTick(price) {
    if (!matchesContractWatch?.watching || matchesContractWatch.finalized) return;
    const p = Number(price);
    if (!Number.isFinite(p)) return;
    if (matchesContractLastPrice != null && p === matchesContractLastPrice) return;
    matchesContractLastPrice = p;
    const digit = extractLastDigitFromPrice(p);
    if (digit == null || digit < 0 || digit > 9) return;
    const w = matchesContractWatch;
    if (w.ticks.length >= w.duration) return;
    w.ticks.push({ digit, at: Date.now(), price: p });
    if (w.entryPrice == null) w.entryPrice = p;
    if (!w.finalized && w.status === "waiting") w.status = "live";
    const tickNum = w.ticks.length;
    const isExpirySlot = tickNum >= w.duration;
    renderMatchesContractTrail();
    flashContractDigitOnGrid(digit, isExpirySlot);
    if (matchesDigitPointer) moveDigitPointerToCell(grid, matchesDigitPointer, digit);
    if (contractTrailNoteEl) {
      const hit = digit === w.barrier;
      contractTrailNoteEl.textContent = `Tick ${Math.min(tickNum, w.duration)}: last digit ${digit} ${hit ? "matches" : "≠"} barrier ${w.barrier}${isExpirySlot ? " (expiry)" : ""}`;
    }
    setContractTrailStatus(`LIVE · tick ${Math.min(tickNum, w.duration)}/${w.duration} → ${digit}`, "live");
  }

  function showMatchesOutcomeFlash({ won, profit, stake }) {
    const layer = document.getElementById("matchesOutcomeLayer");
    if (!layer) return;
    const isWin = !!won;
    const stakeVal = Math.abs(Number(stake) || 0);
    const profitVal = Math.abs(Number(profit) || 0);
    const amountText = isWin
      ? `+$${profitVal.toFixed(2)}`
      : `-$${stakeVal.toFixed(2)}`;

    const card = document.createElement("div");
    card.className = `matches-outcome-flash matches-outcome-flash--${isWin ? "win" : "loss"}`;
    card.innerHTML = `
      <div class="matches-outcome-flash__burst" aria-hidden="true"></div>
      <div class="matches-outcome-flash__inner">
        <span class="matches-outcome-flash__label">${isWin ? "WIN" : "LOSS"}</span>
        <strong class="matches-outcome-flash__amount">${escapeHtml(amountText)}</strong>
      </div>
    `;
    layer.appendChild(card);

    while (layer.children.length > 2) {
      layer.firstChild?.remove();
    }

    requestAnimationFrame(() => {
      card.classList.add("is-visible");
    });

    const dismiss = () => {
      if (!card.isConnected) return;
      card.classList.add("is-exiting");
      window.setTimeout(() => {
        try {
          card.remove();
        } catch (_e) {
          /* ignore */
        }
      }, 520);
    };
    window.setTimeout(dismiss, isWin ? 2800 : 2600);
  }

  function finalizeMatchesContractWatch(won) {
    if (!matchesContractWatch) return;
    const w = matchesContractWatch;
    if (w.fastPollId) {
      window.clearInterval(w.fastPollId);
      w.fastPollId = null;
    }
    w.watching = false;
    w.finalized = true;
    w.won = !!won;
    w.status = won ? "won" : "lost";
    const expiryIdx = Math.max(0, w.duration - 1);
    const expiryTick = w.ticks[expiryIdx] ?? w.ticks[w.ticks.length - 1];
    if (expiryTick) flashContractDigitOnGrid(expiryTick.digit, true);
    renderMatchesContractTrail();
    renderActiveContractPanel();
    setContractTrailStatus(won ? "WIN — contract settled" : "LOSE — contract settled", won ? "win" : "lose");
    if (contractTrailNoteEl && expiryTick) {
      const hit = expiryTick.digit === w.barrier;
      contractTrailNoteEl.textContent = `Expiry digit ${expiryTick.digit} ${hit ? "matched" : "≠"} barrier ${w.barrier} · Deriv: ${won ? "WIN" : "LOSE"}`;
    }
    if (lastContractEl && expiryTick) {
      lastContractEl.textContent = `${won ? "WIN" : "LOSE"} · expiry digit ${expiryTick.digit} · barrier ${w.barrier}`;
    }
    const profitDelta =
      w.profitDelta != null && Number.isFinite(Number(w.profitDelta))
        ? Number(w.profitDelta)
        : w.payout != null && w.stake != null
          ? Number(w.payout) - Number(w.stake)
          : 0;
    showMatchesOutcomeFlash({ won: !!won, profit: profitDelta, stake: w.stake });
    if (w.settledTimerId) window.clearTimeout(w.settledTimerId);
    w.settledTimerId = window.setTimeout(() => {
      if (matchesContractWatch === w && w.finalized) {
        w.status = "settled";
        renderActiveContractPanel();
      }
    }, 4000);
  }

  function computeStreak(rows) {
    let win = 0;
    let loss = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = String(rows[i]?.result || "").toLowerCase();
      if (r === "win") {
        if (loss > 0) break;
        win += 1;
      } else if (r === "loss") {
        if (win > 0) break;
        loss += 1;
      }
    }
    if (win > 0) return `W${win}`;
    if (loss > 0) return `L${loss}`;
    return "Flat";
  }

  function formatUsd(value, { signed = false, emptyLabel = "None yet" } = {}) {
    if (value == null || !Number.isFinite(Number(value))) return emptyLabel;
    const n = Number(value);
    if (signed) {
      return `${n >= 0 ? "+" : ""}$${Math.abs(n).toFixed(2)}`;
    }
    return `$${n.toFixed(2)}`;
  }

  function updatePerformance(status, rows) {
    const matchRows = (rows || []).filter((r) => String(r.contract_type || "").toUpperCase() === "DIGITMATCH");
    const wins = matchRows.filter((r) => String(r.result || "").toLowerCase() === "win").length;
    const losses = matchRows.filter((r) => String(r.result || "").toLowerCase() === "loss").length;
    const total = matchRows.length;
    const hasPnl = status && Number.isFinite(Number(status?.profit));
    const pnl = hasPnl ? Number(status.profit) : 0;

    if (pnlEl) {
      pnlEl.textContent = `${pnl >= 0 ? "+" : ""}$${Math.abs(pnl).toFixed(2)}`;
      pnlEl.classList.toggle("matches-pos", pnl > 0);
      pnlEl.classList.toggle("matches-neg", pnl < 0);
    }

    if (winRateEl) {
      winRateEl.textContent = total > 0 ? `${((wins / total) * 100).toFixed(1)}%` : "0.0%";
    }

    if (streakEl) {
      const streak = computeStreak(matchRows);
      streakEl.textContent = streak;
      streakEl.classList.toggle("matches-pos", /^W\d+/.test(streak));
      streakEl.classList.toggle("matches-neg", /^L\d+/.test(streak));
    }

    const totalTradesEl = document.getElementById("matchesTotalTrades");
    if (totalTradesEl) totalTradesEl.textContent = String(total);

    const winsEl = document.getElementById("matchesWinningTrades");
    if (winsEl) winsEl.textContent = String(wins);

    const lossesEl = document.getElementById("matchesLosingTrades");
    if (lossesEl) lossesEl.textContent = String(losses);

    const winBar = document.getElementById("matchesWinLossBarWin");
    const lossBar = document.getElementById("matchesWinLossBarLoss");
    if (winBar && lossBar) {
      const winPct = total > 0 ? (wins / total) * 100 : 0;
      const lossPct = total > 0 ? (losses / total) * 100 : 0;
      winBar.style.width = `${winPct}%`;
      lossBar.style.width = `${lossPct}%`;
    }

    const roiEl = document.getElementById("matchesSessionRoi");
    if (roiEl) {
      const totalStaked = matchRows.reduce((sum, r) => sum + Math.abs(Number(r.stake ?? 0)), 0);
      if (totalStaked > 0 && hasPnl) {
        const roi = (pnl / totalStaked) * 100;
        roiEl.textContent = `${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`;
        roiEl.classList.toggle("matches-pos", roi > 0);
        roiEl.classList.toggle("matches-neg", roi < 0);
      } else {
        roiEl.textContent = "0.0%";
        roiEl.classList.remove("matches-pos", "matches-neg");
      }
    }

    const profits = matchRows
      .map((r) => Number(r.profit ?? NaN))
      .filter((p) => Number.isFinite(p));
    const winProfits = profits.filter((p) => p > 0);
    const lossProfits = profits.filter((p) => p < 0);
    const largestWin = winProfits.length ? Math.max(...winProfits) : null;
    const largestLoss = lossProfits.length ? Math.min(...lossProfits) : null;

    const largestWinEl = document.getElementById("matchesLargestWin");
    if (largestWinEl) {
      largestWinEl.textContent = largestWin != null ? formatUsd(largestWin, { signed: true }) : "None yet";
      largestWinEl.classList.toggle("matches-pos", largestWin != null);
      largestWinEl.classList.remove("matches-neg");
    }

    const largestLossEl = document.getElementById("matchesLargestLoss");
    if (largestLossEl) {
      largestLossEl.textContent = largestLoss != null ? formatUsd(largestLoss, { signed: true }) : "None yet";
      largestLossEl.classList.toggle("matches-neg", largestLoss != null);
      largestLossEl.classList.remove("matches-pos");
    }

    const balanceEl = document.getElementById("matchesSessionBalance");
    if (balanceEl) {
      const effectiveBal = resolveEffectiveBalance(status);
      balanceEl.textContent = `$${effectiveBal.toFixed(2)}`;
    }

    const badgeEl = document.getElementById("matchesSessionBadge");
    if (badgeEl) {
      if (total === 0) {
        badgeEl.textContent = "No trades";
        badgeEl.className = "session-perf-badge session-perf-badge--idle";
      } else if (pnl > 0) {
        badgeEl.textContent = "In profit";
        badgeEl.className = "session-perf-badge session-perf-badge--profit";
      } else if (pnl < 0) {
        badgeEl.textContent = "In drawdown";
        badgeEl.className = "session-perf-badge session-perf-badge--loss";
      } else {
        badgeEl.textContent = "Break even";
        badgeEl.className = "session-perf-badge session-perf-badge--flat";
      }
    }
  }

  function syncAiOpportunityAdvisory(confidence, underDigit, underPct) {
    const tierEl = document.getElementById("matchesAiConfidenceTier");
    const scoreEl = document.getElementById("matchesAiConfidenceScore");
    const recEl = document.getElementById("matchesAiRecommendedContract");
    const stakeElUi = document.getElementById("matchesAiSuggestedStake");
    const baseStake = Number(stakeEl?.value ?? 1);

    let tier = "scan";
    let tierLabel = "Scanning";
    if (confidence >= 75) {
      tier = "high";
      tierLabel = "High confidence";
    } else if (confidence >= 55) {
      tier = "medium";
      tierLabel = "Medium confidence";
    } else if (confidence >= 35) {
      tier = "low";
      tierLabel = "Low confidence";
    } else if (Number.isFinite(confidence) && confidence > 0) {
      tier = "low";
      tierLabel = "Low confidence";
    }

    if (tierEl) {
      tierEl.textContent = tierLabel;
      tierEl.className = "matches-ai-tier";
      tierEl.classList.add(`matches-ai-tier--${tier}`);
    }
    if (scoreEl) {
      scoreEl.textContent = Number.isFinite(confidence) && confidence > 0 ? `${confidence}%` : "--";
      scoreEl.classList.toggle("matches-ai-opp-score__value--high", confidence >= 75);
      scoreEl.classList.toggle("matches-ai-opp-score__value--medium", confidence >= 55 && confidence < 75);
      scoreEl.classList.toggle("matches-ai-opp-score__value--low", confidence > 0 && confidence < 55);
    }
    if (recEl) {
      recEl.textContent =
        underDigit != null && underDigit >= 0 && underDigit <= 9
          ? `Digit Match · barrier ${underDigit}`
          : "—";
    }
    if (stakeElUi) {
      if (!Number.isFinite(confidence) || confidence < 35) {
        stakeElUi.textContent = "Observe — no suggested stake";
      } else if (confidence >= 75) {
        stakeElUi.textContent = `Standard · $${baseStake.toFixed(2)} USD`;
      } else if (confidence >= 55) {
        stakeElUi.textContent = `Moderate · $${Math.max(0.35, baseStake * 0.75).toFixed(2)} USD`;
      } else {
        stakeElUi.textContent = `Light · $${Math.max(0.35, baseStake * 0.5).toFixed(2)} USD`;
      }
    }
  }

  function updateOpportunityAndSignal(points) {
    const sample = (points || []).slice(-120);
    const counts = Array.from({ length: 10 }, () => 0);
    sample.forEach((p) => {
      const d = extractLastDigit(p?.price);
      if (d != null && d >= 0 && d <= 9) counts[d] += 1;
    });
    const n = counts.reduce((a, b) => a + b, 0);
    if (n < 30) {
      if (oppTitleEl) oppTitleEl.textContent = "Scanning for imbalance...";
      if (oppTextEl) oppTextEl.textContent = "Need more ticks before ranking opportunities.";
      if (signalLabelEl) signalLabelEl.textContent = "NO EDGE";
      if (signalDetailEl) signalDetailEl.textContent = "Collecting samples...";
      if (signalFillEl) signalFillEl.style.width = "6%";
      if (confidenceEl) confidenceEl.textContent = "Collecting…";
      const confBadgeEl = document.getElementById("matchesConfidenceBadge");
      if (confBadgeEl) {
        confBadgeEl.textContent = "--";
        confBadgeEl.classList.remove("is-strong");
      }
      if (riskLevelEl) riskLevelEl.textContent = "MEDIUM";
      if (expectedEdgeEl) expectedEdgeEl.textContent = "—";
      const underEl = document.getElementById("matchesUnderDigit");
      const overEl = document.getElementById("matchesOverDigit");
      if (underEl) underEl.textContent = "--";
      if (overEl) overEl.textContent = "--";
      oppBannerEl?.classList.remove("matches-opportunity--hot");
      lastAiOpportunity = { confidence: 0, underDigit: null, underPct: null };
      syncAiOpportunityAdvisory(0, null, null);
      return;
    }
    const expected = n / 10;
    const zScores = counts.map((c) => (c - expected) / Math.sqrt(Math.max(expected * 0.9, 1e-9)));
    let underDigit = 0;
    let overDigit = 0;
    for (let i = 1; i < 10; i += 1) {
      if (zScores[i] < zScores[underDigit]) underDigit = i;
      if (zScores[i] > zScores[overDigit]) overDigit = i;
    }
    const selected = Number(barrierEl?.value ?? 0);
    const selectedPct = ((counts[selected] / n) * 100).toFixed(1);
    const underPct = ((counts[underDigit] / n) * 100).toFixed(1);
    const strengthRaw = Math.max(0, -zScores[underDigit]);
    const confidence = Math.min(95, Math.round((strengthRaw / 2.5) * 100));
    const label =
      confidence >= 75 ? "STRONG BUY MATCH" : confidence >= 55 ? "MODERATE BUY MATCH" : confidence >= 35 ? "WEAK EDGE" : "NO EDGE";
    if (oppTitleEl) oppTitleEl.textContent = `Opportunity: digit ${underDigit} underrepresented (${underPct}%)`;
    if (oppTextEl) {
      oppTextEl.textContent = `Suggested focus: MATCH ${underDigit}. Selected ${selected} appears ${selectedPct}% vs expected 10.0%.`;
    }
    const underEl = document.getElementById("matchesUnderDigit");
    const overEl = document.getElementById("matchesOverDigit");
    if (underEl) underEl.textContent = String(underDigit);
    if (overEl) overEl.textContent = String(overDigit);
    if (signalLabelEl) signalLabelEl.textContent = label;
    if (signalDetailEl) signalDetailEl.textContent = `Confidence ${confidence}% · z=${zScores[underDigit].toFixed(2)} · sample ${n} ticks`;
    if (signalFillEl) signalFillEl.style.width = `${Math.max(8, confidence)}%`;
    if (confidenceEl) confidenceEl.textContent = `${confidence}%`;
    const confBadgeEl = document.getElementById("matchesConfidenceBadge");
    if (confBadgeEl) {
      confBadgeEl.textContent = `${confidence}%`;
      confBadgeEl.classList.toggle("is-strong", confidence >= 55);
    }
    syncAiOpportunityAdvisory(confidence, underDigit, underPct);
    if (expectedEdgeEl) expectedEdgeEl.textContent = `${(10 - Number(selectedPct)).toFixed(1)}% vs fair`;
    if (riskLevelEl) {
      riskLevelEl.textContent = confidence >= 75 ? "LOW" : confidence >= 50 ? "MEDIUM" : "HIGH";
      riskLevelEl.classList.toggle("matches-pos", confidence >= 75);
      riskLevelEl.classList.toggle("matches-neg", confidence < 50);
    }
    oppBannerEl?.classList.toggle("matches-opportunity--hot", confidence >= 55);
    lastAiOpportunity = { confidence, underDigit, underPct };
    syncTradeSummary();
  }

  function seedDigitRollFromPoints(points, maxLen = 48) {
    const digits = (points || [])
      .map((p) => extractLastDigitFromPrice(p?.price))
      .filter((d) => d != null && d >= 0 && d <= 9);
    if (!digits.length) return;
    const tail = digits.slice(-maxLen);
    const unchanged =
      digitRoll.length === tail.length && digitRoll.every((d, i) => d === tail[i]);
    if (unchanged) return;
    digitRoll.length = 0;
    tail.forEach((d) => digitRoll.push(d));
    renderTickerStrip();
  }

  function renderTickerStrip() {
    if (!tickerStripEl) return;
    tickerStripEl.innerHTML = "";
    const slice = digitRoll.slice(-36);
    if (!slice.length) {
      const ph = document.createElement("span");
      ph.className = "matches-ticker-empty subtle small";
      ph.textContent = "Waiting for ticks…";
      tickerStripEl.appendChild(ph);
      return;
    }
    slice.forEach((d, idx) => {
      const span = document.createElement("span");
      span.className = "matches-ticker-digit";
      span.classList.add(`matches-ticker-digit--d${d}`);
      span.textContent = String(d);
      if (idx === slice.length - 1) {
        span.classList.add("matches-ticker-digit--head", "matches-ticker-digit--flash");
      }
      tickerStripEl.appendChild(span);
    });
    if (tickerEl) tickerEl.scrollLeft = tickerEl.scrollWidth;
  }

  function lastDigitFromMarketData(data) {
    const pts = data?.points || [];
    if (!pts.length) return null;
    return extractLastDigit(pts[pts.length - 1]?.price);
  }

  function getMatchesRisingRankChoice() {
    const r = document.querySelector('input[name="matchesRisingRank"]:checked');
    return r && r.value === "2" ? 2 : 1;
  }

  function getActiveRisingDigit() {
    return getMatchesRisingRankChoice() === 2 ? coachRisingDigitSecond : coachRisingDigit;
  }

  function syncCoachActionButtons() {
    const applyHot = document.getElementById("matchesApplyHotBtn");
    const applyCold = document.getElementById("matchesApplyColdBtn");
    const applyRising = document.getElementById("matchesApplyRisingBtn");
    const applyLast = document.getElementById("matchesApplyLastDigitBtn");
    if (applyHot) applyHot.disabled = coachHotDigit == null;
    if (applyCold) applyCold.disabled = coachColdDigit == null;
    if (applyRising) {
      const pick = getActiveRisingDigit();
      applyRising.disabled = pick == null;
      const rank = getMatchesRisingRankChoice();
      applyRising.textContent = rank === 2 ? "Use 2nd rising digit" : "Use 1st rising digit";
    }
    if (applyLast) applyLast.disabled = prevPollDigit == null;
  }

  function applyCoachDigit(d) {
    if (d == null || d < 0 || d > 9 || !barrierEl) return;
    barrierEl.value = String(d);
    syncDigitHighlight();
    setMatchesMobilePane("trade");
    void refreshQuote();
  }

  function renderPossibleEntryPoints() {
    const wraps = [
      document.getElementById("matchesCoachEntries"),
      document.getElementById("matchesCoachEntriesQuick"),
    ].filter(Boolean);
    if (!wraps.length) return;
    const map = new Map();
    function addTag(digit, tag) {
      if (digit == null || digit < 0 || digit > 9) return;
      if (!map.has(digit)) map.set(digit, []);
      const arr = map.get(digit);
      if (!arr.includes(tag)) arr.push(tag);
    }
    addTag(coachHotDigit, "Hottest");
    addTag(coachColdDigit, "Coldest");
    addTag(coachRisingDigit, "1st↑");
    addTag(coachRisingDigitSecond, "2nd↑");
    addTag(prevPollDigit, "Last tick");

    const order = [
      coachRisingDigit,
      coachRisingDigitSecond,
      coachHotDigit,
      coachColdDigit,
      prevPollDigit,
    ].filter((d) => d != null && d >= 0 && d <= 9);
    const orderedDigits = [...new Set(order)];
    const rest = [...map.keys()].filter((d) => !orderedDigits.includes(d));
    const finalOrder = [...orderedDigits, ...rest.sort((a, b) => a - b)];

    const emptyMsg = '<span class="subtle small">Need live ticks to suggest entry digits.</span>';
    if (finalOrder.length === 0) {
      wraps.forEach((w) => {
        w.innerHTML = emptyMsg;
      });
      return;
    }

    wraps.forEach((wrap) => {
      wrap.innerHTML = "";
      finalOrder.forEach((digit) => {
      const tags = map.get(digit) || [];
      const chip = document.createElement("div");
      chip.className = "matches-entry-chip";
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.setAttribute("aria-label", `Set barrier to ${digit}: ${tags.join(", ")}`);
      if (digit === coachHotDigit) chip.classList.add("matches-entry-chip--hot");
      else if (digit === coachColdDigit) chip.classList.add("matches-entry-chip--cold");
      if (digit === coachRisingDigit || digit === coachRisingDigitSecond) chip.classList.add("matches-entry-chip--rising");
      const dEl = document.createElement("span");
      dEl.className = "matches-entry-chip-digit";
      dEl.textContent = String(digit);
      const tEl = document.createElement("span");
      tEl.className = "matches-entry-chip-tags";
      tEl.textContent = tags.join(" · ");
      chip.appendChild(dEl);
      chip.appendChild(tEl);
      chip.addEventListener("click", () => applyCoachDigit(digit));
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          applyCoachDigit(digit);
        }
      });
      wrap.appendChild(chip);
      });
    });
  }

  function updateStrategyCoach(data, lastDigit) {
    const list = document.getElementById("matchesCoachList");
    if (!list) return;
    const points = data?.points || [];
    const barrier = Number(barrierEl?.value ?? NaN);
    const items = [];

    const rsi = data?.last_rsi14;
    const ma = data?.last_ma20;
    const price = data?.last_price != null ? Number(data.last_price) : null;

    if (Number.isFinite(rsi)) {
      if (rsi >= 65) {
        items.push({
          text: `RSI(14) is stretched up (${rsi.toFixed(1)}) — recent closes rose quickly. **Digits stay random**; use RSI as mood, not digit signal.`,
          cls: "matches-coach-li--note",
        });
      } else if (rsi <= 35) {
        items.push({
          text: `RSI(14) is stretched down (${rsi.toFixed(1)}) — recent closes fell quickly. **Digits stay random**; context only.`,
          cls: "matches-coach-li--note",
        });
      } else {
        items.push({
          text: `RSI(14) ≈ ${rsi.toFixed(1)} — neutral chop zone on price; last-digit odds do not follow RSI.`,
          cls: "",
        });
      }
    }

    if (price != null && Number.isFinite(ma)) {
      const above = price > ma;
      items.push({
        text: `Price is **${above ? "above" : "below"}** the 20-tick MA (${Number(ma).toFixed(3)}). Short drift ${above ? "up" : "down"} — expiry digit still comes from the full path of ticks.`,
        cls: "",
      });
    }

    const counts = Array.from({ length: 10 }, () => 0);
    const slice = points.slice(-60);
    slice.forEach((p) => {
      const d = extractLastDigit(p?.price);
      if (d != null && d >= 0 && d <= 9) counts[d] += 1;
    });
    const total = counts.reduce((a, b) => a + b, 0);
    coachHotDigit = null;
    coachColdDigit = null;
    coachRisingDigit = null;
    coachRisingDigitSecond = null;
    if (total >= 15) {
      const maxC = Math.max(...counts);
      const minC = Math.min(...counts);
      coachHotDigit = counts.indexOf(maxC);
      coachColdDigit = counts.indexOf(minC);
      const hotPct = ((maxC / total) * 100).toFixed(1);
      const coldPct = ((minC / total) * 100).toFixed(1);
      items.push({
        text: `In the last **${total}** ticks, last-digit **${coachHotDigit}** appeared most (${hotPct}%), **${coachColdDigit}** least (${coldPct}%). “Hot/cold” is descriptive only.`,
        cls: "",
      });
    } else {
      items.push({
        text: "Still collecting ticks — heat/cold digits need a few more samples.",
        cls: "",
      });
    }

    const sampleRise = points.slice(-digitPctSample);
    const midR = Math.floor(sampleRise.length / 2);
    const recentR =
      midR >= 8 ? sampleRise.slice(midR) : sampleRise.slice(-Math.min(30, sampleRise.length));
    const prevR =
      midR >= 8
        ? sampleRise.slice(0, midR)
        : sampleRise.slice(0, Math.max(0, sampleRise.length - recentR.length));
    const countRRecent = Array.from({ length: 10 }, () => 0);
    const countRPrev = Array.from({ length: 10 }, () => 0);
    recentR.forEach((p) => {
      const dd = extractLastDigit(p?.price);
      if (dd != null && dd >= 0 && dd <= 9) countRRecent[dd] += 1;
    });
    prevR.forEach((p) => {
      const dd = extractLastDigit(p?.price);
      if (dd != null && dd >= 0 && dd <= 9) countRPrev[dd] += 1;
    });
    if (recentR.length >= 8 && prevR.length >= 8) {
      const deltas = countRRecent.map((c, i) => c - countRPrev[i]);
      const ranked = deltas
        .map((delta, digit) => ({ digit, delta }))
        .filter((x) => x.delta > 0)
        .sort((a, b) => b.delta - a.delta || a.digit - b.digit);
      coachRisingDigit = ranked[0] != null ? ranked[0].digit : null;
      coachRisingDigitSecond = ranked[1] != null ? ranked[1].digit : null;
      const maxDelta = ranked[0] != null ? ranked[0].delta : 0;
      if (maxDelta > 0 && coachRisingDigit != null) {
        const tiesAtFirst = ranked.filter((x) => x.delta === maxDelta).map((x) => x.digit);
        const digitLabelFirst =
          tiesAtFirst.length > 1 ? `**Tie (1st):** ${tiesAtFirst.join(", ")}` : `**${coachRisingDigit}**`;
        let riseText = `**1st increasing digit:** ${digitLabelFirst} at **+${maxDelta}** (recent vs older half, ${recentR.length} vs ${prevR.length} ticks). `;
        if (coachRisingDigitSecond != null && ranked[1]) {
          riseText += `**2nd increasing:** **${coachRisingDigitSecond}** at **+${ranked[1].delta}**. Pick **1st** or **2nd** above for “Use rising digit” / your entry rule. Same as ▲ on the grid; not a forecast.`;
        } else {
          riseText +=
            "No **2nd** rising digit (only one rank had a gain). Switch to **1st** if you had **2nd** selected.";
        }
        items.push({
          text: riseText,
          cls: "matches-coach-li--note",
        });
      } else {
        items.push({
          text: "**Increasing digits:** none — no digit gained hits in the recent half vs the older half (all flat or down).",
          cls: "",
        });
      }
    }

    const streakDigits = points.map((p) => extractLastDigit(p?.price)).filter((d) => d != null);
    if (streakDigits.length >= 2) {
      const tail = streakDigits[streakDigits.length - 1];
      let streak = 1;
      for (let i = streakDigits.length - 2; i >= 0; i -= 1) {
        if (streakDigits[i] === tail) streak += 1;
        else break;
      }
      if (streak >= 3) {
        items.push({
          text: `**Streak:** last digit **${tail}** repeated **${streak}** times in this window — feels like a pattern; mathematically the next tick is not “due” to break it.`,
          cls: "matches-coach-li--warn",
        });
      } else if (streak === 2) {
        items.push({
          text: `Last two ticks share last digit **${tail}** — weak repeat read; not an edge by itself.`,
          cls: "",
        });
      }
    }

    if (lastDigit != null && !Number.isNaN(barrier)) {
      items.push({
        text: `Barrier **${barrier}** vs last printed digit **${lastDigit}**: ${lastDigit === barrier ? "**same** on this print" : "**different**"} — settlement uses the **official expiry** digit.`,
        cls: lastDigit === barrier ? "matches-coach-li--note" : "",
      });
    }

    if (lastQuoteSnapshot && Number.isFinite(lastQuoteSnapshot.implied_probability)) {
      items.push({
        text: `From Deriv **proposal**: implied win chance ≈ **${lastQuoteSnapshot.implied_probability.toFixed(1)}%** (ask ÷ payout). Payout is always from the API, not guessed here.`,
        cls: "matches-coach-li--note",
      });
    }

    list.innerHTML = "";
    items.forEach(({ text, cls }) => {
      const li = document.createElement("li");
      if (cls) li.className = cls;
      li.innerHTML = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      list.appendChild(li);
    });
    renderPossibleEntryPoints();
    syncCoachActionButtons();
  }

  function renderHistoryStripFromPoints(points) {
    const histEl = document.getElementById("matchesDigitHistory");
    if (!histEl) return;
    const slice = (points || []).slice(-20);
    const digits = slice.map((p) => extractLastDigit(p?.price)).filter((d) => d != null);
    histEl.innerHTML = "";
    if (!digits.length) {
      const ph = document.createElement("span");
      ph.className = "subtle small";
      ph.textContent = "Waiting for ticks…";
      histEl.appendChild(ph);
      return;
    }
    digits.forEach((d, i) => {
      const pill = document.createElement("span");
      pill.className = "matches-history-pill";
      pill.textContent = String(d);
      if (i === digits.length - 1) pill.classList.add("matches-history-pill--newest");
      histEl.appendChild(pill);
    });
  }

  function syncGridLastTick(digit) {
    if (!grid || digit == null || digit < 0 || digit > 9) return;
    grid.querySelectorAll(".digit-cell").forEach((cell) => {
      const d = Number(cell.dataset.digit);
      cell.classList.toggle("digit-cell--tick", d === digit);
    });
  }

  function renderMatchesDigitPercents(points) {
    renderDigitGridFromPoints(grid, points, digitPctSample, lastDigitTrendGlyph);
    updateOpportunityAndSignal(points);
  }

  async function refreshQuote() {
    if (Date.now() < quoteCooldownUntil) return;
    const stake = Number(stakeEl?.value ?? 0);
    const duration_ticks = Math.max(1, Math.min(10, Math.floor(Number(durationEl?.value ?? 5) || 5)));
    if (durationEl) durationEl.value = String(duration_ticks);
    if (!stake || stake <= 0 || !barrierEl) {
      if (payoutEl) payoutEl.textContent = "Enter stake";
      if (askEl) askEl.textContent = "—";
      const profitSummaryEl = document.getElementById("matchesSummaryProfit");
      if (profitSummaryEl) profitSummaryEl.textContent = "Enter stake";
      lastQuoteSnapshot = null;
      updateStrategyCoach(lastMarketData, lastDigitFromMarketData(lastMarketData) ?? prevPollDigit);
      syncTradeSummary();
      return;
    }
    markTradeSummaryQuotePending();
    try {
      const quote = await requestJson("/manual-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_type: "DIGITMATCH",
          barrier: Number(barrierEl.value),
          stake,
          symbol: "R_100",
          duration_ticks,
        }),
      });
      if (payoutEl) payoutEl.textContent = `$${Number(quote.payout ?? 0).toFixed(2)}`;
      if (askEl) askEl.textContent = `$${Number(quote.ask_price ?? 0).toFixed(2)}`;
      const profitSummaryEl = document.getElementById("matchesSummaryProfit");
      const profitVal = Number(quote.profit ?? Number(quote.payout ?? 0) - stake);
      if (profitSummaryEl) {
        profitSummaryEl.textContent = Number.isFinite(profitVal)
          ? `${profitVal >= 0 ? "+" : ""}$${Math.abs(profitVal).toFixed(2)}`
          : "Unavailable";
        profitSummaryEl.classList.toggle("matches-pos", profitVal > 0);
        profitSummaryEl.classList.toggle("matches-neg", profitVal < 0);
      }
      lastQuoteSnapshot = {
        implied_probability: Number(quote.implied_probability ?? NaN),
        payout: Number(quote.payout ?? 0),
        ask: Number(quote.ask_price ?? 0),
        profit: Number(quote.profit ?? 0),
      };
      if (expectedEdgeEl && Number.isFinite(lastQuoteSnapshot.implied_probability)) {
        expectedEdgeEl.textContent = `${(100 - lastQuoteSnapshot.implied_probability).toFixed(1)}% payout breakeven`;
      }
      updateStrategyCoach(lastMarketData, lastDigitFromMarketData(lastMarketData) ?? prevPollDigit);
    } catch (_e) {
      if (String(_e?.message || "").includes("429") || /rate|cooldown/i.test(String(_e?.message || ""))) {
        quoteCooldownUntil = Date.now() + parseRetryAfterMs(_e?.message, 30000);
      }
      if (payoutEl) payoutEl.textContent = "Quote unavailable";
      if (askEl) askEl.textContent = "—";
      const profitSummaryEl = document.getElementById("matchesSummaryProfit");
      if (profitSummaryEl) {
        profitSummaryEl.textContent = "Quote unavailable";
        profitSummaryEl.classList.remove("matches-pos", "matches-neg");
      }
      lastQuoteSnapshot = null;
      if (expectedEdgeEl) expectedEdgeEl.textContent = "—";
      updateStrategyCoach(lastMarketData, lastDigitFromMarketData(lastMarketData) ?? prevPollDigit);
    }
    syncTradeSummary();
  }

  function applyMarketPointsToUi(points, stale) {
    if (!points?.length) return;
    lastMarketData = { points, symbol: "R_100", timeframe: "tick" };
    const latest = points[points.length - 1];
    const price = Number(latest.price ?? 0);
    if (livePriceEl) livePriceEl.textContent = price ? price.toFixed(3) : "--";
    matchesTickState = applyLatestTickMotion(points, matchesTickState);
    prevPollDigit = matchesTickState.prevDigit;
    const digit = matchesTickState.prevDigit;
    seedDigitRollFromPoints(points);
    if (digit != null) {
      const compactLive = document.getElementById("matchesLiveDigitCompact");
      if (compactLive) compactLive.textContent = String(digit);
    }
    if (latest?.price != null) recordMatchesContractTick(latest.price);
    if (pricePctEl && matchesTickState.prevPrice != null && Number.isFinite(price)) {
      const prior = points.length > 1 ? Number(points[points.length - 2].price ?? NaN) : matchesTickState.prevPrice;
      if (Number.isFinite(prior) && prior) {
        const rel = ((price - prior) / Math.abs(prior)) * 100;
        pricePctEl.textContent = `${rel >= 0 ? "+" : ""}${rel.toFixed(3)}%`;
      }
    }
    renderMatchesDigitPercents(points);
    renderHistoryStripFromPoints(points);
    updateStrategyCoach(lastMarketData, digit != null ? digit : lastDigitFromMarketData(lastMarketData));
    const b = Number(barrierEl?.value ?? NaN);
    if (previewEl && digit != null && !Number.isNaN(b)) {
      previewEl.textContent =
        digit === b
          ? "Tick vs barrier: WIN (preview only — settlement is from Deriv contract)"
          : "Tick vs barrier: LOSE (preview only — settlement is from Deriv contract)";
    }
    if (stale && digitArrowEl) digitArrowEl.title = "Stale tick data — retrying…";
  }

  let pollMarketInFlight = false;
  async function pollMarket() {
    if (pollMarketInFlight) return;
    pollMarketInFlight = true;
    try {
      if (Date.now() < marketCooldownUntil && lastMarketData?.points?.length) {
        applyMarketPointsToUi(lastMarketData.points, true);
        return;
      }
      const { points, stale } = await fetchLiveMarketPoints("R_100", { fresh: matchesPollFresh });
      matchesPollFresh = !matchesPollFresh;
      if (points.length) {
        applyMarketPointsToUi(points, stale);
      } else if (lastMarketData?.points?.length) {
        applyMarketPointsToUi(lastMarketData.points, true);
      }
    } catch (_err) {
      if (String(_err?.message || "").includes("429") || /rate|cooldown/i.test(String(_err?.message || ""))) {
        marketCooldownUntil = Date.now() + parseRetryAfterMs(_err?.message, 15000);
      }
      if (lastMarketData?.points?.length) {
        applyMarketPointsToUi(lastMarketData.points, true);
      }
    } finally {
      pollMarketInFlight = false;
    }
  }

  function formatContractTypeLabel(contractType) {
    const ct = String(contractType || "").toUpperCase();
    if (ct === "DIGITMATCH") return "Digit Match";
    if (ct === "DIGITOVER") return "Digit Over";
    if (ct === "DIGITUNDER") return "Digit Under";
    if (!ct) return "Digit Match";
    return ct.charAt(0) + ct.slice(1).toLowerCase().replace(/_/g, " ");
  }

  function isTodayTimestamp(ts) {
    if (!ts) return false;
    const now = new Date();
    const parts = String(ts).match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!parts) return true;
    const tradeDate = new Date(now);
    tradeDate.setHours(Number(parts[1]), Number(parts[2]), Number(parts[3]), 0);
    if (tradeDate > now) tradeDate.setDate(tradeDate.getDate() - 1);
    return tradeDate.toDateString() === now.toDateString();
  }

  let matchesTimelineRows = [];
  let matchesTimelinePrevNewestKey = null;
  const matchesTimelineFilters = {
    wins: false,
    losses: false,
    scope: "session",
  };

  function timelineRowKey(row) {
    return `${row.timestamp}|${row.digit}|${row.profit}|${row.stake}|${row.result}`;
  }

  function filterTimelineRows(rows) {
    let filtered = [...(rows || [])];
    if (matchesTimelineFilters.scope === "today") {
      filtered = filtered.filter((r) => isTodayTimestamp(r.timestamp));
    }
    if (matchesTimelineFilters.wins && !matchesTimelineFilters.losses) {
      filtered = filtered.filter((r) => String(r.result || "").toLowerCase() === "win");
    } else if (matchesTimelineFilters.losses && !matchesTimelineFilters.wins) {
      filtered = filtered.filter((r) => String(r.result || "").toLowerCase() === "loss");
    }
    return filtered;
  }

  function renderTradeTimeline(matchRows) {
    matchesTimelineRows = matchRows || [];
    const bodyEl = document.getElementById("matchesTimelineBody");
    const countEl = document.getElementById("matchesTimelineCount");
    if (!bodyEl) return;

    const filtered = filterTimelineRows(matchesTimelineRows);
    const displayRows = filtered.slice().reverse();

    if (countEl) {
      const scopeLabel = matchesTimelineFilters.scope === "today" ? "today" : "session";
      countEl.textContent =
        filtered.length === 1 ? `1 trade · ${scopeLabel}` : `${filtered.length} trades · ${scopeLabel}`;
    }

    if (!displayRows.length) {
      const emptyMsg =
        matchesTimelineFilters.wins && !matchesTimelineFilters.losses
          ? "No winning trades yet"
          : matchesTimelineFilters.losses && !matchesTimelineFilters.wins
            ? "No losing trades yet"
            : matchesTimelineFilters.scope === "today"
              ? "No trades today yet"
              : "No trades yet this session";
      bodyEl.innerHTML = `<tr class="trade-timeline-empty"><td colspan="6">${emptyMsg}</td></tr>`;
      return;
    }

    const newestKey = timelineRowKey(displayRows[0]);
    const highlightNewest = matchesTimelinePrevNewestKey != null && newestKey !== matchesTimelinePrevNewestKey;
    matchesTimelinePrevNewestKey = newestKey;

    bodyEl.innerHTML = "";
    displayRows.forEach((row, idx) => {
      const res = String(row.result || "").toLowerCase();
      const isWin = res === "win";
      const isLoss = res === "loss";
      const badgeCls = isWin ? "win" : isLoss ? "loss" : "open";
      const badgeLabel = isWin ? "WIN" : isLoss ? "LOSS" : "OPEN";
      const profit = Number(row.profit ?? 0);
      const stake = Number(row.stake ?? 0);
      const barrier = row.barrier ?? row.digit ?? "—";
      const tr = document.createElement("tr");
      tr.className = "trade-timeline-row";
      if (idx === 0 && highlightNewest) tr.classList.add("trade-timeline-row--new");
      tr.innerHTML = `
        <td class="trade-timeline-row__time">${escapeHtml(row.timestamp ?? "—")}</td>
        <td class="trade-timeline-row__contract">${escapeHtml(formatContractTypeLabel(row.contract_type))}</td>
        <td class="trade-timeline-row__barrier">${escapeHtml(String(barrier))}</td>
        <td class="trade-timeline-row__stake">${escapeHtml(formatUsd(stake))}</td>
        <td class="trade-timeline-row__result">
          <span class="terminal-trade-badge terminal-trade-badge--${badgeCls}">${badgeLabel}</span>
        </td>
        <td class="trade-timeline-row__pnl ${isWin ? "matches-pos" : isLoss ? "matches-neg" : ""}">${escapeHtml(formatUsd(profit, { signed: true, emptyLabel: "—" }))}</td>`;
      bodyEl.appendChild(tr);
    });
  }

  function syncTradeTimelineFiltersUi() {
    document.querySelectorAll(".trade-timeline-filter").forEach((btn) => {
      const key = btn.dataset.filter;
      let active = false;
      if (key === "wins") active = matchesTimelineFilters.wins;
      else if (key === "losses") active = matchesTimelineFilters.losses;
      else if (key === "today") active = matchesTimelineFilters.scope === "today";
      else if (key === "session") active = matchesTimelineFilters.scope === "session";
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  document.querySelectorAll(".trade-timeline-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.filter;
      if (key === "wins") matchesTimelineFilters.wins = !matchesTimelineFilters.wins;
      else if (key === "losses") matchesTimelineFilters.losses = !matchesTimelineFilters.losses;
      else if (key === "today") matchesTimelineFilters.scope = "today";
      else if (key === "session") matchesTimelineFilters.scope = "session";
      syncTradeTimelineFiltersUi();
      renderTradeTimeline(matchesTimelineRows);
    });
  });
  syncTradeTimelineFiltersUi();

  function renderRecentTrades(matchRows) {
    renderTradeTimeline(matchRows);
  }

  async function refreshMatchesHistoryHint(statusSnapshot = null) {
    try {
      const rows = await requestJson("/history");
      const matchRows = (rows || []).filter(
        (r) => String(r.contract_type || "").toUpperCase() === "DIGITMATCH"
      );
      updatePerformance(statusSnapshot, rows || []);
      renderRecentTrades(matchRows);
      if (!lastContractEl) return;
      const last = matchRows[matchRows.length - 1];
      if (!last) {
        lastContractEl.textContent = "No settled trades this session";
        return;
      }
      const resLabel = String(last.result || "").toLowerCase() === "win" ? "WIN" : "LOSS";
      lastContractEl.textContent = `${resLabel} · MATCH ${last.digit ?? "?"} · ${formatUsd(Number(last.profit ?? 0), { signed: true })} · ${last.timestamp ?? ""}`;
    } catch (_e) {
      // ignore
    }
  }

  async function submitBuy() {
    if (!barrierEl || !stakeEl || !durationEl || submitting) return;
    if (Date.now() < buyCooldownUntil) {
      showToast("Buy cooldown active — wait a moment.", 1100);
      return;
    }
    submitting = true;
    setLoading(buyBtn, true);
    syncBuyButtonState();
    const duration_ticks = Math.max(1, Math.min(10, Math.floor(Number(durationEl.value) || 5)));
    durationEl.value = String(duration_ticks);
    beginMatchesContractWatch(barrierEl.value, duration_ticks, {
      stake: Number(stakeEl.value),
      payout: lastQuoteSnapshot?.payout ?? null,
      contractType: "Digit Match",
    });
    let tradeOk = false;
    let tradeWon = null;
    try {
      const res = await requestJson("/manual-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_type: "DIGITMATCH",
          barrier: Number(barrierEl.value),
          stake: Number(stakeEl.value),
          symbol: "R_100",
          duration_ticks,
        }),
      });
      tradeOk = true;
      if (matchesContractWatch) {
        if (res.contract_id) matchesContractWatch.contractId = String(res.contract_id);
        if (Number.isFinite(Number(res.payout))) matchesContractWatch.payout = Number(res.payout);
        if (matchesContractWatch.status === "waiting") matchesContractWatch.status = "live";
        renderActiveContractPanel();
      }
      if (typeof res.won === "boolean") {
        tradeWon = res.won;
        if (matchesContractWatch && Number.isFinite(Number(res.profit_delta))) {
          matchesContractWatch.profitDelta = Number(res.profit_delta);
        }
      }
      if (Number.isFinite(Number(res.balance))) {
        applySessionBalance(Number(res.balance));
      }
    } catch (error) {
      showToast(`Buy Match failed: ${error.message}`, 2600);
      if (matchesContractWatch?.fastPollId) window.clearInterval(matchesContractWatch.fastPollId);
      if (matchesContractWatch?.settledTimerId) window.clearTimeout(matchesContractWatch.settledTimerId);
      matchesContractWatch = null;
      hideActiveContractPanel();
    } finally {
      if (tradeOk && typeof tradeWon === "boolean") finalizeMatchesContractWatch(tradeWon);
      else if (!tradeOk && matchesContractWatch && !matchesContractWatch.finalized) {
        if (matchesContractWatch.fastPollId) window.clearInterval(matchesContractWatch.fastPollId);
        if (matchesContractWatch.settledTimerId) window.clearTimeout(matchesContractWatch.settledTimerId);
        matchesContractWatch = null;
        hideActiveContractPanel();
      }
      setLoading(buyBtn, false);
      submitting = false;
      if (tradeOk) {
        buyCooldownUntil = Date.now() + BUY_COOLDOWN_AFTER_OK_MS;
        window.setTimeout(syncBuyButtonState, BUY_COOLDOWN_AFTER_OK_MS + 80);
      }
      syncBuyButtonState();
    }
    if (tradeOk) {
      void (async () => {
        try {
          const status = await requestJson("/status");
          if ((status.trades_count ?? 0) > 0 && Number.isFinite(Number(status.balance))) {
            applySessionBalance(Number(status.balance));
          }
          await refreshMatchesHistoryHint(status);
          await refreshQuote();
        } catch (_e) {
          /* ignore */
        }
      })();
    }
  }

  if (grid && matchesDigitPointer) {
    window.addEventListener("resize", () => {
      const d = Number(liveDigitEl?.textContent);
      if (!Number.isNaN(d)) moveDigitPointerToCell(grid, matchesDigitPointer, d);
    });
  }
  if (grid && barrierEl) {
    grid.querySelectorAll(".digit-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        barrierEl.value = cell.dataset.digit ?? "0";
        syncDigitHighlight();
        refreshQuote();
      });
      cell.addEventListener("dblclick", async (e) => {
        e.preventDefault();
        if (!matchesLoggedIn || submitting || Date.now() < buyCooldownUntil) return;
        barrierEl.value = cell.dataset.digit ?? "0";
        syncDigitHighlight();
        await refreshQuote();
        submitBuy();
      });
    });
  }
  document.querySelectorAll(".matches-barrier-pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!barrierEl) return;
      barrierEl.value = btn.dataset.digit ?? "0";
      syncDigitHighlight();
      void refreshQuote();
    });
  });

  syncDigitHighlight();
  renderTickerStrip();
  stakeEl?.addEventListener("input", () => {
    syncTradeSummary();
    markTradeSummaryQuotePending();
    syncAiOpportunityAdvisory(
      lastAiOpportunity.confidence,
      lastAiOpportunity.underDigit,
      lastAiOpportunity.underPct,
    );
    refreshQuote();
  });
  durationEl?.addEventListener("input", () => {
    syncDurationPills();
    markTradeSummaryQuotePending();
    refreshQuote();
  });
  document.querySelectorAll(".terminal-tick-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!durationEl) return;
      const ticks = Math.max(1, Math.min(10, Math.floor(Number(btn.dataset.ticks) || 5)));
      durationEl.value = String(ticks);
      syncDurationPills();
      markTradeSummaryQuotePending();
      void refreshQuote();
    });
  });
  syncTradeSummary();
  syncDurationPills();
  buyBtn.addEventListener("click", () => submitBuy());

  document.getElementById("matchesApplyHotBtn")?.addEventListener("click", () => applyCoachDigit(coachHotDigit));
  document.getElementById("matchesApplyColdBtn")?.addEventListener("click", () => applyCoachDigit(coachColdDigit));
  document
    .getElementById("matchesApplyRisingBtn")
    ?.addEventListener("click", () => applyCoachDigit(getActiveRisingDigit()));
  document.getElementById("matchesApplyLastDigitBtn")?.addEventListener("click", () => applyCoachDigit(prevPollDigit));

  document.querySelectorAll('input[name="matchesRisingRank"]').forEach((inp) => {
    inp.addEventListener("change", () => {
      try {
        localStorage.setItem("matchesRisingRank", inp.value);
      } catch (_e) {
        /* ignore */
      }
      syncCoachActionButtons();
    });
  });
  try {
    const saved = localStorage.getItem("matchesRisingRank");
    const two = document.querySelector('input[name="matchesRisingRank"][value="2"]');
    const one = document.querySelector('input[name="matchesRisingRank"][value="1"]');
    if (saved === "2" && two) {
      two.checked = true;
      if (one) one.checked = false;
    }
  } catch (_e) {
    /* ignore */
  }
  syncCoachActionButtons();

  initMatchesMobilePanes();

  let statusPollIndex = 0;
  async function refreshMatchesStatus() {
    try {
      await refreshAuthState();
      const status = await requestJson("/status");
      applyHybridBannerFromStatus(status);
      const loggedIn = !!lastDerivMe?.logged_in && !!lastDerivMe?.account;
      matchesLoggedIn = loggedIn;
      if (!loggedIn) buyCooldownUntil = 0;
      syncMatchesAccountFromAuth();
      syncBuyButtonState();
      if (statusPollIndex % 5 === 0) await refreshMatchesHistoryHint(status);
      statusPollIndex += 1;
    } catch (error) {
      const msg = String(error?.message || "");
      if (!/rate|cooldown|429/i.test(msg)) {
        showToast(`Status: ${msg}`);
      }
    }
  }

  function matchesPageKeydown(e) {
    if (!document.getElementById("matchesBuyBtn")) {
      document.removeEventListener("keydown", matchesPageKeydown);
      return;
    }
    if (e.key !== "Enter" || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    const btn = document.getElementById("matchesBuyBtn");
    if (!btn || btn.disabled || submitting) return;
    e.preventDefault();
    void submitBuy();
  }
  document.addEventListener("keydown", matchesPageKeydown);

  const cooldownUiTimer = window.setInterval(() => {
    if (Date.now() < buyCooldownUntil && document.getElementById("matchesBuyBtn")) syncBuyButtonState();
  }, 400);

  initAuthButtons();
  refreshAuthState();
  refreshQuote();
  pollMarket();
  refreshMatchesStatus();
  refreshMatchesHistoryHint();
  syncBuyButtonState();
  setInterval(pollMarket, 1000);
  setInterval(refreshQuote, 4500);
  setInterval(refreshMatchesStatus, 2500);
  window.setInterval(refreshAuthState, 15000);

  window.addEventListener(
    "pagehide",
    () => {
      document.removeEventListener("keydown", matchesPageKeydown);
      window.clearInterval(cooldownUiTimer);
    },
    { once: true }
  );
}

const __path = (window.location.pathname || "/").replace(/\/+$/, "") || "/";
if (__path === "/" || __path === "") {
  initDashboardPage();
} else if (__path === "/manual-trader") {
  initManualTraderPage();
} else if (__path === "/matches") {
  initMatchesPage();
} else if (__path === "/strategies") {
  initStrategiesPage();
} else if (__path === "/analysis") {
  initAnalysisPage();
} else if (__path === "/copy-trading") {
  if (typeof initCopyMarketplace === "function") initCopyMarketplace();
  else initCopyPage();
} else if (__path === "/builder") {
  initBuilderPage();
} else if (__path === "/trading-bots") {
  if (typeof initBotsRegistry === "function") initBotsRegistry();
  else initTradingBotsPage();
}

// Global auth wiring fallback: some routes (e.g. TradingView) do not have a page initializer
// that calls auth setup, but the layout still exposes login controls in the base header.
initSectionTabs();
initThemeToggle();
initAuthButtons();
if (document.getElementById("headerWalletBtn") || document.getElementById("authAccount")) {
  refreshAuthState();
}
