"use strict";

const { app, BrowserWindow, Tray, Menu, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const settings = require("./settings");
const ipc = require("./ipc");
const { autoUpdater } = require("electron-updater");

let win = null;
let readerWin = null; // second window: full-thread reader
let tray = null;
let trayMenu = null;
let nudgeTimer = null;
let wasHidden = false; // true only after the window has been hidden to tray

const startedHidden = process.argv.includes("--hidden");
const diagnosticPartition = process.env.RM_DIAG === "1" ? "retro-diag-" + process.pid : undefined;

// ---- single instance ---------------------------------------------------
// Diagnostics run in an isolated session and may coexist with Shelvi's installed
// copy; normal launches still enforce exactly one InboxBot process group.
const gotLock = process.env.RM_DIAG === "1" || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(init);
}

function init() {
  ipc.register({
    hideToTray,
    nudge,
    applyAutoLaunch,
    openReader,
    closeReader,
    installUpdateNow,
    checkForUpdates,
  });
  createWindow();
  createTray();
  applyAutoLaunch(settings.get().autoLaunch);
  setupAutoUpdate();
}

// Auto-update from GitHub Releases. Silent download; the renderer shows a
// "restart to update" prompt when a new version is ready. No-op in dev
// (unpackaged) and during the RM_DIAG smoke test.
function setupAutoUpdate() {
  if (!app.isPackaged || process.env.RM_DIAG === "1") return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const toRenderer = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload || {});
  };

  autoUpdater.on("update-available", (info) => toRenderer("update:available", { version: info && info.version }));
  autoUpdater.on("update-downloaded", (info) => toRenderer("update:ready", { version: info && info.version }));
  autoUpdater.on("error", (err) => console.error("[autoUpdater]", err && err.message));

  autoUpdater.checkForUpdates().catch((e) => console.error("[autoUpdater] check failed:", e && e.message));
  // Re-check every 6 hours while the app stays open.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

function installUpdateNow() {
  autoUpdater.quitAndInstall();
  return { ok: true };
}

function checkForUpdates() {
  if (!app.isPackaged) return { ok: false, code: "DEV_MODE" };
  autoUpdater.checkForUpdates().catch(() => {});
  return { ok: true };
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 600,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    frame: false, // 98.css draws its own title bar
    backgroundColor: "#008080",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Each diagnostic launch gets an in-memory session so saved user progress
      // cannot change test ordering or be erased by the test.
      partition: diagnosticPartition,
      preload: path.join(__dirname, "..", "preload", "preload.js"),
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Surface renderer problems in the main-process log (harmless in normal use).
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.error("[renderer]", message); // warnings + errors
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[did-fail-load]", code, desc, url);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[render-gone]", details && details.reason);
  });

  win.once("ready-to-show", () => {
    if (!startedHidden) showWindow();
    if (process.env.RM_DIAG === "1") runDiagnostics();
  });

  // Closing hides to tray instead of quitting.
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      hideToTray();
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

// Open (or reuse) the reader window beside the main one, showing one thread.
// payload: { id, subject, from, link }
function openReader(payload) {
  const query = "?" + new URLSearchParams(payload || {}).toString();

  if (readerWin && !readerWin.isDestroyed()) {
    readerWin.setSize(420, 600);
    readerWin.loadFile(path.join(__dirname, "..", "renderer", "reader.html"), { search: query });
    positionReaderBesideMain();
    readerWin.show();
    readerWin.focus();
    return { ok: true };
  }

  readerWin = new BrowserWindow({
    width: 420,
    height: 600,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    frame: false,
    backgroundColor: "#008080",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: diagnosticPartition,
      preload: path.join(__dirname, "..", "preload", "preload.js"),
    },
  });
  readerWin.setMenuBarVisibility(false);
  readerWin.loadFile(path.join(__dirname, "..", "renderer", "reader.html"), { search: query });
  readerWin.once("ready-to-show", () => {
    positionReaderBesideMain();
    readerWin.show();
    readerWin.focus();
  });
  readerWin.on("closed", () => {
    readerWin = null;
  });
  return { ok: true };
}

function positionReaderBesideMain() {
  if (!readerWin || readerWin.isDestroyed() || !win || win.isDestroyed()) return;
  const b = win.getBounds();
  const r = readerWin.getBounds();
  const { screen } = require("electron");
  const area = screen.getDisplayMatching(b).workArea;
  let x = b.x + b.width + 8;
  // If it would run off the right edge, put it to the left of the main window.
  if (x + r.width > area.x + area.width) x = Math.max(area.x, b.x - r.width - 8);
  const y = Math.min(b.y, area.y + area.height - r.height);
  readerWin.setPosition(Math.round(x), Math.round(y));
}

