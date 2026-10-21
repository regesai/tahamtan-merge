// ═══════════════════════════════════════════════════════════════
// TAHAMTAN AI — Video Merge Service
// Merges multiple AI video clips into one seamless MP4
// Deploy on Railway.app — always on, no cold starts
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const ffmpeg  = require('fluent-ffmpeg');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── IDENTITY VERIFICATION ─────────────────────────────────────
// This is a SEPARATE deployment (Railway) from the Netlify functions, so it
// can't require('./auth.js') — that file lives in a different repo. This is
// the same HMAC-signed-token technique duplicated here on purpose: same
// USER_SESSION_SECRET env var, same verify logic, so a token issued by
// verify-otp.js (Netlify) is valid here too. Previously NONE of /merge,
// /caption, /finalize, /music checked identity at all — every real ffmpeg
// job (actual CPU cost, not just a database row) was completely open to
// anyone who read MERGE_SERVICE_URL out of the page's own JS. Fail closed:
// any doubt = not authenticated.
function sessionSecret() {
  return process.env.USER_SESSION_SECRET || process.env.STAFF_SESSION_SECRET || '';
}
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function verifyToken(token) {
  try {
    const key = sessionSecret();
    if (!key || !token) return { ok: false, owner: false };
    const t = String(token).replace(/^Bearer\s+/i, '');
    const dot = t.lastIndexOf('.');
    if (dot < 0) return { ok: false, owner: false };
    const p = t.slice(0, dot), sig = t.slice(dot + 1);
    const expSig = b64url(crypto.createHmac('sha256', key).update(p).digest());
    if (sig.length !== expSig.length) return { ok: false, owner: false };
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expSig))) return { ok: false, owner: false };
    const payload = JSON.parse(b64urlDecode(p));
    if (!payload.email || !payload.exp || Date.now() >= payload.exp) return { ok: false, owner: false };
    return { ok: true, email: payload.email, owner: payload.o === 1 };
  } catch (e) {
    return { ok: false, owner: false };
  }
}
// Pulls a token from the Authorization header or the JSON body (token /
// session_token) — same precedence as auth.js's authFromEvent.
function authFromReq(req) {
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const bodyTok = req.body && (req.body.token || req.body.session_token);
  return verifyToken(hdr || bodyTok || '');
}
// Express middleware — reject before any download/ffmpeg work starts.
function requireAuth(req, res, next) {
  const auth = authFromReq(req);
  if (!auth.ok) return res.status(401).json({ error: 'not_verified', message: 'Please verify your email first.' });
  req.tahAuth = auth;
  next();
}

// ── EDIT-CREDIT RECEIPTS ──────────────────────────────────────
// requireAuth above proves IDENTITY, not PAYMENT — /caption and /music are
// supposed to be gated by edit credits, but that spend happens as a
// completely separate call to edit-credits.js (Netlify) with nothing
// linking it to this call. That meant ANY verified user, including one
// with zero edit credits who never bought anything, could call these
// endpoints directly and get the real ffmpeg work done for free. Same
// signing scheme as edit-credits.js's spend receipts (same
// USER_SESSION_SECRET) — requireReceipt verifies a real, recent, matching
// spend actually happened before any download/ffmpeg work starts.
const RECEIPT_TTL_MS = 30 * 60 * 1000;
function verifyReceipt(receipt) {
  try {
    const key = sessionSecret();
    if (!key || !receipt) return null;
    const dot = String(receipt).lastIndexOf('.');
    if (dot < 0) return null;
    const p = receipt.slice(0, dot), sig = receipt.slice(dot + 1);
    const expSig = crypto.createHmac('sha256', key).update(p).digest('base64');
    if (sig.length !== expSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expSig))) return null;
    const obj = JSON.parse(Buffer.from(p, 'base64').toString());
    if (!obj.iat || Date.now() - obj.iat > RECEIPT_TTL_MS) return null;
    return obj;
  } catch (e) { return null; }
}
// ── PAID-PLAN VERIFICATION ────────────────────────────────────
// For features that should be paid-plan-only, not just edit-credit-
// gated (e.g. /finalize's boost path) — a free-trial user has no edit
// credits to spend in the first place, so a credit charge alone doesn't
// stop them; this checks there's an actual valid, non-expired plan code
// behind the request. Independent of the optional `supabase` client
// above (that one is nullable and documented as fallback-only) — this
// does its own direct REST lookup so it works whether or not that
// client initialized. FAILS CLOSED: any doubt (no code, lookup error,
// expired code) = not a paid plan.
//
// REQUIRES a Supabase key with read access to activation_codes. Prefers
// SUPABASE_SERVICE_ROLE_KEY (same convention entitlement.js uses on
// Netlify) over the plain SUPABASE_KEY already set here for the
// merge_jobs fallback — that one may be a weaker anon key blocked by
// RLS from reading activation_codes. Set SUPABASE_SERVICE_ROLE_KEY on
// Railway for this to work reliably.
const CODE_VALID_DAYS = 30; // mirrors entitlement.js's own expiry window
async function isPaidPlanCode(code) {
  if (!code) return false;
  const supaUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
  if (!/^https:\/\/.+/.test(supaUrl) || !supaKey) {
    console.warn('isPaidPlanCode: Supabase not configured on Railway — failing closed');
    return false;
  }
  try {
    const res = await fetch(
      supaUrl + '/rest/v1/activation_codes?code=eq.' + encodeURIComponent(String(code).toUpperCase()) + '&select=plan,created_at,used_at&limit=1',
      { headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey } }
    );
    if (!res.ok) { console.warn('isPaidPlanCode: lookup failed', res.status); return false; }
    const rows = await res.json();
    const row = Array.isArray(rows) && rows[0];
    if (!row || !row.plan) return false;
    const startedAt = row.used_at || row.created_at;
    if (startedAt) {
      const ageDays = (Date.now() - new Date(startedAt).getTime()) / 86400000;
      if (ageDays > CODE_VALID_DAYS) return false;
    }
    return true;
  } catch (e) {
    console.warn('isPaidPlanCode error:', e.message);
    return false;
  }
}
function requirePaidPlan(req, res, next) {
  isPaidPlanCode(req.body && req.body.code).then(ok => {
    if (!ok) return res.status(402).json({ error: 'paid_plan_required', message: 'This feature needs an active paid plan.' });
    next();
  });
}

// /finalize is called TWO ways: boost:true (the user-facing "Optimize for
// Social / HD ready" button — should be paid-plan-only, since a free user
// could otherwise click it repeatedly and duplicate R2 storage for free)
// and boost:false+watermark:true (the automatic pass every free video
// gets right after generation — must stay open to free users, it's how
// their videos get the TAHAMTAN watermark burned in at all).
function requirePaidPlanIfBoost(req, res, next) {
  if (req.body && req.body.boost === true) return requirePaidPlan(req, res, next);
  next();
}

function requireReceipt(expectedReasons) {
  const allowed = Array.isArray(expectedReasons) ? expectedReasons : [expectedReasons];
  return function (req, res, next) {
    const auth = req.tahAuth;
    const claim = verifyReceipt(req.body && req.body.receipt);
    if (!claim || claim.email !== auth.email || allowed.indexOf(claim.reason) === -1) {
      return res.status(402).json({ error: 'invalid_receipt', message: 'No matching recent edit-credit charge found for this action.' });
    }
    next();
  };
}

