// functions/generate.js — the real "Generate & check these scenes now" step.
// Node/CommonJS source-of-truth mirror of the deployed Deno function at
// supabase/functions/generate/index.ts — if you change one, change both.
//
// SWITCHED FROM HIGGSFIELD TO GEMINI (2026-07-06) — after exhausting every
// REST path/slug guess against platform.higgsfield.ai, confirmed from four
// independent sources that the reference-accurate models
// (marketing_studio_image, ms_image, nano_banana_2, gpt_image_2/
// product-photoshoot) are MCP/CLI-only, not exposed on the developer REST
// API our Higgsfield key can reach. Only Soul was reachable there, and a
// live test against the real Kindtail crate photo produced a WRONG PRODUCT
// (generic crate, none of the honeycomb/color detail held) — confirmed
// useless for this pipeline's whole reason to exist (spec accuracy).
//
// Gemini's own native image model (marketed as "Nano Banana") does the same
// job directly over plain REST with an API key, no CLI, no MCP layer.
// Live-tested against two real, very different products (the Kindtail
// crate, and a much harder case — an asymmetric geometric wood vase with a
// triangular cutout, round dowel accent, and incised lines) — both held
// product identity faithfully.
//
// Model: gemini-3.1-flash-image ("Nano Banana 2") — chosen over the cheaper
// gemini-3.1-flash-lite-image for product-fidelity reasons (Owner call,
// same logic as the real api-decision.md bake-off: pay for the model that
// holds detail). Resolution HARD-CAPPED at 1K (Owner rule, 2026-07-06) —
// imageConfig.imageSize is always "1K" regardless of any project setting.
// Field name verified empirically (not trusted from a fetched summary that
// separately fabricated a nonexistent "/v1beta/interactions" endpoint):
// requesting imageSize:"2K" in a live call returned an actual 2048x2048
// image versus the default 1024x1024 with no size field set.
//
// Multi-reference rule (from the real api-decision.md, 2026-07-06 note):
// "for complex products (anything with a door, hinge, or asymmetric
// feature): pass 2-3 reference photos". Rather than add a new schema list
// column, this reads every file already sitting in
// <client-slug>/<project-id>/assets/ (the New Project modal already
// supports uploading several) and passes up to MAX_REFERENCE_IMAGES of them
// as separate inline_data parts alongside the prompt. project.reference_image
// (single canonical path) still exists separately and is what the checker
// uses as its one ground-truth image, so verdicts stay comparable across a
// whole batch even though generation may see a fuller reference set.
//
// BUG FIXED DURING LIVE TESTING (2026-07-06): the candidate image handed to
// the checker was hardcoded to mediaType 'image/png', but Gemini doesn't
// always return PNG bytes — it returned a real JPEG once, and Anthropic's
// vision API validates the actual byte signature against the declared
// media_type and rejects a mismatch outright ("the image appears to be a
// image/jpeg image"). Fixed by capturing and using Gemini's own reported
// mimeType for both the storage upload's contentType and the checker call,
// never assuming a fixed format.
//
// Auto-chains the checker (added 2026-07-06, same day as the Higgsfield ->
// Gemini switch): the old tool ran generation and checking together as one
// batch ("ran step 3 automatically per the standing rule" per the real Blue
// campaign run log). This function reuses each shot's bytes already in
// memory as the checker's candidate image, no re-fetch needed.

// Note: `db.listFiles`/`db.downloadFile`/`db.uploadFile(path,bytes,mimeType)`
// below describe the shape this function needs, mirroring the deployed Deno
// version's direct supabase-js calls — they aren't a 1:1 call-through to the
// browser's lib/db.js (which has getSignedUrl/listFiles but no
// downloadFile, and uploadFile takes no mimeType arg). This file has never
// been executed as-is; the deployed Deno function is the real, tested path.

const https = require('https');

const CONCURRENCY = parseInt(process.env.GENERATE_CONCURRENCY || '4', 10);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-image';
const MAX_REFERENCE_IMAGES = 3;
const CHECKER_MODEL = process.env.CHECKER_MODEL || 'claude-sonnet-5';

function fullPrompt(shots, item) {
  const parts = [shots.product_lock, shots.style_lock, item.prompt].map((s) => (s || '').trim()).filter(Boolean);
  return parts.join('\n\n');
}

function httpsJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      url,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Generates one shot's image via Gemini, grounded on 1-3 real reference
 * photos. Returns { bytes: Buffer, mimeType: string } — mimeType is
 * whatever Gemini actually reports, never assumed.
 */
