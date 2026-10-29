// ═══════════════════════════════════════════════════════════════
// TAHAMTAN AI — Cloudflare Pages Worker (advanced mode)
// Routes static assets + proxies remaining Netlify functions.
//
// MIGRATION PATTERN: handle a migrated function directly here under its
// ORIGINAL /.netlify/functions/<name> path — intercepted before the generic
// proxy rule below — so index.html never needs to change its fetch URLs.
// Add one `if (url.pathname === '/.netlify/functions/<name>') return
// handle<Name>(request, env);` block per migrated function.
//
// ── tts-voice: MIGRATED TO CLOUDFLARE (Oct 2026) ──
// First real migration off Netlify. Why it had to move: Netlify Functions
// run in AWS Lambda compatibility mode, which caps the COMBINED size of all
// environment variables at 4KB. This project has 31+ env vars (Supabase JWTs
// alone are 200+ bytes each), so there was no room left for the ~1.8KB Google
// service-account JSON — every deploy failed with "environment variables
// exceed the 4KB limit", taking all 45 functions down with it. Cloudflare has
// no combined cap (64 vars/Worker, 5KB each), so the key fits comfortably.
//
// ── MODEL: CHIRP 3: HD ──
// Chosen for its free tier: 1 million characters per month, roughly 4,500
// fifteen-second voiceovers.
//
// PERSIAN IS NOT SUPPORTED. Chirp has no fa-IR — accent #1 returns "voice
// does not exist" — so fa-IR is routed to en-US (see LOCALE_FALLBACK below).
// That is an English voice reading Farsi: intelligible, but the prosody is
// English and '?' and '!' come out wrong. Tested, not assumed.
//
// Request shape Chirp requires:
//   • Voice names are locale-prefixed: "<locale>-Chirp3-HD-<Voice>", e.g.
//     "en-US-Chirp3-HD-Aoede". All 8 voices the picker offers exist in
//     Chirp's 30-voice set, so the front-end list needed no change.
//   • No style or prompt field — the Mood dropdown is carried by
//     speakingRate instead. See styleToRate().
//   • No pitch field. b.pitch is accepted and ignored. (SSML <prosody>
//     could carry real pitch later; not used here to avoid escaping bugs.)
//   • No modelName — the model is implied by the voice name.
//
// LANGUAGE CODES: index.html's TTS_ACC/ACC arrays must hold Chirp locales.
// They must stay in step with this file or calls fail outright.
//
// PORTING NOTES (Node → Workers runtime):
//   • crypto.createSign('RSA-SHA256')  → crypto.subtle.importKey('pkcs8') +
//     crypto.subtle.sign('RSASSA-PKCS1-v1_5').
//   • crypto.createHash('sha256')      → crypto.subtle.digest('SHA-256').
//   • Buffer                           → atob/btoa + TextEncoder/Uint8Array.
//   • r2-upload.js (S3 API)            → native R2 binding (env.VOICE_R2).
//
// The request/response contract is unchanged, so index.html needs NO changes
// beyond the language codes.
//
// REQUIRED Cloudflare Pages configuration:
//   Env var  GOOGLE_SERVICE_ACCOUNT_JSON  — full service-account JSON (required)
//   Env var  GOOGLE_TTS_API_KEY           — fallback (optional; see note below)
//   Env var  R2_PUBLIC_URL                — optional, defaults below
//   Binding  VOICE_R2                     — R2 bucket binding
//
// Note: Chirp 3: HD is not gated behind Vertex IAM, so the plain API key is
// a genuinely viable fallback here. The service account is still preferred.
//
// Without the VOICE_R2 binding the Preview button still works (it only uses
// the data: URI), but `audio_url` comes back null and voice-into-video merging
// breaks, because the Railway merge service must fetch the audio over the
// network and cannot read a data: URI.
// ═══════════════════════════════════════════════════════════════

const NETLIFY_ORIGIN = 'https://roaring-malabi-3c8204.netlify.app';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  // netlify.toml set this for /.netlify/functions/* — preserved so behaviour
  // is unchanged now that the Worker answers this path itself.
  'Access-Control-Allow-Origin': '*'
};

