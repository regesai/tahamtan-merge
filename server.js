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
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

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
app.post('/merge', async (req, res) => {
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
app.post('/caption', async (req, res) => {
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

// ─── SPEED (slow-mo / fast, 0.25x–4x) ───────────────────────
app.post('/speed', async (req, res) => {
  const { video_url, job_id } = req.body || {};
  const rate = Math.min(Math.max(parseFloat(req.body && req.body.rate) || 1, 0.25), 4);
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-spd-'));
  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(video_url, inP);
    await updateJob(job_id, 'processing');
    await changeSpeed(inP, outP, rate);
    await updateJob(job_id, 'uploading');
    await updateJob(job_id, 'done', await uploadOutput(job_id, outP));
  } catch (e) { await updateJob(job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── SPLIT (keep one part, or remove a middle section) ──────
// mode 'keep': output [start,end].  mode 'remove': output everything EXCEPT [start,end].
app.post('/split', async (req, res) => {
  const { video_url, job_id } = req.body || {};
  const mode = (req.body && req.body.mode) === 'remove' ? 'remove' : 'keep';
  const start = Math.max(0, parseFloat(req.body && req.body.start) || 0);
  const end = parseFloat(req.body && req.body.end);
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  if (!(end > start)) return res.status(400).json({ error: 'end must be greater than start' });
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-spl-'));
  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(video_url, inP);
    await updateJob(job_id, 'processing');
    if (mode === 'keep') { await trimClip(inP, outP, start, end); }
    else { await removeSection(inP, outP, start, end, tmpDir); }
    await updateJob(job_id, 'uploading');
    await updateJob(job_id, 'done', await uploadOutput(job_id, outP));
  } catch (e) { await updateJob(job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── STICKER / EMOJI overlay (burn a large emoji at a position) ──
// Body: { video_url, job_id, emoji, pos?('tl'|'tr'|'bl'|'br'|'center'), size? }
app.post('/sticker', async (req, res) => {
  const b = req.body || {};
  if (!b.video_url) return res.status(400).json({ error: 'video_url required' });
  if (!b.emoji) return res.status(400).json({ error: 'emoji required' });
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-stk-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(b.video_url, inP);
    await updateJob(b.job_id, 'processing');
    await burnSticker(inP, outP, tmpDir, b);
    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, outP));
  } catch (e) { await updateJob(b.job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── VOLUME (adjust original audio volume, 0–2x; 0 = mute) ──────
app.post('/volume', async (req, res) => {
  const b = req.body || {};
  const vol = Math.min(Math.max(parseFloat(b.volume), 0), 2);
  if (!b.video_url) return res.status(400).json({ error: 'video_url required' });
  if (isNaN(vol)) return res.status(400).json({ error: 'volume required (0–2)' });
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-vol-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(b.video_url, inP);
    await updateJob(b.job_id, 'processing');
    await setVolume(inP, outP, vol);
    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, outP));
  } catch (e) { await updateJob(b.job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── TEXT overlay (burn a title on screen) ──────────────────
// Body: { video_url, job_id, text, pos?('top'|'center'|'bottom'), lang?, start?, end? }
app.post('/text', async (req, res) => {
  const b = req.body || {};
  if (!b.video_url) return res.status(400).json({ error: 'video_url required' });
  if (!b.text) return res.status(400).json({ error: 'text required' });
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-txt-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(b.video_url, inP);
    await updateJob(b.job_id, 'processing');
    await burnText(inP, outP, tmpDir, b);
    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, outP));
  } catch (e) { await updateJob(b.job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── FILTER / colour grade (preset or manual) ───────────────
// Body: { video_url, job_id, preset?, brightness?, contrast?, saturation? }
app.post('/filter', async (req, res) => {
  const b = req.body || {};
  if (!b.video_url) return res.status(400).json({ error: 'video_url required' });
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-flt-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(b.video_url, inP);
    await updateJob(b.job_id, 'processing');
    await applyFilter(inP, outP, b);
    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, outP));
  } catch (e) { await updateJob(b.job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── REFRAME (aspect ratio: 9:16, 1:1, 16:9) ────────────────
app.post('/reframe', async (req, res) => {
  const b = req.body || {};
  const ar = ['9:16', '1:1', '16:9'].includes(b.aspect) ? b.aspect : '9:16';
  if (!b.video_url) return res.status(400).json({ error: 'video_url required' });
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-rfr-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(b.video_url, inP);
    await updateJob(b.job_id, 'processing');
    await reframe(inP, outP, ar);
    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, outP));
  } catch (e) { await updateJob(b.job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── FADE (fade in + fade out, video + audio) ───────────────
app.post('/fade', async (req, res) => {
  const b = req.body || {};
  const dur = Math.min(Math.max(parseFloat(b.fade) || 1, 0.2), 3);
  if (!b.video_url) return res.status(400).json({ error: 'video_url required' });
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-fad-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(b.video_url, inP);
    await updateJob(b.job_id, 'processing');
    await addFade(inP, outP, dur);
    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, outP));
  } catch (e) { await updateJob(b.job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── FREEZE (hold a frame for N seconds at time T) ──────────
app.post('/freeze', async (req, res) => {
  const b = req.body || {};
  const at = Math.max(0, parseFloat(b.at) || 0);
  const hold = Math.min(Math.max(parseFloat(b.hold) || 1.5, 0.3), 5);
  if (!b.video_url) return res.status(400).json({ error: 'video_url required' });
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-frz-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(b.video_url, inP);
    await updateJob(b.job_id, 'processing');
    await freezeFrame(inP, outP, at, hold, tmpDir);
    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, outP));
  } catch (e) { await updateJob(b.job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── SPLIT-SCREEN / BEFORE-AFTER (two videos side by side or stacked) ──
// Body: { left_url, right_url, job_id, layout?('side'|'stack'), aspect?('9:16'|'1:1'|'16:9') }
app.post('/split-screen', async (req, res) => {
  const b = req.body || {};
  if (!b.left_url || !b.right_url) return res.status(400).json({ error: 'left_url and right_url required' });
  const layout = b.layout === 'stack' ? 'stack' : 'side';
  const aspect = ['9:16', '1:1', '16:9'].includes(b.aspect) ? b.aspect : '9:16';
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ss-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });
    const lp = path.join(tmpDir, 'l.mp4'), rp = path.join(tmpDir, 'r.mp4'), out = path.join(tmpDir, 'out.mp4');
    await downloadFile(b.left_url, lp);
    await downloadFile(b.right_url, rp);
    await updateJob(b.job_id, 'processing');
    await splitScreen(lp, rp, out, layout, aspect);
    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, out));
  } catch (e) { await updateJob(b.job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── EFFECTS / overlays (glow, sparkle, vignette, vhs, etc.) ──
// Body: { video_url, job_id, effect }
app.post('/effect', async (req, res) => {
  const b = req.body || {};
  if (!b.video_url) return res.status(400).json({ error: 'video_url required' });
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-fx-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });
    const inP = path.join(tmpDir, 'in.mp4'), outP = path.join(tmpDir, 'out.mp4');
    await downloadFile(b.video_url, inP);
    await updateJob(b.job_id, 'processing');
    await applyEffect(inP, outP, b.effect);
    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, outP));
  } catch (e) { await updateJob(b.job_id, 'error', null, e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── PHOTO → VIDEO (Ken Burns zoom/pan motion on stills) ────
// Body: { images:[url,...], job_id, perImage?(sec), motion?('zoom'|'pan'|'auto'),
//         transition?('fade'|'none'), music_url?, aspect?('9:16'|'1:1'|'16:9') }
app.post('/photo-video', async (req, res) => {
  const b = req.body || {};
  const images = Array.isArray(b.images) ? b.images.filter(Boolean) : [];
  if (!images.length) return res.status(400).json({ error: 'images array required' });
  const per = Math.min(Math.max(parseFloat(b.perImage) || 3, 1.5), 8);
  const aspect = ['9:16', '1:1', '16:9'].includes(b.aspect) ? b.aspect : '9:16';
  const useXfade = (b.transition === 'fade');
  setJob(b.job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-p2v-'));
  try {
    await updateJob(b.job_id, 'downloading');
    res.json({ status: 'processing', job_id: b.job_id });

    // 1) download all images
    const localImgs = [];
    for (let i = 0; i < images.length; i++) {
      const p = path.join(tmpDir, 'img' + i + path.extname(images[i].split('?')[0]) || '.jpg');
      await downloadFile(images[i], p);
      localImgs.push(p);
    }

    await updateJob(b.job_id, 'processing');
    const dims = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] }[aspect];
    const clips = [];
    // 2) make a Ken Burns clip per image
    for (let i = 0; i < localImgs.length; i++) {
      const out = path.join(tmpDir, 'clip' + i + '.mp4');
      await kenBurns(localImgs[i], out, per, dims, i % 4);
      clips.push(out);
    }

    // 3) join (with or without crossfade), then optional music
    const joined = path.join(tmpDir, 'joined.mp4');
    if (useXfade && clips.length > 1) await xfadeJoin(clips, joined, per, tmpDir);
    else await concatClips(clips, joined, tmpDir);

    let finalOut = joined;
    if (b.music_url) {
      const mp = path.join(tmpDir, 'music.mp3');
      await downloadFile(b.music_url, mp);
      finalOut = path.join(tmpDir, 'final.mp4');
      await addBgMusicSimple(joined, mp, finalOut);
    }

    await updateJob(b.job_id, 'uploading');
    await updateJob(b.job_id, 'done', await uploadOutput(b.job_id, finalOut));
  } catch (e) {
    console.error('[' + b.job_id + '] photo-video error:', e.message);
    await updateJob(b.job_id, 'error', null, e.message);
  } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(x){} }
});

// ─── TRIM (cut a start/end range from a video) ──────────────
// Body: { video_url, job_id, start, end }  (start/end in seconds)
app.post('/trim', async (req, res) => {
  const { video_url, job_id } = req.body || {};
  const start = Math.max(0, parseFloat(req.body && req.body.start) || 0);
  const end = parseFloat(req.body && req.body.end);
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  if (!(end > start)) return res.status(400).json({ error: 'end must be greater than start' });
  console.log(`[${job_id}] Trim job started — ${start}s to ${end}s`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-trim-'));

  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'Trim started' });

    const inPath = path.join(tmpDir, 'in.mp4');
    await downloadFile(video_url, inPath);

    await updateJob(job_id, 'trimming');
    const outPath = path.join(tmpDir, 'out.mp4');
    await trimClip(inPath, outPath, start, end);

    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outPath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] Trim done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] Trim error:`, err.message);
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
app.post('/finalize', async (req, res) => {
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
app.post('/music', async (req, res) => {
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

// Pick the caption font: honor the user's choice ONLY if it can render the
// language's script; otherwise fall back to the correct script font so
// Persian/Arabic/etc. never break.
function pickFont(chosen, lang) {
  const l = String(lang || '').toLowerCase();
  const scriptFont = fontForLang(l);
  if (!chosen) return scriptFont;
  // Latin-script languages can use any of the Latin display choices.
  const latinChoices = ['Noto Sans', 'Noto Serif', 'Noto Sans Display', 'Noto Sans Mono'];
  const isScriptLang = ['ar','fa','ur','hi','zh'].includes(l);
  if (isScriptLang) {
    // For Arabic-script langs allow the two Arabic faces; else force script font.
    if (['ar','fa','ur'].includes(l)) {
      const arabicChoices = ['Noto Sans Arabic', 'Noto Naskh Arabic', 'Noto Kufi Arabic'];
      return arabicChoices.includes(chosen) ? chosen : scriptFont;
    }
    return scriptFont; // hi/zh always use their script font
  }
  return latinChoices.includes(chosen) ? chosen : scriptFont;
}

// Build a styled ASS subtitle file from cues. Social look: big bold text,
// thick outline, bottom-centred. RTL-aware for fa/ar/ur.
function buildAss(cues, opts) {
  opts = opts || {};
  const st = opts.style || {};
  const fontName = pickFont(st.font, opts.lang);
  const fontSize = st.size || 22;
  const primary  = st.primary  || '&H00FFFFFF';  // white   (AABBGGRR)
  const outline  = st.outline  || '&H00000000';  // black
  const outlineW = (st.outlineW != null) ? st.outlineW : 3;
  const shadow   = (st.shadow  != null) ? st.shadow  : 1;
  const marginV  = st.marginV || 40;
  const bold     = st.bold === false ? 0 : -1;
  // Position: 'top' | 'middle' | 'bottom' (ASS alignment 8 / 5 / 2). Default bottom.
  const align    = st.align === 'top' ? 8 : st.align === 'middle' ? 5 : 2;

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
      bold + ',0,0,0,100,100,0,0,1,' + outlineW + ',' + shadow + ',' + align + ',40,40,' + marginV + ',1\n\n' +
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
// Change playback speed (video setpts + audio atempo, chained for range).
function changeSpeed(inPath, outPath, rate) {
  // atempo supports 0.5–2.0 per filter; chain for wider range.
  let a = [], r = rate;
  while (r > 2.0) { a.push('atempo=2.0'); r /= 2.0; }
  while (r < 0.5) { a.push('atempo=0.5'); r /= 0.5; }
  a.push('atempo=' + r.toFixed(4));
  const vpts = (1 / rate).toFixed(4);
  return new Promise((resolve, reject) => {
    ffmpeg().input(inPath)
      .complexFilter([`[0:v]setpts=${vpts}*PTS[v]`, `[0:a]${a.join(',')}[a]`])
      .outputOptions(['-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('speed: ' + e.message))).run();
  });
}

// Remove the [start,end] section: cut the two surrounding parts and concat.
async function removeSection(inPath, outPath, start, end, dir) {
  const probe = await probeClip(inPath);
  const total = probe.duration || 0;
  const partA = path.join(dir, 'a.mp4'), partB = path.join(dir, 'b.mp4');
  const jobs = [];
  if (start > 0.05) jobs.push(trimClip(inPath, partA, 0, start).then(() => partA));
  if (end < total - 0.05) jobs.push(trimClip(inPath, partB, end, total).then(() => partB));
  const parts = await Promise.all(jobs);
  if (parts.length === 1) { fs.copyFileSync(parts[0], outPath); return; }
  const listFile = path.join(dir, 'list.txt');
  fs.writeFileSync(listFile, parts.map(p => `file '${p}'`).join('\n'));
  return new Promise((resolve, reject) => {
    ffmpeg().input(listFile).inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('split: ' + e.message))).run();
  });
}

// Burn a big emoji/sticker at a corner or center using drawtext (color emoji font).
function burnSticker(inPath, outPath, dir, b) {
  const size = Math.min(Math.max(parseInt(b.size) || 160, 48), 400);
  const m = 40; // margin from edges
  const posMap = {
    tl: `x=${m}:y=${m}`,
    tr: `x=w-tw-${m}:y=${m}`,
    bl: `x=${m}:y=h-th-${m}`,
    br: `x=w-tw-${m}:y=h-th-${m}`,
    center: `x=(w-tw)/2:y=(h-th)/2`,
  };
  const pos = posMap[b.pos] || posMap.br;
  // write emoji to a text file to avoid shell-escaping issues
  const txtFile = path.join(dir, 'emoji.txt');
  fs.writeFileSync(txtFile, String(b.emoji));
  const vf = `drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf:textfile='${txtFile}':fontsize=${size}:${pos}`;
  return new Promise((resolve, reject) => {
    ffmpeg().input(inPath).videoFilters(vf)
      .outputOptions(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('sticker: ' + e.message))).run();
  });
}

// Adjust original audio volume (0 mutes, 1 unchanged, 2 = 2x).
function setVolume(inPath, outPath, vol) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(inPath);
    if (vol === 0) {
      cmd.outputOptions(['-an', '-c:v', 'copy', '-movflags', '+faststart']);
    } else {
      cmd.audioFilters(`volume=${vol}`)
        .outputOptions(['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']);
    }
    cmd.output(outPath).on('end', resolve).on('error', e => reject(new Error('volume: ' + e.message))).run();
  });
}

// Burn a single styled text/title using an ASS file (reuses buildAss styling).
function burnText(inPath, outPath, dir, b) {
  const pos = b.pos === 'top' ? 8 : b.pos === 'center' ? 5 : 2;   // ASS alignment
  const dur = (b.end != null && b.start != null) ? null : null;
  const start = b.start != null ? Number(b.start) : 0;
  const probeEnd = b.end != null ? Number(b.end) : 999;
  const rtl = ['ar', 'fa', 'ur'].includes(String(b.lang || '').toLowerCase());
  const cues = [{ start: start, end: probeEnd, text: String(b.text) }];
  const ass = buildAss(cues, { rtl: rtl, lang: b.lang || '', style: { size: 32, marginV: pos === 5 ? 0 : 60 } });
  // force alignment
  const ass2 = ass.replace(/,2,40,40,\d+,1/, `,${pos},40,40,${pos === 5 ? 0 : 60},1`);
  const assPath = path.join(dir, 't.ass');
  fs.writeFileSync(assPath, ass2);
  return burnSubtitles(inPath, assPath, outPath, dir);
}

// Colour grade: presets or manual eq values.
function applyFilter(inPath, outPath, b) {
  const presets = {
    vivid:   'eq=saturation=1.4:contrast=1.15:brightness=0.03',
    warm:    'eq=saturation=1.15:gamma_r=1.08:gamma_b=0.95',
    cool:    'eq=saturation=1.1:gamma_b=1.08:gamma_r=0.95',
    bw:      'hue=s=0,eq=contrast=1.15',
    cinema:  'curves=all=\'0/0.05 0.5/0.5 1/0.95\',eq=saturation=1.05:contrast=1.1',
    bright:  'eq=brightness=0.08:saturation=1.1',
  };
  let vf = presets[b.preset];
  if (!vf) {
    const br = (parseFloat(b.brightness) || 0);
    const co = (parseFloat(b.contrast) || 1);
    const sa = (parseFloat(b.saturation) || 1);
    vf = `eq=brightness=${br}:contrast=${co}:saturation=${sa}`;
  }
  return new Promise((resolve, reject) => {
    ffmpeg().input(inPath).videoFilters(vf)
      .outputOptions(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('filter: ' + e.message))).run();
  });
}

// Reframe to an aspect ratio (fit + black pad, no distortion).
function reframe(inPath, outPath, aspect) {
  const dims = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] }[aspect];
  const [w, h] = dims;
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  return new Promise((resolve, reject) => {
    ffmpeg().input(inPath).videoFilters(vf)
      .outputOptions(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('reframe: ' + e.message))).run();
  });
}

// Fade in + fade out on video and audio.
async function addFade(inPath, outPath, d) {
  const probe = await probeClip(inPath);
  const total = probe.duration || 0;
  const outStart = Math.max(0, total - d).toFixed(2);
  const vf = `fade=t=in:st=0:d=${d},fade=t=out:st=${outStart}:d=${d}`;
  const af = `afade=t=in:st=0:d=${d},afade=t=out:st=${outStart}:d=${d}`;
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(inPath).videoFilters(vf);
    if (probe.hasAudio) cmd.audioFilters(af);
    cmd.outputOptions(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('fade: ' + e.message))).run();
  });
}

// Freeze a frame at time `at` for `hold` seconds (split, still, concat).
async function freezeFrame(inPath, outPath, at, hold, dir) {
  const probe = await probeClip(inPath);
  const total = probe.duration || 0;
  const before = path.join(dir, 'bf.mp4'), still = path.join(dir, 'st.mp4'), after = path.join(dir, 'af.mp4');
  const png = path.join(dir, 'frame.png');
  // grab the frame
  await new Promise((res, rej) => ffmpeg().input(inPath).seekInput(at).frames(1).output(png).on('end', res).on('error', e => rej(new Error('freeze grab: ' + e.message))).run());
  // make a still clip of `hold` secs (silent)
  await new Promise((res, rej) => ffmpeg().input(png).loop(hold).inputOptions(['-framerate', '30'])
    .outputOptions(['-t', String(hold), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'])
    .output(still).on('end', res).on('error', e => rej(new Error('freeze still: ' + e.message))).run());
  const parts = [];
  await trimClip(inPath, before, 0, at); parts.push(before);
  parts.push(still);
  if (at < total - 0.05) { await trimClip(inPath, after, at, total); parts.push(after); }
  const listFile = path.join(dir, 'fl.txt');
  fs.writeFileSync(listFile, parts.map(p => `file '${p}'`).join('\n'));
  return new Promise((resolve, reject) => {
    ffmpeg().input(listFile).inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('freeze concat: ' + e.message))).run();
  });
}

// Split-screen: two videos side-by-side or stacked, fit to canvas.
function splitScreen(leftPath, rightPath, outPath, layout, aspect) {
  const dims = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] }[aspect];
  const [W, H] = dims;
  let filter;
  if (layout === 'stack') {
    const hw = W, hh = Math.floor(H / 2);
    filter =
      `[0:v]scale=${hw}:${hh}:force_original_aspect_ratio=increase,crop=${hw}:${hh},setsar=1[top];` +
      `[1:v]scale=${hw}:${hh}:force_original_aspect_ratio=increase,crop=${hw}:${hh},setsar=1[bot];` +
      `[top][bot]vstack=inputs=2[v]`;
  } else {
    const hw = Math.floor(W / 2), hh = H;
    filter =
      `[0:v]scale=${hw}:${hh}:force_original_aspect_ratio=increase,crop=${hw}:${hh},setsar=1[l];` +
      `[1:v]scale=${hw}:${hh}:force_original_aspect_ratio=increase,crop=${hw}:${hh},setsar=1[r];` +
      `[l][r]hstack=inputs=2[v]`;
  }
  return new Promise((resolve, reject) => {
    ffmpeg().input(leftPath).input(rightPath)
      .complexFilter(filter, 'v')
      .outputOptions(['-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('splitscreen: ' + e.message))).run();
  });
}

// Effects / overlays via ffmpeg filters.
function applyEffect(inPath, outPath, effect) {
  const fx = {
    glow:     'gblur=sigma=8[b];[0:v][b]blend=all_mode=screen:all_opacity=0.35,eq=saturation=1.2:brightness=0.03',
    sparkle:  'eq=saturation=1.25:contrast=1.1,noise=alls=8:allf=t',
    vignette: 'vignette=PI/4',
    vhs:      'curves=r=\'0/0.1 1/0.9\',noise=alls=12:allf=t,eq=saturation=1.3',
    dream:    'gblur=sigma=4[b];[0:v][b]blend=all_mode=lighten:all_opacity=0.5,eq=saturation=1.15',
    sharp:    'unsharp=5:5:1.2:5:5:0.6',
    warm_glow:'eq=saturation=1.2:gamma_r=1.1,vignette=PI/5',
  };
  let filter = fx[effect];
  const isComplex = filter && filter.includes('[b]');
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(inPath);
    if (!filter) { filter = 'null'; }
    if (isComplex) cmd.complexFilter(filter);
    else cmd.videoFilters(filter);
    cmd.outputOptions(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('effect: ' + e.message))).run();
  });
}

// Ken Burns: animate a still with slow zoom/pan. variant 0-3 varies the motion.
function kenBurns(imgPath, outPath, seconds, dims, variant) {
  const [W, H] = dims;
  const fps = 30;
  const frames = Math.round(seconds * fps);
  // zoompan zooms from 1.0 → 1.15; pan direction depends on variant.
  const zEnd = 1.15;
  const zExpr = `min(zoom+${((zEnd - 1) / frames).toFixed(6)},${zEnd})`;
  let x = 'iw/2-(iw/zoom/2)', y = 'ih/2-(ih/zoom/2)';       // default: centre zoom-in
  if (variant === 1) { x = '0'; }                            // pan left→
  if (variant === 2) { x = 'iw-(iw/zoom)'; }                 // pan right←
  if (variant === 3) { y = '0'; }                            // pan top↓
  // scale up first so zoompan has pixels to work with, then zoompan, then fit to canvas
  const vf =
    `scale=${W*2}:${H*2}:force_original_aspect_ratio=increase,crop=${W*2}:${H*2},` +
    `zoompan=z='${zExpr}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps},` +
    `format=yuv420p`;
  return new Promise((resolve, reject) => {
    ffmpeg().input(imgPath).loop(seconds).inputOptions(['-framerate', String(fps)])
      .videoFilters(vf)
      .outputOptions(['-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('kenburns: ' + e.message))).run();
  });
}

// Simple concat of same-size clips (adds silent audio for consistency).
function concatClips(clips, outPath, dir) {
  const listFile = path.join(dir, 'p2v_list.txt');
  fs.writeFileSync(listFile, clips.map(p => `file '${p}'`).join('\n'));
  return new Promise((resolve, reject) => {
    ffmpeg().input(listFile).inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('concat: ' + e.message))).run();
  });
}

// Join clips with crossfade transitions between each.
function xfadeJoin(clips, outPath, per, dir) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    clips.forEach(c => cmd.input(c));
    const fadeDur = 0.6;
    // build chained xfade filter
    let filter = '', last = '0:v';
    let offset = per - fadeDur;
    for (let i = 1; i < clips.length; i++) {
      const out = (i === clips.length - 1) ? 'vout' : `v${i}`;
      filter += `[${last}][${i}:v]xfade=transition=fade:duration=${fadeDur}:offset=${offset.toFixed(2)}[${out}];`;
      last = out;
      offset += per - fadeDur;
    }
    filter = filter.replace(/;$/, '');
    cmd.complexFilter(filter, 'vout')
      .outputOptions(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('xfade: ' + e.message))).run();
  });
}

// Add background music to a (silent) video, trimming music to video length.
function addBgMusicSimple(videoPath, musicPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg().input(videoPath).input(musicPath)
      .outputOptions(['-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart'])
      .output(outPath).on('end', resolve).on('error', e => reject(new Error('bgmusic: ' + e.message))).run();
  });
}

// Cut [start, end] (seconds) from a video. Re-encodes for frame-accurate cuts.
function trimClip(inPath, outPath, start, end) {
  const dur = Math.max(0.1, end - start);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inPath)
      .setStartTime(start)
      .duration(dur)
      .outputOptions([
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart'
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error('trim ffmpeg error: ' + err.message)))
      .run();
  });
}

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
