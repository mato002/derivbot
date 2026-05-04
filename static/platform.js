/** Epicstraders-style first-load splash (once per tab session). */
(function () {
  var root = document.getElementById("appPreloader");
  if (!root) return;
  if (document.documentElement.classList.contains("no-app-preloader")) {
    root.remove();
    return;
  }

  var bar = document.getElementById("preloaderBarFill");
  var pctEl = document.getElementById("preloaderPct");
  var reduce =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setPct(n) {
    var v = Math.max(0, Math.min(100, n));
    if (bar) bar.style.width = v + "%";
    if (pctEl) pctEl.textContent = Math.round(v) + "%";
  }

  function finish() {
    try {
      sessionStorage.setItem("derivbot_preloader_v1", "1");
    } catch (e) {}
    document.body.classList.remove("is-preloading");
    root.classList.add("app-preloader--exit");
    window.setTimeout(function () {
      root.remove();
    }, 520);
  }

  document.body.classList.add("is-preloading");

  if (reduce) {
    setPct(100);
    finish();
    return;
  }

  var start = performance.now();
  var shown = 0;
  var raf = 0;

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function tick(now) {
    var elapsed = (now - start) / 1000;
    var cap = 0.88 + easeOutCubic(Math.min(1, elapsed / 2.2)) * 0.07;
    var target = Math.min(92, cap * 100);
    if (target > shown) shown += (target - shown) * 0.14;
    setPct(shown);
    if (shown < 91.5) raf = requestAnimationFrame(tick);
  }

  raf = requestAnimationFrame(tick);

  var exitStarted = false;
  function onLoaded() {
    if (exitStarted) return;
    exitStarted = true;
    cancelAnimationFrame(raf);
    var t0 = performance.now();
    function to100(now) {
      var u = Math.min(1, (now - t0) / 280);
      shown = shown + (100 - shown) * u;
      setPct(shown);
      if (u < 1) requestAnimationFrame(to100);
      else {
        setPct(100);
        window.setTimeout(finish, 160);
      }
    }
    requestAnimationFrame(to100);
  }

  if (document.readyState === "complete") onLoaded();
  else window.addEventListener("load", onLoaded, { once: true });

  window.setTimeout(function () {
    if (root.parentNode) onLoaded();
  }, 9000);
})();

/** Mobile shell: drawer sidebar, scrim, wallet chip → auth area. */
(function () {
  function qs(id) {
    return document.getElementById(id);
  }

  function closeSidebar() {
    const sidebar = qs("appSidebar");
    const scrim = qs("sidebarScrim");
    const btn = qs("mobileMenuBtn");
    if (sidebar) sidebar.classList.remove("sidebar--open");
    if (scrim) {
      scrim.classList.add("hidden");
      scrim.setAttribute("aria-hidden", "true");
    }
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function openSidebar() {
    const sidebar = qs("appSidebar");
    const scrim = qs("sidebarScrim");
    const btn = qs("mobileMenuBtn");
    if (sidebar) sidebar.classList.add("sidebar--open");
    if (scrim) {
      scrim.classList.remove("hidden");
      scrim.setAttribute("aria-hidden", "false");
    }
    if (btn) btn.setAttribute("aria-expanded", "true");
  }

  function toggleSidebar() {
    const sidebar = qs("appSidebar");
    if (sidebar && sidebar.classList.contains("sidebar--open")) closeSidebar();
    else openSidebar();
  }

  document.addEventListener("DOMContentLoaded", () => {
    const menuBtn = qs("mobileMenuBtn");
    const scrim = qs("sidebarScrim");
    const sidebar = qs("appSidebar");
    const walletBtn = qs("headerWalletBtn");
    const authPanel = document.querySelector(".auth-panel");

    if (menuBtn) {
      menuBtn.addEventListener("click", () => toggleSidebar());
    }
    if (scrim) {
      scrim.addEventListener("click", () => closeSidebar());
    }
    if (sidebar) {
      sidebar.querySelectorAll("a.sidebar-link").forEach((a) => a.addEventListener("click", () => closeSidebar()));
    }
    if (walletBtn && authPanel && !qs("headerWalletDropdown")) {
      walletBtn.addEventListener("click", () => {
        authPanel.scrollIntoView({ behavior: "smooth", block: "center" });
        const login = qs("loginDerivBtn");
        if (login && !login.classList.contains("hidden")) login.focus();
      });
    }

    const bottomInfo = qs("bottomInfoBtn");
    if (bottomInfo) {
      bottomInfo.addEventListener("click", () => {
        window.alert(
          "This is a demo-style control panel. Trading involves risk. Only trade with capital you can afford to lose."
        );
      });
    }
  });
})();
