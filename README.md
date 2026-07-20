# Retro Messenger 🖥️💬

An MSN/Windows-98 styled desktop buddy that pops up when you start your PC and helps you tackle your inbox. Built with Electron + [98.css](https://jdan.github.io/98.css/).

A menu-driven chat (tap chips, not free-type) that pulls a triaged summary of your Gmail — Urgent / Follow-up / Starred-overdue / Unsubscribe / Worth-keeping / What's new / Cleaned up — and lets you reply, unsubscribe, archive, mark read, and read full threads, one item at a time.

## How it works

The app is a **front-end only**. Email access happens in **your own Google Apps Script** web app (Gmail + Gemini) — the desktop app just calls that `/exec` URL over HTTP from its main process (so no CORS, sandboxed renderer). **No API keys live in this code** — your Gemini key stays in your Apps Script. Setup: [`backend/apps-script/SETUP-APPSSCRIPT.md`](backend/apps-script/SETUP-APPSSCRIPT.md).

A bundled **Demo mode** (on by default) serves `mock/sample-triage.json` so the whole experience works before your backend is live.

## Features
- Email triage into actionable buckets, with a session progress bar
- Editable reply → real send or save-as-draft (threaded correctly)
- 📖 second "reader" window shows a full thread in plain text (no tracking pixels)
- Per-item mark-read with undo, "not junk → move to…" rescue, end-of-session clean sweep
- Auto-launch at login, system-tray resident, **auto-updates from GitHub Releases**

## Run it

```powershell
cd C:\dev\retro-messenger
npm install
npm start            # run the app
npm run dist         # build a Windows installer into dist/
npm run release      # build + publish a GitHub release (needs GH_TOKEN / gh auth)
```

`npm run start:hidden` simulates an auto-launch-at-login start (tray only).

## Structure

```
main/       Electron main — window, tray, auto-launch, settings, backend HTTP client, IPC, auto-update
preload/    contextBridge — minimal window.retro API
renderer/   chat UI + reader window (plain HTML/CSS/JS, 98.css)
backend/    Google Apps Script backend + setup guide
mock/       sample-triage.json for Demo mode
assets/     icons + blips
```

See [CHANGELOG.md](CHANGELOG.md) for version history.
