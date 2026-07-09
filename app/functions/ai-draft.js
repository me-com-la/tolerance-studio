// functions/ai-draft.js — port of server.py's ai_draft() (POST /ai-draft).
//
// kind: 'tags' | 'scenes' | 'copy' — same prompts, same JSON-in-JSON-out
// contracts as tools/server.py, but reads from Supabase (projects table +
// sibling projects for the same client) instead of the filesystem.
//
// TODAY: plain Node/CommonJS module, meant to be run from a trusted server
// context (not the browser — it needs the fal.ai key). Written so it can
// become a Supabase Edge Function later with minimal change: swap
// require('./_fal-key') for Deno.env.get('FAL_KEY'), swap the db.js browser
// calls for a server-side supabase-js client using the service role key, and
// wrap draftKind() in Deno.serve(). The function body (prompt construction,
// parsing) does not need to change.
//
// 2026-07-09: routed through fal.ai's OpenRouter chat endpoint instead of
// calling api.anthropic.com directly (consolidating onto the one provider
// already paying for Bria image gen). Model is still Claude — Haiku 4.5, not
// Sonnet: this task is short structured JSON/text drafting, not deep
// reasoning, and Haiku is ~1/2 the per-token price. Swap DRAFT_MODEL if that
// judgment call needs revisiting.
//
// Continuity behavior ported from client_docs() in server.py: for 'tags' and
// 'scenes', pull up to 2 sibling projects for the same client (most recent
// first) and feed their tags/scenes into the prompt so campaigns build on
// each other. There is no brief.md/prompts.md equivalent in the DB schema —
// tags.json's DB equivalent is projects.tags, prompts.md's Scenes section is
// projects.scenes. (No legacy-brief.md conversion path needed; the schema
// has no legacy rows.)

const https = require('https');

const MODEL = process.env.DRAFT_MODEL || 'anthropic/claude-haiku-4.5';

// Routed through fal.ai's OpenRouter-backed chat endpoint (OpenAI-compatible
// request/response shape) rather than calling Anthropic directly. Function
// name kept as callClaude — the model is still Claude, just a different pipe.
function callClaude(falKey, system, user, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const req = https.request(
      'https://fal.run/openrouter/router/openai/v1/chat/completions',
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

function extractJsonObject(text) {
  return text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
}

/**
 * @param {object} deps - { falKey, db } — db is lib/db.js's exported
 *   object (listSiblingProjects, getProject), falKey is the string key
 *   (from ./_fal-key in a trusted server context).
 * @param {object} params - { project, kind, direction }
 *   project: the full project row (from db.getProject), including .clients
 *   kind: 'tags' | 'scenes' | 'copy'
 *   direction: optional owner steering text
 */
async function aiDraft(deps, params) {
  const { falKey, db } = deps;
  const { project, kind, direction: rawDirection } = params;
  const direction = (rawDirection || '').trim();

  const briefLine =
    `Client: ${project.clients ? project.clients.name : '?'} · Campaign: ${project.name} · ` +
    `Product: ${project.product || '?'}\nProject brief: ${project.description || '(none)'}`;

  if (kind === 'tags') {
    const siblings = await db.listSiblingProjects(project.client_id, project.id, 2);
    const prevTxt =
      siblings
        .filter((s) => s.tags)
        .map((s) => `--- from previous campaign ${s.name} ---\n${JSON.stringify(s.tags, null, 2)}`)
        .join('\n\n') || '(no previous campaigns)';
    const cur = project.tags ? JSON.stringify(project.tags, null, 2) : null;

    const system =
      'You draft the weighted brief tags for an AI product-imagery pipeline. Respond with ONLY a JSON ' +
      'object: {"product":[{"t":"tag text","w":"must|should|flavor"}, ...], "creative":[...same shape...]}. ' +
      'product = what must be true on the product itself (type, shape, colors, materials, finish, ' +
      'branding, proportions, condition); creative = scene/palette/light/mood/camera constants locked ' +
      'for the whole batch. Each tag is 1-4 words, keyword style. Weights drive both ends of the ' +
      'pipeline: must = non-negotiable (leads the generation prompt AND auto-rejects in the checker), ' +
      'should = strong preference (mid-prompt, checker flags), flavor = trailing detail (not checked). ' +
      'Be sparing with must — only true product-correctness facts earn it.';
    const user =
      `${briefLine}\n\nPrevious campaigns' tags from this client (reuse facts that still apply, drop ` +
      `campaign-specific ones):\n${prevTxt}\n\n` +
      (cur ? `Existing tags for this project (refine/extend; keep the Owner's weights unless clearly wrong):\n${cur}\n\n` : '') +
      (direction ? `Owner direction: ${direction}\n\n` : '') +
      'Respond with the JSON object only.';
    const text = await callClaude(falKey, system, user);
    const json = JSON.parse(extractJsonObject(text));
    return { ok: true, tags: json };
  }

  if (kind === 'scenes') {
    const brief = project.tags ? JSON.stringify(project.tags, null, 2) : '(not written yet)';
    const siblings = await db.listSiblingProjects(project.client_id, project.id, 2);
    const prevTxt =
      siblings
        .filter((s) => s.scenes)
        .map((s) => `--- from previous campaign ${s.name} ---\n${s.scenes}`)
        .join('\n\n') || '(no previous campaigns)';
    const batchSize = (project.settings && project.settings.batch_size) || 8;

    const system =
      'You draft the Scenes list for an AI product-photography batch: a numbered list of short scene ' +
      'phrases (5-10 words each), one per line, count = the batch size. Each scene describes only the ' +
      "setting/situation — the product and creative-constant details from the brief tags get combined " +
      "with each scene later when the shots are expanded, so don't repeat them here. Written for an " +
      'Owner who edits it by hand for variety — quick to scan, quick to change.';
    const user =
      `${briefLine}\n\nBrief tags (weighted; must > should > flavor):\n${brief}\n\nPrevious scene lists from this client (keep the brand ` +
      `feel consistent, but this campaign needs its own variety):\n${prevTxt}\n\n` +
      (direction ? `Owner direction: ${direction}\n\n` : '') +
      'Write the Scenes list only, as a numbered list of short phrases, count = ' +
      batchSize +
      '. No heading, no other text, no product/style detail restated.';
    const text = await callClaude(falKey, system, user);
    return { ok: true, text };
  }

  if (kind === 'copy') {
    const tags = project.tags ? JSON.stringify(project.tags, null, 2) : '';
    const system =
      'You write short ad copy for product campaign images. Each option has: eyebrow (small kicker, a few ' +
      'words, may be empty), headline (the dominant line, under 8 words), body (one or two supporting ' +
      'sentences with the concrete campaign facts: dates, place, names), and cta (button text, under 4 words). ' +
      'Honest, warm, no hype words, no exclamation marks. Respond with ONLY a JSON object: ' +
      '{"options":[{"eyebrow":"","headline":"","body":"","cta":""} x5]} — five distinct directions.';
    const user =
      `${briefLine}\n\nBrief tags:\n${tags}\n\nCampaign description:\n${(project.description || '').slice(0, 2000)}\n\n` +
      (direction ? `Owner direction for this round: ${direction}\n` : '') +
      'Write 5 copy options.';
    const text = await callClaude(falKey, system, user);
    const json = JSON.parse(extractJsonObject(text));
    return { ok: true, options: json.options };
  }

  return { ok: false, error: `unknown kind ${kind}` };
}

module.exports = { aiDraft, callClaude, extractJsonObject };