// Supabase (optional — only used as a fallback; primary storage is R2).
// Wrapped in try/catch and a URL sanity check so a malformed SUPABASE_URL
// can NEVER take the whole server down at boot (this was crashing Railway
// inside RealtimeClient._initializeOptions).
const SUPABASE_URL  = (process.env.SUPABASE_URL  || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY  = (process.env.SUPABASE_KEY  || '').trim();
let supabase = null;
try {
  if (/^https:\/\/.+/.test(SUPABASE_URL) && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 1 } },
    });
  } else if (SUPABASE_URL || SUPABASE_KEY) {
    console.warn('Supabase not initialised — SUPABASE_URL must start with https:// and SUPABASE_KEY must be set. Using R2 only.');
  }
} catch (e) {
  console.warn('Supabase init skipped (' + (e && e.message) + '). Using R2 only.');
  supabase = null;
}

// Bucket for merged videos — MUST exist in Supabase Storage and be public-read.
const MERGE_BUCKET = process.env.MERGE_BUCKET || 'videos';

// ── In-memory job status ──────────────────────────────────────
// Authoritative source the browser polls via GET /status/:job_id.
// Removes any dependency on Supabase RLS for the browser to read
// merge results (browser anon key often can't SELECT merge_jobs).
const jobs = {};
function setJob(id, patch) {
  if (!id) return;
  jobs[id] = Object.assign(
    { status: 'pending', url: null, error: null },
    jobs[id] || {},
    patch,
    { updated: Date.now() }
  );
}
// Evict jobs older than 1h so memory doesn't grow unbounded.
setInterval(function () {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const k of Object.keys(jobs)) { if (jobs[k].updated < cutoff) delete jobs[k]; }
}, 10 * 60 * 1000);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'tahamtan-merge', timestamp: new Date().toISOString() });
});

// ─── STATUS (browser polls this — always readable, no RLS) ───
app.get('/status/:job_id', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const j = jobs[req.params.job_id];
  if (!j) return res.json({ status: 'unknown' });
  // Return the URL under every field name the frontend might read.
  res.json({ status: j.status, url: j.url, output_url: j.url, video_url: j.url, error: j.error });
});

// ─── PROXY (for CORS issues with Atlas video URLs) ───────────
// NOTE: still unauthenticated — used directly as a <video src>, which
// can't carry an Authorization header or JSON body. Gating this properly
// needs a short-lived signed query-param token instead; flagged as a
// separate, still-open item, not fixed in this pass.
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url param required' });
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({ error: 'upstream error' });
    res.setHeader('Content-Type', r.headers.get('content-type') || 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    r.body.pipe(res);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── MERGE ───────────────────────────────────────────────────
app.post('/merge', requireAuth, async (req, res) => {
  const { clips, job_id } = req.body;

  if (!clips || !Array.isArray(clips) || clips.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 clip URLs to merge' });
  }

  console.log(`[${job_id}] Merge job started — ${clips.length} clips`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-'));

  try {
    // Update Supabase status: downloading
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'Merge started' });

    // 1. Download all clips
    const localFiles = [];
    for (let i = 0; i < clips.length; i++) {
      const localPath = path.join(tmpDir, `clip_${i}.mp4`);
      console.log(`[${job_id}] Downloading clip ${i+1}/${clips.length}`);
      await downloadFile(clips[i], localPath);
      localFiles.push(localPath);
    }

    // 2. Update status: merging
    await updateJob(job_id, 'merging');

    // 3. Create concat list
    const listFile = path.join(tmpDir, 'list.txt');
    const listContent = localFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    // 4. Merge with ffmpeg — smooth crossfade joins, fall back to hard concat on any error
    const outputFile = path.join(tmpDir, 'merged.mp4');
    try {
      await mergeVideosSmooth(localFiles, outputFile);
      console.log(`[${job_id}] Smooth (crossfade) merge complete — ${outputFile}`);
    } catch (xfErr) {
      console.warn(`[${job_id}] Crossfade merge failed, using concat fallback: ${xfErr.message}`);
      await mergeVideos(listFile, outputFile);
      console.log(`[${job_id}] Concat merge complete — ${outputFile}`);
    }

    // 5. Upload to Supabase Storage
    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outputFile);

    // 6. Done — update job with video URL
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] Done — ${publicUrl}`);

  } catch (err) {
    console.error(`[${job_id}] Error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    // Cleanup temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
});

// ─── CAPTION (burn subtitles into a video) ───────────────────
// Body: { video_url, cues:[{start,end,text}], job_id, rtl?, style? }
//   start/end in seconds. Burns ASS subtitles into the MP4 (permanent),
//   so captions survive download and sharing. Status via /status/:job_id.
app.post('/caption', requireAuth, requireReceipt('captions'), async (req, res) => {
  const { video_url, cues, job_id, rtl, style } = req.body || {};
  if (!video_url || !Array.isArray(cues) || cues.length === 0) {
    return res.status(400).json({ error: 'video_url and non-empty cues[] required' });
  }
  console.log(`[${job_id}] Caption job started — ${cues.length} cues, rtl=${!!rtl}`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-cap-'));

  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'Caption started' });

    const inPath = path.join(tmpDir, 'in.mp4');
    await downloadFile(video_url, inPath);

    await updateJob(job_id, 'captioning');
    const assPath = path.join(tmpDir, 'sub.ass');
    fs.writeFileSync(assPath, buildAss(cues, { rtl: !!rtl, lang: (req.body && req.body.lang) || '', style: style || {} }));

    const outPath = path.join(tmpDir, 'out.mp4');
    await burnSubtitles(inPath, assPath, outPath, tmpDir);

    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outPath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] Caption done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] Caption error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
});

// ─── FINALIZE (optimize for social platforms) ───────────────
// Body: { video_url, job_id, boost? }
// Re-wraps the video as a clean 1080x1920 H.264/AAC file with BT.709
// color and a healthy bitrate, plus a light brightness/shadow/saturation
// lift so it survives TikTok/Reels/Shorts compression without darkening.
app.post('/finalize', requireAuth, requirePaidPlanIfBoost, async (req, res) => {
  const { video_url, job_id } = req.body || {};
  const boost = (req.body && req.body.boost === false) ? false : true;
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  console.log(`[${job_id}] Finalize job started — boost=${boost}`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-fin-'));

  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'Finalize started' });

    const inPath = path.join(tmpDir, 'in.mp4');
    await downloadFile(video_url, inPath);

    await updateJob(job_id, 'optimizing');
    const outPath = path.join(tmpDir, 'out.mp4');
    await finalizeForSocial(inPath, outPath, { boost: boost });

    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outPath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] Finalize done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] Finalize error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
});

// ─── MUSIC (mix a background track into a video) ─────────────
// Body: { video_url, audio_url, job_id, volume?, duck? }
//   volume: 0..1 music level (default 0.35)
//   duck:   true → auto-lower music under any speech (default true)
// Loops the track to fill the video, ducks under speech, fades out the
// tail, and keeps any original voice. Status via /status/:job_id.
app.post('/music', requireAuth, requireReceipt(['music', 'voice']), async (req, res) => {
  const { video_url, audio_url, job_id } = req.body || {};
  const volume = Math.min(Math.max(parseFloat(req.body && req.body.volume) || 0.35, 0), 1);
  const duck = (req.body && req.body.duck === false) ? false : true;
  if (!video_url || !audio_url) {
    return res.status(400).json({ error: 'video_url and audio_url required' });
  }
  console.log(`[${job_id}] Music job started — vol=${volume} duck=${duck}`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-mus-'));

  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'Music started' });

    const vPath = path.join(tmpDir, 'in.mp4');
    const aPath = path.join(tmpDir, 'music' + (String(audio_url).match(/\.(mp3|wav|m4a|aac|ogg)(\?|$)/i) ? RegExp.$1 : 'mp3'));
    await downloadFile(video_url, vPath);
    await downloadFile(audio_url, aPath);

    await updateJob(job_id, 'mixing');
    const outPath = path.join(tmpDir, 'out.mp4');
    await mixMusic(vPath, aPath, outPath, { volume: volume, duck: duck });

    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outPath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] Music done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] Music error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
});


