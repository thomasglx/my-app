/* MyOffers section: reads export/offers.json, shows offer blocks, writes manual changes to state/overrides.json */
const Offers = (() => {
  const EXPORT = "export/offers.json", OVERRIDES = "state/overrides.json";
  const STALE_HOURS = 24;

  const STATUS = {
    apply:          { label: "Apply",          cls: "st-apply" },
    applied:        { label: "Applied",        cls: "st-applied" },
    online_test:    { label: "Online test",    cls: "st-test" },
    interview:      { label: "Interview",      cls: "st-interview" },
    offer:          { label: "Offer 🎉",       cls: "st-offer" },
    rejected:       { label: "Rejected",       cls: "st-rejected" },
    not_applicable: { label: "Not applicable", cls: "st-na" },
    closed:         { label: "Closed",         cls: "st-closed" },
  };
  const TABS = [
    { id: "todo",     label: "To apply",    match: s => s === "apply" },
    { id: "progress", label: "In progress", match: s => ["applied", "online_test", "interview", "offer"].includes(s) },
    { id: "done",     label: "Closed",      match: s => ["rejected", "not_applicable", "closed"].includes(s) },
    { id: "all",      label: "All",         match: () => true },
  ];
  const BANDS = { A: "Equity & buy-side", B: "Credit & fixed income", C: "Deals & other", D: "Private banking", E: "Risk" };
  const BAND_RANGE = { A: "P1–P2", B: "P3–P4", C: "P5–P6", D: "P7", E: "P8" };
  const SOURCE_LABEL = { gmail: "Gmail", manual: "Set by you", tracker: "Your tracker", discord: "Discord ✅", default: "MyOffers bot" };

  const state = { exp: null, overrides: {}, tab: "todo", bands: new Set(), market: "", q: "", top: false };
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------ data
  async function load() {
    const injected = window.__MYAPP_PREVIEW__; // local preview only, never in the published app
    if (injected) { state.exp = injected.exp; state.overrides = injected.overrides || {}; return; }
    const [exp, ov] = await Promise.all([GH.readJson(EXPORT), GH.readJson(OVERRIDES)]);
    if (!exp) throw new Error("export/offers.json not found in MyOffers yet.");
    if ((exp.schema_version || 1) < 3) console.warn("MyOffers export is an older version: priorities are estimated, no actions.");
    state.exp = exp; state.overrides = ov || {};
  }

  /* What to display for one offer: the bot's export, plus manual changes not yet seen by the bot. */
  function view(o) {
    const ov = state.overrides[o.offer_id] || {};
    const nm = (state.overrides._names || {})[o.offer_id] || {};
    const v = { ...o, company: nm.company || o.company, title: nm.title || o.title, pending: false };
    if (ov.status && ov.set_at && ov.set_at > (state.exp.generated_at || "") && ov.status !== o.status) {
      Object.assign(v, { status: ov.status, status_source: "manual", status_at: ov.set_at.slice(0, 10),
                         status_evidence: "Set manually in the app", pending: true });
    }
    if (!v.level) { // older data without priorities: estimate from the role family
      v.level = { 1: 2, 2: 3, 3: 5, 4: 7, 5: 6, 6: 8 }[v.family] || 6;
      v.band = { 1: "A", 2: "A", 3: "B", 4: "B", 5: "C", 6: "C", 7: "D", 8: "E" }[v.level];
    }
    v.review = (v.status_evidence || "").startsWith("REVIEW:");
    return v;
  }

  /* Save under a section of overrides.json ("_names", "_actions") */
  async function saveIn(section, id, value, label) {
    const prev = (state.overrides[section] || {})[id];
    state.overrides[section] = { ...(state.overrides[section] || {}), [id]: value };
    render();
    if (window.__MYAPP_PREVIEW__) return toast("Preview: not saved");
    try {
      await GH.updateJson(OVERRIDES, data => ({ ...data, [section]: { ...(data[section] || {}), [id]: value } }), `MyApp: ${label}`);
      toast("Saved ✓");
    } catch (e) {
      if (prev) state.overrides[section][id] = prev; else delete state.overrides[section][id];
      render(); toast("Not saved: " + e.message, true);
    }
  }

  async function save(offerId, patch, label) {
    const set_at = new Date().toISOString();
    const prev = state.overrides[offerId];
    state.overrides[offerId] = { ...(prev || {}), ...patch, set_at };
    render();
    if (window.__MYAPP_PREVIEW__) return toast("Preview: not saved");
    try {
      await GH.updateJson(OVERRIDES, data => ({ ...data, [offerId]: { ...(data[offerId] || {}), ...patch, set_at } }),
                          `MyApp: ${label}`);
      toast("Saved ✓");
    } catch (e) {
      if (prev) state.overrides[offerId] = prev; else delete state.overrides[offerId];
      render(); toast("Not saved: " + e.message, true);
    }
  }

  // ------------------------------------------------------------ helpers
  const fmtDate = iso => {
    if (!iso) return "";
    const d = new Date(iso.length <= 10 ? iso + "T12:00" : iso);
    return isNaN(d) ? iso.slice(0, 10) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const fmtDateTime = iso => {
    const d = new Date(iso); if (isNaN(d)) return iso || "?";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " +
           d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };
  const hoursSince = iso => (Date.now() - new Date(iso).getTime()) / 3.6e6;
  const sourceName = s => (s || "").replace(/^Career page · /, "").replace(/ · .*$/, "")
    .replace("Welcome to the Jungle", "WTTJ").replace(/^gmail$/, "Gmail").replace(/^tracker$/, "Tracker");
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
  // Display-only clean-up of noisy titles/locations coming from e-mail alerts
  function cleanTitle(t, company) {
    t = String(t || "");
    const c = (company || "").trim();
    if (c.length > 2) { const i = t.toLowerCase().indexOf(c.toLowerCase()); if (i > 12) t = t.slice(0, i); }
    return t.replace(/\s+·.*$/, "").replace(/\s+(Actively recruiting|Be an early applicant).*$/i, "").trim() || String(company || "");
  }
  const cleanLoc = l => String(l || "").replace(/\s*\d+\s+connections?.*$/i, "").replace(/\s+(Actively recruiting|Be an early applicant|Promoted).*$/i, "").replace(/^(.+?), \1(, \1)?$/, "$1").trim();
  function viaLabel(v) {
    const h = hostOf(v.apply_url);
    if (!h) return "";
    if (h.includes("welcometothejungle")) return "via WTTJ";
    if (h.includes("linkedin") || h.includes("lnkd.in")) return "via LinkedIn";
    if (h.includes("jobteaser")) return "via JobTeaser";
    return "firm's site";
  }

  // ------------------------------------------------------------ render
  function filtered() {
    const tab = TABS.find(t => t.id === state.tab);
    const q = state.q.toLowerCase();
    return state.exp.offers.map(view).filter(v =>
      tab.match(v.status) &&
      (!state.bands.size || state.bands.has(v.band)) &&
      (!state.market || v.market === state.market) &&
      (!state.top || v.tier === 1) &&
      (!q || (v.company + " " + v.title + " " + v.location).toLowerCase().includes(q)));
  }

  function renderHead() {
    const e = state.exp, h = hoursSince(e.last_successful_run || e.generated_at);
    $("freshness").innerHTML = `Updated ${esc(fmtDateTime(e.last_successful_run || e.generated_at))}` +
      (e.sources_ok != null ? ` · ${e.sources_ok} sources read · ${e.sources_failed} failed` : "");
    let b = "";
    if (h > STALE_HOURS) b += `<div class="banner red">⚠️ No update from the MyOffers bot for ${Math.floor(h)} h. ` +
      `Check Discord for an alert, or the Actions tab of the MyOffers repo on GitHub.</div>`;
    (e.alerts || []).forEach(a => (b += `<div class="banner amber">⚠️ ${esc(a)}</div>`));
    $("banners").innerHTML = b;
    $("freshness").classList.toggle("stale", h > STALE_HOURS);
  }

  function renderToolbar() {
    const all = state.exp.offers.map(view);
    $("tabs").innerHTML = TABS.map(t => {
      const n = all.filter(v => t.match(v.status)).length;
      return `<button class="tab ${t.id === state.tab ? "on" : ""}" data-tab="${t.id}">${t.label}<span>${n}</span></button>`;
    }).join("");
    $("band-filter").innerHTML = Object.entries(BANDS).map(([b, name]) =>
      `<button class="band-chip ${state.bands.has(b) ? "on" : ""}" data-band="${b}">${name} <i>${BAND_RANGE[b]}</i></button>`).join("");
    const markets = [...new Set(all.map(v => v.market).filter(m => m && m !== "?"))].sort();
    const sel = $("market");
    if (sel.options.length !== markets.length + 1) {
      sel.innerHTML = `<option value="">All locations</option>` + markets.map(m => `<option>${esc(m)}</option>`).join("");
      sel.value = state.market;
    }
    $("nav-count").textContent = all.filter(v => v.status === "apply").length || "";
  }

  function card(v) {
    const st = STATUS[v.status] || STATUS.apply;
    const isNew = v.status === "apply" && hoursSince(v.first_seen) < 48;
    const posted = /^\d{4}-\d{2}-\d{2}/.test(v.posted_at || "") ? v.posted_at : "";
    const when = v.status === "apply" ? (posted ? `posted ${fmtDate(posted)}` : `found ${fmtDate(v.first_seen)}`)
      : `${st.label.replace(" 🎉", "").toLowerCase()} ${fmtDate(v.status_at || v.first_seen)}`;
    const loc = cleanLoc(v.location) || (v.market && v.market !== "?" ? v.market : "");
    const via = viaLabel(v);
    const options = Object.entries(STATUS).map(([k, s]) =>
      `<option value="${k}" ${k === v.status ? "selected" : ""}>${s.label}</option>`).join("");
    return `
    <article class="card lvl-${esc(v.level)} ${st.cls}-card" data-id="${esc(v.offer_id)}">
      <div class="card-top">
        <span class="prio lvl-${esc(v.level)}" title="${esc((v.priority_label || "").replace(/^[A-E]\d · /, ""))}">P${esc(v.level)}</span>
        ${v.tier === 1 ? `<span class="tag star" title="Top firm">★ Top firm</span>` : ""}
        ${isNew ? `<span class="tag new">New</span>` : ""}
        ${v.republished ? `<span class="tag" title="Republished">🔁</span>` : ""}
        ${v.review ? `<span class="tag review">Needs review</span>` : ""}
        <button class="icon-btn edit" title="Edit firm / role name" data-edit="${esc(v.offer_id)}">✎</button>
      </div>
      <div class="company">${esc(v.company || "Unknown firm")}</div>
      <div class="title">${esc(cleanTitle(v.title, v.company))}</div>
      <div class="meta">${[loc, when, v.apply_url ? via : ""].filter(Boolean).map(esc).join(" · ")}</div>
      <div class="card-bottom">
        <select class="status-pill ${st.cls}" data-status="${esc(v.offer_id)}" aria-label="Status (click to change)">${options}</select>
        <span class="info" tabindex="0" data-tip="${esc(v.offer_id)}" aria-label="Where this status comes from" title="${v.pending ? "Saved, syncing at the next bot run" : ""}">?</span>
        <span></span>
        <span class="right">${v.apply_url ? `<a class="btn open" href="${esc(v.apply_url)}" target="_blank" rel="noopener">Open offer ↗</a>` : ""}</span>
      </div>
    </article>`;
  }

  function renderList() {
    const items = filtered();
    if (!items.length) { $("list").innerHTML = `<div class="empty">Nothing here.</div>`; return; }
    let html = "", band = null;
    for (const v of items) {
      if (v.band !== band) {
        if (band !== null) html += `</div>`;
        band = v.band;
        const n = items.filter(x => x.band === band).length;
        html += `<h2 class="band-head">${esc(BANDS[band] || "")}<span class="range">${BAND_RANGE[band] || ""}</span>` +
                `<span class="count">${n}</span></h2><div class="grid">`;
      }
      html += card(v);
    }
    $("list").innerHTML = html + `</div>`;
  }

  // ------------------------------------------------------------ actions (test, HireVue, assessment centre, interview, offer)
  function openActions() {
    const done = state.overrides._actions || {};
    return (state.exp.actions || []).filter(a => !a.done && !(done[a.action_id] || {}).done);
  }
  function renderActions() {
    const acts = openActions();
    $("nav-actions").textContent = acts.length || "";
    if (!acts.length) { $("actions").innerHTML = ""; return; }
    $("actions").innerHTML = `<h2 class="actions-head">Action needed<span class="count">${acts.length}</span></h2>` +
      `<div class="actions-grid">` + acts.map(a => {
        let dl = `<span class="deadline none">No deadline found, check the e-mail</span>`;
        if (a.deadline) {
          const h = (new Date(a.deadline) - Date.now()) / 3.6e6;
          const left = h < 0 ? "deadline passed" : h < 24 ? `${Math.max(1, Math.round(h))} h left` : `${Math.floor(h / 24)} day${h >= 48 ? "s" : ""} left`;
          dl = `<span class="deadline ${h < 48 ? "urgent" : ""}">Due ${esc(fmtDateTime(a.deadline))} · ${left}</span>`;
        }
        return `<article class="action">
          <div class="action-type">${esc(a.label)}</div>
          <div class="company">${esc(a.company || "Unknown firm")}</div>
          <div class="title">${esc(cleanTitle(a.title, a.company))}</div>
          ${dl}
          <div class="action-btns">
            ${a.email_url ? `<a class="btn ghost" href="${esc(a.email_url)}" target="_blank" rel="noopener">Open e-mail ↗</a>` : ""}
            <button class="btn primary" data-done="${esc(a.action_id)}">Done ✓</button>
          </div>
        </article>`;
      }).join("") + `</div>`;
  }

  function render() { if (!state.exp) return; renderHead(); renderActions(); renderToolbar(); renderList(); }

  // ------------------------------------------------------------ tooltip, toast, events
  function tipHtml(v) {
    const src = SOURCE_LABEL[v.status_source] || v.status_source || "MyOffers bot";
    const ev = (v.status_evidence || "").replace(/^REVIEW:\s*/, "");
    return `<div class="tip-row"><b>Source:</b> ${esc(src)}${v.pending ? " (syncing at the next bot run)" : ""}</div>` +
      (v.status_at ? `<div class="tip-row"><b>Date:</b> ${esc(fmtDate(v.status_at))}</div>` : "") +
      (ev ? `<div class="tip-row">${esc(ev)}</div>` : "") +
      (v.review ? `<div class="tip-row warn">The bot isn't sure which offer this e-mail belongs to. Set the status yourself if it's wrong.</div>` : "") +
      (v.source ? `<div class="tip-row muted">Offer found on ${esc(sourceName(v.source))}</div>` : "");
  }
  function showTip(el) {
    const o = state.exp.offers.find(x => x.offer_id === el.dataset.tip); if (!o) return;
    const t = $("tooltip"); t.innerHTML = tipHtml(view(o)); t.hidden = false;
    const r = el.getBoundingClientRect(), w = t.offsetWidth;
    t.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    t.style.top = (r.bottom + 8 + window.scrollY) + "px";
  }
  function hideTip() { $("tooltip").hidden = true; }

  let toastTimer;
  function toast(msg, bad) {
    const t = $("toast"); t.textContent = msg; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2200);
  }

  function bind() {
    $("actions").addEventListener("click", e => {
      const b = e.target.closest("[data-done]"); if (!b) return;
      const a = (state.exp.actions || []).find(x => x.action_id === b.dataset.done);
      saveIn("_actions", b.dataset.done, { done: true, set_at: new Date().toISOString() }, `${a ? a.company + " " + a.label : "action"} done`);
    });
    $("tabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) { state.tab = b.dataset.tab; render(); } });
    $("band-filter").addEventListener("click", e => {
      const b = e.target.closest("[data-band]"); if (!b) return;
      state.bands.has(b.dataset.band) ? state.bands.delete(b.dataset.band) : state.bands.add(b.dataset.band); render();
    });
    $("search").addEventListener("input", e => { state.q = e.target.value; renderList(); });
    $("market").addEventListener("change", e => { state.market = e.target.value; render(); });
    $("top-only").addEventListener("change", e => { state.top = e.target.checked; render(); });
    $("list").addEventListener("change", e => {
      const s = e.target.closest("[data-status]"); if (!s) return;
      const o = state.exp.offers.find(x => x.offer_id === s.dataset.status);
      save(s.dataset.status, { status: s.value }, `${o ? o.company : ""} → ${STATUS[s.value].label}`);
    });
    $("list").addEventListener("mouseover", e => { const i = e.target.closest("[data-tip]"); if (i) showTip(i); });
    $("list").addEventListener("mouseout", e => { if (e.target.closest("[data-tip]")) hideTip(); });
    $("list").addEventListener("focusin", e => { const i = e.target.closest("[data-tip]"); if (i) showTip(i); });
    $("list").addEventListener("focusout", hideTip);
    $("list").addEventListener("click", e => {
      const i = e.target.closest("[data-tip]"); if (i) { $("tooltip").hidden ? showTip(i) : hideTip(); return; } // tap on iPhone
      const ed = e.target.closest("[data-edit]"); if (ed) openRename(ed.dataset.edit);
    });
    window.addEventListener("scroll", hideTip, { passive: true });
  }

  function openRename(id) {
    const o = state.exp.offers.find(x => x.offer_id === id); if (!o) return;
    const v = view(o), d = $("rename-dialog");
    $("rename-company").value = v.company; $("rename-title").value = v.title;
    d.returnValue = ""; d.showModal();
    d.onclose = () => {
      if (d.returnValue !== "save") return;
      const company = $("rename-company").value.trim(), title = $("rename-title").value.trim();
      if (company === v.company && title === v.title) return;
      saveIn("_names", id, { company, title, set_at: new Date().toISOString() }, `rename ${company}`);
    };
  }

  let bound = false;
  async function show() {
    if (!bound) { bind(); bound = true; }
    if (!state.exp) $("list").innerHTML = `<div class="empty">Loading…</div>`;
    await load();
    render();
  }

  return { show, render, hasData: () => !!state.exp };
})();