function closeReader() {
  if (readerWin && !readerWin.isDestroyed()) readerWin.close();
  return { ok: true };
}

function createTray() {
  const trayIconPath = path.join(__dirname, "..", "assets", "tray.png");
  let img = nativeImage.createFromPath(trayIconPath);
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png"));
  tray = new Tray(img);
  tray.setToolTip("Retro Messenger");

  trayMenu = Menu.buildFromTemplate([
    { label: "Open InboxBot", click: () => showWindow() },
    { type: "separator" },
    { label: "Check New Emails", click: () => runTrayCommand("syncNew") },
    { label: "Refresh Inbox Summary", click: () => runTrayCommand("refreshInbox") },
    { type: "separator" },
    { label: "Quit", click: () => quit() },
  ]);
  tray.setContextMenu(trayMenu);
  tray.on("click", () => (win && win.isVisible() ? hideToTray() : showWindow()));
}

function runTrayCommand(action) {
  showWindow({ suppressWake: true });
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (win && !win.isDestroyed()) win.webContents.send("tray:command", { action: action });
  };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}

function showWindow(options) {
  const opts = options || {};
  if (!win) createWindow();
  win.show();
  win.focus();
  // Only fire the "welcome back" wake when re-showing after a hide — not on
  // the initial launch (avoids a double greeting racing with renderer boot).
  if (wasHidden && !opts.suppressWake) {
    win.webContents.send("app:wake", {});
  }
  wasHidden = false;
}

function hideToTray() {
  if (win) {
    win.hide();
    wasHidden = true;
  }
  // Tuck the conversation window away with the buddy list.
  if (readerWin && !readerWin.isDestroyed()) readerWin.hide();
}

function nudge() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const [x, y] = win.getPosition();
  const seq = [8, -8, 6, -6, 4, -4, 0];
  let i = 0;
  clearInterval(nudgeTimer);
  nudgeTimer = setInterval(() => {
    // The window can be closed/hidden mid-shake — bail safely if so.
    if (!win || win.isDestroyed()) {
      clearInterval(nudgeTimer);
      return;
    }
    if (i >= seq.length) {
      clearInterval(nudgeTimer);
      win.setPosition(x, y);
      return;
    }
    win.setPosition(x + seq[i], y);
    i++;
  }, 45);
}

