/* Tolerance Studio shared nav — one place to edit navigation for the whole site */
(function () {
  // Marketing site links — stay inline
  var consumer = [
    { href: "index.html", label: "Home" },
    { href: "contact.html", label: "Contact" }
  ];

  // Dropdown categories — each collapses into its own menu, in this order.
  // The "Internal" group (Overview/Brief/Leads/Launch plan/Team/Tech) was
  // removed here for the public launch (2026-07-07) — those pages moved to
  // website/_internal/ and are never pushed to the live site. If you need
  // that dropdown back for local browsing, it's still in git history.
  var dropdowns = [
    {
      label: "Case Study",
      items: [
        { href: "client-toyota.html", label: "Engineering to Image - Toyota" },
        { href: "client-wingstudio.html", label: "Low Resolution to 4K - Wings Studio" },
        { href: "client-kindtail.html", label: "CAD to Image - Kindtail" }
      ]
    }
  ];

  var here = (location.pathname.split("/").pop() || "index.html");
  function link(i) {
    var a = (i.href === here) ? ' class="active"' : '';
    return '<a href="' + i.href + '"' + a + '>' + i.label + '</a>';
  }

  var groupC = consumer.map(link).join("");

  // Dropdown styles, injected so the nav stays self-contained
  var css =
    '.nav-dd{position:relative;display:flex;align-items:center}' +
    '.nav-dd-btn{font-family:inherit;font-size:.82rem;color:var(--ink);opacity:.78;background:none;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:.34rem;padding:0;white-space:nowrap;transition:opacity .2s}' +
    '.nav-dd-btn:hover,.nav-dd-btn.active{opacity:1}' +
    '.nav-dd-btn.active{color:var(--accent-ink)}' +
    '.nav-dd-btn .caret{font-size:.6rem;transition:transform .2s}' +
    '.nav-dd.open .nav-dd-btn .caret{transform:rotate(180deg)}' +
    '.nav-dd-panel{position:absolute;top:calc(100% + .7rem);right:0;min-width:212px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 32px rgba(17,16,20,.14);padding:.45rem;display:none;flex-direction:column;gap:.08rem;z-index:60}' +
    '.nav-dd.open .nav-dd-panel{display:flex}' +
    '.nav-dd-panel a{padding:.5rem .7rem;border-radius:8px;font-size:.86rem;text-decoration:none;color:var(--muted);white-space:nowrap}' +
    '.nav-dd-panel a:hover{background:var(--chip);color:var(--ink)}' +
    '.nav-dd-panel a.active{background:var(--accent-wash);color:var(--accent-ink)}' +
    '.nav-dd-label{display:none}' +
    '@media(max-width:900px){' +
      '.nav-dd{display:block;width:100%}' +
      '.nav-dd-btn{display:none}' +
      '.nav-dd-label{display:block;font-family:\'IBM Plex Sans\',sans-serif;font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:.5rem 0 .1rem}' +
      '.nav-dd-panel{position:static;display:flex;border:none;box-shadow:none;padding:0;min-width:0}' +
      '.nav-dd-panel a{font-size:1rem;padding:.25rem 0;color:var(--ink)}' +
    '}';
  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // Build each dropdown's markup
  function ddHtml(dd, idx) {
    var active = dd.items.some(function (i) { return i.href === here; });
    var btnActive = active ? ' active' : '';
    return (
      '<div class="nav-dd" data-dd="' + idx + '">' +
        '<button class="nav-dd-btn' + btnActive + '" data-ddbtn="' + idx + '" aria-haspopup="true" aria-expanded="false">' +
          dd.label + ' <span class="caret">▾</span></button>' +
        '<span class="nav-dd-label">' + dd.label + '</span>' +
        '<div class="nav-dd-panel">' + dd.items.map(link).join("") + '</div>' +
      '</div>'
    );
  }
  var groupDD = dropdowns.map(ddHtml).join('<span class="nav-sep" aria-hidden="true"></span>');

  // Auth link — session detected synchronously from supabase-js's localStorage
  // key (no CDN load needed just to render the nav). account.html/login.html
  // do the real session check; this only decides which label to show.
  var signedIn = false;
  try { signedIn = !!localStorage.getItem("sb-mqgfosfadmmiqlvuvbcy-auth-token"); } catch (e) {}
  var authLinks = signedIn
    ? [{ href: "account.html", label: "Account" }]
    : [{ href: "login.html", label: "Log in" }, { href: "signup.html", label: "Sign up" }];
  var groupAuth = authLinks.map(link).join("");

  var html =
    '<nav class="nav"><div class="wrap">' +
      '<a class="brand" href="index.html"><img src="images/ts-logo.png" alt="Tolerance Studio" style="height:17px;width:auto;display:block;"><span class="brand-tag">Beta</span></a>' +
      '<button id="navtoggle" aria-label="Menu" class="navtoggle"><span></span><span></span><span></span></button>' +
      '<div class="nav-links" id="navlinks">' +
        '<span class="nav-group">' + groupC + '</span>' +
        '<span class="nav-sep" aria-hidden="true"></span>' +
        groupDD +
        '<span class="nav-sep" aria-hidden="true"></span>' +
        '<span class="nav-group">' + groupAuth + '</span>' +
      '</div>' +
    '</div></nav>';

  var holder = document.createElement("div");
  holder.innerHTML = html;
  document.body.insertBefore(holder.firstChild, document.body.firstChild);

  // Mobile hamburger
  var btn = document.getElementById("navtoggle");
  var links = document.getElementById("navlinks");
  btn.addEventListener("click", function () {
    links.classList.toggle("open");
    btn.classList.toggle("open");
  });

  // Dropdowns (desktop) — multiple, only one open at a time
  var dds = Array.prototype.slice.call(document.querySelectorAll(".nav-dd"));
  function closeAll(except) {
    dds.forEach(function (d) {
      if (d === except) return;
      d.classList.remove("open");
      var b = d.querySelector(".nav-dd-btn");
      if (b) b.setAttribute("aria-expanded", "false");
    });
  }
  dds.forEach(function (d) {
    var b = d.querySelector(".nav-dd-btn");
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = d.classList.toggle("open");
      b.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) closeAll(d);
    });
  });
  document.addEventListener("click", function (e) {
    dds.forEach(function (d) {
      if (!d.contains(e.target)) {
        d.classList.remove("open");
        var b = d.querySelector(".nav-dd-btn");
        if (b) b.setAttribute("aria-expanded", "false");
      }
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAll(null);
  });
})();
