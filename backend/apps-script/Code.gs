/**
 * Retro Messenger — Google Apps Script backend
 * ---------------------------------------------
 * Replaces n8n. Reads your Gmail, asks Gemini to triage it into buckets, and
 * returns JSON to the Retro Messenger desktop app. Runs free inside your own
 * Google account.
 *
 * SETUP: paste your Gemini API key below, then Deploy → New deployment →
 * Web app → Execute as: Me → Who has access: Anyone. Copy the /exec URL
 * into the app's Settings. Full steps in SETUP-APPSSCRIPT.md.
 */

const BACKEND_VERSION = "0.7.8.3";

const CONFIG = {
  GEMINI_API_KEY: "PASTE_YOUR_GEMINI_KEY_HERE", // from https://aistudio.google.com/apikey
  // No hardcoded model — the script asks Google which models YOUR key can use
  // and picks the best available, in this order of preference:
  MODEL_PREFERENCES: [
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-3.5-flash",
  ],
  MODEL_SELECTION_VERSION: "compact-triage-v3",
  GEMINI_MODEL_ATTEMPTS: 3,
  GEMINI_BATCH_SIZE: 10,
  INBOX_QUERY: "in:inbox newer_than:3d",
  INBOX_LIMIT: 20,
  STARRED_QUERY: "is:starred older_than:5d",
  STARRED_LIMIT: 10,
  SUMMARY_REUSE_MINUTES: 10,
  AI_FALLBACK_RETRY_MINUTES: 1,
  TONE_SAMPLE_LIMIT: 20,
  TONE_SAMPLE_CHARS: 1200,
  SUBSCRIPTIONS_LABEL: "Subscriptions",
};

const EMPTY_SUMMARY = {
  headline: "",
  generatedAt: null,
  unreadCount: 0,
  importantUrgent: [],
  needsFollowUp: [],
  starredOverdue: [],
  canUnsubscribe: [],
  keepSubscriptions: [],
  whatsNew: [],
  cleanedUp: [],
};

const TRIAGE_BUCKETS = [
  "importantUrgent",
  "needsFollowUp",
  "starredOverdue",
  "canUnsubscribe",
  "keepSubscriptions",
  "whatsNew",
  "cleanedUp",
];

// Compact structured output: exactly one classification object per email.
// The previous seven-array response encouraged duplication and could exhaust
// the output allowance before Gemini closed the JSON for a 30-email scan.
const SUMMARY_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING", description: "One warm sentence about what needs attention." },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "The Gmail message id supplied in the prompt." },
          bucket: { type: "STRING", enum: TRIAGE_BUCKETS, description: "Exactly one triage bucket." },
          topic: { type: "STRING", description: "Plain 3 to 8 word topic, at most 60 characters." },
          why: { type: "STRING", description: "Brief reason or context, at most 120 characters." },
          action: { type: "STRING", description: "Brief next action, at most 120 characters." },
          suggestedReply: { type: "STRING", description: "Brief optional reply, at most 160 characters." },
        },
        required: ["id", "bucket", "topic"],
      },
    },
  },
  required: ["headline", "items"],
};

/* ============================ ROUTING ============================ */

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "latest";
    if (action === "version") return json({ ok: true, backendVersion: BACKEND_VERSION });
    if (action === "run") return json(runTriage());
    return json(getLatest());
  } catch (err) {
    // Return the error AS JSON so the app can show the real reason instead of
    // an un-parseable HTML crash page.
    return json({ ok: false, code: (err && err.code) || "BACKEND_ERROR", error: String((err && err.message) || err) });
  }
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (_) {}
  try {
    return json(route(body));
  } catch (err) {
    return json({ ok: false, code: (err && err.code) || "BACKEND_ERROR", error: String((err && err.message) || err) });
  }
}

function route(body) {
  switch (body.action) {
    case "run":
      return runTriage();
    case "syncNew":
      return syncNew();
    case "learnTone":
      return learnTone();
    case "unsubscribe":
      return doUnsubscribe(body.items || []);
    case "label":
      return doLabel(body.ids || []);
    case "draft":
      return doDraft(body);
    case "send":
      return doSend(body);
    case "markRead":
      return doMarkRead(body.ids || []);
    case "markUnread":
      return doMarkUnread(body.ids || []);
    case "thread":
      return doThread(body);
    case "markAllRead":
      return doMarkAllRead();
    case "unarchive":
      return doUnarchive(body.ids || []);
    default:
      return { ok: false, error: "unknown action" };
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================ TRIAGE ============================ */

function runTriage() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) {
    const saved = getLatest();
    if (hasSavedSummary(saved)) {
      saved.reusedCachedSummary = true;
      saved.cacheNotice = "Another inbox scan is already running, so I loaded your last saved summary.";
      return saved;
    }
    lock.waitLock(10000);
  }

  try {
    return runTriageLocked();
  } finally {
    lock.releaseLock();
  }
}

