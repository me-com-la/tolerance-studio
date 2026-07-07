# Homepage ticker images

The homepage hero ticker loads images from this folder by number:
`1.jpg`, `2.jpg`, `3.jpg` ... (also accepts `.png` or `.webp`).

To add an image: drop it in here named with the next number in the
sequence. No code changes needed — the page probes numbers in order
and stops after three consecutive gaps, so keep the numbering
continuous.

Tips:
- Any aspect ratio works; the ticker crops nothing (fixed height,
  natural width).
- Keep files small — resize to ~640px tall before dropping in.
  Originals live in images/pro, images/KindTail, images/Toyota,
  images/Wingstudio.
