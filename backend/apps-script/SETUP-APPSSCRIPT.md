# Retro Messenger — Apps Script backend setup

This replaces n8n. It runs free inside your own Google account, on Google's servers
(no memory limits, no trial clock). ~10 min, no coding — you paste one file and deploy.

---

## 1. Get a Gemini API key (free)
- Go to https://aistudio.google.com/apikey → **Create API key** → copy the `AIza...` string.

## 2. Create the script
1. Go to https://script.google.com → **New project**.
2. Delete the empty `function myFunction() {}` in the editor.
3. Open `backend/apps-script/Code.gs` from the Retro Messenger project, copy
   **everything**, and paste it into the Apps Script editor. There is no
   `script.go.js` file—the `.gs` extension is Google Apps Script's JavaScript format.
4. Near the top, replace `PASTE_YOUR_GEMINI_KEY_HERE` with your `AIza...` key. Keep the quotes.
5. (Optional) change `TIME ZONE` / query windows in `CONFIG` if you like the defaults are fine.
6. Click **💾 Save** (top).

> **Which Gemini model?** You don't pick one. The script asks Google which models
> your key can use and auto-selects the best available Flash model. (Google retires
> model names often — this avoids "model not found" breakage.)

## 3. Authorize it (first run)
1. In the toolbar, pick the function **`runTriage`** from the dropdown → click **▶ Run**.
2. Google will ask for permission → **Review permissions** → pick your account →
   "Google hasn't verified this app" → **Advanced → Go to (your project) → Allow**.
   (This is *your own* script reading *your own* Gmail — safe.)
3. It runs (~10–20s). Check **Execution log** shows it finished. That proves Gmail + Gemini work.
   - **If Gemini errors:** run the **`listAvailableModels`** function (same dropdown) — the log
     prints every model your key can use, and which one the script will pick.
   - **429 error:** just a rate limit — wait ~1 minute and run once more (don't spam ▶ Run).

## 4. Deploy as a web app
1. Top-right **Deploy → New deployment**.
2. Click the ⚙ gear next to "Select type" → **Web app**.
3. Set:
   - **Description:** Retro Messenger
   - **Execute as:** **Me**
   - **Who has access:** **Anyone** — required; "Only myself" makes the desktop app get a 401,
     because the app calls the URL without a Google login. The URL is a long unguessable
     string — treat it like a password and the script still only touches YOUR Gmail.
4. **Deploy** → authorize again if asked → **copy the Web app URL** (ends in `/exec`).

## 5. Connect the app
1. Open Retro Messenger → **⚙️ Settings**.
2. Paste the `/exec` URL into **Backend URL**.
3. **Uncheck Demo mode** → **Test connection** (should say ✓ Connected) → **Save**.
4. Ask **"What's the most important thing in my email? 📬"** → real inbox. 🎉

---

## Optional: automatic morning refresh
Run the `installMorningTrigger` function once (same dropdown + ▶ Run) to have it refresh
your summary every day at 8am, so "Show last summary" is instant.

## If you change Code.gs later
Edit → Save → **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy**.
The `/exec` URL stays the same, so you don't need to touch the app.

## Troubleshooting
- **Test connection fails** → the deployment "Who has access" must allow you; re-deploy.
- **Buckets empty / error** → check the Gemini key, and the **Execution log** in the editor
  (Extensions → Executions) for the real error.
- **"Show last summary" is blank** → run once first (the app's "most important" button), or set
  up the morning trigger.
- **Slow first run** → Gmail + Gemini takes ~10–20s; the app waits up to 2 min.
