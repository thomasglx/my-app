/* Networking section. Everything is an event attached to a person; NetEngine computes the rest.
   Data (private MyOffers repo):
   - export/networking.json            people, events, firms, network, tasks (from the bot / Excel import)
   - state/networking_overrides.json   what you do in the app: events, new people, edits, settings, advice
   - state/networking_prompts.json     the prompts, with every version
   - state/networking_profiles.json    LinkedIn profile text pasted per person */
const Networking = (() => {
  const DATA = "export/networking.json", OVR = "state/networking_overrides.json",
        PROMPTS = "state/networking_prompts.json", PROFILES = "state/networking_profiles.json", OFFERS = "export/offers.json", INBOX = "state/networking_inbox_mac.json", DRAFTS = "state/networking_drafts.json";
  const PAGES = [["today", "Today"], ["requests", "Connection requests"], ["replies", "Replies"], ["cold", "Cold messages"],
                 ["thanks", "Thank-you & keep warm"], ["calls", "Calls"], ["advice", "Call advice"], ["network", "Network"],
                 ["prompts", "Prompts"], ["stats", "Stats"]];
  const KIND = { first: "first_message", followup: "followup", reply: "reply", thanks: "thanks", keep_warm: "keep_warm" };
  const st = { base: null, ov: {}, inbox: null, prompts: null, profiles: null, offers: null, m: null, page: "today", q: "",
               open: null, netTab: "people", stageF: "", promptSel: "first_message", drafts: {} };
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const preview = () => !!window.__MYAPP_PREVIEW_NET__;
  const todayIso = () => preview() ? window.__MYAPP_PREVIEW_NET__.today : NetEngine.isoDay(new Date());
  const nowIso = () => preview() ? window.__MYAPP_PREVIEW_NET__.today + "T" + new Date().toTimeString().slice(0, 5) : new Date().toISOString();
  const fmt = iso => { if (!iso) return ""; const x = new Date(String(iso).length > 10 ? iso : iso + "T12:00"); return isNaN(x) ? iso : x.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
  const fmtT = iso => { const x = new Date(iso); return isNaN(x) ? "" : x.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
  const uid = () => "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const searchUrl = name => "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(name);
  const peopleUrl = f => f.linkedin ? f.linkedin.replace(/\/$/, "") + "/people/"
    : "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(String(f.firm || "").replace(/\b(S\.?A\.?|SAS|SARL|AG)\b\.?/g, "").replace(/\(.*?\)/g, "").trim());
  const profileUrl = p => p.linkedin || searchUrl(p.name + (p.firm ? " " + p.firm : ""));
  const CH = { linkedin: "LinkedIn", whatsapp: "WhatsApp", sms: "SMS", imessage: "iMessage", email: "E-mail", phone: "Phone" };

  // ------------------------------------------------------------ data
  async function load() {
    const inj = window.__MYAPP_PREVIEW_NET__;
    if (inj) { Object.assign(st, { base: inj.base, ov: inj.ov || {}, prompts: inj.prompts, profiles: {}, offers: inj.offers, inbox: inj.inbox || null, ai: inj.ai || {} }); return model(); }
    const [base, ov, prompts, offers, inbox, aid] = await Promise.all([GH.readJson(DATA), GH.readJson(OVR), GH.readJson(PROMPTS), GH.readJson(OFFERS), GH.readJson(INBOX).catch(() => null), GH.readJson(DRAFTS).catch(() => null)]);
    if (!base) throw new Error("export/networking.json not found yet.");
    if ((base.schema_version || 1) < 2) throw new Error("The networking data is in the old format. It needs a re-import (schema 2).");
    Object.assign(st, { base, ov: ov || {}, prompts: prompts || { prompts: [] }, offers, inbox, ai: (aid || {}).drafts || {} });
    model();
  }
  function model() { st.m = NetEngine.build(st.base, st.ov, st.offers, todayIso(), st.inbox); return st.m; }

  /* Writes are queued so two quick clicks never overwrite each other. */
  let chain = Promise.resolve();
  function save(path, mutate, label, rollback) {
    if (preview()) return;
    chain = chain.then(() => GH.updateJson(path, mutate, "MyApp: " + label)).catch(e => { if (rollback) rollback(); render(); toast("Not saved: " + e.message); });
  }
  function addEvents(list, label) {
    st.ov.events = [...(st.ov.events || []), ...list]; model(); render();
    save(OVR, d => ({ ...d, events: [...(d.events || []), ...list] }), label,
      () => { const ids = new Set(list.map(e => e.id)); st.ov.events = st.ov.events.filter(e => !ids.has(e.id)); model(); });
  }
  const ev = (person, type, extra = {}) => ({ id: uid(), person, type, at: nowIso(), source: "app", ...extra });
  function setOv(key, id, value, label) {
    st.ov[key] = { ...(st.ov[key] || {}), [id]: value }; model(); render();
    save(OVR, d => ({ ...d, [key]: { ...(d[key] || {}), [id]: value } }), label);
  }
  function patchPerson(id, patch, label) {
    const isNew = !!(st.ov.people_new || {})[id];
    if (isNew) setOv("people_new", id, { ...st.ov.people_new[id], ...patch }, label);
    else setOv("people", id, { ...((st.ov.people || {})[id] || {}), ...patch }, label);
  }
  function newPerson(p, events, label) {
    st.ov.people_new = { ...(st.ov.people_new || {}), [p.id]: p };
    st.ov.events = [...(st.ov.events || []), ...events]; model(); render();
    save(OVR, d => ({ ...d, people_new: { ...(d.people_new || {}), [p.id]: p }, events: [...(d.events || []), ...events] }), label);
  }
  const idFromUrl = url => { const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i); return m ? "li-" + decodeURIComponent(m[1]).toLowerCase() : null; };
  const nameFromUrl = url => { const m = String(url).match(/\/in\/([^/?#]+)/); return m ? decodeURIComponent(m[1]).replace(/-[0-9a-f]{5,}$/i, "").split("-").filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ") : ""; };
  const person = id => st.m.P.find(p => p.id === id);

  // ------------------------------------------------------------ message drafts
  function promptOf(id) { const p = (st.prompts.prompts || []).find(x => x.id === id); return p ? p.versions[p.versions.length - 1].text : ""; }
  function draftFor(p, kind, form) {
    const key = p.id + ":" + kind;
    if (st.drafts[key] && st.drafts[key].form === form) return st.drafts[key];
    // AI draft prepared by the scheduled task for this exact situation (same reply / acceptance / call)
    const dk = p.st && NetEngine.draftKey(p), ai = dk && dk.split(":")[1] === kind && (st.ai || {})[dk];
    if (ai && (!form || form === ai.form)) return (st.drafts[key] = { form: ai.form || form, text: ai.text, original: ai.text, ai });
    form = form || NetEngine.form(p);
    const t = NetEngine.templates(promptOf(KIND[kind]));
    const tpl = t[form] || t.vous || t.tu || Object.values(t)[0] || "";
    const text = NetEngine.fill(tpl, p);
    return (st.drafts[key] = { form, text, original: text });
  }
  function composer(p, kind) {
    const prev = st.drafts[p.id + ":" + kind];
    const d = draftFor(p, kind, prev ? prev.form : null) ;
    const form = d.form || NetEngine.form(p);
    const miss = NetEngine.unresolved(d.text);
    const ch = kind === "reply" || kind === "keep_warm" ? p.st.bestChannel : "linkedin";
    const lr = p.st.s.lastRecv;
    const theirs = kind !== "reply" || !lr ? "" : lr.text ? `<div class="their"><span>${esc(CH[lr.channel] || "")} · ${fmtT(lr.at)}</span>${esc(lr.text)}</div>`
      : lr.digest ? `<div class="their"><span>LinkedIn · ${fmtT(lr.at)}</span>LinkedIn's e-mail doesn't include the text. <a href="${esc(lr.thread_url || "https://www.linkedin.com/messaging/")}" target="_blank" rel="noopener">Open the conversation ↗</a></div>` : "";
    return `<div class="composer" data-pid="${esc(p.id)}" data-kind="${kind}">${theirs}
      <div class="comp-top"><div class="seg small">${["tu", "vous", "en"].map(f => `<button class="seg-b ${form === f ? "on" : ""}" data-form="${f}">${f === "en" ? "English" : f}</button>`).join("")}</div>
        <span class="muted small">${d.ai ? `✨ Claude's draft · ${fmtT(d.ai.at)}${d.ai.why ? ` · <span title="${esc(d.ai.why)}">why?</span>` : ""}` : "Draft from your template · Claude's draft comes at the next run (8:00, 12:00, 16:00, 20:00)"}</span></div>
      <textarea class="comp-text" rows="${Math.min(22, d.text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 78)), 1))}">${esc(d.text)}</textarea>
      ${miss.length ? `<div class="comp-miss">To fill: ${miss.map(esc).join(" · ")}</div>` : ""}
      <div class="comp-btns">
        <a class="btn mini ghost" href="${esc(profileUrl(p))}" target="_blank" rel="noopener">Open profile ↗</a>
        <span class="muted small">via ${esc(CH[ch] || ch)}</span><span class="grow"></span>
        <button class="btn mini ghost" data-act="close-comp">Cancel</button>
        ${kind === "reply" ? `<button class="btn mini ghost" data-act="handled">No reply needed</button>` : ""}
        <button class="btn mini" data-act="copy">${p.st.s.copied ? "Copied ✓" : "Copy"}</button>
        <button class="btn mini primary" data-act="sent" data-ch="${esc(ch)}">Sent ✓</button>
      </div></div>`;
  }

  // ------------------------------------------------------------ building blocks
  const card = (title, count, body, cls = "") => `<section class="net-card ${cls}">${title ? `<h3>${title}${count !== null && count !== undefined ? `<span class="count">${count}</span>` : ""}</h3>` : ""}${body}</section>`;
  const empty = t => `<div class="empty-s">${t}</div>`;
  const when = due => { const T = todayIso(); return !due ? "" : due < T ? `<span class="late">${NetEngine.diff(due, T)} d late</span>` : due === T ? `<span class="due">today</span>` : `<span class="soon">${fmt(due)}</span>`; };
  const pname = p => `<a class="pname" data-person="${esc(p.id)}">${esc(p.name)}</a>`;
  const prow = (p, sub, side = "", key = "") => `<div class="row ${st.open === key ? "is-open" : ""}"><div class="row-main click" data-person="${esc(p.id)}"><div class="row-title">${pname(p)} <span class="muted">· ${esc(p.firm || p.title)}</span></div>${sub ? `<div class="row-sub">${sub}</div>` : ""}</div><div class="row-side">${side}</div></div>`;
  const writeBtn = (p, kind, label = "Write") => { const k = p.id + ":" + kind; return `<button class="btn mini ${st.open === k ? "" : "primary"}" data-open="${esc(k)}">${st.open === k ? "Close" : label}</button>`; };
  const REASONS = [["friend", "Friend"], ["classmate", "Classmate"], ["family", "Family"], ["elsewhere", "Handled elsewhere (call, WhatsApp…)"],
                   ["finished", "Conversation finished"], ["not relevant", "Not relevant for my search"]];
  const needBtn = (p, task) => { const k = p.id + ":" + task + ":skip"; return `<button class="btn mini ghost" data-open="${esc(k)}">${st.open === k ? "Close" : "No need"}</button>`; };
  const needForm = (p, task) => `<form class="noneed" data-pid="${esc(p.id)}" data-skiptask="${task}">
      <div class="noneed-q">Why no ${task === "reply" || task === "talking" ? "reply" : "message"} to ${esc(p.name)}?</div>
      <div class="chips">${REASONS.map(([v, l]) => `<label class="chip"><input type="radio" name="reason" value="${esc(v)}"><span>${esc(l)}</span></label>`).join("")}</div>
      <textarea name="text" rows="2" placeholder="Details (optional): saved in the contact card"></textarea>
      <div class="comp-btns"><span class="muted small">Friend, classmate, family and "not relevant" stop all reminders for this person.</span><span class="grow"></span><button class="btn mini primary">Save</button></div></form>`;
  const msgRow = (p, kind, sub, task = kind) => {
    const k = p.id + ":" + kind, ks = p.id + ":" + task + ":skip";
    return prow(p, sub, when(p.st.due) + needBtn(p, task) + writeBtn(p, kind), st.open === ks ? ks : k) + (st.open === k ? composer(p, kind) : "") + (st.open === ks ? needForm(p, task) : "");
  };
  const kpi = (label, val, sub = "", cls = "") => `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-val">${val}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  const gauge = (n, max) => { const pct = Math.min(100, Math.round(100 * n / max)); return `<div class="gauge"><i style="width:${pct}%" class="${pct >= 90 ? "hot" : ""}"></i></div>`; };
  function counters() {
    const c = st.m.counters, S = st.m.S;
    return `<div class="kpis four">
      <div class="kpi"><div class="kpi-label">Requests today</div><div class="kpi-val">${c.reqToday}<span>/ ${S.requestsDayMax}</span></div>${gauge(c.reqToday, S.requestsDayMax)}<div class="kpi-sub">${c.reqLeft} more allowed today</div></div>
      <div class="kpi"><div class="kpi-label">Requests, 7 days</div><div class="kpi-val">${c.req7d}<span>/ ${S.requests7dMax}</span></div>${gauge(c.req7d, S.requests7dMax)}<div class="kpi-sub">rolling week</div></div>
      <div class="kpi"><div class="kpi-label">LinkedIn messages today</div><div class="kpi-val">${c.sentToday}<span>/ ${S.messagesDayMax}</span></div>${gauge(c.sentToday, S.messagesDayMax)}<div class="kpi-sub">${c.msgLeft} left</div></div>
      ${kpi("Calls booked", st.m.P.filter(p => p.st.stage === "call").length)}
    </div>`;
  }
  function firmBlock(f) {
    const key = "firm:" + f.firm_id;
    const ppl = f.at.map(p => `${pname(p)} <span class="stage-chip">${esc(p.st.label)}</span>`).join(" · ");
    return `<div class="row ${st.open === key ? "is-open" : ""}"><div class="row-main"><div class="row-title">${esc(f.firm)}</div>
        <div class="row-sub">#${f.rank} · ${esc(f.tier)} · ${esc(f.type)} · ${esc(f.city || f.market)}</div>
        ${f.why ? `<div class="row-sub"><span class="why">${esc(f.why)}</span></div>` : ""}
        ${f.newWave ? `<div class="row-sub"><span class="why">Nobody accepted: new wave</span></div>` : ""}
        ${ppl ? `<div class="row-sub">${ppl}</div>` : ""}</div>
      <div class="row-side"><a class="btn mini ghost" href="${esc(peopleUrl(f))}" target="_blank" rel="noopener">People ↗</a><button class="btn mini ${st.open === key ? "" : "primary"}" data-open="${esc(key)}">${st.open === key ? "Close" : "Add requests"}</button></div></div>
      ${st.open === key ? addForm(f) : ""}`;
  }
  const addForm = f => `<form class="addp" data-firm="${esc(f ? f.firm_id : "")}">
      <div class="addp-hint">Paste the LinkedIn profile link of each person you sent a request to (1 senior + 1 junior, no interns).</div>
      ${[0, 1].map(i => `<div class="addp-row"><input name="url${i}" placeholder="https://www.linkedin.com/in/…" autocomplete="off"><input name="name${i}" placeholder="Full name (auto)"><select name="sen${i}"><option value="senior"${i === 0 ? " selected" : ""}>Senior</option><option value="junior"${i === 1 ? " selected" : ""}>Junior</option></select></div>`).join("")}
      ${f ? "" : `<div class="addp-row"><input name="firm" placeholder="Firm"><input name="by" placeholder="Referred by (optional)"></div>`}
      <div class="comp-btns"><span class="grow"></span><button class="btn mini primary" type="submit">Request sent ✓</button></div></form>`;

  // ------------------------------------------------------------ pages
  const P = {};

  function deviceBar() {
    const d = st.m.device;
    if (!d) return `<div class="device off">Mac sync not installed yet: replies on WhatsApp, SMS and calls aren't read automatically.</div>`;
    const mins = Math.round((Date.now() - new Date(d.last_run)) / 6e4);
    const ago = mins < 2 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
    const src = Object.entries(d.sources || {}).filter(([k]) => k !== "contacts").map(([k, v]) => `<span class="${String(v).startsWith("ok") ? "ok" : "bad"}" title="${esc(v)}">${esc({ linkedin: "LinkedIn", sms: "SMS", whatsapp: "WhatsApp", calls: "Calls" }[k] || k)} ${String(v).startsWith("ok") ? "✓" : "⚠"}</span>`).join("");
    const stale = mins > 180;
    return `<div class="device ${stale ? "stale" : ""}">${stale ? "⚠ " : ""}Mac synced ${ago}${stale ? " (Mac off or asleep? New replies may be missing)" : ""} · ${src}</div>`;
  }

  P.today = () => {
    const t = st.m.today, c = st.m.counters, out = [];
    out.push(deviceBar());
    out.push(counters());
    const now = [];
    t.copies.forEach(p => now.push(prow(p, `You copied a ${esc(p.st.s.copied.kind || "")} message ${fmt(p.st.s.copied.at)}. Did you send it?`,
      `<button class="btn mini ghost" data-act="notsent" data-pid="${esc(p.id)}">Not sent</button><button class="btn mini primary" data-act="confirm" data-pid="${esc(p.id)}">Sent ✓</button>`)));
    t.replies.forEach(p => now.push(msgRow(p, "reply", `${esc(CH[p.st.s.lastRecv.channel] || "LinkedIn")} · ${esc(p.st.info)}${p.st.s.lastRecv.approx ? "" : ""}`)));
    t.callLog.forEach(p => now.push(prow(p, `Call planned ${fmtT(p.st.s.callBooked.call_at)}`, `<button class="btn mini ghost" data-act="call-moved" data-pid="${esc(p.id)}">New date</button><button class="btn mini primary" data-act="call-done" data-pid="${esc(p.id)}">Done ✓</button>`)));
    t.interviews.forEach(x => now.push(`<div class="row"><div class="row-main"><div class="row-title">${esc(x.type)} · ${esc(x.offer.company)}</div>
      <div class="row-sub">${esc(String(x.offer.title || "").slice(0, 90))}</div>
      ${x.contacts.length ? `<div class="row-sub">People you know there: ${x.contacts.map(pname).join(", ")}: ask them for tips before the interview.</div>` : ""}</div>
      <div class="row-side">${x.at ? `<span class="due">${fmtT(x.at)}</span>` : `<input type="datetime-local" class="dt" data-iv="${esc(x.offer.offer_id)}"><button class="btn mini primary" data-act="iv-save" data-iv="${esc(x.offer.offer_id)}">Save</button>`}</div></div>`));
    out.push(card("Needs you now", now.length, now.join("") || empty("Nothing urgent. Replies appear here as soon as they arrive."), "accent"));

    const calls = [...t.calls.map(p => prow(p, `${p.st.s.callBooked.call_at ? fmtT(p.st.s.callBooked.call_at) : ""} · prepare the call sheet 10 min before`, `<a class="btn mini ghost" href="#networking/calls">Prepare →</a>`)),
                   ...t.thanks.map(p => msgRow(p, "thanks", esc(p.st.info)))];
    if (calls.length) out.push(card("Calls & thank-yous", calls.length, calls.join("")));

    const msgs = [...t.first.map(p => msgRow(p, "first", esc(p.st.info))), ...t.followups.map(p => msgRow(p, "followup", esc(p.st.info))),
                  ...t.keepWarm.map(p => msgRow(p, "keep_warm", `Keep warm · ${esc(p.st.info)}`)),
                  ...t.nudges.map(p => msgRow(p, "reply", `No answer since your last message · ${esc(p.st.info)}`, "talking"))];
    const dorm = t.dormant.map(p => msgRow(p, "first", `${esc(p.st.info)} · never messaged`, "dormant"));
    const net = t.network.map(netRow);
    out.push(card(`Messages to send <span class="muted small">· ${c.msgLeft} left today</span>`, msgs.length + dorm.length + net.length,
      (msgs.join("") || "") + (dorm.length + net.length ? `<div class="sub-head">Old connections (${st.m.S.networkPerDay} a day, best roles first)</div>` + dorm.join("") + net.join("") : "") || empty("No message due today.")));

    const reqs = [...t.referred.map(p => prow(p, `Referred by ${esc(p.introduced_by)} · priority`, `${needBtn(p, "referred")}<a class="btn mini ghost" href="${esc(profileUrl(p))}" target="_blank" rel="noopener">Profile ↗</a><button class="btn mini primary" data-act="req-sent" data-pid="${esc(p.id)}">Request sent ✓</button>`) + (st.open === p.id + ":referred:skip" ? needForm(p, "referred") : ""))];
    out.push(card(`Connection requests <span class="muted small">· ${c.reqLeft} left today</span>`, null,
      (reqs.length ? `<div class="sub-head">Referred in calls</div>` + reqs.join("") : "") +
      (c.reqLeft ? `<div class="sub-head">Firms for today</div>` + t.firms.map(firmBlock).join("") : empty(`Limit reached (${c.req7d}/${st.m.S.requests7dMax} over 7 days). Requests come back tomorrow.`))));

    const house = [...t.tasks.map(x => `<div class="row"><div class="row-main"><div class="row-title">${esc(x.contact)} <span class="muted">· ${esc(x.firm)}</span></div><div class="row-sub">${esc(x.task)}</div><div class="row-sub small">${esc(x.origin)}</div></div><div class="row-side">${when(x.due)}<button class="btn mini" data-task="${esc(x.id)}">Done ✓</button></div></div>`),
                   ...t.withdraw.map(p => prow(p, esc(p.st.info) + " · withdraw it on LinkedIn (My Network → Manage → Sent)", `<button class="btn mini" data-act="withdrawn" data-pid="${esc(p.id)}">Withdrawn ✓</button>`))];
    if (house.length) out.push(card("Tasks from calls & housekeeping", house.length, house.join("")));
    return out.join("");
  };

  function netRow(n) {
    const k = "net:" + n.key, fake = netPerson(n), ks = fake.id + ":dormant:skip";
    return `<div class="row ${st.open === k || st.open === ks ? "is-open" : ""}"><div class="row-main"><div class="row-title">${esc(n.name)} <span class="muted">· old connection</span></div><div class="row-sub">${esc(n.headline.slice(0, 110))}</div></div>
      <div class="row-side"><button class="btn mini ghost" data-open="${esc(ks)}">${st.open === ks ? "Close" : "No need"}</button><button class="btn mini primary" data-open="${esc(k)}">${st.open === k ? "Close" : "Write"}</button></div></div>
      ${st.open === k ? netComposer(n) : ""}${st.open === ks ? needForm(fake, "dormant").replace('class="noneed"', `class="noneed" data-net="${esc(n.key)}"`) : ""}`;
  }
  const netPerson = n => ({ id: "net-" + n.key.replace(/\s+/g, "-"), name: n.name, title: n.headline, firm: "", alumni: n.school || "", lang: "FR", seniority: "", origin: "network", notes: [] });
  function netComposer(n) {
    const fake = { id: "net-" + n.key.replace(/\s+/g, "-"), name: n.name, title: n.headline, firm: "", alumni: n.school, lang: "FR", seniority: "", st: { s: {}, bestChannel: "linkedin" } };
    return composer(fake, "first").replace('data-kind="first"', `data-kind="first" data-net="${esc(n.key)}"`);
  }

  P.requests = () => {
    const t = st.m.today, c = st.m.counters;
    const pend = st.m.P.filter(p => p.st.stage === "pending").sort((a, b) => (a.st.s.req.at || "").localeCompare(b.st.s.req.at || ""));
    return counters() + `<div class="net-grid"><div class="net-col">` +
      card("Firms for today", t.firms.length, `<div class="hint">Order: referred in a call → open offer you haven't applied to yet (network first) → recent application → your firm ranking. Firms where 2 people are already active are skipped.</div>` + t.firms.map(firmBlock).join("")) +
      card("Someone else", null, `<button class="btn mini ${st.open === "firm:" ? "" : "primary"}" data-open="firm:">${st.open === "firm:" ? "Close" : "Add a request"}</button>${st.open === "firm:" ? addForm(null) : ""}`) +
      `</div><div class="net-col">` +
      card("Referred in calls", t.referred.length, t.referred.map(p => prow(p, `Referred by ${esc(p.introduced_by)}`, `<a class="btn mini ghost" href="${esc(profileUrl(p))}" target="_blank" rel="noopener">Profile ↗</a><button class="btn mini primary" data-act="req-sent" data-pid="${esc(p.id)}">Request sent ✓</button>`)).join("") || empty("None.")) +
      card("Sync with LinkedIn", null, `<form id="sent-sync" class="addp"><div class="addp-hint">LinkedIn → My Network → Manage → <b>Sent</b>: select the whole page (Cmd+A), copy, paste here. Anyone missing from that page is marked withdrawn; anyone new is added.</div>
        <textarea name="text" rows="3" placeholder="Paste the Sent invitations page"></textarea><div class="comp-btns"><span class="muted small">${st.ov.sent_sync_at ? "Last sync " + fmtT(st.ov.sent_sync_at) : "Never synced"}</span><span class="grow"></span><button class="btn mini primary">Sync</button></div></form>`) +
      card("Withdraw (3+ weeks)", st.m.P.filter(p => p.st.stage === "withdraw").length, st.m.P.filter(p => p.st.stage === "withdraw").map(p => prow(p, esc(p.st.info), `<button class="btn mini" data-act="withdrawn" data-pid="${esc(p.id)}">Withdrawn ✓</button>`)).join("") || empty("None.")) +
      card("Waiting for acceptance", pend.length, pend.map(p => prow(p, esc(p.st.info), `<button class="btn mini ghost" data-act="accepted" data-pid="${esc(p.id)}">Accepted ✓</button>`)).join("") || empty("None.")) +
      `</div></div>`;
  };

  P.replies = () => {
    const r = st.m.P.filter(p => p.st.stage === "reply");
    return `<div class="page-intro">People who answered, on any channel. Reply and ask when they're available (never propose slots).</div>` +
      card("Replies to send", r.length, r.map(p => msgRow(p, "reply", `${esc(CH[p.st.s.lastRecv.channel] || "LinkedIn")} · ${esc(p.st.info)}`)).join("") || empty("No reply waiting.")) +
      card("In conversation", null, st.m.P.filter(p => p.st.stage === "talking").sort((a, b) => (a.st.due || "9").localeCompare(b.st.due || "9")).map(p => prow(p, esc(p.st.info), when(p.st.due))).join("") || empty("None.")) +
      card("Log a reply", null, `<div class="hint">LinkedIn: import your data archive (messages.csv) and everything is exact. Between two archives, or for WhatsApp / SMS / e-mail: open the person → "They replied" and paste their message.</div>`);
  };

  P.cold = () => {
    const all = st.m.P, T = todayIso();
    const first = all.filter(p => p.st.stage === "first"), fu = all.filter(p => p.st.stage === "followup");
    const paused = [...first, ...fu].filter(p => p.st.paused);
    const third = all.filter(p => p.st.stage === "third");
    const t = st.m.today;
    t.network = t.network || [];
    return `<div class="page-intro">First messages (24 h after acceptance), the one follow-up on LinkedIn after ${st.m.S.followupDays} days, then "3rd outreach" (e-mail, on hold).</div>
      <div class="net-grid"><div class="net-col">` +
      card("First messages", first.filter(p => !p.st.paused).length, first.filter(p => !p.st.paused).map(p => msgRow(p, "first", esc(p.st.info) + (p.st.due > T ? ` · from ${fmt(p.st.due)}` : ""))).join("") || empty("Nobody new.")) +
      card(`Follow-ups (day ${st.m.S.followupDays})`, fu.filter(p => !p.st.paused && p.st.due <= T).length,
        fu.filter(p => !p.st.paused && p.st.due <= T).map(p => msgRow(p, "followup", esc(p.st.info))).join("") || empty("None due.")) +
      (paused.length ? card("Paused: a colleague already answered", paused.length, paused.map(p => prow(p, esc(p.st.paused))).join("")) : "") +
      `</div><div class="net-col">` +
      card("Old connections today", t.network.length, t.network.map(netRow).join("") || empty("Done for today.")) +
      card("Waiting for the follow-up date", fu.filter(p => p.st.due > T).length, fu.filter(p => p.st.due > T).slice(0, 30).map(p => prow(p, esc(p.st.info), when(p.st.due))).join("")) +
      card("Connected, never messaged", all.filter(p => p.st.stage === "dormant").length, all.filter(p => p.st.stage === "dormant").sort((a, b) => NetEngine.levelOf(a.title) - NetEngine.levelOf(b.title)).slice(0, 40).map(p => msgRow(p, "first", esc(p.st.info))).join("") || empty("None.")) +
      card("3rd outreach (e-mail, on hold)", third.length, third.map(p => prow(p, esc(p.st.info) + (p.email ? " · " + esc(p.email) : ""))).join("") || empty("None.")) +
      `</div></div>`;
  };

  P.thanks = () => {
    const T = todayIso(), all = st.m.P;
    const th = all.filter(p => p.st.stage === "thanks"), kw = all.filter(p => p.st.stage === "keep_warm").sort((a, b) => (a.st.due || "9").localeCompare(b.st.due || "9"));
    return `<div class="page-intro">Thank-you the day after the call. Keep warm at least ${Math.round(st.m.S.keepWarmDays / 7)} weeks after the last contact, on any channel.</div>
      <div class="net-grid"><div class="net-col">` +
      card("Thank-you", th.length, th.map(p => msgRow(p, "thanks", esc(p.st.info) + (p.st.due > T ? ` · send ${fmt(p.st.due)}` : ""))).join("") || empty("None.")) +
      `</div><div class="net-col">` +
      card("Keep warm", kw.length, kw.map(p => p.st.due <= T ? msgRow(p, "keep_warm", esc(p.st.info)) : prow(p, esc(p.st.info), when(p.st.due))).join("") || empty("Nobody yet.")) +
      `</div></div>`;
  };

  P.calls = () => {
    const all = st.m.P;
    const up = all.filter(p => p.st.stage === "call").sort((a, b) => (a.st.s.callBooked.call_at || "9").localeCompare(b.st.s.callBooked.call_at || "9"));
    const log = all.filter(p => p.st.stage === "call_log");
    const done = all.filter(p => p.st.s.callDone).sort((a, b) => b.st.s.callDone.at.localeCompare(a.st.s.callDone.at));
    const callRow = p => {
      const at = p.st.s.callBooked.call_at, same = at ? up.filter(o => o.id !== p.id && NetEngine.day(o.st.s.callBooked.call_at) === NetEngine.day(at)) : [];
      return `<div class="row stack"><div class="row-main"><div class="row-title">${pname(p)} <span class="muted">· ${esc(p.firm || p.title)}</span></div>
        <div class="row-sub">${at ? fmtT(at) : `<span class="late">date to set</span>`}${p.phone ? " · " + esc(p.phone) : ""} · best channel ${esc(CH[p.st.bestChannel] || p.st.bestChannel)}</div>
        ${same.length ? `<div class="row-sub small">Same day: ${same.map(o => esc(o.name) + " " + fmtT(o.st.s.callBooked.call_at).split(" ").pop()).join(", ")}</div>` : ""}
        <div class="row-sub small muted">Call sheet: phase C · Record button: phase D</div></div>
        <div class="row-side"><input type="datetime-local" class="dt" data-calldt="${esc(p.id)}" value="${esc((at || "").slice(0, 16))}">
          ${at ? `<button class="btn mini ghost" data-act="ics" data-pid="${esc(p.id)}">Calendar</button>` : ""}
          <button class="btn mini ghost" data-act="vcard" data-pid="${esc(p.id)}">iPhone contact</button>
          <button class="btn mini primary" data-act="call-done" data-pid="${esc(p.id)}">Done ✓</button></div></div>`;
    };
    return `<div class="page-intro">Before: the contact card for your iPhone, the calendar event with a 30-min reminder, the call sheet. After: "Done", then your recap.</div>
      <div class="net-grid"><div class="net-col">` +
      card("Upcoming", up.length, up.map(callRow).join("") || empty("No call booked.")) +
      (log.length ? card("Did it happen?", log.length, log.map(p => prow(p, fmtT(p.st.s.callBooked.call_at), `<button class="btn mini ghost" data-act="call-moved" data-pid="${esc(p.id)}">New date</button><button class="btn mini primary" data-act="call-done" data-pid="${esc(p.id)}">Done ✓</button>`)).join("")) : "") +
      `</div><div class="net-col">` +
      card("Calls done", done.length, done.map(p => {
        const recap = p.evs.filter(e => e.type === "note" && e.kind === "recap").pop();
        return prow(p, `${p.st.s.callDone.approx ? "~" : ""}${fmt(p.st.s.callDone.at)} · ${esc(p.st.label)}${recap ? `<br><span class="note">${esc(recap.text.slice(0, 160))}</span>` : ""}`, `<button class="btn mini ghost" data-person="${esc(p.id)}">Recap</button>`);
      }).join("") || empty("None yet.")) + `</div></div>`;
  };

  P.advice = () => {
    const list = (st.ov.advice || []).slice().reverse();
    const themes = {}; list.forEach(a => (themes[a.theme || "Other"] = themes[a.theme || "Other"] || []).push(a));
    return `<div class="page-intro">Advice from your calls. Kept apart from your tasks: send one to your future TO DO only when you decide to act on it.</div>` +
      card("Add advice", null, `<form class="addp" id="advice-form"><div class="addp-row"><input name="text" placeholder="The advice, in a few words" required><input name="from" placeholder="From (person)"><input name="theme" placeholder="Theme (CFA, modelling…)"></div><div class="comp-btns"><span class="grow"></span><button class="btn mini primary">Add</button></div></form>
        <div class="hint">From phase D, advice is pulled from each call recap automatically.</div>`) +
      Object.entries(themes).map(([th, items]) => card(esc(th), items.length, items.map(a => `<div class="row"><div class="row-main"><div class="row-title">${esc(a.text)}</div><div class="row-sub">${esc(a.from || "")} · ${fmt(a.at)}</div></div>
        <div class="row-side"><button class="btn mini ${a.to_todo ? "" : "ghost"}" data-advice="${esc(a.id)}">${a.to_todo ? "In TO DO ✓" : "Send to TO DO"}</button></div></div>`).join(""))).join("");
  };

  P.network = () => {
    const q = st.q.toLowerCase();
    if (st.netTab === "connections") {
      const list = st.m.network.filter(n => !q || (n.name + " " + n.headline).toLowerCase().includes(q));
      return tabs() + `<table class="ftable"><thead><tr><th>Name</th><th>Headline</th><th>Category</th><th>Role</th><th>Status</th></tr></thead><tbody>` +
        list.slice(0, 200).map(n => `<tr><td class="b">${esc(n.name)}</td><td>${esc(n.headline.slice(0, 90))}</td><td>${esc(n.category.replace(/^(.)\s–.*/, "$1"))}</td><td>P${n.lvl}</td>
          <td><span class="fstat ${n.messaged === "Yes" ? "on" : ""}">${esc(n.messaged === "Yes" ? "Messaged" : n.status)}</span></td></tr>`).join("") +
        `</tbody></table>${list.length > 200 ? `<div class="hint center">Showing 200 of ${list.length}. Use the search.</div>` : ""}`;
    }
    const stages = [...new Set(st.m.P.map(p => p.st.label))];
    const list = st.m.P.filter(p => (!st.stageF || p.st.label === st.stageF) && (!q || (p.name + " " + p.firm + " " + p.title).toLowerCase().includes(q)))
      .sort((a, b) => a.st.prio - b.st.prio || (b.st.lastContactAt || "").localeCompare(a.st.lastContactAt || ""));
    return tabs() + `<div class="seg wrap"><button class="seg-b ${!st.stageF ? "on" : ""}" data-stage="">All <span>${st.m.P.length}</span></button>${stages.map(s => `<button class="seg-b ${st.stageF === s ? "on" : ""}" data-stage="${esc(s)}">${esc(s)} <span>${st.m.P.filter(p => p.st.label === s).length}</span></button>`).join("")}</div>
      <table class="ftable"><thead><tr><th>Name</th><th>Firm</th><th>Stage</th><th>Next</th><th>Last contact</th><th>Channel</th></tr></thead><tbody>` +
      list.map(p => `<tr data-person="${esc(p.id)}" class="click"><td class="b">${esc(p.name)}</td><td>${esc(p.firm || "")}</td><td><span class="stage-chip">${esc(p.st.label)}</span>${p.st.paused ? ' <span class="muted small">paused</span>' : ""}</td>
        <td>${when(p.st.due)}</td><td>${esc(fmt(p.st.lastContactAt))}</td><td>${esc(CH[p.st.bestChannel] || p.st.bestChannel)}</td></tr>`).join("") + `</tbody></table>`;
  };
  const tabs = () => `<div class="tabs net-tabs"><button class="tab ${st.netTab === "people" ? "on" : ""}" data-nettab="people">People you track <span>${st.m.P.length}</span></button><button class="tab ${st.netTab === "connections" ? "on" : ""}" data-nettab="connections">LinkedIn connections <span>${st.m.network.length}</span></button></div>`;

  P.prompts = () => {
    const list = st.prompts.prompts || [], cur = list.find(p => p.id === st.promptSel) || list[0];
    if (!cur) return empty("No prompts yet.");
    const v = cur.versions[cur.versions.length - 1];
    return `<div class="page-intro">The instructions behind every message and document. Edit one and everything made after uses the new version. Code blocks (\`\`\`tu, \`\`\`vous, \`\`\`en) are the templates used for drafts.</div>
      <div class="prompt-grid"><div class="prompt-list">${list.map(p => `<button class="prompt-item ${p.id === cur.id ? "on" : ""}" data-prompt="${esc(p.id)}"><b>${esc(p.name)}</b><span>${esc(p.used_for)}</span><span class="muted small">v${p.versions.length} · ${fmt(p.versions[p.versions.length - 1].at)}</span></button>`).join("")}</div>
      <div class="prompt-edit"><textarea id="prompt-text" spellcheck="false">${esc(v.text)}</textarea>
        <div class="comp-btns"><span class="muted small">Version ${cur.versions.length}, ${esc(v.by)} · ${fmtT(v.at)}</span><span class="grow"></span><button class="btn mini primary" data-act="prompt-save">Save as new version</button></div>
        ${cur.versions.length > 1 ? `<div class="sub-head">Earlier versions</div>` + cur.versions.slice(0, -1).map((x, i) => `<div class="row"><div class="row-main"><div class="row-title">v${i + 1} · ${fmtT(x.at)} · ${esc(x.by)}</div></div><div class="row-side"><button class="btn mini ghost" data-restore="${i}">Restore</button></div></div>`).reverse().join("") : ""}
      </div></div>`;
  };

  P.stats = () => {
    const f = NetEngine.funnel(st.m, todayIso()), S = st.m.S;
    const pct = (a, b) => b ? Math.round(100 * a / b) + "%" : "–";
    const rows = f.rows.map(r => `<tr><td class="b">${fmt(r.week)}</td><td>${r.requests}</td><td>${r.accepted} <span class="muted">${pct(r.accepted, r.requests)}</span></td><td>${r.first}</td><td>${r.replies} <span class="muted">${pct(r.replies, r.first)}</span></td><td>${r.booked}</td><td>${r.calls}</td></tr>`).join("");
    const seg = Object.entries(f.seg).map(([k, [n, a]]) => kpi(`Acceptance · ${k}`, pct(a, n), `${a} of ${n} requests`)).join("");
    return `<div class="page-intro">Where people drop off, week by week. Dates imported from the Excel are partly estimated; from now on everything is exact.</div>` +
      card("Weekly funnel", null, `<table class="ftable"><thead><tr><th>Week of</th><th>Requests</th><th>Accepted</th><th>First messages</th><th>Replies</th><th>Calls booked</th><th>Calls done</th></tr></thead><tbody>${rows}</tbody></table>`) +
      `<div class="kpis three">${seg}</div><div class="hint">Senior / junior is recorded for every request you add from now on.</div>` +
      card("Limits", null, `<form id="settings-form" class="settings">${[["requestsDayMax", "Requests per day"], ["requests7dMax", "Requests per 7 days"], ["messagesDayMax", "LinkedIn messages per day"], ["networkPerDay", "Old connections per day"], ["followupDays", "Follow-up after (days)"], ["keepWarmDays", "Keep warm after (days)"]]
        .map(([k, l]) => `<label>${l}<input type="number" min="0" name="${k}" value="${S[k]}"></label>`).join("")}<button class="btn mini primary">Save</button></form>`);
  };

  // ------------------------------------------------------------ person sheet
  function openPerson(id) {
    const p = person(id); if (!p) return;
    const T = todayIso();
    const field = (k, label, ph = "") => `<label class="pf-edit"><span>${label}</span><input data-field="${k}" value="${esc(p[k] || "")}" placeholder="${esc(ph)}"></label>`;
    const LBL = { request_sent: "Request sent", accepted: "Accepted", message_sent: "Message sent", message_received: "Message received", call_booked: "Call booked", call_done: "Call done",
                  contact_logged: "Contact", closed: "Closed", reopened: "Reopened", withdrawn: "Request withdrawn / not pending", copied: "Copied", not_sent: "Not sent", note: "Note", handled: "No reply needed", skipped: "No need" };
    const tl = p.evs.slice().reverse().map(e => `<div class="tl ${e.type}"><div class="tl-d">${e.approx ? "~" : ""}${fmt(e.at)}</div><div class="tl-b"><b>${LBL[e.type] || e.type}</b>${e.kind ? ` · ${esc(e.kind.replace("_", " "))}` : ""}${e.channel ? ` · ${esc(CH[e.channel] || e.channel)}` : ""}${e.call_at ? ` · ${fmtT(e.call_at)}` : ""}${e.reason ? ` · ${esc(e.reason)}` : ""}
      ${e.text ? `<div class="tl-t">${esc(e.text)}</div>` : ""}</div>${e.source === "app" ? `<button class="tl-x" title="Undo" data-undo="${esc(e.id)}">×</button>` : ""}</div>`).join("");
    $("person").innerHTML = `<button class="pclose" data-close>×</button>
      <div class="ptitle">${esc(p.name)}</div><div class="psub">${esc(p.title)}${p.firm ? " · " + esc(p.firm) : ""}</div>
      <div class="pstage">${esc(p.st.label)}${p.st.due ? " · " + (p.st.due <= T ? "due" : fmt(p.st.due)) : ""}${p.st.paused ? " · paused" : ""}</div>
      <div class="pmeta">Best channel: <b>${esc(CH[p.st.bestChannel] || p.st.bestChannel)}</b>${p.st.lastContactAt ? ` · last contact ${fmt(p.st.lastContactAt)}` : ""}${p.introduced_by ? ` · referred by ${esc(p.introduced_by)}` : ""}</div>
      <div class="pbtns"><a class="btn mini ghost" href="${esc(profileUrl(p))}" target="_blank" rel="noopener">LinkedIn ↗</a>
        <button class="btn mini" data-pact="replied">They replied</button><button class="btn mini" data-pact="logged">Log contact</button>
        <button class="btn mini" data-pact="book">Book call</button><button class="btn mini" data-pact="note">Note</button>
        ${p.st.stage === "closed" ? `<button class="btn mini ghost" data-pact="reopen">Reopen</button>` : `<button class="btn mini ghost" data-pact="close">Close</button>`}</div>
      <div id="pact-box"></div>
      <div class="psec">Details</div><div class="pform">${field("firm", "Firm")}${field("title", "Title")}${field("linkedin", "LinkedIn URL", "https://www.linkedin.com/in/…")}${field("email", "E-mail")}${field("phone", "Phone")}${field("alumni", "Shared school")}
        <label class="pf-edit"><span>Seniority</span><select data-field="seniority">${["", "senior", "junior", "student"].map(s => `<option ${p.seniority === s ? "selected" : ""} value="${s}">${s || "–"}</option>`).join("")}</select></label>
        <label class="pf-edit"><span>Relationship</span><select data-field="relationship">${["", "friend", "classmate", "family", "not relevant"].map(s => `<option ${(p.relationship || "") === s ? "selected" : ""} value="${s}">${s || "networking contact"}</option>`).join("")}</select></label>
        <label class="pf-edit"><span>Language</span><select data-field="lang">${["FR", "EN"].map(s => `<option ${String(p.lang).toUpperCase() === s ? "selected" : ""}>${s}</option>`).join("")}</select></label></div>
      <div class="psec">LinkedIn profile <span class="muted small">(Cmd+A, Cmd+C on their profile, then paste)</span></div>
      <textarea class="ptext" id="profile-text" rows="4" placeholder="Paste the profile here: drafts will use it in phase C.">${esc((st.profiles || {})[p.id]?.text || "")}</textarea>
      <div class="comp-btns"><span class="grow"></span><button class="btn mini" data-pact="profile">Save profile</button></div>
      <div class="psec">History</div><div class="timeline">${tl || empty("Nothing yet.")}</div>
      ${(p.notes || []).length ? `<div class="psec">Notes from the Excel</div>` + p.notes.map(s => `<div class="pnote">${esc(s)}</div>`).join("") : ""}`;
    $("person-wrap").hidden = false; $("person").dataset.pid = id;
    if (st.profiles === null && !preview()) GH.readJson(PROFILES).then(x => { st.profiles = x || {}; const el = $("profile-text"); if (el && !el.value && st.profiles[id]) el.value = st.profiles[id].text; }).catch(() => {});
  }
  function personAction(act) {
    const id = $("person").dataset.pid, p = person(id), box = $("pact-box");
    const chSel = (def = "linkedin") => `<select name="ch">${Object.entries(CH).map(([k, v]) => `<option value="${k}" ${k === def ? "selected" : ""}>${v}</option>`).join("")}</select>`;
    const forms = {
      replied: `<form class="pact" data-do="replied"><div class="addp-row">${chSel(p.st.bestChannel)}<input type="datetime-local" name="at" value="${nowIso().slice(0, 16)}"></div><textarea name="text" rows="4" placeholder="Paste their message"></textarea><div class="comp-btns"><span class="grow"></span><button class="btn mini primary">Save</button></div></form>`,
      logged: `<form class="pact" data-do="logged"><div class="addp-row">${chSel("phone")}<input name="text" placeholder="What was it about? (optional)"></div><div class="comp-btns"><span class="grow"></span><button class="btn mini primary">Save</button></div></form>`,
      book: `<form class="pact" data-do="book"><div class="addp-row"><input type="datetime-local" name="at" required></div><div class="hint">Several calls the same day? Put them back to back, 15 min apart.</div><div class="comp-btns"><span class="grow"></span><button class="btn mini primary">Book</button></div></form>`,
      note: `<form class="pact" data-do="note"><textarea name="text" rows="3" placeholder="Note" required></textarea><label class="small"><input type="checkbox" name="recap"> This is a call recap</label><div class="comp-btns"><span class="grow"></span><button class="btn mini primary">Save</button></div></form>`,
    };
    if (forms[act]) { box.innerHTML = forms[act]; return; }
    if (act === "close") return addEvents([ev(id, "closed", { reason: "closed by you" })], "close " + p.name), openPerson(id);
    if (act === "reopen") return addEvents([ev(id, "reopened")], "reopen " + p.name), openPerson(id);
    if (act === "profile") {
      const text = $("profile-text").value.trim(); st.profiles = { ...(st.profiles || {}), [id]: { text, at: nowIso() } };
      save(PROFILES, d => ({ ...d, [id]: { text, at: nowIso() } }), "profile " + p.name); toast("Profile saved", true);
    }
  }
  function personForm(f) {
    const id = $("person").dataset.pid, p = person(id), x = Object.fromEntries(new FormData(f).entries());
    const at = x.at ? new Date(x.at).toISOString() : nowIso();
    if (f.dataset.do === "replied") addEvents([ev(id, "message_received", { channel: x.ch, text: x.text || "", at })], "reply from " + p.name);
    if (f.dataset.do === "logged") addEvents([ev(id, "contact_logged", { channel: x.ch, text: x.text || "" })], "contact " + p.name);
    if (f.dataset.do === "book") addEvents([ev(id, "call_booked", { call_at: x.at })], "call booked " + p.name);
    if (f.dataset.do === "note") addEvents([ev(id, "note", { text: x.text, ...(x.recap ? { kind: "recap" } : {}) })], "note " + p.name);
    openPerson(id);
  }

  // ------------------------------------------------------------ actions
  function onComposer(btn) {
    const box = btn.closest(".composer"), pid = box.dataset.pid, kind = box.dataset.kind, key = pid + ":" + kind;
    const text = box.querySelector(".comp-text").value, d = st.drafts[key] || {};
    if (btn.dataset.form) { st.drafts[key] = null; st.drafts[key] = { ...draftFor({ ...(person(pid) || netFake(box)), id: pid }, kind, btn.dataset.form) }; return render(); }
    if (btn.dataset.act === "close-comp") { st.open = null; return render(); }
    if (btn.dataset.act === "handled") { st.open = pid + ":reply:skip"; return render(); }
    if (btn.dataset.act === "copy") {
      navigator.clipboard?.writeText(text).catch(() => {});
      st.drafts[key] = { ...d, text };
      if (person(pid)) addEvents([ev(pid, "copied", { kind, text })], "copied message");
      else { btn.textContent = "Copied ✓"; }
      return toast("Copied. Paste it in LinkedIn, then press Sent ✓", true);
    }
    if (btn.dataset.act === "sent") {
      const e = ev(pid, "message_sent", { kind: kind === "reply" ? "reply" : kind, channel: btn.dataset.ch || "linkedin", text, ...(d.original && d.original !== text ? { draft: d.original } : {}), ...(d.ai ? { ai_draft: true } : {}) });
      if (box.dataset.net) {
        const n = st.m.network.find(x => x.key === box.dataset.net);
        newPerson({ id: pid, name: n.name, title: n.headline, firm: "", lang: "FR", alumni: n.school || "", origin: "network", seniority: "", notes: [] }, [e], "first message " + n.name);
      } else addEvents([e], `${kind} sent to ${person(pid).name}`);
      st.open = null; delete st.drafts[key]; render();
    }
  }
  const netFake = box => { const n = st.m.network.find(x => x.key === box.dataset.net) || {}; return { name: n.name, title: n.headline, alumni: n.school, lang: "FR", firm: "" }; };

  function onAddRequests(f) {
    const x = Object.fromEntries(new FormData(f).entries()), firm = st.m.firms.find(z => z.firm_id === f.dataset.firm);
    const added = [];
    [0, 1].forEach(i => {
      const url = (x["url" + i] || "").trim(), name = (x["name" + i] || "").trim() || nameFromUrl(url);
      if (!url && !name) return;
      const id = idFromUrl(url) || "p-" + NetEngine.nameKey(name).replace(/\s+/g, "-");
      const exists = person(id) || st.m.P.find(p => NetEngine.nameKey(p.name) === NetEngine.nameKey(name));
      if (exists) { addEvents([ev(exists.id, "request_sent", { channel: "linkedin" })], "request " + exists.name); added.push(exists.name); return; }
      newPerson({ id, name, title: "", firm: firm ? firm.firm : (x.firm || ""), firm_id: firm ? firm.firm_id : "", market: firm ? firm.market : "",
                  linkedin: url ? url.split("?")[0] : "", seniority: x["sen" + i], lang: "FR", introduced_by: x.by || "", origin: "app", notes: [] },
                [ev(id, "request_sent", { channel: "linkedin" })], "request " + name);
      added.push(name);
    });
    if (added.length) { st.open = null; render(); toast(`Recorded: ${added.join(", ")}`, true); }
  }

  function download(name, text, type) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function onClick(e) {
    const t = e.target;
    const op = t.closest("[data-open]"); if (op) { st.open = st.open === op.dataset.open ? null : op.dataset.open; return render(); }
    const cb = t.closest(".composer button"); if (cb) return onComposer(cb);
    const tk = t.closest("[data-task]"); if (tk) return setOv("tasks", tk.dataset.task, { status: "Fait", set_at: nowIso() }, "task done");
    const pp = t.closest("[data-person]"); if (pp) return openPerson(pp.dataset.person);
    const nt = t.closest("[data-nettab]"); if (nt) { st.netTab = nt.dataset.nettab; return render(); }
    const sg = t.closest("[data-stage]"); if (sg) { st.stageF = sg.dataset.stage; return render(); }
    const pr = t.closest("[data-prompt]"); if (pr) { st.promptSel = pr.dataset.prompt; return render(); }
    const rs = t.closest("[data-restore]"); if (rs) { const cur = st.prompts.prompts.find(p => p.id === st.promptSel); $("prompt-text").value = cur.versions[+rs.dataset.restore].text; return toast("Loaded. Press Save to make it the current version.", true); }
    const ad = t.closest("[data-advice]"); if (ad) { const list = (st.ov.advice || []).map(a => a.id === ad.dataset.advice ? { ...a, to_todo: !a.to_todo } : a); st.ov.advice = list; render(); return save(OVR, d => ({ ...d, advice: list }), "advice"); }
    const a = t.closest("[data-act]"); if (!a) return;
    const pid = a.dataset.pid, p = pid && person(pid);
    switch (a.dataset.act) {
      case "confirm": { const c = p.st.s.copied; return addEvents([ev(pid, "message_sent", { kind: c.kind, channel: "linkedin", text: c.text })], "sent"); }
      case "notsent": return addEvents([ev(pid, "not_sent")], "not sent");
      case "req-sent": return addEvents([ev(pid, "request_sent", { channel: "linkedin" })], "request " + p.name);
      case "accepted": return addEvents([ev(pid, "accepted")], "accepted " + p.name);
      case "withdrawn": return addEvents([ev(pid, "withdrawn")], "withdrawn " + p.name);
      case "call-done": return addEvents([ev(pid, "call_done")], "call done " + p.name);
      case "call-moved": return openPerson(pid), personAction("book");
      case "ics": return download(`Call ${p.name}.ics`, NetEngine.ics(p, p.st.s.callBooked.call_at), "text/calendar");
      case "vcard": return download(`${p.name}.vcf`, NetEngine.vcard(p), "text/vcard");
      case "iv-save": { const inp = document.querySelector(`input[data-iv="${a.dataset.iv}"]`); if (!inp.value) return; return setOv("interviews", a.dataset.iv, { at: inp.value, set_at: nowIso() }, "interview date"); }
      case "prompt-save": {
        const text = $("prompt-text").value, id = st.promptSel, v = { at: nowIso(), by: "you", text };
        const cur = st.prompts.prompts.find(x => x.id === id); cur.versions.push(v); st.drafts = {}; render(); toast("Saved as a new version", true);
        return save(PROMPTS, d => ({ ...d, prompts: (d.prompts || []).map(x => x.id === id ? { ...x, versions: [...x.versions, v] } : x) }), "prompt " + id);
      }
    }
  }
  function onChange(e) {
    const dt = e.target.closest("[data-calldt]");
    if (dt && dt.value) { const p = person(dt.dataset.calldt); addEvents([ev(p.id, "call_booked", { call_at: dt.value })], "call date " + p.name); }
  }
  function onSubmit(e) {
    const f = e.target; e.preventDefault();
    if (f.classList.contains("noneed")) {
      const x = Object.fromEntries(new FormData(f).entries()), pid = f.dataset.pid;
      if (!x.reason && !x.text) return toast("Pick a reason or write one");
      if (!person(pid) && f.dataset.net) {
        const n = st.m.network.find(z => z.key === f.dataset.net);
        newPerson({ ...netPerson(n), ...(NetEngine.PERSONAL.includes(x.reason) ? { relationship: x.reason, relationship_note: x.text || "" } : {}) },
          [ev(pid, "skipped", { task: "dormant", reason: (REASONS.find(r => r[0] === x.reason) || [, x.reason || ""])[1], text: x.text || "" })], "no need: " + n.name);
        st.open = null; return render();
      }
      const p = person(pid);
      const label = (REASONS.find(r => r[0] === x.reason) || [, x.reason || ""])[1];
      st.open = null;
      if (NetEngine.PERSONAL.includes(x.reason)) patchPerson(pid, { relationship: x.reason, relationship_note: x.text || "" }, "relationship " + p.name);
      return addEvents([ev(pid, "skipped", { task: f.dataset.skiptask, reason: label, text: x.text || "" })], "no need: " + p.name);
    }
    if (f.classList.contains("addp") && f.id !== "advice-form") return onAddRequests(f);
    if (f.id === "advice-form") {
      const x = Object.fromEntries(new FormData(f).entries()), a = { id: uid(), text: x.text, from: x.from, theme: x.theme, at: nowIso(), to_todo: false };
      st.ov.advice = [...(st.ov.advice || []), a]; render(); return save(OVR, d => ({ ...d, advice: [...(d.advice || []), a] }), "advice");
    }
    if (f.id === "sent-sync") {
      const r = NetEngine.syncSent(st.m, new FormData(f).get("text"), todayIso(), nowIso(), uid);
      if (!r) return toast("Couldn't read the page. Copy the whole Sent page and paste it again.");
      const w = r.events.filter(e => e.type === "withdrawn").length, a = r.events.filter(e => e.type === "request_sent").length;
      const pn = Object.fromEntries(r.people.map(p => [p.id, p])), at = nowIso();
      st.ov.people_new = { ...(st.ov.people_new || {}), ...pn }; st.ov.events = [...(st.ov.events || []), ...r.events]; st.ov.sent_sync_at = at; model(); render();
      toast(`${r.list.length} pending on LinkedIn · ${w} marked withdrawn · ${a} added`, true);
      return save(OVR, d => ({ ...d, people_new: { ...(d.people_new || {}), ...pn }, events: [...(d.events || []), ...r.events], sent_sync_at: at }), "sync sent invitations");
    }
    if (f.id === "settings-form") {
      const x = Object.fromEntries([...new FormData(f).entries()].map(([k, v]) => [k, +v]));
      st.ov.settings = { ...(st.ov.settings || {}), ...x }; model(); render(); toast("Saved", true);
      return save(OVR, d => ({ ...d, settings: { ...(d.settings || {}), ...x } }), "settings");
    }
  }

  // ------------------------------------------------------------ render
  function badges() {
    const t = st.m.today;
    const n = { today: t.replies.length + t.callLog.length + t.copies.length + t.interviews.filter(x => !x.at).length,
                requests: st.m.counters.reqLeft ? t.firms.length + t.referred.length : 0, replies: t.replies.length,
                cold: t.first.length + t.followups.length + t.network.length, thanks: t.thanks.length + t.keepWarm.length,
                calls: st.m.P.filter(p => p.st.stage === "call" || p.st.stage === "call_log").length };
    Object.entries(n).forEach(([k, v]) => { const el = $("nb-" + k); if (el) el.textContent = v || ""; });
  }
  function render() {
    if (!st.m) return;
    const page = st.page, label = (PAGES.find(p => p[0] === page) || PAGES[0])[1];
    $("net-title").textContent = label;
    const li = st.base.linkedin_import;
    $("net-fresh").textContent = `Networking · ${li ? "LinkedIn messages up to " + fmtT(li.messages_until) : "data " + fmtT(st.base.generated_at)}`;
    $("net-search").hidden = page !== "network";
    const y = window.scrollY;
    try { $("net-body").innerHTML = (P[page] || P.today)(); }
    catch (e) { console.error(e); $("net-body").innerHTML = `<div class="empty error">This page hit a bug: ${esc(e.message)}. The other pages still work. Send me a screenshot.</div>`; }
    window.scrollTo(0, y);
    badges();
    document.querySelectorAll(".nav-sub a").forEach(a => a.classList.toggle("active", a.dataset.page === page));
    if (!$("person-wrap").hidden && $("person").dataset.pid && document.activeElement?.closest?.("#person") == null) openPerson($("person").dataset.pid);
  }
  function toast(m, ok) { const t = $("toast"); t.textContent = m; t.className = "toast " + (ok ? "ok" : "bad"); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }

  let bound = false;
  function bind() {
    $("net-search").addEventListener("input", e => { st.q = e.target.value; render(); });
    $("net-body").addEventListener("click", onClick);
    $("net-body").addEventListener("change", onChange);
    $("net-body").addEventListener("submit", onSubmit);
    $("net-body").addEventListener("input", e => { const ta = e.target.closest(".comp-text"); if (ta) { const box = ta.closest(".composer"), k = box.dataset.pid + ":" + box.dataset.kind; st.drafts[k] = { ...(st.drafts[k] || {}), text: ta.value }; } });
    $("person-wrap").addEventListener("click", e => {
      if (e.target.id === "person-wrap" || e.target.closest("[data-close]")) { $("person-wrap").hidden = true; return; }
      const pa = e.target.closest("[data-pact]"); if (pa) return personAction(pa.dataset.pact);
      const un = e.target.closest("[data-undo]"); if (un) { const id = un.dataset.undo; st.ov.deleted_events = [...(st.ov.deleted_events || []), id]; model(); render(); openPerson($("person").dataset.pid); return save(OVR, d => ({ ...d, deleted_events: [...(d.deleted_events || []), id] }), "undo"); }
    });
    $("person-wrap").addEventListener("submit", e => { e.preventDefault(); personForm(e.target); });
    $("person-wrap").addEventListener("change", e => { const f = e.target.closest("[data-field]"); if (f) patchPerson($("person").dataset.pid, { [f.dataset.field]: f.value.trim() }, "edit person"); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") $("person-wrap").hidden = true; });
  }
  async function show(page) {
    if (!bound) { bind(); bound = true; }
    const next = PAGES.some(p => p[0] === page) ? page : "today";
    if (next !== st.page) { st.open = null; st.q = ""; $("net-search").value = ""; }
    st.page = next;
    if (!st.m) await load();
    render(); window.scrollTo(0, 0);
  }
  async function refresh() { await load(); render(); }
  const signature = () => st.base ? `${(st.inbox && st.inbox.device || {}).last_run}|${st.base.generated_at}|${(st.base.linkedin_import || {}).at}|${st.base.events.length}|${(st.ov.events || []).length}|${JSON.stringify(st.ov).length}` : "";
  return { show, render, load, refresh, PAGES, signature };
})();
