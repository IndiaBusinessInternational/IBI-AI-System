/* =====================================================================
   IBI Artificial Intelligence System — engine relay
   Cloudflare Worker · India Business International
   ---------------------------------------------------------------------
   Sits between the browser and every AI vendor.

   Why it exists:
     1. Concealment. The browser only ever talks to this Worker. Vendor
        hostnames, model IDs and even vendor error text never reach the
        client, so devtools shows nothing but this origin.
     2. One key, not many. Credentials live in Worker secrets, so staff
        never paste keys and no key sits in anyone's localStorage.
     3. CORS. Vendors that refuse browser-origin requests stop mattering,
        because the call is now server-to-server.

   Deploy: see CLOUDFLARE-WORKER-SETUP.md
   ===================================================================== */

/* ---- who may call this relay ---- */
const ALLOWED_ORIGINS = [
  'https://ai.indiabusinessinternational.online',
  'https://indiabusinessinternational.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

/* ---- limits (abuse guards) ---- */
const MAX_BODY_BYTES = 400_000;   // ~400KB of conversation
const MAX_MESSAGES   = 60;
const MAX_TOKENS_CAP = 32_000;
const UPSTREAM_TIMEOUT_MS = 120_000;

/* ---- engine roster (server-side only) ----------------------------------
   The browser receives `id`, `label` and `tag`. It never sees `vendor`
   or `model`, so the client cannot reveal which vendor served a reply.
   `secret` names the Worker secret holding that vendor's credential.
   ---------------------------------------------------------------------- */
const ENGINES = {
  apex:    {label:'IBI Apex',    tag:'deepest reasoning',  vendor:'anthropic', model:'claude-opus-5',     secret:'KEY_ANTHROPIC', think:true},
  balance: {label:'IBI Balance', tag:'everyday work',      vendor:'anthropic', model:'claude-sonnet-5',   secret:'KEY_ANTHROPIC', think:true},
  sage:    {label:'IBI Sage',    tag:'alternate opinion',  vendor:'openai',    model:'gpt-5.6-sol',       secret:'KEY_OPENAI'},
  swift:   {label:'IBI Swift',   tag:'fast & very cheap',  vendor:'openai',    model:'gpt-5.6-luna',      secret:'KEY_OPENAI'},
  rapid:   {label:'IBI Rapid',   tag:'lowest cost',        vendor:'deepseek',  model:'deepseek-v4-flash', secret:'KEY_DEEPSEEK'},
  vision:  {label:'IBI Vision',  tag:'images & long docs', vendor:'gemini',    model:'gemini-3.6-flash',  secret:'KEY_GEMINI'}
};

/* ---- vendor adapters --------------------------------------------------
   request()  -> {url, headers, body}
   parse(ev, sink) -> push deltas into the neutral sink
   ---------------------------------------------------------------------- */
const VENDORS = {

  anthropic: {
    request: ({model, key, system, messages, maxTokens, think}) => {
      const body = {
        model, max_tokens: maxTokens, stream: true, system,
        messages: messages.map(m => ({role: m.role, content: m.content}))
      };
      if (think) body.thinking = {type: 'adaptive', display: 'summarized'};
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
        body
      };
    },
    parse: (ev, sink) => {
      if (ev.type === 'content_block_delta') {
        const d = ev.delta;
        if (d.type === 'text_delta')     sink.text(d.text);
        if (d.type === 'thinking_delta') sink.think(d.thinking);
      } else if (ev.type === 'message_delta') {
        if (ev.delta && ev.delta.stop_reason) sink.stop(ev.delta.stop_reason);
        if (ev.usage) sink.usage(ev.usage.output_tokens);
      } else if (ev.type === 'error') {
        sink.fail();
      }
    }
  },

  openai: {
    request: ({model, key, system, messages, maxTokens}) => ({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {'content-type':'application/json','authorization':'Bearer ' + key},
      body: {
        model, stream: true, stream_options: {include_usage: true},
        max_completion_tokens: maxTokens,     // GPT-5.x rejects max_tokens
        messages: [{role:'system', content: system},
                   ...messages.map(m => ({role: m.role, content: m.content}))]
      }
    }),
    parse: (ev, sink) => {
      const c = ev.choices && ev.choices[0];
      if (c && c.delta) {
        if (c.delta.content)           sink.text(c.delta.content);
        if (c.delta.reasoning_content) sink.think(c.delta.reasoning_content);
      }
      if (c && c.finish_reason) sink.stop(c.finish_reason === 'length' ? 'max_tokens' : c.finish_reason);
      if (ev.usage) sink.usage(ev.usage.completion_tokens);
    }
  },

  deepseek: {
    request: ({model, key, system, messages, maxTokens}) => ({
      url: 'https://api.deepseek.com/chat/completions',
      headers: {'content-type':'application/json','authorization':'Bearer ' + key},
      body: {
        model, stream: true, max_tokens: maxTokens,
        messages: [{role:'system', content: system},
                   ...messages.map(m => ({role: m.role, content: m.content}))]
      }
    }),
    parse: (ev, sink) => {
      const c = ev.choices && ev.choices[0];
      if (c && c.delta) {
        if (c.delta.content)           sink.text(c.delta.content);
        if (c.delta.reasoning_content) sink.think(c.delta.reasoning_content);
      }
      if (c && c.finish_reason) sink.stop(c.finish_reason === 'length' ? 'max_tokens' : c.finish_reason);
      if (ev.usage) sink.usage(ev.usage.completion_tokens);
    }
  },

  gemini: {
    request: ({model, key, system, messages, maxTokens}) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      headers: {'content-type':'application/json','x-goog-api-key': key},
      body: {
        systemInstruction: {parts: [{text: system}]},
        generationConfig: {maxOutputTokens: maxTokens},
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{text: m.content}]
        }))
      }
    }),
    parse: (ev, sink) => {
      const c = ev.candidates && ev.candidates[0];
      const parts = (c && c.content && c.content.parts) || [];
      for (const p of parts) {
        if (!p.text) continue;
        if (p.thought) sink.think(p.text); else sink.text(p.text);
      }
      if (c && c.finishReason && c.finishReason !== 'STOP') {
        sink.stop(c.finishReason === 'MAX_TOKENS' ? 'max_tokens' : String(c.finishReason).toLowerCase());
      }
      if (ev.usageMetadata) sink.usage(ev.usageMetadata.candidatesTokenCount);
    }
  }
};

