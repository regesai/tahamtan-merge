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

const MERGE_BUCKET = process.env.MERGE_BUCKET || 'videos';

// ── In-memory job status ──────────────────────────────────────
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

// ─── STATUS ──────────────────────────────────────────────────
app.get('/status/:job_id', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const j = jobs[req.params.job_id];
  if (!j) return res.json({ status: 'unknown' });
  res.json({ status: j.status, url: j.url, output_url: j.url, video_url: j.url, error: j.error });
});

// ─── PROXY ───────────────────────────────────────────────────
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
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'Merge started' });

    const localFiles = [];
    for (let i = 0; i < clips.length; i++) {
      const localPath = path.join(tmpDir, `clip_${i}.mp4`);
      console.log(`[${job_id}] Downloading clip ${i+1}/${clips.length}`);
      await downloadFile(clips[i], localPath);
      localFiles.push(localPath);
    }

    await updateJob(job_id, 'merging');

    const listFile = path.join(tmpDir, 'list.txt');
    const listContent = localFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    const outputFile = path.join(tmpDir, 'merged.mp4');
    try {
      await mergeVideosSmooth(localFiles, outputFile);
      console.log(`[${job_id}] Smooth (crossfade) merge complete — ${outputFile}`);
    } catch (xfErr) {
      console.warn(`[${job_id}] Crossfade merge failed, using concat fallback: ${xfErr.message}`);
      await mergeVideos(listFile, outputFile);
      console.log(`[${job_id}] Concat merge complete — ${outputFile}`);
    }

    await updateJob(job_id, 'uploading');
    const publicUrl = await uploadOutput(job_id, outputFile);

    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] Done — ${publicUrl}`);

  } catch (err) {
    console.error(`[${job_id}] Error:`, err.message);
    await updateJob(job_id, 'error', null, err.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
});

// ─── CAPTION ─────────────────────────────────────────────────
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

// ─── FINALIZE ────────────────────────────────────────────────
app.post('/finalize', async (req, res) => {
  const { video_url, job_id } = req.body || {};
  const boost = (req.body && req.body.boost === false) ? false : true;
  const resolution = (req.body && req.body.resolution) || '1080p';
  const aspect = (req.body && req.body.aspect) || '9:16';
  const watermark = (req.body && req.body.watermark === false) ? false : true;
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  console.log(`[${job_id}] Finalize job started — boost=${boost} res=${resolution} aspect=${aspect}`);
  setJob(job_id, { status: 'processing' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tahamtan-fin-'));

  try {
    await updateJob(job_id, 'downloading');
    res.json({ status: 'processing', job_id, message: 'Finalize started' });

    const inPath = path.join(tmpDir, 'in.mp4');
    await downloadFile(video_url, inPath);

    await updateJob(job_id, 'optimizing');
    const outPath = path.join(tmpDir, 'out.mp4');
    let useAspect = aspect;
    if (!req.body || !req.body.aspect) {
      const pr = await probeClip(inPath);
      useAspect = detectAspect(pr.width, pr.height);
      console.log(`[${job_id}] auto-detected aspect ${useAspect} from ${pr.width}x${pr.height}`);
    }
    await finalizeForSocial(inPath, outPath, { boost: boost, resolution: resolution, aspect: useAspect, watermark: watermark });

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

// ─── MUSIC ───────────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════
// EDIT-TAB ENDPOINTS
// ═══════════════════════════════════════════════════════════════

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

// ─── TRIM ────────────────────────────────────────────────────
app.post('/trim', (req, res) => runVideoJob(req, res, 'trim', async (inPath, outPath, b) => {
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
app.post('/speed', (req, res) => runVideoJob(req, res, 'speed', async (inPath, outPath, b) => {
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
app.post('/volume', (req, res) => runVideoJob(req, res, 'volume', async (inPath, outPath, b) => {
  const vol = Math.min(Math.max(parseFloat(b.volume), 0), 3);
  const probe = await probeClip(inPath);
  if (!probe.hasAudio) { await runFF(inPath, outPath, { audio: 'drop', tag: 'volume' }); return; }
  await runFF(inPath, outPath, { af: 'volume=' + (isNaN(vol) ? 1 : vol), tag: 'volume' });
}));

// ─── FILTER ──────────────────────────────────────────────────
app.post('/filter', (req, res) => runVideoJob(req, res, 'filter', async (inPath, outPath, b) => {
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
app.post('/effect', (req, res) => runVideoJob(req, res, 'effect', async (inPath, outPath, b) => {
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
app.post('/reframe', (req, res) => runVideoJob(req, res, 'reframe', async (inPath, outPath, b) => {
  const dims = aspectDims(b.aspect);
  const vf = `scale=${dims.w}:${dims.h}:force_original_aspect_ratio=decrease,` +
             `pad=${dims.w}:${dims.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
  await runFF(inPath, outPath, { vf, tag: 'reframe' });
}));

