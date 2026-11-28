/* MyApp shell: first-launch setup, navigation between sections. */
(() => {
  const $ = id => document.getElementById(id);

  const SECTIONS = { offers: () => Offers.show(), networking: () => Networking.show(location.hash.split("/")[1]) };
  const current = () => { const k = location.hash.slice(1).split("/")[0]; return k in SECTIONS ? k : "offers"; };

  let running = false, lastOk = 0;
  async function start() {
    if (running) return;
    running = true;
    try { await startInner(); } finally { running = false; }
  }
  async function startInner() {
    const preview = !!window.__MYAPP_PREVIEW__;
    if (!preview && !GH.getToken()) return showSetup();
    const sec = current();
    $("setup").hidden = true; $("btn-disconnect").hidden = preview;
    Object.keys(SECTIONS).forEach(k => { $(k).hidden = k !== sec; });
    document.querySelectorAll(".nav-item").forEach(a => a.classList.toggle("active", a.dataset.section === sec));
    $("nav-sub").classList.toggle("open", sec === "networking");
    try { await SECTIONS[sec](); lastOk = Date.now(); if (sec !== "networking") Networking.load().catch(() => {}); }
    catch (e) {
      if (e.status === 401 || e.status === 403) { GH.setToken(null); return showSetup(e.message); }
      if (sec === "offers" && Offers.hasData()) { return toastMsg("Couldn't refresh (connection). Showing the last data."); }
      $(current() === "networking" ? "net-body" : "list").innerHTML = `<div class="empty error">Couldn't load ${current() === "networking" ? "Networking" : "your offers"}: ${String(e.message).replace(/</g, "&lt;")}</div>`;
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
  /* Refresh buttons show what happened: spinning while loading, then "Updated" / "Up to date" / "Failed" + the time. */
  const hhmm = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  async function doRefresh(btn, sig, fn) {
    if (btn.classList.contains("busy")) return;
    const before = sig();
    btn.className = "btn ghost refresh busy"; btn.innerHTML = `<span class="spin">↻</span> Refreshing…`;
    let label, cls, msg;
    try {
      await Promise.all([fn(), new Promise(r => setTimeout(r, 600))]); // spinner visible at least 0.6 s
      const changed = sig() !== before;
      label = changed ? "✓ Updated" : "✓ Up to date"; cls = "ok";
      msg = changed ? "Refreshed: new data loaded" : "Checked GitHub: nothing new since the last load";
    } catch (e) {
      label = "⚠ Failed"; cls = "bad"; msg = "Refresh failed: " + (e.message || "connection problem") + ". The data shown is the last one loaded.";
      if (e.status === 401 || e.status === 403) { GH.setToken(null); showSetup(e.message); }
    }
    btn.className = "btn ghost refresh " + cls; btn.innerHTML = `${label} <span class="rtime">${hhmm()}</span>`;
    toastMsg(msg, cls === "ok");
    setTimeout(() => { btn.className = "btn ghost refresh"; btn.innerHTML = `↻ Refresh <span class="rtime">${label.includes("Failed") ? "last try failed" : "checked " + hhmm()}</span>`; }, 3500);
  }
  $("btn-refresh").addEventListener("click", e => doRefresh(e.currentTarget, Offers.signature, () => Offers.show()));
  $("btn-net-refresh").addEventListener("click", e => doRefresh(e.currentTarget, Networking.signature, () => Networking.refresh()));
  window.addEventListener("hashchange", start);
  // Refresh when coming back to the app, at most every 2 minutes
  document.addEventListener("visibilitychange", () => { if (!document.hidden && GH.getToken() && Date.now() - lastOk > 120000) start(); });
  function toastMsg(m, ok) { const t = $("toast"); t.textContent = m; t.className = "toast " + (ok ? "ok" : "bad"); t.hidden = false; clearTimeout(toastMsg.t); toastMsg.t = setTimeout(() => (t.hidden = true), 4000); }

  start();
})();
