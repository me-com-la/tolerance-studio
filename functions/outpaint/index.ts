// supabase/functions/outpaint/index.ts — the Compose page's "Extend image"
// step (horizontal banners, first cut).
//
// What it does: takes a green-bordered PNG built in the browser (the real
// approved render placed on one side of a wider canvas, the rest painted
// pure #00FF00) and runs fal's FLUX.2 [klein] 4B outpaint LoRA, which fills
// the green area with a coherent extension of the scene — leaving the
// subject fully in frame and a clean run of background for the copy to sit
// on. This replaces v1's Firefly generative-expand (see keys-and-deploy.md
// history); we're fal-only now (Owner rule), and this LoRA is the cheapest
// path that does true edge-aware outpainting (~$0.016/MP vs image-apps-v2
// outpaint's $0.035/MP — chosen deliberately, the Owner tested both).
//
// Same fal async-queue pattern as generate/index.ts (falQueueRun below is a
// verbatim port). fal accepts the green-bordered image as a data URI in
// image_urls, exactly like generate passes reference photos, so there's no
// separate upload round-trip. fal returns a hosted URL; we download it here
// and hand the browser base64 back, so the compose canvas draws from a
// same-origin data URI and never taints on toBlob() at save time.
//
// Call shape: POST { imageDataUri } (a "data:image/png;base64,…" string),
// Authorization: Bearer <user JWT> — auth is required (matches every other
// function's callFunction path) but no project row is touched.
const OUTPAINT_MODEL = Deno.env.get('OUTPAINT_MODEL') || 'fal-ai/flux-2/klein/4b/base/edit/lora';
// The green-screen outpaint LoRA weights (fal's own, on HF). scale 1.1 is
// the value fal documents for this LoRA — strong enough to honor the green
// mask without over-cooking the fill.
const OUTPAINT_LORA_URL = Deno.env.get('OUTPAINT_LORA_URL') ||
  'https://huggingface.co/fal/flux-2-klein-4B-outpaint-lora/resolve/main/flux-outpaint-lora.safetensors';
const OUTPAINT_LORA_SCALE = parseFloat(Deno.env.get('OUTPAINT_LORA_SCALE') || '1.1');
// The LoRA's trigger phrase plus a subject guard (2026-07-16). The bare
// trigger phrase alone duplicated the product on wide frames: banner /
// Facebook-ad sizes leave a green area bigger than the product itself, and
// handed that much blank space the model painted a second copy of the
// subject into it (reproduced 2/2 in A/B testing against fal; the guarded
// prompt came back clean 4/4). Env-overridable like the model and LoRA so
// wording can be tuned without a redeploy.
const OUTPAINT_PROMPT = Deno.env.get('OUTPAINT_PROMPT') ||
  'Fill the green spaces according to the image. Continue only the empty ' +
  'background scene into the green area; do not add, repeat, or duplicate ' +
  'the main subject, the product, or any similar object anywhere in the new area.';

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked so a ~1-2MB PNG doesn't blow the argument limit on
  // String.fromCharCode(...spread) the way the whole array at once would.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Submits to fal's async queue and polls to completion — verbatim port of
// generate/index.ts's falQueueRun (submit carries status_url/response_url;
// poll every 2s, 120s deadline).
async function falQueueRun(falKey: string, model: string, body: unknown) {
  const submitRes = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const submitted = await submitRes.json();
  if (!submitRes.ok) throw new Error(`fal submit error: ${JSON.stringify(submitted).slice(0, 300)}`);
  const { status_url, response_url } = submitted;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const sres = await fetch(status_url, { headers: { Authorization: `Key ${falKey}` } });
    const status = await sres.json();
    if (status.status === 'COMPLETED') {
      const rres = await fetch(response_url, { headers: { Authorization: `Key ${falKey}` } });
      const result = await rres.json();
      if (!rres.ok) throw new Error(`fal result error: ${JSON.stringify(result).slice(0, 300)}`);
      return result;
    }
    if (status.status === 'ERROR' || status.status === 'FAILED') {
      throw new Error(`fal outpaint failed: ${JSON.stringify(status).slice(0, 300)}`);
    }
  }
  throw new Error('fal outpaint timed out after 120s');
}

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader) throw new Error('not signed in');
    const { imageDataUri } = await req.json();
    if (!imageDataUri || typeof imageDataUri !== 'string' || !imageDataUri.startsWith('data:image/')) {
      return new Response(JSON.stringify({ ok: false, error: 'imageDataUri (a data:image/… PNG) required' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    const falKey = Deno.env.get('FAL_KEY');
    if (!falKey) throw new Error('FAL_KEY secret not set');

    const result = await falQueueRun(falKey, OUTPAINT_MODEL, {
      prompt: OUTPAINT_PROMPT,
      image_urls: [imageDataUri],
      loras: [{ path: OUTPAINT_LORA_URL, scale: OUTPAINT_LORA_SCALE }],
      output_format: 'png',
    });

    const img = (result.images || [])[0];
    if (!img || !img.url) throw new Error(`fal returned no image: ${JSON.stringify(result).slice(0, 300)}`);
    const imgRes = await fetch(img.url);
    if (!imgRes.ok) throw new Error(`failed to download extended image: HTTP ${imgRes.status}`);
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    const mimeType = img.content_type || 'image/png';

    return new Response(JSON.stringify({
      ok: true,
      imageBase64: bytesToBase64(bytes),
      mimeType,
      width: img.width || null,
      height: img.height || null,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  }
});
