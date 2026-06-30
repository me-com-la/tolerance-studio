#!/usr/bin/env python3
"""
Generate art-director keywords for Lexus and Toyota images using Claude Sonnet vision.
Writes a 'keywords' field (array of 10 strings) into each manifest entry.
Safe to re-run: skips images that already have keywords.

Usage:
  python3 describe_images.py                  # both brands
  python3 describe_images.py --brand lexus
  python3 describe_images.py --brand toyota
  python3 describe_images.py --redescribe     # overwrite existing keywords
  python3 describe_images.py --dry-run        # print what would be processed, no API calls
"""

import argparse
import base64
import json
import os
import time
from pathlib import Path

import anthropic

BASE_DIR = Path(__file__).parent

BRANDS = {
    "lexus": {
        "manifest": BASE_DIR / "Lexus" / "manifest.json",
        "library": BASE_DIR / "Lexus" / "library",
    },
    "toyota": {
        "manifest": BASE_DIR / "Toyota" / "manifest.json",
        "library": BASE_DIR / "Toyota" / "library",
    },
}

MODEL = "claude-sonnet-4-6"

PROMPT = """You are keywording a car photo for a searchable image library used by art directors.
Return exactly 10 keywords or short phrases that describe this image — the kind of words an art director would use when searching for a photo to use.

Think in terms of:
- scene / setting (mountain road, city street, desert, racetrack, parking garage, studio)
- environment (night, golden hour, overcast, snowy, rainy, foggy, sunny)
- mood / feel (cinematic, dramatic, moody, clean, lifestyle, rugged, luxury)
- subject focus (exterior, interior, dashboard, steering wheel, wheels, detail shot)
- people (no people, driver, hands on wheel, family, couple, silhouette)
- color / visual (blue car, red interior, dark tones, bright light, reflections)
- activity (off-road, driving, parked, cornering, on highway)
- distinctive elements (snow, canyon, coastline, skyscrapers, forest, open road)

Output ONLY a JSON array of 10 strings. No explanation, no markdown, no extra text.
Example: ["night", "city street", "wet pavement", "exterior", "no people", "cinematic", "dark tones", "parked", "urban", "reflections"]"""


def encode_image(path: Path) -> str:
    return base64.standard_b64encode(path.read_bytes()).decode("utf-8")


def detect_media_type(path: Path) -> str:
    header = path.read_bytes()[:4]
    if header[:2] == b'\xff\xd8':
        return "image/jpeg"
    if header[:4] == b'\x89PNG':
        return "image/png"
    if header[:4] in (b'RIFF', b'WEBP'):
        return "image/webp"
    # fallback to extension
    suffix = path.suffix.lower()
    return "image/jpeg" if suffix in (".jpg", ".jpeg") else "image/png" if suffix == ".png" else "image/webp"


def describe_image(client: anthropic.Anthropic, img_path: Path) -> list[str]:
    image_data = encode_image(img_path)
    media_type = detect_media_type(img_path)

    message = client.messages.create(
        model=MODEL,
        max_tokens=150,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_data,
                        },
                    },
                    {"type": "text", "text": PROMPT},
                ],
            }
        ],
    )
    raw = message.content[0].text.strip()
    keywords = json.loads(raw)
    if not isinstance(keywords, list):
        raise ValueError(f"Expected list, got: {raw}")
    return [str(k).lower() for k in keywords[:10]]


def process_brand(brand: str, config: dict, client: anthropic.Anthropic, args: argparse.Namespace):
    manifest_path = config["manifest"]
    library = config["library"]

    if not manifest_path.exists():
        print(f"  No manifest found for {brand}, skipping.")
        return

    manifest = json.loads(manifest_path.read_text())
    total = skipped = described = errors = 0

    for uid, entry in manifest.items():
        if not args.redescribe and entry.get("keywords"):
            skipped += 1
            continue

        model = entry.get("model") or (entry.get("models") or [None])[0]
        if not model:
            continue

        img_path = library / model / entry["subfolder"] / entry["filename"]
        if not img_path.exists():
            continue

        total += 1

        if args.dry_run:
            print(f"  [dry-run] {brand}/{model}/{entry['filename']}")
            continue

        try:
            keywords = describe_image(client, img_path)
            entry["keywords"] = keywords
            described += 1
            print(f"  {brand}/{model}/{entry['filename']}")
            print(f"    → {', '.join(keywords)}")
        except Exception as e:
            print(f"  ✗ {img_path.name}: {e}")
            errors += 1
            time.sleep(2)  # back off on error

        # save every 20 images
        if total % 20 == 0:
            manifest_path.write_text(json.dumps(manifest, indent=2))
            print(f"  … {total} processed so far ({brand})")

        # rate limit: ~3 images/sec to stay well within limits
        time.sleep(0.35)

    if not args.dry_run:
        manifest_path.write_text(json.dumps(manifest, indent=2))

    print(f"\n{brand}: {total} processed, {described} described, {skipped} skipped, {errors} errors.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brand", choices=["lexus", "toyota"], help="Process one brand only")
    parser.add_argument("--redescribe", action="store_true", help="Overwrite existing keywords")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be processed without API calls")
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key and not args.dry_run:
        print("Error: ANTHROPIC_API_KEY environment variable not set.")
        print("  export ANTHROPIC_API_KEY=sk-ant-...")
        return

    client = anthropic.Anthropic(api_key=api_key) if not args.dry_run else None

    brands_to_run = [args.brand] if args.brand else list(BRANDS.keys())

    for brand in brands_to_run:
        print(f"\n--- {brand.upper()} ---")
        process_brand(brand, BRANDS[brand], client, args)

    print("\nAll done.")


if __name__ == "__main__":
    main()