// ═══════════════════════════════════════════════════════════════════════
// RESTORED 20 Oct 2026 — the 30 September regression
//
// On 30 Sep (commit c0ea6db) server.js was cut from 1273 lines to 229 and
// then rebuilt to 821 — but only 7 of the original 22 routes came back.
// Fifteen were lost silently. index.html never stopped calling six of
// them, so for three weeks every one of those POSTs hit Express's default
// 404 handler.
//
// /voice-merge is the one that hurt: it is the ffmpeg step that lays the
// Google TTS audio onto the Seedance clip. The frontend does
// `if (vmR.ok) { ... }` with NO else branch, so a 404 there produced a
// SILENT VIDEO with no error logged and nothing shown to the customer.
// Every bit of voice work done since 30 Sep was being thrown away at the
// last step.
//
// Restored verbatim from commit 3e86bfe (24 Sep), the last good version.
// CHANGED ON RESTORE: each route now carries requireAuth, matching the
// security model added to /merge, /caption, /finalize and /music after
// these were lost. That is safe because index.html's global fetch wrapper
// injects `token` into the body of every request to this host (see
// window.__paidEndpoints), so a verified user passes automatically.
//
// NOT added: requireReceipt. /caption and /music charge edit credits that
// way, and most of the editor routes below probably should too — but the
// reason-strings the frontend sends are unverified, and a wrong one would
// 402 every call. Decide that deliberately rather than guess here.
// ═══════════════════════════════════════════════════════════════════════

// ─── VOICE-MERGE (replace Seedance silent audio with Google TTS) ──────────
// Body: { video_url, audio_url, job_id }
//   video_url : silent Seedance MP4
//   audio_url : Google TTS output (WAV / MP3 / M4A)
// Replaces the video's audio track entirely with the TTS voice.
// -shortest trims audio to video length so nothing hangs.
// Status via /status/:job_id.
app.post('/voice-merge', requireAuth, async (req, res) => {
  const { video_url, audio_url, job_id } = req.body || {};
  if (!video_url || !audio_url) {
    return res.status(400).json({ error: 'video_url and audio_url required' });
  }
  console.log(`[${job_id}] voice-merge started`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-vm-'));

  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'voice-merge started' });

    const vPath = path.join(tmpDir, 'video.mp4');
    const aExt = String(audio_url).match(/\.(mp3|wav|m4a|aac|ogg)(\?|$)/i) ? RegExp.$1 : 'mp3';
    const aPath = path.join(tmpDir, 'audio.' + aExt);
    await downloadFile(video_url, vPath);
    await downloadFile(audio_url, aPath);

    await updateJob(job_id, 'merging');
    const outPath = path.join(tmpDir, 'out.mp4');

    // ── NOTHING GETS CUT (21 Oct 2026) ─────────────────────────────────
    // The old command used a bare -shortest, which truncates whichever
    // stream ends first — and it was wrong in BOTH directions:
    //
    //   voice LONGER than video  -> the voiceover was cut off mid-sentence
    //   voice SHORTER than video -> the VIDEO was cut to the audio length,
    //                               so a customer paying for 15s got 9s
    //
    // Neither is acceptable, and neither needs to happen: both are fixable
    // here in ffmpeg, on our own box, at no extra cost and with no extra
    // generation seconds charged to anyone.
    //
    //   voice longer  -> LOOP the video to cover the audio. Looping (rather
    //                    than freezing the last frame) keeps the mouth
    //                    MOVING for the whole voiceover, which is the entire
    //                    point of the free lip-sync effect. A frozen face
    //                    with a voice still talking is the worst option.
    //   voice shorter -> keep the full video and pad the audio with silence.
    //
    // Output length is therefore always max(video, audio). If probing fails
    // we fall back to the original single-pass behaviour rather than risk
    // producing nothing.
    const _vInfo = await probeClip(vPath);
    const _aInfo = await probeClip(aPath);
    const _vDur = _vInfo.duration || 0;
    const _aDur = _aInfo.duration || 0;
    console.log(`[${job_id}] voice-merge: video ${_vDur.toFixed(2)}s, audio ${_aDur.toFixed(2)}s`);

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg();
      let outOpts;

      // How to cover a voiceover LONGER than the video depends on what the
      // video is. Seedance's single-clip ceiling is 15s, so:
      //
      //   <= 15s  -> ONE generated clip. Looping it reads as a short motion
      //              loop and keeps the mouth moving, which is the point.
      //   >  15s  -> a MERGED seamless sequence with a beginning and an end.
      //              Replaying its opening to cover extra speech looks
      //              obviously broken, so hold the final frame instead.
      //
      // Either way the voice is spoken in full and the video never shortens.
      const LOOPABLE_MAX = 15.5;

      if (_vDur && _aDur && _aDur > _vDur + 0.15 && _vDur <= LOOPABLE_MAX) {
        // SHORT CLIP, VOICE LONGER — loop it. Looping needs a re-encode;
        // -c:v copy with -stream_loop produces broken timestamps.
        cmd.input(vPath).inputOptions(['-stream_loop', '-1']);
        cmd.input(aPath);
        outOpts = [
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
          '-t', String(_aDur.toFixed(3)),   // stop exactly at the end of the voice
          '-movflags', '+faststart'
        ];
        console.log(`[${job_id}] voice-merge: looping ${_vDur.toFixed(2)}s clip to cover ${_aDur.toFixed(2)}s of speech`);
      } else if (_vDur && _aDur && _aDur > _vDur + 0.15) {
        // LONG SEQUENCE, VOICE LONGER — hold the last frame rather than
        // replaying the opening. The mouth stops moving for the overhang,
        // which is a smaller price than a visible restart mid-narration.
        const _pad = (_aDur - _vDur).toFixed(3);
        cmd.input(vPath);
        cmd.input(aPath);
        outOpts = [
          '-map', '0:v', '-map', '1:a',
          '-vf', 'tpad=stop_mode=clone:stop_duration=' + _pad,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
          '-t', String(_aDur.toFixed(3)),
          '-movflags', '+faststart'
        ];
        console.log(`[${job_id}] voice-merge: holding final frame ${_pad}s to cover ${_aDur.toFixed(2)}s of speech`);
      } else if (_vDur && _aDur) {
        // VOICE SHORTER (or equal) — keep every frame the customer paid for
        // and pad the audio out with silence.
        cmd.input(vPath);
        cmd.input(aPath);
        outOpts = [
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy',                  // no re-encode — fast + lossless
          '-af', 'apad',                   // silence after the voice ends
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
          '-t', String(_vDur.toFixed(3)),  // full video length, never shorter
          '-movflags', '+faststart'
        ];
      } else {
        // Probe failed — original behaviour, so a merge still happens.
        cmd.input(vPath);
        cmd.input(aPath);
        outOpts = [
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy',
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
          '-shortest',
          '-movflags', '+faststart'
        ];
        console.warn(`[${job_id}] voice-merge: probe failed, using -shortest fallback`);
      }

      cmd.outputOptions(outOpts)
        .output(outPath)
        .on('end', resolve)
        .on('error', (err) => reject(new Error('voice-merge ffmpeg error: ' + err.message)))
        .run();
    });

    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outPath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] voice-merge done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] voice-merge error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ── /lip-sync DELIBERATELY NOT RESTORED (20 Oct 2026) ──────────────────
