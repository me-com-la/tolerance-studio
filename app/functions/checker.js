// functions/checker.js — port of spec-checker/check_stage2.py + run_checker.py
// (spec-checker/README.md, run_checker.py) for the hosted pipeline.
//
// Stage 1 (check_stage1.py: resolution/sharpness/color code checks) is NOT
// ported here — it's a pure-image-bytes operation with no filesystem/DB
// dependency, so it can run client-side or in this same function unchanged;
// left as a TODO (see app/README.md) since it needs an image-processing lib
// (PIL equivalent) not yet chosen for the JS side.
//
// Stage 2 (vision compare against a spec) IS ported: sends the source photo
// + candidate render to a vision model, same instructions/schema shape as
// check_stage2.py, and writes the verdict onto the renders row —
// WITHOUT ever overwriting a row that has human_override set. This mirrors
// run_checker.py's sorting loop, which skips anything in the `overridden`
// bucket.
//
// SWITCHED FROM CLAUDE TO GEMINI (2026-07-09, Owner call): checker only ever
// ran on Standard (Pro has no checker.js) and was the last thing still
// calling Anthropic directly on that tier. Gemini 2.5 Flash-Lite is priced
// per-token an order of magnitude below claude-sonnet-5 and is multimodal
// natively (image input priced the same as text, no vision surcharge) — a
// QA-checklist read against a fixed list of tags doesn't need the strongest
// model available, unlike the generation step it's grading. Uses
// generationConfig.responseMimeType:"application/json" to get clean JSON
// back directly instead of Claude's find-the-braces text slicing.
//
// GUESS FLAGGED: 001_init.sql's projects table has no `spec` / `spec.json`
// column — spec-checker's per-SKU spec.json (code_checks, vision_checks,
// rules) has no home in the schema yet. I pass `spec` in as a parameter
// here (caller's responsibility to source it — e.g. from project.settings
// or a future `projects.spec jsonb` column) rather than inventing a new
// column myself, per the ground rule not to ALTER TABLE. Flagging this to
// the Owner in the final report — this is the biggest structural gap
// blocking a real checker run.
//
// TODAY: plain Node/CommonJS module for a trusted server context (same
// reasons as ai-draft.js — needs the Gemini key and raw image bytes).
// Edge Function migration note: swap key source, swap the image byte read
// (currently expects base64 already decoded/passed in, so this part barely
// changes), wrap in Deno.serve().

const https = require('https');

const MODEL = process.env.CHECKER_MODEL || 'gemini-3.5-flash'; // matches deployed supabase/functions/checker/index.ts
const API = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

