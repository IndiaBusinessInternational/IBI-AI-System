/* =====================================================================
   IBI AI System — on-device engine gateway
   ---------------------------------------------------------------------
   Sits between the Cloudflare tunnel and the local model runtime so the
   runtime itself is never exposed.

       phone ──https──> Cloudflare ──tunnel──> THIS (127.0.0.1:11435)
                                                 └─> Ollama (127.0.0.1:11434)

   It exists because the runtime has no authentication of any kind — no
   key, no token, nothing. Publishing it directly would hand any stranger
   who found the hostname a free GPU and, worse, the model-management
   endpoints on the same port.

   Four jobs:

     1. ACCESS CODE. Every real request must carry `x-ibi-access`. This is
        the only thing standing between the internet and the runtime.

     2. ENDPOINT ALLOWLIST. Only chat and model-listing are forwarded.
        /api/delete and /api/pull are refused even WITH a valid code, so a
        leaked code cannot destroy or replace models — it can only chat.

     3. HOST REWRITE. The runtime refuses any request whose Host header
        isn't loopback — a tunnel's public hostname gets a bare 403 with an
        empty body and no log line. Rewriting Host to localhost:11434 is
        what makes the tunnel work at all; without it everything 403s and
        looks like the runtime is down.

     4. CORS. The browser sends a preflight OPTIONS with no custom headers,
        so preflight must pass WITHOUT a code. That is not a hole: a
        preflight reaches nothing and returns no data.

   Deliberately dependency-free — Node's stdlib only, so there is no
   install step and nothing to keep patched.
   ===================================================================== */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const LISTEN_PORT   = 11435;
const LISTEN_HOST   = '127.0.0.1';         // tunnel connects locally; never 0.0.0.0
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 11434;

/* The pages allowed to call this. The tunnel is public, so this is only a
   second line of defence — the access code is the real one.

   Every IBI app is a subdomain of one apex we own, and new ones ship often.
   Listing them individually meant editing and restarting this gateway every
   time an app started using the engine, so the rule is the apex itself. It
   is still an allowlist: never widen it to `*`, which would let any site you
   happen to visit drive the model on this PC.

   Matched on the PARSED hostname, deliberately. A string test like
   `origin.endsWith('indiabusinessinternational.online')` would also accept
   `https://evil-indiabusinessinternational.online` — the leading dot and the
   URL parse are what make this a domain check rather than a substring one. */
const APEX = 'indiabusinessinternational.online';
const EXTRA_ORIGINS = ['http://localhost:8127'];

function originAllowed(origin) {
  if (!origin) return true;                       // same-origin / non-browser callers
  if (EXTRA_ORIGINS.includes(origin)) return true;
  let u;
  try { u = new URL(origin); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;      // no plaintext from the public web
  return u.hostname === APEX || u.hostname.endsWith('.' + APEX);
}

/* Chat and model-listing only. Anything absent from this list is refused
   even with a valid code — notably the runtime's /api/* management routes. */
const ALLOWED = [
  {method: 'POST', path: '/v1/chat/completions'},
  {method: 'GET',  path: '/v1/models'}
];

/* Read the code from a file kept beside this script rather than baking it
   in, so the code can be rotated without editing code, and so this file
   stays safe to commit. */
const CODE_FILE = path.join(__dirname, 'access-code.txt');
let ACCESS_CODE = '';
try {
  ACCESS_CODE = fs.readFileSync(CODE_FILE, 'utf8').trim();
} catch (_) { /* handled below */ }

if (!ACCESS_CODE || ACCESS_CODE.length < 16) {
  console.error('[ibi-gateway] FATAL: no usable access code in ' + CODE_FILE);
  console.error('[ibi-gateway] Refusing to start — starting without one would');
  console.error('[ibi-gateway] publish the model runtime to the internet unguarded.');
  process.exit(1);
}

/* Timing-safe compare, so the code can't be recovered a character at a
   time by measuring how long the rejection takes. */
const crypto = require('crypto');
function sameCode(given) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(ACCESS_CODE, 'utf8');
  if (a.length !== b.length) return false;          // length alone is not secret
  return crypto.timingSafeEqual(a, b);
}

const log = (...m) => console.log(new Date().toISOString(), '[ibi-gateway]', ...m);

/* A vision request legitimately carries a base64 image, so the limit has to
   be generous — but not unbounded, or one caller can exhaust memory. */
const MAX_BODY = 24 * 1024 * 1024;

/* THE THINKING DEFAULT — the single most load-bearing line in this file.

   The model deliberates before answering. On the OpenAI-compatible path that
   deliberation goes into `reasoning_content` and the whole token budget is
   spent there, so `content` comes back EMPTY and finish_reason is `length`.
   Every calling app reads that as "the AI returned nothing".

   Measured on qwen3.5:4b through /v1/chat/completions:

     no knob                          content    0 chars, reasoning 611
     think: false                     content    0 chars, reasoning 756   <- ignored here
     chat_template_kwargs             content    0 chars, reasoning 729   <- ignored here
     reasoning_effort: "low"          content    0 chars, reasoning 664
     reasoning_effort: "none"         content  316 chars, reasoning   0   <- the only one

   `think:false` DOES work, but only on the runtime's native /api/chat, which
   is not what the apps speak. Do not "simplify" this to that flag.

   Applied here so no app has to know any of it. An app that genuinely wants
   deliberation sends its own reasoning_effort and this leaves it alone. */
