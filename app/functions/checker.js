// functions/checker.js — Node-flavored mirror of the deployed
// supabase/functions/checker/index.ts (Deno). Keep these in sync by hand —
// if you edit one, mirror the change in the other. Source of truth for what
// is actually LIVE is always the deployed index.ts (pulled via the
// Management REST API GET .../functions/checker/body), not this file.
//
// STANDARD CHECKER — "7-point inspection" model (rebuilt 2026-07-10).
//
// The inspection is a FIXED set of seven named points (Shape, Color,
// Materials, Details, Clarity, Lighting, Scene). The names never change —
// that consistency is the marketing asset. What each point *means* for a
// given brand comes from that brand's declared truths (the weighted brief
// tags), fed in as the per-point standard.
//
// Two numbers come out, kept separate on purpose:
//   • SCORE — "X of 7 verified" — countable, reproducible, the public number.
//   • GATE  — PASS / HUMAN_REVIEW / REJECT — driven by whether a must-have or
//     should-have brand truth failed. A high score can still Hold if the one
//     thing wrong is critical.
//
// On top, the model writes in a direct creative-director voice: a short
// headline, a 2-3 sentence note, and a suggested_fix that pre-loads the redo.
//
// Response shape written to renders.checker (superset of the old shape, so
// existing readers keep working):
//   { spec, stage2_verdict, score, verified, applicable,
//     points:[{key,name,blurb,verdict,reason}],   // the seven, always present
//     headline, note, suggested_fix,
//     items:[{id,item,verdict,reason}],            // per declared truth (gate + callouts)
//     overall_notes }                              // == note, back-compat
//
// Sticky human_override rule preserved exactly (never overwrites a row that
// has one set — mirrors run_checker.py's `overridden` bucket and
// db.setCheckerResult()). Provider unchanged: fal.ai OpenRouter chat
// endpoint, model Claude Haiku 4.5.
//
// TODAY: plain Node/CommonJS module for a trusted server context (same
// reasons as ai-draft.js — needs the fal.ai key and raw image bytes).

const https = require('https');

const MODEL = process.env.CHECKER_MODEL || 'anthropic/claude-haiku-4.5'; // matches deployed supabase/functions/checker/index.ts
const API = 'https://fal.run/openrouter/router/openai/v1/chat/completions';

// The seven fixed inspection points — constant across every brand and both
// tiers. Names + blurbs live here so the report/card can render them straight
// from the stored result.
const POINTS = [
  { key: 'shape', name: 'Shape', blurb: 'Silhouette, structure, and proportions match your product.' },
  { key: 'color', name: 'Color', blurb: 'Colors match the real thing.' },
  { key: 'materials', name: 'Materials', blurb: 'Surface, texture, sheen, and pattern read true.' },
  { key: 'details', name: 'Details', blurb: 'Logos, hardware, closures, seams, and text are correct and undistorted.' },
  { key: 'clarity', name: 'Clarity', blurb: 'Sharp and clean — no artifacts or warping.' },
  { key: 'lighting', name: 'Lighting', blurb: 'Believable light direction, shadows, and reflections.' },
  { key: 'scene', name: 'Scene', blurb: 'The product sits naturally in its setting, not pasted on.' },
];

