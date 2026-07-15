// supabase/functions/animate/index.ts
//
// Image → short video clip via fal (Kling 2.5 Turbo Pro image-to-video).
// First iteration of the "Animate" feature (2026-07-14, R&D): Compose sends
// a CLEAN frame (photo layer only, no text — text is re-overlaid client-side
// so it stays sharp), this function drives fal's async queue.
//
// Unlike generate/edit-render, video takes 1–5 minutes — far past what a
// synchronous edge call should hold open. So this function is split into
// stateless actions and the BROWSER owns the job state
// (project.settings.animation_jobs) and all storage writes, same
// division of labor as edit-render:
//   submit   { image_url, prompt, duration? }  -> { request_id, status_url, response_url }
//   status   { status_url }                     -> { status }
//   result   { response_url }                   -> { video_url }
//   download { video_url }                      -> { video_b64, mime_type }
//     (download exists because fal's storage may not serve CORS headers the
//      browser can use — the function proxies the bytes instead.)
//
// URL allowlists below keep the proxy actions from being a generic
// fetch-anything-with-our-FAL-key endpoint.

const VIDEO_MODEL = Deno.env.get("VIDEO_MODEL") || "fal-ai/kling-video/v2.5-turbo/pro/image-to-video";
const FAL_KEY = Deno.env.get("FAL_KEY");
// Vision model for the `suggest` action — same fal OpenRouter route + model
// as the checker, so no new provider or key (fal-only rule).
const SUGGEST_MODEL = Deno.env.get("SUGGEST_MODEL") || "anthropic/claude-haiku-4.5";
const CHAT_API = "https://fal.run/openrouter/router/openai/v1/chat/completions";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Queue URLs must point at fal's own queue host — the client passes them
// back to us verbatim, so never fetch anything else with the FAL key.
function assertQueueUrl(url: string) {
  if (!/^https:\/\/queue\.fal\.run\//.test(url || "")) {
    throw new Error("not a fal queue URL");
  }
}
// Result videos are served from fal's storage hosts.
function assertVideoUrl(url: string) {
  let host = "";
  try { host = new URL(url).host; } catch (_e) { /* falls through */ }
  const ok = host === "storage.googleapis.com" ||
    host === "fal.media" || host.endsWith(".fal.media") ||
    host.endsWith(".fal.run") || host.endsWith(".fal.ai");
  if (!ok) throw new Error("not a fal video URL");
}

// suggest: vision model looks at the actual composed frame and drafts the
// editable part of the motion prompt — what, of the things ALREADY in the
// frame, can move a little. The user sees and edits this text in the Animate
// modal before anything is generated (transparency, Owner call 2026-07-15).
// Only frames from our own storage are fetched (SUPABASE_URL host check),
// so this can't be used as a fetch-anything proxy.
function assertFrameUrl(url: string) {
  const own = new URL(Deno.env.get("SUPABASE_URL") || "https://x.invalid").host;
  let host = "";
  try { host = new URL(url).host; } catch (_e) { /* falls through */ }
  if (!host || host !== own) throw new Error("not a project storage URL");
}

