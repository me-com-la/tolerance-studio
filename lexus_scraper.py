#!/usr/bin/env python3
"""
Lexus image scraper — three capture types per model:

  gallery/   Scene7 CDN images from EXTERIOR / INTERIOR / WHEELS tabs
  hero/      Full-width hero image at top of each model page (AEM CDN)
  design/    All large images that appear after clicking the Design tab (AEM CDN)

Downloads to Rapp/Lexus/library/<model-slug>/{gallery,hero,design}/
Tracks URLs in Rapp/Lexus/manifest.json — safe to re-run (skips duplicates).
"""

import asyncio
import hashlib
import json
import urllib.request
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright

BASE_DIR = Path(__file__).parent
LEXUS_LIB = BASE_DIR / "Lexus" / "library"
MANIFEST_PATH = BASE_DIR / "Lexus" / "manifest.json"

CATEGORY_URLS = [
    "https://www.lexus.com/models/categories/suvs",
    "https://www.lexus.com/models/categories/sedans",
    "https://www.lexus.com/models/categories/hybrids",
    "https://www.lexus.com/models/categories/performance",
]

GALLERY_TAB_TEXTS = {"EXTERIOR", "INTERIOR", "WHEELS", "360°"}

# Scene7 CDN (gallery images) — append to get 1920px JPEG
SCENE7_PARAMS = "?wid=1920&fmt=jpg&qlt=85"

# AEM delivery CDN (hero + design) — download as-is (already 1920px)
AEM_CDN = "delivery.lcom.assetscs.lexus.com"


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text())
    return {}


def save_manifest(manifest: dict):
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))


def url_hash(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:12]