async function generateShotImage(geminiKey, { prompt, aspectRatio, referenceImages }) {
  const parts = [{ text: prompt }];
  for (const img of referenceImages) parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: aspectRatio || '1:1', imageSize: '1K' }, // hard cap, Owner rule
    },
  };
  const { status, json: resp } = await httpsJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    { 'x-goog-api-key': geminiKey },
    body,
  );
  if (status < 200 || status >= 300) throw new Error(`Gemini error: ${resp.error?.message || status}`);
  for (const c of resp.candidates || []) {
    for (const part of c.content?.parts || []) {
      if (part.inlineData) return { bytes: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType || 'image/png' };
    }
  }
  throw new Error('Gemini returned no image data');
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await worker(items[i], i) }; }
      catch (err) { results[i] = { ok: false, error: err }; }
    }
  }
  const lanes = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(lanes);
  return results;
}

// ---------- checker logic (mirrors functions/checker.js — see its header) ----------

function buildSpecFromTags(project) {
  // Product tags only — the checker verifies the PRODUCT matches the real
  // one; creative tags (mood/background/style) are intentionally excluded
  // from pass/fail checks, since scene/background/lighting differences are
  // allowed per the checker's own instructions below. Folding creative
  // "must" tags in here used to reject-out otherwise-correct renders over
  // style mismatches, not product accuracy.
  const all = project.tags?.product || [];
  const vision_checks = all
    .filter((t) => t.w === 'must' || t.w === 'should')
    .map((t, i) => ({
      id: `${t.w}_${i}_${t.t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')}`.slice(0, 60),
      item: t.t,
      when_visible: true,
      severity: t.w === 'must' ? 'reject' : 'flag',
    }));
  return {
    sku: (project.product || project.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    variant: project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    vision_checks,
    rules: { confidence_below: 80 },
  };
}

async function callClaudeVision(anthropicKey, sourceImage, candidateImage, instructions) {
  const { json: resp } = await httpsJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    {
      model: CHECKER_MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'IMAGE 1 — real product (ground truth):' },
          { type: 'image', source: { type: 'base64', media_type: sourceImage.mediaType, data: sourceImage.base64 } },
          { type: 'text', text: 'IMAGE 2 — AI-generated candidate:' },
          { type: 'image', source: { type: 'base64', media_type: candidateImage.mediaType, data: candidateImage.base64 } },
          { type: 'text', text: instructions },
        ],
      }],
    },
  );
  if (resp.error) throw new Error(resp.error.message || 'Anthropic API error');
  const text = (resp.content || []).map((b) => b.text || '').join('');
  return text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
}

