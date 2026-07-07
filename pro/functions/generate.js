// functions/generate.js — app-composite fork of the pipeline's generate step.
//
// WHY THIS FORK EXISTS (2026-07-06): the main app/functions/generate.js sends
// the product's reference photos INTO Gemini and asks it to regenerate the
// whole shot. That's fast and often close, but it is never pixel-exact — the
// model is free to redraw the product, and did (wrong product, garbled
// embossing, warped pattern cells — see api-decision.md across several real
// campaigns). This fork tests the opposite approach the Owner asked to
// revisit: NEVER let a generative model touch the product's pixels.
//
//   1. Generate ONLY the background/scene from the shot prompt — no product
//      reference image goes into this call at all, so there's nothing for
//      the model to get wrong about the product (it doesn't know it exists).
//   2. Composite the project's real product CUTOUT (a pre-made
//      transparent-background PNG of the actual photographed product — same
//      artifact as clients/<Client>/products/<Product>/originals/*-cutout.png)
//      on top, pixel-for-pixel. The only transforms allowed are uniform
//      scale and x/y position (per shot, via item.placement) — never
//      rotation, never a perspective warp, never a re-render. That's the
//      "preserve the angle" rule: the product was photographed at some
//      angle, and the only way to guarantee it stays that exact angle,
//      undistorted, is to never ask a generative model to redraw it.
//
// Adobe Firefly's generative-expand would normally be the tool for "extend a
// background around a fixed subject" (see tools/compose.py's header + the
// 2026-07-04 firefly-vs-higgsfield test) but this app is required to stay
// isolated from the Adobe MCP/Firefly toolchain — Owner call, 2026-07-06.
// Gemini and Seedream are the only generation APIs available here, and
// neither does masked/region compositing server-side, so the compositing
// itself happens locally in this function after the background comes back,
// not as part of the generation API call.
//
// Deployed Deno function would do the actual pixel compositing with
// https://deno.land/x/imagescript (pure-Deno PNG decode/resize/draw, no
// native deps — Deno Edge Functions can't install sharp/libvips). This Node
// file mirrors the same logic with the Node equivalent (`sharp`) but, same
// as the main app's generate.js, has never been executed as-is — the
// deployed Deno version is the real, tested path. If you change one, mirror
// the change in the other (see app-composite/README.md).
//
// SEEDREAM: no Seedream account/endpoint has been wired yet — GENERATION_MODEL
// defaults to 'gemini'. Flagging rather than guessing at a Seedream REST
// contract: ask the Owner for the real endpoint + key before adding a
// 'seedream' branch to generateBackgroundImage().

const https = require('https');
const sharp = require('sharp'); // Node mirror only — Deno path uses imagescript, see header

const CONCURRENCY = parseInt(process.env.GENERATE_CONCURRENCY || '4', 10);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-image';
const GENERATION_MODEL = process.env.GENERATION_MODEL || 'gemini'; // 'gemini' | 'seedream' (not yet wired)