// The 24 Sep version of this route called REPLICATE Wav2Lip, which bills
// per prediction. Elite's instruction, 20 Oct: "we don't use Wav2Lip, make
// sure of it -- that is just for customers paying by credit, I don't want
// to pay for it."
//
// So it is removed on purpose, NOT lost. To bring it back, take it from
// commit 3e86bfe -- but note it needs REPLICATE_API_TOKEN and
// REPLICATE_WAV2LIP_MODEL and costs money on every call.
//
// The product's two REAL lip-syncs are both on Netlify and unaffected:
//   /.netlify/functions/sync-lipsync      -> Lip Sync tool  (video + audio)
//   /.netlify/functions/infinitetalk-proxy -> Talking Avatar (photo + audio)
// Both are customer-paid via edit credits. Neither touches this service.
//
// index.html still references MERGE_SERVICE_URL + '/lip-sync' behind
// window.TAH_LIPSYNC, which defaults to FALSE. With this route absent that
// call is never made; if the flag were ever switched on it would 404 and be
// swallowed by the frontend's own error handling. No charge either way.
// ───────────────────────────────────────────────────────────────────────


// ─── TRIM ────────────────────────────────────────────────────
app.post('/trim', requireAuth, (req, res) => runVideoJob(req, res, 'trim', async (inPath, outPath, b) => {
  const start = Math.max(0, parseFloat(b.start) || 0);
  const end = parseFloat(b.end) || 0;
  const dur = Math.max(0.1, end - start);
  await new Promise((resolve, reject) => {
    ffmpeg().input(inPath).setStartTime(start).duration(dur)
      .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-preset veryfast', '-crf 20', '-c:a aac', '-b:a 192k', '-movflags +faststart'])
      .output(outPath).on('end', resolve)
      .on('error', (e) => reject(new Error('trim ffmpeg error: ' + e.message))).run();
  });
}));

// ─── SPEED ───────────────────────────────────────────────────
app.post('/speed', requireAuth, (req, res) => runVideoJob(req, res, 'speed', async (inPath, outPath, b) => {
  let rate = parseFloat(b.rate) || 1;
  rate = Math.min(Math.max(rate, 0.25), 4);
  const probe = await probeClip(inPath);
  const vpts = (1 / rate).toFixed(5);
  function atempoChain(r) {
    const parts = []; let x = r;
    while (x > 2.0) { parts.push('atempo=2.0'); x /= 2.0; }
    while (x < 0.5) { parts.push('atempo=0.5'); x /= 0.5; }
    parts.push('atempo=' + x.toFixed(5));
    return parts.join(',');
  }
  if (probe.hasAudio) {
    await runFF(inPath, outPath, {
      complex: `[0:v]setpts=${vpts}*PTS[v];[0:a]${atempoChain(rate)}[a]`,
      maps: ['v', 'a'], audio: 'encode', tag: 'speed'
    });
  } else {
    await runFF(inPath, outPath, { vf: `setpts=${vpts}*PTS`, audio: 'drop', tag: 'speed' });
  }
}));

// ─── VOLUME ──────────────────────────────────────────────────
app.post('/volume', requireAuth, (req, res) => runVideoJob(req, res, 'volume', async (inPath, outPath, b) => {
  const vol = Math.min(Math.max(parseFloat(b.volume), 0), 3);
  const probe = await probeClip(inPath);
  if (!probe.hasAudio) { await runFF(inPath, outPath, { audio: 'drop', tag: 'volume' }); return; }
  await runFF(inPath, outPath, { af: 'volume=' + (isNaN(vol) ? 1 : vol), tag: 'volume' });
}));

// ─── FILTER ──────────────────────────────────────────────────
app.post('/filter', requireAuth, (req, res) => runVideoJob(req, res, 'filter', async (inPath, outPath, b) => {
  const p = String(b.preset || '').toLowerCase();
  const map = {
    vivid:  'eq=saturation=1.45:contrast=1.12:brightness=0.02',
    warm:   "curves=r='0/0.06 1/1':b='0/0 1/0.94',eq=saturation=1.1",
    cool:   "curves=b='0/0.06 1/1':r='0/0 1/0.94',eq=saturation=1.05",
    cinema: "eq=contrast=1.12:saturation=0.92,curves=r='0/0.03 0.5/0.5 1/0.97':b='0/0.04 0.5/0.5 1/0.95'",
    bw:     'hue=s=0,eq=contrast=1.1',
    bright: 'eq=brightness=0.09:saturation=1.06:contrast=1.03'
  };
  const vf = map[p] || map.vivid;
  await runFF(inPath, outPath, { vf, tag: 'filter' });
}));

// ─── EFFECT ──────────────────────────────────────────────────
app.post('/effect', requireAuth, (req, res) => runVideoJob(req, res, 'effect', async (inPath, outPath, b) => {
  const e = String(b.effect || '').toLowerCase();
  const bloom = (sigma, op, pre) =>
    ({ complex: `[0:v]${pre || 'null'}[base];[base]split[a][b];[b]gblur=sigma=${sigma}[bl];[a][bl]blend=all_mode=screen:all_opacity=${op}[v]`, maps: ['v'] });
  let opts;
  switch (e) {
    case 'glow':      opts = bloom(9, 0.35, 'eq=brightness=0.03:saturation=1.05'); break;
    case 'warm_glow': opts = bloom(9, 0.35, "curves=r='0/0.06 1/1':b='0/0 1/0.94',eq=saturation=1.08"); break;
    case 'dream':     opts = bloom(4, 0.45, 'eq=saturation=1.1:brightness=0.03'); break;
    case 'sparkle':   opts = bloom(6, 0.3,  'eq=brightness=0.05:saturation=1.15:contrast=1.05'); break;
    case 'vhs':       opts = { vf: "noise=c0s=26:allf=t,eq=saturation=1.25:contrast=1.05,curves=r='0/0.03 1/1'" }; break;
    case 'vignette':  opts = { vf: 'vignette=PI/4' }; break;
    default:          opts = bloom(9, 0.35, 'eq=brightness=0.03:saturation=1.05');
  }
  opts.tag = 'effect';
  await runFF(inPath, outPath, opts);
}));

