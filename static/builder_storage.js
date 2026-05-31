/**
 * Bot Builder strategy persistence: DB library, local drafts, import/export, versions.
 * Does not execute trades; optional apply to bot config via existing /save-strategy.
 */

(function initBuilderStorageModule() {
  const AUTOSAVE_KEY = "builder.autosave.v1";
  const RECENT_LOCAL_KEY = "builder.recent.local.v1";
  const AUTOSAVE_MS = 12000;
  const DEBOUNCE_MS = 1500;

  let activeStrategyId = null;
  let autosaveTimer = null;
  let debounceTimer = null;
  let pendingTemplate = null;
  let confirmResolver = null;

  function deps() {
    return {
      requestJson: typeof requestJson === "function" ? requestJson : null,
      showToast: typeof showToast === "function" ? showToast : (m) => console.log(m),
      escapeHtml: typeof escapeHtml === "function" ? escapeHtml : (s) => String(s),
      setBuilderSaveStatus: window.setBuilderSaveStatus,
      syncBuilderStrategyHeader: window.syncBuilderStrategyHeader,
      markBuilderStrategyDirty: window.markBuilderStrategyDirty,
      touchBuilderEdited: window.touchBuilderEdited,
      renderBuilderTemplates: window.renderBuilderTemplateGroups,
    };
  }

  function formatTs(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "—";
    return new Date(n * 1000).toLocaleString();
  }

  function contractLabel(code) {
    const c = String(code || "").toUpperCase();
    if (c === "DIGITOVER") return "Digit Over";
    if (c === "DIGITUNDER") return "Digit Under";
    return c || "—";
  }

  function statusClass(status) {
    const s = String(status || "saved").toLowerCase();
    return `builder-library-card__status--${s.replace(/[^a-z]/g, "") || "saved"}`;
  }

  async function isBotRunning() {
    const { requestJson: req } = deps();
    if (!req) return false;
    try {
      const status = await req("/status");
      return !!status.running;
    } catch (_e) {
      return false;
    }
  }

  function showConfirm(title, message) {
    return new Promise((resolve) => {
      const modal = document.getElementById("builderConfirmModal");
      const titleEl = document.getElementById("builderConfirmTitle");
      const msgEl = document.getElementById("builderConfirmMessage");
      const okBtn = document.getElementById("builderConfirmOkBtn");
      const cancelBtn = document.getElementById("builderConfirmCancelBtn");
      if (!modal || !okBtn || !cancelBtn) {
        resolve(window.confirm(message));
        return;
      }
      if (titleEl) titleEl.textContent = title;
      if (msgEl) msgEl.textContent = message;
      modal.classList.remove("hidden");
      confirmResolver = resolve;
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      function cleanup(result) {
        modal.classList.add("hidden");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        confirmResolver = null;
        resolve(result);
      }
      okBtn.addEventListener("click", onOk, { once: true });
      cancelBtn.addEventListener("click", onCancel, { once: true });
    });
  }

  async function ensureCanReplaceWorkspace() {
    if (window.builderSaveDirty === true) {
      const ok = await showConfirm(
        "Unsaved changes",
        "The current workspace has unsaved changes. Replace it anyway?"
      );
      if (!ok) return false;
    }
    if (await isBotRunning()) {
      const stopOk = await showConfirm(
        "Bot is running",
        "Stop the bot before replacing the workspace? The bot will be stopped and the strategy will not auto-run."
      );
      if (!stopOk) return false;
      const { requestJson: req, showToast: toast } = deps();
      try {
        await req("/stop-bot", { method: "POST" });
        toast("Bot stopped");
      } catch (error) {
        toast(`Stop failed: ${error.message}`);
        return false;
      }
    }
    return true;
  }

  function readAutosaveDraft() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_e) {
      return null;
    }
  }

  function writeAutosaveDraft() {
    if (typeof getBuilderWorkspaceMeta !== "function") return;
    const meta = getBuilderWorkspaceMeta();
    const draft = {
      ...meta,
      active_strategy_id: activeStrategyId,
      saved_at: Date.now(),
    };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(draft));
  }

  function clearAutosaveDraft() {
    localStorage.removeItem(AUTOSAVE_KEY);
    document.getElementById("builderDraftRecoveryBanner")?.classList.add("hidden");
  }

  function scheduleAutosave() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      writeAutosaveDraft();
      if (window.markBuilderStrategyDirty) window.markBuilderStrategyDirty();
    }, DEBOUNCE_MS);
    if (autosaveTimer) clearInterval(autosaveTimer);
    autosaveTimer = setInterval(writeAutosaveDraft, AUTOSAVE_MS);
  }

  function renderStorageCard(item, actions) {
    const card = document.createElement("article");
    card.className = "builder-library-card";
    const status = item.status || "saved";
    card.innerHTML = `
      <div class="builder-library-card__head">
        <strong class="builder-library-card__name">${deps().escapeHtml(item.name || "Untitled")}</strong>
        <span class="builder-library-card__status ${statusClass(status)}">${deps().escapeHtml(status)}</span>
      </div>
      <p class="builder-library-card__contract subtle small">${deps().escapeHtml(contractLabel(item.contract_type || item.contract))} · ${deps().escapeHtml(item.market || "R_100")}</p>
      <p class="builder-library-card__desc subtle small">Edited ${formatTs(item.updated_at || item.saved_at / 1000)} · v${item.version ?? 1}</p>
      <div class="builder-library-card__actions"></div>`;
    const row = card.querySelector(".builder-library-card__actions");
    actions.forEach((action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn btn-sm ${action.primary ? "btn-blue" : ""}`;
      btn.textContent = action.label;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        action.onClick(item);
      });
      row.appendChild(btn);
    });
    return card;
  }

  async function refreshLibrary() {
    const { requestJson: req, escapeHtml: esc } = deps();
    const q = String(document.getElementById("builderStrategySearch")?.value || "")
      .trim()
      .toLowerCase();

    const savedHost = document.getElementById("builderLibrarySaved");
    const draftsHost = document.getElementById("builderLibraryDrafts");
    const recentHost = document.getElementById("builderLibraryRecent");
    const importedHost = document.getElementById("builderLibraryImported");
    const templatesHost = document.getElementById("builderLibraryTemplates");

    [savedHost, draftsHost, recentHost, importedHost, templatesHost].forEach((el) => {
      if (el) el.innerHTML = "";
    });

    let saved = [];
    let recent = [];
    let imported = [];
    if (req) {
      try {
        const [allRes, recentRes] = await Promise.all([
          req("/builder/strategies"),
          req("/builder/strategies/recent"),
        ]);
        saved = (allRes.strategies || []).filter((s) => s.status !== "imported");
        imported = (allRes.strategies || []).filter((s) => s.status === "imported");
        recent = recentRes.strategies || [];
      } catch (_e) {
        /* offline */
      }
    }

    const filterItem = (item) =>
      !q ||
      String(item.name || "")
        .toLowerCase()
        .includes(q) ||
      String(item.market || "")
        .toLowerCase()
        .includes(q);

    if (savedHost) {
      const rows = saved.filter(filterItem);
      if (!rows.length) {
        savedHost.innerHTML = `<p class="builder-library-empty subtle small">No saved strategies yet. Use Save or Save as.</p>`;
      } else {
        rows.forEach((item) => {
          savedHost.appendChild(
            renderStorageCard(item, [
              { label: "Load", primary: true, onClick: () => loadSavedStrategy(item.id) },
              { label: "Clone", onClick: () => cloneSavedStrategy(item.id) },
              { label: "Export", onClick: () => exportSavedStrategy(item.id) },
              { label: "Delete", onClick: () => deleteSavedStrategy(item.id) },
            ])
          );
        });
      }
    }

    if (draftsHost) {
      const draft = readAutosaveDraft();
      if (draft && filterItem(draft)) {
        draftsHost.appendChild(
          renderStorageCard(
            { ...draft, name: `${draft.name} (autosave)`, status: "draft", updated_at: draft.saved_at / 1000 },
            [
              { label: "Load", primary: true, onClick: () => restoreLocalDraft() },
              { label: "Discard", onClick: () => clearAutosaveDraft() },
            ]
          )
        );
      } else {
        draftsHost.innerHTML = `<p class="builder-library-empty subtle small">Autosaved drafts appear here while you edit.</p>`;
      }
    }

    if (recentHost) {
      const rows = recent.filter(filterItem);
      if (!rows.length) {
        recentHost.innerHTML = `<p class="builder-library-empty subtle small">Recently opened strategies will appear here.</p>`;
      } else {
        rows.forEach((item) => {
          recentHost.appendChild(
            renderStorageCard(item, [
              { label: "Load", primary: true, onClick: () => loadSavedStrategy(item.id) },
            ])
          );
        });
      }
    }

    if (importedHost) {
      const rows = imported.filter(filterItem);
      if (!rows.length) {
        importedHost.innerHTML = `<p class="builder-library-empty subtle small">Import JSON or XML to add strategies here.</p>`;
      } else {
        rows.forEach((item) => {
          importedHost.appendChild(
            renderStorageCard(item, [
              { label: "Load", primary: true, onClick: () => loadSavedStrategy(item.id) },
              { label: "Export", onClick: () => exportSavedStrategy(item.id) },
              { label: "Delete", onClick: () => deleteSavedStrategy(item.id) },
            ])
          );
        });
      }
    }

    if (templatesHost && typeof window.renderBuilderTemplateGroups === "function") {
      window.renderBuilderTemplateGroups(templatesHost, q, previewTemplate);
    } else if (templatesHost) {
      templatesHost.innerHTML = `<p class="builder-library-empty subtle small">Templates load from the quick strategy wizard.</p>`;
    }
  }

  function previewTemplate(item) {
    pendingTemplate = item;
    const modal = document.getElementById("builderTemplatePreviewModal");
    const title = document.getElementById("builderTemplatePreviewTitle");
    const meta = document.getElementById("builderTemplatePreviewMeta");
    if (!modal || !meta) return;
    if (title) title.textContent = item.label || "Template";
    meta.innerHTML = `
      <div><dt>Contract</dt><dd>${deps().escapeHtml(contractLabel(item.contract))}</dd></div>
      <div><dt>Risk</dt><dd>${deps().escapeHtml(item.risk || "Medium")}</dd></div>
      <div><dt>Stake</dt><dd>$${Number(item.stake ?? 1).toFixed(2)}</dd></div>
      <div><dt>Description</dt><dd>${deps().escapeHtml(item.desc || "")}</dd></div>`;
    modal.classList.remove("hidden");
  }

  async function applyTemplateToWorkspace(item) {
    if (!(await ensureCanReplaceWorkspace())) return;
    if (typeof window.applyBuilderStrategyFromTemplate === "function") {
      window.applyBuilderStrategyFromTemplate(item, { skipConfirm: true });
    }
    document.getElementById("builderTemplatePreviewModal")?.classList.add("hidden");
    pendingTemplate = null;
    if (window.setBuilderSaveStatus) window.setBuilderSaveStatus(false);
    scheduleAutosave();
    refreshLibrary();
  }

  async function loadSavedStrategy(id, applyBot = true) {
    const { requestJson: req, showToast: toast } = deps();
    if (!req) return;
    if (!(await ensureCanReplaceWorkspace())) return;
    try {
      const res = await req(`/builder/strategies/${encodeURIComponent(id)}`);
      const row = res.strategy;
      if (!loadStrategyRecord(row)) {
        throw new Error("Could not restore workspace blocks");
      }
      activeStrategyId = row.id;
      updateHeaderFromRecord(row);
      if (window.setBuilderSaveStatus) window.setBuilderSaveStatus(true);
      if (applyBot && row.strategy) {
        await req("/save-strategy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(row.strategy),
        });
      }
      await req(`/builder/strategies/${encodeURIComponent(id)}/open`, { method: "POST" });
      clearAutosaveDraft();
      toast(`Loaded ${row.name}`);
      if (window.syncBuilderStrategyHeader) window.syncBuilderStrategyHeader();
      if (window.touchBuilderEdited) window.touchBuilderEdited();
      refreshLibrary();
    } catch (error) {
      toast(`Load failed: ${error.message}`);
    }
  }

  function loadStrategyRecord(row) {
    if (!row) return false;
    if (typeof loadBuilderStrategyBundle === "function") {
      return loadBuilderStrategyBundle({
        strategy: row.strategy,
        blockly_xml: row.blockly_xml,
      });
    }
    return false;
  }

  function updateHeaderFromRecord(row) {
    const nameEl = document.getElementById("builderStrategyName");
    if (nameEl) nameEl.textContent = row.name || "Strategy";
    const sym = document.getElementById("builderHeaderSymbol");
    if (sym) sym.textContent = row.market || "R_100";
    const contract = document.getElementById("builderHeaderContract");
    if (contract) contract.textContent = contractLabel(row.contract_type);
    const stake = document.getElementById("builderHeaderStake");
    if (stake) stake.textContent = `$${Number(row.stake ?? 1).toFixed(2)}`;
    const edited = document.getElementById("builderHeaderEdited");
    if (edited) edited.textContent = `Last edited ${formatTs(row.updated_at)}`;
  }

  async function saveStrategyFlow({ saveAs = false } = {}) {
    const modal = document.getElementById("builderSaveModal");
    const title = document.getElementById("builderSaveModalTitle");
    const nameInput = document.getElementById("builderSaveName");
    const marketInput = document.getElementById("builderSaveMarket");
    const contractInput = document.getElementById("builderSaveContract");
    if (!modal || typeof getBuilderWorkspaceMeta !== "function") return;

    const meta = getBuilderWorkspaceMeta();
    if (title) title.textContent = saveAs || !activeStrategyId ? "Save strategy as" : "Save strategy";
    if (nameInput) nameInput.value = meta.name || "Strategy";
    if (marketInput) marketInput.value = meta.market || "R_100";
    if (contractInput) contractInput.value = meta.contract_type || "DIGITUNDER";

    return new Promise((resolve) => {
      modal.classList.remove("hidden");
      const confirmBtn = document.getElementById("builderSaveConfirmBtn");
      const cancelBtn = document.getElementById("builderSaveCancelBtn");
      const onCancel = () => {
        modal.classList.add("hidden");
        cleanup();
        resolve(false);
      };
      const onConfirm = async () => {
        const payload = {
          id: saveAs ? undefined : activeStrategyId || undefined,
          name: String(nameInput?.value || meta.name).trim(),
          market: String(marketInput?.value || meta.market).trim(),
          contract_type: String(contractInput?.value || meta.contract_type),
          stake: meta.stake,
          risk_level: meta.risk_level,
          status: "saved",
          strategy: meta.strategy,
          blockly_xml: meta.blockly_xml,
        };
        const applyBot = !!document.getElementById("builderSaveApplyBot")?.checked;
        const ok = await persistStrategy(payload, applyBot);
        modal.classList.add("hidden");
        cleanup();
        resolve(ok);
      };
      function cleanup() {
        confirmBtn?.removeEventListener("click", onConfirm);
        cancelBtn?.removeEventListener("click", onCancel);
      }
      confirmBtn?.addEventListener("click", onConfirm, { once: true });
      cancelBtn?.addEventListener("click", onCancel, { once: true });
    });
  }

  async function persistStrategy(payload, applyBot = true) {
    const { requestJson: req, showToast: toast } = deps();
    if (!req || !payload.strategy) return false;
    try {
      const res = await req("/builder/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const saved = res.strategy;
      activeStrategyId = saved.id;
      updateHeaderFromRecord(saved);
      if (applyBot) {
        await req("/save-strategy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(saved.strategy),
        });
      }
      const outputEl = document.getElementById("strategyOutput");
      if (outputEl) outputEl.textContent = JSON.stringify(saved.strategy, null, 2);
      if (window.setBuilderSaveStatus) window.setBuilderSaveStatus(true);
      if (window.touchBuilderEdited) window.touchBuilderEdited();
      clearAutosaveDraft();
      toast("Strategy saved");
      refreshLibrary();
      return true;
    } catch (error) {
      toast(`Save failed: ${error.message}`);
      return false;
    }
  }

  async function cloneSavedStrategy(id) {
    const { requestJson: req, showToast: toast } = deps();
    try {
      const res = await req(`/builder/strategies/${encodeURIComponent(id)}`);
      const row = res.strategy;
      await persistStrategy(
        {
          name: `${row.name} (copy)`,
          market: row.market,
          contract_type: row.contract_type,
          stake: row.stake,
          risk_level: row.risk_level,
          status: "saved",
          strategy: row.strategy,
          blockly_xml: row.blockly_xml,
        },
        false
      );
    } catch (error) {
      toast(`Clone failed: ${error.message}`);
    }
  }

  async function deleteSavedStrategy(id) {
    const ok = await showConfirm("Delete strategy", "Delete this saved strategy permanently?");
    if (!ok) return;
    const { requestJson: req, showToast: toast } = deps();
    try {
      await req(`/builder/strategies/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (activeStrategyId === id) activeStrategyId = null;
      toast("Strategy deleted");
      refreshLibrary();
    } catch (error) {
      toast(`Delete failed: ${error.message}`);
    }
  }

  async function exportSavedStrategy(id) {
    const { requestJson: req } = deps();
    const res = await req(`/builder/strategies/${encodeURIComponent(id)}`);
    downloadJson(`${res.strategy.name || "strategy"}.json`, {
      format: "derivbot-builder-strategy",
      version: 1,
      exported_at: new Date().toISOString(),
      name: res.strategy.name,
      market: res.strategy.market,
      contract_type: res.strategy.contract_type,
      stake: res.strategy.stake,
      risk_level: res.strategy.risk_level,
      strategy: res.strategy.strategy,
      blockly_xml: res.strategy.blockly_xml,
    });
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportCurrentJson() {
    if (typeof exportBuilderStrategyJson !== "function") return;
    const data = exportBuilderStrategyJson({ id: activeStrategyId });
    downloadJson(`${data.name || "strategy"}.json`, data);
    deps().showToast("Strategy exported as JSON");
  }

  function exportCurrentXml() {
    if (typeof exportBuilderWorkspaceXml !== "function") return;
    const xml = exportBuilderWorkspaceXml();
    const name =
      document.getElementById("builderStrategyName")?.textContent?.trim() || "strategy";
    downloadText(`${name.replace(/\s+/g, "_")}.xml`, xml, "text/xml");
    deps().showToast("Workspace exported as XML");
  }

  async function importFromFile(file) {
    const { requestJson: req, showToast: toast } = deps();
    if (!file) return;
    const text = await file.text();
    const isXml = file.name.toLowerCase().endsWith(".xml") || text.trim().startsWith("<");
    let bundle;
    if (isXml) {
      bundle = { blockly_xml: text, name: file.name.replace(/\.xml$/i, "") };
    } else {
      bundle = JSON.parse(text);
    }
    try {
      const validated = await req("/builder/strategies/validate-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });
      if (!(await ensureCanReplaceWorkspace())) return;
      if (validated.blockly_xml && typeof loadBuilderXml === "function") {
        loadBuilderXml(validated.blockly_xml);
      } else if (validated.strategy && typeof loadStrategyIntoWorkspace === "function") {
        loadStrategyIntoWorkspace(validated.strategy);
      }
      const meta =
        typeof getBuilderWorkspaceMeta === "function" ? getBuilderWorkspaceMeta() : {};
      const importRes = await req("/builder/strategies/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: bundle.name || validated.name || meta.name,
          market: bundle.market || validated.market || meta.market,
          contract_type: bundle.contract_type || validated.contract_type || meta.contract_type,
          stake: bundle.stake ?? validated.stake ?? meta.stake,
          risk_level: bundle.risk_level || validated.risk_level || meta.risk_level,
          strategy: validated.strategy || bundle.strategy || meta.strategy,
          blockly_xml: validated.blockly_xml || bundle.blockly_xml || meta.blockly_xml,
          status: "imported",
        }),
      });
      activeStrategyId = importRes.strategy?.id || null;
      if (importRes.strategy) updateHeaderFromRecord(importRes.strategy);
      if (window.setBuilderSaveStatus) window.setBuilderSaveStatus(true);
      toast("Strategy imported (bot remains stopped)");
      refreshLibrary();
    } catch (error) {
      const detail = error?.detail?.errors || error.message;
      toast(`Import failed: ${Array.isArray(detail) ? detail.join("; ") : detail}`);
    }
  }

  async function openLoadModal() {
    const modal = document.getElementById("builderLoadModal");
    const list = document.getElementById("builderLoadList");
    if (!modal || !list) return;
    modal.classList.remove("hidden");
    const render = async () => {
      const q = String(document.getElementById("builderLoadSearch")?.value || "").trim();
      const { requestJson: req } = deps();
      list.innerHTML = "";
      try {
        const res = await req(`/builder/strategies${q ? `?q=${encodeURIComponent(q)}` : ""}`);
        const rows = res.strategies || [];
        if (!rows.length) {
          list.innerHTML = `<p class="subtle small">No strategies found.</p>`;
          return;
        }
        rows.forEach((item) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "builder-load-row";
          row.innerHTML = `<span><strong>${deps().escapeHtml(item.name)}</strong><br/><span class="subtle small">${deps().escapeHtml(contractLabel(item.contract_type))} · ${deps().escapeHtml(item.market)} · v${item.version}</span></span><span>›</span>`;
          row.addEventListener("click", async () => {
            modal.classList.add("hidden");
            await loadSavedStrategy(item.id);
          });
          list.appendChild(row);
        });
      } catch (error) {
        list.innerHTML = `<p class="subtle small">Could not load strategies: ${deps().escapeHtml(error.message)}</p>`;
      }
    };
    await render();
    document.getElementById("builderLoadSearch")?.addEventListener("input", render);
  }

  async function openVersionsModal() {
    if (!activeStrategyId) {
      deps().showToast("Save the strategy first to view version history");
      return;
    }
    const modal = document.getElementById("builderVersionsModal");
    const list = document.getElementById("builderVersionsList");
    const sub = document.getElementById("builderVersionsSubtitle");
    if (!modal || !list) return;
    modal.classList.remove("hidden");
    const { requestJson: req, showToast: toast } = deps();
    try {
      const res = await req(`/builder/strategies/${encodeURIComponent(activeStrategyId)}/versions`);
      const versions = res.versions || [];
      if (sub) sub.textContent = `${versions.length} version(s) on file`;
      list.innerHTML = "";
      versions.forEach((v) => {
        const row = document.createElement("div");
        row.className = "builder-version-row";
        row.innerHTML = `<div><strong>v${v.version}</strong> · ${formatTs(v.created_at)}<br/><span class="subtle small">${deps().escapeHtml(v.name)} · ${deps().escapeHtml(contractLabel(v.contract_type))}</span></div>`;
        const restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.className = "btn btn-sm btn-blue";
        restoreBtn.textContent = "Restore";
        restoreBtn.addEventListener("click", async () => {
          if (!(await ensureCanReplaceWorkspace())) return;
          try {
            const restored = await req(
              `/builder/strategies/${encodeURIComponent(activeStrategyId)}/versions/${v.version}/restore`,
              { method: "POST" }
            );
            loadStrategyRecord(restored.strategy);
            updateHeaderFromRecord(restored.strategy);
            toast(`Restored version ${v.version}`);
            modal.classList.add("hidden");
            refreshLibrary();
          } catch (error) {
            toast(`Restore failed: ${error.message}`);
          }
        });
        row.appendChild(restoreBtn);
        list.appendChild(row);
      });
    } catch (error) {
      list.innerHTML = `<p class="subtle small">${deps().escapeHtml(error.message)}</p>`;
    }
  }

  async function newStrategy() {
    if (!(await ensureCanReplaceWorkspace())) return;
    if (typeof resetBuilderWorkspaceToDefault === "function") {
      resetBuilderWorkspaceToDefault();
    }
    activeStrategyId = null;
    if (window.setBuilderSaveStatus) window.setBuilderSaveStatus(false);
    if (window.syncBuilderStrategyHeader) window.syncBuilderStrategyHeader();
    clearAutosaveDraft();
    deps().showToast("New strategy workspace");
    scheduleAutosave();
  }

  function restoreLocalDraft() {
    const draft = readAutosaveDraft();
    if (!draft) return;
    loadBuilderStrategyBundle(draft);
    activeStrategyId = draft.active_strategy_id || null;
    updateHeaderFromRecord({
      name: draft.name,
      market: draft.market,
      contract_type: draft.contract_type,
      stake: draft.stake,
      updated_at: draft.saved_at / 1000,
    });
    if (window.setBuilderSaveStatus) window.setBuilderSaveStatus(false);
    clearAutosaveDraft();
    deps().showToast("Draft restored");
  }

  function checkRecoveryBanner() {
    const draft = readAutosaveDraft();
    const banner = document.getElementById("builderDraftRecoveryBanner");
    if (!banner) return;
    if (draft && draft.saved_at && Date.now() - draft.saved_at < 7 * 24 * 3600 * 1000) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  function wireFileMenu() {
    const btn = document.getElementById("builderFileMenuBtn");
    const panel = document.getElementById("builderFileMenuPanel");
    if (!btn || !panel) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = panel.classList.toggle("hidden");
      btn.setAttribute("aria-expanded", open ? "false" : "true");
    });
    document.addEventListener("click", () => {
      panel.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    });
    panel.querySelectorAll("[data-file-action]").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        panel.classList.add("hidden");
        const action = item.dataset.fileAction;
        if (action === "new") newStrategy();
        if (action === "save") saveStrategyFlow({ saveAs: false });
        if (action === "save-as") saveStrategyFlow({ saveAs: true });
        if (action === "load") openLoadModal();
        if (action === "import") document.getElementById("builderImportFileInput")?.click();
        if (action === "export-json") exportCurrentJson();
        if (action === "export-xml") exportCurrentXml();
        if (action === "versions") openVersionsModal();
      });
    });
  }

  window.initBuilderStorage = function initBuilderStorage() {
    window.builderSaveDirty = false;
    window.setBuilderSaveStatus =
      window.setBuilderSaveStatus ||
      function (saved) {
        window.builderSaveDirty = !saved;
        const el = document.getElementById("builderSaveStatus");
        if (!el) return;
        el.textContent = saved ? "Saved" : "Unsaved";
        el.classList.toggle("builder-save-status--dirty", !saved);
      };

    wireFileMenu();
    document.getElementById("builderHeaderSaveBtn")?.addEventListener("click", () =>
      saveStrategyFlow({ saveAs: false })
    );
    document.getElementById("builderDraftRestoreBtn")?.addEventListener("click", restoreLocalDraft);
    document.getElementById("builderDraftDiscardBtn")?.addEventListener("click", clearAutosaveDraft);
    document.getElementById("builderTemplateUseBtn")?.addEventListener("click", () => {
      if (pendingTemplate) applyTemplateToWorkspace(pendingTemplate);
    });
    document.getElementById("builderTemplatePreviewCloseBtn")?.addEventListener("click", () => {
      document.getElementById("builderTemplatePreviewModal")?.classList.add("hidden");
      pendingTemplate = null;
    });
    document.getElementById("builderLoadCancelBtn")?.addEventListener("click", () => {
      document.getElementById("builderLoadModal")?.classList.add("hidden");
    });
    document.getElementById("builderVersionsCloseBtn")?.addEventListener("click", () => {
      document.getElementById("builderVersionsModal")?.classList.add("hidden");
    });
    document.getElementById("builderImportFileInput")?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      importFromFile(file);
      e.target.value = "";
    });
    document.getElementById("builderStrategySearch")?.addEventListener("input", () => refreshLibrary());

    checkRecoveryBanner();
    scheduleAutosave();
    refreshLibrary();

    window.BuilderStorage = {
      refreshLibrary,
      saveStrategyFlow,
      loadSavedStrategy,
      openLoadModal,
      exportCurrentJson,
      exportCurrentXml,
      ensureCanReplaceWorkspace,
      previewTemplate,
      activeStrategyId: () => activeStrategyId,
      setActiveStrategyId: (id) => {
        activeStrategyId = id;
      },
    };
  };
})();