function applyThinkingDefault(buf) {
  let obj;
  try { obj = JSON.parse(buf.toString('utf8')); }
  catch (_) { return buf; }             // not JSON we understand — pass through untouched
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return buf;
  if (obj.reasoning_effort !== undefined) return buf;   // caller made a choice; respect it
  obj.reasoning_effort = 'none';
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

function corsHeaders(origin) {
  const h = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-ibi-access',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
  if (origin && originAllowed(origin)) h['access-control-allow-origin'] = origin;
  return h;
}

function refuse(res, status, message, origin) {
  const body = JSON.stringify({error: {message}});
  res.writeHead(status, Object.assign({
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  }, corsHeaders(origin)));
  res.end(body);
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const url    = (req.url || '').split('?')[0];

  // Preflight: no code required, and it reveals nothing.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  // A tiny unauthenticated liveness route, so "is the gateway up?" can be
  // answered without handing over the code. It says nothing about models.
  if (req.method === 'GET' && url === '/healthz') {
    const body = JSON.stringify({ok: true, service: 'ibi-local-gateway'});
    res.writeHead(200, Object.assign({'content-type': 'application/json'}, corsHeaders(origin)));
    return res.end(body);
  }

  if (!originAllowed(origin)) {
    log('refused origin', origin);
    return refuse(res, 403, 'This caller is not allowed.', origin);
  }

  if (!sameCode(req.headers['x-ibi-access'])) {
    log('refused: bad or missing access code', req.method, url);
    return refuse(res, 401, 'Access code missing or incorrect.', origin);
  }

  if (!ALLOWED.some(a => a.method === req.method && a.path === url)) {
    log('refused route', req.method, url);
    return refuse(res, 404, 'Not available through this gateway.', origin);
  }

  // Host is rewritten to loopback: the runtime rejects anything else.
  const headers = Object.assign({}, req.headers, {host: `localhost:${UPSTREAM_PORT}`});
  delete headers['x-ibi-access'];        // never forward our own secret
  delete headers['cf-connecting-ip'];    // nor Cloudflare's client metadata
  delete headers['cf-ray'];
  delete headers['origin'];              // we answer CORS; the runtime need not

  /* The request body is collected rather than piped straight through, because
     applyThinkingDefault has to see the whole JSON object to edit it. Only the
     REQUEST is buffered — the reply still streams token by token, which is
     what the chat UIs depend on. */
  const chunks = [];
  let received = 0;
  let tooBig = false;

  req.on('data', d => {
    if (tooBig) return;
    received += d.length;
    if (received > MAX_BODY) {
      tooBig = true;
      log('refused: body over', MAX_BODY, 'bytes');
      return refuse(res, 413, 'That request is too large for the on-device engine.', origin);
    }
    chunks.push(d);
  });

  req.on('end', () => {
    if (tooBig) return;

    let body = Buffer.concat(chunks);
    if (body.length) body = applyThinkingDefault(body);

    // Host is rewritten to loopback: the runtime rejects anything else.
    const headers = Object.assign({}, req.headers, {host: `localhost:${UPSTREAM_PORT}`});
    delete headers['x-ibi-access'];        // never forward our own secret
    delete headers['cf-connecting-ip'];    // nor Cloudflare's client metadata
    delete headers['cf-ray'];
    delete headers['origin'];              // we answer CORS; the runtime need not
    // Rewriting the body changes its length, and a stale content-length would
    // hang the upstream read. Drop any chunked marker for the same reason.
    delete headers['transfer-encoding'];
    if (body.length) headers['content-length'] = Buffer.byteLength(body);
    else delete headers['content-length'];

    const up = http.request(
      {host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers},
      upRes => {
        const out = Object.assign({}, upRes.headers, corsHeaders(origin));
        // Streaming replies must not be buffered anywhere along the path.
        if (String(upRes.headers['content-type'] || '').includes('event-stream')) {
          out['cache-control'] = 'no-cache, no-transform';
          out['x-accel-buffering'] = 'no';
        }
        res.writeHead(upRes.statusCode || 502, out);
        upRes.pipe(res);
      }
    );

    up.on('error', err => {
      log('upstream error:', err.message);
      if (!res.headersSent) refuse(res, 502, 'The on-device runtime is not responding.', origin);
      else res.end();
    });

    // Don't let a dropped client leave a generation running upstream.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });

    up.end(body.length ? body : undefined);
  });

  req.on('error', err => {
    log('client error:', err.message);
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  log(`access code loaded (${ACCESS_CODE.length} chars) from ${CODE_FILE}`);
  log('allowed routes:', ALLOWED.map(a => a.method + ' ' + a.path).join(', '));
});
