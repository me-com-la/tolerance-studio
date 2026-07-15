// Clip preview playback — shared by 7-review-gallery.html and my-images.html
// (Files → Animations tab). One file so the two grids never drift.
//
// Why (Owner call + /ui-ux-pro-max, 2026-07-15): every clip used to be a bare
// <video autoplay loop>, so a grid of N clips asked the browser for N hardware
// video decoders at once. Browsers cap concurrent decoders at ~a handful, so
// past that the pipeline stalls every clip at roughly the same moment — the
// "they all freeze after a while" bug. The fix is the portfolio pattern:
//   • each card holds on its first frame (a still "poster") with a ▶ badge
//   • hover to play (desktop) / tap to play (touch)
//   • only ONE clip ever plays at a time — moving to another pauses the last
// That caps live decoders at 1, kills the freeze, saves battery/CPU/data, and
// needs no motion until the reviewer asks for it (reduced-motion friendly).
//
// Usage: add class="anim-preview" (and preload="metadata", no autoplay) to the
// <video>, whose parent is a position:relative frame. Call AnimPreview.init()
// after every grid re-render — already-wired videos are skipped.
(function () {
  'use strict';

  var CSS =
    '.anim-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);' +
    'width:52px;height:52px;border-radius:50%;border:none;background:rgba(0,0,0,.5);' +
    'color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;' +
    'padding-left:3px;z-index:4;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);' +
    'transition:opacity .15s ease,transform .15s ease,background .15s ease}' +
    '.anim-play:hover{background:rgba(0,0,0,.72);transform:translate(-50%,-50%) scale(1.06)}' +
    '.anim-play:focus-visible{outline:2px solid #9d7aff;outline-offset:3px}' +
    '.anim-play svg{display:block}' +
    // When this frame's clip is playing, fade the badge out and let clicks
    // through to the video/frame (so tap-again can pause on touch).
    '.is-playing>.anim-play{opacity:0;pointer-events:none}' +
    // Reduced motion: no scale nudge.
    '@media (prefers-reduced-motion: reduce){.anim-play{transition:opacity .15s ease}' +
    '.anim-play:hover{transform:translate(-50%,-50%)}}';

  var styled = false;
  function ensureStyle() {
    if (styled) return;
    styled = true;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // Desktop-style hover only where a fine pointer that can truly hover exists;
  // touch/coarse pointers get tap-to-toggle instead.
  var canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  // The single clip allowed to play. One-at-a-time is what caps live decoders.
  var current = null;

  function stop(v) {
    try { v.pause(); v.currentTime = 0; } catch (e) { /* metadata not ready yet */ }
    if (v.parentElement) v.parentElement.classList.remove('is-playing');
    if (current === v) current = null;
  }

  function start(v) {
    if (current && current !== v) stop(current);
    current = v;
    if (v.parentElement) v.parentElement.classList.add('is-playing');
    var p = v.play();
    if (p && p.catch) p.catch(function () { /* interrupted / not buffered — ignore */ });
  }

  function toggle(v) { if (v.paused) start(v); else stop(v); }

  function wire(v) {
    if (v.dataset.previewWired) return;
    v.dataset.previewWired = '1';
    v.removeAttribute('autoplay');
    v.muted = true; v.loop = true; v.playsInline = true;
    if (!v.getAttribute('preload')) v.preload = 'metadata';

    var frame = v.parentElement;
    if (!frame) return;

    var badge = document.createElement('button');
    badge.className = 'anim-play';
    badge.type = 'button';
    badge.setAttribute('aria-label', 'Play preview');
    badge.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
      '<path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    frame.appendChild(badge);

    // Badge click always toggles (keyboard Enter/Space land here too), and
    // never bubbles to the frame's own click handler.
    badge.addEventListener('click', function (e) { e.stopPropagation(); toggle(v); });

    if (canHover) {
      frame.addEventListener('mouseenter', function () { start(v); });
      frame.addEventListener('mouseleave', function () { stop(v); });
    } else {
      // Touch: a tap anywhere on the frame toggles play/pause.
      frame.addEventListener('click', function () { toggle(v); });
    }

    // Keep the frame's is-playing class honest even if playback state changes
    // outside our helpers (e.g. the browser pauses on tab hide).
    v.addEventListener('play', function () { frame.classList.add('is-playing'); });
    v.addEventListener('pause', function () { frame.classList.remove('is-playing'); });
  }

  function init(root) {
    ensureStyle();
    (root || document).querySelectorAll('video.anim-preview').forEach(wire);
  }

  window.AnimPreview = { init: init };
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', function () { init(); });
})();
