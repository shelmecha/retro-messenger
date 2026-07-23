"use strict";

// Turns triage items into chat cards with per-item actions. Namespace: window.Triage
(function () {
  const esc = (s) => window.ChatUI.esc(s);

  const TEMPLATES = [
    { label: "Acknowledge", body: "Got it — thanks for this. I'll follow up shortly." },
    { label: "Need info", body: "Thanks for reaching out. Could you share a little more detail so I can help properly?" },
    { label: "Not right now", body: "Appreciate this — I'm heads-down at the moment and will circle back next week." },
  ];

  // Per-bucket display config. `key` is the JSON field; `meta` is which item
  // field to show as the explanation line.
  const BUCKETS = {
    importantUrgent: { type: "urgent", badge: "🔴 Important / Urgent", meta: "why", chip: "🔴 Urgent" },
    starredOverdue: { type: "starred", badge: "⭐ Starred · overdue", meta: "context", chip: "⭐ Starred overdue" },
    needsFollowUp: { type: "followup", badge: "✉️ Needs follow-up", meta: null, chip: "✉️ Follow-up" },
    canUnsubscribe: { type: "unsub", badge: "🗑️ Subscription", meta: "reason", chip: "🗑️ Unsubscribe" },
    keepSubscriptions: { type: "keep", badge: "📌 Worth keeping", meta: "why", chip: "📌 Worth keeping" },
    whatsNew: { type: "new", badge: "🆕 What's new", meta: "why", chip: "🆕 What's new" },
    cleanedUp: { type: "cleaned", badge: "🧹 Cleaned up", meta: "reason", chip: "🧹 Cleaned up" },
  };

  const ORDER = [
    "importantUrgent",
    "starredOverdue",
    "needsFollowUp",
    "canUnsubscribe",
    "keepSubscriptions",
    "whatsNew",
    "cleanedUp",
  ];

  // Buckets that support "✍️ Draft reply". (Cleaned-up items don't reply
  // directly — you rescue them into a real pile first, then reply there.)
  const REPLYABLE = ["urgent", "starred", "followup", "new"];

  // Where a mis-filed "cleaned up" email can be rescued to.
  const MOVE_TARGETS = [
    { key: "importantUrgent", label: "🔴 Urgent" },
    { key: "needsFollowUp", label: "✉️ Follow-up" },
    { key: "whatsNew", label: "🆕 What's new" },
  ];

  function showResult(card, text, isErr) {
    const el = card.querySelector(".card-result");
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
    el.classList.remove("hidden");
  }

  function actBtn(label, cls, handler) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.classList.add(cls);
    b.onclick = handler;
    return b;
  }

  function cardTopic(item) {
    const value = String(item.topic || item.subject || "(no subject)")
      .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
      .replace(/\s+/g, " ")
      .trim();
    return value.length > 68 ? value.slice(0, 65).replace(/\s+\S*$/, "") + "…" : value;
  }

  // Collapse the card to a slim "done" line. The item is flagged so bucket
  // counts and the progress bar reflect it (see flows.js).
  function markHandled(card, item, onChange) {
    item._handled = true;
    card.classList.add("handled");
    onChange && onChange(item, { type: "acted" });
  }

  // Append a small "↩ Undo" next to the result line (used after Mark read).
  function addUndo(card, bucketKey, item, onChange, options) {
    const el = card.querySelector(".card-result");
    const undo = actBtn("↩ Undo", "undo-link", async () => {
      undo.disabled = true;
      const r = await window.retro.action.markUnread([item.id]);
      if (r && r.ok) {
        item._handled = false;
        const fresh = makeCard(bucketKey, item, onChange, options);
        card.replaceWith(fresh);
        onChange && onChange(item, { type: "undone" });
      } else {
        undo.disabled = false;
        showResult(card, "Couldn't undo: " + ((r && r.message) || "error"), true);
      }
    });
    el.appendChild(undo);
  }

  // onChange(item, {type: "acted"|"undone"}) — keeps progress/win chip honest.
  function makeCard(bucketKey, item, onChange, options) {
    options = options || {};
    const cfg = BUCKETS[bucketKey];
    const topic = cardTopic(item);
    const card = document.createElement("div");
    card.className = "item-card";
    if (item.id) card.dataset.itemId = item.id;
    if (item._handled) card.classList.add("handled");

    const metaVal = cfg.meta ? item[cfg.meta] : "";
    card.innerHTML =
      `<span class="card-topright">` +
      (item.age ? `<span class="card-age">${esc(item.age)}</span>` : "") +
      (item.id ? `<button class="card-read" title="Read full thread here">📖</button>` : "") +
      (item.link ? `<button class="card-link" title="Open in Gmail">🔗</button>` : "") +
      `</span>` +
      `<div class="card-badge">${esc(cfg.badge)}</div>` +
      `<div class="card-subject">${esc(topic)}</div>` +
      (item.from ? `<div class="card-from">${esc(item.from)}</div>` : "") +
      (metaVal ? `<div class="card-meta">${esc(metaVal)}</div>` : "") +
      (item.action ? `<div class="card-do"><em>Do:</em> ${esc(item.action)}</div>` : "") +
      `<div class="card-actions"></div>` +
      `<div class="card-result hidden"></div>`;

    const subjectEl = card.querySelector(".card-subject");
    if (subjectEl && item.subject && item.subject !== topic) subjectEl.title = item.subject;

    const linkBtn = card.querySelector(".card-link");
    if (linkBtn) linkBtn.onclick = () => window.retro.action.openExternal(item.link);

    const readBtn = card.querySelector(".card-read");
    if (readBtn)
      readBtn.onclick = () =>
        window.retro.reader.open({ id: item.id, subject: topic, from: item.from || "", link: item.link || "" });

    const actions = card.querySelector(".card-actions");

    if (REPLYABLE.includes(cfg.type)) {
      actions.appendChild(
        actBtn("✍️ Draft reply", "default", () => showTemplates(card, bucketKey, item, onChange, options))
      );
    }

    if (cfg.type === "unsub") {
      actions.appendChild(
        actBtn("Unsubscribe", null, async () => {
          const ok = await doUnsubscribe(card, item);
          if (ok) markHandled(card, item, onChange);
        })
      );
      actions.appendChild(
        actBtn("Keep it", null, () => {
          showResult(card, "Kept.");
          markHandled(card, item, onChange);
        })
      );
    }

    if (cfg.type === "keep") {
      actions.appendChild(
        actBtn("Archive + label", "default", async () => {
          const r = await window.retro.action.label([item.id]);
          if (r && r.ok) {
            showResult(card, r.mock ? "✓ (demo) filed under Subscriptions" : "✓ Filed under Subscriptions");
            markHandled(card, item, onChange);
          } else {
            showResult(card, "Couldn't file: " + ((r && r.message) || "error"), true);
          }
        })
      );
      actions.appendChild(
        actBtn("Unsubscribe", null, async () => {
          const ok = await doUnsubscribe(card, item);
          if (ok) markHandled(card, item, onChange);
        })
      );
    }

    // ✓ Mark read — everything except cleaned-up (which is already "done").
    if (cfg.type !== "cleaned" && item.id) {
      actions.appendChild(
        actBtn("✓ Mark read", null, async function () {
          this.disabled = true;
          const r = await window.retro.action.markRead([item.id]);
          if (r && r.ok) {
            showResult(card, r.mock ? "✓ (demo) marked read " : "✓ Marked read ");
            markHandled(card, item, onChange);
            addUndo(card, bucketKey, item, onChange, options);
          } else if (r && r.code === "NOT_SUPPORTED") {
            this.disabled = false;
            showResult(card, "Mark-read needs the Apps Script backend.", true);
          } else {
            this.disabled = false;
            showResult(card, "Couldn't mark read: " + ((r && r.message) || "error"), true);
          }
        })
      );
    }

    // Cleaned-up escape hatch: restore a mistaken cleanup into a real pile.
    if (cfg.type === "cleaned" && item.id) {
      actions.appendChild(
        actBtn("↩ Restore…", null, () => showMoveTargets(card, item, onChange))
      );
    }

    if (typeof options.onDefer === "function" && !item._handled) {
      actions.appendChild(actBtn("Do later →", "flashcard-later", () => options.onDefer(item)));
    }

    if (!actions.children.length) actions.remove();

    return card;
  }

  // Returns true on success so callers can mark the card handled.
  async function doUnsubscribe(card, item) {
    if (item.unsubMethod === "oneclick") {
      const r = await window.retro.action.unsubscribe([item]);
      if (r && r.ok) {
        showResult(card, r.mock ? "✓ (demo) unsubscribed" : "✓ Unsubscribed");
        return true;
      }
      showResult(card, "Unsubscribe failed: " + ((r && r.message) || "error"), true);
      return false;
    }
    if (item.unsubTarget) {
      const url = item.unsubMethod === "mailto" ? "mailto:" + item.unsubTarget + "?subject=unsubscribe" : item.unsubTarget;
      await window.retro.action.openExternal(url);
      showResult(card, "Opened opt-out page — confirm it there.");
      return true;
    }
    showResult(card, "No unsubscribe link found.", true);
    return false;
  }

  // Cleaned-up restore: pick a destination pile → item re-renders there and counts.
  function showMoveTargets(card, item, onChange) {
    const actions = card.querySelector(".card-actions");
    actions.innerHTML = "";
    const title = document.createElement("div");
    title.className = "tmpl-title";
    title.textContent = "Restore to…";
    const list = document.createElement("div");
    list.className = "tmpl-list";

    MOVE_TARGETS.forEach((t) => {
      list.appendChild(
        actBtn(t.label, null, () => {
          const fresh = makeCard(t.key, item, onChange);
          card.replaceWith(fresh);
          onChange && onChange(item, { type: "moved", from: "cleanedUp", to: t.key });
        })
      );
    });
    const back = actBtn("← back", null, () => {
      const fresh = makeCard("cleanedUp", item, onChange);
      card.replaceWith(fresh);
    });

    actions.appendChild(title);
    actions.appendChild(list);
    actions.appendChild(back);
  }

  // Step 1: pick a starting point → fills the editor. Step 2: edit → send/draft.
  function showTemplates(card, bucketKey, item, onChange, options) {
    const actions = card.querySelector(".card-actions");
    actions.innerHTML = "";
    const title = document.createElement("div");
    title.className = "tmpl-title";
    title.textContent = "Pick a starting point (you'll edit before sending):";
    const list = document.createElement("div");
    list.className = "tmpl-list";

    const pick = (label, body) => actBtn(label, null, () => showEditor(card, bucketKey, item, body, onChange, options));
    if (item.suggestedReply) list.appendChild(pick("✨ Gemini's suggestion", item.suggestedReply));
    TEMPLATES.forEach((t) => list.appendChild(pick(t.label, t.body)));
    list.appendChild(pick("✏️ Blank", ""));

    const back = actBtn("← back", null, () => {
      const fresh = makeCard(bucketKey, item, onChange, options);
      card.replaceWith(fresh);
    });

    actions.appendChild(title);
    actions.appendChild(list);
    actions.appendChild(back);
  }

  function showEditor(card, bucketKey, item, startingText, onChange, options) {
    const actions = card.querySelector(".card-actions");
    actions.innerHTML = "";

    const title = document.createElement("div");
    title.className = "tmpl-title";
    title.textContent = "Edit your reply, then send or save as draft:";

    const ta = document.createElement("textarea");
    ta.className = "reply-box";
    ta.rows = 5;
    ta.value = startingText || "";

    const row = document.createElement("div");
    row.className = "send-row";

    const finishAction = (r, okMsg) => {
      if (r && r.ok) {
        showResult(card, r.mock ? okMsg.demo : okMsg.live);
        markHandled(card, item, onChange); // draft/send auto-marks read + clears the card
      } else if (r && r.code === "NOT_SUPPORTED") {
        row.querySelectorAll("button").forEach((b) => (b.disabled = false));
        showResult(card, "Sending needs the Apps Script backend (your current backend can't).", true);
      } else {
        row.querySelectorAll("button").forEach((b) => (b.disabled = false));
        showResult(card, "Failed: " + ((r && r.message) || "error"), true);
      }
    };

    const sendBtn = actBtn("📨 Send now", "default", async () => {
      row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const r = await window.retro.action.send({
        id: item.id,
        from: item.from,
        subject: item.subject,
        suggestedReply: ta.value,
      });
      finishAction(r, { demo: "✓ (demo) sent", live: "✓ Sent — it's in the thread in Gmail" });
    });

    const draftBtn = actBtn("💾 Save draft", null, async () => {
      row.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const r = await window.retro.action.draft({
        id: item.id,
        from: item.from,
        subject: item.subject,
        suggestedReply: ta.value,
      });
      finishAction(r, { demo: "✓ (demo) draft saved", live: "✓ Draft saved — review in Gmail" });
    });

    const back = actBtn("← back", null, () => showTemplates(card, bucketKey, item, onChange, options));

    row.appendChild(sendBtn);
    row.appendChild(draftBtn);
    row.appendChild(back);

    actions.appendChild(title);
    actions.appendChild(ta);
    actions.appendChild(row);
    ta.focus();
  }

  window.Triage = { BUCKETS, ORDER, makeCard };
})();
