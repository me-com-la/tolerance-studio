/* Tolerance Studio — one login for both backends.
 *
 * Standard runs on the main Supabase project, Pro on its own separate one
 * (pixel-lock fork). Sessions can't be shared across projects, so this
 * bridge signs the user into BOTH at login/signup time; each supabase-js
 * client persists its own session in localStorage under its project-ref
 * key, so the Pro app's pages find theirs already waiting.
 *
 * Requires the supabase-js UMD script to be loaded first (window.supabase).
 * All Pro-side work is best-effort: if it fails, Standard still works and
 * the Pro app just asks for the same email/password once.
 */
(function () {
  var MAIN_REF = 'mqgfosfadmmiqlvuvbcy';
  var PRO_REF = 'nfvcuidghyklnyixcqrw';
  var PRO_URL = 'https://' + PRO_REF + '.supabase.co';
  var PRO_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5mdmN1aWRnaHlrbG55aXhjcXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNzkxNzIsImV4cCI6MjA5ODk1NTE3Mn0.6AvCWkTjPr_zHoXB2rQtkq-BetQyHmBpJe9Yyo_1n7I';

  var proClient = null;
  function pro() {
    if (!proClient && window.supabase) proClient = window.supabase.createClient(PRO_URL, PRO_ANON);
    return proClient;
  }

  // Sign into the Pro project with the same credentials; if the account
  // doesn't exist there yet (created before dual-signup), create it.
  window.tsEnsureProSession = async function (email, password) {
    try {
      var p = pro();
      if (!p) return;
      var r = await p.auth.signInWithPassword({ email: email, password: password });
      if (r.error) await p.auth.signUp({ email: email, password: password });
    } catch (e) { /* best-effort */ }
  };

  // Sign out of both projects. Works even on pages that only have one
  // client loaded — clears the other project's stored session directly.
  window.tsSignOutEverywhere = async function () {
    try { if (window.sb) await window.sb.auth.signOut(); } catch (e) {}
    try { var p = pro(); if (p) await p.auth.signOut(); } catch (e) {}
    try {
      localStorage.removeItem('sb-' + MAIN_REF + '-auth-token');
      localStorage.removeItem('sb-' + PRO_REF + '-auth-token');
    } catch (e) {}
  };

  // Change the password on both projects. Returns '' on full success, or a
  // human-readable note about what didn't update.
  window.tsChangePasswordEverywhere = async function (newPassword) {
    var r = await window.sb.auth.updateUser({ password: newPassword });
    if (r.error) return r.error.message;
    try {
      var p = pro();
      if (p) {
        var s = await p.auth.getSession();
        if (s.data.session) {
          var pr = await p.auth.updateUser({ password: newPassword });
          if (pr.error) return 'Updated, but the Pro app password could not be changed: ' + pr.error.message;
        } else {
          return 'Updated. Pro app: not signed in there, so its password is unchanged — log out and back in once to re-sync.';
        }
      }
    } catch (e) { /* best-effort */ }
    return '';
  };
})();
