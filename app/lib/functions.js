// lib/functions.js — calls the deployed Supabase Edge Functions
// (ai-draft, expand-shots, checker, generate) from the browser.
//
// Plain <script src="lib/functions.js"> (no type="module"), same reason as
// lib/supabase.js and lib/db.js — everything here is a window global.
// Load order: supabase-js CDN -> lib/supabase.js -> lib/db.js -> lib/functions.js.

// One app, two render modes (apps merged 2026-07-10): callFunction() covers
// both modes' Edge Functions; callLocalService() below is Exact mode's
// Cloud Run compositor.
const FUNCTIONS_BASE = 'https://mqgfosfadmmiqlvuvbcy.supabase.co/functions/v1';
const FUNCTIONS_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1xZ2Zvc2ZhZG1taXFsdnV2YmN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNjA3OTgsImV4cCI6MjA5ODkzNjc5OH0.E9Zj_LRU3Uetrcnv5UTOZ1mjDC7aLqKRbgPqsIypsMQ';

// Calls a deployed Edge Function with the current session's JWT (so it
// authenticates as the logged-in Owner, same RLS scope as every other
// db.js call). Throws on any non-ok response or {ok:false} body, with the
// function's own error message when available.
//
// Used for ai-draft/expand-shots/checker (2026-07-08 — the JWT gateway
// bug this project hit right after creation, described in
// tools/pixel-lock/service.py's header, is gone; a live session-JWT call
// against this project's Edge Functions gateway now succeeds). Only
// `composite`/`remove-background` still go through callLocalService()
// below — those genuinely need OpenCV, which Deno can't run.
async function callFunction(name, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('not signed in');
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: FUNCTIONS_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  let json;
  try { json = await res.json(); }
  catch (e) { throw new Error(`${name}: HTTP ${res.status}, no JSON body`); }
  // Partial-failure case (e.g. generate: some shots ok, some failed) comes
  // back HTTP 200 with ok:false but NO `error` field — the real per-shot
  // reasons live in `summary`/`failed`. Surface those instead of the
  // useless "failed (HTTP 200)" fallback.
  if (!res.ok || json.ok === false) {
    const detail = json.error
      || (Array.isArray(json.failed) && json.failed.length
        ? json.failed.map((f) => `${f.file || 'shot'}: ${f.error || 'unknown error'}`).join('; ')
        : null)
      || json.summary
      || `${name} failed (HTTP ${res.status})`;
    throw new Error(detail);
  }
  return json;
}

// Calls the hosted pixel-lock compositing service (Google Cloud Run,
// source: tools/pixel-lock/cloudrun/) — composite/remove-background need
// real OpenCV, which Supabase's Deno Edge Functions can't run, so those
// two live on Cloud Run instead (deployed 2026-07-08; previously this was
// a localhost-only Python process that only worked on the Owner's
// machine). The service verifies the caller's Supabase session token on
// every request, so it needs the same Authorization header as
// callFunction(). Same error contract as callFunction() so withBusy()
// call sites don't need to change.
const PIXEL_LOCK_SERVICE = 'https://pixel-lock-36638783261.us-west1.run.app';
async function callLocalService(name, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('not signed in');
  let res;
  try {
    res = await fetch(`${PIXEL_LOCK_SERVICE}/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    throw new Error(`can't reach the pixel-lock compositing service at ${PIXEL_LOCK_SERVICE} — check the Cloud Run service is up`);
  }
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    // json.match (score/drift/scale/guard from the LAST attempt) is real
    // diagnostic signal on a drift-guard refusal — attach it to the thrown
    // Error rather than dropping it, so callers can show *how* it failed
    // (borderline vs way off), not just that it failed. See
    // tools/pixel-lock/cloudrun/main.py's snap_back() for what these mean.
    const err = new Error(json.error || `${name} failed (HTTP ${res.status})`);
    if (json.match) err.match = json.match;
    throw err;
  }
  return json;
}

