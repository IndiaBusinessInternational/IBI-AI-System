# IBI AI System — engine relay setup

The relay is a Cloudflare Worker that sits between the app and every AI vendor.

**What it buys you**

| Without relay (v2) | With relay |
|---|---|
| Browser calls vendors directly — hostnames visible in devtools | Browser only ever talks to your Worker |
| Every device needs 4 vendor keys pasted in | Keys live in Worker secrets; no key in any browser |
| Vendor error text can name the vendor | Errors are rewritten to neutral wording |
| A vendor blocking browser origins breaks that engine | Server-to-server, so CORS stops mattering |

There is no Cloudflare API token on this PC, so these steps are done by hand in the
dashboard — the same way `ibi-auth-worker.js` and the IBI News worker are handled.

---

## 1. Create the Worker

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**
2. Name it `ibi-ai-relay` → **Deploy** (the placeholder code is replaced next)
3. **Edit code** → select everything → paste the whole of `cloudflare-worker.js` → **Deploy**

Its address is `https://ibi-ai-relay.<your-subdomain>.workers.dev`. Note it down.

## 2. Add the secrets

Worker → **Settings** → **Variables and Secrets** → **Add** → type **Secret** for each.
Use *Secret*, not *Text* — plain text variables are readable in the dashboard.

| Name | Value | Needed for |
|---|---|---|
| `ACCESS_CODE` | any long random string you invent | **Required** — the gate on the relay |
| `KEY_ANTHROPIC` | `sk-ant-…` | IBI Apex, IBI Balance |
| `KEY_OPENAI` | `sk-…` | IBI Sage, IBI Swift |
| `KEY_DEEPSEEK` | `sk-…` | IBI Rapid |
| `KEY_GEMINI` | `AIza…` | IBI Vision |

Only `ACCESS_CODE` is mandatory. Add whichever vendor keys you want live — engines
whose key is missing report themselves as not ready instead of failing oddly.

For `ACCESS_CODE`, use something long and random, e.g. from a password manager.
It is the only thing stopping a stranger who finds the URL from spending your credits.

**Deploy after adding secrets.** Cloudflare applies new secrets on the next deploy.

## 3. Check it works

Replace the two placeholders and run this in any terminal:

```bash
curl -s https://ibi-ai-relay.YOUR-SUBDOMAIN.workers.dev/v1/engines -H "x-ibi-access: YOUR-ACCESS-CODE"
```

Expected — note that no vendor or model name appears anywhere in the reply:

```json
{"engines":[{"id":"apex","label":"IBI Apex","tag":"deepest reasoning","ready":true}, ...]}
```

- `{"error":"Access code missing or incorrect."}` → `ACCESS_CODE` doesn't match, or you didn't redeploy after adding it
- `"ready": false` on an engine → that vendor's key secret is missing
- `{"error":"Origin not allowed."}` → only when called from a browser on an unlisted site; curl sends no Origin, so it shouldn't appear here

Then send me the Worker address and I'll switch the app over to it.

---

## Optional: put it on your own domain

`*.workers.dev` works fine. To use `relay.indiabusinessinternational.online` instead:

1. Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**
2. Enter `relay.indiabusinessinternational.online`

Cloudflare creates the DNS record itself. **This one must stay orange-cloud
(proxied)** — the opposite of the `ai.` record, which is grey-cloud because it
points at GitHub Pages. Worker routes only run on proxied hostnames.

---

## Things worth knowing

- **The access code is a shared secret.** It protects your spend from strangers,
  not from a staff member who passes it on. If it leaks, change the secret and
  redeploy — everyone re-enters it once.
- **Cost control still sits with the vendors.** The relay caps request size,
  message count and `max_tokens`, but set spend limits in each vendor's console
  too. That is the only hard ceiling.
- **Free tier is 100,000 requests/day**, which is far beyond this use. Streaming
  replies can run minutes of wall-clock but bill on CPU time, which stays tiny.
- **Logs.** Worker → **Logs** shows the real vendor error behind any neutral
  message the app displays. Nothing sensitive is logged beyond a 500-character
  vendor error excerpt.
- **Allowed callers** are pinned in `ALLOWED_ORIGINS` at the top of the worker.
  Add any new site that should be able to call it.