async function runCheckerInline(anthropicKey, spec, sourceImage, candidateImage) {
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
"reason": "one line"}], "overall_notes": "one or two lines"}`;

  const text = await callClaudeVision(anthropicKey, sourceImage, candidateImage, instructions);
  const result = JSON.parse(text);

  const sev = {};
  for (const c of checks) sev[c.id] = c.severity;
  const threshold = (spec.rules && spec.rules.confidence_below) || 80;

  let stage2Verdict = 'PASS';
  for (const it of result.items) {
    if (it.verdict === 'fail' && sev[it.id] === 'reject') { stage2Verdict = 'REJECT'; break; }
  }
  if (stage2Verdict === 'PASS') {
    for (const it of result.items) {
      if (it.verdict === 'n/a') continue;
      if (it.confidence < threshold || (it.verdict === 'fail' && sev[it.id] === 'flag')) stage2Verdict = 'HUMAN_REVIEW';
    }
  }

  const checkerResult = {
    spec: `${spec.sku}/${spec.variant}`, model: CHECKER_MODEL, stage2_verdict: stage2Verdict,
    items: result.items, overall_notes: result.overall_notes || '',
  };
  const verdict = stage2Verdict === 'REJECT' ? 'rejected' : 'approved';
  return { checker: checkerResult, verdict };
}

/**
 * Generates every shot in project.shots.items via Gemini, uploads each
 * result into Supabase storage, auto-checks it, and upserts a `renders` row
 * per shot.
 *
 * @param {object} deps - { geminiKey, anthropicKey, db }
 * @param {object} params - { project } — full project row from db.getProject
 * @returns {Promise<{ok:boolean, generated:number, checked:number, failed:Array}>}
 */
async function generateProjectRenders(deps, params) {
  const { geminiKey, anthropicKey, db } = deps;
  const { project } = params;

  const shots = project.shots;
  if (!shots || !shots.items || !shots.items.length) {
    return { ok: false, error: 'no expanded shots to generate — run Expand shots first' };
  }
  const clientSlug = project.clients && project.clients.slug;
  if (!clientSlug) return { ok: false, error: 'project has no client slug — cannot build a storage path' };

  const aspectRatio = (project.settings && project.settings.generation_aspect) || '1:1';
  const spec = buildSpecFromTags(project);

  // Multi-reference rule: every asset photo (up to MAX_REFERENCE_IMAGES),
  // used to ground generation. Falls back to reference_image alone if the
  // assets listing is empty (projects seeded before the multi-upload modal).
  const referenceImages = [];
  try {
    const files = (await db.listFiles(`${clientSlug}/${project.id}/assets`)).filter((f) => f.id).slice(0, MAX_REFERENCE_IMAGES);
    for (const f of files) {
      const buf = await db.downloadFile(`${clientSlug}/${project.id}/assets/${f.name}`);
      referenceImages.push({ mimeType: buf.mimeType, base64: buf.bytes.toString('base64') });
    }
  } catch (_e) { /* fall through to reference_image-only below */ }

  // Reference photo used by the CHECKER specifically — one fixed image so
  // every shot in the batch is judged against the same ground truth.
  let checkerReferenceImage = null;
  if (anthropicKey && project.reference_image) {
    try {
      const buf = await db.downloadFile(project.reference_image);
      checkerReferenceImage = { mediaType: buf.mimeType, base64: buf.bytes.toString('base64') };
    } catch (_e) { /* no reference photo available — checking is skipped per-shot below */ }
  }
  if (!referenceImages.length && checkerReferenceImage) {
    referenceImages.push({ mimeType: checkerReferenceImage.mediaType, base64: checkerReferenceImage.base64 });
  }

  const outcomes = await mapWithConcurrency(shots.items, CONCURRENCY, async (item) => {
    const prompt = fullPrompt(shots, item);
    const { bytes, mimeType } = await generateShotImage(geminiKey, { prompt, aspectRatio, referenceImages });

    const filename = /\.[a-z0-9]+$/i.test(item.file) ? item.file : `${item.file}.png`;
    const path = db.storagePath(clientSlug, project.id, 'renders', filename);
    await db.uploadFile(path, bytes, mimeType);

    let checkNote = 'not checked (no reference photo or Anthropic key set)';
    let checkerFields = {};
    if (checkerReferenceImage && anthropicKey) {
      try {
        const candidateImage = { mediaType: mimeType, base64: bytes.toString('base64') };
        const { checker, verdict } = await runCheckerInline(anthropicKey, spec, checkerReferenceImage, candidateImage);
        checkerFields = { checker, verdict };
        checkNote = `checked: ${checker.stage2_verdict}`;
      } catch (checkErr) {
        checkNote = `check failed: ${checkErr.message || String(checkErr)}`;
      }
    }

    const render = await db.upsertRender(project.id, filename, { storage_path: path, stage: 'render', ...checkerFields });
    return { file: filename, path, render, checkNote };
  });

  const succeeded = [];
  const failed = [];
  outcomes.forEach((outcome, i) => {
    const item = shots.items[i];
    if (outcome.ok) succeeded.push(outcome.value);
    else failed.push({ file: item.file, motif: item.motif, error: outcome.error.message || String(outcome.error) });
  });

  await db.saveStatus(project.id, 'checking');

  const checkedCount = succeeded.filter((s) => s.checkNote.startsWith('checked')).length;
  const summary =
    `${succeeded.length}/${shots.items.length} shots generated via Gemini ` +
    `(${GEMINI_MODEL}, ${aspectRatio}, 1K cap, ${referenceImages.length} reference photo${referenceImages.length === 1 ? '' : 's'}), ${checkedCount} auto-checked.` +
    (failed.length ? ` Failed: ${failed.map((f) => `${f.file} (${f.error})`).join('; ')}` : '');
  await db.createRunLogEntry(project.id, 'generate', summary);

  return { ok: failed.length === 0, generated: succeeded.length, checked: checkedCount, failed };
}

module.exports = { generateProjectRenders, generateShotImage, fullPrompt, mapWithConcurrency, buildSpecFromTags, runCheckerInline };
