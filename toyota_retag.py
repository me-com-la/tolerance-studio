#!/usr/bin/env python3
"""
Re-tag Toyota manifest with interior/exterior by clicking gallery tabs.
Updates category in manifest.json — no images re-downloaded.

Usage:
  python3 toyota_retag.py
  python3 toyota_retag.py --models camry rav4
"""

import asyncio
import argparse
import json
import re
from pathlib import Path

from playwright.async_api import async_playwright

BASE_DIR = Path(__file__).parent
MANIFEST_PATH = BASE_DIR / "Toyota" / "manifest.json"
SCENE7_CDN = "tmna.aemassets.toyota.com"


def strip_preset(url: str) -> str:
    return re.sub(r'\.(png|jpg|jpeg|webp)[^/]*$', lambda m: m.group(0).split(':')[0], url, flags=re.IGNORECASE)


async def collect_urls_from_tab(page) -> set[str]:
    return set(await page.evaluate(f"""
        () => {{
            const seen = new Set();
            for (const el of document.querySelectorAll('.gallery-item[data-image]')) {{
                // skip hidden elements (tab filtering is CSS-based)
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                // also check parent visibility
                let parent = el.parentElement;
                let hidden = false;
                while (parent && parent !== document.body) {{
                    const ps = window.getComputedStyle(parent);
                    if (ps.display === 'none' || ps.visibility === 'hidden') {{ hidden = true; break; }}
                    parent = parent.parentElement;
                }}
                if (hidden) continue;
                let url = el.getAttribute('data-image').split('?')[0];
                url = url.replace(/\\.(png|jpg|jpeg|webp)[^/]*$/i, m => m.split(':')[0]);
                if (url.includes('{SCENE7_CDN}')) seen.add(url);
            }}
            return [...seen];
        }}
    """))


async def retag_model(page, slug: str) -> dict[str, str]:
    """Returns {{url: category}} for all gallery images on this model page."""
    gallery_url = f"https://www.toyota.com/{slug}/photo-gallery/"
    try:
        resp = await page.goto(gallery_url, wait_until="domcontentloaded")
        if resp and resp.status >= 400:
            print(f"  ✗ {gallery_url} returned {resp.status}, skipping")
            return {}
    except Exception as e:
        print(f"  ✗ navigation error: {e}")
        return {}

    await page.wait_for_timeout(4000)
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    await page.wait_for_timeout(2000)
    await page.evaluate("window.scrollTo(0, 0)")
    await page.wait_for_timeout(1000)

    tag_map: dict[str, str] = {}

    # Find tab buttons for Interior / Exterior
    tab_buttons = await page.query_selector_all("button, [role='tab'], [role='button']")
    interior_btn = None
    exterior_btn = None
    for btn in tab_buttons:
        text = (await btn.inner_text()).strip().lower()
        if text == "interior":
            interior_btn = btn
        elif text == "exterior":
            exterior_btn = btn

    if not interior_btn and not exterior_btn:
        # No tabs — collect all and leave category as-is
        print(f"  no tabs found — keeping existing categories")
        return {}

    if exterior_btn:
        await exterior_btn.click()
        await page.wait_for_timeout(2000)
        for url in await collect_urls_from_tab(page):
            tag_map[url] = "exterior"
        print(f"  exterior: {len([u for u,c in tag_map.items() if c=='exterior'])}")

    if interior_btn:
        await interior_btn.click()
        await page.wait_for_timeout(2000)
        for url in await collect_urls_from_tab(page):
            tag_map[url] = "interior"
        print(f"  interior: {len([u for u,c in tag_map.items() if c=='interior'])}")

    return tag_map


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", metavar="SLUG")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text())

    # Determine which models to process
    if args.models:
        slugs = list(args.models)
    else:
        seen = set()
        slugs = []
        for entry in manifest.values():
            models = entry.get("models") or ([entry["model"]] if entry.get("model") else [])
            for m in models:
                if m and m not in seen:
                    seen.add(m)
                    slugs.append(m)
        slugs.sort()

    print(f"Retagging {len(slugs)} models: {slugs}\n")
    updated = 0

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_viewport_size({"width": 1440, "height": 900})

        for slug in slugs:
            print(f"→ {slug}")
            tag_map = await retag_model(page, slug)
            if not tag_map:
                continue

            for uid, entry in manifest.items():
                entry_models = entry.get("models") or ([entry["model"]] if entry.get("model") else [])
                if slug not in entry_models:
                    continue
                url = entry.get("url", "")
                if url in tag_map:
                    old = entry.get("category")
                    new = tag_map[url]
                    if old != new:
                        entry["category"] = new
                        updated += 1

        await browser.close()

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
    print(f"\nDone. {updated} entries re-tagged.")


if __name__ == "__main__":
    asyncio.run(main())
