import { createClient } from 'npm:@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';
// Lowered from 4 -> 2 (2026-07-10): each lane also chains a checker call, so
// 4 lanes meant up to ~8 concurrent requests against the same fal key, which
// was tripping fal's rate limit (HTTP 429) on batches of any real size.
const CONCURRENCY = parseInt(Deno.env.get('GENERATE_CONCURRENCY') || '2', 10);
function sleep(ms) {
  return new Promise((r)=>setTimeout(r, ms));
}
// fal.ai has no documented rate-limit retry guidance, so this backs off on
// any 429 the same way most APIs expect: short wait, then longer each retry,
// with a little jitter so concurrent lanes don't all retry in lockstep.
const MAX_RETRY_ATTEMPTS = 4;
async function fetchWithRetry429(url, options) {
  let attempt = 0;
  while(true){
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt >= MAX_RETRY_ATTEMPTS) return res;
    attempt++;
    await sleep(Math.min(1000 * 2 ** attempt, 15000) + Math.floor(Math.random() * 500));
  }
}
// fal's hosted slug for the same Gemini 3.1 Flash Image ("Nano Banana 2")
// model Standard has always generated with 
//same model, different pipe.
const IMAGE_MODEL = Deno.env.get('IMAGE_MODEL') || 'fal-ai/gemini-3.1-flash-image-preview/edit';
const MAX_REFERENCE_IMAGES = 3;
// Text+vision model for the checker's verdicts 
//distinct from IMAGE_MODEL.
// Ported off Anthropic-direct 2026-07-08, then Gemini, then fal 2026-07-09.
const CHECKER_MODEL = Deno.env.get('CHECKER_MODEL') || 'anthropic/claude-haiku-4.5';
function fullPrompt(shots, item) {
  const parts = [
    shots.product_lock,
    shots.style_lock,
    item.prompt
  ].map((s)=>(s || '').trim()).filter(Boolean);
  return parts.join('\n\n');
}
function bytesToBase64(bytes) {
  let binary = '';
  for(let i = 0; i < bytes.length; i++)binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
// Reference photos come straight from the user's uploads and are often
// full-resolution phone shots (10MP+). Decoding and base64-ing several of
// those at once is what pushes this function past Supabase's 512MB limit,
// which comes back as HTTP 546 ("WORKER_LIMIT"). Shrink the long edge to
// <=1536px BEFORE we ever hold the base64 in memory or send it to fal —
// that's plenty of detail to ground the edit, at a fraction of the size.
// One image at a time (callers loop sequentially), and on ANY failure we
// fall back to the original bytes: a big reference beats a broken run.
async function downscaleForModel(bytes, mimeType, maxEdge = 1536) {
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
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while(next < items.length){
      const i = next++;
      try {
        results[i] = {
          ok: true,
          value: await worker(items[i], i)
        };
      } catch (err) {
        results[i] = {
          ok: false,
          error: err
        };
      }
    }
  }
  const lanes = Array.from({
    length: Math.min(limit, items.length)
  }, runOne);
  await Promise.all(lanes);
  return results;
}
// Submits a job to fal's async queue and polls it to completion 
//same
// proven pattern as tools/pixel-lock/service.py's bria_genfill() (submit
// response carries status_url/response_url directly; poll every 2s, 120s
// deadline).
async function falQueueRun(falKey, model, body) {
  const submitRes = await fetchWithRetry429(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const submitted = await submitRes.json();
  if (!submitRes.ok) throw new Error(`fal submit error: ${JSON.stringify(submitted).slice(0, 300)}`);
  const { status_url, response_url } = submitted;
  const deadline = Date.now() + 120000;
  while(Date.now() < deadline){
    await new Promise((r)=>setTimeout(r, 2000));
    const sres = await fetchWithRetry429(status_url, {
      headers: {
        Authorization: `Key ${falKey}`
      }
    });
    const status = await sres.json();
    if (status.status === 'COMPLETED') {
      const rres = await fetchWithRetry429(response_url, {
        headers: {
          Authorization: `Key ${falKey}`
        }
      });
      const result = await rres.json();
      if (!rres.ok) throw new Error(`fal result error: ${JSON.stringify(result).slice(0, 300)}`);
      return result;
    }
    if (status.status === 'ERROR' || status.status === 'FAILED') {
      throw new Error(`fal generation failed: ${JSON.stringify(status).slice(0, 300)}`);
    }
  }
  throw new Error('fal generation timed out after 120s');
}
// Generates one shot's image via fal (Gemini 3.1 Flash Image / "Nano Banana
// 2", same model as before 
//see header), grounded on 1-3 real reference
// photos. fal returns a hosted URL, not inline bytes, so this downloads the
// image itself before returning 
//bytes AND the real mime type fal
// reported, never assumed (a mismatched declared mime type can get the
// candidate image rejected by the checker's vision API).
// Per-project model choice (2026-07-11): projects.settings.image_model
// picks an alternate look. Only vetted models are mapped — anything else
// falls back to IMAGE_MODEL, so a stale/garbage setting can't route to an
// arbitrary fal endpoint.
const MODEL_CHOICES = {
  seedream: 'fal-ai/bytedance/seedream/v5/lite/edit',
  gpt: 'fal-ai/gpt-image-1.5/edit',
  bria: 'fal-ai/bria/product-shot'
};
function modelForProject(project) {
  return MODEL_CHOICES[project.settings && project.settings.image_model] || IMAGE_MODEL;
}
// ---------- Bria product-shot (2026-07-18) ----------
// Unlike the three redraw models above, Bria COMPOSITES the real product
// photo into a generated background — the product pixels are placed, not
// redrawn. Options live in projects.settings.bria (set on the Scenes page):
//   { cutout, bg: 'describe'|'reference', ref_image, placement, position,
//     padding: [l,r,t,b], shot_w, shot_h, original_quality, fast, optimize,
//     num_results }
const BRIA_CUTOUT_MODEL = 'fal-ai/bria/background/remove';
// Bria's background/remove keeps the ORIGINAL canvas — the product floats
// inside a transparent frame. product-shot measures placement and scale on
// the full canvas, so that frame reads as product and renders sat far from
// the product's real edge (Owner, 2026-07-18). Trim to the alpha bounding
// box (+2px) before compositing; this is also what makes manual_padding
// mean "pixels from the product's edge" like Bria's docs intend.
async function trimTransparent(bytes) {
  const img = await Image.decode(bytes);
  const { width, height } = img;
  const data = img.bitmap;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for(let y = 0; y < height; y++){
    for(let x = 0; x < width; x++){
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  // Nothing opaque (broken cutout) or nothing to trim — return as-is.
  if (maxX < 0 || minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) return bytes;
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  img.crop(minX, minY, maxX - minX + 1, maxY - minY + 1);
  return await img.encode();
}
// Bria wants ~1,000,000 total pixels in the final shot. Per-aspect sizes
// that land on that budget (same aspect keys as the redraw models).
const BRIA_SIZES = {
  '1:1':  [1000, 1000],
  '16:9': [1332, 750],
  '9:16': [750, 1332],
  '4:3':  [1152, 864],
  '3:4':  [864, 1152],
  '3:2':  [1224, 816],
  '2:3':  [816, 1224]
};
// Bria's scene_description is a background brief, not an art-direction
// prompt — the product is never redrawn, so product_lock (which describes
// the product for redraw models) is dead weight. Style lock + the scene
// line is the whole brief. Bria wants English with no special characters;
// strip non-ASCII rather than reject.
function briaScenePrompt(shots, item) {
  return [shots.style_lock, item.prompt]
    .map((s)=>(s || '').trim()).filter(Boolean).join('\n\n')
    .replace(/[^\x20-\x7E\n]/g, ' ').trim();
}
// Text-only fal call (same openrouter route as the checker, no images).
async function callFalText(falKey, instructions) {
  const res = await fetchWithRetry429('https://fal.run/openrouter/router/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CHECKER_MODEL,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: instructions
        }
      ]
    })
  });
  const resp = await res.json();
  if (resp.error) throw new Error(resp.error.message || 'fal.ai API error');
  const text = (resp.choices || []).map((c)=>c.message && c.message.content || '').join('').trim();
  if (!text) throw new Error(`fal returned no text: ${JSON.stringify(resp).slice(0, 300)}`);
  return text;
}
// The expanded shot prompts describe the product IN the scene — written for
// the redraw models. Feeding that to Bria makes it paint the product into
// the background too, and then composite the real one on top (the Owner's
// "chairs on chairs", 2026-07-18). Rewrite each brief to background-only:
// keep setting/light/mood, ban the product and its whole category, leave an
// empty spot. On any failure fall back to the raw brief — a product-y
// background beats a failed shot.
async function briaBackgroundBrief(falKey, productName, shotPrompt) {
  try {
    const out = await callFalText(falKey, `A real photo of this product will be composited into an AI-generated background afterwards: "${productName}".
Below is a full image-generation brief that describes the product inside a scene. Rewrite it as a description of the EMPTY BACKGROUND SCENE ONLY, ready for the product to be placed into it:
- Never mention the product or any object of the same category — the background must not contain another one.
- Drop any size or height comparisons ("about the height of a table", "waist-height on an adult") — never name furniture, props, or people as size references.
- Keep the setting, surfaces, lighting, mood, and camera feel from the brief.
- Describe a natural clear spot where the product will sit.
- Plain English, no special characters, under 100 words.
Respond with ONLY the rewritten scene description.

Brief:
${shotPrompt}`);
    return out.replace(/[^\x20-\x7E\n]/g, ' ').trim() || shotPrompt;
  } catch (_e) {
    return shotPrompt;
  }
}
// Placement is no longer user-facing (Owner call, 2026-07-18 — manual
// positions were hanging products in mid-air with a painted glow under
// them). Always automatic, EXCEPT when the size-in-frame mapping below
// upgrades the run to manual_padding internally. Old placement keys still
// saved in settings.bria are ignored.
function briaInputFor(bria, prompt, productUri, refBgUri, aspectRatio) {
  const placement = bria.placement === 'manual_padding' ? 'manual_padding' : 'automatic';
  const input = {
    image_url: productUri,
    placement_type: placement,
    fast: bria.fast !== false,
    optimize_description: bria.optimize !== false,
    num_results: Math.max(1, Math.min(4, parseInt(bria.num_results, 10) || 1))
  };
  // Background source: a reference image OR a text description — the API
  // takes exactly one, never both.
  if (refBgUri) input.ref_image_url = refBgUri;
  else input.scene_description = prompt;
  if (placement === 'automatic') {
    const w = parseInt(bria.shot_w, 10), h = parseInt(bria.shot_h, 10);
    input.shot_size = w > 0 && h > 0 ? [w, h] : BRIA_SIZES[aspectRatio] || BRIA_SIZES['1:1'];
  } else {
    // [left, right, top, bottom] px around the cutout; final canvas =
    // cutout + padding, so the ~1M-pixel budget includes the product.
    input.padding_values = bria.padding;
  }
  return input;
}
// One shot through Bria product-shot. Returns an ARRAY (num_results can be
// 1-4). Same retry-once envelope as generateShotImage.
async function generateBriaShot(falKey, { prompt, aspectRatio, productUri, refBgUri, bria }) {
  async function attempt() {
    const result = await falQueueRun(falKey, MODEL_CHOICES.bria, briaInputFor(bria, prompt, productUri, refBgUri, aspectRatio));
    // Bria can return MORE images than num_results — automatic placement
    // hands back one image per placement it recommends (Owner hit this with
    // num_results=1, 2026-07-18). The user's setting is the contract: keep
    // exactly that many, drop the rest before downloading.
    const want = Math.max(1, Math.min(4, parseInt(bria.num_results, 10) || 1));
    const imgs = (result.images || []).filter((im)=>im && im.url).slice(0, want);
    if (!imgs.length) throw new Error(`bria returned no image: ${JSON.stringify(result).slice(0, 300)}`);
    const out = [];
    for (const im of imgs){
      const r = await fetch(im.url);
      if (!r.ok) throw new Error(`failed to download bria image: HTTP ${r.status}`);
      out.push({
        bytes: new Uint8Array(await r.arrayBuffer()),
        mimeType: im.content_type || 'image/png'
      });
    }
    return out;
  }
  try {
    return await attempt();
  } catch (err) {
    await sleep(3000 + Math.floor(Math.random() * 1000));
    return await attempt();
  }
}
// Seedream's edit endpoint has a different input schema than the Gemini
// one: image_size ({width,height}, 1024-4096 per side) instead of
// aspect_ratio/resolution/output_format. Same image_urls + prompt.
// Alternate models treat references more loosely than Gemini's edit
// endpoint — Seedream in particular will happily invent a new product from
// a scene-style prompt (real drift the Owner hit, 2026-07-11). Both alt
// models get a hard anchoring preamble; GPT additionally gets
// input_fidelity 'high', the endpoint's own reference-preservation knob.
const ANCHOR = 'The reference image(s) show the exact product. Reproduce THIS exact product — ' +
  'same shape, colors, materials, hardware, and markings, unchanged — placed into the scene ' +
  'described below. Never invent a different or similar product.\n\n';
