/* Networking: a folder of pages, one per step of the process, plus a person sheet.
   Data: export/networking.json in MyOffers. Manual changes: state/networking_overrides.json. */
const Networking = (() => {
  const DATA = "export/networking.json", OVERRIDES = "state/networking_overrides.json";
  const PAGES = [
    ["today", "Today"], ["firms", "Firms"], ["requests", "Requests"], ["messages", "Messages"],
    ["replies", "Replies"], ["calls", "Calls"], ["followup", "Follow-up"], ["network", "Network"],
  ];
  const state = { d: null, ov: { tasks: {} }, page: "today", q: "", showOld: false, netCat: "A" };
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = iso => { if (!iso) return ""; const x = new Date(iso + "T12:00"); return isNaN(x) ? iso : x.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
  const days = (a, b) => Math.round((new Date(b + "T12:00") - new Date(a + "T12:00")) / 864e5);
  const T = () => state.d.today;
  const peopleUrl = f => f.linkedin ? f.linkedin.replace(/\/$/, "") + "/people/"
    : "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent((f.firm || "").replace(/\b(SA|SAS|S\.A\.|SARL|AG)\b\.?/g, "").trim());
  const searchUrl = name => "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(name);
  const taskStatus = x => state.ov.tasks[x.id]?.status || x.status;
  const statusEn = s => ({ "À faire": "to do", "Fait": "done", "Abandon": "dropped" }[s] || s);
  const C = () => state.d.contacts;

  // ------------------------------------------------------------ data
  async function load() {
    const inj = window.__MYAPP_PREVIEW_NET__;
    if (inj) { state.d = inj; return; }
    const [d, ov] = await Promise.all([GH.readJson(DATA), GH.readJson(OVERRIDES)]);
    if (!d) throw new Error("export/networking.json not found yet.");
    state.d = d; state.ov = Object.assign({ tasks: {} }, ov || {});
  }
  async function markTask(id, status) {
    state.ov.tasks[id] = { status, set_at: new Date().toISOString() }; render();
    if (window.__MYAPP_PREVIEW_NET__) return;
    try { await GH.updateJson(OVERRIDES, d => ({ ...d, tasks: { ...(d.tasks || {}), [id]: state.ov.tasks[id] } }), `MyApp: task ${status}`); }
    catch (e) { delete state.ov.tasks[id]; render(); alert("Not saved: " + e.message); }
  }

  // ------------------------------------------------------------ building blocks
  const card = (title, count, body) => `<section class="net-card">${title ? `<h3>${title}${count !== null && count !== undefined ? `<span class="count">${count}</span>` : ""}</h3>` : ""}${body}</section>`;
  const empty = t => `<div class="empty-s">${t}</div>`;
  const when = due => !due ? "" : due < T() ? `<span class="late">${days(due, T())} d late</span>` : due === T() ? `<span class="due">today</span>` : `<span class="soon">${fmt(due)}</span>`;
  const person = (c, sub) => `<div class="row-main"><div class="row-title"><a class="pname" data-person="${esc(c.id)}">${esc(c.name)}</a> <span class="muted">· ${esc(c.firm || c.title)}</span></div>${sub ? `<div class="row-sub">${sub}</div>` : ""}</div>`;
  const profileBtn = c => `<a class="btn mini ghost" href="${esc(c.linkedin || searchUrl(c.name))}" target="_blank" rel="noopener">Profile ↗</a>`;
  const row = (main, side = "") => `<div class="row">${main}<div class="row-side">${side}</div></div>`;
  const kpi = (label, val, sub = "") => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-val">${val}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  function limits() {
    const L = state.d.limits, left = Math.max(0, Math.min(L.requests_day_max, L.requests_7d_max - L.requests_7d));
    return { L, left, pct: Math.min(100, Math.round(100 * L.requests_7d / L.requests_7d_max)) };
  }

  // ------------------------------------------------------------ pages
  const P = {};

  P.today = () => {
    const { L, left, pct } = limits();
    const n = g => C().filter(x => x.group === g).length;
    const tasks = state.d.tasks.filter(x => taskStatus(x) === "À faire" && x.due && x.due <= T());
    const accepted = C().filter(c => c.group === "accepted"), replies = C().filter(c => c.group === "replied");
    const thanks = C().filter(c => c.stage === "Call done");
    const emails = C().filter(c => c.stage === "Request sent" && c.request_date && days(c.request_date, T()) >= 7);
    const steps = [
      ["firms", "Firms", `${left} connection requests left today`, left],
      ["requests", "Requests", `${emails.length} not accepted: 7+ days`, emails.length],
      ["messages", "Messages", `${accepted.length} accepted to message · daily network messages`, 1],
      ["replies", "Replies", `${replies.length} replies to handle`, replies.length],
      ["calls", "Calls", `${n("call")} calls booked`, n("call")],
      ["followup", "Follow-up", `${tasks.length} tasks due · ${thanks.length} thank-you to send`, tasks.length + thanks.length],
    ];
    return `<div class="kpis">
        <div class="kpi"><div class="kpi-label">Requests, last 7 days</div><div class="kpi-val">${L.requests_7d}<span>/ ${L.requests_7d_max}</span></div>
          <div class="gauge"><i style="width:${pct}%" class="${pct >= 90 ? "hot" : ""}"></i></div><div class="kpi-sub">${left} more allowed today</div></div>
        ${kpi("Waiting for acceptance", n("pending"))}${kpi("Conversations open", n("contacted") + n("replied"))}${kpi("Calls booked", n("call"))}${kpi("Calls done", n("done"))}
      </div>` +
      card("Your day, step by step", null, steps.map(([id, l, t, k], i) => `<a class="step ${k ? "" : "quiet"}" href="#networking/${id}">
        <span class="step-n">${i + 1}</span><span class="step-name">${l}</span><span class="step-text">${t}</span><span class="step-go">Open →</span></a>`).join("")) +
      `<div class="hint center">The detailed layout of Today will be refined later.</div>`;
  };

  P.firms = () => {
    const { L, left } = limits();
    const q = state.q.toLowerCase();
    const outreach = state.d.queue.filter(f => f.status === "In outreach");
    const next = state.d.queue.filter(f => f.status === "To research" && (!q || f.firm.toLowerCase().includes(q))).slice(0, 12);
    const byFirm = id => C().filter(c => c.firm_id === id);
    return `<div class="page-intro">Cold outreach, firm by firm: open the People page, pick 1 senior + 1 junior (no interns), send the requests without a note.</div>
      <div class="kpis three">${kpi("Requests left today", left, `${L.requests_7d}/${L.requests_7d_max} over the last 7 days`)}${kpi("Firms in outreach", outreach.length)}${kpi("Firms in the queue", state.d.queue.filter(f => f.status === "To research").length)}</div>
      <div class="net-grid"><div class="net-col">` +
      card("Next firms to contact", next.length, next.map(f => row(
        `<div class="row-main"><div class="row-title">${esc(f.firm)}</div><div class="row-sub">#${f.rank} · ${esc(f.tier)} · ${esc(f.type)} · ${esc(f.city || f.market)}</div>${f.approach ? `<div class="row-sub ital">${esc(f.approach)}</div>` : ""}</div>`,
        `<a class="btn mini ghost" href="${esc(peopleUrl(f))}" target="_blank" rel="noopener">People ↗</a>`)).join("") || empty("Queue empty.")) +
      `</div><div class="net-col">` +
      card("Firms in outreach", outreach.length, outreach.map(f => {
        const ps = byFirm(f.firm_id);
        return row(`<div class="row-main"><div class="row-title">${esc(f.firm)}</div><div class="row-sub">${ps.length ? ps.map(c => `<a class="pname" data-person="${esc(c.id)}">${esc(c.name)}</a> <span class="stage-chip">${esc(c.stage)}</span>`).join(" · ") : "no contact recorded"}</div></div>`);
      }).join("")) + `</div></div>`;
  };

  P.requests = () => {
    const pend = C().filter(c => c.group === "pending").map(c => ({ c, d: c.request_date ? days(c.request_date, T()) : null }));
    const toEmail = pend.filter(x => x.d !== null && x.d >= 7), waiting = pend.filter(x => x.d === null || x.d < 7);
    const firmsToEmail = {}; toEmail.forEach(x => (firmsToEmail[x.c.firm || "?"] = firmsToEmail[x.c.firm || "?"] || []).push(x.c));
    const emailSent = C().filter(c => c.stage === "Email sent" || c.stage === "Email follow-up sent");
    return `<div class="page-intro">Connection requests waiting for acceptance.</div>
      <div class="net-grid"><div class="net-col">` +
      card("Not accepted: 7+ days", toEmail.length, Object.entries(firmsToEmail).map(([firm, cs]) =>
        `<div class="sub-head">${esc(firm)} <span class="muted">· ${cs.length} ${cs.length > 1 ? "people" : "person"}</span></div>` +
        cs.map(c => row(person(c, `Sent ${fmt(c.request_date)} · ${days(c.request_date, T())} days`), profileBtn(c))).join("")).join("") || empty("Nothing to send.")) +
      `</div><div class="net-col">` +
      card("Waiting: under 7 days", waiting.length, waiting.sort((a, b) => (a.d ?? 99) - (b.d ?? 99)).map(({ c, d }) => row(person(c, `Sent ${fmt(c.request_date)}`), d !== null ? `<span class="soon">day ${d}</span>` : "")).join("") || empty("None.")) +
      `</div></div>`;
  };

  P.messages = () => {
    const acc = C().filter(c => c.group === "accepted");
    const ready = acc.filter(c => !c.accepted_date || days(c.accepted_date, T()) >= 1), tooSoon = acc.filter(c => c.accepted_date && days(c.accepted_date, T()) < 1);
    const fu1All = C().filter(c => c.stage === "DM sent" && c.dm_date && days(c.dm_date, T()) >= 7);
    const fu2All = C().filter(c => c.stage === "DM follow-up sent" && (c.followup_date || c.dm_date) && days(c.followup_date || c.dm_date, T()) >= 7);
    const recent = c => days(c.followup_date || c.dm_date, T()) <= 28;
    const fu1 = fu1All.filter(recent), fu2 = fu2All.filter(recent);
    const oldFu = [...fu1All, ...fu2All].filter(c => !recent(c));
    const cats = { A: "A – ER / buy-side / credit pro", B: "B – IB / PE / markets / wealth pro", C: "C – Student/intern in finance" };
    const net = state.d.network.filter(n => n.status === "To message" && n.messaged !== "Yes");
    const shown = net.filter(n => n.category === cats[state.netCat]);
    return `<div class="page-intro">Who to write to today. First follow-up on LinkedIn, second one by e-mail.</div>
      <div class="net-grid"><div class="net-col">` +
      card("Accepted: first message", ready.length, ready.map(c => row(person(c, `Accepted ${fmt(c.accepted_date)}`), profileBtn(c))).join("") ||
        empty("Nobody new. Acceptances will appear here automatically from your LinkedIn e-mails.")) +
      (tooSoon.length ? card("Accepted today: 1 day", tooSoon.length, tooSoon.map(c => row(person(c, ""))).join("")) : "") +
      card("Follow-up 1 (LinkedIn): 7 days", fu1.length, fu1.map(c => row(person(c, `First message ${fmt(c.dm_date)} · ${days(c.dm_date, T())} days`), profileBtn(c))).join("") || empty("None due.")) +
      card("Follow-up 2 (e-mail): 7 days", fu2.length, fu2.map(c => row(person(c, `LinkedIn follow-up ${fmt(c.followup_date || c.dm_date)}${c.email ? " · " + esc(c.email) : " · e-mail to find"}`), profileBtn(c))).join("") || empty("None due.")) +
      (oldFu.length ? `<button class="link-btn" data-toggle-old>${state.showOld ? "Hide" : "Show"} ${oldFu.length} old follow-ups (over 4 weeks)</button>` +
        (state.showOld ? card("", null, oldFu.map(c => row(person(c, `${esc(c.stage)} · ${fmt(c.followup_date || c.dm_date)}`))).join("")) : "") : "") +
      `</div><div class="net-col">` +
      card("Network: to message", shown.length, `<div class="seg">${Object.keys(cats).map(k => `<button class="seg-b ${state.netCat === k ? "on" : ""}" data-cat="${k}">${esc(cats[k].replace(/^.\s–\s/, ""))} <span>${net.filter(n => n.category === cats[k]).length}</span></button>`).join("")}</div>` +
        shown.slice(0, 15).map(n => row(`<div class="row-main"><div class="row-title">${esc(n.name)}</div><div class="row-sub">${esc(n.headline)}</div></div>`,
          `<a class="btn mini ghost" href="${esc(searchUrl(n.name))}" target="_blank" rel="noopener">Profile ↗</a>`)).join("") +
        (shown.length > 15 ? `<div class="hint">+ ${shown.length - 15} more in Network</div>` : "")) +
      `</div></div>`;
  };

  P.replies = () => {
    const r = C().filter(c => c.group === "replied");
    return `<div class="page-intro">People who answered. Reply, then ask when they're available for a call (never propose slots).</div>` +
      card("Replies to handle", r.length, r.map(c => row(person(c, `${esc(c.next_action)}${c.dm_date ? " · last message " + fmt(c.dm_date) : ""}${c.notes ? `<br><span class="note">${esc(c.notes.split("|").pop().trim().slice(0, 160))}</span>` : ""}`), when(c.due) + profileBtn(c))).join("") || empty("No reply waiting."));
  };

  P.calls = () => {
    const booked = C().filter(c => c.group === "call"), done = C().filter(c => c.group === "done");
    return `<div class="page-intro">Before: the call sheet (phase 3: generated automatically). After: the recap PDF from your MacWhisper transcript.</div>
      <div class="net-grid"><div class="net-col">` +
      card("Upcoming calls", booked.length, booked.map(c => row(person(c, esc((c.notes || "").split("|").pop().trim().slice(0, 140))), `<span class="soon">call sheet · phase 3</span>`)).join("") || empty("No call booked.")) +
      `</div><div class="net-col">` +
      card("Calls done", done.length, done.map(c => row(person(c, esc(c.stage)), c.stage === "Call done" ? `<span class="due">thank-you to send</span>` : `<span class="ok">✓ thanked</span>`)).join("") || empty("None yet.")) +
      `</div></div>`;
  };

  P.followup = () => {
    const open = state.d.tasks.filter(x => taskStatus(x) === "À faire");
    const now = open.filter(x => x.due && x.due <= T()), later = open.filter(x => !x.due || x.due > T());
    const thanks = C().filter(c => c.stage === "Call done");
    const doneT = state.d.tasks.filter(x => taskStatus(x) !== "À faire");
    const taskRow = x => row(`<div class="row-main"><div class="row-title">${esc(x.contact)} <span class="muted">· ${esc(x.firm)}</span></div><div class="row-sub">${esc(x.task)}</div><div class="row-sub small">${esc(x.origin)}</div></div>`,
      when(x.due) + `<button class="btn mini" data-task="${esc(x.id)}">Done ✓</button>`);
    return `<div class="page-intro">Everything that comes out of your calls: thank-you the next day, tasks, introductions, long-term follow-ups.</div>
      <div class="net-grid"><div class="net-col">` +
      card("Thank-you: day after the call", thanks.length, thanks.map(c => row(person(c, "Call done"), profileBtn(c))).join("") || empty("None.")) +
      card("Tasks due", now.length, now.map(taskRow).join("") || empty("Nothing due.")) +
      `</div><div class="net-col">` +
      card("Coming up", later.length, later.sort((a, b) => (a.due || "9").localeCompare(b.due || "9")).map(taskRow).join("") || empty("Nothing planned.")) +
      card("Done", doneT.length, doneT.slice(-8).map(x => row(`<div class="row-main"><div class="row-title muted">${esc(x.contact)} · ${esc(x.task.slice(0, 70))}</div></div>`)).join("") || empty("—")) +
      `</div></div>`;
  };

  P.network = () => {
    const q = state.q.toLowerCase();
    const list = state.d.network.filter(n => !q || (n.name + " " + n.headline).toLowerCase().includes(q));
    return `<div class="page-intro">Your ${state.d.network.length} LinkedIn connections. The ones to message appear each day in Messages.</div>
      <table class="ftable"><thead><tr><th>Name</th><th>Headline</th><th>Category</th><th>Status</th><th>Connected</th></tr></thead><tbody>` +
      list.slice(0, 150).map(n => `<tr><td class="b">${esc(n.name)}</td><td>${esc(n.headline.slice(0, 90))}</td><td>${esc(n.category.replace(/^(.)\s–.*/, "$1"))}</td>
        <td><span class="fstat ${n.messaged === "Yes" ? "on" : ""}">${esc(n.messaged === "Yes" ? "Messaged" : n.status)}</span></td><td>${esc(fmt(n.connected_on) || n.connected_on)}</td></tr>`).join("") +
      `</tbody></table>${list.length > 150 ? `<div class="hint center">Showing 150 of ${list.length}. Use the search.</div>` : ""}`;
  };

  // ------------------------------------------------------------ person sheet
  function openPerson(id) {
    const c = C().find(x => x.id === id); if (!c) return;
    const tasks = state.d.tasks.filter(x => x.contact === c.name);
    const f = state.d.queue.find(x => x.firm_id === c.firm_id);
    const field = (k, v) => v ? `<div class="pf"><span>${k}</span><b>${esc(v)}</b></div>` : "";
    $("person").innerHTML = `<button class="pclose" data-close>×</button>
      <div class="ptitle">${esc(c.name)}</div><div class="psub">${esc(c.title)}${c.firm ? " · " + esc(c.firm) : ""}</div>
      <div class="pstage">${esc(c.stage)}</div>
      <div class="pgrid">${field("Next action", c.next_action)}${field("Due", fmt(c.due))}${field("Request sent", fmt(c.request_date))}${field("Accepted", fmt(c.accepted_date))}
        ${field("Message sent", fmt(c.dm_date))}${field("E-mail", c.email)}${field("E-mail sent", fmt(c.email_date))}${field("Follow-up", fmt(c.followup_date))}
        ${field("Language", c.lang)}${field("Seniority", c.seniority)}${field("Alumni", c.alumni)}${field("Introduced by", c.introduced_by)}${field("Firm tier", f && f.tier)}</div>
      ${tasks.length ? `<div class="psec">Tasks</div>` + tasks.map(x => `<div class="pnote">${esc(fmt(x.due))} · ${esc(x.task)} <span class="muted">(${esc(statusEn(taskStatus(x)))})</span></div>`).join("") : ""}
      ${c.notes ? `<div class="psec">History</div>` + c.notes.split("|").map(s => s.trim()).filter(Boolean).map(s => `<div class="pnote">${esc(s)}</div>`).join("") : ""}
      <div class="pbtns"><a class="btn mini ghost" href="${esc(c.linkedin || searchUrl(c.name))}" target="_blank" rel="noopener">LinkedIn ↗</a></div>`;
    $("person-wrap").hidden = false;
  }

  // ------------------------------------------------------------ render
  function render() {
    if (!state.d) return;
    const d = state.d, page = state.page, label = (PAGES.find(p => p[0] === page) || PAGES[0])[1];
    $("net-title").textContent = label;
    $("net-fresh").textContent = `Networking · updated ${new Date(d.generated_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    $("net-search").hidden = !["firms", "network"].includes(page);
    $("net-body").innerHTML = (P[page] || P.today)();
    const cnt = {
      requests: C().filter(c => c.stage === "Request sent" && c.request_date && days(c.request_date, T()) >= 7).length,
      messages: C().filter(c => c.group === "accepted").length,
      replies: C().filter(c => c.group === "replied").length,
      calls: C().filter(c => c.group === "call").length,
      followup: state.d.tasks.filter(x => taskStatus(x) === "À faire" && x.due && x.due <= T()).length + C().filter(c => c.stage === "Call done").length,
    };
    Object.entries(cnt).forEach(([k, v]) => { const el = $("nb-" + k); if (el) el.textContent = v || ""; });
    document.querySelectorAll(".nav-sub a").forEach(a => a.classList.toggle("active", a.dataset.page === page));
  }

  let bound = false;
  function bind() {
    $("net-search").addEventListener("input", e => { state.q = e.target.value; render(); });
    $("net-body").addEventListener("click", e => {
      const t = e.target.closest("[data-task]"); if (t) return markTask(t.dataset.task, "Fait");
      const p = e.target.closest("[data-person]"); if (p) return openPerson(p.dataset.person);
      const c = e.target.closest("[data-cat]"); if (c) { state.netCat = c.dataset.cat; return render(); }
      if (e.target.closest("[data-toggle-old]")) { state.showOld = !state.showOld; render(); }
    });
    $("person-wrap").addEventListener("click", e => { if (e.target.id === "person-wrap" || e.target.closest("[data-close]")) $("person-wrap").hidden = true; });
    document.addEventListener("keydown", e => { if (e.key === "Escape") $("person-wrap").hidden = true; });
  }
  async function show(page) {
    if (!bound) { bind(); bound = true; }
    state.page = PAGES.some(p => p[0] === page) ? page : "today"; state.q = ""; $("net-search").value = "";
    if (!state.d) await load();
    render(); window.scrollTo(0, 0);
  }
  async function refresh() { await load(); render(); }
  return { show, render, load, refresh, PAGES };
})();
