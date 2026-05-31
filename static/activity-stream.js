/** Real-time dashboard activity stream (display-only, polls /events). */
(function () {
  const MAX_ITEMS = 80;
  const TONE_CLASS = {
    win: "activity-item--win",
    loss: "activity-item--loss",
    system: "activity-item--system",
  };

  const state = {
    lastSeq: 0,
    bootstrapped: false,
    seen: new Set(),
    items: [],
  };

  function extractTimestamp(row, raw) {
    if (row && row.ts) return String(row.ts);
    const m = String(raw || "").match(/^\[(\d{2}:\d{2}:\d{2})\]/);
    return m ? m[1] : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function stripTimestamp(raw) {
    return String(raw || "").replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "").trim();
  }

  function classifyEvent(row) {
    const raw = stripTimestamp(row?.message ?? row ?? "");
    const lower = raw.toLowerCase();
    const ts = extractTimestamp(row, row?.message);
    const base = { ts, detail: raw, tone: "system", type: "System" };

    if (/^bot started\b/i.test(raw)) {
      return { ...base, type: "Bot Started", tone: "system" };
    }
    if (/^bot stopped\b/i.test(raw)) {
      return { ...base, type: "Bot Stopped", tone: "system" };
    }
    if (/^bot paused\b/i.test(raw)) {
      return { ...base, type: "Bot Paused", tone: "system" };
    }
    if (/^bot resumed\b/i.test(raw)) {
      return { ...base, type: "Bot Resumed", tone: "system" };
    }
    if (/authorized successfully|connected with otp|subscribed to r_100/i.test(lower)) {
      return { ...base, type: "API Reconnected", tone: "system", detail: raw };
    }
    if (/^\[trade\]\s*buy\b/i.test(raw)) {
      const detail = raw.replace(/^\[Trade\]\s*/i, "").trim();
      return { ...base, type: "Trade Opened", tone: "system", detail };
    }
    if (/^trade win\b/i.test(raw)) {
      const profit = raw.match(/profit\s+(-?[\d.]+)/i);
      const detail = profit ? `+$${Number(profit[1]).toFixed(2)}` : raw.replace(/^Trade WIN\s*\|\s*/i, "");
      return { ...base, type: "Win", tone: "win", detail: `Trade Closed · ${detail}` };
    }
    if (/^trade loss\b/i.test(raw)) {
      const profit = raw.match(/profit\s+(-?[\d.]+)/i);
      const detail = profit ? `$${Number(profit[1]).toFixed(2)}` : raw.replace(/^Trade LOSS\s*\|\s*/i, "");
      return { ...base, type: "Loss", tone: "loss", detail: `Trade Closed · ${detail}` };
    }
    if (/^\[trade\]\s*failed\b/i.test(raw)) {
      return { ...base, type: "Trade Closed", tone: "loss", detail: raw.replace(/^\[Trade\]\s*FAILED\s*/i, "") || "Order failed" };
    }
    if (/risk limit reached/i.test(lower)) {
      return { ...base, type: "Bot Stopped", tone: "system", detail: raw };
    }
    if (/reconnecting\b|websocket disconnected|stream error|session error/i.test(lower)) {
      return null;
    }

    return null;
  }

  function itemKey(row) {
    const seq = row?.seq;
    if (seq != null) return `seq:${seq}`;
    return `msg:${row?.ts || ""}:${row?.message || row}`;
  }

  function renderItem(entry, isNew) {
    const li = document.createElement("li");
    li.className = `activity-item ${TONE_CLASS[entry.tone] || TONE_CLASS.system}`;
    if (isNew) li.classList.add("activity-item--new");
    li.dataset.seq = String(entry.seq ?? "");

    const time = document.createElement("span");
    time.className = "activity-item__time";
    time.textContent = entry.ts;

    const type = document.createElement("span");
    type.className = "activity-item__type";
    type.textContent = entry.type;

    const detail = document.createElement("span");
    detail.className = "activity-item__detail";
    detail.textContent = entry.detail;

    li.append(time, type, detail);

    if (isNew) {
      window.setTimeout(() => li.classList.remove("activity-item--new"), 900);
    }
    return li;
  }

  function renderStream(container, prependNew) {
    if (!container) return;
    const empty = container.querySelector(".activity-stream__empty");
    if (!state.items.length) {
      if (!empty) {
        container.innerHTML = '<li class="activity-stream__empty">Waiting for activity…</li>';
      }
      return;
    }
    if (empty) empty.remove();

    if (!prependNew || !container.children.length) {
      container.innerHTML = "";
      state.items.forEach((entry) => container.appendChild(renderItem(entry, false)));
      container.scrollTop = 0;
      return;
    }

    const frag = document.createDocumentFragment();
    const newOnes = state.items.filter((e) => e._justAdded);
    newOnes.forEach((entry) => {
      entry._justAdded = false;
      frag.appendChild(renderItem(entry, true));
    });
    container.prepend(frag);
    container.scrollTop = 0;
  }

  function ingestRows(rows, { replace = false } = {}) {
    const list = document.getElementById("activityStream");
    if (!list) return;

    if (replace) {
      state.items = [];
      state.seen.clear();
    }

    let added = false;
    (rows || []).forEach((row) => {
      const key = itemKey(row);
      if (state.seen.has(key)) return;
      const classified = classifyEvent(row);
      if (!classified) return;
      state.seen.add(key);
      state.items.unshift({
        ...classified,
        seq: row.seq,
        _justAdded: !replace,
      });
      added = true;
    });

    state.items.sort((a, b) => Number(b.seq || 0) - Number(a.seq || 0));
    state.items = state.items.slice(0, MAX_ITEMS);

    if (added || replace) {
      renderStream(list, added && !replace);
    }
  }

  async function refreshActivityStream(requestJson) {
    const list = document.getElementById("activityStream");
    if (!list || typeof requestJson !== "function") return;

    try {
      const since = state.bootstrapped ? state.lastSeq : 0;
      const data = await requestJson(`/events?since_seq=${since}&limit=120`);
      const rows = data.events || [];
      if (Number.isFinite(Number(data.latest_seq))) {
        state.lastSeq = Number(data.latest_seq);
      }

      if (!state.bootstrapped) {
        ingestRows(rows.slice().reverse(), { replace: true });
        state.bootstrapped = true;
        return;
      }

      if (rows.length) {
        ingestRows(rows, { replace: false });
      }
    } catch (_err) {
      /* non-fatal */
    }
  }

  function resetActivityStream() {
    state.lastSeq = 0;
    state.bootstrapped = false;
    state.seen.clear();
    state.items = [];
    const list = document.getElementById("activityStream");
    if (list) {
      list.innerHTML = '<li class="activity-stream__empty">Waiting for activity…</li>';
    }
  }

  window.ActivityStream = {
    refresh: refreshActivityStream,
    reset: resetActivityStream,
    classifyEvent,
  };
})();
