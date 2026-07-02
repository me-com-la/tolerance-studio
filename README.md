# Rapp — Lexus & Toyota Image Library

Local image library scraped from lexus.com and toyota.com, browsed through a
password-gated viewer, deployed to GitHub Pages.

**Standing rule: never commit, push, or deploy without explicit go-ahead.
The site is live and in use. Everything below is local until the final
deploy step, which always requires approval.**

## Which doc do I need?

| I want to… | Open |
|---|---|
| Do the weekly check for new/removed images | `WEEKLY-UPDATE.md` |
| Do the full re-scrape (every ~3 months) | `QUARTERLY-FULL-SCRAPE.md` |
| Start/stop the local viewer | `TERMINAL_COMMANDS.md` |
| Understand how the scrapers/viewer work internally | `SCRAPER_NOTES.md` |

## File map

**Scripts — weekly routine (in the order you run them)**
- `weekly_diff.py` — scans the live sites, compares against the manifests, writes `diff_report.json`. No downloads, changes nothing.
- `diff_review.html` — browser page to eyeball the diff report (needs the local server running).
- `apply_removed.py` — deletes reviewed-and-confirmed removed images (file + manifest entry). Destructive — read the warnings in `WEEKLY-UPDATE.md` first.
- `download_new.py` — fast path to download only the "added" URLs. **Still misnames some models (see WEEKLY-UPDATE.md) — prefer re-running the scraper for now.**
- `log_update.py` — appends the week's changes to `update_log.json` (shown on `update_log.html`). Run once per pass.

**Scripts — full scrape**
- `toyota_scraper.py` / `lexus_scraper.py` — the main scrapers. Safe to re-run; they skip what they already have.
- `toyota_tagger.py` / `lexus_tagger.py` — face/people tagging (Apple Vision, free, on-device).
- `describe_images.py` — AI keywords per image (Claude vision, ~$0.02/image, needs API key from `keys-and-deploy.md`).
- `condense_keywords.py` — merges near-duplicate AI keywords into canonical names
  ("tires", "alloy wheels", "wheel detail" → "wheels"). Runs automatically at the
  end of every describe_images.py pass — no separate step. Backs up both manifests
  to `backups/` first; `--dry-run` to preview. The merge map lives at the top of
  the script — run it by hand only after editing that map.
- `make_thumbs.sh` — thumbnail generation (scrapers also make thumbs as they go).

**Scripts — hand tagging**
- `apply_tags.py` — applies hand-made tag changes exported from the viewer. In the
  viewer sidebar open "Tagging", turn tag mode on, click the badge on images (or
  press T in the lightbox), then "Download patch file" and run this script on it.
  Tags land in the manifests' `custom` field and power the "Parts" sidebar filter.
  Full steps in the script's header. Safe across scrapes — the scrapers never
  overwrite existing manifest entries.

**Data**
- `Lexus/manifest.json`, `Toyota/manifest.json` — the catalogs. One entry per image: file, model, category, keywords. The viewer reads these.
- `Lexus/library/`, `Toyota/library/` — the image files, one folder per model.
- `diff_report.json` — latest weekly scan result (overwritten per scan).
- `update_log.json` — running history of maintenance passes.

**Pages** (all password-gated via `auth.js`)
- `index.html` — the viewer, served at the site root by GitHub Pages. (`viewer.html` was a duplicate copy of this and has been removed — one codebase now.)
- `keywords.html` — standalone keyword browser.
- `update_log.html` — public-facing "what changed" page.

**Other scripts** — `toyota_retag.py`, `toyota_scene_tagger.py` (scene tags, currently parked), `lexus_tagger.py`. See `SCRAPER_NOTES.md`.
