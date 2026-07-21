"use strict";

// Menu-driven conversation state machine. Namespace: window.Flows
(function () {
  const UI = window.ChatUI;
  const T = window.Triage;

  let summary = null;
  let sessionActed = 0;

  // ---- daily win tracking (localStorage) --------------------------------
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  function getWins() {
    try {
      const w = JSON.parse(localStorage.getItem("handledToday") || "null");
      if (!w || w.date !== todayStr()) return { date: todayStr(), count: 0 };
      return w;
    } catch {
      return { date: todayStr(), count: 0 };
    }
  }
  function bumpWin(delta) {
    const w = getWins();
    w.count = Math.max(0, w.count + (delta == null ? 1 : delta));
    localStorage.setItem("handledToday", JSON.stringify(w));
    UI.setWinChip(w.count);
    return w.count;
  }

  // ---- handled/moved persistence (survives refresh + restart) -----------
  // handledIds: { emailId: savedAtMs }  · movedItems: { emailId: bucketKey }
  const DAY = 86400000;
  function loadStore(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}") || {};
    } catch {
      return {};
    }
  }
  function saveStore(key, obj) {
    localStorage.setItem(key, JSON.stringify(obj));
  }
  let handledIds = loadStore("handledIds");
  let movedItems = loadStore("movedItems");
  // Prune handled entries older than 14 days so the store can't grow forever.
  (function pruneHandled() {
    const now = Date.now();
    let changed = false;
    Object.keys(handledIds).forEach((id) => {
      if (now - handledIds[id] > 14 * DAY) {
        delete handledIds[id];
        changed = true;
      }
    });
    if (changed) saveStore("handledIds", handledIds);
  })();

  // Re-apply persisted handled flags + bucket moves onto a freshly loaded summary.
  function applyPersistence() {
    if (!summary) return;
    // Move any cleaned items the user previously rescued into their target bucket.
    const cleaned = summary.cleanedUp || [];
    for (let i = cleaned.length - 1; i >= 0; i--) {
      const it = cleaned[i];
      const to = movedItems[it.id];
      if (to && summary[to]) {
        cleaned.splice(i, 1);
        summary[to].unshift(it);
      }
    }
    // Flag handled items across every bucket.
    T.ORDER.forEach((k) => {
      (summary[k] || []).forEach((it) => {
        it._handled = !!handledIds[it.id];
      });
    });
  }

  // ---- session progress ---------------------------------------------------
  // Everything except cleanedUp counts toward the bar (cleaned = already done).
  const PROGRESS_KEYS = () => T.ORDER.filter((k) => k !== "cleanedUp");
  let celebrated = false;

  function actionableItems() {
    if (!summary) return [];
    return PROGRESS_KEYS().flatMap((k) => summary[k] || []);
  }

  function updateProgress() {
    const items = actionableItems();
    const done = items.filter((i) => i._handled).length;
    UI.setProgress(done, items.length);
    if (items.length > 0 && done === items.length && !celebrated) {
      celebrated = true;
      UI.addBotMsg("🏆 That's EVERYTHING — you cleared the whole board. Look at that full bar!");
      window.retro.win.nudge();
      playBlip();
    }
  }

  // Card callback: keeps the win chip, session count, progress bar, and the
  // persistent stores honest.
  function onCardChange(item, evt) {
    const type = evt && evt.type;
    if (type === "moved") {
      // Rescue from cleanedUp into a real bucket (in-app only).
      const to = evt.to;
      const arr = summary.cleanedUp || [];
      const idx = arr.indexOf(item);
      if (idx !== -1) arr.splice(idx, 1);
      if (summary[to]) summary[to].unshift(item);
      movedItems[item.id] = to;
      saveStore("movedItems", movedItems);
      updateProgress(); // total grows by 1 — honest countdown
      return;
    }
    if (type === "undone") {
      sessionActed = Math.max(0, sessionActed - 1);
      bumpWin(-1);
      delete handledIds[item.id];
      saveStore("handledIds", handledIds);
    } else {
      sessionActed += 1;
      bumpWin(1);
      handledIds[item.id] = Date.now();
      saveStore("handledIds", handledIds);
    }
    updateProgress();
  }

  function playBlip() {
    // Sounds are opt-in; guarded by settings in app.js via window.__retroSounds.
    if (!window.__retroSounds) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 660;
      g.gain.value = 0.05;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      o.stop(ctx.currentTime + 0.26);
    } catch {
      /* ignore */
    }
  }

  // ---- states -----------------------------------------------------------
  function greet(returning) {
    UI.setBuddyStatus("Online — ready to help");
    UI.addBotMsg(returning ? "Welcome back, Shelvi! 👋 Want me to check your inbox?" : "Hey Shelvi! 👋 I'm your inbox buddy. What can I do for you?");
    menu();
  }

  function menu() {
    UI.setChips([
      { label: "What's the most important thing in my email? 📬", onClick: () => runTriage(true) },
      { label: "Show last summary", onClick: () => runTriage(false) },
      { label: "⚙️ Settings", echo: "Open settings", onClick: openSettings },
    ]);
  }

  async function runTriage(fresh) {
    UI.setBuddyStatus("Reading your inbox…");
    UI.showTyping();
    UI.addBotMsg(fresh ? "On it — reading your inbox. This can take ~30 seconds. ⏳" : "Pulling up your last summary…");
    UI.scrollToEnd();

    const r = fresh ? await window.retro.triage.run() : await window.retro.triage.latest();
    UI.hideTyping();
    UI.setBuddyStatus("Online — ready to help");

    if (!r || !r.ok) return showError(r, fresh);

    UI.setStatusDot(r.mock ? "demo" : "live");
    summary = r.data || {};
    sessionActed = 0;
    celebrated = false;
    applyPersistence();
    updateProgress();
    overview();
  }

  async function syncNew() {
    const button = document.getElementById("btnSyncNew");
    button.disabled = true;
    button.classList.add("busy");
    UI.setBuddyStatus("Checking for new unread mail…");
    try {
      const r = await window.retro.triage.syncNew();
      if (!r || !r.ok || !r.data) return showError(r, true);
      summary = r.data;
      celebrated = false;
      applyPersistence();
      updateProgress();
      const count = Number(r.data.addedCount || 0);
      UI.addBotMsg(count ? `Added ${count} new unread email${count === 1 ? "" : "s"} to your board. 📬` : "No new unread emails since your last sync. Your board is unchanged. ✓");
      overview();
    } finally {
      button.disabled = false;
      button.classList.remove("busy");
      UI.setBuddyStatus("Online — ready to help");
    }
  }

  async function learnTone() {
    const button = document.getElementById("btnLearnTone");
    button.disabled = true;
    button.classList.add("busy");
    UI.setBuddyStatus("Learning your writing style…");
    try {
      const r = await window.retro.triage.learnTone();
      if (r && r.ok) {
        const count = Number((r.data && r.data.done) || 0);
        UI.addBotMsg(`Writing style updated from ${count} sent email${count === 1 ? "" : "s"}. Future reply suggestions will sound more like you. ✍️`);
      } else {
        UI.addBotMsg("I couldn't update your writing style: " + ((r && r.message) || "try again shortly."));
      }
      menu();
    } finally {
      button.disabled = false;
      button.classList.remove("busy");
      UI.setBuddyStatus("Online — ready to help");
    }
  }

  // Remaining (unhandled) items in a bucket — the counts users see tick down.
  function bucketItems(key) {
    return ((summary && summary[key]) || []).filter((i) => !i._handled);
  }

  function bucketCount(key) {
    return bucketItems(key).length;
  }

  function overview() {
    if (summary && summary.headline) UI.addBotMsg(summary.headline);

    const parts = [];
    T.ORDER.forEach((key) => {
      const n = bucketCount(key);
      if (n) parts.push(`${n} ${T.BUCKETS[key].chip.replace(/^[^ ]+ /, "").toLowerCase()}`);
    });

    if (!parts.length) {
      const total = actionableItems().length;
      UI.addBotMsg(
        total > 0
          ? "Everything's handled — nothing left in any pile. 🎉"
          : "Your inbox is clear — nothing needs you right now. Enjoy the quiet. 🌿"
      );
      UI.setChips([{ label: "Back to menu", onClick: () => menu() }]);
      return;
    }

    UI.addBotMsg("Here's the shape of it: " + parts.join(" · ") + ". Which pile do you want to tackle?");

    const chips = [];
    T.ORDER.forEach((key) => {
      const n = bucketCount(key);
      if (n) chips.push({ label: `${T.BUCKETS[key].chip} (${n})`, echo: T.BUCKETS[key].chip, onClick: () => openBucket(key) });
    });
    chips.push({ label: "I'm done ✅", onClick: () => finish() });
    UI.setChips(chips);
  }

  function openBucket(key) {
    const items = key === "cleanedUp" ? (summary && summary[key]) || [] : bucketItems(key);
    if (!items.length) {
      UI.addBotMsg(`${T.BUCKETS[key].badge} — nothing left here. 🎉`);
    } else {
      UI.addBotMsg(`${T.BUCKETS[key].badge} — ${items.length} item${items.length === 1 ? "" : "s"}:`);
      items.forEach((item) => {
        const card = T.makeCard(key, item, onCardChange);
        UI.addElement(card);
      });
    }
    // Bucket view shows only "Back to summary" — "I'm done" lives on the summary page.
    UI.setChips([{ label: "← Back to summary", echo: "Back", onClick: () => overview() }]);
  }

  function finish() {
    if (sessionActed > 0) {
      UI.addBotMsg(`Nice — you handled ${sessionActed} thing${sessionActed === 1 ? "" : "s"}. That's a win. 🌿`);
    } else {
      UI.addBotMsg("All good — ping me whenever you want another sweep. 🌿");
    }
    window.retro.win.nudge();
    playBlip();

    const unread = (summary && summary.unreadCount) || 0;
    if (unread > 0) {
      const label = unread >= 100 ? "100+" : String(unread);
      UI.addBotMsg(`You've still got ${label} unread sitting in the inbox. Want me to mark them all read for a clean slate?`);
      UI.setChips([
        { label: `🧹 Yes, mark all read`, echo: "Clean sweep", onClick: () => cleanSweep() },
        { label: "Leave them", onClick: () => menu() },
      ]);
      return;
    }
    UI.setChips([{ label: "Back to menu", onClick: () => menu() }]);
  }

  async function cleanSweep() {
    UI.showTyping();
    const r = await window.retro.action.markAllRead();
    UI.hideTyping();
    if (r && r.ok) {
      if (summary) summary.unreadCount = 0;
      UI.addBotMsg("Swept the inbox — you're at zero unread. Breathe easy. 🌿");
      window.retro.win.nudge();
      playBlip();
    } else if (r && r.code === "NOT_SUPPORTED") {
      UI.addBotMsg("That needs the Apps Script backend — your current one can't mark-all-read.");
    } else {
      UI.addBotMsg("Couldn't do the sweep: " + ((r && r.message) || "error"));
    }
    UI.setChips([{ label: "Back to menu", onClick: () => menu() }]);
  }

  function showError(r, wasFresh) {
    UI.setStatusDot("error");
    const code = (r && r.code) || "NETWORK";
    let msg;
    if (code === "NOT_CONFIGURED") {
      msg = "My email brain isn't hooked up yet. Add your backend URL in Settings, or try Demo mode. 🛠️";
    } else if (code === "TIMEOUT") {
      msg = "That took too long and timed out. The inbox scan can be slow — want to retry?";
    } else if (code === "BAD_RESPONSE") {
      msg =
        "Your backend answered, but not with a real summary — usually that means the script crashed, " +
        "or the live deployment is an older version. In Apps Script: check the Execution log, then " +
        "Deploy → Manage deployments → ✏️ → New version → Deploy.";
    } else if (code === "BACKEND_ERROR") {
      msg = (r && r.message) || "The backend hit an error. It's often temporary (Gemini busy) — try again in a minute.";
    } else if (code.startsWith("HTTP_")) {
      msg = `The backend answered with an error (${code.slice(5)}). Is it active and deployed?`;
    } else {
      msg = "I couldn't reach your backend. Check the URL in Settings and that it's running.";
    }
    UI.addBotMsg(msg);
    UI.setChips([
      { label: "🔁 Retry", onClick: () => runTriage(wasFresh) },
      { label: "🎭 Use demo mode", echo: "Use demo mode", onClick: enableDemoAndRetry },
      { label: "⚙️ Settings", echo: "Open settings", onClick: openSettings },
    ]);
  }

  async function enableDemoAndRetry() {
    await window.retro.settings.set({ mockMode: true });
    UI.addBotMsg("Demo mode on — showing you a sample inbox. 🎭");
    runTriage(true);
  }

  function openSettings() {
    window.SettingsPanel.open({
      onSaved: (cfg) => {
        UI.setStatusDot(cfg.mockMode ? "demo" : cfg.n8nBaseUrl ? "live" : "error");
        window.__retroSounds = !!cfg.sounds;
        UI.addBotMsg("Settings saved. 👍");
        menu();
      },
      onClosed: () => menu(),
    });
  }

  window.Flows = { greet, menu, openSettings, getWins, syncNew, learnTone };
})();
