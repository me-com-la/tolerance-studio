---
name: toyota-scraper
description: >
  Scrape and download images from any Toyota.com page — photo galleries,
  model pages, interior/exterior pages, and more. Use this skill whenever
  the user wants to pull, download, save, grab, or extract images from any
  toyota.com URL, even if they just say "get the images from this page" or
  "download the photos". Also triggers when the user wants to scrape images
  from other pages on the same Toyota website during a session.
---

# Toyota Image Scraper

Extracts and downloads images from toyota.com pages to a local folder. Toyota
uses a Scene7 CDN and lazy-loading, so images aren't in standard `<img src>`
attributes — they're stored in `data-image` attributes on gallery items and
must be fetched with CDN parameters to get full-resolution files.

## Prerequisites

- Claude in Chrome extension must be connected (tools named `mcp__Claude_in_Chrome__*`)
- A local folder must be connected (via `mcp__cowork__request_cowork_directory` if not already mounted)

## Workflow

### 1. Confirm the destination folder

Check if a folder is already connected. If not, ask the user to select one,
then use `mcp__cowork__request_cowork_directory` to mount it. Note the bash
path (shown in the tool response as the `/sessions/.../mnt/...` path) — you'll
use this for downloads.

### 2. Connect to Chrome and navigate

```
mcp__Claude_in_Chrome__select_browser   → pick "Browser 1" (or whichever is connected)
mcp__Claude_in_Chrome__tabs_context_mcp (createIfEmpty: true)
mcp__Claude_in_Chrome__browser_batch    → navigate to the URL, then wait 4s for JS to load
```

### 3. Extract image URLs

Toyota gallery pages store image paths in `data-image` attributes on
`.gallery-item` elements. Run this JavaScript to extract them:

```javascript
const items = [...document.querySelectorAll('.gallery-item[data-image]')];
items.map(el => ({
  url: el.getAttribute('data-image').split('?')[0],  // strip query params
  desc: el.getAttribute('data-description')
}))
```

The returned URLs look like:
`https://tmna.aemassets.toyota.com/is/image/toyota/.../FILENAME.png:tcom_gallery_16x9`

**Important:** Strip the `:tcom_gallery_16x9` suffix (everything after `.png`) —
that's a Scene7 image preset, not part of the filename.

If `.gallery-item[data-image]` returns nothing (non-gallery pages), fall back to
extracting large `<img>` elements using the same `.split('?')[0]` trick to strip
query strings before the extension blocks them.

### 4. Build download URLs

Toyota's CDN (Scene7 / `tmna.aemassets.toyota.com`) accepts URL parameters to
control format and size. Construct download URLs like this:

```
<base_url>?wid=1920&fmt=jpg&qlt=85
```

- `wid=1920` — 1920px wide (high resolution, reasonable file size)
- `fmt=jpg` — convert to JPEG
- `qlt=85` — quality 85 (good balance of size vs. quality)

For even higher res, use `wid=3840`. For thumbnails, use `wid=800`.

### 5. Download in parallel

Use `curl` in parallel (background `&` + `wait`) for speed. Save to the bash
mount path of the connected folder:

```bash
DEST="/sessions/.../mnt/FolderName"

for url in "${urls[@]}"; do
  name=$(basename "$url" | cut -d'.' -f1)
  curl -s -L -o "$DEST/${name}.jpg" "${url}?wid=1920&fmt=jpg&qlt=85" &
done
wait
echo "Done: $(ls "$DEST"/*.jpg | wc -l) images"
```

### 6. Report back

Tell the user how many images were saved and where the folder is (use the
human-readable path like `~/Documents/ClaudeCowork/Toyota`, not the
`/sessions/...` mount path).

## Notes on Toyota's CDN

- The Chrome extension blocks URLs containing query strings (privacy filter).
  Always call `.split('?')[0]` inside JavaScript before returning values.
- The `:preset_name` suffix on Scene7 URLs is not part of the filename — strip
  it with `.split(':')[0]` before appending your own params.
- Images are lazy-loaded (placeholder 1×1 GIF until scrolled into view), so
  `img.src` / `img.currentSrc` won't have the real URL — always use
  `data-image` or `data-src` attributes instead.
- For pages without `.gallery-item` (e.g., model overview pages), check for
  `data-src`, `data-lazy`, or background-image CSS — scan `[data-src]` elements
  as a fallback.

## Example: Photo gallery page

URL: `https://www.toyota.com/corollacross/photo-gallery/`

- Selector: `.gallery-item[data-image]` → 52 images
- Image filenames follow pattern: `CCH_MY26_0006_V001.png`, `CRC_MY26_0003_V001.png`, etc.
- Download URL: `https://tmna.aemassets.toyota.com/is/image/toyota/toyota/vehicles/2026/corollacross/galleries/CCH_MY26_0006_V001.png?wid=1920&fmt=jpg&qlt=85`
