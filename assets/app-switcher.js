/* Tolerance Studio — in-app product switcher + real user identity.
 *
 * Turns the ".who" element (top-right, "Owner" + avatar placeholder) in
 * every app topbar (Standard app/ and Pro pro/ pages) into a dropdown showing
 * the real signed-in user: Standard / Pro / Full Service (coming soon),
 * Account, Log out. The ".brand" label (top-left) stays static — it only
 * says which app you're in, no dropdown there.
 *
 * Load AFTER supabase-js + lib/supabase.js (logout uses window.sb directly —
 * Standard and Pro share one Supabase project, so there's nothing to bridge).
 */
(function () {
  var who = document.querySelector('.topbar .who');
  if (!who) return;

  var isPro = location.pathname.indexOf('/pro/') !== -1;
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

  who.insertAdjacentHTML('beforeend',
    '<span class="caret">▾</span>' +
    '<div class="ts-switch-menu">' +
      '<a href="../app/2-project-list.html" class="' + (isPro ? '' : 'on') + '">Standard</a>' +
      '<a href="../pro/2-project-list.html" class="' + (isPro ? 'on' : '') + '">Pro</a>' +
      '<a href="../full-service.html">Full Service <span class="soon">Coming soon</span></a>' +
      '<hr>' +
      '<a href="../account.html">Account</a>' +
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
    location.href = '../index.html';
  });
})();
