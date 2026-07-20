"use strict";

const { ipcMain, shell, app } = require("electron");
const settings = require("./settings");
const n8n = require("./n8n-client");

// `deps` carries functions that need the BrowserWindow (nudge, autolaunch).
function register(deps) {
  // ---- app ------------------------------------------------------------
  ipcMain.handle("app:version", () => app.getVersion());

  // ---- settings -------------------------------------------------------
  ipcMain.handle("settings:get", () => settings.get());
  ipcMain.handle("settings:set", (_e, partial) => {
    const next = settings.set(partial || {});
    if (Object.prototype.hasOwnProperty.call(partial || {}, "autoLaunch")) {
      deps.applyAutoLaunch(next.autoLaunch);
    }
    return next;
  });

  // ---- triage ---------------------------------------------------------
  ipcMain.handle("triage:run", () => n8n.call("run", "POST", { source: "retro-messenger" }));
  ipcMain.handle("triage:latest", () => n8n.call("latest", "GET"));

  // ---- per-item actions ----------------------------------------------
  ipcMain.handle("action:unsubscribe", (_e, items) => n8n.call("unsubscribe", "POST", { items: items || [] }));
  ipcMain.handle("action:label", (_e, ids) => n8n.call("label", "POST", { ids: ids || [], archive: true }));
  ipcMain.handle("action:draft", (_e, payload) => n8n.call("draft", "POST", payload || {}));
  ipcMain.handle("action:send", (_e, payload) => n8n.call("send", "POST", payload || {}));
  ipcMain.handle("action:markRead", (_e, ids) => n8n.call("markRead", "POST", { ids: ids || [] }));
  ipcMain.handle("action:markUnread", (_e, ids) => n8n.call("markUnread", "POST", { ids: ids || [] }));
  ipcMain.handle("thread:get", (_e, id) => n8n.call("thread", "POST", { id: id }));
  ipcMain.handle("action:markAllRead", () => n8n.call("markAllRead", "POST", {}));
  ipcMain.handle("action:unarchive", (_e, ids) => n8n.call("unarchive", "POST", { ids: ids || [] }));
  ipcMain.handle("action:autofilter", (_e, senders) => n8n.call("autofilter", "POST", { senders: senders || [] }));

  // Open an unsubscribe mailto:/https: link externally (scheme-guarded).
  ipcMain.handle("action:openExternal", (_e, url) => {
    const u = String(url || "");
    if (/^(https?:|mailto:)/i.test(u)) {
      shell.openExternal(u);
      return { ok: true };
    }
    return { ok: false, code: "BAD_SCHEME" };
  });

  // ---- window ---------------------------------------------------------
  ipcMain.handle("win:minimize", () => deps.hideToTray());
  ipcMain.handle("win:close", () => deps.hideToTray());
  ipcMain.handle("win:nudge", () => deps.nudge());

  // ---- reader (second window) ----------------------------------------
  ipcMain.handle("reader:open", (_e, payload) => deps.openReader(payload || {}));
  ipcMain.handle("reader:close", () => deps.closeReader());

  // ---- auto-update ----------------------------------------------------
  ipcMain.handle("update:install", () => deps.installUpdateNow());
  ipcMain.handle("update:check", () => deps.checkForUpdates());
}

module.exports = { register };
