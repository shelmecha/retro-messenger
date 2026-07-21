# Changelog — Retro Messenger

All notable changes, newest first. Version shows in the title bar and Settings.

## v0.7.4
- **One Settings button** — removed the redundant Settings chip from the bottom menu and connection-error actions; use the title-bar gear instead.

## v0.7.3
- **Cleaner forwarded emails** — quoted reply lines now appear as a tidy block with a vertical quote bar instead of repeated `>` characters.

## v0.7.2
- **Clearer email topics** — preview cards show a short description of what each message is actually about, with the original subject available on hover.
- **Visible Settings shortcut** — a compact ⚙ button now sits beside Minimize in the title bar.
- **Faster repeat opens** — likely threads preload in the background and stay cached for ten minutes, including while a fresh inbox scan is running.

## v0.7.1
- **Faster thread opening** — email conversations no longer wait for Gemini before displaying; Gmail content is cleaned locally and shown immediately.
- **Email-style reader** — full-width message rows replace chat bubbles, with older messages collapsed and the newest message expanded by default.
- **Compact reader window** — the email window now matches the main Retro Messenger window at 420 × 600 pixels.

## v0.7.0
- **Focused manual sync** — ↻ adds only new unread mail to the current board and preserves handled and moved-item progress; waking the app no longer replaces the board.
- **Writing-style learning** — ✍↻ learns a compact profile from sent mail and uses it for future suggested replies without storing email samples.
- **Conversation reader redesign** — chronological message cards add name-only senders, avatars, friendly dates, one-sentence summaries, expandable cleaned text, and a distinct style for Shelvi's messages.
- **Email clutter removal** — Gemini removes signatures, contact details, disclaimers, links, tracking text, and repeated quoted history while preserving useful facts.
- **Settings navigation fix** — Save, Close, and Cancel all return to the home menu.

## v0.6.2
- **Resilient to Gemini overload** — the backend now auto-retries with backoff when Gemini is briefly overloaded (HTTP 503/500/429) instead of failing, so demand spikes heal themselves.
- Backend errors now come back as clean JSON, so the app shows the **real reason** ("Gemini is temporarily overloaded — try again") instead of a generic "not a real summary" message.

## v0.6.1
- **Auto-update** — the app now checks GitHub Releases, downloads new versions in the background, and shows a "🔄 Restart & update" button. No more manual reinstalls after this version.

## v0.6.0
- **📖 Read** button on every card opens a second MSN-style window beside the main one showing the **full thread** (plain text — no tracking pixels load), with an editable **reply/draft** box and **Open in Gmail ↗**.
- Backend gains a `thread` action (full message bodies). Requires one Apps Script redeploy.

## v0.5.0
- Progress now **persists** — handled items stay crossed out and counted across "Back to summary", "Show last summary", and app restarts (fixes the bar resetting to 0).
- Progress bar reads as a **countdown ("N to go")** instead of "handled".
- Cleaned-up cards: replaced "Mark unread" with **"🚚 Not junk → move to…"** — rescue a mis-filed email into Urgent / Follow-up / What's new; it then counts and gets normal actions.
- **Refresh on wake** — reopening the window silently pulls a newer summary if one arrived.
- Bucket views show only "← Back to summary"; **"I'm done" lives only on the summary page**.
- Version number shown in the title bar + Settings.

## v0.4.0
- Handled cards collapse to a slim line; bucket counts tick down live; Win98-style session progress bar with a celebration at 100%.
- "✓ Mark read" gained an "↩ Undo"; cleaned-up cards got reply/mark-unread escape hatches.

## v0.3.2
- App no longer shows a fake "inbox is clear" when the backend actually crashed (HTML error pages are now caught → honest error + redeploy hint).

## v0.3.1
- Fixed a crash in the window-shake animation when the window closed mid-shake.

## v0.3.0
- 🔗 Open-in-Gmail on every card; editable reply → real Send or Save draft; auto mark-read on any action; end-of-session "clean sweep" to mark the whole inbox read.

## v0.2.0
- Switched backend from n8n to Google Apps Script (free, no memory limits); app auto-detects which backend the URL points to.

## v0.1.0
- First build: MSN/Win-98 messenger window, menu-driven bot, email triage into buckets, demo mode, Windows installer, auto-launch at login.