function callGeminiVision(geminiKey, sourceImage, candidateImage, instructions) {
  // sourceImage / candidateImage: { mediaType: 'image/jpeg', base64: '...' }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{
        parts: [
          { text: 'IMAGE 1 — real product (ground truth):' },
          { inline_data: { mime_type: sourceImage.mediaType, data: sourceImage.base64 } },
          { text: 'IMAGE 2 — AI-generated candidate:' },
          { inline_data: { mime_type: candidateImage.mediaType, data: candidateImage.base64 } },
          { text: instructions },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json' },
    });
    const req = https.request(
      API,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': geminiKey,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const resp = JSON.parse(raw);
            if (resp.error) return reject(new Error(resp.error.message || 'Gemini API error'));
            const text = (resp.candidates || [])
              .flatMap((c) => c.content?.parts || [])
              .map((p) => p.text || '')
              .join('');
            if (!text) return reject(new Error('Gemini returned no text output'));
            resolve(text);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Runs stage-2 vision check for a single render against a spec, same verdict
 * rules as check_stage2.py:
 *   any severity:reject item failing        -> REJECT
 *   any item confidence < threshold (80)    -> HUMAN_REVIEW
 *   any severity:flag item failing          -> HUMAN_REVIEW
 *   else                                    -> PASS
 *
 * @param {object} deps - { geminiKey }
 * @param {object} params - { spec, sourceImage, candidateImage }
 *   spec: parsed spec.json shape { sku, variant, vision_checks:[{id,item,when_visible,severity}], rules:{confidence_below} }
 *   sourceImage / candidateImage: { mediaType, base64 } — caller resizes/encodes,
 *     same as check_stage2.py's b64() helper (downscale to 1568px, JPEG q90).
 */
async function checkStage2(deps, { spec, sourceImage, candidateImage }) {
  const { geminiKey } = deps;
  const checks = spec.vision_checks;
  const instructions = `You are a spec-accuracy QA inspector for AI-generated product imagery.
IMAGE 1 is the REAL product (ground truth). IMAGE 2 is an AI-generated candidate.
Judge IMAGE 2 against IMAGE 1 for each checklist item. The product must match
the real one exactly; scene/background/lighting style differences are allowed
unless an item says otherwise. Items have a "when_visible" condition: if the
relevant feature is not visible in IMAGE 2, return "n/a" for that item.
Be strict: subtle branding moves, invented hardware, warped pattern cells,
and color shifts are exactly what you exist to catch.

Checklist (JSON): ${JSON.stringify(checks)}

Respond with ONLY a JSON object:
{"items": [{"id": "...", "verdict": "pass|fail|n/a", "confidence": 0-100,
"reason": "one line"}], "overall_notes": "one or two lines",
"score": 0-100 — a single overall fidelity score for how closely IMAGE 2
matches IMAGE 1 against this checklist (100 = perfect match, 0 = completely
wrong product)}`;

  const text = await callGeminiVision(geminiKey, sourceImage, candidateImage, instructions);
  const result = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

  const sev = {};
  for (const c of checks) sev[c.id] = c.severity;
  const threshold = (spec.rules && spec.rules.confidence_below) || 80;

  let verdict = 'PASS';
  for (const it of result.items) {
    if (it.verdict === 'fail' && sev[it.id] === 'reject') {
      verdict = 'REJECT';
      break;
    }
  }
  if (verdict === 'PASS') {
    for (const it of result.items) {
      if (it.verdict === 'n/a') continue;
      if (it.confidence < threshold || (it.verdict === 'fail' && sev[it.id] === 'flag')) {
        verdict = 'HUMAN_REVIEW';
      }
    }
  }

  return {
    spec: `${spec.sku}/${spec.variant}`,
    model: MODEL,
    stage2_verdict: verdict,
    items: result.items,
    overall_notes: result.overall_notes || '',
    score: typeof result.score === 'number' ? Math.max(0, Math.min(100, Math.round(result.score))) : null,
  };
}

// Maps a stage2 result onto this app's renders.verdict vocabulary
// ('approved' | 'rejected'), matching run_checker.py's sort logic:
// any reject-severity failed item -> rejected; everything else (clean pass
// or low-confidence human-review) -> approved (flagged for a glance).
function toRenderVerdict(stage2Result) {
  return stage2Result.stage2_verdict === 'REJECT' ? 'rejected' : 'approved';
}

/**
 * Runs the checker for one render row and writes the result, respecting the
 * sticky human_override rule (never overwrites a row that has one set) —
 * same guard as run_checker.py's `overridden` bucket and server.py's
 * /checker-verdict comment.
 *
 * @param {object} deps - { geminiKey, db } — db is lib/db.js's exported object
 * @param {object} params - { renderId, spec, sourceImage, candidateImage }
 */
async function runCheckerForRender(deps, params) {
  const { db } = deps;
  const { renderId, spec, sourceImage, candidateImage } = params;
  const stage2Result = await checkStage2(deps, { spec, sourceImage, candidateImage });
  const verdict = toRenderVerdict(stage2Result);
  // db.setCheckerResult itself checks human_override and no-ops if set —
  // enforced in the data layer, not just here, so no other caller can
  // accidentally clobber a sticky override either.
  return db.setCheckerResult(renderId, { checker: stage2Result, verdict });
}

module.exports = { checkStage2, toRenderVerdict, runCheckerForRender };
