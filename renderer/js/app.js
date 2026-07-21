"use strict";

// Boot + title-bar wiring. Namespace: window.App
(function () {
  const UI = window.ChatUI;

  async function boot() {
    // Title-bar buttons.
    document.getElementById("btnMin").onclick = () => window.retro.win.minimize();
    document.getElementById("btnClose").onclick = () => window.retro.win.close();
    document.getElementById("btnSettingsTitle").onclick = () => window.Flows.openSettings();
    document.getElementById("btnSyncNew").onclick = () => window.Flows.syncNew();
    document.getElementById("btnLearnTone").onclick = () => window.Flows.learnTone();

    window.SettingsPanel.wire();

    // Show the app version in the title bar (and Settings footer if present).
    try {
      const v = await window.retro.getVersion();
      const tv = document.getElementById("titleVersion");
      if (tv) tv.textContent = " v" + v;
      const sv = document.getElementById("settingsVersion");
      if (sv) sv.textContent = "v" + v;
    } catch {
      /* ignore */
    }

    // Load settings → status dot + sounds flag.
    const cfg = await window.retro.settings.get();
    window.__retroSounds = !!cfg.sounds;
    UI.setStatusDot(cfg.mockMode ? "demo" : cfg.n8nBaseUrl ? "live" : "error");

    // Restore today's win chip.
    UI.setWinChip(window.Flows.getWins().count);

    // Re-greet on wake without replacing the focused board. New mail is added
    // only through the deliberate header sync button.
    let greetedOnce = false;
    window.retro.onWake(async () => {
      if (!greetedOnce) return;
      window.ChatUI.addBotMsg("Welcome back! 👋 Your board is right where you left it. Tap ↻ when you want new mail.");
      window.Flows.menu();
    });

    // Auto-update: quiet while downloading, then offer a one-click restart.
    if (window.retro.update) {
      window.retro.update.onReady((p) => {
        window.ChatUI.addBotMsg(
          `🔄 Update ready${p && p.version ? " (v" + p.version + ")" : ""} — restart to apply the latest.`
        );
        const tray = document.getElementById("chipTray");
        const b = document.createElement("button");
        b.className = "default";
        b.textContent = "🔄 Restart & update";
        b.onclick = () => window.retro.update.install();
        tray.prepend(b);
      });
    }

    window.Flows.greet(false);
    greetedOnce = true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.App = { boot };
})();