function runTriageLocked() {
  const saved = getLatest();
  const ageMinutes = summaryAgeMinutes(saved);
  const reuseMinutes = saved.aiFallback
    ? CONFIG.AI_FALLBACK_RETRY_MINUTES
    : CONFIG.SUMMARY_REUSE_MINUTES;
  if (ageMinutes !== null && ageMinutes < reuseMinutes) {
    saved.reusedCachedSummary = true;
    saved.cacheNotice =
      saved.aiFallback
        ? "Gemini was just attempted, so I kept your fallback inbox briefly. Try the full refresh again in about a minute."
        : "I reused your recent summary to avoid another Gemini request. Tap the refresh icon to check only for new mail.";
    return saved;
  }

  const syncStarted = new Date();
  const items = gather();
  if (!items.length) {
    const empty = Object.assign({}, EMPTY_SUMMARY, {
      headline: "Your inbox is quiet — nothing new to triage right now. 🌿",
      generatedAt: new Date().toISOString(),
    });
    saveLatest(empty);
    PropertiesService.getScriptProperties().setProperty("lastInboxSync", syncStarted.toISOString());
    return empty;
  }
  let summary;
  try {
    const parsed = geminiSummarize(items);
    summary = mergeBuckets(parsed, items);
  } catch (err) {
    Logger.log("Gemini triage fallback: " + String((err && err.message) || err));
    summary = buildNoAiSummary(items, err);
  }
  summary.generatedAt = new Date().toISOString();
  summary.unreadCount = countUnread();
  saveLatest(summary);
  PropertiesService.getScriptProperties().setProperty("lastInboxSync", syncStarted.toISOString());
  return summary;
}
// Deliberate, additive sync: summarize only unread messages received since the
// previous deliberate sync, then merge by Gmail message id into the saved board.
function syncNew() {
  const props = PropertiesService.getScriptProperties();
  const latest = getLatest();
  const fallback = latest.generatedAt || new Date(Date.now() - 3 * 86400000).toISOString();
  const since = new Date(props.getProperty("lastInboxSync") || fallback);
  const syncAt = new Date();
  const query = "in:inbox is:unread after:" + Math.floor(since.getTime() / 1000);
  const seen = {};
  bucketKeys().forEach(function (key) {
    (latest[key] || []).forEach(function (item) { seen[item.id] = true; });
  });
  const additions = [];
  GmailApp.search(query, 0, CONFIG.INBOX_LIMIT).forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (message.isUnread() && message.getDate() > since && !seen[message.getId()]) {
        seen[message.getId()] = true;
        additions.push(toItem(message, message.isStarred()));
      }
    });
  });
  if (!additions.length) {
    props.setProperty("lastInboxSync", syncAt.toISOString());
    return Object.assign({}, EMPTY_SUMMARY, { headline: "No new unread messages — board unchanged.", generatedAt: syncAt.toISOString(), unreadCount: countUnread(), addedCount: 0 });
  }
  let delta;
  try {
    delta = mergeBuckets(geminiSummarize(additions), additions);
  } catch (err) {
    Logger.log("Gemini new-mail fallback: " + String((err && err.message) || err));
    delta = buildNoAiSummary(additions, err);
  }
  bucketKeys().forEach(function (key) {
    latest[key] = (latest[key] || []).concat(delta[key] || []);
  });
  latest.generatedAt = syncAt.toISOString();
  latest.unreadCount = countUnread();
  if (delta.aiFallback) {
    latest.aiFallback = true;
    latest.aiFallbackKind = delta.aiFallbackKind || "temporary";
    latest.aiNotice = delta.aiNotice;
  }
  saveLatest(latest);
  props.setProperty("lastInboxSync", syncAt.toISOString());
  delta.generatedAt = latest.generatedAt;
  delta.unreadCount = latest.unreadCount;
  delta.addedCount = additions.length;
  return delta;
}

function bucketKeys() {
  return Object.keys(EMPTY_SUMMARY).filter(function (key) {
    return Array.isArray(EMPTY_SUMMARY[key]);
  });
}

// Cheap unread tally for the "clean sweep" prompt (capped at 100 for speed).
function countUnread() {
  return GmailApp.search("in:inbox is:unread", 0, 100).length;
}

function hasSavedSummary(summary) {
  if (!summary) return false;
  if (summary.generatedAt) return true;
  return bucketKeys().some(function (key) { return (summary[key] || []).length > 0; });
}

function summaryAgeMinutes(summary) {
  if (!summary || !summary.generatedAt) return null;
  const time = new Date(summary.generatedAt).getTime();
  if (!isFinite(time)) return null;
  return Math.max(0, (Date.now() - time) / 60000);
}

function buildNoAiSummary(items, err) {
  const out = Object.assign({}, EMPTY_SUMMARY);
  bucketKeys().forEach(function (key) { out[key] = []; });
  const errorText = String((err && err.message) || "");
  out.aiFallback = true;
  out.aiFallbackKind =
    (err && err.quotaKind) || (/invalid|unauthorized|api key/i.test(errorText) ? "configuration" : "temporary");
  out.aiDiagnostic = safeGeminiDiagnostic(err);
  out.aiNotice =
    out.aiFallbackKind === "daily"
      ? "Gemini's daily project quota is used up. It resets at midnight Pacific time, so I loaded your emails without AI sorting."
      : out.aiFallbackKind === "configuration"
        ? "Your Gemini API key needs attention, but I loaded your emails without AI sorting. Check the key in Code.gs when convenient."
      : "Gemini is unavailable or limited right now, so I loaded your emails without AI sorting.";
  out.headline =
    "I still loaded " + items.length + " email" + (items.length === 1 ? "" : "s") + " so you can keep working.";

  items.forEach(function (orig) {
    const entry = {
      id: orig.id,
      from: orig.from,
      subject: orig.subject,
      topic: String(orig.subject || "(no subject)")
        .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
        .slice(0, 60),
      age: orig.age,
      link: orig.link || "",
      why: "AI sorting is temporarily unavailable — review this message manually.",
      action: "Open the email and review it.",
      reason: "AI sorting is temporarily unavailable.",
      context: "Starred email loaded without AI sorting.",
      suggestedReply: "",
      unsubMethod: orig.unsubMethod || "",
      unsubTarget: orig.unsubTarget || "",
    };
    (orig.starred ? out.starredOverdue : out.whatsNew).push(entry);
  });
  return out;
}

