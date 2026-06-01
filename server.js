// REGES AI — Video Merge Service
// Deploy to Render.com — merges seamless clips into one MP4
// © 2026 Elite Heating Care Ltd

const express       = require('express');
const { execFileSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');
const https         = require('https');
const http          = require('http');
const ffmpegPath    = require('ffmpeg-static');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

// ── Validate env vars at startup ──
var missingEnv = [];
['R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','SUPABASE_URL','SUPABASE_KEY'].forEach(function(k) {
  if (!process.env[k]) missingEnv.push(k);
});
if (missingEnv.length) {
  console.error('MISSING ENV VARS:', missingEnv.join(', '));
  // Don't crash — log clearly so Render dashboard shows the issue
}

const app = express();

// ── Body parser with guard ──
app.use(function(req, res, next) {
  if (req.method === 'POST' && !req.headers['content-type']?.includes('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
});
app.use(express.json({ limit: '1mb' }));

// ── CORS ──
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── R2 Client ──
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || 'https://placeholder.r2.cloudflarestorage.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID     || 'placeholder',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'placeholder',
  },
});
const BUCKET = process.env.R2_BUCKET || 'regesai-videos';

// ── Supabase ──
var supa = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  try {
    supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  } catch(e) {
    console.error('Supabase init failed:', e.message);
  }
}

// ── Health check ──
app.get('/health', function(req, res) {
  res.json({
    ok: true,
    service: 'reges-merge',
    time: new Date().toISOString(),
    ffmpeg: !!ffmpegPath,
    supabase: !!supa,
    r2_bucket: BUCKET,
    missing_env: missingEnv,
  });
});

// ── POST /merge ──
app.post('/merge', function(req, res) {
  // Guard: req.body could be undefined if middleware failed
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  var clips  = req.body.clips;
  var job_id = req.body.job_id;

  if (!clips || !Array.isArray(clips) || clips.length < 1) {
    return res.status(400).json({ error: 'clips array required' });
  }
  if (clips.length > 10) {
    return res.status(400).json({ error: 'Maximum 10 clips per merge' });
  }
  if (!job_id || typeof job_id !== 'string') {
    job_id = 'merge-' + Date.now();
  }

  // Validate all URLs
  for (var i = 0; i < clips.length; i++) {
    if (!clips[i] || typeof clips[i] !== 'string' || !clips[i].startsWith('http')) {
      return res.status(400).json({ error: 'Invalid URL for clip ' + (i+1) });
    }
  }

  // Return 202 immediately
  res.status(202).json({ job_id: job_id, status: 'pending' });

  // Process async
  processMerge(clips, job_id).catch(function(err) {
    console.error('processMerge unhandled error:', err.message);
  });
});