const DEFAULT_R2_PUBLIC_URL = 'https://pub-0f81e4828a664af58eca3cf9734a6e1f.r2.dev';

const TTS_MODEL = 'chirp3-hd';

// ── Locale fallbacks ──────────────────────────────────────────────────
// Chirp 3: HD has no fa-IR. Without this map, a Persian request fails with
// "voice does not exist" — and because index.html auto-detects Farsi script
// and maps it to accent #1 (fa-IR), that failure hits EVERY Persian customer
// automatically, before they ever touch the accent picker. They would have
// to know to manually override to accent #4, which no customer will do.
//
// So Persian is routed to en-US, which does produce audio for Farsi text.
// Be clear about what that is: an ENGLISH voice reading Persian. The words
// are intelligible; the prosody is English, so '?' and '!' take English
// question and stress intonation and a native speaker notices. It is a
// stopgap that keeps Persian WORKING rather than BROKEN, not a Persian voice.
//
// Reversible in one line: delete the fa-IR entry the moment the backend
// moves to a model that speaks real Persian.
//
// Done here, server-side, rather than in index.html because six different
// front-end call sites send a languageCode (generation, preview, seamless,
// picker, regenerate…) and patching each one would leave the next new path
// to rediscover the bug. One substitution point covers all of them.
const LOCALE_FALLBACK = {
  'fa-IR': 'en-US'
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

// ── encoding helpers (no Buffer in the Workers runtime) ──
function bytesToB64(bytes) {
  let s = '';
  const CHUNK = 0x8000; // avoid blowing the argument limit on large audio
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlBytes(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Deterministic key: identical text+voice+language+style always lands on the
// same R2 object, so a repeat Preview click (very common while a user is
// tweaking a script) is served from storage instead of re-billing Google.
// `model` is part of the hashed input ON PURPOSE: it stops audio cached by a
// previous TTS backend from being served by this one. Objects left behind by
// an older backend are harmless and can be bulk-deleted from R2 any time.
async function cacheKeyFor(params) {
  const data = new TextEncoder().encode(JSON.stringify(params));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `voice-tts-cache/${hex.slice(0, 32)}.wav`;
}

async function tryCacheHit(key, publicUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // never let a flaky cache check delay a real request for long
    try {
      const r = await fetch(`${publicUrl}/${key}`, { signal: controller.signal });
      if (!r.ok) return null;
      const buf = new Uint8Array(await r.arrayBuffer());
      return buf.length ? buf : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    return null; // any error here just means a cache miss, never a hard failure
  }
}

// ── Punctuation normalisation for right-to-left languages ────────────
// Persian, Arabic and Urdu have their OWN punctuation marks, and a TTS
// model trained on those languages expects them:
//
//     ,  →  ،   (U+060C Arabic comma)
//     ;  →  ؛   (U+061B Arabic semicolon)
//     ?  →  ؟   (U+061F Arabic question mark)
//     .  →  ۔   (U+06D4 — Urdu only; Persian and Arabic keep the Latin dot)
//
// Typed on an ordinary keyboard, Farsi comes out with ASCII , ; ? and the
// model reads the phrasing as if it were English — the clause breaks and
// the question rise land in the wrong places. '!' needs no conversion;
// Persian uses the same exclamation mark.
//
// Diacritics (َ ُ ِ ّ ً — fatha, damma, kasra, shadda, tanwin) are left
// completely alone. They are pronunciation guides, and stripping or
// altering them makes the reading WORSE, not better.
//
// Applied only when the voice genuinely speaks that language. While fa-IR
// is being substituted to en-US (see LOCALE_FALLBACK), the English voice
// would simply not know what ؟ is and would lose the pause altogether, so
// Persian text keeps its ASCII marks until a real Persian voice is in use.
// The comma is guarded against digits on BOTH sides: "1,000 ريال" must stay a
// thousands separator. Converted blindly it became "1،000", which a speech
// model reads as a clause break — "one، zero zero zero" instead of "one
// thousand". Prices and view counts are exactly the kind of thing these
// scripts contain, so this is not a corner case.
const RTL_PUNCT = [
  [/(?<![0-9]),(?![0-9])/g, '،'],
  [/;/g,                    '؛'],
  [/\?/g,                   '؟']
];
function normalizeRtlPunctuation(text, languageCode) {
  const lang = String(languageCode || '').slice(0, 2).toLowerCase();
  if (lang !== 'fa' && lang !== 'ar' && lang !== 'ur') return text;
  let out = text;
  for (const [re, ch] of RTL_PUNCT) out = out.replace(re, ch);
  if (lang === 'ur') out = out.replace(/\.(\s|$)/g, '۔$1'); // Urdu full stop
  return out;
}

// Chirp has no style/prompt field, so the Mood dropdown is carried by pace
// instead. Deliberately conservative: Chirp accepts 0.25–2.0, but anything
// past roughly ±20% stops sounding like a mood and starts sounding like a
// fault. "Friendly" is nudged rather than left identical to Normal so the
// dropdown isn't lying about having an effect.
function styleToRate(style) {
  switch (String(style || 'normal')) {
    case 'calm':     return 0.90;
    case 'excited':  return 1.15;
    case 'dramatic': return 0.85;
    case 'friendly': return 1.05;
    default:         return 1.0;
  }
}

// Chirp wants the fully-qualified voice ID. Accepts a bare name ("Aoede"),
// an already-prefixed one, or a bare name from an older client, and always
// emits the canonical "<locale>-Chirp3-HD-<Voice>".
function buildChirpVoiceName(languageCode, voiceName) {
  const bare = String(voiceName || 'Aoede')
    .replace(/^.*Chirp3-HD-/i, '')  // strip any existing prefix
    .replace(/[^A-Za-z]/g, '')      // voice names are plain letters
    .slice(0, 40) || 'Aoede';
  return `${languageCode}-Chirp3-HD-${bare}`;
}

// ── Service-account auth (Web Crypto) ──
// Cached across warm invocations of this isolate, same as the Node version
// cached across warm Lambda containers.
let cachedToken = null;    // { token, expiresAt }
let cachedSignKey = null;  // imported CryptoKey — importKey is not free, don't redo it per request

function pemToPkcs8(pem) {
  const body = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  return b64ToBytes(body).buffer;
}

async function getServiceAccountToken(saJson) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token;

  const sa = JSON.parse(saJson);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));

  if (!cachedSignKey) {
    cachedSignKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToPkcs8(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cachedSignKey,
    new TextEncoder().encode(unsigned)
  );
  const jwt = unsigned + '.' + b64urlBytes(new Uint8Array(sigBuf));

  const r = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
          '&assertion=' + encodeURIComponent(jwt)
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error('token_exchange_failed: ' + (data.error_description || data.error || r.status));
  }
  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return cachedToken.token;
}

