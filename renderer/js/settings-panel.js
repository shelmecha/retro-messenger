"use strict";

// In-window settings dialog. Namespace: window.SettingsPanel
(function () {
  const $ = (id) => document.getElementById(id);
  let onSavedCb = null;

  async function open(opts) {
    onSavedCb = (opts && opts.onSaved) || null;
    const cfg = await window.retro.settings.get();
    $("n8nUrl").value = cfg.n8nBaseUrl || "";
    $("chkMock").checked = !!cfg.mockMode;
    $("chkAuto").checked = !!cfg.autoLaunch;
    $("chkSounds").checked = !!cfg.sounds;
    setTestResult("", null);
    $("settingsOverlay").classList.remove("hidden");
  }

  function close() {
    $("settingsOverlay").classList.add("hidden");
  }

  function setTestResult(text, ok) {
    const el = $("testResult");
    el.textContent = text;
    el.classList.remove("ok", "err");
    if (ok === true) el.classList.add("ok");
    else if (ok === false) el.classList.add("err");
  }

  async function save() {
    const next = await window.retro.settings.set({
      n8nBaseUrl: $("n8nUrl").value.trim(),
      mockMode: $("chkMock").checked,
      autoLaunch: $("chkAuto").checked,
      sounds: $("chkSounds").checked,
    });
    close();
    if (onSavedCb) onSavedCb(next);
  }

  async function test() {
    setTestResult("Testing…", null);
    // Persist current field values first so the client uses them.
    await window.retro.settings.set({
      n8nBaseUrl: $("n8nUrl").value.trim(),
      mockMode: $("chkMock").checked,
    });
    const r = await window.retro.triage.latest();
    if (r && r.ok) setTestResult(r.mock ? "✓ Demo mode OK" : "✓ Connected", true);
    else setTestResult("✗ " + ((r && r.message) || "Failed"), false);
  }

  function wire() {
    $("settingsClose").onclick = close;
    $("btnCancelSettings").onclick = close;
    $("btnSaveSettings").onclick = save;
    $("btnTest").onclick = test;
  }

  window.SettingsPanel = { open, close, wire };
})();