function callFalVision(falKey, sourceImage, candidateImage, instructions) {
  // sourceImage / candidateImage: { mediaType: 'image/jpeg', base64: '...' }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 2800,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'IMAGE 1 — real product (ground truth):' },
          { type: 'image_url', image_url: { url: `data:${sourceImage.mediaType};base64,${sourceImage.base64}` } },
          { type: 'text', text: 'IMAGE 2 — AI-generated candidate:' },
          { type: 'image_url', image_url: { url: `data:${candidateImage.mediaType};base64,${candidateImage.base64}` } },
          { type: 'text', text: instructions },
        ],
      }],
    });
    const req = https.request(
      API,
      {
        method: 'POST',
        headers: {
          Authorization: `Key ${falKey}`,
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
            if (resp.error) return reject(new Error(resp.error.message || 'fal.ai API error'));
            const text = (resp.choices || []).map((c) => (c.message && c.message.content) || '').join('');
            if (!text) return reject(new Error('fal returned no text output'));
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

function toRenderVerdict(stage2Verdict) {
  return stage2Verdict === 'REJECT' ? 'rejected' : 'approved';
}

function fallbackHeadline(tier) {
  if (tier === 'REJECT') return 'Hold — off-brand';
  if (tier === 'HUMAN_REVIEW') return 'One fix from ready';
  return 'Send-ready';
}

/**
 * Runs the 7-point inspection for a single render against a spec.
 *
 * @param {object} deps - { falKey }
 * @param {object} params - { spec, sourceImage, candidateImage }
 *   spec: { sku, variant, vision_checks:[{id,item,when_visible,severity}], rules:{confidence_below} }
 *   sourceImage / candidateImage: { mediaType, base64 }
 */
async function checkStage2(deps, { spec, sourceImage, candidateImage }) {
  const { falKey } = deps;
  const truths = spec.vision_checks || [];

  const instructions = `You are a working creative director reviewing an AI-generated product image before it goes to a client. You are direct and specific — never gushing, never padding.

IMAGE 1 is the REAL product (ground truth). IMAGE 2 is the AI-generated candidate. The product in IMAGE 2 must match the real one; scene and lighting *style* may differ unless a brand truth says otherwise.

Run a fixed 7-POINT INSPECTION. Judge each point against IMAGE 1:
${POINTS.map((p) => `- ${p.name}: ${p.blurb}`).join('\n')}

This brand's declared truths (use them as the specific standard for the points they touch): ${JSON.stringify(truths)}

For each point give: "pass" (verified), "attention" (minor issue), "fail" (clearly wrong), or "na" (can't be judged in this shot). Be strict — subtle color shifts, warped patterns, garbled text, invented hardware, and pasted-on lighting are exactly what you catch.

Also rule on each declared truth: "pass", "fail", or "na".

Then speak to the brand owner like their creative director: name the specific thing that's off (or confirm it's right), in plain words. If a fix is needed, write a one-line redo instruction they could hand straight to the generator.

Respond with ONLY this JSON:
{
  "points": [{"key": "shape|color|materials|details|clarity|lighting|scene", "verdict": "pass|attention|fail|na", "reason": "one short line"}],
  "truths": [{"id": "...", "verdict": "pass|fail|na"}],
  "headline": "at most 6 words, e.g. 'Send-ready' or 'One fix: color'",
  "note": "2-3 sentences, first person, direct",
  "suggested_fix": "one-line redo instruction, or empty string"
}`;

  const text = await callFalVision(falKey, sourceImage, candidateImage, instructions);
  const result = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

  // Normalize the model's points back onto the fixed seven, in order. A point
  // the model skipped defaults to 'na' so the inspection is always complete
  // (seven rows, every time).
  const byKey = {};
  for (const p of Array.isArray(result.points) ? result.points : []) byKey[p.key] = p;
  const points = POINTS.map((p) => {
    const got = byKey[p.key] || {};
    const v = ['pass', 'attention', 'fail', 'na'].includes(got.verdict) ? got.verdict : 'na';
    return { key: p.key, name: p.name, blurb: p.blurb, verdict: v, reason: (got.reason || '').trim() };
  });

  // COUNTABLE SCORE — points verified ÷ points applicable (of seven). This is
  // the number that goes public. Only "pass" counts as verified.
  const applicableP = points.filter((p) => p.verdict !== 'na');
  const verifiedP = applicableP.filter((p) => p.verdict === 'pass');
  const applicable = applicableP.length;
  const verified = verifiedP.length;
  const score = applicable > 0 ? Math.round((verified / applicable) * 100) : null;

  // Per-truth results, tagged with their human-readable text for callouts.
  const sev = {};
  const truthText = {};
  for (const t of truths) { sev[t.id] = t.severity; truthText[t.id] = t.item; }
  const truthResults = Array.isArray(result.truths) ? result.truths : [];
  const items = truthResults.map((t) => ({
    id: t.id,
    item: truthText[t.id] || t.id,
    verdict: ['pass', 'fail', 'na'].includes(t.verdict) ? t.verdict : 'na',
    reason: '',
  }));

  // GATE — derived, deterministic:
  //   a failed must-have truth   -> REJECT
  //   a failed should-have truth -> HUMAN_REVIEW
  //   no declared truths? fall back to the points: any 'fail' -> HUMAN_REVIEW
  //   else                       -> PASS
  let stage2Verdict = 'PASS';
  if (items.length > 0) {
    for (const it of items) { if (it.verdict === 'fail' && sev[it.id] === 'reject') stage2Verdict = 'REJECT'; }
    if (stage2Verdict === 'PASS') {
      for (const it of items) { if (it.verdict === 'fail' && sev[it.id] === 'flag') stage2Verdict = 'HUMAN_REVIEW'; }
    }
  } else {
    if (points.some((p) => p.verdict === 'fail')) stage2Verdict = 'HUMAN_REVIEW';
  }

  let headline = typeof result.headline === 'string' ? result.headline.trim() : '';
  if (!headline || headline.length > 42) headline = fallbackHeadline(stage2Verdict);
  const note = typeof result.note === 'string' ? result.note.trim() : '';
  const suggested_fix = typeof result.suggested_fix === 'string' ? result.suggested_fix.trim() : '';

  return {
    spec: `${spec.sku}/${spec.variant}`,
    stage2_verdict: stage2Verdict,
    score,
    verified,
    applicable,
    points,
    headline,
    note,
    suggested_fix,
    items,
    overall_notes: note, // back-compat: old gallery read overall_notes
  };
}

// Maps a stage2 result onto this app's renders.verdict vocabulary
// ('approved' | 'rejected'), matching run_checker.py's sort logic.
function toRenderVerdictFromResult(stage2Result) {
  return toRenderVerdict(stage2Result.stage2_verdict);
}

/**
 * Runs the checker for one render row and writes the result, respecting the
 * sticky human_override rule (never overwrites a row that has one set) —
 * same guard as run_checker.py's `overridden` bucket and server.py's
 * /checker-verdict comment.
 *
 * @param {object} deps - { falKey, db } — db is lib/db.js's exported object
 * @param {object} params - { renderId, spec, sourceImage, candidateImage }
 */
async function runCheckerForRender(deps, params) {
  const { db } = deps;
  const { renderId, spec, sourceImage, candidateImage } = params;
  const stage2Result = await checkStage2(deps, { spec, sourceImage, candidateImage });
  const verdict = toRenderVerdictFromResult(stage2Result);
  // db.setCheckerResult itself checks human_override and no-ops if set —
  // enforced in the data layer, not just here, so no other caller can
  // accidentally clobber a sticky override either.
  return db.setCheckerResult(renderId, { checker: stage2Result, verdict });
}

module.exports = { POINTS, checkStage2, toRenderVerdict: toRenderVerdictFromResult, runCheckerForRender };