async function uploadToR2(env, key, bytes) {
  if (!env.VOICE_R2) return null; // binding not configured — data: URI still returned
  try {
    await env.VOICE_R2.put(key, bytes, { httpMetadata: { contentType: 'audio/wav' } });
    const publicUrl = (env.R2_PUBLIC_URL || DEFAULT_R2_PUBLIC_URL).replace(/\/+$/, '');
    return `${publicUrl}/${key}`;
  } catch (e) {
    console.warn('tts-voice R2 upload failed (data URI still returned):', e && e.message);
    return null;
  }
}

// ═══ /.netlify/functions/tts-voices  (DEBUG / DIAGNOSTIC) ═══
// Asks Google which voices actually exist for a locale, using THIS project's
// own credentials. Exists because Google's docs and its public demo page
// disagree about which languages are available, so neither settles the
// question. This endpoint does, and it answers it for any language later.
//
// Usage:  /.netlify/functions/tts-voices?lang=fa-IR
//         /.netlify/functions/tts-voices            (every voice Google has)
//
// An empty `voices` array means Google genuinely has nothing for that locale
// in ANY tier — Standard, WaveNet, Neural2, Studio or Chirp.
// Caveat: voices.list reports the classic voice inventory. Model-based
// voices are not catalogued per locale, so a locale can be missing here and
// still work in a real synthesize call. If a locale comes back empty,
// confirm with an actual synthesize request before concluding.
// Read-only and harmless, but it is a diagnostic: delete it once the
// language question is settled rather than leaving it public.
async function handleTtsVoices(request, env) {
  const url = new URL(request.url);
  const lang = (url.searchParams.get('lang') || '').slice(0, 12);

  const saJson = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const apiKey = env.GOOGLE_TTS_API_KEY;
  if (!saJson && !apiKey) return json({ error: 'no_key' });

  let target = 'https://texttospeech.googleapis.com/v1/voices';
  if (lang) target += '?languageCode=' + encodeURIComponent(lang);

  let headers = {};
  try {
    if (saJson) {
      headers = { Authorization: 'Bearer ' + (await getServiceAccountToken(saJson)) };
    } else {
      target += (lang ? '&' : '?') + 'key=' + encodeURIComponent(apiKey);
    }
  } catch (e) {
    return json({ error: 'auth_failed', message: String(e && e.message) });
  }

  try {
    const r = await fetch(target, { headers });
    const data = await r.json();
    const voices = (data && data.voices) || [];
    // Summarised rather than raw: the full payload is long and the only
    // questions being asked are "does this locale exist" and "which tiers".
    return json({
      languageCode: lang || '(all)',
      count: voices.length,
      supported: voices.length > 0,
      voices: voices.map(v => ({
        name: v.name,
        gender: v.ssmlGender,
        languageCodes: v.languageCodes
      })),
      error: data && data.error ? data.error.message : undefined
    });
  } catch (e) {
    return json({ error: 'exception', message: String(e && e.message) });
  }
}

