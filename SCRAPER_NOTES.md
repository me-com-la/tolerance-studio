# Lexus & Toyota Image Scraper — Process Notes

Last verified: 2026-06-29

---

## Folder Structure

```
Rapp/
├── lexus_scraper.py          # Lexus scraper (run this)
├── toyota_scraper.py         # Toyota scraper (TBD)
├── SCRAPER_NOTES.md          # this file
├── Lexus/
│   ├── manifest.json         # dedup index — keyed by md5(url+subfolder)
│   └── library/
│       ├── ux-hybrid/
│       │   ├── gallery/      # Scene7 CDN — exterior/interior/wheels tab images
│       │   ├── hero/         # AEM CDN — full-width hero image(s) at page top
│       │   └── design/       # AEM CDN — all large images from the Design tab overlay
│       ├── nx/
│       │   ├── gallery/
│       │   ├── hero/
│       │   └── design/
│       └── ...               # same structure for every model
└── Toyota/
    ├── manifest.json
    └── library/
        ├── rav4/
        └── ...
```

---

## Full Process — Run in This Order

Every script is safe to re-run. All steps skip already-processed images automatically.

```bash
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp

# ── Step 1: Scrape images ────────────────────────────────────────────
python3 lexus_scraper.py                         # all Lexus models
python3 toyota_scraper.py                        # all Toyota models
python3 toyota_scraper.py --models 4runner camry # or target specific models

# ── Step 2: Face / people tagging (Apple Vision, free, on-device) ───
python3 lexus_tagger.py
python3 toyota_tagger.py
# Adds "people" / "face" tags to manifest entries. Sets tagged: true so re-runs skip.

# ── Step 3: AI keyword tagging (Claude Sonnet vision, ~$0.02/image) ─
export ANTHROPIC_API_KEY=$(grep 'Anthropic image vision key' \
  /Users/gy/Documents/ClaudeCowork/keys-and-deploy.md | awk '{print $NF}')
python3 describe_images.py --brand lexus
python3 describe_images.py --brand toyota
# Adds keywords: [...] array (10 art-director keywords per image).
# Skips images that already have a keywords field. Use --redescribe to overwrite.

# ── Step 4: Deploy ───────────────────────────────────────────────────
# Push Lexus/manifest.json, Toyota/manifest.json, viewer.html
# to me-com-la.github.io/library (GitHub Pages, free account)
# See keys-and-deploy.md for the push token.
```

### Current library status (2026-06-29)
| Brand  | Models | Images | People Tagged | AI Keywords |
|--------|--------|--------|--------------|-------------|
| Lexus  | 20     | 327    | ✓ all        | ✓ all       |
| Toyota | 23     | 887    | ✓ all        | ✓ all       |

Missing from toyota.com as of 2026-06-29: none (4Runner added 2026-06-29).

---

## Lexus Scraper — How It Works

### Model discovery (runs every time)
Scrapes four category pages to get the current model list:
- `/models/categories/suvs`
- `/models/categories/sedans`
- `/models/categories/hybrids`
- `/models/categories/performance`

Filters out: `future`, `upcoming`, `tz` (concept/not-yet-released).

### Three capture types per model

#### 1. gallery/ — Scene7 CDN
CDN: `tmna.assetscs.toyota.com/is/image/lexusaemcs/...`
Download params: `?wid=1920&fmt=jpg&qlt=85`

1. Navigate to `https://www.lexus.com/models/{slug}`, wait 4s for JS render
2. Collect all `img[src*="/gallery/"]` already in DOM
3. Find all `<button>` elements with text `EXTERIOR`, `INTERIOR`, `WHEELS`, or `360°`
4. Click **every matching button** (do NOT deduplicate by text — see below)
5. Wait 2.5s after each click, collect again
6. Keep only URLs containing `/gallery/` and starting with `http`

**Why click all buttons (not just one per label)?**
Lexus model pages have two EXTERIOR/INTERIOR button pairs:
- Visualizer buttons → `/visualizer-1/.../large-N.jpg` (18 color-angle shots)
- Gallery tabs → `/gallery/exterior/` or `/gallery/interior/` (editorial shots)

