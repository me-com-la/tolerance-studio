// functions/generate.js — the real "Generate & check these scenes now" step.
// Node/CommonJS source-of-truth mirror of the deployed Deno function at
// supabase/functions/generate/index.ts — if you change one, change both.
//
// Provider history: Higgsfield (rejected — reference-accurate models were
// MCP/CLI-only, not reachable over REST; Soul was reachable but produced a
// wrong product on a live test) -> Gemini called directly (2026-07-06) ->
// fal.ai (2026-07-09, Owner rule: one provider — fal already pays for Bria
// image gen on Pro and Standard's text/vision calls). Image generation
// keeps the SAME underlying model (still "Nano Banana 2" / Gemini 3.1 Flash
// Image — chosen for product fidelity, same api-decision.md bake-off logic)
// but now goes through fal's hosted endpoint for that model instead of
// calling generativelanguage.googleapis.com with a Google key directly, so
// nothing in this app talks to Google or Anthropic's APIs anymore — only
// fal. Resolution stays capped at 2K (Owner call, 2026-07-07, bumped from
// the original 1K cap set 2026-07-06) — fal's `resolution` param, always
// "2K" here regardless of any project setting.
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
// the checker was hardcoded to mediaType 'image/png', but the model doesn't
// always return PNG bytes — it returned a real JPEG once, and a vision API
// that validates the actual byte signature against the declared media type
// rejects a mismatch outright. Fixed by capturing and using the model's own
// reported mimeType for both the storage upload's contentType and the
// checker call, never assuming a fixed format.
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
// fal's hosted slug for the same Gemini 3.1 Flash Image ("Nano Banana 2")
// model Standard has always generated with — same model, different pipe.
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'fal-ai/gemini-3.1-flash-image-preview/edit';
const MAX_REFERENCE_IMAGES = 3;
const CHECKER_MODEL = process.env.CHECKER_MODEL || 'anthropic/claude-haiku-4.5'; // matches deployed supabase/functions/generate/index.ts

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

// Submits a job to fal's async queue and polls it to completion — same
// proven pattern as tools/pixel-lock/service.py's bria_genfill().
function falQueueRun(falKey, model, body) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const { status, json: submitted } = await httpsJson(`https://queue.fal.run/${model}`, { Authorization: `Key ${falKey}` }, body);
        if (status < 200 || status >= 300) throw new Error(`fal submit error: ${JSON.stringify(submitted).slice(0, 300)}`);
        const { status_url, response_url } = submitted;
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const st = await httpsGet(status_url, { Authorization: `Key ${falKey}` });
          if (st.json.status === 'COMPLETED') {
            const rr = await httpsGet(response_url, { Authorization: `Key ${falKey}` });
            if (rr.status < 200 || rr.status >= 300) throw new Error(`fal result error: ${JSON.stringify(rr.json).slice(0, 300)}`);
            return resolve(rr.json);
          }
          if (st.json.status === 'ERROR' || st.json.status === 'FAILED') {
            throw new Error(`fal generation failed: ${JSON.stringify(st.json).slice(0, 300)}`);
          }
        }
        throw new Error('fal generation timed out after 120s');
      } catch (e) { reject(e); }
    })();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * Generates one shot's image via fal (Gemini 3.1 Flash Image / "Nano Banana
 * 2", same model as before — see header), grounded on 1-3 real reference
 * photos. Returns { bytes: Buffer, mimeType: string } — mimeType is
 * whatever fal actually reports, never assumed.
 */
