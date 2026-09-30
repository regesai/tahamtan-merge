// ═══════════════════════════════════════════════════════════════
// TAHAMTAN AI — save-video v6
// 1. Downloads video from the generator (temporary URL)
// 2. Uploads to Cloudflare R2 via S3 API + SigV4 (permanent)
// 3. Saves permanent URL to Supabase explore_videos
// 4. Triggers real (frame-based) moderation in the background
// Dependency-free — uses shared r2-upload.js (Node crypto only)
//
// v6 changes:
//  • Moderation moved OUT of this file entirely, into a new background
//    function (moderate-video-background.js). Every video now saves with
//    approved:false immediately; that background function extracts an
//    actual frame from the real generated video and has Claude look at
//    it directly — not the text prompt, which can diverge from what was
//    actually generated. This file only fires the trigger and moves on;
//    it never waits for moderation to finish, since Netlify's synchronous
//    function time limit made it unsafe to wait here for a video
//    download + frame extraction + Claude vision call.
//  • v5 changes (still in effect): added publish_at (free=immediate,
//    paid=+7 days) — this is the only place that computes it, after a
//    separate duplicate-insert path (shareToExplore, now removed from the
//    frontend) was found creating a second row per video with no real
//    moderation and no R2 backup.
//  • v4 changes (still in effect): R2 upload via S3-compatible SigV4
//    endpoint; Supabase insert sends only columns confirmed to exist.
// ═══════════════════════════════════════════════════════════════

const R2 = require('./r2-upload.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hcfnhfkqoitjjsnrfhbg.supabase.co';
const RAILWAY_MERGE_URL = process.env.RAILWAY_MERGE_URL || 'https://tahamtan-merge-production.up.railway.app';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function getSupabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_KEY
      || process.env.SUPABASE_ANON_KEY
      || '';
}

// Free videos publish to Community immediately. Paid-plan videos wait 7
// days (gives paid customers first-look privacy on their own content
// before it's promotional material, and matches the UI's own copy —
// "In 7 days it appears in Community"). "Best of Community" graduating to
// the separate Explore feed after 14 days is enforced client-side (index.html),
// not here — this only decides Community visibility timing.
function computePublishAt(planSlug) {
  const isPaid = /^(starter|pro|studio|ultimate)/i.test(String(planSlug || ''));
  const delayMs = isPaid ? 7 * 24 * 3600 * 1000 : 0;
  return new Date(Date.now() + delayMs).toISOString();
}

