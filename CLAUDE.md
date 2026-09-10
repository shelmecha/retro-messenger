# CLAUDE.md

Working notes for Claude Code in this repo. Read [HANDOVER.md](HANDOVER.md) for the project
story and the list of rejected ideas; read [CHANGELOG.md](CHANGELOG.md) for what already exists.

## The one thing that matters most

**Backend changes cost Shelvi a manual redeploy. App changes cost her nothing.**
Say which one it is, explicitly, every time.

- `backend/apps-script/Code.gs` changed → she must paste it into Apps Script, re-add her Gemini
  key, then **Deploy → Manage deployments → ✏️ → New version**. Hand her the file with
  `Get-Content backend\apps-script\Code.gs -Raw | Set-Clipboard` — **never** "open the file and
  copy it." She has repeatedly pasted stale copies from old Notepad windows.
- Verify the deploy took: `<exec-url>?action=version` must return the new `BACKEND_VERSION`.
- Everything else (`main/`, `renderer/`, `preload/`) ships through the normal app update.

## Verify before you ship

**Always run the diagnostic harness** — it has caught every regression so far.

```powershell
$env:RM_DIAG="1"; $env:RM_DIAG_REPORT="$env:TEMP\diag.txt"
npx electron . --user-data-dir="$env:TEMP\rm-scratch"
```

Exits 0 on pass and writes every assertion to the report file. The throwaway `--user-data-dir`
matters: it forces demo mode so the test never touches her real settings or Gemini quota.
`RM_DIAG=1` also isolates the session partition and skips auto-update. Add assertions to
`runDiagnostics()` in `main/main.js` for anything you change.

**Test `Code.gs` offline before asking for a redeploy.** It has no top-level execution, so it
loads into a Node `vm` sandbox with stubbed `GmailApp` / `PropertiesService` / `LockService`.
Two gotchas: `const`/`let` are lexical so `CONFIG` is not a sandbox property — use
`vm.runInContext("CONFIG.X", sandbox)`; and values built inside the vm are cross-realm, so
`deepStrictEqual` fails on prototype identity — compare JSON instead.

## Settled decisions — don't relitigate

- **The board is your unread mail.** `INBOX_QUERY` is `in:inbox is:unread` with **no date
  window** and a 30-item cap that drains as items are marked done. Do not reintroduce
  `newer_than:`. `STARRED_QUERY` keeps `older_than:5d` on purpose — the bucket is labelled
  "Starred · overdue" and would lie without it.
- **A capped or failed scan must never read as "all clear."** Two guards exist and both must be
  preserved: `looksLikeSummary()` / `BAD_RESPONSE` in `main/n8n-client.js` (an Apps Script crash
  returns an HTML page with HTTP 200) and `appendBacklogNotice()` in `Code.gs` (a 30-item cap
  over a larger backlog says how many are still waiting).
- **`n8nBaseUrl` and `main/n8n-client.js` are deliberately stale names.** The backend is Apps
  Script; the n8n path is a legacy fallback. Renaming the settings key needs a migration or
  existing installs lose the saved backend URL. Docs-only cleanup was the chosen fix.
- **Keep the main window simple.** Bigger or decorative ideas get their own window. See
  HANDOVER.md §2 for the explicitly rejected list (streaks, XP, free-text chat, …) — don't
  re-propose them.
- **Labels must match her mental model, not the mechanic.** She rejected "Mark unread" on
  cleaned-up cards because the name didn't describe what she wanted; the fix was renaming the
  action, not relabelling the same behaviour.

## Releasing

1. Bump `version` in `package.json` (and `BACKEND_VERSION` in `Code.gs` if it changed).
2. Add a `CHANGELOG.md` entry — user-facing wording, newest first. Flag a required redeploy.
3. `npm run dist`, then
   `gh release create vX.Y.Z <installer> dist/latest.yml dist/*.blockmap`.
   **Omitting the `.yml` / `.blockmap` silently breaks auto-update.**

The build is unsigned, so SmartScreen warns on install. That's expected.

## Environment

- Work in `C:\Users\Shelvi\Documents\GitHub\retro-messenger` (lowercase). The sibling
  `Retro Messenger` folder is a stray *installed* copy, not source.
- User settings live in `%APPDATA%\Roaming\retro-messenger`, separate from either folder.
- **The repo is intentionally public and contains no secrets.** The Gemini key lives only in her
  personal Apps Script. Keep it that way.
- Never share her `/exec` URL — it executes as her against her Gmail, including archive and
  unsubscribe.

## Style

She is ADHD and asked for short, direct answers: bad news first, no preamble, no re-explaining
what she already knows. Pitch options and let her choose rather than building ahead of her
decision.
