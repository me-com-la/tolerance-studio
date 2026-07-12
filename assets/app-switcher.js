/* Tolerance Studio — in-app user menu + shared top chrome.
 *
 * Turns the ".who" element (top-right, "Owner" + avatar placeholder) in
 * every app/ page topbar into a dropdown showing the real signed-in user:
 * Files / Projects / Service (coming soon), Account, Log out. The ".brand"
 * label (top-left) stays static — no dropdown there.
 *
 * One app since the 2026-07-10 merge (render mode lives on the project);
 * the old /pro/ folder is deleted outright (Owner call, same day — no
 * legacy redirects kept; originals in _archive-2026-07-10/pro-app/).
 *
 * Load AFTER supabase-js + lib/supabase.js (logout uses window.sb directly).
 */
(function () {
  var who = document.querySelector('.topbar .who');
  if (!who) return;

  // my-images.html (Files) lives at the repo root, one level up from every
  // app/ page — so link targets need a prefix that depends on where this
  // script is actually running, not a fixed "../" like before.
  var inSubfolder = location.pathname.indexOf('/app/') !== -1;
  var prefix = inSubfolder ? '../' : '';
  var isFullService = location.pathname.indexOf('full-service') !== -1;
  var isAccount = location.pathname.indexOf('account') !== -1;
  var isFiles = !inSubfolder && !isFullService && !isAccount;
  var css =
    '.ts-switch{position:relative;display:inline-flex;align-items:center;gap:.6rem;cursor:pointer;user-select:none}' +
    '.ts-switch .caret{font-size:.55rem;opacity:.55;transition:transform .15s}' +
    '.ts-switch.open .caret{transform:rotate(180deg)}' +
    '.ts-switch-menu{position:absolute;top:calc(100% + .6rem);right:0;min-width:200px;background:#fff;border:1px solid rgba(17,16,20,.12);border-radius:12px;box-shadow:0 12px 32px rgba(17,16,20,.14);padding:.4rem;display:none;flex-direction:column;z-index:99;text-align:left}' +
    '.ts-switch.open .ts-switch-menu{display:flex}' +
    '.ts-switch-menu a{display:flex;justify-content:space-between;align-items:center;gap:.8rem;padding:.5rem .7rem;border-radius:8px;font-size:.85rem;text-decoration:none;color:#5d5b57;white-space:nowrap;font-family:"IBM Plex Sans",system-ui,sans-serif}' +
    '.ts-switch-menu a:hover{background:#eceae6;color:#111014}' +
    '.ts-switch-menu a.on{color:#7a2a14;background:#fbeae3}' +
    '.ts-switch-menu .soon{font-family:"IBM Plex Mono",monospace;font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:#9a988f}' +
    '.ts-switch-menu hr{border:none;border-top:1px solid rgba(17,16,20,.09);margin:.3rem .2rem}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  who.classList.add('ts-switch');
  who.setAttribute('role', 'button');
  who.setAttribute('aria-haspopup', 'true');
  var nameEl = who.querySelector('span');
  var avatarEl = who.querySelector('.avatar');
  if (nameEl) nameEl.textContent = '…';

  who.insertAdjacentHTML('afterbegin',
    '<div class="ts-hamburger" aria-hidden="true"><span></span><span></span><span></span></div>');
  who.insertAdjacentHTML('beforeend',
    '<span class="caret">▾</span>' +
    '<div class="ts-switch-menu">' +
      '<div class="ts-menu-user"><div class="ts-menu-avatar" id="ts-menu-av">O</div><span id="ts-menu-name">…</span></div>' +
      '<hr>' +
      '<a href="' + prefix + 'app/2-project-list.html" class="' + (!isFiles && !isFullService && !isAccount ? 'on' : '') + '">Projects</a>' +
      '<a href="' + prefix + 'my-images.html" class="' + (isFiles ? 'on' : '') + '">Files</a>' +
      '<a href="' + prefix + 'full-service.html" class="' + (isFullService ? 'on' : '') + '">Service <span class="soon">Coming soon</span></a>' +
      '<hr>' +
      '<a href="' + prefix + 'account.html">Account</a>' +
      '<a href="#" id="ts-switch-logout">Log out</a>' +
    '</div>');

  (async function () {
    try {
      var s = await window.sb.auth.getSession();
      var email = s.data.session && s.data.session.user && s.data.session.user.email;
      if (email) {
        var name = email.split('@')[0];
        if (nameEl) nameEl.textContent = name;
        if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();
        var menuName = document.getElementById('ts-menu-name');
        var menuAv = document.getElementById('ts-menu-av');
        if (menuName) menuName.textContent = email;
        if (menuAv) menuAv.textContent = name.charAt(0).toUpperCase();
      }
    } catch (e) { /* leave placeholder */ }
  })();

  who.addEventListener('click', function (e) {
    if (e.target.closest('.ts-switch-menu a')) return; // let links act
    who.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    if (!who.contains(e.target)) who.classList.remove('open');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') who.classList.remove('open');
  });
  var lo = document.getElementById('ts-switch-logout');
  if (lo) lo.addEventListener('click', async function (e) {
    e.preventDefault();
    await window.sb.auth.signOut();
    location.href = prefix + 'index.html';
  });

  // ---- Universal top chrome (2026-07-09) --------------------------------
  // Replaces the old per-page breadcrumbs with one shared treatment so every
  // in-app page matches: (1) brand is the logo + Beta pill,
  // (2) a real main nav (Files / Projects / Service) where the crumbs used to be,
  // (3) the project name shown in its own band above the step rail, fed from
  // the #crumb-proj value each page's init() already writes. Done here, once,
  // rather than in 16 page files (shared-linkage rule, project CLAUDE.md).
  var chromeCss =
    // Main nav = persistent red-underline tabs (promoted from the old
    // per-page .subnav tier-tabs, now removed). The crumbs container stretches
    // to the full topbar height so the active tab's accent underline sits on
    // the topbar's bottom edge, exactly like the subnav did.
    '.topbar .crumbs{display:flex;align-self:stretch;align-items:stretch;gap:.1rem}' +
    '.ts-mainnav{display:inline-flex;align-items:center;padding:0 .95rem;font-size:.9rem;font-weight:600;color:#5d5b57;text-decoration:none;border-bottom:2.5px solid transparent;font-family:"IBM Plex Sans",system-ui,sans-serif}' +
    '.ts-mainnav:hover{color:#111014}' +
    '.ts-mainnav.on{color:#111014;border-bottom-color:#d8502d}' +
    '.ts-projhead{background:#fff;border-bottom:1px solid rgba(17,16,20,.12)}' +
    '.ts-projhead-in{max-width:88rem;margin:0 auto;padding:1.1rem 1.6rem}' +
    '.ts-projhead-in .ts-proj-name{font-family:"Barlow Condensed",sans-serif;font-size:1.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.01em;color:#111014;line-height:1.1}';
  chromeCss += '.ts-hamburger{display:none;flex-direction:column;justify-content:center;gap:4px;width:20px;cursor:pointer}'
  chromeCss += '.ts-hamburger span{display:block;width:20px;height:2px;background:currentColor;border-radius:2px}';
  chromeCss += '.ts-menu-user{display:none;align-items:center;gap:.7rem;padding:.5rem .7rem .4rem}'
  chromeCss += '.ts-menu-avatar{width:28px;height:28px;border-radius:7px;background:var(--accent,#9d7aff);color:#fff;display:flex;align-items:center;justify-content:center;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:.85rem;flex-shrink:0}'
  chromeCss += '.ts-menu-user span{font-size:.85rem;color:#5d5b57;font-family:"IBM Plex Sans",system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
  chromeCss += '@media(max-width:480px){.topbar-in{padding:0 .75rem}.topbar .crumbs{display:none}.ts-hamburger{display:flex}.ts-switch>span:not(.caret),.ts-switch>.avatar{display:none}.ts-switch .caret{display:none}.ts-menu-user{display:flex}}';
  chromeCss += '.pro-dark .ts-switch-menu{background:#1a1820;border-color:rgba(255,255,255,.1);box-shadow:0 12px 32px rgba(0,0,0,.4)}.pro-dark .ts-switch-menu a{color:#9a978f}.pro-dark .ts-switch-menu a:hover{background:#2a2735;color:#e8e6e1}.pro-dark .ts-switch-menu a.on{color:#c4b0ff;background:rgba(157,122,255,.15)}.pro-dark .ts-switch-menu .soon{color:#6b6966}.pro-dark .ts-switch-menu hr{border-top-color:rgba(255,255,255,.08)}';
  chromeCss += '.pro-dark .ts-projhead{background:#1a1820;border-bottom-color:rgba(255,255,255,.1)}.pro-dark .ts-projhead-in .ts-proj-name{color:#e8e6e1}.pro-dark .ts-mainnav{color:#9a978f}.pro-dark .ts-mainnav:hover{color:#e8e6e1}.pro-dark .ts-mainnav.on{color:#e8e6e1;border-bottom-color:#9d7aff}';
  var st2 = document.createElement('style'); st2.textContent = chromeCss; document.head.appendChild(st2);
  document.body.classList.add('pro-dark');

  // (1) Brand: drop the logo image, collapse the label to "TS", and always
  // point it at the Files page (not "whichever app you're in" — the Files
  // page is the one shared home base for the whole app).
  var brand = document.querySelector('.topbar .brand');
  if (brand) {
    brand.innerHTML = '<picture><source srcset="' + prefix + 'images/ts-logo-white-sm.png" media="(max-width:480px)"><img src="' + prefix + 'images/ts-logo_white.png" alt="Tolerance Studio" style="height:15px;width:auto;display:block;"></picture><span style="font-family:\'IBM Plex Mono\',monospace;font-size:.58rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-ink);border:1px solid var(--accent-ink);border-radius:4px;padding:.1rem .35rem;opacity:.85">Beta</span>';
    brand.setAttribute('href', prefix + 'my-images.html');
    brand.style.display = 'flex';
    brand.style.alignItems = 'center';
    brand.style.gap = '.5rem';
    brand.style.textDecoration = 'none';
  }

  // (2) Crumbs -> main nav. Preserve any #crumb-proj / #crumb-client the page
  // JS still writes to (kept hidden) so nothing null-errors. Pages without a
  // crumbs container (e.g. the project list) get one created after the brand.
  var nav = document.querySelector('.topbar .crumbs');
  if (!nav) {
    var tin = document.querySelector('.topbar-in');
    if (tin && brand) { nav = document.createElement('div'); nav.className = 'crumbs'; brand.insertAdjacentElement('afterend', nav); }
  }
  if (nav) {
    var keep = [];
    // #mode-chip (2026-07-10 merge: per-project Scene/Exact render badge) is
    // preserved here, then RELOCATED into the project-name band below — the
    // crumbs container it starts in is replaced by this main nav.
    ['#crumb-proj', '#crumb-client', '#mode-chip'].forEach(function (sel) { var el = nav.querySelector(sel); if (el) keep.push(el); });
    nav.innerHTML =
      '<a class="ts-mainnav' + (!isFiles && !isFullService && !isAccount ? ' on' : '') + '" href="' + prefix + 'app/2-project-list.html">Projects</a>' +
      '<a class="ts-mainnav' + (isFiles ? ' on' : '') + '" href="' + prefix + 'my-images.html">Files</a>' +
      '<a class="ts-mainnav' + (isFullService ? ' on' : '') + '" href="' + prefix + 'full-service.html">Service</a>';
    if (keep.length) {
      var hold = document.createElement('span'); hold.style.display = 'none';
      keep.forEach(function (el) { hold.appendChild(el); });
      nav.appendChild(hold);
    }
  }

  // (3) Project-name band above the step rail. Skip if the page already has
  // its own project header (project view).
  var stepRail = document.querySelector('.rail-wrap');
  var existingHead = document.querySelector('.projhead');
  var projNameEl = null;
  if (existingHead) {
    projNameEl = existingHead.querySelector('#proj-name, .proj-name');
  } else if (stepRail) {
    var band = document.createElement('div');
    band.className = 'ts-projhead';
    band.innerHTML = '<div class="ts-projhead-in"><div class="ts-proj-name" id="proj-name">…</div></div>';
    stepRail.parentNode.insertBefore(band, stepRail);
    projNameEl = band.querySelector('#proj-name');
  }
  if (projNameEl) {
    var src = document.getElementById('crumb-proj');
    var sync = function () {
      var t = src && src.textContent ? src.textContent.trim() : '';
      if (t && t !== '…') projNameEl.textContent = t;
    };
    sync();
    if (src) new MutationObserver(sync).observe(src, { childList: true, characterData: true, subtree: true });
  }

  // Mode chip: pull it out of the hidden crumbs holder and show it beside
  // the project name (the page's own init() fills its text/color class).
  var modeChip = document.getElementById('mode-chip');
  if (modeChip && projNameEl) {
    var nameRow = projNameEl.parentNode;
    if (nameRow) {
      nameRow.style.display = 'flex';
      nameRow.style.alignItems = 'center';
      nameRow.style.gap = '.6rem';
      modeChip.style.display = '';
      nameRow.appendChild(modeChip);
    }
  }
})();