function backgroundPrompt(shots, item) {
  // Deliberately drops product_lock — that section of the old prompt exists
  // to keep a generative model faithful to product details we are no longer
  // asking it to draw at all. style_lock (scene/lighting/mood language) and
  // the per-shot scene description are the only parts relevant to a
  // product-free background plate.
  const parts = [shots.style_lock, item.prompt, 'Do not include any product, object, or packaging in the frame — background/scene only.']
    .map((s) => (s || '').trim())
    .filter(Boolean);
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

/** Generates a product-free background plate via Gemini. Same 1K cap as the main app (Owner rule). */
async function generateBackgroundImage(geminiKey, { prompt, aspectRatio }) {
  if (GENERATION_MODEL !== 'gemini') {
    throw new Error(`GENERATION_MODEL=${GENERATION_MODEL} not wired yet — only 'gemini' is implemented (ask the Owner for the Seedream endpoint/key before adding it)`);
  }
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: aspectRatio || '1:1', imageSize: '1K' },
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

/**
 * Pastes the product cutout onto the background — scale + position only,
 * no rotation, no distortion, no re-render of the product's own pixels.
 * placement is normalized (0-1): { scale, anchorX, anchorY } where anchorX/Y
 * is the cutout's center point as a fraction of the background's width/height.
 * Defaults to centered, scaled to 50% of the background's height — kept
 * smaller than a "fill the frame" composition on purpose, so there's real
 * pixel headroom on every side for compose.py's text placement to pan into
 * later, instead of the product running edge-to-edge with no room to shift.
 */
async function compositeProductOntoBackground(backgroundBytes, cutoutBytes, placement) {
  const { scale = 0.5, anchorX = 0.5, anchorY = 0.62 } = placement || {};
  const bg = sharp(backgroundBytes);
  const bgMeta = await bg.metadata();
  const cutout = sharp(cutoutBytes);
  const cutoutMeta = await cutout.metadata();

  // Uniform scale from the target height fraction — aspect ratio preserved
  // exactly (no independent width/height stretch, which would distort the
  // real product's proportions and violate the whole point of this fork).
  const targetH = Math.round(bgMeta.height * scale);
  const targetW = Math.round((cutoutMeta.width / cutoutMeta.height) * targetH);
  const resizedCutout = await cutout.resize(targetW, targetH, { fit: 'fill' }).toBuffer();

  const left = Math.round(bgMeta.width * anchorX - targetW / 2);
  const top = Math.round(bgMeta.height * anchorY - targetH / 2);

  const composited = await bg
    .composite([{ input: resizedCutout, left, top }])
    .png()
    .toBuffer();
  return { bytes: composited, mimeType: 'image/png' };
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

/**
 * Finds the project's product cutout — a pre-made transparent-background PNG
 * of the real photographed product, same convention as
 * clients/<Client>/products/<Product>/originals/*-cutout.png. Looked up by
 * filename containing "cutout" inside the project's assets/ folder.
 *
 * Deliberately does NOT fall back to generating a cutout with an AI
 * background-remover — every generation API touching the product's pixels
 * defeats the purpose of this fork. If no cutout exists yet, this fails
 * loudly and asks the Owner to upload one, rather than silently degrading
 * back to the regenerate-the-whole-image behavior this fork exists to avoid.
 */
async function findProductCutout(db, clientSlug, project) {
  const files = await db.listFiles(`${clientSlug}/${project.id}/assets`);
  const cutoutFile = (files || []).find((f) => f.id && /cutout/i.test(f.name));
  if (!cutoutFile) {
    throw new Error(
      'no product cutout found in this project\'s assets/ folder (expected a filename containing "cutout", ' +
      'e.g. product-name-cutout.png — a transparent-background PNG of the real product). Upload one before generating.',
    );
  }
  return db.downloadFile(`${clientSlug}/${project.id}/assets/${cutoutFile.name}`);
}

/**
 * Generates every shot in project.shots.items as a composite: AI background
 * + the real product cutout pasted on top untouched. Uploads each result and
 * upserts a `renders` row per shot. No checker call anywhere in this fork —
 * see app-composite/README.md for why.
 *
 * @param {object} deps - { geminiKey, db }
 * @param {object} params - { project }
 * @returns {Promise<{ok:boolean, generated:number, failed:Array}>}
 */
async function generateProjectRenders(deps, params) {
  const { geminiKey, db } = deps;
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

  let cutoutBuf;
  try {
    cutoutBuf = await findProductCutout(db, clientSlug, project);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }

  const outcomes = await mapWithConcurrency(shots.items, CONCURRENCY, async (item) => {
    const prompt = backgroundPrompt(shots, item);
    const background = await generateBackgroundImage(geminiKey, { prompt, aspectRatio });
    const { bytes, mimeType } = await compositeProductOntoBackground(background.bytes, cutoutBuf.bytes, item.placement);

    const filename = /\.[a-z0-9]+$/i.test(item.file) ? item.file : `${item.file}.png`;
    const path = db.storagePath(clientSlug, project.id, 'renders', filename);
    await db.uploadFile(path, bytes, mimeType);

    const render = await db.upsertRender(project.id, filename, { storage_path: path, stage: 'render' });
    return { file: filename, path, render };
  });

  const succeeded = [];
  const failed = [];
  outcomes.forEach((outcome, i) => {
    const item = shots.items[i];
    if (outcome.ok) succeeded.push(outcome.value);
    else failed.push({ file: item.file, motif: item.motif, error: outcome.error.message || String(outcome.error) });
  });

  await db.saveStatus(project.id, 'checking'); // "checking" kept as the status label for step 3 (Check), no checker runs

  const summary =
    `${succeeded.length}/${shots.items.length} shots composited (AI background via ${GENERATION_MODEL}, ${aspectRatio}, ` +
    `1K cap + real product cutout pasted at fixed angle, no product regeneration).` +
    (failed.length ? ` Failed: ${failed.map((f) => `${f.file} (${f.error})`).join('; ')}` : '') + capNote;
  await db.createRunLogEntry(project.id, 'generate', summary);

  return { ok: failed.length === 0, generated: succeeded.length, failed };
}

module.exports = { generateProjectRenders, generateBackgroundImage, compositeProductOntoBackground, backgroundPrompt, mapWithConcurrency, findProductCutout };
