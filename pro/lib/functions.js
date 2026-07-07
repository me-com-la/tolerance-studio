// lib/functions.js — calls the deployed Supabase Edge Functions
// (ai-draft, expand-shots, checker, generate) from the browser.
//
// Plain <script src="lib/functions.js"> (no type="module"), same reason as
// lib/supabase.js and lib/db.js — everything here is a window global.
// Load order: supabase-js CDN -> lib/supabase.js -> lib/db.js -> lib/functions.js.

const FUNCTIONS_BASE = 'https://nfvcuidghyklnyixcqrw.supabase.co/functions/v1';
const FUNCTIONS_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5mdmN1aWRnaHlrbG55aXhjcXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNzkxNzIsImV4cCI6MjA5ODk1NTE3Mn0.6AvCWkTjPr_zHoXB2rQtkq-BetQyHmBpJe9Yyo_1n7I';

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

// Calls the local pixel-lock service (tools/pixel-lock/service.py,
// http://127.0.0.1:8805) instead of a Supabase Edge Function. Only used for
// composite/remove-background now (2026-07-08) — those need real OpenCV,
// which Deno Edge Functions can't run, so they stay local by necessity.
// ai-draft/expand-shots moved back to callFunction() above once the JWT
// gateway bug that originally forced them here turned out to be resolved.
// Same error contract as callFunction() so withBusy() call sites don't
// need to change.
const LOCAL_SERVICE = 'http://127.0.0.1:8805';
async function callLocalService(name, body) {
  let res;
  try {
    res = await fetch(`${LOCAL_SERVICE}/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    throw new Error(`can't reach the local pixel-lock service at ${LOCAL_SERVICE} — start it with: python3 tools/pixel-lock/service.py`);
  }
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.error || `${name} failed (HTTP ${res.status})`);
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
