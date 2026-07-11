// lib/lightbox.js — image viewer with prev/next, zoom, and pan.
// Ported from tools/control.html's lightbox (same behavior: click-to-zoom
// 2.5x, wheel zoom, drag-to-pan while zoomed, arrow keys + on-screen
// buttons for prev/next, Escape to close, counter, "open original" link).
//
// Loaded via a plain <script src="lib/lightbox.js"> (no type="module"),
// same reason as lib/supabase.js — keep this free of import/export.
//
// Usage on any page:
//   1. Include the markup from lib/lightbox.html (or copy the <div id="lightbox">
//      block) once per page.
//   2. Give every clickable thumbnail class="lb-thumb" and onclick="openLightbox(this)".
//      openLightbox groups thumbnails by their nearest ancestor with class
//      "grid" (or the whole document if none), so prev/next stays scoped to
//      whichever gallery grid the click came from — same rule as control.html.
//   3. Each <img class="lb-thumb"> must have its real, already-resolved src
//      set (signed URL) before the user clicks it — OR carry the URL in a
//      data-full attribute instead (lbShow reads data-full first, falling
//      back to .src). data-full lets a gallery defer the thumbnail's own
//      fetch (real viewport-gated lazy loading, e.g. my-images.html) while
//      keeping Next/Prev instant and correct for images never scrolled to.

let lbList = [], lbIdx = 0, lbScale = 1, lbX = 0, lbY = 0, lbDrag = null;

function openLightbox(imgEl) {
  const grid = imgEl.closest('.grid') || document;
  lbList = Array.from(grid.querySelectorAll('img.lb-thumb'));
  lbIdx = lbList.indexOf(imgEl);
  if (lbIdx < 0) lbIdx = 0;
  document.getElementById('lightbox').style.display = 'flex';
  lbShow();
}
function closeLightbox() {
  document.getElementById('lightbox').style.display = 'none';
  lbList = [];
}
function lbShow() {
  const el = lbList[lbIdx];
  if (!el) return;
  const full = el.dataset.full || el.src;
  const img = document.getElementById('lb-img');
  img.src = full;
  document.getElementById('lb-open-orig').href = full;
  document.getElementById('lb-counter').textContent = (lbIdx + 1) + ' / ' + lbList.length;
  lbResetZoom();
}
function lbNext(dir) {
  if (!lbList.length) return;
  lbIdx = (lbIdx + dir + lbList.length) % lbList.length;
  lbShow();
}
function lbResetZoom() {
  lbScale = 1; lbX = 0; lbY = 0;
  const img = document.getElementById('lb-img');
  img.style.transform = 'translate(0,0) scale(1)';
  img.classList.remove('zoomed');
}
function lbApplyTransform() {
  const img = document.getElementById('lb-img');
  img.style.transform = `translate(${lbX}px,${lbY}px) scale(${lbScale})`;
  img.classList.toggle('zoomed', lbScale > 1);
}
function initLightboxEvents() {
  const img = document.getElementById('lb-img');
  if (!img) return;
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    if (lbScale > 1) { lbResetZoom(); return; }
    lbScale = 2.5; lbApplyTransform();
  });
  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    lbScale = Math.min(5, Math.max(1, lbScale - e.deltaY * 0.0015 * lbScale));
    if (lbScale <= 1.02) { lbResetZoom(); } else { lbApplyTransform(); }
  }, { passive: false });
  img.addEventListener('mousedown', (e) => {
    if (lbScale <= 1) return;
    lbDrag = { startX: e.clientX, startY: e.clientY, origX: lbX, origY: lbY };
    img.classList.add('panning');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!lbDrag) return;
    lbX = lbDrag.origX + (e.clientX - lbDrag.startX);
    lbY = lbDrag.origY + (e.clientY - lbDrag.startY);
    lbApplyTransform();
  });
  window.addEventListener('mouseup', () => {
    if (lbDrag) { lbDrag = null; img.classList.remove('panning'); }
  });
  window.addEventListener('keydown', (e) => {
    if (document.getElementById('lightbox').style.display !== 'flex') return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight') lbNext(1);
    else if (e.key === 'ArrowLeft') lbNext(-1);
  });
}
document.addEventListener('DOMContentLoaded', initLightboxEvents);