function falInputFor(model, prompt, image_urls, aspectRatio) {
  if (model.includes('gpt-image')) {
    // Only three fixed sizes; quality 'medium' = $0.034-0.051/image
    // (high would be $0.13-0.20 — not worth 4x for batch scenes).
    const size = aspectRatio === '1:1' ? '1024x1024'
      : (aspectRatio === '9:16' || aspectRatio === '3:4' || aspectRatio === '2:3') ? '1024x1536'
      : '1536x1024';
    return {
      prompt: ANCHOR + prompt,
      image_urls,
      image_size: size,
      quality: 'medium',
      input_fidelity: 'high',
      output_format: 'png'
    };
  }
  if (model.includes('seedream')) {
    // Seedream 5 Lite requires 3.7–9.43 MP output; 16:9/9:16 bumped up from
    // the v4 sizes (2560×1440 = 3.69 MP) to clear the 3.7 MP floor.
    const SIZES = {
      '1:1':  { width: 2048, height: 2048 },
      '16:9': { width: 2688, height: 1512 },
      '9:16': { width: 1512, height: 2688 },
      '4:3':  { width: 2304, height: 1728 },
      '3:4':  { width: 1728, height: 2304 },
      '3:2':  { width: 2496, height: 1664 },
      '2:3':  { width: 1664, height: 2496 }
    };
    return { prompt: ANCHOR + prompt, image_urls, image_size: SIZES[aspectRatio] || SIZES['1:1'] };
  }
  return {
    prompt,
    image_urls,
    aspect_ratio: aspectRatio || '1:1',
    resolution: '2K',
    output_format: 'png'
  };
}
async function generateShotImage(falKey, { prompt, aspectRatio, referenceImages, model }) {
  // referenceImages already carry base64 (not raw bytes, see bytesToBase64
  // above), so image_urls is a plain data-URI template
  //same trick already
  // proven with Bria's image_url/mask_url fields (see keys-and-deploy.md).
  const image_urls = referenceImages.map((img)=>`data:${img.mimeType};base64,${img.base64}`);
  // Retry-once wrapper (2026-07-16). fetchWithRetry429 already handles 429s
  // up to 4 tries with backoff; this covers everything else that used to
  // fail a whole shot on the first hiccup — a fal internal error, a queue
  // deadline hit, a hosted-image 5xx on download, etc. One retry after a
  // short pause recovers the transient cases; a truly broken shot still
  // fails cleanly (mapWithConcurrency records it as ok:false and moves on).
  async function attempt() {
    const result = await falQueueRun(falKey, model || IMAGE_MODEL, falInputFor(model || IMAGE_MODEL, prompt, image_urls, aspectRatio));
    const img = (result.images || [])[0];
    if (!img || !img.url) throw new Error(`fal returned no image: ${JSON.stringify(result).slice(0, 300)}`);
    const imgRes = await fetch(img.url);
    if (!imgRes.ok) throw new Error(`failed to download generated image: HTTP ${imgRes.status}`);
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    return { bytes, mimeType: img.content_type || 'image/png' };
  }
  try {
    return await attempt();
  } catch (err) {
    // Backoff before the retry so a fal queue slot has time to free up
    // and a rate-limit bucket has time to refill; jitter avoids two lanes
    // retrying in lockstep after a shared spike.
    await sleep(3000 + Math.floor(Math.random() * 1000));
    return await attempt();
  }
}
// ---------- checker logic (duplicated from checker/index.ts, see its header) ----------
function buildSpecFromTags(project) {
  const all = [
    ...project.tags?.product || [],
    ...project.tags?.creative || []
  ];
  const vision_checks = all.filter((t)=>t.w === 'must' || t.w === 'should').map((t, i)=>({
      id: `${t.w}_${i}_${t.t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')}`.slice(0, 60),
      item: t.t,
      when_visible: true,
      severity: t.w === 'must' ? 'reject' : 'flag'
    }));
  return {
    sku: (project.product || project.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    variant: project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    vision_checks,
    rules: {
      confidence_below: 80
    }
  };
}
async function callFalVision(falKey, sourceImage, candidateImage, instructions) {
  const res = await fetchWithRetry429('https://fal.run/openrouter/router/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CHECKER_MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'IMAGE 1 — real product (ground truth):'
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${sourceImage.mediaType};base64,${sourceImage.base64}`
              }
            },
            {
              type: 'text',
              text: 'IMAGE 2 — AI-generated candidate:'
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${candidateImage.mediaType};base64,${candidateImage.base64}`
              }
            },
            {
              type: 'text',
              text: instructions
            }
          ]
        }
      ]
    })
  });
  const resp = await res.json();
  if (resp.error) throw new Error(resp.error.message || 'fal.ai API error');
  const text = (resp.choices || []).map((c)=>c.message && c.message.content || '').join('');
  if (!text) throw new Error(`fal returned no text: ${JSON.stringify(resp).slice(0, 300)}`);
  return text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
}
// The seven fixed inspection points — constant across every brand and both
// modes. Kept in sync by hand with the standalone checker's POINTS so a render
// checked inline (Scene mode) and one checked via the checker function (Exact /
// edits) render identically on the gallery's 7-point card.
const POINTS = [
  { key: 'shape', name: 'Shape', blurb: 'Silhouette, structure, and proportions match your product.' },
  { key: 'color', name: 'Color', blurb: 'Colors match the real thing.' },
  { key: 'materials', name: 'Materials', blurb: 'Surface, texture, sheen, and pattern read true.' },
  { key: 'details', name: 'Details', blurb: 'Logos, hardware, closures, seams, and text are correct and undistorted.' },
  { key: 'clarity', name: 'Clarity', blurb: 'Sharp and clean — no artifacts or warping.' },
  { key: 'lighting', name: 'Lighting', blurb: 'Believable light direction, shadows, and reflections.' },
  { key: 'scene', name: 'Scene', blurb: 'The product sits naturally in its setting, not pasted on.' }
];
function fallbackHeadline(tier) {
  if (tier === 'REJECT') return 'Hold — off-brand';
  if (tier === 'HUMAN_REVIEW') return 'One fix from ready';
  return 'Send-ready';
}
async function runCheckerInline(falKey, spec, sourceImage, candidateImage) {
  const truths = spec.vision_checks || [];
  const instructions = `You are a working creative director reviewing an AI-generated product image before it goes to a client. You are direct and specific — never gushing, never padding.

IMAGE 1 is the REAL product (ground truth). IMAGE 2 is the AI-generated candidate. The product in IMAGE 2 must match the real one; scene and lighting *style* may differ unless a brand truth says otherwise.

Run a fixed 7-POINT INSPECTION. Judge each point against IMAGE 1:
${POINTS.map((p)=>`- ${p.name}: ${p.blurb}`).join('\n')}

This brand's declared truths (use them as the specific standard for the points they touch): ${JSON.stringify(truths)}

For each point give a "score" 0-100 for how closely it matches IMAGE 1 (100 = perfect match, 0 = completely wrong), plus a "verdict" derived from that score: "pass" (score 85+), "attention" (score 50-84), "fail" (score below 50), or "na" (can't be judged in this shot, no score). Be strict — subtle color shifts, warped patterns, garbled text, invented hardware, and pasted-on lighting are exactly what you catch.

Also rule on each declared truth: "pass", "fail", or "na".

Then speak to the brand owner like their creative director: name the specific thing that's off (or confirm it's right), in plain words. If a fix is needed, write a one-line redo instruction they could hand straight to the generator.

Respond with ONLY this JSON:
{
  "points": [{"key": "shape|color|materials|details|clarity|lighting|scene", "verdict": "pass|attention|fail|na", "score": 0-100 or null if na, "reason": "one short line"}],
  "truths": [{"id": "...", "verdict": "pass|fail|na"}],
  "headline": "at most 6 words, e.g. 'Send-ready' or 'One fix: color'",
  "note": "2-3 sentences, first person, direct",
  "suggested_fix": "one-line redo instruction, or empty string"
}`;
  const text = await callFalVision(falKey, sourceImage, candidateImage, instructions);
  const result = JSON.parse(text);
  const byKey = {};
  for (const p of Array.isArray(result.points) ? result.points : [])byKey[p.key] = p;
  const points = POINTS.map((p)=>{
    const got = byKey[p.key] || {};
    const v = ['pass', 'attention', 'fail', 'na'].includes(got.verdict) ? got.verdict : 'na';
    const score = typeof got.score === 'number' ? Math.max(0, Math.min(100, Math.round(got.score))) : null;
    return { key: p.key, name: p.name, blurb: p.blurb, verdict: v, score, reason: (got.reason || '').trim() };
  });
  const applicableP = points.filter((p)=>p.verdict !== 'na');
  const verified = applicableP.filter((p)=>p.verdict === 'pass').length;
  const applicable = applicableP.length;
  const score = applicable > 0 ? Math.round(verified / applicable * 100) : null;
  const sev = {};
  const truthText = {};
  for (const t of truths){ sev[t.id] = t.severity; truthText[t.id] = t.item; }
  const truthResults = Array.isArray(result.truths) ? result.truths : [];
  const items = truthResults.map((t)=>({
    id: t.id,
    item: truthText[t.id] || t.id,
    verdict: ['pass', 'fail', 'na'].includes(t.verdict) ? t.verdict : 'na',
    reason: ''
  }));
  let stage2Verdict = 'PASS';
  if (items.length > 0) {
    for (const it of items){ if (it.verdict === 'fail' && sev[it.id] === 'reject') stage2Verdict = 'REJECT'; }
    if (stage2Verdict === 'PASS') {
      for (const it of items){ if (it.verdict === 'fail' && sev[it.id] === 'flag') stage2Verdict = 'HUMAN_REVIEW'; }
    }
  } else {
    if (points.some((p)=>p.verdict === 'fail')) stage2Verdict = 'HUMAN_REVIEW';
  }
  let headline = typeof result.headline === 'string' ? result.headline.trim() : '';
  if (!headline || headline.length > 42) headline = fallbackHeadline(stage2Verdict);
  const note = typeof result.note === 'string' ? result.note.trim() : '';
  const suggested_fix = typeof result.suggested_fix === 'string' ? result.suggested_fix.trim() : '';
  const checkerResult = {
    spec: `${spec.sku}/${spec.variant}`,
    model: CHECKER_MODEL,
    stage2_verdict: stage2Verdict,
    score,
    verified,
    applicable,
    points,
    headline,
    note,
    suggested_fix,
    items,
    overall_notes: note
  };
  const verdict = stage2Verdict === 'REJECT' ? 'rejected' : 'approved';
  return {
    checker: checkerResult,
    verdict
  };
}
// ---------- main ----------
Deno.serve(async (req)=>{
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
  };
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: cors
  });
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const { projectId } = await req.json();
    if (!projectId) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'projectId required'
      }), {
        status: 400,
        headers: {
          ...cors,
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
    // Checking is best-effort 
    //a checker failure must not block generation
    // itself, it just leaves those renders pending for a manual "Run
    // checker" click on the Check page. Both generation and checking use
    // the same fal key (different models 
    //IMAGE_MODEL vs CHECKER_MODEL).
    const { data: project, error: projectErr } = await supabase.from('projects').select('*, clients(name, slug)').eq('id', projectId).single();
    if (projectErr) throw projectErr;
    const shots = project.shots;
    if (!shots || !shots.items || !shots.items.length) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'no expanded shots to generate — run Expand shots first'
      }), {
        status: 400,
        headers: {
          ...cors,
          'Content-Type': 'application/json'
        }
      });
    }
    // Beta cap: at most MAX_IMAGES_PER_PROJECT images per project, counting
    // renders that already exist (re-generating the same filename replaces
    // its row, so the count stays honest). Owner rule, 2026-07-07.
    const MAX_IMAGES_PER_PROJECT = parseInt(Deno.env.get('MAX_IMAGES_PER_PROJECT') || '10', 10);
    const { count: existingRenders } = await supabase.from('renders').select('*', {
      count: 'exact',
      head: true
    }).eq('project_id', projectId);
    const remainingQuota = MAX_IMAGES_PER_PROJECT - (existingRenders || 0);
    if (remainingQuota <= 0) {
      return new Response(JSON.stringify({
        ok: false,
        error: `Beta limit reached: ${MAX_IMAGES_PER_PROJECT} images per project. Start a new project to keep going.`
      }), {
        status: 400,
        headers: {
          ...cors,
          'Content-Type': 'application/json'
        }
      });
    }
    let capNote = '';
    if (shots.items.length > remainingQuota) {
      shots.items = shots.items.slice(0, remainingQuota);
      capNote = ` Beta cap: ran ${remainingQuota} of the requested shots (${MAX_IMAGES_PER_PROJECT} images max per project).`;
    }
    const clientSlug = project.clients && project.clients.slug;
    if (!clientSlug) throw new Error('project has no client slug — cannot build a storage path');
    const aspectRatio = project.settings && project.settings.generation_aspect || '1:1';
    const spec = buildSpecFromTags(project);
    // Multi-reference rule: gather every asset photo (up to 3), used to
    // ground generation. Falls back to just reference_image if the assets
    // folder listing fails or is empty (e.g. projects seeded before the
    // multi-upload modal existed).
    const referenceImages = [];
    try {
      const { data: files } = await supabase.storage.from('projects').list(`${clientSlug}/${project.id}/assets`, {
        limit: MAX_REFERENCE_IMAGES + 5
      });
      const realFiles = (files || []).filter((f)=>f.id).slice(0, MAX_REFERENCE_IMAGES);
      for (const f of realFiles){
        const { data: blob, error: dlErr } = await supabase.storage.from('projects').download(`${clientSlug}/${project.id}/assets/${f.name}`);
        if (!dlErr && blob) {
          const rawBytes = new Uint8Array(await blob.arrayBuffer());
          const { bytes, mimeType } = await downscaleForModel(rawBytes, blob.type || 'image/jpeg');
          referenceImages.push({
            mimeType,
            base64: bytesToBase64(bytes)
          });
        }
      }
    } catch (_e) {}
    // Reference photo used by the CHECKER specifically 
    //one fixed image so
    // every shot in the batch is judged against the same ground truth,
    // separate from the (possibly multiple) images fed to generation.
    let checkerReferenceImage = null;
    let checkerRefDiagnostic = '';
    if (!project.reference_image) checkerRefDiagnostic = 'project.reference_image is not set';
    else {
      try {
        const { data: refBlob, error: refErr } = await supabase.storage.from('projects').download(project.reference_image);
        if (refErr) checkerRefDiagnostic = `download error: ${refErr.message || JSON.stringify(refErr)}`;
        else if (!refBlob) checkerRefDiagnostic = 'download returned no blob';
        else {
          const rawRefBytes = new Uint8Array(await refBlob.arrayBuffer());
          const { bytes: refBytes, mimeType: refMime } = await downscaleForModel(rawRefBytes, refBlob.type || 'image/jpeg');
          checkerReferenceImage = {
            mediaType: refMime,
            base64: bytesToBase64(refBytes)
          };
        }
      } catch (e) {
        checkerRefDiagnostic = `threw: ${e.message || String(e)}`;
      }
    }
    if (!referenceImages.length && checkerReferenceImage) {
      referenceImages.push({
        mimeType: checkerReferenceImage.mediaType,
        base64: checkerReferenceImage.base64
      });
    }
    const model = modelForProject(project);
    // ---------- Bria one-time prep (per run, not per shot) ----------
    const isBria = model === MODEL_CHOICES.bria;
    const briaOpts = isBria && project.settings && project.settings.bria || {};
    let briaProductUri = null;
    let briaRefBgUri = null;
    if (isBria) {
      if (!referenceImages.length) throw new Error('Bria needs a product photo — upload one on the Brief page first');
      briaProductUri = `data:${referenceImages[0].mimeType};base64,${referenceImages[0].base64}`;
      // User-facing placement was removed 2026-07-18 (Owner call) — whatever
      // an older project saved, the run is automatic unless the size-in-frame
      // mapping below switches it to manual_padding.
      briaOpts.placement = 'automatic';
      // Bria's own recommended flow: cutout first, then place. No longer
      // optional — the size-in-frame mapping needs the trimmed product
      // dimensions. Runs ONCE; every shot in the batch reuses the result.
      // A cutout failure falls back to the raw photo — product-shot does
      // its own segmentation anyway.
      let briaCutoutBytes = null;
      {
        try {
          const cut = await falQueueRun(falKey, BRIA_CUTOUT_MODEL, { image_url: briaProductUri });
          if (cut.image && cut.image.url) {
            const r = await fetch(cut.image.url);
            if (r.ok) {
              briaCutoutBytes = await trimTransparent(new Uint8Array(await r.arrayBuffer()));
              briaProductUri = `data:image/png;base64,${bytesToBase64(briaCutoutBytes)}`;
            } else {
              briaProductUri = cut.image.url;
            }
          }
        } catch (_e) {}
      }
      // Size in frame → Bria (2026-07-18). Bria has no "product is X% of the
      // image height" knob — the padding around the cutout IS its size
      // control. When Size in frame is set on the Scenes page and placement
      // was left on Automatic, translate it: canvas height = cutout height /
      // fraction, product sits low (12% of the empty vertical space below
      // it), everything scaled to Bria's ~1MP sweet spot. Explicit manual
      // choices (padding / position / original) are respected untouched.
      try {
        const frac = project.tags && project.tags.placement && project.tags.placement.scale;
        if (briaCutoutBytes && frac >= 0.1 && frac <= 1 && (briaOpts.placement || 'automatic') === 'automatic') {
          const img = await Image.decode(briaCutoutBytes);
          const AR = { '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '3:4': 3 / 4, '3:2': 3 / 2, '2:3': 2 / 3 }[aspectRatio] || 1;
          const totalH = img.height / frac;
          const totalW = Math.max(totalH * AR, img.width + 16);
          const s = Math.min(1, Math.sqrt(1000000 / (totalW * totalH)));
          if (s < 1) img.resize(Math.max(1, Math.round(img.width * s)), Image.RESIZE_AUTO);
          const padV = Math.max(0, Math.round(totalH * s) - img.height);
          const padH = Math.max(0, Math.round(totalW * s) - img.width);
          const padT = Math.round(padV * 0.88);
          const padL = Math.floor(padH / 2);
          briaOpts.placement = 'manual_padding';
          briaOpts.padding = [padL, padH - padL, padT, padV - padT];
          if (s < 1) briaProductUri = `data:image/png;base64,${bytesToBase64(await img.encode())}`;
        }
      } catch (_e) {}
      // Reference background image (settings.bria.ref_image = storage path):
      // Bria generates a background MATCHING this image instead of a text brief.
      if (briaOpts.bg === 'reference' && briaOpts.ref_image) {
        const { data: bgBlob, error: bgErr } = await supabase.storage.from('projects').download(briaOpts.ref_image);
        if (bgErr || !bgBlob) throw new Error(`Bria reference background could not be loaded: ${bgErr && bgErr.message || 'no blob'}`);
        const rawBg = new Uint8Array(await bgBlob.arrayBuffer());
        const { bytes: bgBytes, mimeType: bgMime } = await downscaleForModel(rawBg, bgBlob.type || 'image/jpeg');
        briaRefBgUri = `data:${bgMime};base64,${bytesToBase64(bgBytes)}`;
      }
      // The beta cap counts saved renders; num_results multiplies output per
      // shot, so clamp it to fit what's left of the quota.
      const requested = Math.max(1, Math.min(4, parseInt(briaOpts.num_results, 10) || 1));
      briaOpts.num_results = Math.min(requested, Math.max(1, Math.floor(remainingQuota / shots.items.length)));
    }
    const outcomes = await mapWithConcurrency(shots.items, CONCURRENCY, async (item)=>{
      // Bria composites (returns 1-4 images per shot); the redraw models
      // return exactly one — normalized to an array so the save/check loop
      // below is shared.
      // With a reference background image the scene text is unused (the API
      // takes one or the other), so skip the background-only rewrite call.
      const images = isBria
        ? await generateBriaShot(falKey, {
            prompt: briaRefBgUri ? '' : await briaBackgroundBrief(falKey, project.product || project.name || 'the product', briaScenePrompt(shots, item)),
            aspectRatio,
            productUri: briaProductUri,
            refBgUri: briaRefBgUri,
            bria: briaOpts
          })
        : [await generateShotImage(falKey, {
            prompt: fullPrompt(shots, item),
            aspectRatio,
            referenceImages,
            model
          })];
      const saved = [];
      for (let v = 0; v < images.length; v++){
        const { bytes, mimeType } = images[v];
        // Unique per run (same timestamp convention as Compose's output
        // filenames)
        //item.file alone is product+motif+index, so re-running
        // a similar scene used to produce the SAME filename and the upsert
        // silently REPLACED the earlier render (real data loss the Owner hit
        // on the Bowls project, 2026-07-08). Every generation now keeps its
        // own row/file; the beta cap counts them all, which is the point.
        const base = item.file.replace(/\.[a-z0-9]+$/i, '');
        const filename = `${base}-${Date.now().toString(36)}${v > 0 ? `-v${v + 1}` : ''}.png`;
        const path = `${clientSlug}/${project.id}/renders/${filename}`;
        const { error: uploadErr } = await supabase.storage.from('projects').upload(path, bytes, {
          upsert: true,
          contentType: mimeType
        });
        if (uploadErr) throw uploadErr;
        const renderFields = {
          project_id: project.id,
          filename,
          storage_path: path,
          stage: 'render'
        };
        let checkNote = `not checked (${checkerRefDiagnostic || 'unknown reason'})`;
        if (checkerReferenceImage) {
          try {
            // Downscale the render before base64-ing it for the checker. The
            // checker only judges product fidelity, so 1024px is plenty — and
            // base64-ing a full 2K Gemini output (its native size; Seedream/GPT
            // return smaller) across 2 concurrent lanes is what tripped the
            // 512MB/CPU worker limit (HTTP 546), which is why it only showed up
            // on Gemini. The stored render (uploaded above) stays full-res.
            const { bytes: checkBytes, mimeType: checkMime } = await downscaleForModel(bytes, mimeType, 1024);
            const candidateImage = {
              mediaType: checkMime,
              base64: bytesToBase64(checkBytes)
            };
            const { checker, verdict } = await runCheckerInline(falKey, spec, checkerReferenceImage, candidateImage);
            renderFields.checker = checker;
            renderFields.verdict = verdict;
            checkNote = `checked: ${checker.stage2_verdict}`;
          } catch (checkErr) {
            checkNote = `check failed: ${checkErr.message || String(checkErr)}`;
          }
        }
        const { data: render, error: renderErr } = await supabase.from('renders').upsert(renderFields, {
          onConflict: 'project_id,filename'
        }).select().single();
        if (renderErr) throw renderErr;
        saved.push({
          file: filename,
          path,
          render,
          checkNote
        });
      }
      return saved;
    });
    const succeeded = [];
    const failed = [];
    outcomes.forEach((outcome, i)=>{
      const item = shots.items[i];
      if (outcome.ok) succeeded.push(...outcome.value);
      else failed.push({
        file: item.file,
        motif: item.motif,
        error: outcome.error?.message || String(outcome.error)
      });
    });
    await supabase.from('projects').update({
      status: 'checking'
    }).eq('id', project.id);
    const checkedCount = succeeded.filter((s)=>s.checkNote.startsWith('checked')).length;
    const summary = isBria
      ? `${succeeded.length} image${succeeded.length === 1 ? '' : 's'} from ${shots.items.length} shot${shots.items.length === 1 ? '' : 's'} via fal (${model}, composite, ${briaOpts.placement}, bg ${briaRefBgUri ? 'reference image' : 'described'}), ${checkedCount} auto-checked.` + (failed.length ? ` Failed: ${failed.map((f)=>`${f.file} (${f.error})`).join('; ')}` : '') + capNote
      : `${succeeded.length}/${shots.items.length} shots generated via fal ` + `(${model}, ${aspectRatio}, 2K cap, ${referenceImages.length} reference photo${referenceImages.length === 1 ? '' : 's'}), ${checkedCount} auto-checked.` + (failed.length ? ` Failed: ${failed.map((f)=>`${f.file} (${f.error})`).join('; ')}` : '') + capNote;
    await supabase.from('run_log').insert({
      project_id: project.id,
      step: 'generate',
      note: summary
    });
    return new Response(JSON.stringify({
      ok: failed.length === 0,
      generated: succeeded.length,
      checked: checkedCount,
      failed,
      summary
    }), {
      headers: {
        ...cors,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: err.message || String(err)
    }), {
      status: 500,
      headers: {
        ...cors,
        'Content-Type': 'application/json'
      }
    });
  }
});