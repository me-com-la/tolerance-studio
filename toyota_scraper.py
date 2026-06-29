#!/usr/bin/env python3
"""
Toyota image scraper — gallery images per model.

Downloads to Rapp/Toyota/library/<model-slug>/gallery/
Tracks URLs in Rapp/Toyota/manifest.json — safe to re-run (skips duplicates).

Usage:
  python3 toyota_scraper.py                      # all models
  python3 toyota_scraper.py --models bz camry    # specific models
"""

import asyncio
import hashlib
import json
import re
import urllib.request
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright

BASE_DIR = Path(__file__).parent
TOYOTA_LIB = BASE_DIR / "Toyota" / "library"
MANIFEST_PATH = BASE_DIR / "Toyota" / "manifest.json"

SCENE7_PARAMS = "?wid=1920&fmt=jpg&qlt=85"
SCENE7_CDN = "tmna.aemassets.toyota.com"

DISCOVERY_URL = "https://www.toyota.com/all-vehicles/"


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


def url_hash(url: str, subfolder: str) -> str:
    return hashlib.md5((url + subfolder).encode()).hexdigest()[:12]


def strip_preset(url: str) -> str:
    """Strip Scene7 preset suffix: 'file.png:tcom_gallery_16x9' → 'file.png'"""
    return re.sub(r'\.(png|jpg|jpeg|webp).*$', lambda m: m.group(0).split(':')[0], url, flags=re.IGNORECASE)


def download_image(url: str, dest: Path) -> bool:
    try:
        fetch_url = url + SCENE7_PARAMS
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
    """Return [{slug, url}] for all current Toyota models."""
    await page.goto(DISCOVERY_URL, wait_until="domcontentloaded")
    await page.wait_for_timeout(4000)

    links = await page.eval_on_selector_all(
        'a[href*="toyota.com/"]',
        """els => els.map(a => {
            const url = a.href.split('?')[0].split('#')[0];
            const m = url.match(/toyota\\.com\\/([a-z0-9]+)\\/?$/i);
            return m ? { slug: m[1].toLowerCase(), url } : null;
        }).filter(Boolean)"""
    )

    seen = {}
    for m in links:
        slug = m["slug"]
        if slug and slug not in ("all-vehicles", "configurator", "search", "dealers", "offers") \
                and slug not in seen:
            seen[slug] = m["url"]

    return [{"slug": k, "url": v} for k, v in sorted(seen.items())]


# ---------------------------------------------------------------------------
# Per-model scraper
# ---------------------------------------------------------------------------

async def scrape_gallery(page, model_url: str) -> list[str]:
    """Navigate to model's photo-gallery page and extract all gallery image URLs."""
    gallery_url = model_url.rstrip("/") + "/photo-gallery/"
    try:
        resp = await page.goto(gallery_url, wait_until="domcontentloaded")
        if resp and resp.status >= 400:
            # fall back to model overview page
            await page.goto(model_url, wait_until="domcontentloaded")
    except Exception:
        await page.goto(model_url, wait_until="domcontentloaded")

    await page.wait_for_timeout(4000)

    # scroll to trigger lazy-load
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    await page.wait_for_timeout(2000)
    await page.evaluate("window.scrollTo(0, 0)")
    await page.wait_for_timeout(1000)

    urls = await page.evaluate(f"""
        () => {{
            const seen = new Set();
            const results = [];

            // Primary: .gallery-item[data-image]
            for (const el of document.querySelectorAll('.gallery-item[data-image]')) {{
                let url = el.getAttribute('data-image').split('?')[0];
                // strip Scene7 preset suffix
                url = url.replace(/\\.(png|jpg|jpeg|webp)[^/]*$/i, m => m.split(':')[0]);
                if (url.includes('{SCENE7_CDN}') && !seen.has(url)) {{
                    seen.add(url);
                    results.push(url);
                }}
            }}

            // Fallback: [data-src] images on the CDN
            if (results.length === 0) {{
                for (const el of document.querySelectorAll('[data-src]')) {{
                    let url = (el.getAttribute('data-src') || '').split('?')[0];
                    url = url.replace(/\\.(png|jpg|jpeg|webp)[^/]*$/i, m => m.split(':')[0]);
                    if (url.includes('{SCENE7_CDN}') && !seen.has(url)) {{
                        seen.add(url);
                        results.push(url);
                    }}
                }}
            }}

            return results;
        }}
    """)

    print(f"  gallery : {len(urls)} images  (from {gallery_url})")
    return urls


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", metavar="SLUG",
                        help="Only scrape these model slugs (e.g. --models bz camry)")
    args = parser.parse_args()
    filter_slugs = {s.lower() for s in args.models} if args.models else None

    manifest = load_manifest()
    today = date.today().isoformat()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_viewport_size({"width": 1440, "height": 900})

        if filter_slugs:
            # Build model list directly from known slugs — skip discovery
            models = [
                {"slug": slug, "url": f"https://www.toyota.com/{slug}/"}
                for slug in sorted(filter_slugs)
            ]
            print(f"Targeting: {[m['slug'] for m in models]}\n")
        else:
            print("Discovering Toyota models...")
            models = await discover_models(page)
            print(f"Found {len(models)} models: {[m['slug'] for m in models]}\n")

        total_new = 0

        for model in models:
            slug = model["slug"]
            print(f"→ {slug}")

            urls = await scrape_gallery(page, model["url"])
            subfolder = "gallery"
            dest_dir = TOYOTA_LIB / slug / subfolder
            dest_dir.mkdir(parents=True, exist_ok=True)

            for img_url in urls:
                if not img_url.startswith("http"):
                    continue
                uid = url_hash(img_url, subfolder)
                if uid in manifest:
                    entry = manifest[uid]
                    models_list = entry.get("models") or [entry.get("model", "")]
                    if slug not in models_list:
                        models_list.append(slug)
                        entry["models"] = models_list
                        print(f"    + shared with {slug}: {entry['filename']}")
                    continue
                filename = Path(urlparse(img_url).path).name
                if not filename:
                    continue
                if not re.search(r'\.(jpg|jpeg|png|webp)$', filename, re.IGNORECASE):
                    filename += ".jpg"
                cat = "interior" if re.search(r'interior', filename, re.IGNORECASE) else "exterior"
                dest = dest_dir / filename
                print(f"    ↓ {filename}")
                if download_image(img_url, dest):
                    make_thumb(dest)
                    manifest[uid] = {
                        "filename": filename,
                        "models": [slug],
                        "brand": "toyota",
                        "subfolder": subfolder,
                        "category": cat,
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
