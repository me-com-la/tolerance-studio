/* Tolerance Studio — in-app product switcher.
 *
 * Turns the static ".brand" label in every app topbar (Standard app/ and
 * Pro pro/ pages) into a dropdown: switch between Standard, Pro and Full
 * Service (coming soon), plus Account and Log out. Injected client-side so
 * the 16 app pages don't each carry the markup.
 *
 * Load AFTER supabase-js + lib/supabase.js and ../assets/auth-bridge.js
 * (logout uses tsSignOutEverywhere).
 */
(function () {
  var brand = document.querySelector('.topbar .brand');
  if (!brand) return;

  var isPro = location.pathname.indexOf('/pro/') !== -1;
  var css =
    '.ts-switch{position:relative;display:inline-flex;align-items:center;gap:.45rem;cursor:pointer;user-select:none}' +
    '.ts-switch .caret{font-size:.55rem;opacity:.55;transition:transform .15s}' +
    '.ts-switch.open .caret{transform:rotate(180deg)}' +
    '.ts-switch-menu{position:absolute;top:calc(100% + .6rem);left:0;min-width:200px;background:#fff;border:1px solid rgba(17,16,20,.12);border-radius:12px;box-shadow:0 12px 32px rgba(17,16,20,.14);padding:.4rem;display:none;flex-direction:column;z-index:99}' +
    '.ts-switch.open .ts-switch-menu{display:flex}' +
    '.ts-switch-menu a{display:flex;justify-content:space-between;align-items:center;gap:.8rem;padding:.5rem .7rem;border-radius:8px;font-size:.85rem;text-decoration:none;color:#5d5b57;white-space:nowrap;font-family:"IBM Plex Sans",system-ui,sans-serif;text-transform:none;letter-spacing:0;font-weight:400}' +
    '.ts-switch-menu a:hover{background:#eceae6;color:#111014}' +
    '.ts-switch-menu a.on{color:#7a2a14;background:#fbeae3}' +
    '.ts-switch-menu .soon{font-family:"IBM Plex Mono",monospace;font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:#9a988f}' +
    '.ts-switch-menu hr{border:none;border-top:1px solid rgba(17,16,20,.09);margin:.3rem .2rem}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  brand.classList.add('ts-switch');
  brand.setAttribute('role', 'button');
  brand.setAttribute('aria-haspopup', 'true');
  brand.insertAdjacentHTML('beforeend',
    ' <span class="caret">▾</span>' +
    '<div class="ts-switch-menu">' +
      '<a href="../app/2-project-list.html" class="' + (isPro ? '' : 'on') + '">Standard</a>' +
      '<a href="../pro/2-project-list.html" class="' + (isPro ? 'on' : '') + '">Pro</a>' +
      '<a href="../full-service.html">Full Service <span class="soon">Coming soon</span></a>' +
      '<hr>' +
      '<a href="../account.html">Account</a>' +
      '<a href="#" id="ts-switch-logout">Log out</a>' +
    '</div>');

  brand.addEventListener('click', function (e) {
    if (e.target.closest('.ts-switch-menu a')) return; // let links act
    brand.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    if (!brand.contains(e.target)) brand.classList.remove('open');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') brand.classList.remove('open');
  });
  var lo = document.getElementById('ts-switch-logout');
  if (lo) lo.addEventListener('click', async function (e) {
    e.preventDefault();
    if (window.tsSignOutEverywhere) await window.tsSignOutEverywhere();
    location.href = '../index.html';
  });
})();
