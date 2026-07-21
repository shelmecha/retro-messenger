"use strict";

const fs = require("fs");
const path = require("path");
const settings = require("./settings");

// n8n webhook contract (from the original inbox-summary extension).
const N8N_PATHS = {
  run: "/webhook/inbox-summary/run",
  latest: "/webhook/inbox-summary/latest",
  unsubscribe: "/webhook/inbox-summary/unsubscribe",
  label: "/webhook/inbox-summary/label",
  draft: "/webhook/inbox-summary/draft",
  unarchive: "/webhook/inbox-summary/unarchive",
  autofilter: "/webhook/inbox-summary/autofilter",
};

const DEFAULT_TIMEOUT = 20000;
const RUN_TIMEOUT = 120000; // Gmail + Gemini can be slow
const LONG_ACTIONS = new Set(["run", "syncNew", "learnTone", "thread"]);

const normalizeBase = (u) => (u || "").trim().replace(/\/+$/, "");

// A Google Apps Script web app is a single /exec endpoint (routes by ?action=
// or a POST body.action), unlike n8n's path-per-action webhooks.
const isAppsScript = (base) => /script\.google\.com/i.test(base) || /\/exec(\?|$)/i.test(base);

function loadMock() {
  const raw = fs.readFileSync(path.join(__dirname, "..", "mock", "sample-triage.json"), "utf8");
  const data = JSON.parse(raw);
  data.generatedAt = new Date().toISOString();
  return data;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BAD_RESPONSE = {
  ok: false,
  code: "BAD_RESPONSE",
  message: "The backend answered, but not with usable data.",
};

// A summary payload must look like one; a crashed Apps Script returns an HTML
// error page with HTTP 200, which must NOT be mistaken for an empty inbox.
function looksLikeSummary(data) {
  if (!data || typeof data !== "object") return false;
  if (typeof data.headline === "string" && data.headline.length) return true;
  const buckets = [
    "importantUrgent", "needsFollowUp", "starredOverdue", "canUnsubscribe",
    "keepSubscriptions", "whatsNew", "cleanedUp",
  ];
  return buckets.some((k) => Array.isArray(data[k]));
}

function looksLikeActionResult(data) {
  return !!data && typeof data === "object" &&
    ("ok" in data || "done" in data || "error" in data);
}

// Shared fetch with timeout + typed errors. Never throws.
async function doFetch(url, opts, timeout, kind) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, Object.assign({ signal: controller.signal }, opts));
    if (!res.ok) {
      return { ok: false, code: "HTTP_" + res.status, message: `Server responded ${res.status}.` };
    }
    let data;
    try {
      data = await res.json();
    } catch (_) {
      return BAD_RESPONSE;
    }
    // Backend reported a real error as JSON (e.g. Gemini overloaded) — surface
    // its actual message rather than the generic "bad response".
    if (data && typeof data === "object" && data.ok === false) {
      return {
        ok: false,
        code: data.code || "BACKEND_ERROR",
        message: data.error || data.message || "The backend reported an error.",
      };
    }
    if (kind === "summary" && !looksLikeSummary(data)) return BAD_RESPONSE;
    if (kind === "action" && !looksLikeActionResult(data)) return BAD_RESPONSE;
    return { ok: true, mock: false, data };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, code: "TIMEOUT", message: "The request timed out." };
    return { ok: false, code: "NETWORK", message: e.message || "Network error." };
  } finally {
    clearTimeout(timer);
  }
}

async function callAppsScript(base, pathKey, body) {
  const timeout = LONG_ACTIONS.has(pathKey) ? RUN_TIMEOUT : DEFAULT_TIMEOUT;
  if (pathKey === "run" || pathKey === "latest") {
    const url = base + (base.includes("?") ? "&" : "?") + "action=" + pathKey;
    return doFetch(url, { method: "GET" }, timeout, "summary");
  }
  return doFetch(
    base,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ action: pathKey }, body || {})),
    },
    timeout,
    pathKey === "syncNew" ? "summary" : "action"
  );
}

async function callN8n(base, pathKey, method, body) {
  // The n8n workflow only implements the original webhook paths.
  if (!N8N_PATHS[pathKey]) {
    return { ok: false, code: "NOT_SUPPORTED", message: "This action needs the Apps Script backend." };
  }
  const timeout = LONG_ACTIONS.has(pathKey) ? RUN_TIMEOUT : DEFAULT_TIMEOUT;
  const opts = { method };
  if (method === "POST") {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body || { source: "retro-messenger" });
  }
  const kind = pathKey === "run" || pathKey === "latest" ? "summary" : "action";
  return doFetch(base + N8N_PATHS[pathKey], opts, timeout, kind);
}

// Public entry. Never throws — resolves { ok, ... } or { ok:false, code, message }.
async function call(pathKey, method = "GET", body) {
  const cfg = settings.get();

  // ---- Demo mode ------------------------------------------------------
  if (cfg.mockMode) {
    if (pathKey === "run" || pathKey === "latest") {
      await wait(pathKey === "run" ? 1200 : 700);
      const data = loadMock();
      return { ok: true, mock: true, data };
    }
    if (pathKey === "thread") {
      await wait(80);
      return {
        ok: true,
        mock: true,
        data: {
          subject: "Re: Bureau — Spare Parts / After-Sale Request (Compass Education)",
          link: "https://mail.google.com/",
          messages: [
            {
              senderName: "Courtney Butler",
              date: "2026-07-20T10:42:00.000Z",
              summary: "Courtney needs confirmation of the Compass Education spare-parts order and an ETA today.",
              body:
                "Hi Shelvi,\n\nCan you confirm the spare-parts order for Compass Education? " +
                "The client is chasing an ETA and I'd love to give them something today.",
              isMe: false,
            },
            {
              senderName: "Shelvi",
              date: "2026-07-20T11:06:00.000Z",
              summary: "Shelvi will chase the supplier and report back that afternoon.",
              body:
                "Noted — I'll chase the supplier now and come back to you this afternoon.\n\n" +
                "---------- Forwarded message ---------\n" +
                "From: Courtney Butler <courtney@example.com>\n" +
                "Date: Mon, Jul 20, 2026 at 10:42 AM\n" +
                "Subject: Spare Parts / After-Sale Request\n\n" +
                "> Hi Shelvi,\n>\n> Can you confirm the spare-parts order for Compass Education?\n" +
                "> The client is chasing an ETA today.",
              isMe: true,
            },
          ],
        },
      };
    }
    if (pathKey === "syncNew") {
      await wait(700);
      const data = loadMock();
      data.headline = "1 new message joined your board — everything you already handled stays put.";
      data.addedCount = 1;
      data.importantUrgent = [data.importantUrgent[0]];
      Object.keys(data).forEach((key) => {
        if (Array.isArray(data[key]) && key !== "importantUrgent") data[key] = [];
      });
      return { ok: true, mock: true, data };
    }
    if (pathKey === "learnTone") {
      await wait(700);
      return { ok: true, mock: true, data: { ok: true, done: 50, message: "Writing style updated from 50 sent messages." } };
    }
    await wait(400);
    return { ok: true, mock: true, data: { done: (body && body.items && body.items.length) || 1 } };
  }

  // ---- Live mode ------------------------------------------------------
  const base = normalizeBase(cfg.n8nBaseUrl);
  if (!base) return { ok: false, code: "NOT_CONFIGURED", message: "No backend URL set." };

  if (isAppsScript(base)) return callAppsScript(base, pathKey, body);
  return callN8n(base, pathKey, method, body);
}

module.exports = { call };