function gather() {
  const out = [];
  const seen = {};

  const inbox = GmailApp.search(CONFIG.INBOX_QUERY, 0, CONFIG.INBOX_LIMIT);
  inbox.forEach((t) => {
    const m = t.getMessages().pop(); // most recent message in the thread
    if (m && !seen[m.getId()]) {
      seen[m.getId()] = true;
      out.push(toItem(m, false));
    }
  });

  const starred = GmailApp.search(CONFIG.STARRED_QUERY, 0, CONFIG.STARRED_LIMIT);
  starred.forEach((t) => {
    const m = t.getMessages().pop();
    if (m && !seen[m.getId()]) {
      seen[m.getId()] = true;
      out.push(toItem(m, true));
    }
  });

  return out;
}

function toItem(m, starred) {
  const body = safeBody(m);
  const item = {
    id: m.getId(),
    from: messageFrom(m),
    subject: m.getSubject() || "(no subject)",
    age: ageStr(m.getDate()),
    snippet: body.slice(0, 300),
    starred: !!starred,
    hasUnsub: false,
    link: "https://mail.google.com/mail/u/0/#all/" + m.getId(),
  };
  // Only pay the raw-content cost for likely subscriptions.
  if (/unsubscribe/i.test(body)) {
    const u = parseUnsub(m);
    if (u) {
      item.hasUnsub = true;
      item.unsubMethod = u.method;
      item.unsubTarget = u.target;
    }
  }
  return item;
}

function safeBody(m) {
  try {
    return m.getPlainBody() || "";
  } catch (_) {
    return "";
  }
}

function ageStr(date) {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 60) return mins + "m";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h";
  return Math.floor(hrs / 24) + "d";
}

function parseUnsub(m) {
  let raw = "";
  try {
    raw = m.getRawContent();
  } catch (_) {
    return null;
  }
  const lu = raw.match(/^List-Unsubscribe:\s*(.+(?:\r?\n\s+.+)*)/im);
  if (!lu) return null;
  const val = lu[1].replace(/\s+/g, " ").trim();
  const hasPost = /^List-Unsubscribe-Post:/im.test(raw);
  const urls = (val.match(/<([^>]+)>/g) || []).map((x) => x.slice(1, -1));
  const https = urls.find((u) => /^https?:/i.test(u));
  const mailto = urls.find((u) => /^mailto:/i.test(u));
  if (hasPost && https) return { method: "oneclick", target: https };
  if (https) return { method: "link", target: https };
  if (mailto) return { method: "mailto", target: mailto.replace(/^mailto:/i, "") };
  return null;
}

/* ============================ GEMINI ============================ */

function geminiSummarize(items) {
  try {
    return geminiSummarizeRequest(items);
  } catch (err) {
    const canRetryInBatches =
      items.length > CONFIG.GEMINI_BATCH_SIZE &&
      err &&
      (err.code === "GEMINI_TRUNCATED" || err.code === "GEMINI_MALFORMED");
    if (!canRetryInBatches) throw err;

    Logger.log(
      "Gemini full-inbox JSON was incomplete; retrying in batches of " +
      CONFIG.GEMINI_BATCH_SIZE + "."
    );
    clearPickedModel();
    const combined = { headline: "", items: [] };
    for (let start = 0; start < items.length; start += CONFIG.GEMINI_BATCH_SIZE) {
      const part = geminiSummarizeRequest(items.slice(start, start + CONFIG.GEMINI_BATCH_SIZE));
      if (!combined.headline && part.headline) combined.headline = part.headline;
      combined.items = combined.items.concat(part.items || []);
    }
    if (!combined.headline) combined.headline = "Your inbox is sorted and ready to review.";
    return combined;
  }
}

function geminiSummarizeRequest(items) {
  const payload = {
    contents: [{ parts: [{ text: buildPrompt(items) }] }],
  };

  const triedModels = {};
  const transientByModel = {};
  const attempts = [];
  let model = pickModel([]);
  let lastError = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    triedModels[model] = true;
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent?key=" +
      CONFIG.GEMINI_API_KEY;

    const requestPayload = Object.assign({}, payload, {
      generationConfig: triageGenerationConfig(model),
    });
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(requestPayload),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const attemptInfo = { model: model, httpStatus: code };
    attempts.push(attemptInfo);

    if (code === 200) {
      let data = {};
      try {
        data = JSON.parse(res.getContentText() || "{}");
      } catch (_) {}
      const candidate = (data.candidates || [])[0] || {};
      const text = ((candidate.content || { parts: [] }).parts || [])
        .map(function (p) { return p.text || ""; })
        .join("") || "";
      const parsed = safeParseJson(text);
      if (isCompleteSummaryPayload(parsed, items)) return parsed;

      const finishReason = String(candidate.finishReason || "UNKNOWN");
      attemptInfo.finishReason = finishReason;
      attemptInfo.responseChars = text.length;
      lastError = new Error(
        finishReason === "MAX_TOKENS"
          ? "Gemini's JSON was cut off before it finished."
          : "Gemini returned incomplete JSON even with schema enforcement."
      );
      lastError.code = finishReason === "MAX_TOKENS" ? "GEMINI_TRUNCATED" : "GEMINI_MALFORMED";
      lastError.model = model;
      lastError.finishReason = finishReason;
      lastError.responseChars = text.length;

      // A different model still has to emit the same large response. Split the
      // workload immediately instead of spending more calls on another model.
      if (finishReason === "MAX_TOKENS") throw withGeminiAttempts(lastError, attempts);

      const nextAfterJson = nextGeminiModel(triedModels);
      if (nextAfterJson) {
        model = nextAfterJson;
        continue;
      }
      throw withGeminiAttempts(lastError, attempts);
    }

    // Retry a temporary server problem twice on the same model, then switch.
    if (code === 503 || code === 500) {
      transientByModel[model] = (transientByModel[model] || 0) + 1;
      if (transientByModel[model] <= 2) {
        Utilities.sleep(1500 * transientByModel[model]);
        continue;
      }
      lastError = new Error("Gemini is temporarily overloaded (high demand). Give it a minute and try again.");
      lastError.code = "GEMINI_OVERLOADED";
      lastError.model = model;
      lastError.httpStatus = code;
      const nextAfterOverload = nextGeminiModel(triedModels);
      if (nextAfterOverload) {
        model = nextAfterOverload;
        continue;
      }
      throw withGeminiAttempts(lastError, attempts);
    }

    if (code === 429) {
      lastError = geminiQuotaError(res.getContentText());
      lastError.model = model;
      const nextAfterQuota = nextGeminiModel(triedModels);
      if (nextAfterQuota) {
        model = nextAfterQuota;
        continue;
      }
      throw withGeminiAttempts(lastError, attempts);
    }

    if (code === 404 && model) {
      lastError = new Error("Gemini model '" + model + "' is no longer available for this key.");
      lastError.code = "GEMINI_MODEL_UNAVAILABLE";
      lastError.model = model;
      lastError.httpStatus = code;
      const nextAfterMissing = nextGeminiModel(triedModels);
      if (nextAfterMissing) {
        model = nextAfterMissing;
        continue;
      }
      throw withGeminiAttempts(lastError, attempts);
    }

    lastError = new Error(
      "Gemini HTTP " + code + " on model '" + model + "': " + res.getContentText().slice(0, 200)
    );
    lastError.code = code === 400 || code === 403 ? "GEMINI_CONFIGURATION" : "GEMINI_HTTP_ERROR";
    lastError.model = model;
    lastError.httpStatus = code;
    throw withGeminiAttempts(lastError, attempts);
  }
  throw withGeminiAttempts(
    lastError || new Error("Gemini kept failing after several retries — likely temporary. Try again shortly."),
    attempts
  );
}

