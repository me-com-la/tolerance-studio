// upscale — owner-only 4K delivery upscale of an approved render (2026-07-16).
//
// Upscales the EXACT stored render (not a re-generation) via fal Topaz, so the
// delivered 4K file is the same image the client approved — just more pixels
// and reconstructed detail. Owner-triggered from 7-review-gallery.html; the
// review-view function then hands the 4K file to the client viewer's download.
//
// Same auth pattern as generate/index.ts: called with the Owner's session JWT
// (deploy with verify_jwt = true / default), so RLS is what scopes access —
// only the Owner can read a render's storage_path and write hires_path back.
// FAL_KEY is the same deployed secret generate uses (the copy in
// keys-and-deploy.md is stale, but the live secret is fine).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';

// Topaz "Standard V2" at 2x turns a ~2K render into ~4K (~12–17MP), which
// lands in fal's ≤24MP tier (~$0.08/image). Renders are always ~2K, so a
// flat 2x stays in that tier without needing the source dimensions up front.
const TOPAZ_MODEL = 'fal-ai/topaz/upscale/image';
const UPSCALE_FACTOR = 2;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

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
    const s = await (await fetch(status_url, { headers: { Authorization: `Key ${falKey}` } })).json();
    if (s.status === 'COMPLETED') {
      const r = await fetch(response_url, { headers: { Authorization: `Key ${falKey}` } });
      const result = await r.json();
      if (!r.ok) throw new Error(`fal result error: ${JSON.stringify(result).slice(0, 300)}`);
      return result;
    }
    if (s.status === 'ERROR' || s.status === 'FAILED') {
      throw new Error(`fal upscale failed: ${JSON.stringify(s).slice(0, 300)}`);
    }
  }
  throw new Error('fal upscale timed out after 120s');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { renderId } = await req.json().catch(() => ({}));
    if (!renderId) return json({ ok: false, error: 'renderId required' }, 400);

    const authHeader = req.headers.get('Authorization') || '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const falKey = Deno.env.get('FAL_KEY');
    if (!falKey) throw new Error('FAL_KEY secret not set');

    // RLS: this read only succeeds for the Owner (or the render's client),
    // so no extra role check is needed — a stranger's JWT gets nothing here.
    const { data: render, error: rErr } = await supabase
      .from('renders')
      .select('id, storage_path, filename, project_id, projects(id, clients(slug))')
      .eq('id', renderId)
      .single();
    if (rErr || !render) throw (rErr || new Error('render not found'));
    const slug = (render as any).projects?.clients?.slug;
    if (!render.storage_path || !slug) throw new Error('render has no storage path / client slug');

    // fal fetches the image by URL — sign the private-bucket object.
    const { data: signed, error: sErr } = await supabase
      .storage.from('projects').createSignedUrl(render.storage_path, 600);
    if (sErr || !signed?.signedUrl) throw (sErr || new Error('could not sign source image'));

    const result = await falQueueRun(falKey, TOPAZ_MODEL, {
      image_url: signed.signedUrl,
      model: 'Standard V2',
      upscale_factor: UPSCALE_FACTOR,
      output_format: 'jpeg',
    });
    const out = result.image;
    if (!out?.url) throw new Error(`fal returned no image: ${JSON.stringify(result).slice(0, 300)}`);

    const bytes = new Uint8Array(await (await fetch(out.url)).arrayBuffer());
    let w: number | null = null, h: number | null = null;
    try { const im = await Image.decode(bytes); w = im.width; h = im.height; } catch (_) { /* dims are cosmetic */ }

    // Save the 4K as its OWN render row (mirrors edit-render: a brand-new
    // filename so both versions sit side by side as separate thumbnails).
    // The '-4k' suffix is what the galleries key the "4K" badge off. stage
    // 'composed' so it passes the review/viewer filter and shows up. upsert
    // on (project_id, filename) so re-running replaces the 4K, no duplicate.
    const base = render.filename.replace(/\.[a-z0-9]+$/i, '');
    const filename = `${base}-4k.jpg`;
    const path = `${slug}/${render.project_id}/renders/${filename}`;
    const { error: upErr } = await supabase
      .storage.from('projects').upload(path, bytes, { upsert: true, contentType: out.content_type || 'image/jpeg' });
    if (upErr) throw upErr;

    const { data: newRender, error: insErr } = await supabase
      .from('renders')
      .upsert({ project_id: render.project_id, filename, storage_path: path, stage: 'composed' },
        { onConflict: 'project_id,filename' })
      .select('id, filename')
      .single();
    if (insErr) throw insErr;

    return json({ ok: true, render: newRender, w, h });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message || String(e) }, 500);
  }
});
