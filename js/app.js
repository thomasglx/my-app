/* MyApp shell: first-launch setup, navigation between sections. */
(() => {
  const $ = id => document.getElementById(id);

  const SECTIONS = { offers: () => Offers.show(), networking: () => Networking.show(location.hash.split("/")[1]) };
  const current = () => { const k = location.hash.slice(1).split("/")[0]; return k in SECTIONS ? k : "offers"; };

  async function start() {
    const preview = !!window.__MYAPP_PREVIEW__;
    if (!preview && !GH.getToken()) return showSetup();
    const sec = current();
    $("setup").hidden = true; $("btn-disconnect").hidden = preview;
    Object.keys(SECTIONS).forEach(k => { $(k).hidden = k !== sec; });
    document.querySelectorAll(".nav-item").forEach(a => a.classList.toggle("active", a.dataset.section === sec));
    $("nav-sub").classList.toggle("open", sec === "networking");
    try { await SECTIONS[sec](); if (sec !== "networking") Networking.load().catch(() => {}); }
    catch (e) {
      if (e.status === 401 || e.status === 403) { GH.setToken(null); return showSetup(e.message); }
      $(current() === "networking" ? "net-body" : "list").innerHTML = `<div class="empty error">Couldn't load your offers: ${String(e.message).replace(/</g, "&lt;")}</div>`;
    }
  }

  function showSetup(msg) {
    $("offers").hidden = true; $("networking").hidden = true; $("setup").hidden = false; $("btn-disconnect").hidden = true;
    $("setup-error").textContent = msg || "";
  }

  $("setup-form").addEventListener("submit", e => {
    e.preventDefault();
    GH.setToken($("token").value.trim());
    $("token").value = "";
    start();
  });
  $("btn-disconnect").addEventListener("click", () => {
    if (confirm("Remove your access key from this browser?")) { GH.setToken(null); showSetup(); }
  });
  $("btn-refresh").addEventListener("click", start);
  $("btn-net-refresh").addEventListener("click", () => Networking.refresh());
  window.addEventListener("hashchange", start);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && GH.getToken()) start(); });

  start();
})();