function isCompleteSummaryPayload(value, sourceItems) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.headline !== "string") return false;
  if (!Array.isArray(value.items)) return false;
  if (value.items.length !== (sourceItems || []).length) return false;
  const expected = {};
  const seen = {};
  (sourceItems || []).forEach(function (item) { expected[item.id] = true; });
  return value.items.every(function (item) {
    if (!item || !expected[item.id] || seen[item.id]) return false;
    seen[item.id] = true;
    return TRIAGE_BUCKETS.indexOf(item.bucket) !== -1 && !!item.topic;
  });
}

function triageGenerationConfig(model) {
  const config = {
    responseMimeType: "application/json",
    responseSchema: SUMMARY_RESPONSE_SCHEMA,
    maxOutputTokens: 16384,
  };
  // Inbox classification is simple. Gemini 2.5 can run without thinking;
  // Gemini 3 Flash cannot fully disable it, so use its lowest stable level.
  config.thinkingConfig = thinkingConfigForModel(model);
  return config;
}

function thinkingConfigForModel(model) {
  return /^gemini-3(?:\.|-|$)/i.test(String(model || ""))
    ? { thinkingLevel: "low" }
    : { thinkingBudget: 0 };
}

function withGeminiAttempts(err, attempts) {
  const out = err || new Error("Gemini failed.");
  out.attempts = (attempts || []).slice(0, 8);
  return out;
}

function nextGeminiModel(triedModels) {
  if (Object.keys(triedModels).length >= CONFIG.GEMINI_MODEL_ATTEMPTS) return "";
  clearPickedModel();
  try {
    return pickModel(Object.keys(triedModels));
  } catch (_) {
    return "";
  }
}

function clearPickedModel() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty("pickedModel");
  props.deleteProperty("pickedModelVersion");
}

function safeGeminiDiagnostic(err) {
  const raw = String((err && err.message) || err || "Gemini failed");
  let message = raw.replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]");
  if (CONFIG.GEMINI_API_KEY && CONFIG.GEMINI_API_KEY !== "PASTE_YOUR_GEMINI_KEY_HERE") {
    message = message.split(CONFIG.GEMINI_API_KEY).join("[redacted]");
  }
  return {
    code: String((err && err.code) || "GEMINI_ERROR").slice(0, 60),
    message: message.slice(0, 240),
    model: String((err && err.model) || "").slice(0, 80),
    httpStatus: Number((err && err.httpStatus) || 0),
    finishReason: String((err && err.finishReason) || "").slice(0, 40),
    retryDelay: String((err && err.retryDelay) || "").slice(0, 40),
    attempts: ((err && err.attempts) || []).slice(0, 8).map(function (attempt) {
      return {
        model: String((attempt && attempt.model) || "").slice(0, 80),
        httpStatus: Number((attempt && attempt.httpStatus) || 0),
        finishReason: String((attempt && attempt.finishReason) || "").slice(0, 40),
        responseChars: Number((attempt && attempt.responseChars) || 0),
      };
    }),
  };
}

function geminiQuotaError(responseText) {
  let data = {};
  try {
    data = JSON.parse(responseText || "{}");
  } catch (_) {}
  const details = (((data || {}).error || {}).details || []);
  const detailText = JSON.stringify(data || {});
  const isDaily = /per.?day|requestsperday|inputtokensperday|rpd/i.test(detailText);
  const retryInfo = details.find(function (detail) {
    return detail && (detail.retryDelay || /RetryInfo/i.test(String(detail["@type"] || "")));
  });
  const err = new Error(
    isDaily
      ? "Gemini's daily project quota is used up. It resets at midnight Pacific time."
      : "Gemini reached a project rate or token limit. Your emails can still load without AI sorting."
  );
  err.code = "GEMINI_QUOTA";
  err.httpStatus = 429;
  err.quotaKind = isDaily ? "daily" : "rate";
  err.retryDelay = retryInfo && retryInfo.retryDelay ? String(retryInfo.retryDelay) : "";
  return err;
}