async function insertRow(row, key) {
  return fetch(SUPABASE_URL + '/rest/v1/explore_videos', {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(row)
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!b.video_url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'video_url required' }) };

  const supabaseKey = getSupabaseKey();
  if (!supabaseKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase not configured' }) };

  let permanentUrl = b.video_url; // fallback if R2 fails
  let onR2 = false;               // only true when the video really reached R2

  // ── R2 Upload (S3 + SigV4) ───────────────────────────────────
  if (R2.r2Configured()) {
    try {
      console.log('Downloading video:', b.video_url);
      const videoRes = await fetch(b.video_url);
      if (!videoRes.ok) throw new Error(`Download failed: ${videoRes.status}`);
      const buffer = Buffer.from(await videoRes.arrayBuffer());

      const key = `videos/${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
      permanentUrl = await R2.putObject(key, buffer, 'video/mp4');
      onR2 = true;
      console.log('Uploaded to R2:', permanentUrl);
    } catch (e) {
      console.error('R2 UPLOAD FAILED — video is NOT permanently stored, temporary URL saved as fallback:', e.message);
      // non-fatal — still save with original URL
    }
  } else {
    console.error('R2 not configured (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY missing) — saving temp URL only');
  }

  // ── Supabase Save ────────────────────────────────────────────
  // Matched to the REAL explore_videos schema. Confirmed columns:
  //   id, created_at, video_url, prompt, duration, ratio, lang, plan,
  //   likes, views, approved, auto_posted, publish_at, winner_rank,
  //   winner_week, score (+2 more).
  const coreRow = {
    video_url: permanentUrl,
    prompt:    b.prompt || '',
    lang:      b.language || b.lang || 'en'
  };
  // duration is an integer column — only include when we have a clean number.
  const dur = parseInt(b.duration, 10);
  if (Number.isFinite(dur)) coreRow.duration = dur;
  if (b.ratio) coreRow.ratio = String(b.ratio);
  if (b.plan)  coreRow.plan  = String(b.plan);
  // Publish to Community by default (so videos appear in the Community feed).
  // is_public !== false is what the Community query looks for.
  coreRow.is_public = (b.is_public !== false && b.publish !== false);
  // Only matters when is_public is true — a private video's publish_at is
  // irrelevant, but harmless to set either way.
  coreRow.publish_at = computePublishAt(b.plan);
  // Link to the creator so it appears in their "My Videos" (only if logged in).
  if (b.user_id) coreRow.user_id = b.user_id;
  // Creator identity — new columns (see the ALTER TABLE Elite needs to run
  // once). Before this, only logged-in/owner videos had ANY identity;
  // free/anonymous visitors were indistinguishable from each other or from
  // a leak. device_id is a random, non-personal id assigned once per
  // browser; creator_email is whatever email is actually known (free-trial
  // verified email, or a logged-in account's email) — never required,
  // stored only when the frontend actually has one.
  if (b.device_id) coreRow.device_id = String(b.device_id);
  if (b.creator_email) coreRow.creator_email = String(b.creator_email).toLowerCase().trim();

  // Real moderation (actually reviewing the video's own frame + any
  // character reference photo, never just the text prompt) now happens
  // entirely in moderate-video-background.js, triggered below after this
  // row is saved. Every video starts unapproved here — hidden from
  // Community and Explore, but always still visible in the creator's own
  // "My Videos", which never checks this flag — until that background
  // check (or a manual Approve in the admin panel) sets it true.
  coreRow.approved = false;

  // Fallback: barest valid row if the richer one is ever rejected.
  // Keep is_public + approved + publish_at here too so community/explore
  // still work correctly on the minimal path.
  const minimalRow = {
    video_url:   permanentUrl,
    prompt:      b.prompt || '',
    is_public:   (b.is_public !== false && b.publish !== false),
    publish_at:  coreRow.publish_at,
    approved:    coreRow.approved
  };
  if (coreRow.device_id) minimalRow.device_id = coreRow.device_id;
  if (coreRow.creator_email) minimalRow.creator_email = coreRow.creator_email;

  try {
    let res = await insertRow(coreRow, supabaseKey);
    if (!res.ok) {
      const errText = await res.text();
      console.warn('Core insert failed, retrying minimal:', res.status, errText);
      res = await insertRow(minimalRow, supabaseKey);
    }
    if (!res.ok) {
      const e2 = await res.text();
      console.error('Insert failed:', res.status, e2);
      // The VIDEO is safe on R2 even if the DB row failed — return success
      // with the permanent URL so the user still gets their video.
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: true,
        saved_to_db: false,
        video_url: permanentUrl,
        r2_url: onR2 ? permanentUrl : null,
        permanent: onR2
      }) };
    }
    const rows  = await res.json();
    const saved = Array.isArray(rows) ? rows[0] : rows;
    console.log('Video saved id:', saved && saved.id, 'url:', permanentUrl);

    // Kick off real moderation — extracting an actual frame from this
    // video and having Claude look at it directly, not the prompt. Runs
    // on Railway (already-paid infrastructure, no execution time limit)
    // rather than as a Netlify Background Function, which would need a
    // paid Netlify Pro plan just for this. We await only the fast
    // acknowledgment Railway sends back immediately — the real work
    // (frame extraction + Claude + Supabase update) continues on Railway
    // after that, unaffected by this function's own time limit.
    if (saved && saved.id) {
      try {
        await fetch(RAILWAY_MERGE_URL + '/moderate-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: saved.id,
            video_url: permanentUrl,
            prompt: b.prompt || '',
            character_photo_url: b.character_photo_url || null
          })
        });
      } catch (e) {
        console.warn('Moderation trigger failed to send:', e.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true,
      saved_to_db: true,
      id: saved && saved.id,
      video_url: permanentUrl,
      r2_url: onR2 ? permanentUrl : null,
      permanent: onR2
    }) };
  } catch (e) {
    console.error('save-video error:', e);
    // Video is still on R2 — don't fail the whole call.
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true, saved_to_db: false, video_url: permanentUrl,
      r2_url: onR2 ? permanentUrl : null, permanent: onR2
    }) };
  }
};