async function generateShotImage(falKey, { prompt, aspectRatio, referenceImages }) {
  const image_urls = referenceImages.map((img) => `data:${img.mimeType};base64,${img.base64}`);
  const result = await falQueueRun(falKey, IMAGE_MODEL, {
    prompt,
    image_urls,
    aspect_ratio: aspectRatio || '1:1',
    resolution: '2K', // cap, Owner rule (raised from 1K 2026-07-07)
    output_format: 'png',
  });
  const img = (result.images || [])[0];
  if (!img || !img.url) throw new Error(`fal returned no image: ${JSON.stringify(result).slice(0, 300)}`);
  const { status, buffer } = await new Promise((resolve, reject) => {
    require('https').get(img.url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  if (status < 200 || status >= 300) throw new Error(`failed to download generated image: HTTP ${status}`);
  return { bytes: buffer, mimeType: img.content_type || 'image/png' };
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

// Checker consolidated onto fal (2026-07-09, Owner rule: one provider),
// same switch as functions/checker.js — see that file's header for the
// reasoning. Reuses the same falKey generation already needs.
async function callFalVision(falKey, sourceImage, candidateImage, instructions) {
  const { json: resp } = await httpsJson(
    'https://fal.run/openrouter/router/openai/v1/chat/completions',
    { Authorization: `Key ${falKey}` },
    {
      model: CHECKER_MODEL,
      max_tokens: 2000,
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
    },
  );
  if (resp.error) throw new Error(resp.error.message || 'fal.ai API error');
  const text = (resp.choices || []).map((c) => (c.message && c.message.content) || '').join('');
  if (!text) throw new Error('fal returned no text output');
  return text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
}

async function runCheckerInline(falKey, spec, sourceImage, candidateImage) {
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

  const text = await callFalVision(falKey, sourceImage, candidateImage, instructions);
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
    score: typeof result.score === 'number' ? Math.max(0, Math.min(100, Math.round(result.score))) : null,
  };
  const verdict = stage2Verdict === 'REJECT' ? 'rejected' : 'approved';
  return { checker: checkerResult, verdict };
}

/**
 * Generates every shot in project.shots.items via fal, uploads each
 * result into Supabase storage, auto-checks it, and upserts a `renders` row
 * per shot.
 *
 * @param {object} deps - { falKey, db } — checker now reuses falKey too
 *   (see functions/checker.js header, 2026-07-09 switch to fal)
 * @param {object} params - { project } — full project row from db.getProject
 * @returns {Promise<{ok:boolean, generated:number, checked:number, failed:Array}>}
 */
async function generateProjectRenders(deps, params) {
  const { falKey, db } = deps;
  const { project } = params;

  const shots = project.shots;
  if (!shots || !shots.items || !shots.items.length) {
    return { ok: false, error: 'no expanded shots to generate — run Expand shots first' };
  }
  const clientSlug = project.clients && project.clients.slug;
  if (!clientSlug) return { ok: false, error: 'project has no client slug — cannot build a storage path' };

  // Beta cap: at most MAX_IMAGES_PER_PROJECT images per project, counting
  // renders that already exist (re-generating the same filename replaces its
  // row via the upsert below, so the count stays honest). Owner rule 2026-07-07.
  const MAX_IMAGES_PER_PROJECT = parseInt(process.env.MAX_IMAGES_PER_PROJECT || '10', 10);
  const existingRenders = await db.countRenders(project.id);
  const remainingQuota = MAX_IMAGES_PER_PROJECT - (existingRenders || 0);
  if (remainingQuota <= 0) {
    return { ok: false, error: `Beta limit reached: ${MAX_IMAGES_PER_PROJECT} images per project. Start a new project to keep going.` };
  }
  let capNote = '';
  if (shots.items.length > remainingQuota) {
    shots.items = shots.items.slice(0, remainingQuota);
    capNote = ` Beta cap: ran ${remainingQuota} of the requested shots (${MAX_IMAGES_PER_PROJECT} images max per project).`;
  }

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
  if (falKey && project.reference_image) {
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
    const { bytes, mimeType } = await generateShotImage(falKey, { prompt, aspectRatio, referenceImages });

    const filename = /\.[a-z0-9]+$/i.test(item.file) ? item.file : `${item.file}.png`;
    const path = db.storagePath(clientSlug, project.id, 'renders', filename);
    await db.uploadFile(path, bytes, mimeType);

    let checkNote = 'not checked (no reference photo or fal key set)';
    let checkerFields = {};
    if (checkerReferenceImage && falKey) {
      try {
        const candidateImage = { mediaType: mimeType, base64: bytes.toString('base64') };
        const { checker, verdict } = await runCheckerInline(falKey, spec, checkerReferenceImage, candidateImage);
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
    `${succeeded.length}/${shots.items.length} shots generated via fal ` +
    `(${IMAGE_MODEL}, ${aspectRatio}, 2K cap, ${referenceImages.length} reference photo${referenceImages.length === 1 ? '' : 's'}), ${checkedCount} auto-checked.` +
    (failed.length ? ` Failed: ${failed.map((f) => `${f.file} (${f.error})`).join('; ')}` : '') + capNote;
  await db.createRunLogEntry(project.id, 'generate', summary);

  return { ok: failed.length === 0, generated: succeeded.length, checked: checkedCount, failed };
}

module.exports = { generateProjectRenders, generateShotImage, fullPrompt, mapWithConcurrency, buildSpecFromTags, runCheckerInline };
