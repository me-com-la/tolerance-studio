#!/usr/bin/env python3
"""
Download exactly the "added" URLs from diff_report.json — no page re-scraping,
no re-walking every model. Fetches full-res images straight from their CDN
URLs, writes them into the right library folder, adds manifest entries, and
generates thumbnails, matching the conventions of lexus_scraper.py /
toyota_scraper.py.

Much faster than a full re-scrape when you already know exactly which URLs
are new (i.e. right after reviewing diff_review.html).

Usage:
  python3 download_new.py --brand toyota
  python3 download_new.py --brand lexus
  python3 download_new.py                 # both brands
"""

import argparse
import json
import re
import subprocess
import urllib.request
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).parent
REPORT_PATH = BASE_DIR / "diff_report.json"

import lexus_scraper as lx
import toyota_scraper as ty

SCENE7_PARAMS = "?wid=1920&fmt=jpg&qlt=85"


def make_thumb(src: Path):
    thumb_dir = src.parent / "thumbs"
    thumb_dir.mkdir(exist_ok=True)
    subprocess.run(["sips", "-Z", "400", str(src), "--out", str(thumb_dir / src.name)],
                   capture_output=True)


def fetch(url: str, dest: Path, scene7_params: str = "") -> bool:
    try:
        fetch_url = url + scene7_params
        req = urllib.request.Request(fetch_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            dest.write_bytes(resp.read())
        if dest.stat().st_size > 10_000:
            return True
        dest.unlink(missing_ok=True)
        return False
    except Exception as e:
        print(f"    ✗ {url} — {e}")
        dest.unlink(missing_ok=True)
        return False


def download_toyota(urls: list):
    manifest = ty.load_manifest()
    today = date.today().isoformat()
    added = 0

    for url in urls:
        m = re.search(r"/vehicles/\d{4}/([a-z0-9-]+)/galler(?:y|ies)/", url, re.IGNORECASE)
        if not m:
            print(f"  ! could not infer model slug, skipping: {url}")
            continue
        slug = m.group(1).lower()

        subfolder = "gallery"
        dest_dir = ty.TOYOTA_LIB / slug / subfolder
        dest_dir.mkdir(parents=True, exist_ok=True)

        filename = Path(urlparse(url).path).name
        if not re.search(r'\.(jpg|jpeg|png|webp)$', filename, re.IGNORECASE):
            filename += ".jpg"
        cat = "interior" if re.search(r'interior', filename, re.IGNORECASE) else "exterior"
        dest = dest_dir / filename

        uid = ty.url_hash(url, subfolder)
        if uid in manifest:
            print(f"  = already in manifest: {filename}")
            continue

        print(f"  ↓ {slug}/{subfolder}/{filename}")
        if fetch(url, dest, SCENE7_PARAMS):
            make_thumb(dest)
            manifest[uid] = {
                "filename": filename,
                "models": [slug],
                "brand": "toyota",
                "subfolder": subfolder,
                "category": cat,
                "url": url,
                "date_added": today,
            }
            added += 1

    ty.save_manifest(manifest)
    print(f"Toyota: {added} new image(s) downloaded + thumbnailed.")


def download_lexus(urls: list):
    manifest = lx.load_manifest()
    today = date.today().isoformat()
    added = 0

    for url in urls:
        is_aem = lx.AEM_CDN in url
        filename = Path(urlparse(url.split("?")[0]).path).name
        fn_lower = filename.lower()

        if is_aem:
            # AEM CDN — hero or design. "hero" in filename = hero, else design.
            subfolder = "hero" if "hero" in fn_lower else "design"
            cat = subfolder
        else:
            subfolder = "gallery"
            cat = "interior" if "interior" in fn_lower else "exterior"

        # Infer model slug from the URL path — Scene7 gallery URLs contain
        # /models/<slug>/, AEM urls don't carry the slug, so this only works
        # reliably for gallery; hero/design need manual model assignment if
        # this heuristic can't find one.
        m = re.search(r"/models/([a-z0-9-]+)/", url, re.IGNORECASE)
        slug = m.group(1).lower() if m else None
        if not slug:
            print(f"  ! could not infer model slug for {filename}, skipping (add manually)")
            continue

        dest_dir = lx.LEXUS_LIB / slug / subfolder
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename

        uid = lx.url_hash(url + subfolder)
        if uid in manifest:
            print(f"  = already in manifest: {filename}")
            continue

        print(f"  ↓ {slug}/{subfolder}/{filename}")
        scene7 = not is_aem
        if fetch(url, dest, SCENE7_PARAMS if scene7 else ""):
            make_thumb(dest)
            manifest[uid] = {
                "filename": filename,
                "models": [slug],
                "brand": "lexus",
                "subfolder": subfolder,
                "category": cat,
                "url": url,
                "date_added": today,
            }
            added += 1

    lx.save_manifest(manifest)
    print(f"Lexus: {added} new image(s) downloaded + thumbnailed.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand", choices=["lexus", "toyota"], default=None)
    args = parser.parse_args()

    report = json.loads(REPORT_PATH.read_text())
    brands = [args.brand] if args.brand else [b for b in ("lexus", "toyota") if b in report]

    for brand in brands:
        urls = report.get(brand, {}).get("added", [])
        if not urls:
            print(f"{brand}: nothing to add.")
            continue
        print(f"{brand}: downloading {len(urls)} new image(s)...")
        if brand == "toyota":
            download_toyota(urls)
        else:
            download_lexus(urls)


if __name__ == "__main__":
    main()
