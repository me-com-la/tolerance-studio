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
  if (!res.ok || json.ok === false) throw new Error(json.error || `${name} failed (HTTP ${res.status})`);
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
