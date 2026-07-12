import { createClient } from 'npm:@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';
const DRAFT_MODEL = Deno.env.get('DRAFT_MODEL') || 'anthropic/claude-haiku-4.5';
function bytesToBase64(bytes) {
  let binary = '';
  for(let i = 0; i < bytes.length; i++)binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
// Shrink the reference photo before we base64 it into the chat request — the
// tag read only needs to recognize the product, not fine detail, and a raw
// 10MP phone photo bloats the request (and risks the 512MB worker limit).
// Any failure falls back to the original bytes. Same helper proven in generate.
async function downscaleForModel(bytes, mimeType, maxEdge = 1024) {
  try {
    const img = await Image.decode(bytes);
    const longEdge = Math.max(img.width, img.height);
    if (longEdge <= maxEdge) return { bytes, mimeType };
    if (img.width >= img.height) img.resize(maxEdge, Image.RESIZE_AUTO);
    else img.resize(Image.RESIZE_AUTO, maxEdge);
    const isPng = (mimeType || '').includes('png');
    const out = isPng ? await img.encode() : await img.encodeJPEG(85);
    return { bytes: out, mimeType: isPng ? 'image/png' : 'image/jpeg' };
  } catch (_e) {
    return { bytes, mimeType };
  }
}
// Builds a multimodal image part from the project's reference photo (or the
// first uploaded asset) so the tag draft can actually SEE the product.
// Returns null if there's no photo yet — callers then fall back to text only.
async function referenceImagePart(supabase, project) {
  try {
    let path = project.reference_image;
    if (!path) {
      const slug = project.clients?.slug;
      if (!slug) return null;
      const { data: files } = await supabase.storage.from('projects').list(`${slug}/${project.id}/assets`, { limit: 5 });
      const real = (files || []).find((f)=>f.id);
      if (!real) return null;
      path = `${slug}/${project.id}/assets/${real.name}`;
    }
    const { data: blob, error } = await supabase.storage.from('projects').download(path);
    if (error || !blob) return null;
    const raw = new Uint8Array(await blob.arrayBuffer());
    const { bytes, mimeType } = await downscaleForModel(raw, blob.type || 'image/jpeg');
    return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${bytesToBase64(bytes)}` } };
  } catch (_e) {
    return null;
  }
}
async function callFal(apiKey, system, user) {
  const res = await fetch('https://fal.run/openrouter/router/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: DRAFT_MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: system
        },
        {
          role: 'user',
          content: user
        }
      ]
    })
  });
  const resp = await res.json();
  if (resp.error) throw new Error(resp.error.message || 'fal.ai API error');
  const text = (resp.choices || []).map((c)=>c.message?.content || '').join('');
  if (text) return text;
  throw new Error(`fal returned no text: ${JSON.stringify(resp).slice(0, 500)}`);
}
function extractJsonObject(text) {
  return text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
}
Deno.serve(async (req)=>{
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
  };
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const { projectId, kind, direction: rawDirection, batchSize: batchSizeOverride, count: countRaw, avoid } = await req.json();
    const direction = (rawDirection || '').trim();
    if (!projectId || !kind) {
      return new Response(JSON.stringify({
        error: 'projectId and kind required'
      }), {
        status: 400,
        headers: {
          ...CORS,
          'Content-Type': 'application/json'
        }
      });
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const falKey = Deno.env.get('FAL_KEY');
    if (!falKey) throw new Error('FAL_KEY secret not set');
    const { data: project, error: projectErr } = await supabase.from('projects').select('*, clients(name, slug)').eq('id', projectId).single();
    if (projectErr) throw projectErr;
    async function listSiblings(limit = 2) {
      const { data, error } = await supabase.from('projects').select('*').eq('client_id', project.client_id).neq('id', project.id).order('created_at', {
        ascending: false
      }).limit(limit);
      if (error) throw error;
      return data || [];
    }
    const briefLine = `Client: ${project.clients ? project.clients.name : '?'} · Campaign: ${project.name} · ` + `Product: ${project.product || '?'}\nProject brief: ${project.description || '(none)'}`;
    let result;
    if (kind === 'tags') {
      const siblings = await listSiblings(2);
      const prevTxt = siblings.filter((s)=>s.tags).map((s)=>`--- from previous campaign ${s.name} ---\n${JSON.stringify(s.tags, null, 2)}`).join('\n\n') || '(no previous campaigns)';
      const cur = project.tags ? JSON.stringify(project.tags, null, 2) : null;
      const system = 'You draft the weighted brief tags for an AI product-imagery pipeline. You are given a REAL ' + 'photo of the product — look at it and read the product from the image itself (type, shape, ' + 'colors, materials, finish, branding, proportions, condition), using the text brief only as ' + 'supporting context. Respond with ONLY a JSON ' + 'object: {"product":[{"t":"tag text","w":"must|should|flavor"}, ...], "creative":[...same shape...]}. ' + 'product = what must be true on the product itself (type, shape, colors, materials, finish, ' + 'branding, proportions, condition); creative = scene/palette/light/mood/camera constants locked ' + 'for the whole batch. Each tag is 1-4 words, keyword style. Weights drive both ends of the ' + 'pipeline: must = non-negotiable (leads the generation prompt AND auto-rejects in the checker), ' + 'should = strong preference (mid-prompt, checker flags), flavor = trailing detail (not checked). ' + 'Be sparing with must — only true product-correctness facts earn it.';
      const userText = `${briefLine}\n\nPrevious campaigns' tags from this client (reuse facts that still apply, drop ` + `campaign-specific ones):\n${prevTxt}\n\n` + (cur ? `Existing tags for this project (refine/extend; keep the Owner's weights unless clearly wrong):\n${cur}\n\n` : '') + (direction ? `Owner direction: ${direction}\n\n` : '') + 'Respond with the JSON object only.';
      // Feed the actual product photo (vision) when one exists; otherwise the
      // model still drafts from the text brief alone.
      const imagePart = await referenceImagePart(supabase, project);
      const user = imagePart
        ? [ { type: 'text', text: 'Real product photo — read the product from THIS image:' }, imagePart, { type: 'text', text: userText } ]
        : userText;
      const text = await callFal(falKey, system, user);
      result = {
        ok: true,
        tags: JSON.parse(extractJsonObject(text)),
        sawPhoto: !!imagePart
      };
    } else if (kind === 'scenes') {
      const brief = project.tags ? JSON.stringify(project.tags, null, 2) : '(not written yet)';
      const siblings = await listSiblings(2);
      const prevTxt = siblings.filter((s)=>s.scenes).map((s)=>`--- from previous campaign ${s.name} ---\n${s.scenes}`).join('\n\n') || '(no previous campaigns)';
      // Explicit batchSize from the caller wins over the stored setting —
      // the Scenes page sends its live input value so a just-changed number
      // is honored even if the settings save hasn't landed yet.
      const batchSize = Math.max(1, Math.min(5, batchSizeOverride || project.settings && project.settings.batch_size || 3));
      const system = 'You draft the Scenes list for an AI product-photography batch: a numbered list of short scene ' + 'phrases (5-10 words each), one per line, count = the batch size. Each scene describes only the ' + "setting/situation — the product and creative-constant details from the brief tags get combined " + "with each scene later when the shots are expanded, so don't repeat them here. Written for an " + 'Owner who edits it by hand for variety — quick to scan, quick to change.';
      const user = `${briefLine}\n\nBrief tags (weighted; must > should > flavor):\n${brief}\n\nPrevious scene lists from this client (keep the brand ` + `feel consistent, but this campaign needs its own variety):\n${prevTxt}\n\n` + (direction ? `Owner direction: ${direction}\n\n` : '') + 'Write the Scenes list only, as a numbered list of short phrases, count = ' + batchSize + '. No heading, no other text, no product/style detail restated.';
      const text = await callFal(falKey, system, user);
      // Hard guarantee on the count: "count = N" is an instruction the model
      // can overshoot, so truncate to batchSize regardless of what came back.
      const lines = text.split('\n').filter((l)=>l.trim()).slice(0, batchSize);
      result = {
        ok: true,
        text: lines.join('\n')
      };
    } else if (kind === 'copy') {
      // Owner call 2026-07-11: two options per round, not five — the client
      // asks for what it will actually show. `avoid` carries the headlines
      // already on screen so a "more" round takes different angles.
      const copyCount = Math.min(5, Math.max(1, parseInt(countRaw, 10) || 2));
      const avoidList = Array.isArray(avoid) ? avoid.filter((h)=>typeof h === 'string' && h.trim()).slice(0, 10) : [];
      const tags = project.tags ? JSON.stringify(project.tags, null, 2) : '';
      const system = 'You write short ad copy for product campaign images. Each option has: eyebrow (small kicker, a few ' + 'words, may be empty), headline (the dominant line, under 8 words), body (one or two supporting ' + 'sentences with the concrete campaign facts: dates, place, names), and cta (button text, under 4 words). ' + 'Honest, warm, no hype words, no exclamation marks. Respond with ONLY a JSON object: ' + `{"options":[{"eyebrow":"","headline":"","body":"","cta":""} x${copyCount}]} — ${copyCount} distinct directions.`;
      const user = `${briefLine}\n\nBrief tags:\n${tags}\n\nCampaign description:\n${(project.description || '').slice(0, 2000)}\n\n` + (direction ? `Owner direction for this round: ${direction}\n` : '') + (avoidList.length ? `Do NOT repeat these directions already shown — take genuinely different angles:\n${avoidList.map((h)=>`- ${h}`).join('\n')}\n` : '') + `Write ${copyCount} copy options.`;
      const text = await callFal(falKey, system, user);
      const json = JSON.parse(extractJsonObject(text));
      result = {
        ok: true,
        options: json.options
      };
    } else {
      result = {
        ok: false,
        error: `unknown kind ${kind}`
      };
    }
    return new Response(JSON.stringify(result), {
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }), {
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      }
    });
  }
});