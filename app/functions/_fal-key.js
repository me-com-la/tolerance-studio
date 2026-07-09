// functions/_fal-key.js — SERVER-SIDE-ONLY placeholder for the fal.ai key.
//
// Do NOT import this from anything that ships to the browser. Mirrors
// _anthropic-key.js's pattern: today these run as plain JS invoked from a
// trusted context; on Supabase this becomes `Deno.env.get('FAL_KEY')` after
// `supabase secrets set FAL_KEY=...`.

const fs = require('fs');
const path = require('path');

function falKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  const keysPath = path.resolve(__dirname, '..', '..', '..', 'keys-and-deploy.md');
  const txt = fs.readFileSync(keysPath, 'utf8');
  const m = txt.match(/\*\*API key:\*\* `([0-9a-f-]+:[0-9a-f]+)`/);
  if (!m) throw new Error('no fal.ai API key found in keys-and-deploy.md');
  return m[1];
}

module.exports = { falKey };