// Defensive parse of model output (port of the n8n "Normalize" node's tricks).
// Returns the object, or null if unrecoverable — never throws.
function safeParseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // Strip markdown fences if the model added them anyway.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  // Slice to the outermost braces.
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  s = s.slice(a, b + 1);
  try {
    return JSON.parse(s);
  } catch (_) {}
  // Common repair: trailing commas before } or ].
  try {
    return JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
  } catch (_) {}
  return null;
}

// Ask Google which models THIS key can use, pick the best per MODEL_PREFERENCES.
// `exclude` may be one model id or an array of ids to skip. Result is cached.
function pickModel(exclude) {
  const excluded = {};
  (Array.isArray(exclude) ? exclude : [exclude]).forEach(function (id) {
    if (id) excluded[id] = true;
  });
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty("pickedModel");
  const cachedVersion = props.getProperty("pickedModelVersion");
  if (cached && cachedVersion === CONFIG.MODEL_SELECTION_VERSION && !excluded[cached]) return cached;

  const res = UrlFetchApp.fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" + CONFIG.GEMINI_API_KEY,
    { method: "get", muteHttpExceptions: true }
  );
  const code = res.getResponseCode();
  if (code === 400 || code === 403) {
    throw new Error("Your Gemini API key looks invalid or unauthorized (HTTP " + code + "). Re-check the key in CONFIG.");
  }
  if (code !== 200) {
    throw new Error("Couldn't list Gemini models (HTTP " + code + "): " + res.getContentText().slice(0, 200));
  }

  const models = (JSON.parse(res.getContentText()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
    .map((m) => String(m.name).replace(/^models\//, ""))
    .filter((id) => !excluded[id]);

  let chosen = CONFIG.MODEL_PREFERENCES.filter((id) => !excluded[id]).find((id) => models.indexOf(id) !== -1);
  if (!chosen) chosen = models.find((id) => /flash/i.test(id)); // any flash
  if (!chosen) chosen = models[0]; // last resort: anything usable
  if (!chosen) throw new Error("No Gemini model on this key supports generateContent.");

  props.setProperties({
    pickedModel: chosen,
    pickedModelVersion: CONFIG.MODEL_SELECTION_VERSION,
  }, false);
  return chosen;
}

// Debug helper — run this from the editor dropdown to see what your key can use.
function listAvailableModels() {
  const res = UrlFetchApp.fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" + CONFIG.GEMINI_API_KEY,
    { method: "get", muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) {
    Logger.log("Error " + res.getResponseCode() + ": " + res.getContentText());
    return;
  }
  const models = (JSON.parse(res.getContentText()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
    .map((m) => String(m.name).replace(/^models\//, ""));
  Logger.log("Models your key can use for generateContent:\n" + models.join("\n"));
  Logger.log("\nThe script will pick: " + pickModel(""));
}

function buildPrompt(items) {
  const slim = items.map((i) => ({
    id: i.id,
    from: i.from,
    subject: i.subject,
    age: i.age,
    snippet: i.snippet,
    starred: i.starred,
    hasUnsub: i.hasUnsub,
  }));

  const tone = PropertiesService.getScriptProperties().getProperty("toneProfile") || "";
  return [
    "You are an inbox triage assistant. Classify the emails below into buckets.",
    "Return ONLY strict JSON with this exact shape (no markdown, no fences):",
    "{",
    '  "headline": "one warm human sentence summarizing what actually needs attention",',
    '  "items": [{"id":"","bucket":"importantUrgent","topic":"","why":"","action":"","suggestedReply":""}]',
    "}",
    "Rules:",
    "- Return exactly one items[] object for every input email: no omissions and no duplicates.",
    "- Use the email's id verbatim and choose exactly one bucket from: " + TRIAGE_BUCKETS.join(", ") + ".",
    "- starredOverdue: only emails where starred=true.",
    "- canUnsubscribe: promotional/newsletter noise, prefer ones where hasUnsub=true.",
    "- keepSubscriptions: newsletters that seem genuinely useful.",
    "- importantUrgent: real people or systems needing a decision/reply soon.",
    "- topic: a plain 3–8 word description of what the message is actually about, not the original subject; maximum 60 characters.",
    "- suggestedReply: a short, natural draft in the user's voice (only where it helps).",
    tone ? "- Match this learned writing-style profile for suggestedReply: " + tone : "- Keep suggested replies warm, direct, and concise.",
    "- Keep why/action under 120 characters and suggestedReply under 160 characters. Use an empty string when a field is unnecessary.",
    "- Do not invent emails or add any objects not present in the input.",
    "",
    "EMAILS:",
    JSON.stringify(slim),
  ].join("\n");
}

function cleanQuotedText(text) {
  return String(text || "")
    .split(/\n(?:On .+ wrote:|From:\s|-{2,}\s*Forwarded message\s*-{2,})/i)[0]
    .replace(/^>.*$/gm, "")
    .trim();
}

function geminiJson(prompt, maxTokens) {
  const model = pickModel("");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model +
    ":generateContent?key=" + CONFIG.GEMINI_API_KEY;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: maxTokens || 4096,
          thinkingConfig: thinkingConfigForModel(model),
        },
      }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) {
      const data = JSON.parse(res.getContentText());
      const text = (((data.candidates || [])[0] || {}).content || { parts: [] }).parts
        .map(function (part) { return part.text || ""; }).join("");
      const parsed = safeParseJson(text);
      if (parsed) return parsed;
    } else if (code === 429) {
      throw geminiQuotaError(res.getContentText());
    } else if (code !== 500 && code !== 503) {
      throw new Error("Gemini HTTP " + code + ": " + res.getContentText().slice(0, 200));
    }
    Utilities.sleep(1500 * (attempt + 1));
  }
  throw new Error("Gemini could not prepare this content. Try again shortly.");
}

function expandCompactSummary(parsed) {
  if (!parsed || !Array.isArray(parsed.items)) return parsed || {};
  const expanded = { headline: parsed.headline || "" };
  TRIAGE_BUCKETS.forEach(function (key) { expanded[key] = []; });
  parsed.items.forEach(function (item) {
    if (!item || TRIAGE_BUCKETS.indexOf(item.bucket) === -1) return;
    const why = item.why || "";
    expanded[item.bucket].push({
      id: item.id || "",
      topic: item.topic || "",
      why: why,
      action: item.action || "",
      reason: why,
      context: why,
      suggestedReply: item.suggestedReply || "",
    });
  });
  return expanded;
}

// Merge Gemini's classification back with our trusted original fields (esp. URLs).
function mergeBuckets(parsed, items) {
  parsed = expandCompactSummary(parsed);
  const byId = {};
  items.forEach((i) => (byId[i.id] = i));
  const out = Object.assign({}, EMPTY_SUMMARY);
  out.headline = parsed.headline || "";
  const placed = {};

  Object.keys(EMPTY_SUMMARY).forEach((key) => {
    if (key === "headline" || key === "generatedAt" || key === "unreadCount") return;
    const arr = parsed[key] || [];
    out[key] = arr
      .map((g) => {
        const orig = byId[g.id];
        if (!orig || placed[orig.id]) return null;
        placed[orig.id] = true;
        return {
          id: orig.id,
          from: orig.from,
          subject: orig.subject,
          topic: g.topic || "",
          age: orig.age,
          link: orig.link || "",
          why: g.why || "",
          action: g.action || "",
          reason: g.reason || "",
          context: g.context || "",
          suggestedReply: g.suggestedReply || "",
          unsubMethod: orig.unsubMethod || "",
          unsubTarget: orig.unsubTarget || "",
        };
      })
      .filter(Boolean);
  });

  // A syntactically valid AI response can still omit or duplicate an id. Never
  // let that make a real Gmail message disappear from the board.
  items.forEach(function (orig) {
    if (placed[orig.id]) return;
    const entry = {
      id: orig.id,
      from: orig.from,
      subject: orig.subject,
      topic: String(orig.subject || "(no subject)")
        .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
        .slice(0, 60),
      age: orig.age,
      link: orig.link || "",
      why: "AI did not classify this message, so it was kept for manual review.",
      action: "Open the email and review it.",
      reason: "Kept because the AI response omitted it.",
      context: "Starred message kept for manual review.",
      suggestedReply: "",
      unsubMethod: orig.unsubMethod || "",
      unsubTarget: orig.unsubTarget || "",
    };
    (orig.starred ? out.starredOverdue : out.whatsNew).push(entry);
  });
  return out;
}

/* ============================ ACTIONS ============================ */

// Fast thread content for the in-app reader. This deliberately avoids Gemini:
// Gmail returns immediately, no remote images load, and no tracking pixels fire.
function doThread(body) {
  try {
    const thread = GmailApp.getMessageById(body.id).getThread();
    const identities = myAddresses();
    const messages = thread.getMessages().map(function (m) {
      const cleaned = cleanThreadBody(safeBody(m));
      const from = messageFrom(m);
      return {
        senderName: senderName(from, identities),
        from: from,
        date: m.getDate().toISOString(),
        summary: threadPreview(cleaned),
        body: (cleaned || "No text content — open in Gmail to view.").slice(0, 6000),
        isMe: isMine(from, identities),
      };
    });
    return {
      ok: true,
      subject: thread.getFirstMessageSubject() || "(no subject)",
      messages: messages,
      link: "https://mail.google.com/mail/u/0/#all/" + body.id,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function myAddresses() {
  const all = [];
  try { all.push(Session.getActiveUser().getEmail()); } catch (_) {}
  try { all.push(Session.getEffectiveUser().getEmail()); } catch (_) {}
  try { Array.prototype.push.apply(all, GmailApp.getAliases() || []); } catch (_) {}
  return all
    .map(function (value) { return addressOnly(value); })
    .filter(function (value, index, values) { return value && values.indexOf(value) === index; });
}

function messageFrom(message) {
  const readers = [
    function () { return message.getFrom(); },
    function () { return message.getHeader("From"); },
    function () { return message.getReplyTo(); },
    function () { return message.getHeader("Reply-To"); },
    function () { return message.getHeader("Return-Path"); },
  ];
  for (let i = 0; i < readers.length; i++) {
    try {
      const value = String(readers[i]() || "").trim();
      if (value) return value;
    } catch (_) {}
  }
  return "";
}

function addressOnly(value) {
  const match = String(value || "").match(/<([^>]+)>/);
  return String(match ? match[1] : value || "").trim().toLowerCase();
}

function isMine(from, identities) {
  return identities.indexOf(addressOnly(from)) !== -1;
}

function senderName(from, identities) {
  if (isMine(from, identities)) return "Shelvi";
  const text = decodeHeaderWords(String(from || ""));
  const name = text.replace(/<[^>]+>/g, "").replace(/^[\s'\"]+|[\s'\"]+$/g, "").trim();
  if (name && name.indexOf("@") === -1) return name;
  const local = addressOnly(text).split("@")[0].replace(/[._-]+/g, " ");
  return local.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || "Unknown sender";
}

function decodeHeaderWords(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, function (_, charset, encoding, encoded) {
    try {
      if (String(encoding).toLowerCase() === "b") {
        return Utilities.newBlob(Utilities.base64Decode(encoded)).getDataAsString(charset || "UTF-8");
      }
      const bytes = [];
      const text = encoded.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, function (match, hex) {
        bytes.push(parseInt(hex, 16));
        return "\u0000";
      });
      let byteIndex = 0;
      const rebuilt = [];
      for (let i = 0; i < text.length; i++) {
        rebuilt.push(text.charAt(i) === "\u0000" ? bytes[byteIndex++] : text.charCodeAt(i));
      }
      return Utilities.newBlob(rebuilt).getDataAsString(charset || "UTF-8");
    } catch (_) {
      return encoded;
    }
  });
}

function isForwardedMarker(line) {
  const marker = String(line || "").replace(/^\s*(?:>\s*)+/, "").trim();
  return /^-{2,}\s*(?:forwarded message|original message)\s*-{2,}$/i.test(marker) ||
    /^begin forwarded message:$/i.test(marker);
}

function withoutReplyQuotePrefix(line) {
  return String(line || "").replace(/^\s*(?:>\s*)*/, "").trim();
}

function replyHistoryStart(lines) {
  for (let i = 0; i < lines.length; i++) {
    const first = withoutReplyQuotePrefix(lines[i]);

    // Gmail can wrap its quote header across several plain-text lines:
    // On Mon., Jul 13, 2026 at 11:42 AM Courtney Butler
    // <courtney@example.com>
    // wrote:
    if (/^On\s+\S/i.test(first)) {
      const headerParts = [];
      for (let j = i; j < Math.min(lines.length, i + 5); j++) {
        const part = withoutReplyQuotePrefix(lines[j]);
        if (part) headerParts.push(part);
        if (/\bwrote:\s*$/i.test(part)) {
          const header = headerParts.join(" ");
          // Gmail quote headers include the original sender's email address.
          // Requiring it avoids cutting off ordinary prose such as "On Monday
          // we wrote: the new process...".
          if (/\S+@\S+/.test(header)) return i;
          break;
        }
      }
    }

    // Outlook-style reply history has a compact From/Sent/To/Subject header.
    // Explicit forwarded-message blocks are protected by cleanThreadBody.
    if (/^From:\s*\S/i.test(first)) {
      const nearby = lines.slice(i, i + 9).map(withoutReplyQuotePrefix);
      const hasSent = nearby.some(function (line) { return /^Sent:\s*\S/i.test(line); });
      const hasTo = nearby.some(function (line) { return /^To:\s*\S/i.test(line); });
      const hasSubject = nearby.some(function (line) { return /^Subject:\s*\S/i.test(line); });
      if (hasSent && hasTo && hasSubject) return i;
    }
  }
  return -1;
}

function signatureStart(lines) {
  const signoff = /^(?:thanks|thank you|many thanks|regards|kind regards|best|best regards|warm regards|cheers|sincerely)[,!]?$/i;
  const mobile = /^sent from my (?:iphone|ipad|android|samsung|mobile)|^sent from outlook for/i;
  const disclaimer = /^(?:confidentiality notice|this e-?mail and any attachments)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    const before = lines.slice(0, i).filter(function (value) { return String(value || "").trim(); });
    if (before.length < 1) continue;

    const after = lines.slice(i + 1).filter(function (value) { return String(value || "").trim(); });
    if (after.length > 14) continue;

    if (/^(?:--|__+)$/.test(line) || mobile.test(line) || disclaimer.test(line)) return i;
    if (!signoff.test(line) || !after.length) continue;

    const firstAfter = String(after[0] || "").trim();
    const shortNameLike = firstAfter.length <= 60 &&
      firstAfter.split(/\s+/).length <= 5 &&
      !/[.!?]$/.test(firstAfter);
    const hasSignatureEvidence = after.some(function (value) {
      const part = String(value || "").trim();
      const digits = (part.match(/\d/g) || []).length;
      return /@|https?:\/\/|www\.|\[image:|(?:manager|leader|director|coordinator|officer|team|department|pty\.?\s*ltd|limited|inc\.?|llc)\b/i.test(part) ||
        digits >= 7;
    });
    if (hasSignatureEvidence || (before.length >= 2 && after.length <= 3 && shortNameLike)) return i;
  }
  return -1;
}

function stripOuterSignature(lines) {
  const forwardedAt = lines.findIndex(isForwardedMarker);
  const sectionEnd = forwardedAt >= 0 ? forwardedAt : lines.length;
  const intro = lines.slice(0, sectionEnd);
  const signatureAt = signatureStart(intro);
  if (signatureAt < 0) return lines;

  const withoutSignature = intro.slice(0, signatureAt);
  if (forwardedAt < 0) return withoutSignature;
  return withoutSignature.concat([""], lines.slice(forwardedAt));
}

function cleanThreadBody(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  const lines = normalized.split("\n");
  const hasForwardedMessage = lines.some(isForwardedMarker);
  let kept = lines;

  // Gmail already returns every normal reply as a separate message. Remove the
  // duplicated quoted history only when this message is not explicitly forwarding
  // another email; forwarded headers, quoted lines and URLs are useful content.
  if (!hasForwardedMessage) {
    const replyHistoryAt = replyHistoryStart(lines);
    if (replyHistoryAt >= 0) kept = lines.slice(0, replyHistoryAt);
  }

  // Remove only the outer message's signature. For forwarded mail, the
  // forwarded block remains untouched because its sender details are content.
  kept = stripOuterSignature(kept);

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function threadPreview(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "No message preview.";
  return flat.length > 180 ? flat.slice(0, 177) + "…" : flat;
}

// Learn from messages genuinely authored by the active account/aliases. The
// samples live only in memory; Script Properties receives only the profile.
function learnTone() {
  const identities = myAddresses();
  const samples = [];
  GmailApp.search("in:sent newer_than:180d", 0, 30).some(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (samples.length < CONFIG.TONE_SAMPLE_LIMIT && isMine(messageFrom(message), identities)) {
        const cleaned = cleanQuotedText(safeBody(message)).slice(0, CONFIG.TONE_SAMPLE_CHARS);
        if (cleaned) samples.push(cleaned);
      }
    });
    return samples.length >= CONFIG.TONE_SAMPLE_LIMIT;
  });
  if (!samples.length) return { ok: false, error: "No recent sent messages were found." };
  const parsed = geminiJson([
    "Return ONLY JSON: {\"profile\":\"a compact writing-style profile under 700 characters\"}.",
    "Describe greeting, tone, sentence length, directness, sign-off, punctuation, and emoji habits. Do not quote or retain private facts.",
    JSON.stringify(samples),
  ].join("\n"), 2048);
  if (!parsed || !parsed.profile) throw new Error("Gemini did not return a writing-style profile.");
  PropertiesService.getScriptProperties().setProperty("toneProfile", String(parsed.profile).slice(0, 700));
  return { ok: true, done: samples.length, message: "Writing style updated from " + samples.length + " sent messages." };
}

// Reply on the LAST message of the thread so Gmail threads it correctly,
// even if the id we hold is an older message in the conversation.
function latestInThread(id) {
  const msgs = GmailApp.getMessageById(id).getThread().getMessages();
  return msgs[msgs.length - 1];
}

function doDraft(body) {
  try {
    const m = latestInThread(body.id);
    m.createDraftReply(body.suggestedReply || "");
    m.getThread().markRead(); // handling it counts as read
    return { ok: true, done: 1 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Send a real reply (marks read). The desktop app always shows/edits the text first.
function doSend(body) {
  try {
    const m = latestInThread(body.id);
    m.reply(body.suggestedReply || "");
    m.getThread().markRead();
    return { ok: true, done: 1 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function doMarkRead(ids) {
  try {
    let done = 0;
    ids.forEach((id) => {
      // Whole thread — Gmail's unread bold is per-thread, not per-message.
      GmailApp.getMessageById(id).getThread().markRead();
      done++;
    });
    return { ok: true, done: done };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Undo for mark-read (also "bring back" for cleaned-up items).
function doMarkUnread(ids) {
  try {
    let done = 0;
    ids.forEach((id) => {
      GmailApp.getMessageById(id).getThread().markUnread();
      done++;
    });
    return { ok: true, done: done };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Mark the whole inbox read, in batches (capped so it never runs away).
function doMarkAllRead() {
  try {
    let done = 0;
    for (let i = 0; i < 5; i++) {
      const threads = GmailApp.search("in:inbox is:unread", 0, 100);
      if (!threads.length) break;
      GmailApp.markThreadsRead(threads);
      done += threads.length;
    }
    return { ok: true, done: done };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function doLabel(ids) {
  try {
    let label = GmailApp.getUserLabelByName(CONFIG.SUBSCRIPTIONS_LABEL);
    if (!label) label = GmailApp.createLabel(CONFIG.SUBSCRIPTIONS_LABEL);
    let done = 0;
    ids.forEach((id) => {
      const t = GmailApp.getMessageById(id).getThread();
      t.addLabel(label);
      t.moveToArchive();
      t.markRead();
      done++;
    });
    return { ok: true, done: done };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function doUnarchive(ids) {
  try {
    let done = 0;
    ids.forEach((id) => {
      GmailApp.getMessageById(id).getThread().moveToInbox();
      done++;
    });
    return { ok: true, done: done };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function doUnsubscribe(items) {
  let done = 0;
  items.forEach((it) => {
    if (it.unsubMethod === "oneclick" && it.unsubTarget) {
      try {
        UrlFetchApp.fetch(it.unsubTarget, {
          method: "post",
          contentType: "application/x-www-form-urlencoded",
          payload: "List-Unsubscribe=One-Click",
          muteHttpExceptions: true,
        });
        done++;
      } catch (_) {}
    }
    if (it.id) {
      try {
        GmailApp.getMessageById(it.id).markRead();
      } catch (_) {}
    }
  });
  // mailto/link items are opened by the desktop app itself.
  return { ok: true, done: done };
}

/* ======================= LATEST STORAGE ======================= */
// ScriptProperties value limit is ~9KB, so chunk the JSON.

function saveLatest(summary) {
  const s = JSON.stringify(summary);
  const CHUNK = 8000;
  const n = Math.ceil(s.length / CHUNK);
  const props = PropertiesService.getScriptProperties();
  const previousN = parseInt(props.getProperty("latest_n") || "0", 10);
  const map = { latest_n: String(n) };
  for (let i = 0; i < n; i++) map["latest_" + i] = s.substr(i * CHUNK, CHUNK);
  props.setProperties(map, false);
  for (let i = n; i < previousN; i++) props.deleteProperty("latest_" + i);
}

function getLatest() {
  const props = PropertiesService.getScriptProperties();
  const n = parseInt(props.getProperty("latest_n") || "0", 10);
  if (!n) {
    return Object.assign({}, EMPTY_SUMMARY, {
      headline: "No summary yet — tap “What's important?” to run one.",
    });
  }
  let s = "";
  for (let i = 0; i < n; i++) s += props.getProperty("latest_" + i) || "";
  try {
    return JSON.parse(s);
  } catch (_) {
    return Object.assign({}, EMPTY_SUMMARY, { headline: "(stored summary was unreadable)" });
  }
}

/* ======================= OPTIONAL: MORNING RUN ======================= */
// Run once manually to install a weekday 8am auto-refresh (optional).
function runWeekdayMorningTriage() {
  const day = new Date().getDay();
  if (day !== 0 && day !== 6) runTriage();
}

function installMorningTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (["runTriage", "runWeekdayMorningTriage"].indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger("runWeekdayMorningTriage").timeBased().atHour(8).everyDays(1).create();
}