// Env-gated end-to-end smoke test of the renderer flow (RM_DIAG=1).
async function runDiagnostics() {
  const wc = win.webContents;
  const run = (js) => wc.executeJavaScript(js, true);
  const report = process.env.RM_DIAG_REPORT;
  if (report) fs.writeFileSync(report, "[DIAG] started\n", "utf8");
  const record = (line) => {
    if (report) fs.appendFileSync(report, line + "\n", "utf8");
  };
  const log = (label, value) => {
    console.log("[DIAG]", label, value);
    record("[DIAG] " + label + " " + String(value));
    if (value === false || value == null) throw new Error(label + " failed");
  };
  try {
    await new Promise((r) => setTimeout(r, 500));
    // Keep repeated diagnostics isolated from a previous run's handled/moved
    // card state. This affects tests only; normal users retain their progress.
    await run("localStorage.clear(); true");
    log("retro API present:", await run("typeof window.retro === 'object'"));
    log("modules:", await run("[typeof ChatUI, typeof Triage, typeof Flows, typeof SettingsPanel].join(',')"));
    log("greeting bubbles:", await run("document.querySelectorAll('#messageList .msg-row.bot .bubble').length"));
    log("menu chips:", await run("document.querySelectorAll('#chipTray button').length === 2"));
    log("manual-sync button:", await run("!!document.getElementById('btnSyncNew')"));
    log("tone-learning button:", await run("!!document.getElementById('btnLearnTone')"));
    log("tray has check-new action:", trayMenu && trayMenu.items.some((item) => item.label === "Check New Emails"));
    log("tray has full-refresh action:", trayMenu && trayMenu.items.some((item) => item.label === "Refresh Inbox Summary"));
    log("settings beside minimize:", await run("document.getElementById('btnMin').previousElementSibling.id === 'btnSettingsTitle'"));
    log("no bottom settings chip:", await run("![...document.querySelectorAll('#chipTray button')].some(b=>/settings/i.test(b.textContent))"));
    log("manual sync response:", await run("window.retro.triage.syncNew().then(r=>r.ok && r.data.addedCount === 1)"));
    log("tone learning response:", await run("window.retro.triage.learnTone().then(r=>r.ok && r.data.done === 20)"));

    await run("document.getElementById('btnSettingsTitle').click()");
    await new Promise((r) => setTimeout(r, 100));
    await run("document.getElementById('settingsClose').click()");
    log("settings Close returns home:", await run("[...document.querySelectorAll('#chipTray button')].some(b=>/important thing/i.test(b.textContent))"));
    await run("Flows.openSettings()");
    await new Promise((r) => setTimeout(r, 100));
    await run("document.getElementById('btnCancelSettings').click()");
    log("settings Cancel returns home:", await run("[...document.querySelectorAll('#chipTray button')].some(b=>/important thing/i.test(b.textContent))"));
    await run("Flows.openSettings()");
    await new Promise((r) => setTimeout(r, 100));
    await run("document.getElementById('btnSaveSettings').click()");
    await new Promise((r) => setTimeout(r, 100));
    log("settings Save returns home:", await run("[...document.querySelectorAll('#chipTray button')].some(b=>/important thing/i.test(b.textContent))"));

    // Click the first chip ("What's the most important thing...") → triage run.
    await run("(()=>{const triageButton=document.querySelector('#chipTray button');triageButton.click();triageButton.click()})()");
    await new Promise((r) => setTimeout(r, 2000)); // mock run has ~1.2s delay
    log("duplicate inbox scan suppressed:", await run("[...document.querySelectorAll('.msg-row.bot .bubble')].filter(b=>/reading your inbox/i.test(b.textContent)).length === 1"));
    if (process.env.RM_QUOTA_MOCK === "1") {
      log("quota shows saved summary:", await run("[...document.querySelectorAll('.msg-row.bot .bubble')].some(b=>/showing your last saved summary/i.test(b.textContent))"));
    }
    log("after-run chips (buckets+done):", await run("document.querySelectorAll('#chipTray button').length"));
    log("headline present:", await run("[...document.querySelectorAll('.msg-row.bot .bubble')].some(b=>b.textContent.includes('need you today'))"));

    // Open the urgent bucket (first bucket chip).
    await run("document.querySelector('#chipTray button').click()");
    await new Promise((r) => setTimeout(r, 300));
    log("cards rendered:", await run("document.querySelectorAll('.item-card').length"));
    log("first card has actions:", await run("!!document.querySelector('.item-card .card-actions button')"));
    log("card shows concise topic:", await run("document.querySelector('.item-card .card-subject').textContent === 'Canada queue escalation decision'"));
    log("original subject preserved:", await run("document.querySelector('.item-card .card-subject').title.includes('CA service queue')"));
    log("card has gmail link btn:", await run("!!document.querySelector('.item-card .card-link')"));
    log("card has read btn:", await run("!!document.querySelector('.item-card .card-read')"));
    log("thread mock messages:", await run("window.retro.thread.get('mockid').then(r => ((r&&r.data&&r.data.messages)||[]).length)"));
    log("thread mock opens quickly:", await run("(async()=>{const started=performance.now();await window.retro.thread.get('mockid');return performance.now()-started < 500})()"));
    log("thread preload cache:", await run("(async()=>{await window.retro.thread.preload(['preload-check']);await new Promise(r=>setTimeout(r,150));const started=performance.now();await window.retro.thread.get('preload-check');return performance.now()-started < 50})()"));
    if (process.env.RM_MAIN_SHOT) {
      const mainImg = await wc.capturePage();
      fs.writeFileSync(process.env.RM_MAIN_SHOT, mainImg.toPNG());
      log("main screenshot saved:", process.env.RM_MAIN_SHOT);
    }

    // Open the reader (second window) on the first card and inspect it.
    await run("document.querySelector('.item-card .card-read').click()");
    await new Promise((r) => setTimeout(r, 1400));
    const readerWc = BrowserWindow.getAllWindows()
      .map((w) => w.webContents)
      .find((c) => (c.getURL() || "").includes("reader.html"));
    if (readerWc) {
      const rRun = (js) => readerWc.executeJavaScript(js, true);
      log("reader window opened:", true);
      log("reader messages rendered:", await rRun("document.querySelectorAll('.mail-message').length === 2"));
      log("reader recovers sender from raw From:", await rRun("document.querySelector('.mail-message:first-child .mail-from').textContent === 'Courtney Butler'"));
      log("reader has no unknown senders:", await rRun("![...document.querySelectorAll('.mail-from')].some(e=>/unknown sender/i.test(e.textContent))"));
      log("reader matches main size:", await rRun("window.innerWidth === 420 && window.innerHeight === 600"));
      log("reader avatars:", await rRun("document.querySelectorAll('.mail-avatar').length === 2"));
      log("reader previews:", await rRun("document.querySelectorAll('.mail-preview').length === 2"));
      log("reader newest expanded:", await rRun("document.querySelector('.mail-message:last-child').classList.contains('expanded')"));
      log("expanded reader row uses pointer cursor:", await rRun("getComputedStyle(document.querySelector('.mail-message:last-child')).cursor === 'pointer'"));
      log("reader uses concise topic:", await rRun("document.getElementById('readerSubject').textContent === 'Canada queue escalation decision'"));
      log("reader hides sender emails:", await rRun("![...document.querySelectorAll('.mail-from')].some(e=>e.textContent.includes('@'))"));
      log("reader normal email has no quote line:", await rRun("!document.querySelector('.mail-message:first-child .mail-forwarded')"));
      log("reader styles forwarded email:", await rRun("document.querySelectorAll('.mail-forwarded').length === 1"));
      log("reader removes forwarded quote markers:", await rRun("![...document.querySelectorAll('.mail-forwarded')].some(q=>q.textContent.split('\\n').some(line=>line.trim().startsWith('>')))"));
      if (process.env.RM_READER_SHOT) {
        const readerImg = await readerWc.capturePage();
        fs.writeFileSync(process.env.RM_READER_SHOT, readerImg.toPNG());
        log("reader screenshot saved:", process.env.RM_READER_SHOT);
      }
      await rRun("document.querySelector('.mail-message').click()");
      log("reader rows expand in place:", await rRun("document.querySelector('.mail-message').classList.contains('expanded') && !document.querySelector('.mail-message:last-child').classList.contains('expanded')"));
      await rRun("document.querySelector('.mail-message').click()");
      log("reader row closes on second click:", await rRun("!document.querySelector('.mail-message.expanded')"));
      await rRun("document.getElementById('btnReplyToggle').click()");
      await new Promise((r) => setTimeout(r, 150));
      log("reader reply box:", await rRun("!!document.querySelector('.reply-box')"));
    } else {
      log("reader window opened:", false);
    }

    if (process.env.RM_SHOT) {
      const shotWc = readerWc || wc;
      const img = await shotWc.capturePage();
      fs.writeFileSync(process.env.RM_SHOT, img.toPNG());
      log("screenshot saved:", process.env.RM_SHOT);
    }

    // Reply flow: Draft reply → pick a template → editable textarea → Send now.
    await run("document.querySelector('.item-card .card-actions button').click()"); // "Draft reply"
    await new Promise((r) => setTimeout(r, 150));
    log("template picks:", await run("document.querySelectorAll('.item-card .tmpl-list button').length"));
    await run("document.querySelector('.item-card .tmpl-list button').click()"); // pick first
    await new Promise((r) => setTimeout(r, 150));
    log("editor textarea present:", await run("!!document.querySelector('.item-card .reply-box')"));
    log("editor prefilled:", await run("(document.querySelector('.item-card .reply-box')||{}).value ? true : false"));
    await run("document.querySelector('.item-card .send-row button').click()"); // "Send now"
    await new Promise((r) => setTimeout(r, 600));
    log("send result text:", await run("(document.querySelector('.item-card .card-result')||{}).textContent"));
    log("win chip:", await run("(document.getElementById('winChip')||{}).textContent"));
    log("card collapsed (handled):", await run("!!document.querySelector('.item-card.handled')"));
    log("progress label:", await run("(document.getElementById('progressLabel')||{}).textContent"));

    // Mark read on the next unhandled card → collapses + offers Undo.
    await run(
      "[...document.querySelectorAll('.item-card:not(.handled) .card-actions button')].find(b=>b.textContent.includes('Mark read')).click()"
    );
    await new Promise((r) => setTimeout(r, 600));
    log("undo offered:", await run("!!document.querySelector('.undo-link')"));
    log("countdown label (to-go):", await run("(document.getElementById('progressLabel')||{}).textContent"));
    await run("document.querySelector('.undo-link').click()");
    await new Promise((r) => setTimeout(r, 600));
    log("progress after undo:", await run("(document.getElementById('progressLabel')||{}).textContent"));

    // Bucket view must NOT have "I'm done" — only "Back to summary".
    log("bucket has no I'm-done:", await run("![...document.querySelectorAll('#chipTray button')].some(b=>/done/i.test(b.textContent))"));

    // Persistence: back to summary, re-open urgent → handled card still collapsed.
    await run("[...document.querySelectorAll('#chipTray button')].find(b=>/back to summary/i.test(b.textContent)).click()");
    await new Promise((r) => setTimeout(r, 150));
    await run("document.querySelector('#chipTray button').click()"); // first bucket again
    await new Promise((r) => setTimeout(r, 200));
    log("handled persisted after re-open:", await run("!!document.querySelector('.item-card.handled')"));

    // Moved-card path: open Cleaned up, rescue first item to Urgent.
    await run("[...document.querySelectorAll('#chipTray button')].find(b=>/back to summary/i.test(b.textContent)).click()");
    await new Promise((r) => setTimeout(r, 150));
    await run("[...document.querySelectorAll('#chipTray button')].find(b=>/cleaned up/i.test(b.textContent)).click()");
    await new Promise((r) => setTimeout(r, 200));
    await run("[...document.querySelectorAll('.item-card .card-actions button')].find(b=>/not junk/i.test(b.textContent)).click()");
    await new Promise((r) => setTimeout(r, 150));
    await run("[...document.querySelectorAll('.item-card .tmpl-list button')].find(b=>/urgent/i.test(b.textContent)).click()");
    await new Promise((r) => setTimeout(r, 200));
    log("moved card re-rendered as urgent:", await run("[...document.querySelectorAll('.item-card .card-badge')].some(b=>/Important/i.test(b.textContent))"));

    // Finish from the summary page → clean-sweep offer (mock unreadCount = 7).
    await run("[...document.querySelectorAll('#chipTray button')].find(b=>/back to summary/i.test(b.textContent)).click()");
    await new Promise((r) => setTimeout(r, 150));
    await run("[...document.querySelectorAll('#chipTray button')].find(b=>/done/i.test(b.textContent)).click()");
    await new Promise((r) => setTimeout(r, 150));
    log("clean-sweep offered:", await run("[...document.querySelectorAll('#chipTray button')].some(b=>/mark all read/i.test(b.textContent))"));
    await run("[...document.querySelectorAll('#chipTray button')].find(b=>/mark all read/i.test(b.textContent)).click()");
    await new Promise((r) => setTimeout(r, 600));
    log("post-sweep bubble:", await run("[...document.querySelectorAll('.msg-row.bot .bubble')].pop().textContent.slice(0,40)"));
    log("status dot class:", await run("document.getElementById('statusDot').className"));

    // Hidden-icons menu commands should reveal the app and use the same guarded
    // flows as the header buttons.
    hideToTray();
    log("tray test starts hidden:", !win.isVisible());
    const syncBubbleCount = await run("document.querySelectorAll('.msg-row.bot .bubble').length");
    runTrayCommand("syncNew");
    await new Promise((r) => setTimeout(r, 1000));
    log("tray check-new reveals app:", win.isVisible());
    log("tray check-new reaches renderer:", await run("document.querySelectorAll('.msg-row.bot .bubble').length > " + syncBubbleCount));
    const refreshBubbleCount = await run("[...document.querySelectorAll('.msg-row.bot .bubble')].filter(b=>/reading your inbox/i.test(b.textContent)).length");
    hideToTray();
    runTrayCommand("refreshInbox");
    await new Promise((r) => setTimeout(r, 1600));
    log("tray full-refresh reveals app:", win.isVisible());
    log("tray full-refresh reaches renderer:", await run("[...document.querySelectorAll('.msg-row.bot .bubble')].filter(b=>/reading your inbox/i.test(b.textContent)).length > " + refreshBubbleCount));

    log("DONE — all assertions passed", true);
  } catch (e) {
    console.error("[DIAG] error:", e && e.message);
    record("[DIAG] error: " + String(e && e.message));
    process.exitCode = 1;
  } finally {
    record("[DIAG] finished");
    quit();
  }
}

function applyAutoLaunch(enabled) {
  // macOS/Windows only; no-op elsewhere.
  if (process.platform === "linux") return;
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    args: ["--hidden"],
  });
}

function quit() {
  app.isQuitting = true;
  app.quit();
}

app.on("window-all-closed", () => {
  // Keep running in tray; only quit explicitly.
});

app.on("before-quit", () => {
  app.isQuitting = true;
});
