#!/usr/bin/env python3
"""
Weekly scan: detect new/removed image URLs on Lexus + Toyota model pages
WITHOUT downloading anything. Compares live page URLs against manifest.json.

Writes diff_report.json:
  {
    "generated": "2026-07-01",
    "lexus":  {"added": [...], "removed": [...], "suspect_models": [...]},
    "toyota": {"added": [...], "removed": [...], "suspect_models": [...]}
  }

"added"   = URL seen on the live site but not in manifest.json (new image)
"removed" = URL in manifest.json but no longer seen on the live site
"suspect_models" = models we couldn't properly check this scan — either a
  per-model page load failed, or the model was never discovered at all
  (e.g. the 2026-07-01 c-hr incident: a slug regex missed the model). Every
  "removed" entry for these models may be a false positive. Each item is
  {"slug": ..., "reason": "page failed to load" | "not found during discovery"}.

Run:
  python3 weekly_diff.py             # both brands
  python3 weekly_diff.py --brand lexus
  python3 weekly_diff.py --brand toyota
"""

import argparse
import asyncio
import json
from datetime import date
from pathlib import Path
from typing import Optional

from playwright.async_api import async_playwright

import lexus_scraper as lx
import toyota_scraper as ty

BASE_DIR = Path(__file__).parent
REPORT_PATH = BASE_DIR / "diff_report.json"


def manifest_urls(manifest: dict) -> set[str]:
    return {entry["url"] for entry in manifest.values() if "url" in entry}


def manifest_model_slugs(manifest: dict) -> set[str]:
    slugs: set[str] = set()
    for entry in manifest.values():
        models_list = entry.get("models") or [entry.get("model", "")]
        slugs.update(s for s in models_list if s)
    return slugs


def unscanned_models(manifest: dict, discovered_slugs: set[str]) -> list[dict]:
    """Manifest models that discovery never even found (the c-hr failure mode)."""
    missing = manifest_model_slugs(manifest) - discovered_slugs
    return [{"slug": s, "reason": "not found during discovery"} for s in sorted(missing)]


async def scan_lexus(page) -> tuple[set[str], list[dict], set[str]]:
    live_urls: set[str] = set()
    failed_models: list[dict] = []
    models = await lx.discover_models(page)
    print(f"[lexus] {len(models)} models found")
    for m in models:
        try:
            await page.goto(m["url"], wait_until="domcontentloaded")
            await page.wait_for_timeout(4000)
            gallery = await lx.scrape_gallery(page)
            live_urls.update(u for u, _cat in gallery)
            heroes = await lx.scrape_hero(page)
            live_urls.update(heroes)
            design = await lx.scrape_design(page)
            for urls in design.values():
                live_urls.update(urls)
        except Exception as e:
            print(f"  [lexus] {m['slug']} failed: {e}")
            failed_models.append({"slug": m["slug"], "reason": "page failed to load"})
    discovered_slugs = {m["slug"] for m in models}
    return live_urls, failed_models, discovered_slugs


async def scan_toyota(page) -> tuple[set[str], list[dict], set[str]]:
    live_urls: set[str] = set()
    failed_models: list[dict] = []
    models = await ty.discover_models(page)
    print(f"[toyota] {len(models)} models found")
    for m in models:
        try:
            gallery = await ty.scrape_gallery(page, m["url"])
            live_urls.update(gallery)
        except Exception as e:
            print(f"  [toyota] {m['slug']} failed: {e}")
            failed_models.append({"slug": m["slug"], "reason": "page failed to load"})
    discovered_slugs = {m["slug"] for m in models}
    return live_urls, failed_models, discovered_slugs


def load_existing_report() -> dict:
    if REPORT_PATH.exists():
        try:
            return json.loads(REPORT_PATH.read_text())
        except json.JSONDecodeError:
            pass
    return {}


async def run(brand: Optional[str]):
    # Start from the existing report so a single-brand run doesn't wipe out
    # the other brand's most recent results.
    report = load_existing_report()
    report["generated"] = str(date.today())

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        if brand in (None, "lexus"):
            lx_manifest = lx.load_manifest()
            lx_live, lx_failed, lx_discovered = await scan_lexus(page)
            lx_known = manifest_urls(lx_manifest)
            suspect = lx_failed + unscanned_models(lx_manifest, lx_discovered)
            report["lexus"] = {
                "added": sorted(lx_live - lx_known),
                "removed": sorted(lx_known - lx_live),
                "suspect_models": sorted(suspect, key=lambda m: m["slug"]),
            }

        if brand in (None, "toyota"):
            ty_manifest = ty.load_manifest()
            ty_live, ty_failed, ty_discovered = await scan_toyota(page)
            ty_known = manifest_urls(ty_manifest)
            suspect = ty_failed + unscanned_models(ty_manifest, ty_discovered)
            report["toyota"] = {
                "added": sorted(ty_live - ty_known),
                "removed": sorted(ty_known - ty_live),
                "suspect_models": sorted(suspect, key=lambda m: m["slug"]),
            }

        await browser.close()

    REPORT_PATH.write_text(json.dumps(report, indent=2))

    for b in ("lexus", "toyota"):
        if b in report:
            print(f"\n{b}: +{len(report[b]['added'])} added, "
                  f"-{len(report[b]['removed'])} removed")

    print(f"\nWrote {REPORT_PATH}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand", choices=["lexus", "toyota"], default=None)
    args = parser.parse_args()
    asyncio.run(run(args.brand))