The `/gallery/` URL filter discards visualizer images automatically, so clicking all buttons is safe and resilient to future CSS class name changes (styled-components hashes rotate on redeploy).

#### 2. hero/ — AEM CDN
CDN: `delivery.lcom.assetscs.lexus.com/adobe/assets/urn:aaid:aem:.../as/FILENAME.jpg`
Download: URL as-is (already full resolution, typically 1920px wide)

Collected at page load (before any tab clicks). Targets `delivery.lcom` images with `hero` or `Hero` in the filename and width ≥ 600px in the viewport.

Typically 1–2 images per model (main hero + F SPORT hero if applicable).

#### 3. design/ — AEM CDN
Same CDN as hero. Download: URL as-is.

1. Click the `DESIGN` nav link → page scrolls to the design section
2. Find all `<a href*="model_design_overlay">` CTA links (e.g. "EXPLORE TRIM DETAILS", "VIEW F SPORT DETAILS")
3. Click each CTA → a fixed/absolute overlay opens containing trim images
4. Collect `delivery.lcom` images with `Desktop` in the filename (excludes `Mobile` duplicates)
5. Click all inner tabs inside the overlay (e.g. PREMIUM, F SPORT) and collect again after each
6. Close the overlay (close button or Escape), then move to the next CTA

Typically 2 CTAs per model (Luxury trim + F SPORT trim), each with 2 inner tabs.
Yields ~15–20 images per model — trim feature shots, lifestyle images, interior details.
`Desktop` filter captures all resolutions in the overlay (480px thumbnails + 1440px heroes).

### Category tagging (gallery only)
- `interior` — filename contains `Interior` OR URL path contains `/interior/`
- `exterior` — filename contains `Exterior` OR URL path contains `/exterior/`
- `gallery` — anything else (mixed/unnamed shots)

---

## Toyota Scraper — How It Works

### Model discovery
Scrapes `https://www.toyota.com/all-vehicles/` for links matching `toyota.com/{model}/{year}`.

### Gallery extraction
Toyota has a dedicated gallery page: `https://www.toyota.com/{model}/photo-gallery/`

Images are in `data-image` attributes on `.gallery-item` elements — no tab clicking needed. All exterior and interior images are on one page.

Extraction:
```js
[...document.querySelectorAll('.gallery-item[data-image]')].map(el => {
  let url = el.getAttribute('data-image').split('?')[0];
  // strip Scene7 preset suffix (e.g. :tcom_gallery_16x9)
  url = url.replace(/\.(png|jpg|jpeg|webp).*$/i, (m, ext) => '.' + ext);
  return url;
})
```

CDN: `tmna.aemassets.toyota.com/is/image/toyota/...`
Download params: same `?wid=1920&fmt=jpg&qlt=85`

---

## Verified Results (2026-06-26)

| Model | gallery | hero | design | Gallery tabs |
|---|---|---|---|---|
| Lexus UX Hybrid | 14 | 2 | 15 | INTERIOR + EXTERIOR |
| Lexus NX | 16 | 2 | 19 | EXTERIOR + INTERIOR + WHEELS |
| Toyota RAV4 | 36 | — | — | single gallery page (no tabs) |

---

## Known Gotchas

- **CSS class names rotate** on Lexus site redeploys (styled-components). Never select tabs by class — always use button text.
- **Chrome extension blocks URLs with query strings** in JS output. Always call `.split('?')[0]` before returning a URL from `evaluate()`.
- **Toyota `data-image` preset suffix** — strip everything after the file extension (`:tcom_gallery_16x9` etc.) before appending CDN params.
- **Lexus UX Hybrid** loads all tab images in a single Swiper at page load (no separate exterior gallery path). Other models (NX, RX, etc.) load each tab on demand.
- **JWT-blocked URLs** — occasional Lexus image URLs get flagged by the Chrome extension. The scraper filters these with the `startswith("http")` and `/gallery/` checks.

---

## Dependencies

```bash
pip3 install playwright anthropic
playwright install chromium
```

Python 3.9+. No Node/npm required.
