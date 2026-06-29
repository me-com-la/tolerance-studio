#!/usr/bin/env python3
"""
Tag Lexus images using Apple Vision — detects people and faces.
Adds tags to manifest.json: 'people', 'face'
Safe to re-run: skips images already tagged (has 'tagged' key).

Usage:
  python3 lexus_tagger.py
  python3 lexus_tagger.py --retag   # re-run even if already tagged
"""

import argparse
import json
from pathlib import Path

import Vision
from Cocoa import NSURL
from Quartz import CIImage

BASE_DIR = Path(__file__).parent
MANIFEST_PATH = BASE_DIR / "Lexus" / "manifest.json"
LEXUS_LIB = BASE_DIR / "Lexus" / "library"


def detect_image(img_path: Path) -> list[str]:
    url = NSURL.fileURLWithPath_(str(img_path))
    ci_image = CIImage.imageWithContentsOfURL_(url)
    if ci_image is None:
        return []

    tags = set()
    handler = Vision.VNImageRequestHandler.alloc().initWithCIImage_options_(ci_image, {})

    people_req = Vision.VNDetectHumanRectanglesRequest.alloc().init()
    handler.performRequests_error_([people_req], None)
    if people_req.results() and len(people_req.results()) > 0:
        tags.add("people")

    face_req = Vision.VNDetectFaceRectanglesRequest.alloc().init()
    handler.performRequests_error_([face_req], None)
    if face_req.results() and len(face_req.results()) > 0:
        tags.add("face")
        tags.add("people")

    return sorted(tags)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--retag", action="store_true", help="Re-tag already-tagged images")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text())
    total = skipped = tagged = errors = 0

    for uid, entry in manifest.items():
        if not args.retag and entry.get("tagged"):
            skipped += 1
            continue

        model = entry.get("model") or (entry.get("models") or [None])[0]
        if not model:
            continue

        img_path = LEXUS_LIB / model / entry["subfolder"] / entry["filename"]
        if not img_path.exists():
            continue

        total += 1
        try:
            new_tags = detect_image(img_path)
            entry["tags"] = new_tags
            entry["tagged"] = True
            if new_tags:
                print(f"  [{', '.join(new_tags)}] {model}/{entry['filename']}")
            tagged += 1
        except Exception as e:
            print(f"  ✗ {img_path.name}: {e}")
            errors += 1

        if total % 50 == 0:
            MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
            print(f"  … {total} processed so far")

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
    print(f"\nDone. {total} processed, {tagged} tagged, {skipped} skipped, {errors} errors.")


if __name__ == "__main__":
    main()
