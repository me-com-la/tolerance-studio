// functions/_anthropic-key.js — SERVER-SIDE-ONLY placeholder for the Anthropic key.
//
// Do NOT import this from anything that ships to the browser. Today (phase 1b,
// no Supabase CLI access confirmed / Edge Functions not deployed) ai-draft.js,
// expand-shots.js, and checker.js run as plain JS invoked from a trusted
// context (e.g. a local Node script, or manually by the Owner), the same way
// server.py currently reads the key from ../keys-and-deploy.md.
//
// REAL DEPLOYMENT TODO: when these move to Supabase Edge Functions, delete
// this file entirely and read the key from `Deno.env.get('ANTHROPIC_API_KEY')`
// after setting it via `supabase secrets set ANTHROPIC_API_KEY=...` (or the
// Supabase dashboard's Edge Function secrets panel). Never bundle this file
// or its contents into client-side/browser code.

const fs = require('fs');
const path = require('path');

function anthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  // Mirrors server.py's anthropic_key(): read from keys-and-deploy.md,
  // two levels up from this file (Tolerance Studios/../keys-and-deploy.md).
  const keysPath = path.resolve(__dirname, '..', '..', '..', 'keys-and-deploy.md');
  const txt = fs.readFileSync(keysPath, 'utf8');
  const m = txt.match(/(sk-ant-[A-Za-z0-9_-]+)/);
  if (!m) throw new Error('no Anthropic API key found in keys-and-deploy.md');
  return m[1];
}

module.exports = { anthropicKey };
