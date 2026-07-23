// fal-iclight — IC-Light relight run split into short calls (2026-07-20).
// Why this exists: IC-Light on fal cold-boots for ~2 min after idle, which
// blew past Supabase's 150s edge-function gateway limit when `generate` both
// submitted AND polled the job in one request (the "HTTP 504" the Owner kept
// hitting). Here the work is split so no single request is ever held open:
//   action:'start'   — submit every shot to fal's queue, return job handles.
//   action:'collect' — check the handles; save any that finished; return.
// The browser calls 'start' once, then loops 'collect' every few seconds
// until all shots are done. Each call returns in seconds, so the cold boot
// happens in fal's queue while the browser polls — never inside one request.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';

const MODEL = 'fal-ai/iclight-v2';
const SIZES = {
  '1:1':  { width: 1024, height: 1024 },
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '4:3':  { width: 1152, height: 864 },
  '3:4':  { width: 864, height: 1152 },
  '3:2':  { width: 1216, height: 810 },
  '2:3':  { width: 810, height: 1216 }
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
async function downscale(bytes: Uint8Array, mimeType: string, maxEdge = 1536) {
  try {
    const img = await Image.decode(bytes);
    if (Math.max(img.width, img.height) <= maxEdge) return { bytes, mimeType };
    if (img.width >= img.height) img.resize(maxEdge, Image.RESIZE_AUTO);
    else img.resize(Image.RESIZE_AUTO, maxEdge);
    const isPng = (mimeType || '').includes('png');
    return { bytes: isPng ? await img.encode() : await img.encodeJPEG(85), mimeType: isPng ? 'image/png' : 'image/jpeg' };
  } catch (_e) { return { bytes, mimeType }; }
}
function fullPrompt(shots, item) {
  return [shots.product_lock, shots.style_lock, item.prompt].map((s) => (s || '').trim()).filter(Boolean).join('\n\n');
}

// Submit only — returns fal's queue handles immediately (no polling).
async function submit(falKey: string, body: unknown) {
  const res = await fetch(`https://queue.fal.run/${MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`fal submit error: ${JSON.stringify(out).slice(0, 300)}`);
  return { status_url: out.status_url, response_url: out.response_url };
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const falKey = Deno.env.get('FAL_KEY');
    if (!falKey) throw new Error('FAL_KEY secret not set');
    const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } }
    });
    const payload = await req.json();
    const { action, projectId } = payload;
    if (!projectId) return json({ ok: false, error: 'projectId required' }, 400);

    const { data: project, error: pErr } = await supabase.from('projects').select('*, clients(slug)').eq('id', projectId).single();
    if (pErr) throw pErr;
    const clientSlug = project.clients && project.clients.slug;
    if (!clientSlug) throw new Error('project has no client slug');

    // ---------- collect: check handles, save any that finished ----------
    if (action === 'collect') {
      const jobs = payload.jobs || [];
      const results = [];
      for (const job of jobs) {
        try {
          const sres = await fetch(job.status_url, { headers: { Authorization: `Key ${falKey}` } });
          const status = await sres.json();
          if (status.status === 'ERROR' || status.status === 'FAILED') {
            results.push({ id: job.id, done: true, error: `fal failed: ${JSON.stringify(status).slice(0, 200)}` });
            continue;
          }
          if (status.status !== 'COMPLETED') { results.push({ id: job.id, done: false }); continue; }
          const rres = await fetch(job.response_url, { headers: { Authorization: `Key ${falKey}` } });
          const result = await rres.json();
          const imgs = (result.images || []).filter((im) => im && im.url);
          if (!imgs.length) { results.push({ id: job.id, done: true, error: 'fal returned no image' }); continue; }
          for (let v = 0; v < imgs.length; v++) {
            const im = imgs[v];
            const r = await fetch(im.url);
            if (!r.ok) throw new Error(`download failed HTTP ${r.status}`);
            const bytes = new Uint8Array(await r.arrayBuffer());
            const filename = v > 0 ? job.filename.replace(/\.png$/, `-v${v + 1}.png`) : job.filename;
            const path = `${clientSlug}/${projectId}/renders/${filename}`;
            const { error: upErr } = await supabase.storage.from('projects').upload(path, bytes, { upsert: true, contentType: im.content_type || 'image/png' });
            if (upErr) throw upErr;
            // Checker is deferred — the Check page scores unchecked renders on load.
            const { error: rowErr } = await supabase.from('renders').upsert(
              { project_id: projectId, filename, storage_path: path, stage: 'render', model: 'iclight' },
              { onConflict: 'project_id,filename' });
            if (rowErr) throw rowErr;
          }
          results.push({ id: job.id, done: true });
        } catch (e) {
          results.push({ id: job.id, done: true, error: e.message || String(e) });
        }
      }
      return json({ ok: true, results });
    }

    // ---------- start: submit every shot, return handles ----------
    if (action === 'start') {
      const shots = project.shots;
      if (!shots || !shots.items || !shots.items.length) return json({ ok: false, error: 'no expanded shots — run expand-shots first' }, 400);

      // Beta cap, same rule as generate: at most MAX_IMAGES_PER_PROJECT total.
      const MAX = parseInt(Deno.env.get('MAX_IMAGES_PER_PROJECT') || '10', 10);
      const { count: existing } = await supabase.from('renders').select('*', { count: 'exact', head: true }).eq('project_id', projectId);
      const remaining = MAX - (existing || 0);
      if (remaining <= 0) return json({ ok: false, error: `Beta limit reached: ${MAX} images per project.` }, 400);
      const items = shots.items.slice(0, remaining);

      // IC-Light relights ONE product photo. Prefer the first asset; fall back
      // to the project reference image.
      let productUri = null;
      try {
        const { data: files } = await supabase.storage.from('projects').list(`${clientSlug}/${projectId}/assets`, { limit: 5 });
        const first = (files || []).find((f) => f.id);
        const key = first ? `${clientSlug}/${projectId}/assets/${first.name}` : project.reference_image;
        if (key) {
          const { data: blob } = await supabase.storage.from('projects').download(key);
          if (blob) {
            const { bytes, mimeType } = await downscale(new Uint8Array(await blob.arrayBuffer()), blob.type || 'image/jpeg');
            productUri = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
          }
        }
      } catch (_e) {}
      if (!productUri) throw new Error('no product photo found to relight — upload one on the Brief page first');

      const aspect = (project.settings && project.settings.generation_aspect) || '1:1';
      const opts = (project.settings && project.settings.iclight) || {};
      const num_images = Math.max(1, Math.min(4, parseInt(opts.num_images, 10) || 1));
      const input0: Record<string, unknown> = {
        image_url: productUri,
        image_size: SIZES[aspect] || SIZES['1:1'],
        num_images,
        num_inference_steps: 12,
        output_format: 'png'
      };
      if (['Left', 'Right', 'Top', 'Bottom'].includes(opts.light)) input0.initial_latent = opts.light;

      const stamp = Date.now().toString(36);
      const jobs = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const base = item.file.replace(/\.[a-z0-9]+$/i, '');
        const filename = `${base}-${stamp}-${i}.png`;
        const { status_url, response_url } = await submit(falKey, { ...input0, prompt: fullPrompt(shots, item) });
        jobs.push({ id: i, filename, status_url, response_url });
      }
      await supabase.from('projects').update({ status: 'checking' }).eq('id', projectId);
      return json({ ok: true, jobs });
    }

    return json({ ok: false, error: `unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) }, 500);
  }
});