async function suggest(imageUrl: string) {
  assertFrameUrl(imageUrl);
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`could not read frame: HTTP ${imgRes.status}`);
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  let binary = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  const mediaType = imgRes.headers.get("Content-Type") || "image/png";
  const instructions =
    "You write the motion description for turning this still product photo into a ~5-second, " +
    "very subtle, seamlessly looping video clip. Look at the photo. Name only things ALREADY " +
    "visible in the frame that could plausibly move a little — plants or flowers swaying, fabric " +
    "stirring, existing shadows or light drifting, water rippling. Write 2 to 4 short plain " +
    "sentences describing that subtle motion. Hard rules: never invent objects that are not in " +
    "the photo; the product itself stays perfectly still; no people, smoke, steam or particles; " +
    "no camera movement. Output ONLY the motion sentences — no preamble, no list markers.";
  const res = await fetch(CHAT_API, {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: SUGGEST_MODEL,
      max_tokens: 400,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${btoa(binary)}` } },
          { type: "text", text: instructions },
        ],
      }],
    }),
  });
  const out = await res.json();
  if (!res.ok || out.error) throw new Error(`fal suggest error: ${JSON.stringify(out.error || out).slice(0, 300)}`);
  const text = (out.choices || []).map((c: { message?: { content?: string } }) => c.message?.content || "").join("").trim();
  if (!text) throw new Error("fal returned no suggestion text");
  return { ok: true, suggestion: text };
}

async function submit(imageUrl: string, prompt: string, duration: string, tailImageUrl?: string) {
  const res = await fetch(`https://queue.fal.run/${VIDEO_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      image_url: imageUrl,
      // Seamless-loop mode: same frame as start AND end, so Kling choreographs
      // the motion back to the opening frame — a true native loop, no reverse
      // bounce needed downstream. Omitted entirely for the classic pingpong path.
      ...(tailImageUrl ? { tail_image_url: tailImageUrl } : {}),
      duration: duration === "10" ? "10" : "5",
      // Forbids the two failure modes seen on the first clips: ADDED elements
      // (smoke came from the old prompt's "steam"; the phantom window from
      // nothing locking architecture) and any product/scene distortion.
      negative_prompt: "smoke, steam, fog, mist, haze, dust, particles, sparks, " +
        "new objects, added objects, extra objects, added windows, moving architecture, " +
        "people, hands, birds, animals, floating objects, " +
        "text, letters, captions, watermark, " +
        "camera movement, zoom, pan, rotation, shaking, " +
        "morphing, warping, distortion, deformation, flicker, blur, low quality",
      // cfg_scale: higher = obey the prompt (and its "nothing added" rules)
      // more strictly, less improvising. Nudged 0.5 -> 0.7 for tighter control.
      cfg_scale: 0.7,
    }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`fal submit error: ${JSON.stringify(out).slice(0, 300)}`);
  return { ok: true, request_id: out.request_id, status_url: out.status_url, response_url: out.response_url };
}

async function status(statusUrl: string) {
  assertQueueUrl(statusUrl);
  const res = await fetch(statusUrl, { headers: { Authorization: `Key ${FAL_KEY}` } });
  const out = await res.json();
  if (!res.ok) throw new Error(`fal status error: ${JSON.stringify(out).slice(0, 300)}`);
  return { ok: true, status: out.status, queue_position: out.queue_position ?? null };
}

async function result(responseUrl: string) {
  assertQueueUrl(responseUrl);
  const res = await fetch(responseUrl, { headers: { Authorization: `Key ${FAL_KEY}` } });
  const out = await res.json();
  if (!res.ok) throw new Error(`fal result error: ${JSON.stringify(out).slice(0, 300)}`);
  const url = out?.video?.url;
  if (!url) throw new Error(`fal returned no video: ${JSON.stringify(out).slice(0, 300)}`);
  return { ok: true, video_url: url };
}

async function download(videoUrl: string) {
  assertVideoUrl(videoUrl);
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`failed to download video: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Chunked btoa — String.fromCharCode(...bytes) overflows the arg limit on
  // multi-MB videos.
  let binary = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return {
    ok: true,
    video_b64: btoa(binary),
    mime_type: res.headers.get("Content-Type") || "video/mp4",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    if (!FAL_KEY) throw new Error("FAL_KEY secret not set");
    const p = await req.json();
    switch (p.action) {
      case "suggest": {
        if (!p.image_url) return json({ ok: false, error: "image_url is required" }, 400);
        return json(await suggest(p.image_url));
      }
      case "submit": {
        if (!p.image_url || !p.prompt) return json({ ok: false, error: "image_url and prompt are required" }, 400);
        return json(await submit(p.image_url, p.prompt, p.duration, p.tail_image_url));
      }
      case "status": {
        if (!p.status_url) return json({ ok: false, error: "status_url is required" }, 400);
        return json(await status(p.status_url));
      }
      case "result": {
        if (!p.response_url) return json({ ok: false, error: "response_url is required" }, 400);
        return json(await result(p.response_url));
      }
      case "download": {
        if (!p.video_url) return json({ ok: false, error: "video_url is required" }, 400);
        return json(await download(p.video_url));
      }
      default:
        return json({ ok: false, error: "unknown action (use suggest/submit/status/result/download)" }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
