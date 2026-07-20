"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  n8nBaseUrl: "",
  mockMode: true, // n8n isn't live yet — demo mode on by default
  autoLaunch: false,
  sounds: false,
};

let cache = null;

function filePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    console.error("[settings] failed to save:", e.message);
  }
}

function get() {
  return { ...load() };
}

function set(partial) {
  load();
  cache = { ...cache, ...partial };
  save();
  return { ...cache };
}

module.exports = { get, set, DEFAULTS };
