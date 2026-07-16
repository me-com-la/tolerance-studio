-- 007_hires_delivery.sql — 4K delivery upscales (2026-07-16).
--
-- An approved render can be upscaled to 4K for print / large-format delivery.
-- Upscaling (NOT re-generating) keeps the exact image the client approved —
-- same composition, just reconstructed detail. The upscale Edge Function
-- (owner-only) runs fal Topaz on the stored render and writes the result
-- path here; the review-view function then serves the 4K file to the client
-- viewer's download when present. Cheap tier (~$0.08/image at ≤24MP), so a
-- studio marks only the images worth delivering big.
alter table renders
  add column if not exists hires_path text,      -- storage path of the 4K file
  add column if not exists hires_w    int,        -- upscaled pixel width
  add column if not exists hires_h    int;        -- upscaled pixel height
