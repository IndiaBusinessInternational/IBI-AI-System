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
ollama pull qwen3:4b-instruct
```

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

## Why this exact model

The default `qwen3:4b` is a *thinking* model, and its thinking cannot be turned
off — the API's reasoning-effort switch only stops the runtime **parsing** the
thought block, which dumps raw deliberation and a stray `</think>` tag into the
visible answer, and the model's own `/no_think` instruction is ignored. Asked
to reply with a single sentence, it produced **2,000 tokens over four minutes**
and then answered correctly.

`qwen3:4b-instruct` is the same model family without the thinking stage. Same
prompt, **five seconds**. That is the only reason for the `-instruct` suffix in
the engine roster, and it should not be dropped.

---

## Speed, honestly

On the Quadro P2000 (4 GB) in this PC: **~13 tokens/second**, with about 69% of
the model on the GPU and the rest on the CPU — the card is a little too small to
hold all of it. A short listing or reply lands in a few seconds; a long document
takes a minute or so.

Two things were tried and made it *worse*, so don't reach for them: flash
attention with a quantised KV cache dropped it to 10 tokens/second, because the
P2000's generation lacks the hardware that makes those pay off.

## What it is good at, and what it isn't

Good: drafting listing copy, rewriting and shortening, summarising, classifying,
translating, routine questions — the bulk of everyday use, at no cost and in
complete privacy.

Not good: hard reasoning, long documents, careful figure work. A 4-billion
parameter model is not in the same class as IBI Apex, and no amount of
configuration closes that gap. Keep the hosted engines for that work.

**It cannot do images.** IBI Vision remains the engine for those.

---

## Where this stops being "no outside API"

The model itself is open-weights, trained by someone else and downloaded once.
Genuinely training a model from scratch is a different order of undertaking —
large GPU clusters and budgets to match — and is not on the table. What this
setup does give you is independence at *run time*: no key, no vendor, no
metering, no request leaving the building.

Related: `CLOUDFLARE-WORKER-SETUP.md` covers the opposite problem — hiding the
vendors behind a relay for the engines that do call out.
