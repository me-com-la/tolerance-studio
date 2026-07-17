// Animate prompt modal — shared by 8-compose.html (✦ Animate) and
// 7-review-gallery.html (✎ Edit & redo). One file so the two entry points
// can never drift (shared-linkage rule, project CLAUDE.md).
//
// Why a modal (Owner call, 2026-07-15): the motion prompt used to be a hidden
// house prompt with too much leeway. Now it's transparent — the AI drafts the
// motion description from the actual frame (animate Edge Function, action
// 'suggest'), the user edits it or writes their own, and the fixed house
// rules ("guardrails": nothing added/removed, product still, camera locked,
// seamless loop) are shown read-only so the user sees everything that gets
// sent. Guardrails stay non-editable on purpose — they're what stops new
// flowers/objects drifting into frame.
//
// API:
//   AnimateModal.open({
//     motionText,   // string|null — prefill; null/'' kicks off suggest() to draft
//     loop,         // bool — initial state of the seamless-loop checkbox
//     guardrails,   // string — read-only house rules, shown in the fold-out
//     suggest,      // async () => string — drafts motion text (also the ↻ button)
//     submitLabel,  // button text, default '✦ Animate'
//     onSubmit,     // async ({motionText, loop}) => {} — throw to keep modal open
//   })
(function () {
  'use strict';

  var CSS =
    '#anim-modal{position:fixed;inset:0;background:rgba(10,9,12,.8);display:none;align-items:center;justify-content:center;z-index:1100;padding:1rem}' +
    '#anim-modal.open{display:flex}' +
    '#anim-modal .am-box{background:var(--card,#1a1820);border:1px solid var(--line-2,rgba(255,255,255,.18));border-radius:var(--radius,14px);width:min(34rem,100%);max-height:92vh;overflow:auto;padding:1.4rem 1.5rem;color:var(--ink,#e8e6e1)}' +
    '#anim-modal h3{font-family:var(--font-display,sans-serif);font-size:1.25rem;font-weight:700;text-transform:uppercase;letter-spacing:.01em;margin:0 0 .3rem}' +
    '#anim-modal .am-sub{color:var(--muted,#9a978f);font-size:.83rem;margin-bottom:1rem}' +
    '#anim-modal label.am-l{display:block;font-size:.78rem;font-weight:600;color:var(--muted,#9a978f);text-transform:uppercase;letter-spacing:.04em;margin:.9rem 0 .35rem}' +
    '#anim-modal textarea{width:100%;min-height:7.5rem;background:var(--paper,#0c0b10);color:var(--ink,#e8e6e1);border:1px solid var(--line-2,rgba(255,255,255,.18));border-radius:10px;padding:.7rem .8rem;font-family:inherit;font-size:.88rem;line-height:1.45;resize:vertical}' +
    '#anim-modal textarea:disabled{opacity:.55}' +
    '#anim-modal .am-ai-row{display:flex;align-items:center;gap:.6rem;margin-top:.4rem;font-size:.78rem;color:var(--muted,#9a978f)}' +
    '#anim-modal .am-ai-row button{background:none;border:1px solid var(--line-2,rgba(255,255,255,.18));border-radius:8px;color:var(--ink,#e8e6e1);font-size:.75rem;padding:.3rem .6rem;cursor:pointer;font-family:inherit}' +
    '#anim-modal .am-spin{width:14px;height:14px;border:2px solid var(--line-2,rgba(255,255,255,.18));border-top-color:var(--accent,#9d7aff);border-radius:50%;animation:am-spin 1s linear infinite;flex-shrink:0}' +
    '@keyframes am-spin{to{transform:rotate(360deg)}}' +
    '#anim-modal details{margin-top:1rem;border:1px solid var(--line,rgba(255,255,255,.1));border-radius:10px;padding:.6rem .8rem}' +
    '#anim-modal summary{cursor:pointer;font-size:.78rem;font-weight:600;color:var(--muted,#9a978f)}' +
    '#anim-modal .am-rules{font-size:.78rem;color:var(--muted,#9a978f);line-height:1.5;margin-top:.5rem;white-space:pre-wrap}' +
    '#anim-modal .am-loop{display:flex;align-items:center;gap:.45rem;margin-top:1rem;font-size:.83rem;cursor:pointer}' +
    '#anim-modal .am-foot{display:flex;justify-content:flex-end;gap:.6rem;margin-top:1.3rem}' +
    '#anim-modal .am-btn{font-size:.88rem;font-weight:600;padding:.65rem 1.2rem;border-radius:10px;border:none;cursor:pointer;font-family:inherit}' +
    '#anim-modal .am-btn.primary{background:var(--accent,#9d7aff);color:#fff}' +
    '#anim-modal .am-btn.ghost{background:transparent;color:var(--ink,#e8e6e1);border:1px solid var(--line-2,rgba(255,255,255,.18))}' +
    '#anim-modal .am-btn:disabled{opacity:.5;cursor:default}' +
    '#anim-modal .am-err{color:#e08a7a;font-size:.8rem;margin-top:.6rem;display:none}';

  var HTML =
    '<div class="am-box">' +
    '<h3>Animate this image</h3>' +
    '<p class="am-sub">A short clip with subtle motion — only things already in the frame move, ' +
    'nothing new appears. Your product and words stay put.</p>' +
    '<label class="am-l" for="am-text">What should move (edit freely)</label>' +
    '<textarea id="am-text" placeholder="e.g. The lavender stems sway gently in a soft breeze. The window light warms and drifts a touch."></textarea>' +
    '<div class="am-ai-row">' +
    '<span class="am-spin" id="am-spin" style="display:none"></span>' +
    '<span id="am-ai-note"></span>' +
    '<button type="button" id="am-suggest">✦ Ask AI to draft it</button>' +
    '</div>' +
    '<details><summary>House rules — always applied, so results stay on-brand</summary>' +
    '<div class="am-rules" id="am-rules"></div></details>' +
    '<label class="am-loop"><input type="checkbox" id="am-loop"> Seamless loop (clip starts and ends on the exact same frame)</label>' +
    '<p class="am-err" id="am-err"></p>' +
    '<div class="am-foot">' +
    '<button type="button" class="am-btn ghost" id="am-cancel">Cancel</button>' +
    '<button type="button" class="am-btn primary" id="am-go">✦ Animate</button>' +
    '</div>' +
    '</div>';

  var root = null;

  function ensureDom() {
    if (root) return root;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    root = document.createElement('div');
    root.id = 'anim-modal';
    root.innerHTML = HTML;
    document.body.appendChild(root);
    return root;
  }

  function open(opts) {
    var el = ensureDom();
    var text = el.querySelector('#am-text');
    var spin = el.querySelector('#am-spin');
    var aiNote = el.querySelector('#am-ai-note');
    var suggestBtn = el.querySelector('#am-suggest');
    var loopCb = el.querySelector('#am-loop');
    var err = el.querySelector('#am-err');
    var go = el.querySelector('#am-go');
    var cancel = el.querySelector('#am-cancel');

    text.value = opts.motionText || '';
    loopCb.checked = opts.loop !== false;
    el.querySelector('#am-rules').textContent = opts.guardrails || '';
    go.textContent = opts.submitLabel || '✦ Animate';
    err.style.display = 'none';
    aiNote.textContent = '';

    function setBusy(b, note) {
      spin.style.display = b ? '' : 'none';
      aiNote.textContent = note || '';
      suggestBtn.disabled = b;
      go.disabled = b;
    }

    async function draft() {
      if (!opts.suggest) return;
      setBusy(true, 'Claude is looking at your image…');
      text.disabled = true;
      try {
        var s = await opts.suggest();
        text.value = s;
        aiNote.textContent = 'Drafted by AI from your image — edit anything.';
      } catch (e) {
        aiNote.textContent = 'AI draft failed — describe the motion yourself.';
      } finally {
        text.disabled = false;
        setBusy(false, aiNote.textContent);
      }
    }

    suggestBtn.onclick = draft;
    cancel.onclick = function () { el.classList.remove('open'); };
    el.onclick = function (ev) { if (ev.target === el) el.classList.remove('open'); };
    go.onclick = async function () {
      var motion = text.value.trim();
      if (!motion) { err.textContent = 'Describe the motion first (or ask AI to draft it).'; err.style.display = ''; return; }
      err.style.display = 'none';
      go.disabled = true; go.textContent = 'Sending…';
      try {
        await opts.onSubmit({ motionText: motion, loop: loopCb.checked });
        el.classList.remove('open');
      } catch (e) {
        err.textContent = (e && e.message) || String(e);
        err.style.display = '';
      } finally {
        go.disabled = false; go.textContent = opts.submitLabel || '✦ Animate';
      }
    };

    el.classList.add('open');
    // No auto-draft (Owner call, 2026-07-16). Let the user write what they
    // want to see first; "✦ Ask AI to draft it" pulls an AI draft on demand
    // and, if the user has typed something, still replaces it (explicit
    // click = explicit consent). Prefilled opens (Review edit) keep their
    // existing text.
  }

  window.AnimateModal = { open: open };
})();