// ═══ /.netlify/functions/tts-voice ═══
async function handleTtsVoice(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const saJson = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const apiKey = env.GOOGLE_TTS_API_KEY;
  if (!saJson && !apiKey) {
    return json({ error: 'no_key', message: 'Voice not configured yet.' });
  }

  let b = {};
  try { b = await request.json(); } catch (e) {}

  const text = String(b.text || '').slice(0, 2500).trim();
  // keep original casing — Google matches voice IDs case-sensitively
  const requestedLang = String(b.languageCode || 'en-US').slice(0, 12);
  const languageCode = LOCALE_FALLBACK[requestedLang] || requestedLang;
  const substituted = languageCode !== requestedLang;
  const style = String(b.style || 'normal').slice(0, 20);
  const speakingRate = styleToRate(style);
  const fullVoiceName = buildChirpVoiceName(languageCode, b.voiceName);
  // b.pitch is accepted and ignored: Chirp has no AudioConfig.pitch field.
  if (!text) return json({ error: 'no_text' }, 400);

  // ── PREVIEW CAP REMOVED (28 Oct 2026) ──────────────────────────────────
  // There used to be a `preview: true` short-snippet mode (25-word cap) for
  // "just checking the voice/accent" calls, cheaper than a full synthesis.
  // index.html never actually sent `preview: true` on any of its 6 calls to
  // this endpoint, so it was dead code — every Preview click was already
  // paying for full, uncapped synthesis. Removed rather than wired up:
  // Elite's call was that Preview should always speak the whole script, not
  // a truncated snippet, so there is nothing left to cap.
  // `isPreview` is kept (always false now) only so the response shape is
  // unchanged for any caller reading `preview` off the JSON result.
  const isPreview = false;
  // `languageCode` here is the EFFECTIVE one, after LOCALE_FALLBACK. That is
  // deliberate: if Persian has been substituted to en-US, this is 'en-US' and
  // no conversion happens, so the English voice still gets punctuation it
  // understands. The moment a real Persian voice is configured, the code
  // stays fa-IR and the conversion starts applying by itself.
  const synthText = normalizeRtlPunctuation(text, languageCode);

  const publicUrl = (env.R2_PUBLIC_URL || DEFAULT_R2_PUBLIC_URL).replace(/\/+$/, '');

  // Check the cache before spending anything on Google — identical inputs always
  // hash to the same key, so re-previewing unchanged text/voice/language/style
  // is free after the first time.
  const cacheKey = await cacheKeyFor({
    model: TTS_MODEL,
    text: synthText,
    languageCode,
    voiceName: fullVoiceName,
    speakingRate
  });
  const cached = await tryCacheHit(cacheKey, publicUrl);
  if (cached) {
    return json({
      audio: 'data:audio/wav;base64,' + bytesToB64(cached),
      audio_url: `${publicUrl}/${cacheKey}`,
      model: TTS_MODEL,
      voice: fullVoiceName,
      cached: true,
      preview: isPreview,
      // Only present when a fallback fired, so "is this really Persian?"
      // is answerable from the response instead of by reading the source.
      requested_language: substituted ? requestedLang : undefined,
      language_used: substituted ? languageCode : undefined
    });
  }

  const body = {
    audioConfig: { audioEncoding: 'LINEAR16', speakingRate: speakingRate },
    input: { text: synthText },
    voice: { languageCode: languageCode, name: fullVoiceName }
  };

  let requestHeaders, url;
  try {
    if (saJson) {
      const token = await getServiceAccountToken(saJson);
      requestHeaders = Object.assign({ Authorization: 'Bearer ' + token }, { 'Content-Type': 'application/json' });
      url = 'https://texttospeech.googleapis.com/v1/text:synthesize';
    } else {
      requestHeaders = { 'Content-Type': 'application/json' };
      url = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(apiKey);
    }
  } catch (e) {
    return json({ error: 'auth_failed', message: String(e && e.message) });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000); // avoid hanging until the platform's own timeout
    let r, data;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      data = await r.json();
    } finally {
      clearTimeout(timeout);
    }
    if (!r.ok || !data.audioContent) {
      // Surfaces the attempted voice ID in the error so an unsupported locale
      // (the most likely failure after this migration) is obvious in the
      // browser console rather than showing up as a generic "failed".
      return json({
        error: 'tts_failed',
        message: (data.error && data.error.message) || 'failed',
        voice: fullVoiceName
      });
    }
    // LINEAR16 comes back as raw PCM/WAV base64 — label it correctly for
    // playback. Store it under the deterministic cache key (not a random one)
    // so the next identical request hits the cache above instead of paying again.
    const audioUrl = await uploadToR2(env, cacheKey, b64ToBytes(data.audioContent));
    return json({
      audio: 'data:audio/wav;base64,' + data.audioContent,
      audio_url: audioUrl,
      model: TTS_MODEL,
      voice: fullVoiceName,
      cached: false,
      preview: isPreview,
      requested_language: substituted ? requestedLang : undefined,
      language_used: substituted ? languageCode : undefined
    });
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return json({
      error: timedOut ? 'timeout' : 'exception',
      message: timedOut ? 'Google TTS took too long to respond.' : String(e && e.message)
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Migrated functions: handled here, before the generic proxy ──
    if (url.pathname === '/.netlify/functions/tts-voice') {
      return handleTtsVoice(request, env);
    }
    if (url.pathname === '/.netlify/functions/tts-voices') {
      return handleTtsVoices(request, env);   // diagnostic — see note above
    }

    // Forward remaining Netlify function calls (payments, login, video
    // generation, etc.)
    if (url.pathname.startsWith('/.netlify/functions/')) {
      const target = NETLIFY_ORIGIN + url.pathname + url.search;
      // Pass Cloudflare's own view of where the request came from. Netlify
      // Functions can't see this (they're behind this proxy, so every
      // request appears to originate from the Worker), and Cloudflare
      // already resolves it at the edge for free — no ipapi.co call, no
      // rate limit, no added latency.
      //
      // Paired with the browser timezone the client sends, this is what
      // separates a genuine diaspora customer from an Iranian visitor on a
      // European VPN: the IP country is spoofable, the OS clock is not.
      // Agreement means the location is real; disagreement means a VPN.
      const fwd = new Request(target, request);
      const headers = new Headers(fwd.headers);
      headers.set('X-Client-Country', (request.cf && request.cf.country) || 'XX');
      return fetch(new Request(fwd, { headers }));
    }

    // Serve the matching static file if one exists
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }

    // Fallback: any other path serves index.html (matches old Netlify SPA redirect)
    return env.ASSETS.fetch(new URL('/index.html', request.url));
  }
};
