/* MyApp shell: first-launch setup, navigation between sections. */
(() => {
  const $ = id => document.getElementById(id);

  async function start() {
    const preview = !!window.__MYAPP_PREVIEW__;
    if (!preview && !GH.getToken()) return showSetup();
    $("setup").hidden = true; $("offers").hidden = false; $("btn-disconnect").hidden = preview;
    try { await Offers.show(); }
    catch (e) {
      if (e.status === 401 || e.status === 403) { GH.setToken(null); return showSetup(e.message); }
      $("list").innerHTML = `<div class="empty error">Couldn't load your offers: ${String(e.message).replace(/</g, "&lt;")}</div>`;
    }
  }

  function showSetup(msg) {
    $("offers").hidden = true; $("setup").hidden = false; $("btn-disconnect").hidden = true;
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
  document.addEventListener("visibilitychange", () => { if (!document.hidden && GH.getToken()) start(); });

  start();
})();