// ─── FADE ────────────────────────────────────────────────────
app.post('/fade', (req, res) => runVideoJob(req, res, 'fade', async (inPath, outPath, b) => {
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
app.post('/text', (req, res) => runVideoJob(req, res, 'text', async (inPath, outPath, b, tmpDir) => {
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
app.post('/sticker', (req, res) => runVideoJob(req, res, 'sticker', async (inPath, outPath, b, tmpDir) => {
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
app.post('/freeze', (req, res) => runVideoJob(req, res, 'freeze', async (inPath, outPath, b, tmpDir) => {
  const at = Math.max(0, parseFloat(b.at) || 0);
  const hold = Math.min(Math.max(parseFloat(b.hold) || 1.5, 0.3), 10);
  await freezeFrame(inPath, outPath, at, hold, tmpDir);
}));

// ─── PHOTO-VIDEO ─────────────────────────────────────────────
app.post('/photo-video', async (req, res) => {
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
app.post('/split-screen', async (req, res) => {
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
app.post('/extract-last-frame', async (req, res) => {
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

// ─── VOICE-MERGE (replace Seedance silent audio with Google TTS) ──────────
// Body: { video_url, audio_url, job_id }
//   video_url : silent Seedance MP4
//   audio_url : Google TTS output (WAV / MP3 / M4A)
// Replaces the video's audio track entirely with the TTS voice.
// -shortest trims audio to video length so nothing hangs.
// Status via /status/:job_id.
app.post('/voice-merge', async (req, res) => {
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

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(vPath)
        .input(aPath)
        .outputOptions([
          '-map', '0:v',        // video from Seedance clip
          '-map', '1:a',        // audio from Google TTS
          '-c:v', 'copy',       // no re-encode — fast + lossless
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
          '-shortest',          // stop at video end (TTS may be slightly shorter/longer)
          '-movflags', '+faststart'
        ])
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

// ─── HELPERS ─────────────────────────────────────────────────

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
    cmd.input(audioPath).inputOptions(['-stream_loop -1']);

    let filter, mapAudio;
    const musicChain =
      '[1:a]volume=' + vol +
      (dur ? (',afade=t=out:st=' + fadeStart.toFixed(2) + ':d=1.5') : '') +
      '[mus]';

    if (hasVoice && duck) {
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
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
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

function assTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  const p2 = n => String(n).padStart(2, '0');
  return h + ':' + p2(m) + ':' + p2(s) + '.' + p2(cs);
}

function fontForLang(lang) {
  switch (String(lang || '').toLowerCase()) {
    case 'ar': case 'fa': case 'ur': return 'Noto Sans Arabic';
    case 'hi':                       return 'Noto Sans Devanagari';
    case 'zh':                       return 'Noto Sans CJK SC';
    default:                         return 'Noto Sans';
  }
}

function buildAss(cues, opts) {
  opts = opts || {};
  const st = opts.style || {};
  const fontName = st.font || fontForLang(opts.lang);
  const fontSize = st.size || 22;
  const primary  = st.primary  || '&H00FFFFFF';
  const outline  = st.outline  || '&H00000000';
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
      .replace(/\r?\n/g, '\\N')
      .replace(/\{/g, '(').replace(/\}/g, ')');
    if (isRtl) text = '\u202B' + text + '\u202C';
    return 'Dialogue: 0,' + assTime(c.start) + ',' + assTime(c.end) +
      ',Default,,0,0,0,,' + text;
  }).join('\n');

  return header + lines + '\n';
}

function finalizeForSocial(inPath, outPath, opts) {
  opts = opts || {};
  const boost = opts.boost !== false;
  const resolution = opts.resolution || '1080p';
  const aspect = opts.aspect || '9:16';

  const short = resolution === '720p' ? 720 : 1080;
  let W, H;
  if (aspect === '1:1')      { W = short;               H = short; }
  else if (aspect === '16:9'){ W = Math.round(short*16/9); H = short; }
  else                       { W = short;               H = Math.round(short*16/9); }
  W += W % 2; H += H % 2;

  const bv = resolution === '720p' ? '6M'  : '12M';
  const mx = resolution === '720p' ? '7M'  : '14M';
  const bf = resolution === '720p' ? '10M' : '20M';

  return new Promise((resolve, reject) => {
    let vf =
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,format=yuv420p`;
    if (boost) {
      vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
           `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
           `eq=brightness=0.03:saturation=1.08:contrast=1.03,` +
           `curves=all='0/0.03 0.5/0.52 1/1',` +
           `unsharp=5:5:2.0:5:5:0.0,` +
           `setsar=1,format=yuv420p`;
    }
    if (opts.watermark) {
      const wmSize = Math.round(H * 0.028);
      const pad = Math.round(H * 0.02);
      vf += `,drawtext=font='Noto Sans':text='TAHAMTAN AI':` +
            `fontcolor=white@0.75:fontsize=${wmSize}:` +
            `shadowcolor=black@0.5:shadowx=2:shadowy=2:` +
            `x=w-tw-${pad}:y=h-th-${pad}`;
    }
    ffmpeg()
      .input(inPath)
      .videoFilters(vf)
      .outputOptions([
        '-r', '30',
        '-c:v', 'libx264',
        '-profile:v', 'high',
        '-preset', 'medium',
        '-b:v', bv, '-maxrate', mx, '-bufsize', bf,
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

function burnSubtitles(inPath, assPath, outPath, workDir) {
  return new Promise((resolve, reject) => {
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

function probeClip(file) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err || !data) return resolve({ duration: 0, hasAudio: false, width: 0, height: 0 });
      const duration = data.format && data.format.duration ? parseFloat(data.format.duration) : 0;
      const hasAudio = (data.streams || []).some((s) => s.codec_type === 'audio');
      const v = (data.streams || []).find((s) => s.codec_type === 'video') || {};
      resolve({ duration: duration || 0, hasAudio, width: v.width || 0, height: v.height || 0 });
    });
  });
}

function detectAspect(w, h) {
  if (!w || !h) return '9:16';
  const r = w / h;
  if (r >= 1.5) return '16:9';
  if (r <= 0.75) return '9:16';
  return '1:1';
}

async function mergeVideosSmooth(files, outputFile) {
  const T = 0.75;
  if (!files || files.length < 2) throw new Error('need >= 2 clips');

  const probes = [];
  for (const f of files) probes.push(await probeClip(f));
  const durs = probes.map((p) => p.duration);
  if (durs.some((d) => !d || d <= T + 0.2)) throw new Error('clip durations unusable for crossfade');
  const allAudio = probes.every((p) => p.hasAudio);

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
const R2_ACCOUNT   = process.env.CF_ACCOUNT_ID || '';
const R2_BUCKET    = process.env.R2_BUCKET || 'tahamtan-videos';
const R2_KEY_ID    = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET    = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_PUBLIC    = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
const R2_HOST      = R2_ACCOUNT ? `${R2_ACCOUNT}.r2.cloudflarestorage.com` : '';

function r2Ready() { return !!(R2_ACCOUNT && R2_KEY_ID && R2_SECRET && R2_PUBLIC); }

function r2sha256hex(d){ return require('crypto').createHash('sha256').update(d).digest('hex'); }
function r2hmac(k, d){ return require('crypto').createHmac('sha256', k).update(d).digest(); }

async function uploadToR2(job_id, filePath, opts) {
  opts = opts || {};
  const ext = opts.ext || 'mp4';
  const contentType = opts.contentType || 'video/mp4';
  const crypto = require('crypto');
  const body = fs.readFileSync(filePath);
  const key = `merged/${job_id}-${Date.now()}.${ext}`;
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
      'Content-Type': contentType,
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

async function uploadOutput(job_id, filePath) {
  if (r2Ready()) return uploadToR2(job_id, filePath);
  return uploadToSupabase(job_id, filePath);
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
  setJob(job_id, { status, url: video_url || (jobs[job_id] && jobs[job_id].url) || null, error });

  if (!supabase || !job_id) return;
  try {
    const row = { id: job_id, status, updated_at: new Date().toISOString() };
    if (video_url) row.video_url = video_url;
    if (error)     row.error     = error;
    await supabase.from('merge_jobs').upsert(row, { onConflict: 'id' });
  } catch(e) {
    console.warn('Supabase update skipped:', e.message);
  }
}

// ─── EDIT-TAB HELPERS ────────────────────────────────────────

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

// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TAHAMTAN merge service running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
