# Scraper Notes — Technical Reference

Last verified: 2026-07-01

**This file is the "how it works inside" reference.** For step-by-step
routines, use:
- `WEEKLY-UPDATE.md` — the weekly scan/review/apply loop
- `QUARTERLY-FULL-SCRAPE.md` — the every-3-months full re-scrape
- `README.md` — map of every file in this folder

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

## Process docs moved

The full re-scrape steps now live in `QUARTERLY-FULL-SCRAPE.md` and the
weekly scan/review/apply loop in `WEEKLY-UPDATE.md`. This file keeps only
the technical detail of how the pieces work.

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

---

## Site / Viewer System

`index.html` is the viewer, served at the site root by GitHub Pages (the old duplicate `viewer.html` copy has been removed — one codebase now). `keywords.html` is a separate standalone keyword-browser page. Copy both when replicating this system for a new scrape.

### Password gate — `auth.js`
Loaded via `<script src="auth.js"></script>` at the bottom of the HTML, before any content is usable.
- On load: hides the page (`visibility:hidden`), checks `sessionStorage['rapp_auth_ok']`. If already `'1'`, unlocks immediately (session-only, resets on browser close).
- Otherwise shows a full-screen password overlay (`#auth-form`), POSTs the entered password as JSON to a **Supabase Edge Function**: `https://chdfupqkxlcarygopmof.supabase.co/functions/v1/rapp-auth`.
- Function returns `{ ok: true/false }`. On `ok`, sets the sessionStorage flag and removes the overlay. No client-side password is ever stored in the JS — it's validated server-side by the edge function, so the real password lives only in the Supabase function's env/config, not in this repo.
- To reuse for a new site: deploy the same edge function pattern (or point at the same one), copy `auth.js` as-is, just include it in the new HTML.

### Layout
Single-page app, no framework — vanilla JS in one `<script>` block (~450 lines) at the bottom of the HTML.
- **Sidebar** (`#sidebar`, 220px fixed): brand toggle (Lexus/Toyota), accordion filter groups, card-size toggle, reset button.
- **Main grid** (`#grid`): image cards, CSS grid with a `--card-size` custom property driven by the size toggle (180/240/340px presets).
- **Lightbox** (`#lightbox`): full-screen image viewer — prev/next nav, side panel showing vehicle/model/brand/subfolder, clickable keyword chips (click a keyword to filter the whole grid to it), filename, and a direct download link.

### Filters (brand-specific, rebuilt on brand switch)
- **Toyota:** Model · Year (`MY\d{2}` regex parsed from tags) · Tag (face/people/keywords) · Category (interior/exterior/hero/wheels)
- **Lexus:** Model · Type (hero/gallery/design) · Trim · Gallery category (interior/exterior) · People tags
- All filters are accordions (`.facc-*` classes) that collapse/expand; `resetAll()` clears every active filter set back to empty.
- Keyword filtering has an OR/AND toggle (`kwMode`) plus a live search box that builds a "keyword cloud" (`buildKwCloud()`) from all AI-tagged keywords across the current brand's items.
- Each model gets a deterministic color from `MODEL_PALETTE` (hash of model name mod 20) — used for model-tag chips throughout the UI, so colors stay stable across reloads/re-scrapes as long as model names don't change.

### Data loading
Both `manifest.json` files (Lexus + Toyota) are fetched client-side and merged into `items` array on load; brand toggle just filters which subset renders, no separate fetch per brand.

### Deploy target
Pushed to `me-com-la.github.io/library` (GitHub Pages, free account) — see `keys-and-deploy.md` for the push token. `index.html` is the file GitHub Pages serves.

### Replicating for a new library
1. Copy `index.html`, `keywords.html`, `auth.js` verbatim.
2. Point the manifest fetch at the new brand's `manifest.json` path(s).
3. Update `MODEL_PALETTE` usage is automatic (hash-based) — no changes needed for new model names.
4. Reuse the same `rapp-auth` Supabase function unless a different password is wanted, in which case deploy a new edge function and swap `AUTH_ENDPOINT` in `auth.js`.
