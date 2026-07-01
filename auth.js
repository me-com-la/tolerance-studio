(async function () {
  const STORAGE_KEY = 'rapp_auth_ok';
  const AUTH_ENDPOINT = 'https://chdfupqkxlcarygopmof.supabase.co/functions/v1/rapp-auth';

  if (sessionStorage.getItem(STORAGE_KEY) === '1') return;

  // Hide page content until password check passes
  document.documentElement.style.visibility = 'hidden';

  window.addEventListener('DOMContentLoaded', () => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:#111;color:#fff;display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;' +
      'font-family:sans-serif;z-index:99999;visibility:visible;';
    overlay.innerHTML = `
      <form id="auth-form" style="text-align:center;">
        <p style="margin-bottom:12px;">Enter password</p>
        <input type="password" id="auth-pass" autofocus
          style="padding:8px;font-size:16px;border-radius:4px;border:1px solid #555;">
        <button type="submit" style="padding:8px 16px;margin-left:8px;">Go</button>
        <p id="auth-err" style="color:#f66;display:none;margin-top:10px;">Wrong password</p>
      </form>`;
    document.body.appendChild(overlay);
    document.documentElement.style.visibility = 'visible';
    document.body.style.overflow = 'hidden';

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = document.getElementById('auth-pass').value;
      const errEl = document.getElementById('auth-err');
      errEl.style.display = 'none';

      try {
        const res = await fetch(AUTH_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: val }),
        });
        const { ok } = await res.json();

        if (ok) {
          sessionStorage.setItem(STORAGE_KEY, '1');
          overlay.remove();
          document.body.style.overflow = '';
        } else {
          errEl.textContent = 'Wrong password';
          errEl.style.display = 'block';
        }
      } catch (_err) {
        errEl.textContent = 'Could not reach auth server, try again';
        errEl.style.display = 'block';
      }
    });
  });
})();
