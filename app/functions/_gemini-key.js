// functions/_gemini-key.js — SERVER-SIDE-ONLY placeholder for the Gemini key.
// Same pattern as _anthropic-key.js: today these run as plain JS in a
// trusted context, so the key is read straight from keys-and-deploy.md.
//
// REAL DEPLOYMENT TODO: when this moves to a Supabase Edge Function, delete
// this file and read `Deno.env.get('GEMINI_API_KEY')` instead (set via
// `supabase secrets set GEMINI_API_KEY=...`). Never bundle this file or its
// contents into client-side/browser code.

const fs = require('fs');
const path = require('path');

function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const keysPath = path.resolve(__dirname, '..', '..', '..', 'keys-and-deploy.md');
  const txt = fs.readFileSync(keysPath, 'utf8');
  const m = txt.match(/\*\*API key:\*\* `(AQ\.[A-Za-z0-9_-]+)`/);
  if (!m) throw new Error('no Gemini API key found in keys-and-deploy.md');
  return m[1];
}

module.exports = { geminiKey };
