// lib/subject-detect.js — find the in-focus subject in a render, entirely
// client-side (canvas + plain JS, no network call, no server). Tolerance
// Studio's product shots are consistently shallow depth-of-field (product
// sharp, background bokeh-blurred) — see any tools/pixel-lock prompt
// template — so "sharpest region" is a reliable, model-free stand-in for
// "the product" without needing an object detector or an external API.
//
// Used by 8-compose.html to decide where to crop/zoom the background image
// so the copy's scrim doesn't land on top of the product.

window.SubjectDetect = (function () {
  // Downscale for analysis — the algorithm only needs to find a region, not
  // exact edges, and this keeps the pixel loops fast (~130k px) even on a
  // 2000px source render.
  const ANALYSIS_MAX = 360;

  function toGrayscale(imgData) {
    const { data, width, height } = imgData;
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      // standard luma weights
      gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return gray;
  }

  // 3x3 Laplacian (edge/texture energy) — high where the image is sharp and
  // detailed, near-zero across smooth/blurred bokeh regions.
  function laplacian(gray, w, h) {
    const out = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        out[i] = v * v; // squared -> energy, always positive
      }
    }
    return out;
  }

  // Summed-area table so a windowed box-sum is O(1) per pixel instead of
  // O(window^2) — needed to keep this fast in plain JS.
  function integralImage(vals, w, h) {
    const sat = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += vals[y * w + x];
        sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    return sat;
  }
  function boxSum(sat, w, h, x0, y0, x1, y1) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(w, x1); y1 = Math.min(h, y1);
    const s = (x, y) => sat[y * (w + 1) + x];
    return s(x1, y1) - s(x0, y1) - s(x1, y0) + s(x0, y0);
  }

  // Separable min/max filter — `op` picks dilate (max, grows the mask) or
  // erode (min, shrinks it back). Both are 1D-separable box filters, so this
  // stays fast even as a brute-force loop at analysis resolution.
  function boxFilter(mask, w, h, radius, op) {
    const pick = op === 'max' ? (a, b) => (a || b ? 1 : 0) : (a, b) => (a && b ? 1 : 0);
    const empty = op === 'max' ? 0 : 1;
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = empty;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const cell = (nx < 0 || nx >= w) ? empty : mask[y * w + nx];
          v = pick(v, cell);
        }
        tmp[y * w + x] = v;
      }
    }
    const out = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = empty;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          const cell = (ny < 0 || ny >= h) ? empty : tmp[ny * w + x];
          v = pick(v, cell);
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // Morphological close (dilate then erode, same radius) — bridges small
  // gaps between nearby-but-separate sharp blobs (e.g. two bowls sitting a
  // few inches apart) so they merge into one subject region, WITHOUT the
  // runaway growth a dilate-only pass would cause (that over-merged into
  // unrelated sharp edges elsewhere in frame — e.g. the dog, window mullions
  // — the first version of this function shipped without the erode step and
  // that's exactly what happened: bbox ballooned to nearly full-frame width).
  function closeMask(mask, w, h, radius) {
    return boxFilter(boxFilter(mask, w, h, radius, 'max'), w, h, radius, 'min');
  }

  // Largest 4-connected blob above threshold — BFS flood fill. At analysis
  // resolution (<=360px) the grid is small enough that a plain JS BFS is
  // effectively instant.
  function largestBlobBBox(mask, w, h) {
    const seen = new Uint8Array(w * h);
    let best = null, bestSize = 0;
    const qx = new Int32Array(w * h), qy = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx] || seen[idx]) continue;
        let head = 0, tail = 0;
        qx[tail] = x; qy[tail] = y; tail++; seen[idx] = 1;
        let x0 = x, x1 = x, y0 = y, y1 = y, size = 0;
        while (head < tail) {
          const cx = qx[head], cy = qy[head]; head++;
          size++;
          if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
          if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
          const neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
          for (const [nx, ny] of neighbors) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            if (mask[nIdx] && !seen[nIdx]) { seen[nIdx] = 1; qx[tail] = nx; qy[tail] = ny; tail++; }
          }
        }
        if (size > bestSize) { bestSize = size; best = { x0, y0, x1: x1 + 1, y1: y1 + 1 }; }
      }
    }
    return best;
  }

  function percentile(arr, p) {
    const sorted = Float32Array.from(arr).sort();
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  /**
   * Find the sharpest (in-focus) region of an image — the product, in
   * Tolerance Studio's shallow-DOF shots.
   * @param {HTMLImageElement} img
   * @returns {{x0:number,y0:number,x1:number,y1:number, cx:number, cy:number, w:number, h:number}}
   *   bbox in ORIGINAL image pixel coordinates, plus its center and size.
   */
  function findSubjectBBox(img) {
    const scale = Math.min(1, ANALYSIS_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(8, Math.round(img.naturalWidth * scale));
    const h = Math.max(8, Math.round(img.naturalHeight * scale));

    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0, w, h);
    const imgData = octx.getImageData(0, 0, w, h);

    const gray = toGrayscale(imgData);
    const energy = laplacian(gray, w, h);
    const sat = integralImage(energy, w, h);

    const win = Math.max(6, Math.round(Math.min(w, h) * 0.07)); // ~7% of the shorter side
    const local = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        local[y * w + x] = boxSum(sat, w, h, x - win, y - win, x + win, y + win);
      }
    }

    const thresh = percentile(local, 88);
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < local.length; i++) mask[i] = local[i] > thresh ? 1 : 0;
    mask = closeMask(mask, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.05)));

    let blob = largestBlobBBox(mask, w, h);
    if (!blob) {
      // degenerate (flat image, no detectable focus falloff) — fall back to
      // a center-weighted default so callers never have to special-case null
      blob = { x0: w * 0.25, y0: h * 0.25, x1: w * 0.75, y1: h * 0.75 };
    }

    const inv = 1 / scale;
    const x0 = blob.x0 * inv, y0 = blob.y0 * inv, x1 = blob.x1 * inv, y1 = blob.y1 * inv;
    return {
      x0, y0, x1, y1,
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      w: x1 - x0, h: y1 - y0,
    };
  }

  /**
   * Compute a cover-crop draw transform (scale, dx, dy — same shape as the
   * plain centered cover-crop in renderPreview) that keeps the canvas fully
   * covered but biases the subject bbox toward `targetXRatio`/`targetYRatio`
   * (0..1 of canvas width/height) instead of dead center on either axis,
   * zooming in a little further than a pure cover-crop would if that's what
   * it takes to make room — capped at `maxZoom` so it never blows the
   * product up absurdly on a tight source. Pass 0.5 for whichever axis
   * shouldn't be pushed (e.g. targetYRatio=0.5 when only the text's left/
   * right zone matters, not its top/middle/bottom zone).
   * Falls back to the closest achievable position (never crops the subject
   * itself out of frame if any tested zoom level can avoid that) when the
   * source doesn't have enough room to hit the target exactly.
   */
  function computeSubjectCrop(img, W, H, bbox, targetXRatio, targetYRatio, maxZoom) {
    if (targetYRatio == null) targetYRatio = 0.5;
    maxZoom = maxZoom || 1.3;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const coverScale = Math.max(W / iw, H / ih);

    let best = null;
    // Try increasing zoom in small steps, always keeping the candidate that
    // gets closest to the target position — fully-visible candidates always
    // beat non-fully-visible ones; within the same visibility tier, smaller
    // error wins; on an exact tie, the LATER (more-zoomed) step wins, since
    // more zoom only ever gets tried because the lower-zoom step already
    // fell short, so a tie means the extra zoom was free precision, not
    // waste. Every step is compared against the running best — a fix for
    // the previous version, which locked onto step 0's result the moment
    // nothing was fully visible and silently ignored every later, closer
    // step for the rest of the loop.
    const steps = 6;
    for (let s = 0; s <= steps; s++) {
      const scale = coverScale * (1 + (maxZoom - 1) * (s / steps));
      const drawW = iw * scale, drawH = ih * scale;
      const dxMin = W - drawW, dxMax = 0;
      const dyMin = H - drawH, dyMax = 0;

      const targetX = W * targetXRatio;
      let dx = targetX - bbox.cx * scale;
      dx = Math.max(dxMin, Math.min(dxMax, dx));

      const targetY = H * targetYRatio;
      let dy = targetY - bbox.cy * scale;
      dy = Math.max(dyMin, Math.min(dyMax, dy));

      const bx0 = bbox.x0 * scale + dx, bx1 = bbox.x1 * scale + dx;
      const by0 = bbox.y0 * scale + dy, by1 = bbox.y1 * scale + dy;
      const subjectFullyVisible = bx0 >= -1 && bx1 <= W + 1 && by0 >= -1 && by1 <= H + 1;

      const achievedX = bbox.cx * scale + dx;
      const achievedY = bbox.cy * scale + dy;
      const err = Math.hypot(achievedX - targetX, achievedY - targetY);

      const candidate = { scale, dx, dy, err, subjectFullyVisible };
      if (!best) {
        best = candidate;
      } else if (candidate.subjectFullyVisible && !best.subjectFullyVisible) {
        best = candidate; // any fully-visible candidate beats any not-fully-visible one
      } else if (candidate.subjectFullyVisible === best.subjectFullyVisible && candidate.err <= best.err) {
        best = candidate; // same tier: closer (or tied-but-more-zoomed) wins
      }
    }
    return best;
  }

  return { findSubjectBBox, computeSubjectCrop };
})();
