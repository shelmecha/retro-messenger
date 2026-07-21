"use strict";

const { app, BrowserWindow, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const settings = require("./settings");
const ipc = require("./ipc");
const { autoUpdater } = require("electron-updater");

let win = null;
let readerWin = null; // second window: full-thread reader
let tray = null;
let nudgeTimer = null;
let wasHidden = false; // true only after the window has been hidden to tray

const startedHidden = process.argv.includes("--hidden");

// ---- single instance ---------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
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
    readerWin.loadFile(path.join(__dirname, "..", "renderer", "reader.html"), { search: query });
    positionReaderBesideMain();
    readerWin.show();
    readerWin.focus();
    return { ok: true };
  }

  readerWin = new BrowserWindow({
    width: 560,
    height: 680,
    resizable: true,
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

  const menu = Menu.buildFromTemplate([
    { label: "Open", click: () => showWindow() },
    { type: "separator" },
    { label: "Quit", click: () => quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => (win && win.isVisible() ? hideToTray() : showWindow()));
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
  // Only fire the "welcome back" wake when re-showing after a hide — not on
  // the initial launch (avoids a double greeting racing with renderer boot).
  if (wasHidden) {
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
  const log = (...a) => console.log("[DIAG]", ...a);
  try {
    await new Promise((r) => setTimeout(r, 500));
    log("retro API present:", await run("typeof window.retro === 'object'"));
    log("modules:", await run("[typeof ChatUI, typeof Triage, typeof Flows, typeof SettingsPanel].join(',')"));
    log("greeting bubbles:", await run("document.querySelectorAll('#messageList .msg-row.bot .bubble').length"));
    log("menu chips:", await run("document.querySelectorAll('#chipTray button').length"));
    log("manual sync button:", await run("!!document.getElementById('btnSyncNew')"));
    log("tone button:", await run("!!document.getElementById('btnLearnTone')"));
    log("manual sync mock:", await run("window.retro.triage.syncNew().then(r => r.ok && r.data.addedCount)"));
    log("tone learning mock:", await run("window.retro.triage.learnTone().then(r => r.ok && r.data.done)"));

    // Settings close/cancel must restore the home menu, not strand the user.
    await run("window.Flows.openSettings()");
    await new Promise((r) => setTimeout(r, 100));
    await run("document.getElementById('settingsClose').click()");
    log("settings close returns home:", await run("document.querySelectorAll('#chipTray button').length === 3"));

    // Click the first chip ("What's the most important thing...") → triage run.
    await run("document.querySelector('#chipTray button').click()");
    await new Promise((r) => setTimeout(r, 2000)); // mock run has ~1.2s delay
    log("after-run chips (buckets+done):", await run("document.querySelectorAll('#chipTray button').length"));
    log("headline present:", await run("[...document.querySelectorAll('.msg-row.bot .bubble')].some(b=>b.textContent.includes('need you today'))"));

    // Open the urgent bucket (first bucket chip).
    await run("document.querySelector('#chipTray button').click()");
    await new Promise((r) => setTimeout(r, 300));
    log("cards rendered:", await run("document.querySelectorAll('.item-card').length"));
    log("first card has actions:", await run("!!document.querySelector('.item-card .card-actions button')"));
    log("card has gmail link btn:", await run("!!document.querySelector('.item-card .card-link')"));
    log("card has read btn:", await run("!!document.querySelector('.item-card .card-read')"));
    log("thread mock messages:", await run("window.retro.thread.get('mockid').then(r => ((r&&r.data&&r.data.messages)||[]).length)"));

    // Open the reader (second window) on the first card and inspect it.
    await run("document.querySelector('.item-card .card-read').click()");
    await new Promise((r) => setTimeout(r, 1400));
    const readerWc = BrowserWindow.getAllWindows()
      .map((w) => w.webContents)
      .find((c) => (c.getURL() || "").includes("reader.html"));
    if (readerWc) {
      const rRun = (js) => readerWc.executeJavaScript(js, true);
      log("reader window opened:", true);
      log("reader thread msgs rendered:", await rRun("document.querySelectorAll('.thread-msg').length"));
      log("reader summaries rendered:", await rRun("document.querySelectorAll('.thread-summary').length"));
      log("reader avatars rendered:", await rRun("document.querySelectorAll('.thread-avatar').length"));
      log("reader hides addresses:", await rRun("![...document.querySelectorAll('.thread-from')].some(e => e.textContent.includes('@'))"));
      if (process.env.RM_READER_SHOT) {
        const fs = require("fs");
        const readerImg = await readerWc.capturePage();
        fs.writeFileSync(process.env.RM_READER_SHOT, readerImg.toPNG());
        log("reader screenshot saved:", process.env.RM_READER_SHOT);
      }
      await rRun("document.getElementById('btnReplyToggle').click()");
      await new Promise((r) => setTimeout(r, 150));
      log("reader reply box:", await rRun("!!document.querySelector('.reply-box')"));
    } else {
      log("reader window opened:", false);
    }

    if (process.env.RM_SHOT) {
      const fs = require("fs");
      const img = await wc.capturePage();
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

    log("DONE — all checks ran");
  } catch (e) {
    console.error("[DIAG] error:", e && e.message);
  } finally {
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
