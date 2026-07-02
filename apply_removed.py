#!/usr/bin/env python3
"""
Apply confirmed removals from diff_report.json: deletes the image file from
the library folder AND removes its entry from manifest.json.

Only ever removes URLs YOU have manually reviewed and confirmed gone from the
live site (e.g. via diff_review.html). Never run this blindly on a fresh
diff_report.json — a scan can misreport removals if a model's page fails to
load (see the c-hr incident, 2026-07-01).

Usage:
  python3 apply_removed.py --brand lexus --url "https://delivery.lcom..."
  python3 apply_removed.py --brand lexus --all-reviewed   # removes every URL
                                                            # currently listed
                                                            # under that brand's
                                                            # "removed" in
                                                            # diff_report.json
"""

import argparse
import json
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).parent
REPORT_PATH = BASE_DIR / "diff_report.json"

BRAND_PATHS = {
    "lexus": (BASE_DIR / "Lexus" / "manifest.json", BASE_DIR / "Lexus" / "library"),
    "toyota": (BASE_DIR / "Toyota" / "manifest.json", BASE_DIR / "Toyota" / "library"),
}


def remove_url(brand: str, url: str):
    manifest_path, library_dir = BRAND_PATHS[brand]
    manifest = json.loads(manifest_path.read_text())

    match_key = None
    for key, entry in manifest.items():
        if entry.get("url") == url:
            match_key = key
            break

    if match_key is None:
        print(f"  ! not found in manifest: {url}")
        return

    entry = manifest.pop(match_key)
    manifest_path.write_text(json.dumps(manifest, indent=2))

    model = entry.get("model") or (entry.get("models") or [None])[0]
    subfolder = entry.get("subfolder", "")
    filename = entry.get("filename", Path(urlparse(url).path).name)
    file_path = library_dir / model / subfolder / filename

    def entry_path(e):
        e_model = e.get("model") or (e.get("models") or [None])[0]
        e_subfolder = e.get("subfolder", "")
        e_filename = e.get("filename", Path(urlparse(e.get("url", "")).path).name)
        return library_dir / e_model / e_subfolder / e_filename

    still_in_use = any(entry_path(e) == file_path for e in manifest.values())

    if still_in_use:
        print(f"  - removed manifest entry only (file still used by another entry): {model}/{subfolder}/{filename}")
    elif file_path.exists():
        file_path.unlink()
        print(f"  - deleted file + manifest entry: {model}/{subfolder}/{filename}")

        # Also drop the cached thumbnail if one exists
        thumb_path = file_path.parent / "thumbs" / filename
        if thumb_path.exists():
            thumb_path.unlink()
    else:
        print(f"  - removed manifest entry only (file not found on disk): {model}/{subfolder}/{filename}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand", choices=["lexus", "toyota"], required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--url", help="Single URL to remove")
    group.add_argument("--all-reviewed", action="store_true",
                        help="Remove every URL in this brand's diff_report.json 'removed' list")
    args = parser.parse_args()

    if args.url:
        remove_url(args.brand, args.url)
        return

    report = json.loads(REPORT_PATH.read_text())
    urls = report.get(args.brand, {}).get("removed", [])
    if not urls:
        print(f"No removed entries for {args.brand} in diff_report.json")
        return

    print(f"Removing {len(urls)} confirmed-gone {args.brand} image(s)...")
    for url in urls:
        remove_url(args.brand, url)


if __name__ == "__main__":
    main()
