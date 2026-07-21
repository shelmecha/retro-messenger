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

const BACKEND_VERSION = "0.7.2";

const CONFIG = {
  GEMINI_API_KEY: "PASTE_YOUR_GEMINI_KEY_HERE", // from https://aistudio.google.com/apikey
  // No hardcoded model — the script asks Google which models YOUR key can use
  // and picks the best available, in this order of preference:
  MODEL_PREFERENCES: [
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  INBOX_QUERY: "in:inbox newer_than:3d",
  INBOX_LIMIT: 20,
  STARRED_QUERY: "is:starred older_than:5d",
  STARRED_LIMIT: 10,
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

/* ============================ ROUTING ============================ */

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "latest";
    if (action === "run") return json(runTriage());
    return json(getLatest());
  } catch (err) {
    // Return the error AS JSON so the app can show the real reason instead of
    // an un-parseable HTML crash page.
    return json({ ok: false, code: "BACKEND_ERROR", error: String((err && err.message) || err) });
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
    return json({ ok: false, code: "BACKEND_ERROR", error: String((err && err.message) || err) });
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
  const parsed = geminiSummarize(items);
  const summary = mergeBuckets(parsed, items);
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
  const delta = mergeBuckets(geminiSummarize(additions), additions);
  bucketKeys().forEach(function (key) {
    latest[key] = (latest[key] || []).concat(delta[key] || []);
  });
  latest.generatedAt = syncAt.toISOString();
  latest.unreadCount = countUnread();
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
    from: m.getFrom(),
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
  const payload = {
    contents: [{ parts: [{ text: buildPrompt(items) }] }],
    // Big output budget: thinking models spend tokens on reasoning before the
    // JSON, and a truncated reply is what breaks JSON.parse.
    generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 8192 },
  };

  let model = pickModel("");
  let malformed = 0; // times the model returned unparseable JSON
  let transient = 0; // times Google returned a temporary 5xx

  for (let attempt = 0; attempt < 8; attempt++) {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent?key=" +
      CONFIG.GEMINI_API_KEY;

    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();

    if (code === 200) {
      const data = JSON.parse(res.getContentText());
      const text =
        (((data.candidates || [])[0] || {}).content || { parts: [] }).parts
          .map(function (p) {
            return p.text || "";
          })
          .join("") || "";
      const parsed = safeParseJson(text);
      if (parsed) return parsed;
      if (++malformed < 2) continue; // model hiccup — ask again once
      throw new Error("Gemini answered with malformed JSON twice — run again in a minute.");
    }

    // Temporary overload/outage — back off and retry a few times so brief
    // demand spikes heal themselves instead of surfacing as an error.
    if ((code === 503 || code === 500 || code === 429) && transient < 3) {
      transient++;
      Utilities.sleep(2000 * transient); // 2s, 4s, 6s
      continue;
    }

    if (code === 429) {
      throw new Error(
        "Gemini is rate-limited right now. Wait about a minute and try again " +
          "(free tier allows ~10 requests per minute)."
      );
    }

    if (code === 503 || code === 500) {
      throw new Error("Gemini is temporarily overloaded (high demand). Give it a minute and try again.");
    }

    if (code === 404 && model) {
      // Model retired/unavailable for this key — forget it and re-pick.
      PropertiesService.getScriptProperties().deleteProperty("pickedModel");
      const next = pickModel(model);
      if (next && next !== model) {
        model = next;
        continue;
      }
    }

    throw new Error(
      "Gemini HTTP " + code + " on model '" + model + "': " + res.getContentText().slice(0, 200)
    );
  }
  throw new Error("Gemini kept failing after several retries — likely temporary. Try again shortly.");
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
// `exclude` is a model id to skip (e.g. one that just 404'd). Result is cached.
function pickModel(exclude) {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty("pickedModel");
  if (cached && cached !== exclude) return cached;

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
    .filter((id) => id !== exclude);

  let chosen = CONFIG.MODEL_PREFERENCES.filter((id) => id !== exclude).find((id) => models.indexOf(id) !== -1);
  if (!chosen) chosen = models.find((id) => /flash/i.test(id)); // any flash
  if (!chosen) chosen = models[0]; // last resort: anything usable
  if (!chosen) throw new Error("No Gemini model on this key supports generateContent.");

  props.setProperty("pickedModel", chosen);
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
    '  "importantUrgent": [{"id":"","topic":"","why":"","action":"","suggestedReply":""}],',
    '  "needsFollowUp":   [{"id":"","topic":"","suggestedReply":""}],',
    '  "starredOverdue":  [{"id":"","topic":"","context":"","suggestedReply":""}],',
    '  "canUnsubscribe":  [{"id":"","topic":"","reason":""}],',
    '  "keepSubscriptions":[{"id":"","topic":"","why":""}],',
    '  "whatsNew":        [{"id":"","topic":"","why":""}],',
    '  "cleanedUp":       [{"id":"","topic":"","reason":""}]',
    "}",
    "Rules:",
    "- Every email goes in exactly ONE bucket. Use the email's id verbatim.",
    "- starredOverdue: only emails where starred=true.",
    "- canUnsubscribe: promotional/newsletter noise, prefer ones where hasUnsub=true.",
    "- keepSubscriptions: newsletters that seem genuinely useful.",
    "- importantUrgent: real people or systems needing a decision/reply soon.",
    "- topic: a plain 3–8 word description of what the message is actually about, not the original subject; maximum 60 characters.",
    "- suggestedReply: a short, natural draft in the user's voice (only where it helps).",
    tone ? "- Match this learned writing-style profile for suggestedReply: " + tone : "- Keep suggested replies warm, direct, and concise.",
    "- Keep every text field under 200 characters. Do not invent emails not listed.",
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
        generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: maxTokens || 4096 },
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
    } else if (code !== 429 && code !== 500 && code !== 503) {
      throw new Error("Gemini HTTP " + code + ": " + res.getContentText().slice(0, 200));
    }
    Utilities.sleep(1500 * (attempt + 1));
  }
  throw new Error("Gemini could not prepare this content. Try again shortly.");
}