// ─── REFRAME ─────────────────────────────────────────────────
app.post('/reframe', requireAuth, (req, res) => runVideoJob(req, res, 'reframe', async (inPath, outPath, b) => {
  const dims = aspectDims(b.aspect);
  const vf = `scale=${dims.w}:${dims.h}:force_original_aspect_ratio=decrease,` +
             `pad=${dims.w}:${dims.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
  await runFF(inPath, outPath, { vf, tag: 'reframe' });
}));

// ─── FADE ────────────────────────────────────────────────────
app.post('/fade', requireAuth, (req, res) => runVideoJob(req, res, 'fade', async (inPath, outPath, b) => {
  const f = Math.min(Math.max(parseFloat(b.fade) || 1, 0.2), 5);
  const probe = await probeClip(inPath);
  const dur = probe.duration || 0;
  const outSt = Math.max(0, dur - f).toFixed(2);
  const vf = `fade=t=in:st=0:d=${f},fade=t=out:st=${outSt}:d=${f}`;
  if (probe.hasAudio && dur) {
    await runFF(inPath, outPath, {
      complex: `[0:v]${vf}[v];[0:a]afade=t=in:st=0:d=${f},afade=t=out:st=${outSt}:d=${f}[a]`,
      maps: ['v', 'a'], audio: 'encode', tag: 'fade'
    });
  } else {
    await runFF(inPath, outPath, { vf, audio: probe.hasAudio ? 'copy' : 'drop', tag: 'fade' });
  }
}));

// ─── TEXT ────────────────────────────────────────────────────
app.post('/text', requireAuth, (req, res) => runVideoJob(req, res, 'text', async (inPath, outPath, b, tmpDir) => {
  const text = String(b.text || '').trim();
  if (!text) throw new Error('text required');
  const probe = await probeClip(inPath);
  const dur = probe.duration || 5;
  const assPath = path.join(tmpDir, 'text.ass');
  fs.writeFileSync(assPath, buildTitleAss(text, {
    pos: b.pos || 'bottom', lang: b.lang || '', dur: dur,
    rtl: /^(fa|ar|ur)$/i.test(String(b.lang || ''))
  }));
  await burnSubtitles(inPath, assPath, outPath, tmpDir);
}));

// ─── STICKER ─────────────────────────────────────────────────
app.post('/sticker', requireAuth, (req, res) => runVideoJob(req, res, 'sticker', async (inPath, outPath, b, tmpDir) => {
  const emoji = String(b.emoji || '🔥');
  const size = Math.min(Math.max(parseInt(b.size, 10) || 160, 40), 400);
  const pos = String(b.pos || 'br');
  const M = 40;
  const posMap = {
    br: `x=w-tw-${M}:y=h-th-${M}`, bl: `x=${M}:y=h-th-${M}`,
    tr: `x=w-tw-${M}:y=${M}`,       tl: `x=${M}:y=${M}`,
    center: 'x=(w-tw)/2:y=(h-th)/2'
  };
  const xy = posMap[pos] || posMap.br;
  const fontFile = process.env.EMOJI_FONT || '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf';
  const txtPath = path.join(tmpDir, 'sticker.txt');
  fs.writeFileSync(txtPath, emoji, 'utf8');
  const esc = txtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const fesc = fontFile.replace(/\\/g, '/').replace(/:/g, '\\:');
  const vf = `drawtext=fontfile='${fesc}':textfile='${esc}':fontsize=${size}:${xy}`;
  await runFF(inPath, outPath, { vf, tag: 'sticker' });
}));

// ─── FREEZE ──────────────────────────────────────────────────
app.post('/freeze', requireAuth, (req, res) => runVideoJob(req, res, 'freeze', async (inPath, outPath, b, tmpDir) => {
  const at = Math.max(0, parseFloat(b.at) || 0);
  const hold = Math.min(Math.max(parseFloat(b.hold) || 1.5, 0.3), 10);
  await freezeFrame(inPath, outPath, at, hold, tmpDir);
}));

// ─── PHOTO-VIDEO ─────────────────────────────────────────────
app.post('/photo-video', requireAuth, async (req, res) => {
  const b = req.body || {};
  const images = b.images;
  const job_id = b.job_id;
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images[] required' });
  }
  console.log(`[${job_id}] photo-video — ${images.length} images`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-p2v-'));
  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'photo-video started' });
    const dims = aspectDims(b.aspect);
    const per = Math.min(Math.max(parseFloat(b.perImage) || 3, 1.5), 8);
    const clips = [];
    for (let i = 0; i < images.length && i < 9; i++) {
      const img = path.join(tmpDir, `img_${i}` + (String(images[i]).match(/\.(png|webp|jpe?g)(\?|$)/i) ? '.' + RegExp.$1 : '.jpg'));
      await downloadFile(images[i], img);
      const clip = path.join(tmpDir, `clip_${i}.mp4`);
      await kenBurnsClip(img, clip, per, dims, i);
      clips.push(clip);
    }
    await updateJob(job_id, 'building');
    const outPath = path.join(tmpDir, 'out.mp4');
    if (clips.length === 1) {
      fs.copyFileSync(clips[0], outPath);
    } else if (String(b.transition) === 'fade') {
      try { await mergeVideosSmooth(clips, outPath); }
      catch (e) {
        const listFile = path.join(tmpDir, 'list.txt');
        fs.writeFileSync(listFile, clips.map(f => `file '${f}'`).join('\n'));
        await mergeVideos(listFile, outPath);
      }
    } else {
      const listFile = path.join(tmpDir, 'list.txt');
      fs.writeFileSync(listFile, clips.map(f => `file '${f}'`).join('\n'));
      await mergeVideos(listFile, outPath);
    }
    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outPath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] photo-video done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] photo-video error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ─── SPLIT-SCREEN ─────────────────────────────────────────────
app.post('/split-screen', requireAuth, async (req, res) => {
  const b = req.body || {};
  const { left_url, right_url, job_id } = b;
  if (!left_url || !right_url) return res.status(400).json({ error: 'left_url and right_url required' });
  console.log(`[${job_id}] split-screen — ${b.layout || 'side'}`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-ss-'));
  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'split-screen started' });
    const lPath = path.join(tmpDir, 'left.mp4');
    const rPath = path.join(tmpDir, 'right.mp4');
    await downloadFile(left_url, lPath);
    await downloadFile(right_url, rPath);
    await updateJob(job_id, 'building');
    const outPath = path.join(tmpDir, 'out.mp4');
    await splitScreen(lPath, rPath, outPath, b.layout || 'side', b.aspect || '9:16');
    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outPath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] split-screen done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] split-screen error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ─── EXTRACT-LAST-FRAME ───────────────────────────────────────
app.post('/extract-last-frame', requireAuth, async (req, res) => {
  const b = req.body || {};
  const { video_url, job_id } = b;
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  console.log(`[${job_id}] extract-last-frame started`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-lf-'));
  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'extract-last-frame started' });
    const inPath = path.join(tmpDir, 'in.mp4');
    await downloadFile(video_url, inPath);

    const probe = await probeClip(inPath);
    const dur = probe.duration || 0;
    const at = Math.max(0, dur - 0.1);
    const framePath = path.join(tmpDir, 'lastframe.jpg');
    await new Promise((resolve, reject) => {
      ffmpeg().input(inPath).seekInput(at).frames(1)
        .outputOptions(['-q:v', '2'])
        .output(framePath)
        .on('end', resolve)
        .on('error', (e) => reject(new Error('frame extract: ' + e.message)))
        .run();
    });

    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutputImage(job_id, framePath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] extract-last-frame done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] extract-last-frame error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ─── HELPERS ─────────────────────────────────────────────────

// Mix a looping background track into a video.
//  - Loops music to fill the whole video (-stream_loop -1) then trims to length.
//  - If the video has its own audio (voice) and duck=true, the music is
//    side-chain compressed so it dips under speech, then the two are mixed.
//  - If the video has no audio, the music simply plays under it.
//  - Music tail fades out over ~1.5s.
async function mixMusic(videoPath, audioPath, outPath, opts) {
  opts = opts || {};
  const vol = (opts.volume != null) ? opts.volume : 0.35;
  const duck = opts.duck !== false;

  const vProbe = await probeClip(videoPath);
  const hasVoice = vProbe.hasAudio;
  const dur = vProbe.duration || 0;
  const fadeStart = Math.max(0, dur - 1.5);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    cmd.input(videoPath);
    cmd.input(audioPath).inputOptions(['-stream_loop -1']); // loop music

    let filter, mapAudio;
    const musicChain =
      '[1:a]volume=' + vol +
      (dur ? (',afade=t=out:st=' + fadeStart.toFixed(2) + ':d=1.5') : '') +
      '[mus]';

    if (hasVoice && duck) {
      // Duck music under the voice, then mix voice + ducked music.
      filter =
        musicChain + ';' +
        '[mus][0:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[ducked];' +
        '[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=0[aout]';
      mapAudio = '[aout]';
    } else if (hasVoice) {
      filter = musicChain + ';[0:a][mus]amix=inputs=2:duration=first:dropout_transition=0[aout]';
      mapAudio = '[aout]';
    } else {
      filter = musicChain;
      mapAudio = '[mus]';
    }

    const outOpts = [
      '-map', '0:v',
      '-map', mapAudio,
      '-c:v', 'copy',            // don't re-encode video — fast + lossless
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',               // stop at video length (music is looped/longer)
      '-movflags', '+faststart'
    ];

    cmd.complexFilter(filter)
      .outputOptions(outOpts)
      .output(outPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error('music ffmpeg error: ' + err.message)))
      .run();
  });
}

// Convert seconds -> ASS time "H:MM:SS.cs"
function assTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  const p2 = n => String(n).padStart(2, '0');
  return h + ':' + p2(m) + ':' + p2(s) + '.' + p2(cs);
}

// Pick the Noto font family that covers a language's script.
// These families are all provided by fonts-noto-core / fonts-noto-cjk
// (installed via the Dockerfile), so fontconfig resolves them.
function fontForLang(lang) {
  switch (String(lang || '').toLowerCase()) {
    case 'ar': case 'fa': case 'ur': return 'Noto Sans Arabic';
    case 'hi':                       return 'Noto Sans Devanagari';
    case 'zh':                       return 'Noto Sans CJK SC';
    default:                         return 'Noto Sans'; // Latin + Cyrillic + Greek
  }
}

// Build a styled ASS subtitle file from cues. Social look: big bold text,
// thick outline, bottom-centred. RTL-aware for fa/ar/ur.
function buildAss(cues, opts) {
  opts = opts || {};
  const st = opts.style || {};
  const fontName = st.font || fontForLang(opts.lang);
  const fontSize = st.size || 22;
  const primary  = st.primary  || '&H00FFFFFF';  // white   (AABBGGRR)
  const outline  = st.outline  || '&H00000000';  // black
  const outlineW = (st.outlineW != null) ? st.outlineW : 3;
  const shadow   = (st.shadow  != null) ? st.shadow  : 1;
  const marginV  = st.marginV || 40;
  const bold     = st.bold === false ? 0 : -1;

  const header =
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    'PlayResX: 1280\n' +
    'PlayResY: 720\n' +
    'WrapStyle: 2\n' +
    'ScaledBorderAndShadow: yes\n\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Default,' + fontName + ',' + fontSize + ',' + primary + ',&H000000FF,' + outline + ',&H64000000,' +
      bold + ',0,0,0,100,100,0,0,1,' + outlineW + ',' + shadow + ',2,40,40,' + marginV + ',1\n\n' +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

  const isRtl = !!opts.rtl;
  const lines = cues.map(function (c) {
    var text = String(c.text || '')
      .replace(/\r?\n/g, '\\N')                    // ASS line break
      .replace(/\{/g, '(').replace(/\}/g, ')');    // strip ASS override braces
    // For Arabic/Persian/Urdu: wrap the line in an explicit RTL embedding
    // (RLE … PDF) so word order and mixed numbers/Latin render correctly.
    if (isRtl) text = '\u202B' + text + '\u202C';
    return 'Dialogue: 0,' + assTime(c.start) + ',' + assTime(c.end) +
      ',Default,,0,0,0,,' + text;
  }).join('\n');

  return header + lines + '\n';
}

// Optimize a video for social platforms (TikTok / Reels / Shorts):
//  - scale/pad to a clean 1080x1920 (9:16) container
//  - H.264 High, yuv420p, BT.709 color tags (stops HDR darkening/shift)
//  - ~12 Mbps target so the platform transcoder gets a clean source
//  - light brightness + shadow lift + saturation so it survives the crush
//  - 30fps, AAC 192k, +faststart
function finalizeForSocial(inPath, outPath, opts) {
  opts = opts || {};
  const boost = opts.boost !== false;
  return new Promise((resolve, reject) => {
    // Fit any aspect into 1080x1920 without distortion, pad with black.
    let vf =
      "scale=1080:1920:force_original_aspect_ratio=decrease," +
      "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black," +
      "setsar=1,format=yuv420p";
    if (boost) {
      // eq: tiny brightness + saturation; curves: lift shadows a touch.
      vf = "scale=1080:1920:force_original_aspect_ratio=decrease," +
           "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black," +
           "eq=brightness=0.03:saturation=1.08:contrast=1.03," +
           "curves=all='0/0.03 0.5/0.52 1/1'," +
           "setsar=1,format=yuv420p";
    }
    ffmpeg()
      .input(inPath)
      .videoFilters(vf)
      .outputOptions([
        '-r', '30',
        '-c:v', 'libx264',
        '-profile:v', 'high',
        '-preset', 'medium',
        '-b:v', '12M', '-maxrate', '14M', '-bufsize', '20M',
        '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart'
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error('finalize ffmpeg error: ' + err.message)))
      .run();
  });
}

// Burn the ASS file into the video. Re-encodes video, copies audio.
// fontsdir lets us ship a font that covers Persian/Arabic/Urdu.
function burnSubtitles(inPath, assPath, outPath, workDir) {
  return new Promise((resolve, reject) => {
    // Escape the path for ffmpeg's filter graph. Fonts are resolved by
    // fontconfig from the system Noto fonts installed in the Docker image,
    // so no fontsdir is needed (optional override via FONTS_DIR).
    const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    let vf = "ass='" + escaped + "'";
    if (process.env.FONTS_DIR) {
      const fontsDir = process.env.FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:');
      vf = "ass='" + escaped + "':fontsdir='" + fontsDir + "'";
    }
    ffmpeg()
      .input(inPath)
      .videoFilters(vf)
      .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-preset veryfast', '-crf 20', '-c:a copy', '-movflags +faststart'])
      .output(outPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error('caption ffmpeg error: ' + err.message)))
      .run();
  });
}

async function downloadFile(url, dest) {
  const r = await fetch(url, { timeout: 60000 });
  if (!r.ok) throw new Error(`Download failed: ${url} — ${r.status}`);
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    r.body.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function mergeVideos(listFile, outputFile) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy', '-movflags +faststart'])
      .output(outputFile)
      .on('end', resolve)
      .on('error', (err) => reject(new Error('ffmpeg error: ' + err.message)))
      .run();
  });
}

// Smooth merge: crossfade (dissolve) ~0.75s between clips so the joins
// aren't hard cuts. Re-encodes (xfade can't stream-copy). Falls back to
// plain concat upstream if this throws.
async function mergeVideosSmooth(files, outputFile) {
  const T = 0.75; // crossfade duration (seconds)
  if (!files || files.length < 2) throw new Error('need >= 2 clips');

  // Need real durations to place each crossfade
  const probes = [];
  for (const f of files) probes.push(await probeClip(f));
  const durs = probes.map((p) => p.duration);
  if (durs.some((d) => !d || d <= T + 0.2)) throw new Error('clip durations unusable for crossfade');
  const allAudio = probes.every((p) => p.hasAudio);

  // Video: chain xfade transitions. offset = running merged length - T.
  const filters = [];
  let acc = durs[0];
  let prevV = '0:v';
  for (let i = 1; i < files.length; i++) {
    const offset = (acc - T).toFixed(3);
    const out = (i === files.length - 1) ? 'vout' : ('v' + i);
    filters.push(`[${prevV}][${i}:v]xfade=transition=fade:duration=${T}:offset=${offset}[${out}]`);
    acc = acc + durs[i] - T;
    prevV = out;
  }

  // Audio: acrossfade chain, only if every clip actually has audio
  const maps = ['vout'];
  if (allAudio) {
    let prevA = '0:a';
    for (let i = 1; i < files.length; i++) {
      const outA = (i === files.length - 1) ? 'aout' : ('a' + i);
      filters.push(`[${prevA}][${i}:a]acrossfade=d=${T}[${outA}]`);
      prevA = outA;
    }
    maps.push('aout');
  }

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    files.forEach((f) => cmd.input(f));
    const outOpts = ['-c:v libx264', '-pix_fmt yuv420p', '-preset veryfast', '-crf 20', '-movflags +faststart'];
    if (allAudio) { outOpts.push('-c:a aac', '-b:a 128k'); } else { outOpts.push('-an'); }
    cmd.complexFilter(filters, maps)
      .outputOptions(outOpts)
      .output(outputFile)
      .on('end', resolve)
      .on('error', (err) => reject(new Error('xfade ffmpeg error: ' + err.message)))
      .run();
  });
}

// Probe a clip for duration + whether it carries an audio track
function probeClip(file) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err || !data) return resolve({ duration: 0, hasAudio: false });
      const duration = data.format && data.format.duration ? parseFloat(data.format.duration) : 0;
      const hasAudio = (data.streams || []).some((s) => s.codec_type === 'audio');
      resolve({ duration: duration || 0, hasAudio });
    });
  });
}

// ── helpers restored alongside the 30 Sep routes (commit 3e86bfe) ──
function runFF(inPath, outPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(inPath);
    const out = [
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
      '-movflags', '+faststart'
    ];
    if (opts.complex) {
      cmd.complexFilter(opts.complex, opts.maps || undefined);
    } else if (opts.vf) {
      cmd.videoFilters(opts.vf);
    }
    if (opts.audio === 'drop') { out.push('-an'); }
    else if (opts.af) { cmd.audioFilters(opts.af); out.push('-c:a', 'aac', '-b:a', '192k'); }
    else if (opts.audio === 'encode') { out.push('-c:a', 'aac', '-b:a', '192k'); }
    else { out.push('-c:a', 'copy'); }
    if (opts.extraOut) opts.extraOut.forEach(o => out.push(o));
    cmd.outputOptions(out)
      .output(outPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(opts.tag ? (opts.tag + ' ffmpeg error: ' + err.message) : err.message)))
      .run();
  });
}

async function runVideoJob(req, res, tag, runner) {
  const body = req.body || {};
  const { video_url, job_id } = body;
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  console.log(`[${job_id}] ${tag} job started`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-' + tag + '-'));
  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: tag + ' started' });
    const inPath = path.join(tmpDir, 'in.mp4');
    await downloadFile(video_url, inPath);
    await updateJob(job_id, tag);
    const outPath = path.join(tmpDir, 'out.mp4');
    await runner(inPath, outPath, body, tmpDir);
    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outPath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] ${tag} done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] ${tag} error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

function aspectDims(aspect) {
  switch (String(aspect || '9:16')) {
    case '1:1':  return { w: 1080, h: 1080 };
    case '16:9': return { w: 1920, h: 1080 };
    case '9:16':
    default:     return { w: 1080, h: 1920 };
  }
}

function buildTitleAss(text, opts) {
  opts = opts || {};
  const dur = Math.max(0.5, opts.dur || 5);
  const align = opts.pos === 'top' ? 8 : (opts.pos === 'center' ? 5 : 2);
  const marginV = opts.pos === 'center' ? 0 : 70;
  const fontName = fontForLang(opts.lang);
  let t = String(text).replace(/\r?\n/g, '\\N').replace(/\{/g, '(').replace(/\}/g, ')');
  if (opts.rtl) t = '\u202B' + t + '\u202C';
  const header =
    '[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Default,' + fontName + ',30,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,' +
      align + ',40,40,' + marginV + ',1\n\n' +
    '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  return header + 'Dialogue: 0,' + assTime(0) + ',' + assTime(dur) + ',Default,,0,0,0,,' + t + '\n';
}

async function freezeFrame(inPath, outPath, at, hold, tmpDir) {
  const probe = await probeClip(inPath);
  const dur = probe.duration || 0;
  const hasA = probe.hasAudio;
  const enc = ['-c:v libx264', '-pix_fmt yuv420p', '-preset veryfast', '-crf 20', '-r 30'];
  const encA = hasA ? ['-c:a aac', '-b:a 192k', '-ar 48000'] : ['-an'];
  const atC = Math.min(Math.max(at, 0), Math.max(0, dur - 0.05));

  function seg(start, len, out) {
    return new Promise((resolve, reject) => {
      const c = ffmpeg().input(inPath).setStartTime(start);
      if (len) c.duration(len);
      c.outputOptions(enc.concat(encA)).output(out)
        .on('end', resolve).on('error', e => reject(new Error('freeze seg: ' + e.message))).run();
    });
  }
  function still(out) {
    return new Promise((resolve, reject) => {
      const framePng = path.join(tmpDir, 'frame.png');
      ffmpeg().input(inPath).seekInput(atC).frames(1).output(framePng)
        .on('end', () => {
          const c = ffmpeg().input(framePng).loop(hold).inputOptions(['-framerate 30']);
          if (hasA) c.input('anullsrc=channel_layout=stereo:sample_rate=48000').inputOptions(['-f lavfi']);
          const oo = ['-t ' + hold, '-c:v libx264', '-pix_fmt yuv420p', '-preset veryfast', '-crf 20', '-r 30', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];
          if (hasA) { oo.push('-c:a aac', '-b:a 192k', '-ar 48000', '-shortest'); } else { oo.push('-an'); }
          c.outputOptions(oo).output(out)
            .on('end', resolve).on('error', e => reject(new Error('freeze still: ' + e.message))).run();
        })
        .on('error', e => reject(new Error('freeze frame extract: ' + e.message))).run();
    });
  }

  const p1 = path.join(tmpDir, 'p1.mp4');
  const p2 = path.join(tmpDir, 'p2.mp4');
  const st = path.join(tmpDir, 'still.mp4');
  const parts = [];
  if (atC > 0.15) { await seg(0, atC, p1); parts.push(p1); }
  await still(st); parts.push(st);
  if (dur - atC > 0.15) { await seg(atC, null, p2); parts.push(p2); }

  const listFile = path.join(tmpDir, 'flist.txt');
  fs.writeFileSync(listFile, parts.map(f => `file '${f}'`).join('\n'));
  await mergeVideos(listFile, outPath);
}

function kenBurnsClip(imgPath, outPath, sec, dims, idx) {
  const fps = 30;
  const frames = Math.round(sec * fps);
  const zoomIn = (idx % 2 === 0);
  const z = zoomIn
    ? `z='min(zoom+0.0012,1.2)'`
    : `z='if(eq(on,1),1.2,max(zoom-0.0012,1.0))'`;
  const vf =
    `scale=${dims.w * 2}:${dims.h * 2}:force_original_aspect_ratio=increase,` +
    `crop=${dims.w * 2}:${dims.h * 2},` +
    `zoompan=${z}:d=${frames}:s=${dims.w}x${dims.h}:fps=${fps}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',` +
    `setsar=1,format=yuv420p`;
  return new Promise((resolve, reject) => {
    ffmpeg().input(imgPath).loop(sec).inputOptions(['-framerate ' + fps])
      .videoFilters(vf)
      .outputOptions(['-t ' + sec, '-c:v libx264', '-pix_fmt yuv420p', '-preset veryfast', '-crf 20', '-r ' + fps, '-an'])
      .output(outPath)
      .on('end', resolve)
      .on('error', e => reject(new Error('kenburns ffmpeg error: ' + e.message)))
      .run();
  });
}

async function splitScreen(leftPath, rightPath, outPath, layout, aspect) {
  const dims = aspectDims(aspect);
  const side = String(layout) !== 'stack';
  const paneW = side ? Math.floor(dims.w / 2) : dims.w;
  const paneH = side ? dims.h : Math.floor(dims.h / 2);
  const [pl, pr] = await Promise.all([probeClip(leftPath), probeClip(rightPath)]);
  const bothAudio = pl.hasAudio && pr.hasAudio;
  const anyAudio = pl.hasAudio || pr.hasAudio;
  const fit = (i) =>
    `[${i}:v]scale=${paneW}:${paneH}:force_original_aspect_ratio=increase,crop=${paneW}:${paneH},setsar=1[v${i}]`;
  const stackFilter = side ? `[v0][v1]hstack=inputs=2[v]` : `[v0][v1]vstack=inputs=2[v]`;
  let filters = [fit(0), fit(1), stackFilter];
  const maps = ['v'];
  let audio = 'drop';
  if (bothAudio) {
    filters.push('[0:a][1:a]amix=inputs=2:duration=shortest:dropout_transition=0[a]');
    maps.push('a'); audio = 'amix';
  } else if (anyAudio) {
    const ai = pl.hasAudio ? 0 : 1;
    maps.push(ai + ':a'); audio = 'single';
  }
  await new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(leftPath).input(rightPath);
    const out = ['-c:v libx264', '-pix_fmt yuv420p', '-preset veryfast', '-crf 20', '-shortest', '-movflags +faststart'];
    if (audio === 'drop') out.push('-an'); else out.push('-c:a aac', '-b:a 192k');
    cmd.complexFilter(filters, maps).outputOptions(out).output(outPath)
      .on('end', resolve)
      .on('error', e => reject(new Error('split-screen ffmpeg error: ' + e.message)))
      .run();
  });
}