/* ---------------------------------------------------------------- utils */
function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-ibi-access',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status, headers: {'content-type':'application/json; charset=utf-8', ...corsHeaders(origin)}
});

/* Vendor errors are never forwarded verbatim — they name the vendor and can
   echo key fragments. Map to a neutral sentence and log the detail instead. */
function neutralError(status) {
  if (status === 401 || status === 403) return 'This engine is not accepting requests right now. Ask the CEO to check its configuration.';
  if (status === 404) return 'This engine is unavailable. Ask the CEO to check its configuration.';
  if (status === 429) return 'This engine is busy or its quota is spent. Wait a moment, or switch engine.';
  if (status >= 500)  return 'This engine is temporarily unavailable. Try again shortly.';
  return 'This engine rejected the request.';
}

/* Timing-safe-ish comparison so the access code can't be probed byte by byte. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------ handlers */
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: corsHeaders(origin)});
    }

    // Browser callers must come from a known origin. (Not a security
    // boundary on its own — a non-browser client can forge Origin — which
    // is why the access code below is the real gate.)
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({error: 'Origin not allowed.'}, 403, origin);
    }

    // Shared access code, held as a Worker secret.
    const supplied = request.headers.get('x-ibi-access') || '';
    if (!env.ACCESS_CODE || !safeEqual(supplied, env.ACCESS_CODE)) {
      return json({error: 'Access code missing or incorrect.'}, 401, origin);
    }

    if (url.pathname === '/v1/engines' && request.method === 'GET') {
      // Only neutral fields leave the Worker.
      const list = Object.entries(ENGINES).map(([id, e]) => ({
        id, label: e.label, tag: e.tag, ready: !!env[e.secret]
      }));
      return json({engines: list}, 200, origin);
    }

    if (url.pathname === '/v1/chat' && request.method === 'POST') {
      return handleChat(request, env, ctx, origin);
    }

    return json({error: 'Not found.'}, 404, origin);
  }
};

async function handleChat(request, env, ctx, origin) {
  /* ---- validate input ---- */
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({error: 'Conversation too large.'}, 413, origin);

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return json({error: 'Malformed request.'}, 400, origin); }

  const engine = ENGINES[payload.engine];
  if (!engine) return json({error: 'Unknown engine.'}, 400, origin);

  const key = env[engine.secret];
  if (!key) return json({error: 'This engine is not configured on the relay.'}, 503, origin);

  let messages = Array.isArray(payload.messages) ? payload.messages : [];
  messages = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .slice(-MAX_MESSAGES);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return json({error: 'No message to send.'}, 400, origin);

  const system = typeof payload.system === 'string' ? payload.system.slice(0, 20_000) : '';
  const maxTokens = Math.min(Number(payload.maxTokens) || 16_000, MAX_TOKENS_CAP);

  /* ---- call the vendor ---- */
  const vendor = VENDORS[engine.vendor];
  const req = vendor.request({model: engine.model, key, system, messages, maxTokens, think: engine.think});

  let upstream;
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  try {
    upstream = await fetch(req.url, {
      method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: timeout
    });
  } catch (e) {
    console.log('relay upstream failure', engine.vendor, String(e));
    return sseError('This engine could not be reached. Try again shortly.', origin);
  }

  if (!upstream.ok || !upstream.body) {
    // Read the vendor's message for the log only — it never reaches the client.
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 500); } catch {}
    console.log('relay upstream error', engine.vendor, upstream.status, detail);
    return sseError(neutralError(upstream.status), origin);
  }

  /* ---- normalise the stream ----
     Every vendor collapses to the same three event shapes, so the browser
     has no vendor-specific code and no way to tell them apart.            */
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = obj => writer.write(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));

  ctx.waitUntil((async () => {
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '', stop = null, out = null, failed = false;
    const sink = {
      text:  t => send({t}),
      think: k => send({k}),
      stop:  s => { stop = s; },
      usage: n => { out = n; },
      fail:  () => { failed = true; }
    };
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const p = line.slice(5).trim();
          if (!p || p === '[DONE]') continue;
          let ev; try { ev = JSON.parse(p); } catch { continue; }
          try { vendor.parse(ev, sink); } catch { failed = true; }
        }
      }
      if (failed) await send({error: 'This engine stopped unexpectedly. Try again.'});
      else await send({done: {stop, out}});
    } catch (e) {
      console.log('relay stream failure', engine.vendor, String(e));
      try { await send({error: 'The connection to this engine dropped.'}); } catch {}
    } finally {
      try { await writer.close(); } catch {}
    }
  })());

  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      ...corsHeaders(origin)
    }
  });
}

/* Errors are delivered on the stream too, so the client has one code path. */
function sseError(message, origin) {
  return new Response('data: ' + JSON.stringify({error: message}) + '\n\n', {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      ...corsHeaders(origin)
    }
  });
}
