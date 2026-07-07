/* Tolerance Studio — case study interactions (shared by every client page) */
(function () {
  // Before/after slider: any .cs-ba with a range input + .after layer
  document.querySelectorAll(".cs-ba").forEach(function (ba) {
    var range = ba.querySelector("input[type=range]");
    var after = ba.querySelector(".after");
    var handle = ba.querySelector(".handle");
    if (!range || !after) return;
    function set(v) {
      after.style.clipPath = "inset(0 0 0 " + v + "%)";
      if (handle) handle.style.left = v + "%";
    }
    range.addEventListener("input", function () { set(range.value); });
    set(range.value);
  });

  // Scroll reveal
  var els = document.querySelectorAll(".cs-reveal");
  if (!("IntersectionObserver" in window) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    els.forEach(function (el) { el.classList.add("in"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.12 });
  els.forEach(function (el) { io.observe(el); });
})();
