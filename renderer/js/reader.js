"use strict";

// Reader window: shows one full email thread (plain text) with reply + Gmail.
(function () {
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "";
  const requestedSubject = params.get("subject") || "";
  const requestedFrom = params.get("from") || "";
  const subject = requestedSubject || "(no subject)";
  const link = params.get("link") || "";

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function senderLabel(message, fallbackFrom) {
    if (message && message.isMe) return "Shelvi";
    const candidates = [
      message && message.senderName,
      message && message.from,
      message && message.sender,
      message && message.senderEmail,
      fallbackFrom,
    ];
    const raw = String(candidates.find((value) => value && !/^unknown sender$/i.test(String(value).trim())) || "").trim();
    if (!raw) return "Unknown sender";
    const display = raw.replace(/<[^>]+>/g, "").replace(/^[\s'\"]+|[\s'\"]+$/g, "").trim();
    if (display && !display.includes("@")) return display;
    const emailMatch = raw.match(/<([^>]+)>/);
    const address = String(emailMatch ? emailMatch[1] : raw).trim();
    const local = address.split("@")[0].replace(/[._-]+/g, " ").trim();
    return local.replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Unknown sender";
  }

  function formatMailBody(value) {
    const source = String(value || "No text content — open in Gmail to view.").replace(/\r\n?/g, "\n");
    const lines = source.split("\n");
    const withoutQuoteMarker = (line) => line.replace(/^\s*(?:>\s*)+/, "");
    const forwardedAt = lines.findIndex((line) => {
      const marker = withoutQuoteMarker(line).trim();
      return (
        /^-{2,}\s*(?:forwarded message|original message)\s*-{2,}$/i.test(marker) ||
        /^begin forwarded message:$/i.test(marker)
      );
    });

    if (forwardedAt < 0) return `<div class="mail-body-text">${esc(source)}</div>`;

    const normalText = lines.slice(0, forwardedAt).join("\n").replace(/\n+$/, "");
    const forwardedText = lines.slice(forwardedAt).map(withoutQuoteMarker).join("\n");
    return (
      (normalText ? `<div class="mail-body-text">${esc(normalText)}</div>` : "") +
      `<blockquote class="mail-forwarded">${esc(forwardedText)}</blockquote>`
    );
  }

  const subjEl = document.getElementById("readerSubject");
  const countEl = document.getElementById("readerCount");
  const threadEl = document.getElementById("threadList");
  const replyArea = document.getElementById("replyArea");

  subjEl.textContent = subject;

  document.getElementById("readerClose").onclick = () => window.retro.reader.close();
  document.getElementById("btnOpenGmail").onclick = () => window.retro.action.openExternal(link || "https://mail.google.com/");

  // Title-bar + close should feel instant; load the thread body next.
  loadThread();

  async function loadThread() {
    threadEl.innerHTML =
      '<div class="reader-loading"><span class="reader-spinner" aria-hidden="true"></span>' +
      "Loading messages…</div>";
    const r = await window.retro.thread.get(id);
    if (!r || !r.ok || !r.data) {
      threadEl.innerHTML =
        '<div class="reader-loading err">Couldn\'t load this thread' +
        (r && r.code === "NOT_SUPPORTED" ? " — it needs the updated Apps Script backend." : ".") +
        " Try Open in Gmail.</div>";
      return;
    }
    const data = r.data;
    if (data.subject && !requestedSubject) subjEl.textContent = data.subject;
    const messages = data.messages || [];
    countEl.textContent = messages.length + " message" + (messages.length === 1 ? "" : "s");
    threadEl.innerHTML = "";
    messages.forEach((m, index) => {
      const message = document.createElement("div");
      message.className = "mail-message" + (m.isMe ? " mine" : "") + (index === messages.length - 1 ? " expanded" : "");
      message.tabIndex = 0;
      message.setAttribute("role", "button");
      message.setAttribute("aria-expanded", index === messages.length - 1 ? "true" : "false");
      message.style.setProperty("--stagger", `${Math.min(index * 35, 210)}ms`);
      const name = senderLabel(m, messages.length === 1 ? requestedFrom : "");
      const initials = name.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase() || "?";
      message.innerHTML =
        `<div class="mail-avatar" aria-hidden="true">${esc(initials)}</div>` +
        `<article class="mail-content"><div class="mail-head"><span class="mail-from">${esc(name)}</span>` +
        `<span class="mail-head-end"><time class="mail-date">${esc(friendlyDate(m.date))}</time>` +
        `<span class="mail-chevron" aria-hidden="true">›</span></span></div>` +
        `<div class="mail-preview">${esc(m.summary || preview(m.body))}</div>` +
        `<div class="mail-expanded"><div class="mail-recipient">${m.isMe ? "from me" : "to me"}</div>` +
        `<div class="mail-body">${formatMailBody(m.body)}</div></div></article>`;
      const toggle = () => expandMessage(message);
      message.onclick = toggle;
      message.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      };
      threadEl.appendChild(message);
    });
    const newest = threadEl.lastElementChild;
    if (newest) newest.scrollIntoView({ block: "nearest" });
  }

  function expandMessage(selected) {
    const shouldExpand = !selected.classList.contains("expanded");
    threadEl.querySelectorAll(".mail-message").forEach((message) => {
      const expanded = message === selected && shouldExpand;
      message.classList.toggle("expanded", expanded);
      message.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  }

  function preview(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > 160 ? text.slice(0, 157) + "…" : text || "No message preview.";
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
