"use strict";

const { ipcMain, shell, app } = require("electron");
const settings = require("./settings");
const n8n = require("./n8n-client");

const THREAD_CACHE_TTL = 10 * 60 * 1000;
const THREAD_CACHE_MAX = 20;
const threadCache = new Map();
const threadInFlight = new Map();
let triageInFlight = null;

function runMailboxOperation(action, payload) {
  if (triageInFlight) {
    if (triageInFlight.action === action) return triageInFlight.promise;
    return Promise.resolve({
      ok: false,
      code: "BUSY",
      message: "Another inbox operation is already running. Please wait for it to finish.",
    });
  }

  const operation = { action, promise: null };
  operation.promise = n8n.call(action, "POST", payload || {}).finally(() => {
    if (triageInFlight === operation) triageInFlight = null;
  });
  triageInFlight = operation;
  return operation.promise;
}

function trimThreadCache() {
  while (threadCache.size > THREAD_CACHE_MAX) {
    threadCache.delete(threadCache.keys().next().value);
  }
}

function getThread(id) {
  const key = String(id || "").trim();
  if (!key) return Promise.resolve({ ok: false, code: "BAD_REQUEST", message: "Missing message id." });
  const cached = threadCache.get(key);
  if (cached && Date.now() - cached.savedAt < THREAD_CACHE_TTL) return Promise.resolve(cached.result);
  if (threadInFlight.has(key)) return threadInFlight.get(key);

  const request = n8n.call("thread", "POST", { id: key }).then((result) => {
    if (result && result.ok) {
      threadCache.delete(key);
      threadCache.set(key, { savedAt: Date.now(), result });
      trimThreadCache();
    }
    return result;
  }).finally(() => threadInFlight.delete(key));
  threadInFlight.set(key, request);
  return request;
}

function preloadThreads(ids) {
  const unique = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 8);
  void (async () => {
    for (const id of unique) await getThread(id);
  })();
  return { ok: true, queued: unique.length };
}

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
  ipcMain.handle("triage:run", () => runMailboxOperation("run", { source: "retro-messenger" }));
  ipcMain.handle("triage:latest", () => n8n.call("latest", "GET"));
  ipcMain.handle("triage:syncNew", () => runMailboxOperation("syncNew", {}));
  ipcMain.handle("triage:learnTone", () => runMailboxOperation("learnTone", {}));

  // ---- per-item actions ----------------------------------------------
  ipcMain.handle("action:unsubscribe", (_e, items) => n8n.call("unsubscribe", "POST", { items: items || [] }));
  ipcMain.handle("action:label", (_e, ids) => n8n.call("label", "POST", { ids: ids || [], archive: true }));
  ipcMain.handle("action:draft", (_e, payload) => n8n.call("draft", "POST", payload || {}));
  ipcMain.handle("action:send", (_e, payload) => n8n.call("send", "POST", payload || {}));
  ipcMain.handle("action:markRead", (_e, ids) => n8n.call("markRead", "POST", { ids: ids || [] }));
  ipcMain.handle("action:markUnread", (_e, ids) => n8n.call("markUnread", "POST", { ids: ids || [] }));
  ipcMain.handle("thread:get", (_e, id) => getThread(id));
  ipcMain.handle("thread:preload", (_e, ids) => preloadThreads(ids));
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