// Shared "generating…" affordance: disables the button, swaps its label,
// shows a status note next to it that clears itself once the call settles
// (success or failure) — same visual language across every AI/generate
// button in the app, per the Owner's brief (2026-07-06): the note should
// disappear as soon as real data appears, not linger.
async function withBusy(button, statusEl, busyLabel, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  if (statusEl) { statusEl.textContent = busyLabel; statusEl.classList.add('busy'); }
  try {
    const result = await fn();
    if (statusEl) { statusEl.textContent = ''; statusEl.classList.remove('busy'); }
    return result;
  } catch (err) {
    if (statusEl) { statusEl.textContent = err.message || String(err); statusEl.classList.remove('busy'); statusEl.classList.add('err'); }
    throw err;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// ---- Shared "Please wait…" overlay + page-leave guard -------------------
// Any AI generation or upload that isn't already covered by a page's own
// full-screen takeover (scenes-editor's image-gen has its own #gen-overlay)
// should run inside withBusyOverlay(): it shows a blocking spinner so the
// Owner sees that something's happening, and blocks refresh/close/navigate
// while the call is in flight so a half-finished generation can't be lost.
// Self-contained (injects its own styles + node) so it works on any page that
// loads lib/functions.js, with no per-page markup. Nesting-safe via a depth
// counter — an upload that then auto-drafts tags stays covered throughout.
let __busyDepth = 0;
let __busyGuardBound = false;
function __ensureBusyOverlay() {
  let el = document.getElementById('busy-overlay');
  if (el) return el;
  const style = document.createElement('style');
  style.textContent =
    '#busy-overlay{position:fixed;inset:0;background:rgba(0,0,0,.82);display:none;align-items:center;justify-content:center;z-index:3000}' +
    '#busy-overlay.open{display:flex}' +
    '#busy-overlay .bo-box{text-align:center;color:#fff;max-width:24rem;padding:2rem}' +
    '#busy-overlay .bo-spin{width:40px;height:40px;border:3px solid rgba(255,255,255,.25);border-top-color:#d8502d;border-radius:50%;margin:0 auto 1.2rem;animation:bo-spin 1s linear infinite}' +
    '@keyframes bo-spin{to{transform:rotate(360deg)}}' +
    '#busy-overlay .bo-title{font-size:1.15rem;font-weight:700;margin-bottom:.4rem}' +
    '#busy-overlay .bo-note{font-size:.9rem;color:rgba(255,255,255,.85);line-height:1.5}' +
    '#busy-overlay .bo-warn{display:inline-block;margin-top:1rem;font-size:.78rem;font-weight:600;color:#ffcaba}';
  document.head.appendChild(style);
  el = document.createElement('div');
  el.id = 'busy-overlay';
  el.innerHTML =
    '<div class="bo-box"><div class="bo-spin"></div>' +
    '<div class="bo-title" id="bo-title">Please wait…</div>' +
    '<div class="bo-note" id="bo-note"></div>' +
    '<span class="bo-warn">Please don\'t refresh or leave this page.</span></div>';
  document.body.appendChild(el);
  return el;
}
function __busyGuard(e) { if (__busyDepth > 0) { e.preventDefault(); e.returnValue = ''; } }
function showBusyOverlay(title, note) {
  const el = __ensureBusyOverlay();
  el.querySelector('#bo-title').textContent = title || 'Please wait…';
  el.querySelector('#bo-note').textContent = note || '';
  el.classList.add('open');
  __busyDepth++;
  if (!__busyGuardBound) { window.addEventListener('beforeunload', __busyGuard); __busyGuardBound = true; }
}
// Update the sub-note without touching the depth counter — for multi-phase
// flows (e.g. "Uploading…" -> "Reading your photo…").
function setBusyNote(note) {
  const el = document.getElementById('busy-overlay');
  if (el) el.querySelector('#bo-note').textContent = note || '';
}
function hideBusyOverlay() {
  __busyDepth = Math.max(0, __busyDepth - 1);
  if (__busyDepth === 0) { const el = document.getElementById('busy-overlay'); if (el) el.classList.remove('open'); }
}
// Wrap any async generation/upload so the overlay + leave-guard cover its whole
// duration and always clear afterward. The error still propagates so callers
// keep showing their own inline message.
async function withBusyOverlay(title, note, fn) {
  showBusyOverlay(title, note);
  try { return await fn(); }
  finally { hideBusyOverlay(); }
}
