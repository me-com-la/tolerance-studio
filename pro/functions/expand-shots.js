// functions/expand-shots.js — new capability per saas-plan.md phase 1b:
// "the regenerate step 2 work that today needs a Claude chat." Takes the
// project's weighted tags (projects.tags) + Scenes list (projects.scenes)
// and calls Claude to produce expanded per-shot prompts, writing the result
// to projects.shots and appending a run_log entry (step: 'expand').
//
// There is no server.py equivalent to port verbatim — server.py's
// /scenes-merge only splices a drafted Scenes list into prompts.md above the
// GENERATED_BELOW marker; the actual "expand shots into full prompts" step
// happens today in a manual Claude chat (per control.html's comment: "ask
// Claude to regenerate step 2"). This function automates exactly that chat.
//
// GUESS FLAGGED: the shots jsonb shape isn't specified anywhere in
// 001_init.sql beyond "expanded shots table (generated, never hand-edited)".
// I designed it as an array of {file, motif, prompt} objects, one per scene,
// mirroring the "Expanded shots (auto)" table shown in
// app/design/5-scenes-editor.html (columns: #, File, Motif, Prompt). Also
// invented file-slug naming (product-name + motif-slug + 2-digit index) to
// match the pattern in existing project folders (e.g. crate-blue-living-01).
// Flagging this as a guess in the final report — worth Owner sign-off since
// it's a new contract, not a ported one.
//
// TODAY: plain Node/CommonJS module for the same trusted-server-context
// reason as ai-draft.js. Edge Function migration note: same as ai-draft.js
// (swap key source + wrap in Deno.serve()); the prompt-building and slug
// logic below does not need to change.

const { callClaude, extractJsonObject } = require('./ai-draft');

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function tagLines(tags) {
  const all = [...(tags?.product || []), ...(tags?.creative || [])];
  const line = (w) => all.filter((t) => t.w === w).map((t) => t.t).join(' · ') || '(none)';
  return {
    always: line('must'),
    prefer: line('should'),
    detail: line('flavor'),
  };
}

// Owner-entered approximate dimensions (inches), stored at tags.dimensions —
// image models have no real-world scale grounding from a product name alone,
// so a plain size line in the prompt is what corrects "looks shorter/wider
// than it actually is" misses (e.g. a tall vase rendering squat).
function dimensionsLine(dimensions) {
  const { width, height, length } = dimensions || {};
  const parts = [];
  if (height) parts.push(`${height}in tall`);
  if (width) parts.push(`${width}in wide`);
  if (length) parts.push(`${length}in deep`);
  if (!parts.length) return '(not given)';
  if (height && width) {
    const ratio = (height / width).toFixed(1);
    parts.push(`height-to-width ratio ~${ratio}:1`);
  }
  return parts.join(', ');
}

function parseScenes(scenesText) {
  // Strips the numbering AND the "*" owner-written marker the Scenes editor
  // persists (lines like "3. * Rooftop terrace…") — the marker is UI-side
  // provenance only and must never leak into a generation prompt. Mirrors
  // the deployed Deno version (supabase/functions/expand-shots/index.ts).
  return (scenesText || '')
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').replace(/^\*\s*/, '').trim())
    .filter(Boolean);
}

/**
 * @param {object} deps - { anthropicKey, db }
 * @param {object} params - { project } — full project row from db.getProject
 * @returns {Promise<{ok:boolean, shots?:object, error?:string}>}
 */
async function expandShots(deps, params) {
  const { anthropicKey, db } = deps;
  const { project } = params;

  const scenes = parseScenes(project.scenes);
  if (!scenes.length) {
    return { ok: false, error: 'no scenes to expand — write the Scenes list first' };
  }
  const tags = tagLines(project.tags);
  const dimensions = dimensionsLine(project.tags?.dimensions);
  const productSlug = slugify(project.product || project.name);

  const system =
    'You expand a short scene-phrase list into full AI-image-generation prompts for a product-photography ' +
    'batch. Each output prompt combines: (1) the product lock — must-weighted product facts, always true, ' +
    'stated first, including the given approximate dimensions/proportions stated in plain language (e.g. ' +
    '"a tall, slender vase, about 3x taller than it is wide") so the generated product reads at true scale ' +
    'instead of default proportions; (2) the style lock — must/should-weighted creative constants, stated as ' +
    'consistent style guidance across the whole batch; (3) the specific scene detail for that shot. Write one ' +
    'flowing descriptive paragraph per shot, camera-ready, 2-4 sentences, ending with the shot angle. Every ' +
    'prompt must also keep the full product in frame with even margin on all sides — never crop tight or run ' +
    'the product edge-to-edge — so the compose step downstream has room to shift the image left or right ' +
    'behind text without cutting the product off. Respond with ' +
    'ONLY a JSON object: {"product_lock":"...", "style_lock":"...", ' +
    '"shots":[{"motif":"short 2-4 word label","prompt":"full prompt paragraph"}, ...]} — exactly one shot ' +
    'per input scene, same order.';
  const user =
    `Product: ${project.product || project.name}\n\n` +
    `ALWAYS (must): ${tags.always}\nPREFER (should): ${tags.prefer}\nDETAIL (flavor): ${tags.detail}\n\n` +
    `Approximate dimensions: ${dimensions}\n\n` +
    `Scenes (one shot per line, expand in this exact order):\n${scenes.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
    'Respond with the JSON object only.';

  const text = await callClaude(anthropicKey, system, user);
  const parsed = JSON.parse(extractJsonObject(text));

  const shots = {
    product_lock: parsed.product_lock || '',
    style_lock: parsed.style_lock || '',
    items: (parsed.shots || []).map((s, i) => ({
      index: i + 1,
      file: `${productSlug}-${slugify(s.motif || 'scene')}-${String(i + 1).padStart(2, '0')}`,
      motif: s.motif || '',
      prompt: s.prompt || '',
    })),
  };

  await db.saveShots(project.id, shots);
  return { ok: true, shots };
}

module.exports = { expandShots };
