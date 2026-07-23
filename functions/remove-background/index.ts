// remove-background — BiRefNet v2 cutout via fal (2026-07-20, Owner call:
// replace rembg, which kept picking the wrong subject — e.g. the dog instead
// of the crate — and OOM'd Cloud Run on big photos; see the pixel-lock OOM
// notes). BiRefNet is fal-hosted, so no container memory to manage, and its
// Heavy model at 2048px holds fine detail (mesh, fur, thin legs) that rembg
// dropped. Same request/response contract as the old Cloud Run endpoint:
// { image_b64, mime_type? } in, { cutout_b64 } out — callers didn't change.
const BIREFNET_MODEL = 'fal-ai/birefnet/v2';

async function falQueueRun(falKey: string, model: string, body: unknown) {
  const submitRes = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
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
      throw new Error(`fal background removal failed: ${JSON.stringify(status).slice(0, 300)}`);
    }
  }
  throw new Error('fal background removal timed out after 120s');
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const falKey = Deno.env.get('FAL_KEY');
    if (!falKey) throw new Error('FAL_KEY secret not set');
    const { image_b64, mime_type } = await req.json();
    if (!image_b64) {
      return new Response(JSON.stringify({ ok: false, error: 'image_b64 required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
    const result = await falQueueRun(falKey, BIREFNET_MODEL, {
      image_url: `data:${mime_type || 'image/jpeg'};base64,${image_b64}`,
      model: 'General Use (Heavy)',
      operating_resolution: '2048x2048',
      refine_foreground: true,
      output_format: 'png'
    });
    if (!result.image || !result.image.url) {
      throw new Error(`birefnet returned no image: ${JSON.stringify(result).slice(0, 300)}`);
    }
    const r = await fetch(result.image.url);
    if (!r.ok) throw new Error(`failed to download cutout: HTTP ${r.status}`);
    const cutout_b64 = bytesToBase64(new Uint8Array(await r.arrayBuffer()));
    return new Response(JSON.stringify({ ok: true, cutout_b64 }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message || String(err) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});
