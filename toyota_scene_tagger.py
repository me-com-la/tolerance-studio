#!/usr/bin/env python3
"""
Tag Toyota images with on-road / off-road using Apple Vision VNClassifyImageRequest.
Only tags when confident — skips ambiguous images.
Safe to re-run: skips already scene-tagged images unless --retag.

Usage:
  python3 toyota_scene_tagger.py
  python3 toyota_scene_tagger.py --retag
"""

import argparse
import json
from pathlib import Path

import Vision
from Cocoa import NSURL
from Quartz import CIImage

BASE_DIR      = Path(__file__).parent
MANIFEST_PATH = BASE_DIR / "Toyota" / "manifest.json"
TOYOTA_LIB    = BASE_DIR / "Toyota" / "library"

# Labels that strongly indicate on-road (paved surface, urban driving)
ON_ROAD_LABELS = {"road", "road_other", "parking_lot", "sidewalk", "street"}

# Labels that strongly indicate off-road (natural terrain)
OFF_ROAD_LABELS = {"hill", "rocks", "sand", "sand_dune", "desert", "grass",
                   "forest", "mountain", "cliff", "path", "vegetation", "shrub"}

# Confidence threshold — only fire if a signal label clears this
CONF_ON  = 0.30
CONF_OFF = 0.25  # slightly lower since off-road has more label variety


def classify(img_path: Path):
    """Return 'on-road', 'off-road', or None if not confident."""
    url      = NSURL.fileURLWithPath_(str(img_path))
    ci_image = CIImage.imageWithContentsOfURL_(url)
    if ci_image is None:
        return None

    handler = Vision.VNImageRequestHandler.alloc().initWithCIImage_options_(ci_image, {})
    req     = Vision.VNClassifyImageRequest.alloc().init()
    handler.performRequests_error_([req], None)

    labels = {r.identifier(): r.confidence() for r in (req.results() or [])}

    on_score  = max((labels.get(l, 0) for l in ON_ROAD_LABELS),  default=0)
    off_score = max((labels.get(l, 0) for l in OFF_ROAD_LABELS), default=0)

    if on_score >= CONF_ON and on_score > off_score:
        return "on-road"
    if off_score >= CONF_OFF and off_score > on_score:
        return "off-road"
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--retag", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text())
    total = tagged = skipped = errors = 0

    for uid, entry in manifest.items():
        if not args.retag and entry.get("scene_tagged"):
            skipped += 1
            continue

        models = entry.get("models") or ([entry["model"]] if entry.get("model") else [])
        if not models:
            continue

        model    = models[0]
        img_path = TOYOTA_LIB / model / entry["subfolder"] / entry["filename"]
        if not img_path.exists():
            continue

        total += 1
        try:
            result = classify(img_path)
            entry["scene_tagged"] = True
            tags = entry.get("tags") or []
            # remove stale on/off-road tags before re-adding
            tags = [t for t in tags if t not in ("on-road", "off-road")]
            if result:
                tags.append(result)
                print(f"  [{result}] {model}/{entry['filename']}")
            entry["tags"] = tags
            tagged += 1
        except Exception as e:
            print(f"  ✗ {entry['filename']}: {e}")
            errors += 1

        if total % 50 == 0:
            MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
            print(f"  … {total} processed")

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
    print(f"\nDone. {total} processed, {tagged} scene-tagged, {skipped} skipped, {errors} errors.")


if __name__ == "__main__":
    main()
