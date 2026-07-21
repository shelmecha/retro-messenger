"use strict";

// Reader window: shows one full email thread (plain text) with reply + Gmail.
(function () {
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "";
  const subject = params.get("subject") || "(no subject)";
  const link = params.get("link") || "";

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  const subjEl = document.getElementById("readerSubject");
  const threadEl = document.getElementById("threadList");
  const replyArea = document.getElementById("replyArea");

  subjEl.textContent = subject;

  document.getElementById("readerClose").onclick = () => window.retro.reader.close();
  document.getElementById("btnOpenGmail").onclick = () => window.retro.action.openExternal(link || "https://mail.google.com/");

  // Title-bar + close should feel instant; load the thread body next.
  loadThread();

  async function loadThread() {
    threadEl.innerHTML = '<div class="reader-loading">Opening the conversation…</div>';
    const r = await window.retro.thread.get(id);
    if (!r || !r.ok || !r.data) {
      threadEl.innerHTML =
        '<div class="reader-loading err">Couldn\'t load this thread' +
        (r && r.code === "NOT_SUPPORTED" ? " — it needs the updated Apps Script backend." : ".") +
        " Try Open in Gmail.</div>";
      return;
    }
    const data = r.data;
    if (data.subject) subjEl.textContent = data.subject;
    threadEl.innerHTML = "";
    (data.messages || []).forEach((m, index) => {
      const row = document.createElement("div");
      row.className = "thread-row" + (m.isMe ? " mine" : "");
      row.style.setProperty("--stagger", `${index * 55}ms`);
      const name = String(m.senderName || "Unknown sender").trim();
      const initials = name.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase() || "?";
      row.innerHTML =
        `<div class="thread-avatar" aria-hidden="true">${esc(initials)}</div>` +
        `<article class="thread-msg"><div class="thread-head"><span class="thread-from">${esc(name)}</span>` +
        `<time class="thread-date">${esc(friendlyDate(m.date))}</time></div>` +
        `<div class="thread-summary">${esc(m.summary || "No summary available.")}</div>` +
        `<details class="thread-details"><summary>Show cleaned message</summary>` +
        `<div class="thread-body">${esc(m.body)}</div></details></article>`;
      threadEl.appendChild(row);
    });
    threadEl.scrollTop = 0;
  }

  function friendlyDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "");
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (sameDay) return "Today at " + time;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday at " + time;
    return date.toLocaleDateString([], { month: "short", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" }) + " at " + time;
  }

  // ---- reply -------------------------------------------------------------
  document.getElementById("btnReplyToggle").onclick = toggleReply;

  function toggleReply() {
    if (replyArea.dataset.open === "1") {
      replyArea.innerHTML = "";
      replyArea.dataset.open = "";
      return;
    }
    replyArea.dataset.open = "1";
    replyArea.innerHTML = "";

    const ta = document.createElement("textarea");
    ta.className = "reply-box";
    ta.rows = 5;
    ta.placeholder = "Type your reply…";

    const row = document.createElement("div");
    row.className = "send-row";

    const result = document.createElement("div");
    result.className = "card-result hidden";

    const showResult = (text, err) => {
      result.textContent = text;
      result.classList.toggle("err", !!err);
      result.classList.remove("hidden");
    };

    const finish = (r, okMsg) => {
      if (r && r.ok) {
        showResult(r.mock ? okMsg.demo : okMsg.live);
      } else if (r && r.code === "NOT_SUPPORTED") {
        row.querySelectorAll("button").forEach((b) => (b.disabled = false));
        showResult("Sending needs the updated Apps Script backend.", true);
      } else {
        row.querySelectorAll("button").forEach((b) => (b.disabled = false));
        showResult("Failed: " + ((r && r.message) || "error"), true);
      }
    };

    const send = mkBtn("📨 Send now", "default", async () => {
      row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const r = await window.retro.action.send({ id, suggestedReply: ta.value });
      finish(r, { demo: "✓ (demo) sent", live: "✓ Sent — it's in the thread in Gmail" });
    });
    const draft = mkBtn("💾 Save draft", null, async () => {
      row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const r = await window.retro.action.draft({ id, suggestedReply: ta.value });
      finish(r, { demo: "✓ (demo) draft saved", live: "✓ Draft saved — review in Gmail" });
    });

    row.appendChild(send);
    row.appendChild(draft);
    replyArea.appendChild(ta);
    replyArea.appendChild(row);
    replyArea.appendChild(result);
    ta.focus();
  }

  function mkBtn(label, cls, handler) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.classList.add(cls);
    b.onclick = handler;
    return b;
  }
})();
