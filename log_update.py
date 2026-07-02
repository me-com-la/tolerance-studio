#!/usr/bin/env python3
"""
Append an entry to update_log.json recording what changed in a maintenance
pass — added/removed image filenames, counts, per brand.

Run this AFTER you've reviewed diff_report.json in diff_review.html and
applied the approved add/remove steps (toyota_scraper.py / lexus_scraper.py
for adds, apply_removed.py for removes). It reads diff_report.json for the
list of changed URLs, so run it before that file gets overwritten by next
week's scan.

Usage:
  python3 log_update.py                    # logs both brands from diff_report.json
  python3 log_update.py --brand toyota      # logs just one brand
  python3 log_update.py --note "recolored 2026 Camry hero shots"
"""

import argparse
import json
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).parent
REPORT_PATH = BASE_DIR / "diff_report.json"
LOG_PATH = BASE_DIR / "update_log.json"


def filename_of(url: str) -> str:
    return Path(urlparse(url).path).name


def load_log() -> list:
    if LOG_PATH.exists():
        return json.loads(LOG_PATH.read_text())
    return []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand", choices=["lexus", "toyota"], default=None)
    parser.add_argument("--note", default="")
    parser.add_argument("--force", action="store_true",
                         help="log even if this brand already has an entry for today")
    args = parser.parse_args()

    report = json.loads(REPORT_PATH.read_text())
    log = load_log()

    brands = [args.brand] if args.brand else [b for b in ("lexus", "toyota") if b in report]
    entries_added = 0
    today = str(date.today())

    for brand in brands:
        section = report.get(brand)
        if not section:
            continue
        added = section.get("added", [])
        removed = section.get("removed", [])
        if not added and not removed:
            continue

        if not args.force and any(e.get("date") == today and e.get("brand") == brand for e in log):
            print(f"already logged {brand} today — use --force to log anyway")
            continue

        log.append({
            "date": str(date.today()),
            "brand": brand,
            "added_count": len(added),
            "removed_count": len(removed),
            "added": [filename_of(u) for u in added],
            "removed": [filename_of(u) for u in removed],
            "note": args.note,
        })
        entries_added += 1
        print(f"Logged {brand}: +{len(added)} / -{len(removed)}")

    if entries_added:
        LOG_PATH.write_text(json.dumps(log, indent=2))
        print(f"Wrote {LOG_PATH}")
    else:
        print("Nothing to log — no added/removed entries in diff_report.json")


if __name__ == "__main__":
    main()