def download_image(url: str, dest: Path, scene7: bool = True) -> bool:
    """Download url → dest. Appends Scene7 params if scene7=True."""
    try:
        fetch_url = url + SCENE7_PARAMS if scene7 else url
        req = urllib.request.Request(fetch_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            dest.write_bytes(resp.read())
        return dest.stat().st_size > 10_000
    except Exception as e:
        print(f"    ✗ {e}")
        return False


def make_thumb(src: Path):
    import subprocess
    thumb_dir = src.parent / "thumbs"
    thumb_dir.mkdir(exist_ok=True)
    subprocess.run(["sips", "-Z", "400", str(src), "--out", str(thumb_dir / src.name)],
                   capture_output=True)


# ---------------------------------------------------------------------------
# Model discovery
# ---------------------------------------------------------------------------

async def discover_models(page) -> list[dict]:
    """Return [{slug, url}] for all current Lexus models across categories."""
    models = {}
    for cat_url in CATEGORY_URLS:
        await page.goto(cat_url, wait_until="domcontentloaded")
        await page.wait_for_timeout(3000)
        links = await page.eval_on_selector_all(
            'a[href*="/models/"]',
            """els => els.map(a => ({
                slug: a.href.split('/models/')[1].replace(/[\\/?#].*/, '').toLowerCase(),
                url:  a.href.split('?')[0].split('#')[0]
            })).filter(m => m.slug && !/categor|future|upcoming|tz/.test(m.slug))"""
        )
        for m in links:
            if m["slug"] not in models:
                models[m["slug"]] = m["url"]
    return [{"slug": k, "url": v} for k, v in sorted(models.items())]


# ---------------------------------------------------------------------------
# Per-model scrapers
# ---------------------------------------------------------------------------

TAB_TO_CATEGORY = {
    "EXTERIOR": "exterior",
    "INTERIOR": "interior",
    "WHEELS":   "wheels",
    "360°":     "exterior",
}

async def scrape_gallery(page) -> list[tuple[str, str]]:
    """
    Collect /gallery/ image URLs with tab-aware category.
    Returns [(url, category)] where category is 'exterior'|'interior'|'wheels'.
    """
    # url → category (last tab clicked wins, but we assign per-batch below)
    collected: dict[str, str] = {}

    def is_gallery_url(url: str) -> bool:
        return "/gallery/" in url and (
            "lexusaemcs" in url or "lexus.com/content/dam/" in url
        )

    # Initial DOM scan — label as exterior by default
    urls = await page.evaluate("""
        () => {
            const seen = new Set();
            return [...document.querySelectorAll('img[src*="/gallery/"]')]
                .map(el => el.src.split('?')[0])
                .filter(u => (u.includes('lexusaemcs') || u.includes('lexus.com/content/dam/'))
                             && !seen.has(u) && seen.add(u));
        }
    """)
    for u in urls:
        fn = u.split("/")[-1].lower()
        cat = "interior" if "interior" in fn else "exterior"
        collected.setdefault(u, cat)

    tabs_seen = []
    for btn in await page.query_selector_all("button"):
        try:
            text = (await btn.inner_text()).strip()
            if text not in GALLERY_TAB_TEXTS:
                continue
            tab_cat = TAB_TO_CATEGORY[text]

            # Intercept network responses during this tab's load
            tab_urls: set[str] = set()
            def on_response(response, _cat=tab_cat):
                url = response.url.split("?")[0]
                if is_gallery_url(url):
                    tab_urls.add(url)
            page.on("response", on_response)

            await btn.scroll_into_view_if_needed()
            await btn.click()
            await page.wait_for_timeout(2500)

            page.remove_listener("response", on_response)

            # Also grab anything newly visible in DOM after click
            dom_urls = await page.evaluate("""
                () => {
                    const seen = new Set();
                    return [...document.querySelectorAll('img[src*="/gallery/"]')]
                        .map(el => el.src.split('?')[0])
                        .filter(u => (u.includes('lexusaemcs') || u.includes('lexus.com/content/dam/'))
                                     && !seen.has(u) && seen.add(u));
                }
            """)
            for u in list(tab_urls) + dom_urls:
                if u.startswith("http") and "/gallery/" in u:
                    collected[u] = tab_cat  # tab label is authoritative

            tabs_seen.append(text)
        except Exception:
            pass

    IMAGE_EXTS = ('.jpg', '.jpeg', '.png', '.webp')
    result = [(u, cat) for u, cat in collected.items()
              if u.startswith("http") and u.lower().split('?')[0].endswith(IMAGE_EXTS)]
    unique_tabs = list(dict.fromkeys(tabs_seen))
    print(f"  gallery : {len(result)} images  (tabs: {', '.join(unique_tabs) or 'none'})")
    return result


async def scrape_hero(page) -> list[str]:
    """
    Collect the single top-of-page hero image.
    Prefers delivery.lcom images with 'Hero' in the filename.
    Falls back to the widest delivery.lcom image >= 1400px if none found.
    """
    heroes = await page.evaluate("""
        () => {
            const imgs = [...document.querySelectorAll('img[src*="delivery.lcom"]')]
                .filter(el => el.getBoundingClientRect().width >= 600);
            // Prefer explicit Hero filename
            const heroNamed = imgs
                .filter(el => /hero/i.test(el.src.split('/').pop().split('?')[0]))
                .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            if (heroNamed.length) return [heroNamed[0].src.split('?')[0]];
            // Fallback: widest image >= 1400px at top of page
            const wide = imgs
                .filter(el => el.getBoundingClientRect().width >= 1400)
                .sort((a, b) => {
                    const ay = a.getBoundingClientRect().top;
                    const by = b.getBoundingClientRect().top;
                    return ay - by;
                });
            if (wide.length) return [wide[0].src.split('?')[0]];
            return [];
        }
    """)
    print(f"  hero    : {len(heroes)} image(s)")
    return heroes


async def scrape_feature(page, model_slug: str, page_responses: set[str]) -> list[str]:
    """
    Extract model-specific content images from delivery.lcom responses collected
    during the full page session (passed in from the pre-goto listener).
    Excludes gallery, hero, design-overlay, swatches, and generic brand images.
    Goes into hero/ subfolder per user preference.
    """
    import re
    # Build match variants: "ux-hybrid" → ["UXH", "UX-HYBRID", "UX_HYBRID", "UXG", "UXS"]
    # Strategy: try slug without hyphens as prefix, and the full slug uppercased.
    slug_up = model_slug.upper()
    slug_compact = slug_up.replace("-", "")  # UX-HYBRID → UXHYBRID, GX → GX

    result = []
    for url in page_responses:
        fn = url.split("/")[-1]
        fn_up = fn.upper()
        # Must be desktop JPEG
        if "desktop" not in fn.lower() and "desktop" not in fn.upper():
            continue
        if not fn.lower().endswith(".jpg"):
            continue
        # Skip generic brand pages
        if any(x in fn for x in ("Lexus-Desktop-LSS", "LexusCare", "Lexus-Desktop-Large")):
            continue
        # Skip already-handled types
        if "/gallery/" in url:
            continue
        if any(x in fn.lower() for x in ("hero", "design-overlay", "design_overlay")):
            continue
        # Model match: slug must appear (compact or hyphenated) OR
        # the filename starts with Lexus-{MODEL_CODE}- where model code prefix matches slug prefix
        slug_prefix = slug_compact[:3]  # first 3 chars, e.g. UXH, GX_ → GX
        if slug_prefix and (slug_prefix in fn_up or slug_up in fn_up):
            result.append(url)

    print(f"  feature : {len(result)} image(s)")
    return result


def tab_slug(tab_text: str) -> str:
    """Convert overlay tab label to a folder-safe slug, e.g. 'F SPORT' → 'f-sport'."""
    import re
    return re.sub(r"[^a-z0-9]+", "-", tab_text.strip().lower()).strip("-")


async def scrape_design(page) -> dict[str, list[str]]:
    """
    Collect design overlay images from the AEM CDN, keyed by trim tab.

    Returns {tab_slug: [urls]} — e.g. {"premium": [...], "f-sport": [...]}

    Flow:
      1. Click the 'DESIGN' nav link → page scrolls to #model_design section
      2. Find all CTA links with 'model_design_overlay' in href
      3. Click each CTA → overlay opens as a fixed/absolute element
      4. Click each inner tab (PREMIUM, LUXURY, F SPORT, etc.) and collect images
      5. Close overlay, move to next CTA
    """
    result: dict[str, list[str]] = {}

    def find_overlay_js():
        return """
            [...document.querySelectorAll('*')].find(el => {
                const s = window.getComputedStyle(el);
                return (s.position === 'fixed' || s.position === 'absolute')
                    && el.querySelectorAll('img').length > 2;
            })
        """

    async def collect_tab_urls() -> list[str]:
        return await page.evaluate(f"""
            () => {{
                const seen = new Set();
                const fixed = {find_overlay_js()};
                if (!fixed) return [];
                return [...fixed.querySelectorAll('img')]
                    .map(el => el.src.split('?')[0])
                    .filter(u => {{
                        if (!u.startsWith('http') || seen.has(u)) return false;
                        seen.add(u);
                        const fn = u.split('/').pop();
                        // Accept AEM delivery CDN or Scene7/lexusaemcs CDN, both with desktop images
                        return (u.includes('delivery.lcom') || u.includes('lexusaemcs'))
                            && /desktop/i.test(fn);
                    }});
            }}
        """)

    async def get_overlay_tabs() -> list[str]:
        return await page.evaluate(f"""
            () => {{
                const fixed = {find_overlay_js()};
                if (!fixed) return [];
                return [...fixed.querySelectorAll('button, li, [role="tab"]')]
                    .map(el => el.textContent.trim())
                    .filter(t => t.length > 0 && t.length < 40 && !/close|icon/i.test(t));
            }}
        """)

    # Step 1: click DESIGN nav to scroll to section
    clicked = await page.evaluate("""
        () => {
            const el = [...document.querySelectorAll('a, button, li')].find(el =>
                /^design$/i.test(el.textContent.trim()));
            if (el) { el.click(); return true; }
            return false;
        }
    """)
    if not clicked:
        print("  design  : no Design nav link found")
        return result

    await page.wait_for_timeout(2000)

    # Step 2: find CTAs — match by href OR by "explore … design" link text
    cta_count = await page.evaluate("""
        () => {
            const byHref = [...document.querySelectorAll('a[href*="model_design_overlay"]')];
            if (byHref.length) return byHref.length;
            // fallback: links whose text matches "explore … design"
            return [...document.querySelectorAll('a')].filter(a =>
                /explore/i.test(a.textContent) && /design/i.test(a.textContent)).length;
        }
    """)
    if cta_count == 0:
        # Fallback: navigate directly to the overlay URL.
        # The overlay images are only present during the initial React render —
        # they unmount quickly, so we use wait_for_function to catch them the
        # moment they appear rather than using a fixed sleep.
        current_url = page.url.split("?")[0]
        overlay_url = current_url + "?link[model_design_overlay][SHOW_PAGE]=true"
        print(f"  design  : no CTAs — trying direct overlay URL")
        await page.goto(overlay_url, wait_until="domcontentloaded")
        try:
            await page.wait_for_function(
                "() => { const o = document.querySelector('#model_design_overlay'); "
                "return o && o.querySelectorAll('img').length > 0; }",
                timeout=8000,
            )
        except Exception:
            pass
        # Collect immediately — no CDN filter, just anything in the overlay
        urls = await page.evaluate("""
            () => {
                const seen = new Set();
                const overlay = document.querySelector('#model_design_overlay');
                if (!overlay) return [];
                return [...overlay.querySelectorAll('img')]
                    .map(el => el.src.split('?')[0])
                    .filter(u => u.startsWith('http') && !seen.has(u) && seen.add(u));
            }
        """)
        if urls:
            result["design"] = urls
        total = sum(len(v) for v in result.values())
        tab_summary = ", ".join(f"{k}:{len(v)}" for k, v in result.items())
        print(f"  design  : {total} images  ({tab_summary})")
        return result

    # Step 3: iterate CTAs
    for i in range(cta_count):
        await page.evaluate(f"""
            () => {{
                let ctas = [...document.querySelectorAll('a[href*="model_design_overlay"]')];
                if (!ctas.length) {{
                    ctas = [...document.querySelectorAll('a')].filter(a =>
                        /explore/i.test(a.textContent) && /design/i.test(a.textContent));
                }}
                if (ctas[{i}]) ctas[{i}].click();
            }}
        """)
        await page.wait_for_timeout(2500)

        tabs = await get_overlay_tabs()
        if not tabs:
            # No inner tabs — collect flat into "design"
            urls = await collect_tab_urls()
            slug = "design"
            result.setdefault(slug, [])
            result[slug] += [u for u in urls if u not in result[slug]]
        else:
            for tab_idx, tab_text in enumerate(tabs):
                await page.evaluate(f"""
                    () => {{
                        const fixed = {find_overlay_js()};
                        if (!fixed) return;
                        const tabs = [...fixed.querySelectorAll('button, li, [role="tab"]')]
                            .filter(el => el.textContent.trim().length > 0
                                && el.textContent.trim().length < 40
                                && !/close|icon/i.test(el.textContent.trim()));
                        if (tabs[{tab_idx}]) tabs[{tab_idx}].click();
                    }}
                """)
                await page.wait_for_timeout(1500)
                urls = await collect_tab_urls()
                slug = tab_slug(tab_text)
                result.setdefault(slug, [])
                result[slug] += [u for u in urls if u not in result[slug]]

        # Close overlay
        closed = await page.evaluate(f"""
            () => {{
                const fixed = {find_overlay_js()};
                if (!fixed) return false;
                const closeBtn = [...fixed.querySelectorAll('button')]
                    .find(el => /close|dismiss|×|✕/i.test(el.textContent)
                        || /close/i.test(el.getAttribute('aria-label') || ''));
                if (closeBtn) {{ closeBtn.click(); return true; }}
                return false;
            }}
        """)
        if not closed:
            await page.keyboard.press("Escape")
        await page.wait_for_timeout(1000)

    total = sum(len(v) for v in result.values())
    tab_summary = ", ".join(f"{k}:{len(v)}" for k, v in result.items())
    print(f"  design  : {total} images  ({tab_summary})")
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", metavar="SLUG",
                        help="Only scrape these model slugs (e.g. --models es es-hybrid)")
    args = parser.parse_args()
    filter_slugs = {s.lower() for s in args.models} if args.models else None

    manifest = load_manifest()
    today = date.today().isoformat()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_viewport_size({"width": 1440, "height": 900})

        print("Discovering Lexus models...")
        models = await discover_models(page)
        if filter_slugs:
            models = [m for m in models if m["slug"] in filter_slugs]
        print(f"Found {len(models)} models: {[m['slug'] for m in models]}\n")

        total_new = 0

        for model in models:
            slug = model["slug"]
            print(f"→ {slug}")

            await page.goto(model["url"], wait_until="domcontentloaded")
            await page.wait_for_timeout(4000)

            gallery_urls = await scrape_gallery(page)
            hero_urls    = await scrape_hero(page)
            design_tabs  = await scrape_design(page)   # {tab_slug: [urls]}

            # gallery_urls is [(url, category)] — unpack for the flat loop
            flat_captures = [
                ("gallery", gallery_urls,                         True),
                ("hero",    [(u, "hero") for u in hero_urls],    False),
            ]
            for subfolder, url_cat_pairs, is_scene7 in flat_captures:
                dest_dir = LEXUS_LIB / slug / subfolder
                dest_dir.mkdir(parents=True, exist_ok=True)
                for img_url, cat in url_cat_pairs:
                    if not img_url.startswith("http"):
                        continue
                    uid = url_hash(img_url + subfolder)
                    if uid in manifest:
                        entry = manifest[uid]
                        models_list = entry.get("models") or [entry.get("model", "")]
                        if slug not in models_list:
                            models_list.append(slug)
                            entry["models"] = models_list
                            print(f"    + [{subfolder}] shared with {slug}: {entry['filename']}")
                        continue
                    filename = Path(urlparse(img_url).path).name
                    dest = dest_dir / filename
                    print(f"    ↓ [{subfolder}/{cat}] {filename}")
                    use_scene7 = is_scene7 and "lexusaemcs" in img_url
                    if download_image(img_url, dest, scene7=use_scene7):
                        make_thumb(dest)
                        manifest[uid] = {
                            "filename": filename,
                            "models": [slug],
                            "brand": "lexus",
                            "subfolder": subfolder,
                            "category": cat,
                            "url": img_url,
                            "date_added": today,
                        }
                        total_new += 1

            # Design: one subfolder per trim tab (e.g. design/premium/, design/f-sport/)
            for trim_slug, urls in design_tabs.items():
                dest_dir = LEXUS_LIB / slug / "design" / trim_slug
                dest_dir.mkdir(parents=True, exist_ok=True)
                for img_url in urls:
                    if not img_url.startswith("http"):
                        continue
                    uid = url_hash(img_url + "design/" + trim_slug)
                    if uid in manifest:
                        entry = manifest[uid]
                        models_list = entry.get("models") or [entry.get("model", "")]
                        if slug not in models_list:
                            models_list.append(slug)
                            entry["models"] = models_list
                            print(f"    + [design/{trim_slug}] shared with {slug}: {entry['filename']}")
                        continue
                    filename = Path(urlparse(img_url).path).name
                    dest = dest_dir / filename
                    print(f"    ↓ [design/{trim_slug}] {filename}")
                    is_scene7 = "lexusaemcs" in img_url
                    if download_image(img_url, dest, scene7=is_scene7):
                        make_thumb(dest)
                        manifest[uid] = {
                            "filename": filename,
                            "models": [slug],
                            "brand": "lexus",
                            "subfolder": f"design/{trim_slug}",
                            "category": trim_slug,
                            "url": img_url,
                            "date_added": today,
                        }
                        total_new += 1

        await browser.close()

    save_manifest(manifest)
    print(f"\nDone. {total_new} new images added.")
    print(f"Manifest: {MANIFEST_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
