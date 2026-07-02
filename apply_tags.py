#!/usr/bin/env python3
"""
Apply hand-made tag changes exported from the viewer's "Tagging" panel.

Workflow:
  1. In the viewer sidebar, open "Tagging" and turn tag mode on.
  2. Click the badge on each image (or press T in the lightbox) to tag it.
  3. Click "Download patch file" — saves tag_patch.json (usually to ~/Downloads).
  4. Run:  python3 apply_tags.py ~/Downloads/tag_patch.json
  5. Back in the viewer: click "Clear pending (after applying)", then reload.

Only touches the "custom" field on manifest entries — never deletes images
or changes anything else. Safe to re-run with the same patch file.
"""

import json
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent

MANIFESTS = {
    "toyota": BASE_DIR / "Toyota" / "manifest.json",
    "lexus": BASE_DIR / "Lexus" / "manifest.json",
}


def main():
    if len(sys.argv) != 2:
        print(__doc__.strip())
        sys.exit(1)

    patch_path = Path(sys.argv[1]).expanduser()
    if not patch_path.exists():
        print(f"Patch file not found: {patch_path}")
        sys.exit(1)

    patch = json.loads(patch_path.read_text())

    for brand, manifest_path in MANIFESTS.items():
        changes = patch.get(brand) or {}
        if not changes:
            print(f"{brand}: nothing in patch")
            continue

        manifest = json.loads(manifest_path.read_text())
        applied = 0
        skipped = 0
        for key, tags in changes.items():
            entry = manifest.get(key)
            if entry is None:
                print(f"  ! {brand}: key {key} not in manifest (image removed since tagging?) — skipped")
                skipped += 1
                continue
            tags = sorted({t.strip().lower() for t in tags if t and t.strip()})
            if tags:
                entry["custom"] = tags
            else:
                entry.pop("custom", None)
            applied += 1

        manifest_path.write_text(json.dumps(manifest, indent=2))
        note = f", {skipped} skipped" if skipped else ""
        print(f"{brand}: updated {applied} manifest entr{'y' if applied == 1 else 'ies'}{note}")

    print("Done. Reload the viewer and use the Parts filter — remember to click")
    print('"Clear pending (after applying)" in the Tagging panel.')


if __name__ == "__main__":
    main()
