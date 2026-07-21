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

  async function syncNew() {
    const button = document.getElementById("btnSyncNew");
    button.disabled = true;
    UI.setBuddyStatus("Checking for new mail…");
    UI.addBotMsg("Checking only for new unread mail — your current board will stay put. ↻");
    const r = await window.retro.triage.syncNew();
    button.disabled = false;
    UI.setBuddyStatus("Online — ready to help");
    if (!r || !r.ok || !r.data) return showError(r, false);
    const incoming = r.data;
    const added = Number(incoming.addedCount || 0);
    if (!added) {
      UI.addBotMsg("No new unread messages — your board is unchanged. 🌿");
      return;
    }
    if (!summary) summary = Object.assign({}, incoming);
    else {
      T.ORDER.forEach((key) => {
        const current = summary[key] || (summary[key] = []);
        const ids = new Set(current.map((item) => item.id));
        (incoming[key] || []).forEach((item) => {
          if (!ids.has(item.id)) current.push(item);
        });
      });
      summary.generatedAt = incoming.generatedAt || summary.generatedAt;
      summary.unreadCount = incoming.unreadCount == null ? summary.unreadCount : incoming.unreadCount;
    }
    applyPersistence();
    updateProgress();
    preloadSummaryThreads(incoming);
    UI.addBotMsg(`${added} new message${added === 1 ? " was" : "s were"} added. Your progress is preserved. 📬`);
    overview();
  }

  async function learnTone() {
    const button = document.getElementById("btnLearnTone");
    button.disabled = true;
    UI.setBuddyStatus("Learning your writing style…");
    UI.addBotMsg("Reviewing your recent sent mail. I keep only the style profile — never the email samples. ✍️");
    const r = await window.retro.triage.learnTone();
    button.disabled = false;
    UI.setBuddyStatus("Online — ready to help");
    if (r && r.ok) {
      const data = r.data || {};
      UI.addBotMsg(data.message || "Your writing style is updated for future suggested replies. ✓");
    } else {
      UI.addBotMsg("I couldn't update your writing style: " + ((r && r.message) || "please try again."));
    }
  }

  function menu() {
    UI.setChips([
      { label: "What's the most important thing in my email? 📬", onClick: () => runTriage(true) },
      { label: "Show last summary", onClick: () => runTriage(false) },
    ]);
  }

  function preloadSummaryThreads(data) {
    if (!data || !window.retro.thread || !window.retro.thread.preload) return;
    const ids = [];
    T.ORDER.forEach((key) => {
      (data[key] || []).forEach((item) => {
        if (item && item.id && !item._handled && ids.length < 8) ids.push(item.id);
      });
    });
    if (ids.length) void window.retro.thread.preload(ids);
  }

  async function runTriage(fresh) {
    UI.setBuddyStatus("Reading your inbox…");
    UI.showTyping();
    UI.addBotMsg(fresh ? "On it — reading your inbox. This can take ~30 seconds. ⏳" : "Pulling up your last summary…");
    UI.scrollToEnd();

    // While Gemini prepares a fresh board, warm the thread cache from the
    // previous board so likely Read actions can open immediately.
    if (fresh) {
      void window.retro.triage.latest().then((previous) => {
        if (previous && previous.ok) preloadSummaryThreads(previous.data);
      });
    }
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
    preloadSummaryThreads(summary);
    overview();
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