// Merge Gemini's classification back with our trusted original fields (esp. URLs).
function mergeBuckets(parsed, items) {
  const byId = {};
  items.forEach((i) => (byId[i.id] = i));
  const out = Object.assign({}, EMPTY_SUMMARY);
  out.headline = parsed.headline || "";

  Object.keys(EMPTY_SUMMARY).forEach((key) => {
    if (key === "headline" || key === "generatedAt" || key === "unreadCount") return;
    const arr = parsed[key] || [];
    out[key] = arr
      .map((g) => {
        const orig = byId[g.id];
        if (!orig) return null;
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
      return {
        senderName: senderName(m.getFrom(), identities),
        date: m.getDate().toISOString(),
        summary: threadPreview(cleaned),
        body: (cleaned || "No text content — open in Gmail to view.").slice(0, 6000),
        isMe: isMine(m.getFrom(), identities),
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
  const all = [Session.getActiveUser().getEmail()].concat(GmailApp.getAliases() || []);
  return all.map(function (value) { return String(value || "").toLowerCase(); }).filter(Boolean);
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
  const text = String(from || "");
  const name = text.replace(/<[^>]+>/g, "").replace(/^['\"]|['\"]$/g, "").trim();
  if (name && name.indexOf("@") === -1) return name;
  const local = addressOnly(text).split("@")[0].replace(/[._-]+/g, " ");
  return local.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || "Unknown sender";
}

function cleanThreadBody(text) {
  return cleanQuotedText(text)
    .replace(/\u00a0/g, " ")
    .split(/\n(?:--\s*$|Sent from my\b|Get Outlook for\b)/im)[0]
    .replace(/^\s*https?:\/\/\S+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  GmailApp.search("in:sent newer_than:180d", 0, 50).some(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (samples.length < 50 && isMine(message.getFrom(), identities)) {
        const cleaned = cleanQuotedText(safeBody(message)).slice(0, 2500);
        if (cleaned) samples.push(cleaned);
      }
    });
    return samples.length >= 50;
  });
  if (!samples.length) return { ok: false, error: "No recent sent messages were found." };
  const parsed = geminiJson([
    "Return ONLY JSON: {\"profile\":\"a compact writing-style profile under 700 characters\"}.",
    "Describe greeting, tone, sentence length, directness, sign-off, punctuation, and emoji habits. Do not quote or retain private facts.",
    JSON.stringify(samples),
  ].join("\n"));
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
  const map = { latest_n: String(n) };
  for (let i = 0; i < n; i++) map["latest_" + i] = s.substr(i * CHUNK, CHUNK);
  PropertiesService.getScriptProperties().setProperties(map, false);
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
function installMorningTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "runTriage") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("runTriage").timeBased().atHour(8).everyDays(1).create();
}
