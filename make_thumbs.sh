#!/bin/bash
# Generate 400px-wide thumbnails for all downloaded images.
# Saves to thumbs/ subfolder next to each image. Skips if thumb already exists.

BRANDS=("Toyota" "Lexus")

for BRAND in "${BRANDS[@]}"; do
  LIB="$(dirname "$0")/${BRAND}/library"
  [ -d "$LIB" ] || continue
  echo "=== $BRAND ==="
  find "$LIB" -type f \( -iname "*.jpg" -o -iname "*.png" -o -iname "*.jpeg" -o -iname "*.webp" \) | while read -r img; do
    dir="$(dirname "$img")"
    base="$(basename "$img")"
    thumb_dir="${dir}/thumbs"
    thumb="${thumb_dir}/${base}"
    [ -f "$thumb" ] && continue
    mkdir -p "$thumb_dir"
    sips -Z 400 "$img" --out "$thumb" > /dev/null 2>&1 && echo "  ✓ $BRAND/.../${base}" || echo "  ✗ $img"
  done
done

echo "Done."
