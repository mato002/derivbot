/** Dashboard terminal polish — skeleton lifecycle + live metric ticks (display only). */
(function () {
  const FLASH = ["live-flash-up", "live-flash-down", "live-flash-neutral"];
  let ready = false;
  let lastDigitTail = null;

  function root() {
    return document.querySelector(".page-inner--dash-terminal");
  }

  function motionOk() {
    try {
      return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_e) {
      return true;
    }
  }

  function pulseEl(el, dir) {
    if (!el || !motionOk()) return;
    el.classList.remove(...FLASH);
    el.classList.add(dir === "up" ? "live-flash-up" : dir === "down" ? "live-flash-down" : "live-flash-neutral");
    window.setTimeout(() => el.classList.remove(...FLASH), 520);
  }

  function tweenNumber(el, from, to, format, tone) {
    if (!el || !motionOk()) {
      if (el) el.textContent = format(to);
      return;
    }
    const duration = 380;
    const start = performance.now();
    el.classList.add("is-updating");
    pulseEl(el, tone === "up" ? "up" : tone === "down" ? "down" : to > from ? "up" : to < from ? "down" : "neutral");

    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(from + (to - from) * eased);
      if (t < 1) {
        requestAnimationFrame(tick);
        return;
      }
      el.textContent = format(to);
      el.classList.remove("is-updating");
    }
    requestAnimationFrame(tick);
  }

  function updateCounter(el, next, options) {
    if (!el) return;
    const n = Number(next);
    if (!Number.isFinite(n)) {
      el.textContent = "—";
      el.dataset.rawValue = "";
      return;
    }
    const prev = Number(el.dataset.rawValue);
    el.dataset.rawValue = String(n);
    if (options?.animate !== false && Number.isFinite(prev) && prev !== n && motionOk()) {
      tweenNumber(el, prev, n, (v) => String(Math.round(v)), n > prev ? "up" : n < prev ? "down" : "neutral");
      return;
    }
    el.textContent = String(n);
  }

  function updateDecimal(el, next, options) {
    if (!el) return;
    const n = Number(next);
    const decimals = options?.decimals ?? 2;
    const prefix = options?.prefix ?? "";
    const suffix = options?.suffix ?? "";
    if (!Number.isFinite(n)) {
      el.textContent = "—";
      el.dataset.rawValue = "";
      return;
    }
    const prev = Number(el.dataset.rawValue);
    const fmt = (v) => `${prefix}${Number(v).toFixed(decimals)}${suffix}`;
    el.dataset.rawValue = String(n);
    if (options?.animate !== false && Number.isFinite(prev) && Math.abs(prev - n) > 0.001 && motionOk()) {
      tweenNumber(el, prev, n, fmt, n > prev ? "up" : n < prev ? "down" : "neutral");
      return;
    }
    el.textContent = fmt(n);
  }

  function updateText(el, text, options) {
    if (!el) return;
    const prev = el.textContent;
    if (prev === text) return;
    el.textContent = text;
    if (options?.animate !== false && prev && prev !== "—" && prev !== "--") {
      pulseEl(el, options?.dir || "neutral");
    }
  }

  function noteDigitTape(digits) {
    const arr = Array.isArray(digits) ? digits.map((d) => Number(d)).filter(Number.isFinite) : [];
    const tail = arr.length ? arr[arr.length - 1] : null;
    const changed = lastDigitTail !== null && tail !== null && tail !== lastDigitTail;
    lastDigitTail = tail;
    return changed;
  }

  function updateSignedMoney(el, next, options) {
    if (!el) return;
    const n = Number(next);
    if (!Number.isFinite(n)) {
      el.textContent = "—";
      el.dataset.rawValue = "";
      return;
    }
    const prev = Number(el.dataset.rawValue);
    const fmt = (v) => {
      const val = Number(v);
      return `${val >= 0 ? "+" : "-"}$${Math.abs(val).toFixed(options?.decimals ?? 2)}`;
    };
    el.dataset.rawValue = String(n);
    if (options?.animate !== false && Number.isFinite(prev) && Math.abs(prev - n) > 0.001 && motionOk()) {
      tweenNumber(el, prev, n, fmt, n > prev ? "up" : n < prev ? "down" : "neutral");
      return;
    }
    el.textContent = fmt(n);
  }

  function init() {
    if (!document.getElementById("balance")) return;
    const r = root();
    if (!r) return;
    r.classList.add("is-loading");
    r.classList.remove("is-ready");
  }

  function markReady() {
    if (ready) return;
    ready = true;
    const r = root();
    if (!r) return;
    r.classList.remove("is-loading");
    r.classList.add("is-ready");
  }

  window.DashboardPolish = {
    init,
    markReady,
    pulseEl,
    updateCounter,
    updateDecimal,
    updateSignedMoney,
    updateText,
    noteDigitTape,
  };
})();
