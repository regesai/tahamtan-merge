// ═══════════════════════════════════════════════════════════════
//  TAHAMTAN.AI — Seamless Video Merge Service
//  Runs on Railway. Merges 2–4 clips into ONE MP4 and uploads to R2.
//
//  Contract (must match the front-end):
//    GET  /health           -> { status: "ok" }        (wake-up ping)
//    POST /merge            -> body { clips: [url,...], job_id: "..." }
//                              responds 202 immediately, then works async
//
//  Progress is written to Supabase table `merge_jobs` (id primary key):
//    status: pending -> downloading -> merging -> uploading -> done | error
//    on done:  output_url = public R2 link
//    on error: error_message = reason
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');            // v2 (CommonJS)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

// ─── Environment ───────────────────────────────────────────────
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_KEY          = process.env.SUPABASE_KEY;          // service-role key preferred
const R2_ACCOUNT_ID         = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID      = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY  = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET             = process.env.R2_BUCKET;             // e.g. tahamtan-videos
const R2_PUBLIC_URL         = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, ''); // e.g. https://pub-xxxx.r2.dev
const PORT                  = process.env.PORT || 8080;

// Warn loudly at startup if anything critical is missing (shows in Railway logs)
(function checkEnv() {
  const need = { SUPABASE_URL, SUPABASE_KEY, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL };
  const missing = Object.keys(need).filter(k => !need[k]);
  if (missing.length) console.warn('⚠️  MISSING ENV VARS:', missing.join(', '));
  else console.log('✅ All required env vars present.');
})();

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

// ─── App ───────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'tahamtan-merge' }));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'tahamtan-merge' }));

app.post('/merge', async (req, res) => {
  const { clips, job_id } = req.body || {};
  if (!Array.isArray(clips) || clips.length < 2 || !job_id) {
    return res.status(400).json({ error: 'Provide clips[] (2 or more) and a job_id.' });
  }
  if (clips.some(u => typeof u !== 'string' || !u.startsWith('http'))) {
    return res.status(400).json({ error: 'All clip URLs must be valid http(s) links.' });
  }

  // Respond immediately so the front-end's short POST timeout never aborts.
  res.status(202).json({ status: 'accepted', job_id });

  // Do the heavy work in the background; report progress via Supabase.
  processMerge(job_id, clips).catch(async (err) => {
    console.error('merge failed:', err);
    await setJob(job_id, { status: 'error', error_message: String(err && err.message || err) });
  });
});

// ─── Job status writer ─────────────────────────────────────────
async function setJob(job_id, fields) {
  if (!supabase) { console.warn('No Supabase client; cannot write job', job_id); return; }
  try {
    await supabase.from('merge_jobs').upsert({ id: job_id, ...fields });
  } catch (e) {
    console.warn('setJob write failed:', e.message);
  }
}

// ─── Core pipeline ─────────────────────────────────────────────
async function processMerge(job_id, clips) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  try {
    // 1) Download every clip
    await setJob(job_id, { status: 'downloading' });
    const localFiles = [];
    for (let i = 0; i < clips.length; i++) {
      const dest = path.join(workDir, `clip${i}.mp4`);
      const r = await fetch(clips[i]);
      if (!r.ok) throw new Error(`Download failed for clip ${i + 1} (HTTP ${r.status})`);
      const buf = await r.buffer();               // node-fetch v2
      fs.writeFileSync(dest, buf);
      localFiles.push(dest);
    }

    // 2) Merge into one MP4
    await setJob(job_id, { status: 'merging' });
    const outPath = path.join(workDir, 'merged.mp4');
    const allHaveAudio = (await Promise.all(localFiles.map(hasAudio))).every(Boolean);
    await mergeClips(localFiles, outPath, allHaveAudio);

    // 3) Upload to Cloudflare R2
    await setJob(job_id, { status: 'uploading' });
    const key = `merged/${job_id}.mp4`;
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: fs.readFileSync(outPath),
      ContentType: 'video/mp4',
    }));
    const output_url = `${R2_PUBLIC_URL}/${key}`;

    // 4) Done
    await setJob(job_id, { status: 'done', output_url });
    console.log('✅ merge done:', job_id, output_url);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// Probe a file to see if it has an audio stream
function hasAudio(file) {
  return new Promise((resolve) => {
    execFile(ffprobeStatic.path, [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', file,
    ], (err, stdout) => resolve(!err && !!stdout.trim()));
  });
}

// Concatenate clips with re-encode (robust against slightly different params).
// If every clip has audio -> keep audio; otherwise -> video-only output.
function mergeClips(files, outPath, withAudio) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    files.forEach(f => cmd.input(f));

    const n = files.length;
    let filter, maps, extra;
    if (withAudio) {
      filter = files.map((_, i) => `[${i}:v][${i}:a]`).join('') + `concat=n=${n}:v=1:a=1[v][a]`;
      maps = ['-map', '[v]', '-map', '[a]'];
      extra = ['-c:a', 'aac', '-b:a', '128k'];
    } else {
      filter = files.map((_, i) => `[${i}:v]`).join('') + `concat=n=${n}:v=1:a=0[v]`;
      maps = ['-map', '[v]'];
      extra = ['-an'];
    }

    cmd.outputOptions([
      '-filter_complex', filter,
      ...maps,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      ...extra,
      '-movflags', '+faststart',
    ])
      .on('start', c => console.log('ffmpeg:', c))
      .on('error', reject)
      .on('end', () => resolve())
      .save(outPath);
  });
}

app.listen(PORT, () => console.log(`🎬 tahamtan-merge listening on port ${PORT}`));
