// functions/_higgsfield-key.js — SERVER-SIDE-ONLY placeholder for the
// Higgsfield Cloud API credentials, same pattern as _anthropic-key.js.
//
// Do NOT import this from anything that ships to the browser. Today (no
// Supabase CLI access confirmed / Edge Functions not deployed) generate.js
// runs as a plain JS module invoked from a trusted context, the same way
// _anthropic-key.js reads from ../keys-and-deploy.md as a stand-in for a
// real secrets store.
//
// REAL DEPLOYMENT TODO: when generate.js moves to a Supabase Edge Function,
// delete this file entirely and read the credentials from
// `Deno.env.get('HF_CREDENTIALS')` after setting it via
// `supabase secrets set HF_CREDENTIALS=KEY_ID:KEY_SECRET` (or the Supabase
// dashboard's Edge Function secrets panel). Never bundle this file or its
// contents into client-side/browser code.

const fs = require('fs');
const path = require('path');

function higgsfieldCredentials() {
  if (process.env.HF_CREDENTIALS) return process.env.HF_CREDENTIALS;
  // Mirrors _anthropic-key.js: read from keys-and-deploy.md, two levels up
  // from this file (Tolerance Studios/../keys-and-deploy.md).
  const keysPath = path.resolve(__dirname, '..', '..', '..', 'keys-and-deploy.md');
  const txt = fs.readFileSync(keysPath, 'utf8');
  const idMatch = txt.match(/\*\*API Key ID:\*\*\s*`([^`]+)`/);
  const secretMatch = txt.match(/\*\*API Key Secret:\*\*\s*`([^`]+)`/);
  if (!idMatch || !secretMatch) {
    throw new Error('no Higgsfield API Key ID/Secret found in keys-and-deploy.md');
  }
  return `${idMatch[1]}:${secretMatch[1]}`;
}

module.exports = { higgsfieldCredentials };
