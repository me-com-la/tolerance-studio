# Tolerance Studio — app-composite (pixel-preserving fork, 2026-07-06)

Duplicated from `../app/` (see that folder's README for the full pipeline
history). This fork exists to test the approach the Owner asked to revisit:
**never let a generative model touch the product's own pixels.**

## v1 was wrong — corrected same day

The first version of this fork generated the background **independently**
(no product reference in that call at all) and pasted the real cutout on top
afterward at a fixed anchor. Live-tested against a real crate+dog cutout —
**perspective and lighting didn't match, unusable.** That's because this is
exactly the "paste-AFTER" approach the vault had already tested and killed:
see `Obsidian Vault/2-Projects/Tolerance Studio/Pixel-Lock Pipeline.md`,
test #0 — "Crate pasted onto finished render — FAIL — alignment impossible,
perspective mismatch. Dead end; generate-around is the only viable order."
That prior art wasn't checked before v1 was built. It should have been.

## v2 — the proven method (Pixel-Lock), reproduced live

Full method, results, and known limits: `Pixel-Lock Pipeline.md` (linked
above) and `Tolerance Studios/tools/pixel-lock/README.md` (the operational
runbook — six controlled tests across bowl/vase/crate, real drift numbers).
Reproduced live against the same crate+dog cutout for this fork (2026-07-06):
**1px drift, scale 1.00** — tighter than the vault's own recorded 3px.

1. **Stage** — paste the real cutout onto a plain grey (235,235,235)
   2048×1536 canvas at final position/size (uniform scale only — never
   rotated).
2. **Scene generation** — send the STAGED canvas to Gemini (`nano banana`,
   `gemini-3.1-flash-image`) as an image reference, with a "keep the product
   EXACTLY as in the input, replace only the background" instruction. This
   is the part v1 skipped — the model can only draw a background/shadow
   consistent with the product's already-visible position, angle, and
   implied lighting, because it's editing an image that already contains it.
3. **Snap-back** — multi-scale (0.78–1.13) masked template match
   (`cv2.matchTemplate`, `TM_SQDIFF_NORMED`) locates where the model actually
   drew the product; the ORIGINAL cutout pixels get stamped there (1.02×
   pad, feathered alpha). The product in the final image is always real,
   untouched pixels — whatever the model drew there gets overwritten.
4. **Drift guard** — refuses (and retries, up to 2x) if score ≥ 0.08, drift
   ≥ 260px, or scale outside [0.8, 1.1]. Never ships a doubtful match.

### Why this runs as a separate local Python process, not a Supabase Edge Function

Step 3 (snap-back) needs OpenCV. Supabase Edge Functions run Deno, which has
no OpenCV equivalent worth trusting for this (a hand-rolled correlation
matcher risks being subtly wrong, in a step whose entire job is precision).
So the real compositing logic lives at **`Tolerance Studios/tools/pixel-lock/service.py`**
— a local HTTP service (`python3 service.py` → `http://127.0.0.1:8805`,
exact same tested code as `tools/pixel-lock/scripts/snapback-crate.py`,
generalized to take any cutout + prompt) — and `5-scenes-editor.html` calls
it **directly from the browser**, bypassing Edge Functions for this step
entirely: fetch the cutout from Supabase storage → POST to the local
service → upload the composite + upsert the render row, same pattern
`8-compose.html` already used for its client-side canvas compositing.

**Must be running before you click "Generate & composite these scenes":**
`python3 "Tolerance Studios/tools/pixel-lock/service.py"` — the button
surfaces a clear error (not a silent hang) if it can't reach it.

The Supabase `generate` Edge Function from v1 is still deployed but **no
longer called by anything** — Deno can't reach a localhost service, so it
can't do this step. Left in place rather than torn out; safe to delete once
this is confirmed as the real path forward.

## What's different from `../app/`

- **Compositing** — see above. Real product pixels, AI-generated scene
  matched to them via stage → image-edit → snap-back, not independent
  generation + blind paste.
- **`functions/checker.js`** and **`functions/_higgsfield-key.js`** —
  deleted. No checker anywhere in this fork.
- **`6-checker-gallery.html`** ("Check", step 3) — rewritten. No checker
  tally, no verdict pills, no approve/reject buttons, no "Run checker". Just
  every render in one grid; click a card to select it, up to **3** (further
  clicks are blocked, not auto-swapped, once 3 are selected — Owner call).
  Selection is stored the same way the old app stored its sticky override
  (`renders.human_override = 'approved'` when selected, `null` when not) —
  no schema change, and it's why...
- **`8-compose.html`** — untouched. It already reads
  `(human_override || verdict) === 'approved'` to build its "approved
  renders" strip, so the new Check page's selection mechanism feeds it with
  zero changes needed there.
- **`lib/db.js`** — `setVerdict`/`setCheckerResult` replaced with a single
  `setSelected(renderId, selected)`.

## Infra actually stood up (2026-07-06, real — not a plan)

- New isolated Supabase project `tolerance-studio-composite` (ref
  `nfvcuidghyklnyixcqrw`), under the me-com-la account (second free project
  slot), schema applied, Owner auth user created. Credentials in
  `keys-and-deploy.md`, wired into `lib/supabase.js`.
- Real edge functions deployed (`ai-draft`, `expand-shots` — both live-tested
  with real Claude calls; `generate` — v1, now superseded, see above).
- Live-tested end-to-end through the real UI: Check page selection (capped
  at 3, confirmed) → Compose picked up the selections with zero code changes
  there.

## Outstanding

1. **Guard thresholds aren't calibrated per-product** — same known issue as
   the vault's runbook (crate's big lit surface can inflate the SQDIFF score
   even at low actual drift). Same numbers for every product today.
2. **Seedream not wired** — only `gemini`/nano banana is implemented in
   `tools/pixel-lock/service.py`. The runbook's model split says seedream is
   for shots that ADD a subject beyond the locked cutout unit; not built yet.
3. **Defringe unsolved** — same flagged issue as the runbook (grey backdrop
   rim can cling to wispy cutout edges on fine-detail products). Not an
   issue on the crate test (chunky product, clean cutout).
4. **Default placement is a guess** — `service.py`'s `stage()` centers the
   product at 62% of canvas height by default (`placement` request field
   overrides it per shot) — reasonable on the crate test, not checked against
   other product shapes.
