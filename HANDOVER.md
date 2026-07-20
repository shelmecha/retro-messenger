# Retro Messenger — Project Handover

**What it is:** an MSN/Windows-98–styled Electron desktop app that pops up as a retro chat buddy and helps Shelvi triage her Gmail inbox. Menu-driven (tap chips, no free-typing to an AI). All email/AI work happens in a Google Apps Script backend she owns; the app is a thin client with no secrets in it.

- **Code:** `C:\dev\retro-messenger` (local), mirrored at `github.com/shelmecha/retro-messenger` (public repo)
- **Current version:** v0.6.1
- **Stack:** Electron (plain HTML/CSS/JS, no bundler/framework) + [98.css](https://jdan.github.io/98.css/) for the retro chrome. Backend: Google Apps Script (`backend/apps-script/Code.gs`) calling the Gmail API + Gemini.
- **Distribution:** GitHub Releases + `electron-updater` — the app auto-updates itself after this version.

---

## 1. Current features (as of v0.6.1)

### Core loop
- Auto-launches at login, lives in the system tray, MSN-style chat window
- Menu-driven bot ("What's the most important thing in my email? 📬" / "Show last summary" / "⚙️ Settings") — no free-text prompt
- Pulls Gmail (last 24h inbox + starred-overdue), asks Gemini to triage into 7 buckets: 🔴 Important/Urgent, ⭐ Starred overdue, ✉️ Needs follow-up, 🗑️ Can unsubscribe, 📌 Worth keeping, 🆕 What's new, 🧹 Cleaned up
- Session progress bar ("N to go" countdown, fills as items are handled, "all clear 🎉" at zero) — **persists** across Back-to-summary/refresh/app-restart via localStorage
- Handled cards collapse to a slim strikethrough line; bucket counts tick down live

### Per-email actions
- **✍️ Draft reply** — pick a starting point (Gemini's suggestion or a canned template) → **editable textarea** → **📨 Send now** (real threaded Gmail reply, never sends unseen text) or **💾 Save draft**
- **✓ Mark read** (with **↩ Undo**), **🗑️ Unsubscribe** (one-click RFC 8058 where possible, else opens the opt-out page), **Archive + label** (Worth-keeping bucket, adds a "Subscriptions" Gmail label)
- **🚚 Not junk → move to…** on Cleaned-up cards — rescues a mis-filed email into Urgent/Follow-up/What's-new in-app
- **🔗 Open in Gmail** and **📖 Read** (opens a **second MSN-style window** beside the main one showing the full thread in plain text — no tracking pixels — with its own reply/draft box and "Open in Gmail ↗")
- **🧹 Clean sweep** at session end — offers to mark the whole inbox read if unread remain

### Infrastructure
- **Backend:** Google Apps Script, deployed as a personal web app; auto-detects the best available Gemini model (Google renames/retires models often — this avoids hardcoding one that gets shut down); defensive JSON parsing (thinking models can truncate output)
- **Demo/mock mode:** bundled sample inbox so the app is fully testable without a live backend
- **Auto-update:** checks GitHub Releases on launch + every 6h, downloads silently, shows "🔄 Restart & update"
- **Security:** contextIsolation on, sandboxed renderer, CSP, no Node integration in renderer; only the backend URL is stored client-side (no API keys in the app)
- **Version visible** in title bar + Settings; `CHANGELOG.md` kept up to date every release
- **Diagnostic harness:** `RM_DIAG=1` env var runs a full scripted walkthrough (greet → triage → cards → reply → mark-read/undo → move → clean sweep → reader window) and logs `[DIAG]` assertions — used to verify every change before shipping

---

## 2. Planned next features (not yet built)

### Agreed & scoped (ready to build)
- **Buddy-list window** — a second MSN-style "contact list" window: Gmail shown as an online buddy, future integrations (Calendar, Slack, HubSpot) listed as offline buddies you can add. This is where the progress/score display may eventually live (kept OUT of the main chat window per Shelvi's "keep it simple" direction).
- **Protected keywords** — a settings field where Shelvi types words; any email containing them is never bucketed as unsubscribe/cleanup and never swept. Small addition to the Gemini prompt + settings UI.
- **HubSpot sync** — her work emails already log to HubSpot; she wants "mark read/handled" in the app to reflect there too. Needs a HubSpot private-app token; good candidate as its own "buddy."
- **Calendar buddy** — "what's my day look like?" pulled via the same Apps Script (no new OAuth needed, same Google account).

### Explicitly rejected — do not re-propose
- **Daily streaks** — "this is a job, we show up every day, streaks don't fit"
- **"Just 3 things" bounded quest** — redundant with the existing Urgent bucket
- **Rank titles / XP / levels** — "too detailed right now, focus on main features before decoration"
- Free-text chat with the bot, Superhuman-style split inboxes, auto-send without review, fake/buggy snooze — all rejected early as scope creep against the "keep it simple" vision

### Vision statement (repeat this back before proposing anything new)
> "Gamify work, but keep everything simple." The main messenger window should stay minimal with few features that work well. Bigger/decorative ideas get their own window (buddy list) rather than bloating the chat.

---

## 3. Recommendations for whoever picks this up

1. **Read `CHANGELOG.md` and the memory file before touching anything.** This project has been built through many small conversational iterations; the changelog is the fastest way to understand what exists and why.
2. **Always run the `RM_DIAG=1` diagnostic after any renderer/main change**, using a throwaway `--user-data-dir` so it exercises demo mode, not Shelvi's real settings. It has caught every regression so far — don't skip it.
3. **Backend changes require a manual redeploy she has to do herself** (paste Code.gs → re-add her Gemini key → Deploy → Manage deployments → New version). This has been the single biggest friction point in the whole project — she has repeatedly pasted stale copies from old Notepad windows. **Always hand her the file via clipboard (`Set-Clipboard`), never "open the file and copy it."** App-only changes need no redeploy — say so explicitly every time, it matters to her.
4. **Ask before assuming scope.** She corrects overreach fast and clearly (see rejected list above) — pitch options, let her choose, don't build ahead of her decisions.
5. **She is ADHD and explicitly asked for short, direct answers** — no repeating prior explanations, no long preambles. Match that.
6. **Never let a backend crash look like success.** A past bug: Apps Script crashes return HTTP 200 with an HTML error page, which briefly got misread as "inbox is clear." There's now a `looksLikeSummary()`/`BAD_RESPONSE` guard in `main/n8n-client.js` — preserve this pattern for any new response type.
7. **Version every release** — bump `package.json`, add a `CHANGELOG.md` entry, and to actually ship it: `npm run dist` then `gh release create vX.Y.Z <installer> dist/latest.yml dist/*.blockmap`. Forgetting the `.yml`/`.blockmap` assets silently breaks auto-update.
8. **The repo is intentionally public** — there are no secrets in this codebase (Gemini key lives only in her personal Apps Script). Keep it that way; never commit a real API key.
9. When in doubt about a UX call, her stated taste is: **retro/MSN charm is welcome, but functional confusion is not** — e.g. she rejected a "Mark unread" button on cleaned-up emails because the label didn't describe what she actually wanted (rebucketing), and the fix was renaming the action to match her mental model, not just relabeling.
