# Retro Messenger — going live

Retro Messenger is a front-end. Its brain is a **Google Apps Script web app** running in your
own Google account. Until that's connected, the app runs in **Demo mode** with sample data.

**Full step-by-step:** [`backend/apps-script/SETUP-APPSSCRIPT.md`](backend/apps-script/SETUP-APPSSCRIPT.md)
— ~10 min, no coding. You paste one file and deploy.

The checklist below is the short version.

---

## 1. Gemini API key (2 min)
- [ ] https://aistudio.google.com/apikey → **Create API key** → copy the `AIza...` string

## 2. Create + paste the script (3 min)
- [ ] https://script.google.com → **New project**, delete the stub `myFunction`
- [ ] Copy **all** of `backend/apps-script/Code.gs` → paste into the editor
- [ ] Replace `PASTE_YOUR_GEMINI_KEY_HERE` with your key (keep the quotes) → **💾 Save**

> You don't pick a Gemini model. The script asks Google which models your key can use and
> auto-selects the best available Flash model, so retired model names can't break it.

## 3. Authorize it (2 min)
- [ ] Pick **`runTriage`** from the function dropdown → **▶ Run**
- [ ] **Review permissions** → your account → "Google hasn't verified this app" →
      **Advanced → Go to (project) → Allow**
      (It's *your* script reading *your* Gmail.)
- [ ] Execution log shows it finished → Gmail + Gemini both work
- [ ] Gemini erroring? Run **`listAvailableModels`** — the log prints every model your key
      can use and which one the script will pick

## 4. ⚠️ The step everyone gets wrong
- [ ] **Deploy → New deployment** → ⚙ gear next to "Select type" → **Web app**
- [ ] **Execute as: Me**
- [ ] **Who has access: Anyone** ← required. "Only myself" gives the desktop app a **401**,
      because it calls the URL without a Google login. The URL is long and unguessable —
      treat it like a password. The script still only ever touches *your* Gmail.
- [ ] **Deploy** → authorize again if asked → copy the **Web app URL** (ends in `/exec`)

## 5. Connect Retro Messenger (1 min)
- [ ] Retro Messenger → **⚙️ Settings** → paste the `/exec` URL into **Backend URL**
- [ ] **Test connection** → should say "✓ Connected"
- [ ] **Uncheck Demo mode** → **Save**
- [ ] Ask "What's the most important thing in my email? 📬" → real inbox 🎉

## 6. Optional: morning refresh
- [ ] Run `installMorningTrigger` once → refreshes your summary daily at 8am, so
      "Show last summary" is instant

---

## First-run safety
- Test **Unsubscribe** and **Archive + label** on a throwaway newsletter first.
- **Unsubscribe** is outward-facing and hard to undo.
- **Draft reply** only ever creates a Gmail *draft* — it never sends.
- **Archive** is reversible.

## If you edit Code.gs later
**Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy.**
The `/exec` URL stays the same, so you don't touch the app.

## If something's off
| Symptom | Cause |
|---|---|
| App says "isn't hooked up yet" | Backend URL blank/wrong, or Demo mode still on |
| **401** on Test connection | Deployment "Who has access" isn't **Anyone** (step 4) |
| "Connected" but buckets empty | Check the Gemini key; read **Extensions → Executions** for the real error |
| "Show last summary" is blank | Nothing cached yet — run once first, or set up the morning trigger |
| Slow first run | Gmail + Gemini takes ~10–20s; the app waits up to 2 min |
| Gemini **429** | Rate limit. Wait ~1 min, run once more. Don't spam ▶ Run. |

## Uninstalling
Three ways, all the same uninstaller:
- **Start Menu → "Uninstall Retro Messenger"**
- **Settings → Apps → Installed apps → Retro Messenger → Uninstall**
- Run `Uninstall Retro Messenger.exe` in
  `%LOCALAPPDATA%\Programs\Retro Messenger\`

Your settings live in `%APPDATA%\retro-messenger\` and are **left behind** on purpose, so a
reinstall keeps your backend URL. Delete that folder to wipe them.

## Sharing the app with someone else
They need **their own** Apps Script deployment and **their own** Gemini key — walk them
through this same doc. Never hand over your `/exec` URL: it executes as you, against your
Gmail, including archive and unsubscribe.

---

<details>
<summary>Legacy: n8n backend (superseded)</summary>

Earlier versions used an **n8n Cloud** workflow instead. The app still supports it —
`main/n8n-client.js` sniffs the saved URL and routes `script.google.com` / `/exec` URLs to
the Apps Script handler, anything else to n8n's path-per-action webhooks.

Apps Script replaced it: free, no trial clock, no memory limits, fewer moving parts. Note that
some newer actions (`syncNew`, `learnTone`, `thread`) are **Apps Script only** — on an n8n URL
they return `NOT_SUPPORTED`.

To use n8n anyway: import `inbox-summary.json` from the original `inbox-summary` extension
project, create a `latest_summary` Data Table (String columns `generatedAt` and `payload`),
wire one Gmail OAuth2 credential onto every Gmail node, paste the Gemini key into
**Gemini: summarize**, turn **ON** that node's "Output Content as JSON" (off = every bucket
comes back empty), create a `Subscriptions` Gmail label and set its ID in the
**Gmail API: create filter** node, activate the workflow, then paste the base URL
(`https://<workspace>.app.n8n.cloud` — no trailing slash, no `/webhook`) into Settings.

</details>
