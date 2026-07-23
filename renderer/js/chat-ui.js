"use strict";

// Low-level chat DOM primitives. Namespace: window.ChatUI
(function () {
  const listEl = () => document.getElementById("messageList");
  const trayEl = () => document.getElementById("chipTray");

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function scrollToEnd() {
    const l = listEl();
    l.scrollTop = l.scrollHeight;
  }

  function addUserMsg(text) {
    const row = document.createElement("div");
    row.className = "msg-row user";
    row.innerHTML = `<div class="bubble">${esc(text)}</div>`;
    listEl().appendChild(row);
    scrollToEnd();
    return row;
  }

  function addBotMsg(text, opts) {
    opts = opts || {};
    const row = document.createElement("div");
    row.className = "msg-row bot";
    const sender = opts.sender === false ? "" : `<div class="msg-sender">InboxBot 🤖</div>`;
    // allowHtml is only ever used with app-built strings, never remote data.
    const body = opts.allowHtml ? text : esc(text);
    row.innerHTML = `${sender}<div class="bubble">${body}</div>`;
    listEl().appendChild(row);
    scrollToEnd();
    return row;
  }

  // chips: [{ label, onClick, cls }]
  function setChips(chips) {
    const tray = trayEl();
    tray.innerHTML = "";
    (chips || []).forEach((c) => {
      const b = document.createElement("button");
      b.textContent = c.label;
      if (c.cls) b.classList.add(c.cls);
      b.onclick = () => {
        // Echo the choice as a user message unless told not to.
        if (c.echo !== false) addUserMsg(c.echo || c.label);
        clearChips();
        c.onClick && c.onClick();
      };
      tray.appendChild(b);
    });
  }

  function clearChips() {
    trayEl().innerHTML = "";
  }

  let typingRow = null;
  function showTyping() {
    hideTyping();
    typingRow = document.createElement("div");
    typingRow.className = "msg-row bot";
    typingRow.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
    listEl().appendChild(typingRow);
    scrollToEnd();
  }
  function hideTyping() {
    if (typingRow && typingRow.parentNode) typingRow.parentNode.removeChild(typingRow);
    typingRow = null;
  }

  // Add an arbitrary element (e.g. an item card) into the transcript.
  function addElement(elm) {
    const row = document.createElement("div");
    row.className = "msg-row bot";
    if (elm && elm.classList && elm.classList.contains("flashcard-deck")) row.classList.add("flashcard-row");
    row.appendChild(elm);
    listEl().appendChild(row);
    scrollToEnd();
    return row;
  }

  function setStatusDot(mode) {
    const dot = document.getElementById("statusDot");
    dot.classList.remove("live", "error");
    if (mode === "live") dot.classList.add("live");
    else if (mode === "error") dot.classList.add("error");
    dot.title =
      mode === "live" ? "Connected to n8n" : mode === "error" ? "Last request failed" : "Demo mode";
  }

  function setBuddyStatus(text) {
    document.getElementById("buddyStatus").textContent = text;
  }

  function setWinChip(count) {
    const chip = document.getElementById("winChip");
    if (count > 0) {
      chip.textContent = `✓ ${count} handled today`;
      chip.classList.remove("hidden");
    } else {
      chip.classList.add("hidden");
    }
  }

  // Session progress bar: hidden when total is 0.
  function setProgress(done, total) {
    const row = document.getElementById("progressRow");
    if (!row) return;
    if (!total) {
      row.classList.add("hidden");
      return;
    }
    row.classList.remove("hidden");
    const left = Math.max(0, total - done);
    document.getElementById("progressLabel").textContent = left === 0 ? "all clear 🎉" : `${left} to go`;
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    document.getElementById("progressFill").style.width = pct + "%";
  }

  window.ChatUI = {
    esc,
    addUserMsg,
    addBotMsg,
    setChips,
    clearChips,
    showTyping,
    hideTyping,
    addElement,
    setStatusDot,
    setBuddyStatus,
    setWinChip,
    setProgress,
    scrollToEnd,
  };
})();
