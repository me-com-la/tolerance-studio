// review-view — public, read-only client review endpoint (2026-07-15).
//
// The client-facing review page (app/review.html) has NO Supabase session:
// a client has no account, and mail apps open links in an in-app browser
// with no login anyway. So this function does its own auth via a per-project
// share token (migration 006) and reads with the SERVICE ROLE key, never
// exposing that key to the browser.
//
// DEPLOY NOTE: this function must be deployed with `verify_jwt = false` so
// anon visitors can reach it. Security does not come from the JWT gateway
// here — it comes from the share token + the status guard below (only
// projects at 'review'/'delivered' are ever returned). RLS is untouched.
//
// The browser calls it with the anon apikey only (no Bearer session):
//   POST /functions/v1/review-view   { "token": "<uuid>" }
// and gets back { ok, project, renders[], animations[] } with short-lived
// signed URLs for the private `projects` bucket.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SIGNED_URL_TTL = 3600; // 1h — regenerated on every page load, so this
                             // only needs to outlast a single viewing session.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { token } = await req.json().catch(() => ({}));
    if (!token) return json({ ok: false, error: 'token required' }, 400);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Token must match AND the project must have reached a shareable stage —
    // same rule the client RLS policy enforces for logged-in client users.
    const { data: project, error: projErr } = await supabase
      .from('projects')
      .select('id, name, settings, status, clients(name, slug)')
      .eq('share_token', token)
      .in('status', ['review', 'delivered'])
      .single();
    if (projErr || !project) return json({ ok: false, error: 'This review link is not available.' }, 404);

    const bucket = supabase.storage.from('projects');
    const sign = async (path: string | null | undefined): Promise<string> => {
      if (!path) return '';
      const { data } = await bucket.createSignedUrl(path, SIGNED_URL_TTL);
      return data?.signedUrl || '';
    };
    // Egress guard (2026-07-17): grid display gets a server-side resized webp
    // (~90% smaller than the 2K PNG). Full-res `url` stays for downloads and
    // the lightbox. Falls back to the plain signed URL if transforms fail.
    const signPreview = async (path: string | null | undefined): Promise<string> => {
      if (!path) return '';
      const { data } = await bucket.createSignedUrl(path, SIGNED_URL_TTL, {
        transform: { width: 1600, quality: 78, resize: 'contain' },
      });
      return data?.signedUrl || '';
    };

    // Same client-facing filter as 7-review-gallery.html init(): composed
    // images, plus anything approved at Check that skipped Compose.
    const { data: allRenders } = await supabase
      .from('renders')
      .select('id, filename, storage_path, stage, verdict, human_override')
      .eq('project_id', project.id)
      .order('filename');
    const shown = (allRenders || []).filter(
      (r) => r.stage === 'composed' || (r.human_override || r.verdict) === 'approved',
    );
    // A 4K delivery is its own render (filename ends -4k), so it comes through
    // here as a normal card; the viewer badges it off the filename.
    const renders = await Promise.all(
      shown.map(async (r) => ({
        id: r.id,
        filename: r.filename,
        url: await sign(r.storage_path),
        preview_url: (await signPreview(r.storage_path)) || (await sign(r.storage_path)),
      })),
    );

    // Finished animation clips only (status 'done'). Carry the pad/crop math
    // so review.html can CSS-crop a raw clip back to the composed size, the
    // same way the owner gallery does.
    const jobs = (project.settings?.animation_jobs || []).filter(
      (j: any) => j.status === 'done' && (j.final_path || j.storage_path),
    );
    const animations = await Promise.all(
      jobs.map(async (j: any) => ({
        id: j.id,
        url: await sign(j.final_path || j.storage_path),
        isFinal: !!j.final_path,
        w: j.w, h: j.h, padW: j.padW, offX: j.offX, offY: j.offY,
        baseName: j.baseName || '', sizeKey: j.sizeKey || '',
      })),
    );

    return json({
      ok: true,
      project: { name: project.name, client: project.clients?.name || '' },
      renders,
      animations,
    });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message || String(e) }, 500);
  }
});
