/* Nucleus product page — progressive enhancement only.
   Without JS the page is complete and the download links point at the
   latest published assets as of this commit. With JS we follow whatever
   GitHub reports as the latest release (so the page updates per release). */
(function () {
  "use strict";

  var REPO = "mockcomic/Nucleus";
  var API = "https://api.github.com/repos/" + REPO + "/releases/latest";

  function mb(bytes) {
    return Math.max(1, Math.round(bytes / (1024 * 1024))) + " MB";
  }

  function setDl(id, asset) {
    var a = document.getElementById(id);
    if (!a) return;
    a.href = asset.browser_download_url;
    var sub = a.querySelector(".btn-sub");
    if (sub) {
      var v = asset.name.replace(/^Nucleus-|-(setup|portable)\.exe$/g, "");
      sub.textContent = "v" + v + " · ~" + mb(asset.size);
    }
  }

  fetch(API, { headers: { Accept: "application/vnd.github+json" } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (rel) {
      (rel.assets || []).forEach(function (asset) {
        if (/-setup\.exe$/i.test(asset.name)) { setDl("dl-setup", asset); setDl("dl-setup-2", asset); }
        if (/-portable\.exe$/i.test(asset.name)) { setDl("dl-portable", asset); }
      });
    })
    .catch(function () { /* keep the static fallback links */ });

  // Star count pill (cosmetic; falls back to the plain "Star" label).
  fetch("https://api.github.com/repos/" + REPO)
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (repo) {
      var n = repo.stargazers_count;
      var el = document.getElementById("stars-n");
      if (el && typeof n === "number") {
        el.textContent = n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
      }
    })
    .catch(function () {});

  // Click-to-play films (keeps the page light: videos load only on demand).
  document.querySelectorAll(".film").forEach(function (fig) {
    function play() {
      if (fig.classList.contains("playing")) return;
      var v = document.createElement("video");
      v.src = fig.getAttribute("data-src");
      v.poster = fig.getAttribute("data-poster") || "";
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      fig.replaceChild(v, fig.querySelector("img"));
      fig.classList.add("playing");
    }
    fig.addEventListener("click", play);
    fig.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(); }
    });
  });

  // Reduced motion: the hero film shouldn't loop on its own.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.querySelectorAll(".hero-media video").forEach(function (v) {
      v.pause();
      v.removeAttribute("autoplay");
      v.controls = true;
    });
  }
})();