async function uploadOutputImage(job_id, filePath) {
  if (r2Ready()) return uploadToR2(job_id, filePath, { ext: 'jpg', contentType: 'image/jpeg' });
  if (!supabase) throw new Error('No output storage configured.');
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = `merged/${job_id}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from(MERGE_BUCKET).upload(fileName, fileBuffer, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error('Supabase image upload failed: ' + error.message);
  const { data } = supabase.storage.from(MERGE_BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

// ─── OUTPUT STORAGE ──────────────────────────────────────────
// Prefer Cloudflare R2 (the rest of the stack uses R2). Falls back to
// Supabase Storage only if R2 isn't configured.
const R2_ACCOUNT   = process.env.CF_ACCOUNT_ID || '';
const R2_BUCKET    = process.env.R2_BUCKET || 'tahamtan-videos';
const R2_KEY_ID    = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET    = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_PUBLIC    = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
const R2_HOST      = R2_ACCOUNT ? `${R2_ACCOUNT}.r2.cloudflarestorage.com` : '';

function r2Ready() { return !!(R2_ACCOUNT && R2_KEY_ID && R2_SECRET && R2_PUBLIC); }

function r2sha256hex(d){ return require('crypto').createHash('sha256').update(d).digest('hex'); }
function r2hmac(k, d){ return require('crypto').createHmac('sha256', k).update(d).digest(); }

// SigV4-signed PUT to R2 (path-style). Returns the public URL.
async function uploadToR2(job_id, filePath) {
  const crypto = require('crypto');
  const body = fs.readFileSync(filePath);
  const key = `merged/${job_id}-${Date.now()}.mp4`;
  const now = new Date();
  const amzdate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  const datestamp = amzdate.slice(0, 8);
  const region = 'auto', service = 's3';
  const scope = `${datestamp}/${region}/${service}/aws4_request`;
  const canonicalUri = '/' + R2_BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
  const payloadHash = r2sha256hex(body);
  const canonicalHeaders =
    `host:${R2_HOST}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzdate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, r2sha256hex(canonicalRequest)].join('\n');
  const kDate = r2hmac('AWS4' + R2_SECRET, datestamp);
  const kRegion = r2hmac(kDate, region);
  const kService = r2hmac(kRegion, service);
  const kSigning = r2hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${R2_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${R2_HOST}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      'Authorization': authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzdate,
      'Content-Type': 'video/mp4',
      'Content-Length': body.length,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('R2 upload failed ' + res.status + ' ' + t.slice(0, 200));
  }
  return `${R2_PUBLIC}/${key}`;
}