async function processMerge(clips, job_id) {
  var safeId = job_id.replace(/[^a-zA-Z0-9_-]/g, '_');
  var tmpDir = path.join('/tmp', safeId);

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    await updateJob(job_id, { status: 'downloading' });

    // Download clips sequentially
    var clipPaths = [];
    for (var i = 0; i < clips.length; i++) {
      var clipPath = path.join(tmpDir, 'clip' + i + '.mp4');
      console.log('[' + job_id + '] Downloading clip ' + (i+1) + '/' + clips.length);
      await downloadFile(clips[i], clipPath);

      var stat = fs.statSync(clipPath);
      if (stat.size < 1000) {
        throw new Error('Clip ' + (i+1) + ' is too small (' + stat.size + 'B) — URL may have expired');
      }
      console.log('[' + job_id + '] Clip ' + (i+1) + ': ' + (stat.size/1024/1024).toFixed(1) + 'MB');
      clipPaths.push(clipPath);
    }

    await updateJob(job_id, { status: 'merging' });

    // Write concat list
    var listPath   = path.join(tmpDir, 'list.txt');
    var outputPath = path.join(tmpDir, 'merged.mp4');
    fs.writeFileSync(listPath,
      clipPaths.map(function(p){ return "file '" + p.replace(/'/g, "\\'") + "'"; }).join('\n'),
      'utf8'
    );

    // Run FFmpeg via execFileSync — no shell, safer
    console.log('[' + job_id + '] Running FFmpeg...');
    try {
      execFileSync(ffmpegPath, [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        outputPath
      ], { timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch(ffErr) {
      var ffMsg = '';
      if (ffErr.stderr) ffMsg = ffErr.stderr.toString().slice(-800);
      else if (ffErr.stdout) ffMsg = ffErr.stdout.toString().slice(-400);
      else ffMsg = ffErr.message;
      throw new Error('FFmpeg failed: ' + ffMsg);
    }

    // Verify output
    if (!fs.existsSync(outputPath)) throw new Error('FFmpeg produced no output');
    var outStat = fs.statSync(outputPath);
    if (outStat.size < 1000) throw new Error('Merged file too small (' + outStat.size + 'B)');
    console.log('[' + job_id + '] Merged: ' + (outStat.size/1024/1024).toFixed(1) + 'MB');

    await updateJob(job_id, { status: 'uploading' });

    // Upload to R2 using streams — avoids loading entire file into RAM
    var r2Key = 'merged/' + safeId + '.mp4';
    var fileStream = fs.createReadStream(outputPath);

    await r2.send(new PutObjectCommand({
      Bucket:         BUCKET,
      Key:            r2Key,
      Body:           fileStream,
      ContentType:    'video/mp4',
      ContentLength:  outStat.size,
    }));

    // Build output URL
    var outputUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
      ? process.env.R2_PUBLIC_URL.replace(/\/$/, '') + '/' + r2Key
      : process.env.R2_ENDPOINT.replace(/\/$/, '') + '/' + BUCKET + '/' + r2Key;

    await updateJob(job_id, { status: 'done', output_url: outputUrl });
    console.log('[' + job_id + '] Done:', outputUrl);

  } catch(err) {
    console.error('[' + job_id + '] Error:', err.message);
    await updateJob(job_id, { status: 'error', error_message: err.message.slice(0, 500) });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
}

async function updateJob(job_id, fields) {
  if (!supa) return;
  try {
    var payload = Object.assign({ id: job_id, updated_at: new Date().toISOString() }, fields);
    await supa.from('merge_jobs').upsert(payload);
  } catch(e) {
    console.warn('Supabase update failed:', e.message);
  }
}

function downloadFile(url, destPath) {
  return new Promise(function(resolve, reject) {
    var redirectCount = 0;

    function doDownload(currentUrl) {
      var file   = fs.createWriteStream(destPath);
      var proto  = currentUrl.startsWith('https') ? https : http;
      var done   = false;

      function fail(err) {
        if (done) return;
        done = true;
        file.destroy();
        fs.unlink(destPath, function(){});
        reject(err);
      }

      var req = proto.get(currentUrl, function(res) {
        // Handle redirects
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
          file.destroy();
          fs.unlink(destPath, function(){});
          if (++redirectCount > 5) return reject(new Error('Too many redirects'));
          return doDownload(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return fail(new Error('HTTP ' + res.statusCode + ' for: ' + currentUrl.slice(0,80)));
        }
        res.pipe(file);
        file.on('finish', function() {
          if (done) return;
          done = true;
          file.close(resolve);
        });
        file.on('error', fail);
      });

      req.on('error', fail);
      req.setTimeout(120000, function() {
        req.destroy();
        fail(new Error('Download timeout: ' + currentUrl.slice(0,80)));
      });
    }

    doDownload(url);
  });
}

var PORT = parseInt(process.env.PORT) || 10000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('REGES AI merge service running on port', PORT);
  console.log('FFmpeg path:', ffmpegPath);
  console.log('R2 bucket:', BUCKET);
  console.log('Supabase:', supa ? 'OK' : 'NOT CONFIGURED');
  if (missingEnv.length) console.warn('Missing env vars:', missingEnv.join(', '));
});
