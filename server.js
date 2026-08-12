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

// Supabase (optional — for job status updates)
const SUPABASE_URL  = process.env.SUPABASE_URL  || '';
const SUPABASE_KEY  = process.env.SUPABASE_KEY  || '';
const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

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
    const publicUrl = await uploadToSupabase(job_id, outputFile);

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
    const publicUrl = await uploadToSupabase(job_id, outPath);
    await updateJob(job_id, 'done', publicUrl);
    console.log(`[${job_id}] Caption done — ${publicUrl}`);
  } catch (err) {
    console.error(`[${job_id}] Caption error:`, err.message);
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
    const publicUrl = await uploadToSupabase(job_id, outPath);
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

  const rtlMark = opts.rtl ? '\u202B' : ''; // RLE embedding for correct RTL order
  const lines = cues.map(function (c) {
    const text = String(c.text || '')
      .replace(/\r?\n/g, '\\N')                    // ASS line break
      .replace(/\{/g, '(').replace(/\}/g, ')');    // strip ASS override braces
    return 'Dialogue: 0,' + assTime(c.start) + ',' + assTime(c.end) +
      ',Default,,0,0,0,,' + rtlMark + text;
  }).join('\n');

  return header + lines + '\n';
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

async function uploadToSupabase(job_id, filePath) {
  if (!supabase) {
    // No Supabase — return local file as base64 data URL (fallback)
    console.warn('No Supabase configured — cannot upload merged video');
    throw new Error('Supabase not configured for video storage');
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
