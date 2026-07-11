import { createClient } from 'npm:@supabase/supabase-js@2';
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
  seedream: 'fal-ai/bytedance/seedream/v4/edit',
  gpt: 'fal-ai/gpt-image-1.5/edit'
};
function modelForProject(project) {
  return MODEL_CHOICES[project.settings && project.settings.image_model] || IMAGE_MODEL;
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
    const SIZES = {
      '1:1':  { width: 2048, height: 2048 },
      '16:9': { width: 2560, height: 1440 },
      '9:16': { width: 1440, height: 2560 },
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
  const result = await falQueueRun(falKey, model || IMAGE_MODEL, falInputFor(model || IMAGE_MODEL, prompt, image_urls, aspectRatio));
  const img = (result.images || [])[0];
  if (!img || !img.url) throw new Error(`fal returned no image: ${JSON.stringify(result).slice(0, 300)}`);
  const imgRes = await fetch(img.url);
  if (!imgRes.ok) throw new Error(`failed to download generated image: HTTP ${imgRes.status}`);
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  return {
    bytes,
    mimeType: img.content_type || 'image/png'
  };
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
"score": 0-100 
 a single overall fidelity score for how closely IMAGE 2 — matches IMAGE 1 against this checklist (100 = perfect match, 0 = completely
wrong product)}`;
  const text = await callFalVision(falKey, sourceImage, candidateImage, instructions);
  const result = JSON.parse(text);
  const sev = {};
  for (const c of checks)sev[c.id] = c.severity;
  const threshold = spec.rules && spec.rules.confidence_below || 80;
  let stage2Verdict = 'PASS';
  for (const it of result.items){
    if (it.verdict === 'fail' && sev[it.id] === 'reject') {
      stage2Verdict = 'REJECT';
      break;
    }
  }
  if (stage2Verdict === 'PASS') {
    for (const it of result.items){
      if (it.verdict === 'n/a') continue;
      if (it.confidence < threshold || it.verdict === 'fail' && sev[it.id] === 'flag') {
        stage2Verdict = 'HUMAN_REVIEW';
      }
    }
  }
  const checkerResult = {
    spec: `${spec.sku}/${spec.variant}`,
    model: CHECKER_MODEL,
    stage2_verdict: stage2Verdict,
    items: result.items,
    overall_notes: result.overall_notes || '',
    // Single 0-100 fidelity number (Owner call 2026-07-09) 
    //the checker
    // gallery shows this as a one-number badge, no per-item breakdown.
    score: typeof result.score === 'number' ? Math.max(0, Math.min(100, Math.round(result.score))) : null
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
          const bytes = new Uint8Array(await blob.arrayBuffer());
          referenceImages.push({
            mimeType: blob.type || 'image/jpeg',
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
          const refBytes = new Uint8Array(await refBlob.arrayBuffer());
          checkerReferenceImage = {
            mediaType: refBlob.type || 'image/jpeg',
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
    const outcomes = await mapWithConcurrency(shots.items, CONCURRENCY, async (item)=>{
      const prompt = fullPrompt(shots, item);
      const { bytes, mimeType } = await generateShotImage(falKey, {
        prompt,
        aspectRatio,
        referenceImages,
        model
      });
      // Unique per run (same timestamp convention as Compose's output
      // filenames) 
      //item.file alone is product+motif+index, so re-running
      // a similar scene used to produce the SAME filename and the upsert
      // silently REPLACED the earlier render (real data loss the Owner hit
      // on the Bowls project, 2026-07-08). Every generation now keeps its
      // own row/file; the beta cap counts them all, which is the point.
      const base = item.file.replace(/\.[a-z0-9]+$/i, '');
      const filename = `${base}-${Date.now().toString(36)}.png`;
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
          const candidateImage = {
            mediaType: mimeType,
            base64: bytesToBase64(bytes)
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
      return {
        file: filename,
        path,
        render,
        checkNote
      };
    });
    const succeeded = [];
    const failed = [];
    outcomes.forEach((outcome, i)=>{
      const item = shots.items[i];
      if (outcome.ok) succeeded.push(outcome.value);
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
    const summary = `${succeeded.length}/${shots.items.length} shots generated via fal ` + `(${model}, ${aspectRatio}, 2K cap, ${referenceImages.length} reference photo${referenceImages.length === 1 ? '' : 's'}), ${checkedCount} auto-checked.` + (failed.length ? ` Failed: ${failed.map((f)=>`${f.file} (${f.error})`).join('; ')}` : '') + capNote;
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