// Unified output upload: R2 first, Supabase fallback.
async function uploadOutput(job_id, filePath) {
  if (r2Ready()) return uploadToR2(job_id, filePath);
  return uploadToSupabase(job_id, filePath);
}

async function uploadToSupabase(job_id, filePath) {
  if (!supabase) {
    console.warn('No storage configured — set R2_* env vars on Railway.');
    throw new Error('No output storage configured (set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID, R2_PUBLIC_URL).');
  }
  const fileBuffer = fs.readFileSync(filePath);
  const fileName   = `merged/${job_id}-${Date.now()}.mp4`;

  const { error } = await supabase.storage
    .from(MERGE_BUCKET)
    .upload(fileName, fileBuffer, { contentType: 'video/mp4', upsert: true });

  if (error) throw new Error('Supabase upload failed: ' + error.message);

  const { data } = supabase.storage.from(MERGE_BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

async function updateJob(job_id, status, video_url = null, error = null) {
  // In-memory first — this is what the browser polls via /status/:job_id.
  setJob(job_id, { status, url: video_url || (jobs[job_id] && jobs[job_id].url) || null, error });

  if (!supabase || !job_id) return;
  try {
    // UPSERT (not update): the browser's anon insert may have been blocked by
    // RLS, so the row might not exist yet. Upsert guarantees the write lands.
    const row = { id: job_id, status, updated_at: new Date().toISOString() };
    if (video_url) row.video_url = video_url;
    if (error)     row.error     = error;
    await supabase.from('merge_jobs').upsert(row, { onConflict: 'id' });
  } catch(e) {
    console.warn('Supabase update skipped:', e.message);
  }
}

// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TAHAMTAN merge service running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
