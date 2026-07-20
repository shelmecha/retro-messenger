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
    (data.messages || []).forEach((m) => {
      const el = document.createElement("div");
      el.className = "thread-msg";
      el.innerHTML =
        `<div class="thread-head"><span class="thread-from">${esc(m.from)}</span>` +
        `<span class="thread-date">${esc(m.date)}</span></div>` +
        `<div class="thread-body">${esc(m.body)}</div>`;
      threadEl.appendChild(el);
    });
    threadEl.scrollTop = 0;
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
