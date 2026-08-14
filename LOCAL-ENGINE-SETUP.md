# IBI Local — the on-device engine

**IBI Local** is the one engine that uses no outside AI service. The model runs
on the PC in front of you: no key, no per-message cost, and nothing typed into
it leaves the machine. It is the answer to "can we have an AI system without
depending on anyone else's API" — with the honest limits set out at the bottom.

Every other engine still calls its vendor as before. This one is additive.

---

## What it costs to run

| | |
|---|---|
| Per message | nothing |
| Disk | ~2.5 GB for the model, plus ~4 GB for the runtime |
| Works offline | yes, completely |
| Works on other PCs | only after the same setup is done there |

---

## Setting it up on a PC

**1. Install the runtime**

```bash
winget install --id Ollama.Ollama -e
```

**2. Point it at the D: drive and allow the AI System to call it**

Run in PowerShell, then sign out and back in:

```bash
[Environment]::SetEnvironmentVariable('OLLAMA_MODELS','D:\OllamaModels','User')
```

The second setting is the one people miss. The browser refuses to let a web
page talk to a local service unless that service names the page as allowed —
without it every request comes back **403** and the engine looks broken:

```bash
[Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS','https://ai.indiabusinessinternational.online,http://localhost,http://localhost:*,http://127.0.0.1,http://127.0.0.1:*','User')
```

Keep this an allowlist. Setting it to `*` would let **any** website you happen
to visit drive the model on this PC.

**3. Download the model**

```bash
ollama pull qwen3.5:4b
```

One model, not two — it reads images as well as text. See *Why this exact
model* below for why that matters more than its token rate.

**4. Start it at login**

`local-engine\run-local-engine.bat` applies both settings and starts the
runtime. To have it start automatically, put a shortcut to
`IBI-LocalEngine.vbs` in the Startup folder (`Win+R` → `shell:startup`).

> The runtime's own tray app is **not** reliable here — on this build it reports
> "starting ollama server" and then never binds the port. The batch file starts
> the server directly, which does work. If both are set to run at login, the
> batch file checks whether the port is already taken and exits quietly rather
> than fighting over it.

**5. Check it**

Open the AI System, pick **IBI Local**, and send anything. Or, behind the CEO
gate, open Settings — the *On-device runtime* row shows a live indicator and
says in plain words whether it is running and whether the model is present.

---

## Using it from a phone

By default IBI Local only works on the PC running the runtime, because it calls
`localhost` — and on a phone, `localhost` is the phone. There is no model there,
so the engine reports itself as not running, which from the phone's point of
view is true.

To reach the laptop from a phone, three things are in place:

```
phone --https--> Cloudflare --tunnel--> gateway :11435 --> runtime :11434
```

1. **`local-engine/local-gateway.js`** listens on `127.0.0.1:11435`. It requires
   an access code, forwards **only** chat and model-listing, and rewrites the
   `Host` header.
2. **A Cloudflare tunnel hostname**, `ai-local.indiabusinessinternational.online`,
   pointing at the gateway. It shares the existing `ibi-socialflow` tunnel — one
   tunnel, several hostnames, listed in `~/.cloudflared/config.yml`.
3. **The phone's Settings**, holding that address plus the access code.

### On the phone

Open the AI System, triple-tap the version badge, enter the CEO PIN, then in
Settings under *On-device runtime* set:

| Field | Value |
|---|---|
| address | `https://ai-local.indiabusinessinternational.online` |
| access code | the contents of `local-engine/access-code.txt` |

Save, pick **IBI Local**, and send something. The laptop must be awake.

### Three things that are load-bearing

**The runtime is never the thing exposed.** It has no authentication of any
kind — no key, no token — and `/api/delete` and `/api/pull` sit on the same port
as chat. Publishing it directly would let anyone who found the hostname wipe or
replace your models. The gateway refuses those routes *even with a valid code*,
so the worst a leaked code buys is chat.

**The Host rewrite is not optional.** The runtime rejects any request whose
`Host` isn't loopback, with a bare **403**, an empty body, and no log line. Point
a tunnel straight at `:11434` and every request fails in a way that looks
exactly like the machine being offline. The gateway rewriting `Host` to
`localhost:11434` is what makes the tunnel work at all.

