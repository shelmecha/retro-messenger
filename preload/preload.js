"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("retro", {
  getVersion: () => ipcRenderer.invoke("app:version"),
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (partial) => ipcRenderer.invoke("settings:set", partial),
  },
  triage: {
    run: () => ipcRenderer.invoke("triage:run"),
    latest: () => ipcRenderer.invoke("triage:latest"),
    syncNew: () => ipcRenderer.invoke("triage:syncNew"),
    learnTone: () => ipcRenderer.invoke("triage:learnTone"),
  },
  action: {
    unsubscribe: (items) => ipcRenderer.invoke("action:unsubscribe", items),
    label: (ids) => ipcRenderer.invoke("action:label", ids),
    draft: (payload) => ipcRenderer.invoke("action:draft", payload),
    send: (payload) => ipcRenderer.invoke("action:send", payload),
    markRead: (ids) => ipcRenderer.invoke("action:markRead", ids),
    markUnread: (ids) => ipcRenderer.invoke("action:markUnread", ids),
    markAllRead: () => ipcRenderer.invoke("action:markAllRead"),
    unarchive: (ids) => ipcRenderer.invoke("action:unarchive", ids),
    autofilter: (senders) => ipcRenderer.invoke("action:autofilter", senders),
    openExternal: (url) => ipcRenderer.invoke("action:openExternal", url),
  },
  thread: {
    get: (id) => ipcRenderer.invoke("thread:get", id),
    preload: (ids) => ipcRenderer.invoke("thread:preload", ids),
  },
  reader: {
    open: (payload) => ipcRenderer.invoke("reader:open", payload),
    close: () => ipcRenderer.invoke("reader:close"),
  },
  win: {
    minimize: () => ipcRenderer.invoke("win:minimize"),
    close: () => ipcRenderer.invoke("win:close"),
    nudge: () => ipcRenderer.invoke("win:nudge"),
  },
  onWake: (cb) => {
    ipcRenderer.on("app:wake", (_e, payload) => cb(payload || {}));
  },
  update: {
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
    onAvailable: (cb) => ipcRenderer.on("update:available", (_e, p) => cb(p || {})),
    onReady: (cb) => ipcRenderer.on("update:ready", (_e, p) => cb(p || {})),
  },
});
