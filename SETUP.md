# Retro Messenger — going live (n8n backend setup)

Retro Messenger is a front-end. Its brain is your **n8n Cloud** workflow (the same one the
`inbox-summary` Chrome extension uses). Until that's live, the app runs in **Demo mode** with
sample data. This checklist stands up the backend and connects the app. ~20–30 min, mostly
clicking. No coding.

The workflow itself is already built — you **import** it, you don't create it.

> Workflow file to import:
> `C:\Users\Shelvi\OneDrive - De La Salle University-Dasmariñas\Desktop\Claude Code\inbox-summary\workflow\inbox-summary.json`

---

## 1. Accounts + keys (5 min)
- [ ] **n8n Cloud** account — https://n8n.io (free trial is fine). Note your URL:
      `https://<workspace>.app.n8n.cloud`
- [ ] **Gemini API key** (free) — https://aistudio.google.com/apikey → copy the `AIza...` key

## 2. Import the workflow (2 min)
- [ ] n8n → **Workflows → Add workflow → ⋯ (top-right) → Import from File**
- [ ] Choose `inbox-summary.json` (path above)

## 3. Create the Data Table (3 min)
This is what lets "Show last summary" work without re-scanning.
- [ ] n8n → **Data Tables → Create Data Table**, name it `latest_summary`
- [ ] Add two **String** columns: `generatedAt` and `payload`
- [ ] In the workflow, open **Data Table: save latest** AND **Data Table: read latest** →
      select `latest_summary` in each

## 4. Connect credentials (5 min)
- [ ] **Gmail:** open the **Gmail: last 24h** node → Credentials → *Create new* → **Gmail OAuth2**
      → *Sign in with Google* → allow. (If "app not verified" → Advanced → Go to n8n.)
- [ ] Set that **same** Gmail credential on every other Gmail node: *starred overdue*,
      *add Subscriptions label*, *archive*, *create draft*, *re-add INBOX*, and the
      **Gmail API: create filter** HTTP node.
- [ ] **Gemini:** open **Gemini: summarize** → Credentials → *Create new* →
      **Google Gemini(PaLM) API** → paste your `AIza...` key.

## 5. ⚠️ The one step everyone misses
- [ ] In the **Gemini: summarize** node, turn **ON** "Output Content as JSON".
      If this is off, **every bucket comes back empty** and the app shows nothing.

## 6. Subscriptions label (for unsubscribe/archive actions) (3 min)
- [ ] In Gmail: create a label named **Subscriptions**
- [ ] Workflow → **Gmail: add Subscriptions label** node → pick `Subscriptions` from the dropdown
- [ ] Workflow → **Gmail API: create filter** node → replace `REPLACE_WITH_SUBSCRIPTIONS_LABEL_ID`
      with the Subscriptions label's ID (run **Gmail → Get Labels** once to find it, or read it
      from the label's URL in Gmail)

## 7. Test, then activate (3 min)
- [ ] Click **Execute Workflow** → open the **Normalize** node's output → confirm buckets have
      items (empty everywhere = the JSON toggle in step 5 is off)
- [ ] Toggle the workflow **Active** (top-right). This turns on the webhooks.

## 8. Connect Retro Messenger (2 min)
- [ ] Open any **Webhook** node, copy the **Production URL** — it looks like
      `https://<workspace>.app.n8n.cloud/webhook/inbox-summary/run`
- [ ] Your **base URL** is only the part before `/webhook/…`:
      `https://<workspace>.app.n8n.cloud`  ← no trailing slash, no `/webhook`
- [ ] In Retro Messenger → **⚙️ Settings** → paste the base URL → **Test connection**
      (should say "✓ Connected") → **uncheck Demo mode** → **Save**
- [ ] Ask "What's the most important thing in my email? 📬" → it now reads your real inbox

---

## First-run safety
- Test **Unsubscribe** and **Archive + label** on a throwaway newsletter first.
- Unsubscribe is outward-facing and hard to undo. Draft reply only ever creates a Gmail *draft* —
  it never sends. Archive is reversible.

## If something's off
- **App says "isn't hooked up yet"** → base URL is blank/wrong, or Demo mode is still on.
- **"Connected" but buckets empty** → Gemini "Output as JSON" toggle (step 5).
- **Test connection fails** → workflow isn't **Active**, or the URL has a trailing slash / `/webhook`.
- **403 on an action** → re-create the Gmail OAuth2 credential (needs modify scope) and re-authorize.
- **Gemini 429** → free-tier momentarily saturated; wait and retry, or switch model to
  `gemini-1.5-flash` in the Gemini node.