**Rotating the code** is editing `access-code.txt`, restarting the gateway, and
re-entering it on each phone. Do that if it ever leaks — it is the only thing
between the internet and the runtime.

### The honest limitation

**This is a laptop.** On battery it sleeps after ten minutes, and a sleeping
laptop serves nothing — the phone will report that it cannot reach your machine,
correctly. So mobile IBI Local works when the laptop is awake, which in practice
means plugged in at your desk. If you are out and the laptop is shut, use one of
the hosted engines; they are unaffected.

---

## Why this exact model

`qwen3.5:4b` is chosen for one property that outranks its speed: **it reads
images as well as text**, so the whole estate runs on a single model.

That matters because the card holds 4 GB, which is exactly one model. A
separate vision model is not *also* loaded — it evicts the text one. Measured
here, every swap between two models cost **7–12 seconds**, and a photographed
question triggers one in each direction. One model that does both removes that
stall completely, and on the labels tested it transcribed *better* than the
`gemma3:4b` it replaces, catching small print that gemma summarised past.

### The thinking trap — read this before changing any model

This model deliberates before answering, and left alone it spends the entire
token budget doing so: `content` comes back **empty**, `finish_reason` is
`length`, and the calling app displays nothing at all. It looks exactly like a
broken engine.

**The knob differs by endpoint, and the wrong one fails silently.** Measured on
this PC, through `/v1/chat/completions`:

| sent | content | reasoning |
|---|---|---|
| nothing | 0 chars | 611 |
| `think: false` | 0 chars | 756 |
| `chat_template_kwargs: {enable_thinking:false}` | 0 chars | 729 |
| `reasoning_effort: "low"` | 0 chars | 664 |
| **`reasoning_effort: "none"`** | **316 chars** | **0** |

So: **`reasoning_effort:"none"` on `/v1/chat/completions`, `think:false` on the
native `/api/chat`.** Each is ignored by the other endpoint without any error.
The gateway applies the `/v1` one for everything that passes through it, so
apps get working output for free — but a page talking to `:11434` **directly**
(which the AI System does when you are sitting at this PC) bypasses the gateway
and must send it itself.

The older note here said thinking could not be turned off at all. That was true
of `qwen3:4b` and is no longer true — but only via the exact knob above.

---

## Speed, honestly

On the Quadro P2000 (4 GB) in this PC, measured:

| | |
|---|---|
| Generation | **~9 tokens/second** |
| On the GPU | about half; the rest runs on the CPU |
| Cold load | **12.8 s** |
| Warm reply | **0.8 s** |
| Context | 8192 tokens |

It is **slower than the `qwen3:4b-instruct` it replaces** (~15 tok/s), because
at 3.4 GB less of it fits on the card. That is a deliberate trade: the lost
speed is a few seconds per reply, while the model-swapping it eliminates cost
7–12 seconds *per switch*, and there is no longer a second model to switch to.

`OLLAMA_KEEP_ALIVE=-1` is what keeps the 0.8 s figure honest. Without it the
runtime unloads after five idle minutes and the next request pays the full
12.8 s — which reads as "the AI is broken" rather than "it is waking up".

Two things were tried and made it *worse*, so don't reach for them: flash
attention with a quantised KV cache dropped throughput, because the P2000's
generation lacks the hardware that makes those pay off.

## What it is good at, and what it isn't

Good: drafting listing copy, rewriting and shortening, summarising, classifying,
translating, reading text out of a photograph, routine questions — the bulk of
everyday use, at no cost and in complete privacy.

Not good: hard reasoning, long documents, careful figure work. A 4-billion
parameter model is not in the same class as IBI Apex, and no amount of
configuration closes that gap. Keep the hosted engines for that work — and
never move tax or accounting figures onto it.

---

## Where this stops being "no outside API"

The model itself is open-weights, trained by someone else and downloaded once.
Genuinely training a model from scratch is a different order of undertaking —
large GPU clusters and budgets to match — and is not on the table. What this
setup does give you is independence at *run time*: no key, no vendor, no
metering, no request leaving the building.

Related: `CLOUDFLARE-WORKER-SETUP.md` covers the opposite problem — hiding the
vendors behind a relay for the engines that do call out.
