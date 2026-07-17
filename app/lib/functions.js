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

// ---- Background task chips (2026-07-16) --------------------------------
// The full-screen overlay above forced the user to sit and wait even for
// short AI drafts. withBusyChip() shows a small pill in the bottom-right
// corner instead, so the page stays interactive — user can keep editing,
// switch tabs, etc. — while the task runs. Long tasks (Compose outpaint,
// 30-90s) still opt into the beforeunload guard so a refresh mid-flight
// doesn't burn a fal credit; short tasks (5s AI text) skip it. Auto-clears
// on settle; error text lingers until the user clicks the chip to dismiss.
let __chipSeq = 0;
function __ensureChipHost() {
  let host = document.getElementById('task-chips');
  if (host) return host;
  const style = document.createElement('style');
  style.textContent =
    '#task-chips{position:fixed;right:1.2rem;bottom:1.2rem;display:flex;flex-direction:column;gap:.5rem;z-index:2500;pointer-events:none;max-width:22rem}' +
    '.task-chip{pointer-events:auto;background:#1a1820;color:#e8e6e1;border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.4);padding:.7rem .9rem;display:flex;align-items:center;gap:.7rem;font-size:.86rem;line-height:1.35;opacity:0;transform:translateY(6px);transition:opacity .18s,transform .18s}' +
    '.task-chip.show{opacity:1;transform:translateY(0)}' +
    '.task-chip .tc-spin{flex-shrink:0;width:16px;height:16px;border:2px solid rgba(255,255,255,.25);border-top-color:#9d7aff;border-radius:50%;animation:tc-spin 1s linear infinite}' +
    '.task-chip.done .tc-spin{border-color:#2e7d32;border-top-color:#2e7d32;animation:none}' +
    '.task-chip.err .tc-spin{border-color:#ff6b5c;border-top-color:#ff6b5c;animation:none}' +
    '.task-chip .tc-body{min-width:0;flex:1}' +
    '.task-chip .tc-title{font-weight:600}' +
    '.task-chip .tc-note{color:rgba(232,230,225,.7);font-size:.78rem;margin-top:.15rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.task-chip .tc-x{flex-shrink:0;cursor:pointer;color:rgba(232,230,225,.55);font-size:1.05rem;line-height:1;padding:.15rem .25rem;border-radius:6px}' +
    '.task-chip .tc-x:hover{color:#fff;background:rgba(255,255,255,.08)}' +
    '@keyframes tc-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  host = document.createElement('div');
  host.id = 'task-chips';
  document.body.appendChild(host);
  return host;
}
// Show a chip. Returns a handle with .setNote(t) / .done(t) / .fail(t).
// If guardLeave is true, the beforeunload guard fires until the chip settles.
function showTaskChip(title, note, guardLeave) {
  const host = __ensureChipHost();
  const el = document.createElement('div');
  el.className = 'task-chip';
  el.id = 'tc-' + (++__chipSeq);
  el.innerHTML =
    '<div class="tc-spin"></div>' +
    '<div class="tc-body"><div class="tc-title"></div><div class="tc-note"></div></div>' +
    '<div class="tc-x" title="Dismiss">×</div>';
  el.querySelector('.tc-title').textContent = title || 'Working…';
  el.querySelector('.tc-note').textContent = note || '';
  el.querySelector('.tc-x').onclick = () => dismiss();
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  if (guardLeave) {
    __busyDepth++;
    if (!__busyGuardBound) { window.addEventListener('beforeunload', __busyGuard); __busyGuardBound = true; }
  }
  let dismissed = false, settled = false;
  function dismiss() {
    if (dismissed) return; dismissed = true;
    if (guardLeave && !settled) { __busyDepth = Math.max(0, __busyDepth - 1); settled = true; }
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  }
  function settleGuard() {
    if (guardLeave && !settled) { __busyDepth = Math.max(0, __busyDepth - 1); settled = true; }
  }
  return {
    setNote(t) { el.querySelector('.tc-note').textContent = t || ''; },
    done(t) {
      settleGuard();
      el.classList.add('done');
      el.querySelector('.tc-title').textContent = t || 'Done';
      el.querySelector('.tc-note').textContent = '';
      setTimeout(dismiss, 2500);
    },
    fail(t) {
      settleGuard();
      el.classList.add('err');
      el.querySelector('.tc-title').textContent = 'Failed';
      el.querySelector('.tc-note').textContent = t || '';
      // No auto-dismiss on error — user reads it and clicks × to dismiss.
    },
    dismiss,
  };
}
// ---- Step rail unlock ---------------------------------------------------
// Each step page's rail hardcodes .done / .active / .locked based on which
// page it is. That's fine on the way FORWARD, but wrong on the way BACK:
// going from Check to Brief re-locks Check because the Brief page's rail
// doesn't know renders already exist (Owner report, 2026-07-16). This
// helper reads the actual "how far did the user get?" from the DB and
// unlocks any .rail-step whose position is ≤ that. Called on init from
// every step page — a no-op if the DB says nothing was reached yet.
const __RAIL_STEP_URLS = [
  '4-tags-editor.html',      // 1 Brief
  '5-scenes-editor.html',    // 2 Scenes
  '6-checker-gallery.html',  // 3 Check
  '8-compose.html',          // 4 Size and Text
  '7-review-gallery.html',   // 5 Review
];
async function applyRailUnlocks(projectId) {
  if (!projectId || !window.db || !window.db.computeReachedStep) return;
  let reached = 1;
  try { reached = await window.db.computeReachedStep(projectId); } catch (e) { return; }
  const steps = document.querySelectorAll('.rail .rail-step');
  steps.forEach((el, idx) => {
    const stepNum = idx + 1;
    if (stepNum > reached) return;                        // still ahead — leave locked
    if (!el.classList.contains('locked')) return;         // already done/active — leave alone
    el.classList.remove('locked');
    el.classList.add('done');
    const n = el.querySelector('.n');
    if (n) n.textContent = '✓';
    const url = __RAIL_STEP_URLS[idx];
    if (url) el.onclick = () => { location.href = url + '?project=' + encodeURIComponent(projectId); };
  });
}

// Wrap an async call with a chip. Same shape as withBusyOverlay so the four
// call sites swap in cleanly. guardLeave defaults false — pass true for long
// tasks (e.g. outpaint) that shouldn't be lost to an accidental refresh.
async function withBusyChip(title, note, fn, opts) {
  const chip = showTaskChip(title, note, !!(opts && opts.guardLeave));
  try {
    const r = await fn(chip);
    chip.done((opts && opts.doneLabel) || (title.replace(/…$/, '') + ' — done'));
    return r;
  } catch (err) {
    chip.fail(err && err.message ? err.message : String(err));
    throw err;
  }
}
