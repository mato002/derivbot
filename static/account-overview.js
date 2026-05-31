/** Deriv-style account overview — display-only animated metrics. */
(function () {
  const TONE_CLASSES = ["tone-positive", "tone-negative", "tone-neutral"];
  const FLASH_CLASSES = ["is-flash-up", "is-flash-down", "is-flash-neutral"];

  function formatUsd(value) {
    return `$${Number(value).toFixed(2)}`;
  }

  function applyTone(el, tone) {
    if (!el) return;
    const t = tone === "positive" || tone === "negative" ? tone : "neutral";
    el.classList.remove(...TONE_CLASSES);
    el.classList.add(`tone-${t}`);
    el.dataset.tone = t;
  }

  function flashDirection(el, from, to, tone) {
    el.classList.remove(...FLASH_CLASSES);
    if (tone === "positive" || (Number.isFinite(from) && Number.isFinite(to) && to > from)) {
      el.classList.add("is-flash-up");
    } else if (tone === "negative" || (Number.isFinite(from) && Number.isFinite(to) && to < from)) {
      el.classList.add("is-flash-down");
    } else {
      el.classList.add("is-flash-neutral");
    }
    window.setTimeout(() => el.classList.remove(...FLASH_CLASSES), 650);
  }

  function animateNumber(el, from, to, formatter, tone) {
    const duration = 420;
    const start = performance.now();
    el.classList.add("is-updating");
    flashDirection(el, from, to, tone);

    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + (to - from) * eased;
      el.textContent = formatter(val);
      if (t < 1) {
        requestAnimationFrame(tick);
        return;
      }
      el.textContent = formatter(to);
      el.dataset.rawValue = String(to);
      applyTone(el, tone);
      el.classList.remove("is-updating");
    }
    requestAnimationFrame(tick);
  }

  function updateMoney(el, nextValue, tone, { animate = true } = {}) {
    if (!el) return;
    const next = Number(nextValue);
    if (!Number.isFinite(next)) {
      el.textContent = "--";
      el.dataset.rawValue = "";
      applyTone(el, "neutral");
      return;
    }
    const prev = Number(el.dataset.rawValue);
    const resolvedTone =
      tone || (next > 0 ? "positive" : next < 0 ? "negative" : "neutral");
    if (animate && Number.isFinite(prev) && Math.abs(prev - next) > 0.001) {
      animateNumber(el, prev, next, formatUsd, resolvedTone);
      return;
    }
    el.textContent = formatUsd(next);
    el.dataset.rawValue = String(next);
    applyTone(el, resolvedTone);
  }

  function updateBotStatus(el, running, { animate = true } = {}) {
    if (!el) return;
    const nextLabel = running ? "Running" : "Stopped";
    const nextTone = running ? "positive" : "neutral";
    const prev = el.dataset.rawValue === "1";
    el.textContent = nextLabel;
    el.dataset.rawValue = running ? "1" : "0";
    applyTone(el, nextTone);
    el.classList.toggle("is-live", running);
    if (animate && prev !== running) {
      flashDirection(el, prev ? 1 : 0, running ? 1 : 0, nextTone);
    }
  }

  function computeSnapshot(status) {
    const balance = typeof window.resolveEffectiveBalance === "function"
      ? window.resolveEffectiveBalance(status || {})
      : Number(status?.balance ?? 0);
    const profit = Number(status?.profit ?? 0);
    const active = (status?.active_trades ?? []).length;
    const stake = Number(status?.stake ?? 0);
    const margin = active > 0 && Number.isFinite(stake) ? stake : 0;
    const freeMargin = Math.max(0, balance - margin);
    const equity = balance;
    return {
      balance,
      equity,
      profit,
      margin,
      freeMargin,
      running: !!status?.running,
    };
  }

  function updateFromStatus(status, options) {
    const snap = computeSnapshot(status);
    const els = {
      balance: document.getElementById("balance"),
      equity: document.getElementById("acctEquity"),
      profit: document.getElementById("profit"),
      margin: document.getElementById("acctMargin"),
      freeMargin: document.getElementById("acctFreeMargin"),
      botStatus: document.getElementById("statusBadge"),
    };
    if (!els.balance) return snap;

    const animate = options?.animate !== false;
    updateMoney(els.balance, snap.balance, "neutral", { animate });
    updateMoney(els.equity, snap.equity, "neutral", { animate });
    updateMoney(els.profit, snap.profit, snap.profit > 0 ? "positive" : snap.profit < 0 ? "negative" : "neutral", {
      animate,
    });
    updateMoney(els.margin, snap.margin, "neutral", { animate });
    updateMoney(els.freeMargin, snap.freeMargin, "neutral", { animate });
    updateBotStatus(els.botStatus, snap.running, { animate });
    return snap;
  }

  function refreshBalanceOnly(balance, options) {
    const status = { balance, profit: 0, active_trades: [], stake: 0, running: false };
    const botStatusEl = document.getElementById("statusBadge");
    if (botStatusEl?.dataset.rawValue === "1") {
      status.running = true;
    }
    const profitEl = document.getElementById("profit");
    if (profitEl?.dataset.rawValue) {
      status.profit = Number(profitEl.dataset.rawValue);
    }
    return updateFromStatus(status, options);
  }

  window.AccountOverview = {
    updateFromStatus,
    refreshBalanceOnly,
    computeSnapshot,
    updateMoney,
    updateBotStatus,
  };
})();
