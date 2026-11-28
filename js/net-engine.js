/* Networking engine: turns people + events into stages, due dates, Today and the weekly funnel.
   Nothing here talks to GitHub; networking.js feeds it the data. */
const NetEngine = (() => {
  const DAY = 864e5;
  const D = s => new Date(String(s).slice(0, 10) + "T12:00");
  const isoDay = x => { const y = new Date(x); return `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`; };
  const addDays = (s, n) => { const x = D(s); x.setDate(x.getDate() + n); return isoDay(x); };
  const diff = (a, b) => Math.round((D(b) - D(a)) / DAY);
  const day = s => String(s || "").slice(0, 10);
  const sd = s => D(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  const DEFAULTS = { requestsDayMax: 12, requests7dMax: 80, messagesDayMax: 18, networkPerDay: 5,
                     followupDays: 10, keepWarmDays: 56, withdrawDays: 21, perFirm: 2 };

  /* Firm names written in different ways must match ("ODDO BHF AM" / "ODDO BHF Asset Management") */
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, " ").replace(/&/g, " and ")
    .replace(/\b(sa|sas|sarl|ag|ltd|llp|plc|inc|gmbh|group|groupe|the|and co|co)\b\.?/g, " ")
    .replace(/\b(asset management|investment managers?|investment management|gestion)\b/g, " am ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const GENERIC = /\b(paris|geneve|geneva|luxembourg|lux|france|europe|suisse|switzerland|schweiz|belgique|belgium|bruxelles|brussels|london|londres|uk|international|s a|sa)\b/g;
  const firmKey = s => norm(s).replace(GENERIC, " ").replace(/\s+/g, " ").trim();
  const firmMatch = (a, b) => { const x = firmKey(a), y = firmKey(b); return !!x && x === y; };
  const nameKey = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]+/g, " ").trim();

  /* Rough role priority from a headline (same ladder as MyOffers: P1 best … P8 risk) */
  function levelOf(h) {
    h = String(h || "").toLowerCase();
    if (/\b(risk|risque|compliance|audit)\b/.test(h)) return 8;
    if (/(private bank|banque priv|wealth|gestion de fortune|gestion privée)/.test(h)) return 7;
    if (/(equity research|research analyst|buy[- ]side|portfolio manager|gérant|fund manager|equity analyst|analyste actions|stock picking|long[/ ]short)/.test(h)) return 1;
    if (/(asset management|investment analyst|gestion d'actifs|\bam\b|pm assistant|assistant pm)/.test(h)) return 2;
    if (/(private debt|direct lending|credit|crédit|fixed income|leveraged finance|\bdcm\b|debt)/.test(h)) return 3;
    if (/(m&a|investment banking|\bib\b|private equity|transaction services|\becm\b|venture|corporate finance)/.test(h)) return 5;
    return 6;
  }
  const PERSONAL = ["friend", "classmate", "family", "not relevant"];
  const isStudent = t => /\b(intern|stagiaire|stage|student|étudiant|etudiant|alternant|apprenti|trainee)\b/i.test(t || "");

  /* -------------------------------------------------------------- merge */
  function merge(base, ov) {
    const people = new Map();
    (base.people || []).forEach(p => people.set(p.id, { ...p, origin: p.origin || "excel" }));
    Object.entries(ov.people_new || {}).forEach(([id, p]) => people.set(id, { ...p, id }));
    Object.entries(ov.people || {}).forEach(([id, patch]) => { if (people.has(id)) people.set(id, { ...people.get(id), ...patch }); });
    const hidden = new Set(ov.deleted_events || []);
    const seen = new Set(), events = [];
    [...(base.events || []), ...(ov.events || [])].forEach(e => { if (!seen.has(e.id) && !hidden.has(e.id)) { seen.add(e.id); events.push(e); } });
    events.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
    const byPerson = new Map();
    events.forEach(e => { if (!byPerson.has(e.person)) byPerson.set(e.person, []); byPerson.get(e.person).push(e); });
    return { people, events, byPerson };
  }

  /* -------------------------------------------------------------- one person */
  function derive(p, evs, today, S) {
    const s = { req: null, acc: null, withdrawn: null, out: [], lastSent: null, lastRecv: null, lastContact: null,
                callBooked: null, callDone: null, thanked: null, keepWarm: null, closed: null, copied: null, channels: {} };
    for (const e of evs) {
      switch (e.type) {
        case "request_sent": s.req = e; s.withdrawn = null; break;
        case "withdrawn": s.withdrawn = e; break;
        case "accepted": s.acc = e; break;
        case "message_sent":
          s.lastSent = e; s.lastContact = e; s.copied = null;
          if (e.kind === "first" || e.kind === "followup") s.out.push(e);
          if (e.kind === "thanks") s.thanked = e;
          if (e.kind === "keep_warm") s.keepWarm = e;
          break;
        case "message_received":
          s.lastRecv = e; s.lastContact = e; s.closed = null;
          s.channels[e.channel || "linkedin"] = (s.channels[e.channel || "linkedin"] || 0) + 1; break;
        case "contact_logged": s.lastContact = e; break;
        case "call_booked": s.callBooked = e; break;
        case "call_done": s.callDone = e; s.lastContact = e; s.callBooked = null; s.thanked = null; break;
        case "closed": s.closed = e; break;
        case "reopened": s.closed = null; break;
        case "copied": s.copied = e; break;
        case "handled": s.handled = e; break;
        case "skipped":   // "No need" on a task: resolves that task, with a reason
          if (["reply", "talking"].includes(e.task)) s.handled = e;
          else if (e.task === "thanks") s.thanked = e;
          else if (e.task === "keep_warm") s.lastContact = e;
          else if (e.task === "withdraw") s.withdrawn = e;
          else s.closed = { ...e, reason: e.reason || "no need" };
          break;
        case "not_sent": s.copied = null; break;
      }
    }
    const best = Object.entries(s.channels).sort((a, b) => b[1] - a[1])[0];
    const r = { stage: "to_contact", label: "To contact", due: null, prio: 9, info: "", s,
                bestChannel: best ? best[0] : (p.channel || "linkedin").toLowerCase(),
                lastContactAt: s.lastContact ? day(s.lastContact.at) : null };
    const set = (stage, label, due, prio, info = "") => Object.assign(r, { stage, label, due, prio, info });

    if (PERSONAL.includes(p.relationship)) return set("personal", `${p.relationship[0].toUpperCase() + p.relationship.slice(1)}: not tracked`, null, 98, p.relationship_note || "");
    if (s.closed) return set("closed", "Closed", null, 99, s.closed.reason || "");
    const recvOpen = s.lastRecv && (!s.lastSent || s.lastRecv.at >= s.lastSent.at) && !(s.handled && s.handled.at >= s.lastRecv.at)
      && !(s.callDone && day(s.callDone.at) >= day(s.lastRecv.at)) && !(s.callBooked && day(s.callBooked.at) >= day(s.lastRecv.at))
      && diff(s.lastRecv.at, today) <= 30;
    if (recvOpen) return set("reply", "Reply to send", day(s.lastRecv.at), 1, `They wrote ${sd(s.lastRecv.at)}`);
    if (s.callBooked) {
      const at = s.callBooked.call_at || "";
      if (at && day(at) < today) return set("call_log", "Did the call happen?", day(at), 1);
      return set("call", at ? "Call booked" : "Call: date to set", at ? day(at) : null, 2);
    }
    if (s.callDone && !s.thanked) return set("thanks", "Thank-you to send", addDays(s.callDone.at, 1), 2, `Call ${sd(s.callDone.at)}`);
    if (s.callDone) return set("keep_warm", "Keep warm", addDays(r.lastContactAt, S.keepWarmDays), 5, `Last contact ${sd(r.lastContactAt)}`);
    if (s.lastRecv) {
      const since = s.lastSent && s.lastSent.at > s.lastRecv.at ? s.lastSent.at : s.lastRecv.at;
      return set("talking", "In conversation", diff(since, today) > 40 ? null : addDays(since, S.followupDays), 6, s.lastSent && s.lastSent.at > s.lastRecv.at ? `You wrote last · ${sd(s.lastSent.at)}` : `Done for now · ${sd(since)}`);
    }
    const li = s.out.filter(e => (e.channel || "linkedin") === "linkedin").length, mail = s.out.length - li;
    if (li >= 2 || mail > 0) return set("third", "3rd outreach (e-mail, on hold)", null, 50, mail ? "E-mail already sent" : "No reply after the follow-up");
    if (li === 1 && diff(s.out[0].at, today) > S.followupDays + 21) return set("third", "3rd outreach (e-mail, on hold)", null, 50, `No reply since ${sd(s.out[0].at)}`);
    if (li === 1) return set("followup", "Follow-up", addDays(s.out[0].at, S.followupDays), 4, `First message ${sd(s.out[0].at)}`);
    if (s.acc && diff(s.acc.at, today) > 30) return set("dormant", "Connected, never messaged", null, 45, `Connected ${sd(s.acc.at)}`);
    if (s.acc || (!s.req && p.origin !== "excel") || (!s.req && s.lastContact))
      return set("first", "First message", s.acc ? addDays(s.acc.at, 1) : today, 3, s.acc ? `Accepted ${sd(s.acc.at)}` : "Already connected");
    if (s.req && !s.withdrawn) {
      const age = diff(s.req.at, today);
      if (age >= S.withdrawDays) return set("withdraw", "Not accepted: withdraw?", today, 20, `Sent ${sd(s.req.at)} · ${age} days`);
      return set("pending", "Waiting for acceptance", null, 30, `Sent ${sd(s.req.at)} · day ${age}`);
    }
    if (s.withdrawn) return set("withdrawn", "Withdrawn", addDays(s.withdrawn.at, 21), 60, "Can be invited again after 3 weeks");
    return set("to_contact", p.introduced_by ? "Referred: send a request" : "To contact", null, p.introduced_by ? 3 : 40);
  }

  /* -------------------------------------------------------------- everything */
  function build(base, ov, offersExp, today) {
    const S = { ...DEFAULTS, ...(ov.settings || {}) };
    const { people, events, byPerson } = merge(base, ov);
    const P = [];
    people.forEach(p => { const st = derive(p, byPerson.get(p.id) || [], today, S); P.push({ ...p, st, evs: byPerson.get(p.id) || [] }); });

    // One active conversation per firm: once someone answered, cold messages to colleagues wait
    const engaged = new Map();
    P.forEach(p => { if (["reply", "call", "call_log", "thanks"].includes(p.st.stage) && p.firm) engaged.set(firmKey(p.firm), p); });
    P.forEach(p => {
      if (!["first", "followup"].includes(p.st.stage) || !p.firm) return;
      const o = engaged.get(firmKey(p.firm));
      if (o && o.id !== p.id) p.st.paused = `${o.name} at ${p.firm} already answered`;
    });

    // Counters
    const sentToday = events.filter(e => e.type === "message_sent" && day(e.at) === today && (e.channel || "linkedin") === "linkedin").length;
    const reqToday = events.filter(e => e.type === "request_sent" && day(e.at) === today).length;
    const req7d = events.filter(e => e.type === "request_sent" && diff(e.at, today) < 7 && diff(e.at, today) >= 0).length;
    const reqLeft = Math.max(0, Math.min(S.requestsDayMax - reqToday, S.requests7dMax - req7d));
    const msgLeft = Math.max(0, S.messagesDayMax - sentToday);

    // MyOffers links: firms with an open offer to apply to, or a recent application
    const offers = (offersExp && offersExp.offers) || [];
    const offerFor = firm => offers.filter(o => o.active !== false && firmMatch(o.company, firm));

    // Firms to contact today
    const peopleAt = firm => P.filter(p => p.firm && firmMatch(p.firm, firm));
    const firms = (base.firms || []).filter(f => f.status !== "Skipped").map(f => {
      const at = peopleAt(f.firm).filter(p => p.st.stage !== "closed");
      const active = at.filter(p => !["withdraw", "withdrawn", "third"].includes(p.st.stage));
      const of = offerFor(f.firm);
      const toApply = of.filter(o => o.status === "apply" && (o.level || 6) <= 4);
      const applied = of.filter(o => o.status === "applied" && o.status_at && diff(o.status_at, today) <= 14);
      let boost = 0, why = "";
      if (/recommand|recommended|referr/i.test(f.notes || "")) { boost = 3; why = (f.notes.match(/Recommand[ée]+ par [^|(]+/i) || ["Recommended in a call"])[0].trim(); }
      else if (toApply.length) { boost = 2; why = `Open offer: ${toApply[0].title.split(/ (?:Kepler|·)/)[0].slice(0, 60)} (network before applying)`; }
      else if (applied.length) { boost = 1; why = `Applied ${applied[0].status_at}`; }
      return { ...f, at, active, boost, why, covered: active.length >= S.perFirm, newWave: at.length > 0 && active.length === 0 };
    });
    const firmsToday = firms.filter(f => !f.covered && (f.status === "To research" || f.newWave || f.boost))
      .sort((a, b) => b.boost - a.boost || (a.newWave - b.newWave) || (a.rank || 9999) - (b.rank || 9999));

    // Old connections to message today (by role priority)
    const known = new Set(P.map(p => nameKey(p.name)));
    const catRank = c => /^A/.test(c) ? 0 : /^B/.test(c) ? 1 : /^C/.test(c) ? 2 : 9;
    const network = (base.network || []).map(n => ({ ...n, key: nameKey(n.name), lvl: levelOf(n.headline), cr: catRank(n.category) }));
    const netCandidates = network.filter(n => n.status === "To message" && n.messaged !== "Yes" && !known.has(n.key) && n.cr < 9)
      .sort((a, b) => a.cr - b.cr || a.lvl - b.lvl);
    const netDoneToday = P.filter(p => p.evs.some(e => e.type === "message_sent" && e.kind === "first" && day(e.at) === today)
      && (p.origin === "network" || (p.st.s.acc && diff(p.st.s.acc.at, today) > 30))).length;

    // Interviews that need a date
    const ivDone = ov.interviews || {};
    const interviews = [];
    offers.forEach(o => { if (o.status === "interview") interviews.push({ offer: o, type: "Interview" }); });
    ((offersExp && offersExp.actions) || []).forEach(a => {
      if (!a.done && /interview|assessment/i.test(a.type) && !interviews.some(x => x.offer.offer_id === a.offer_id))
        interviews.push({ offer: offers.find(o => o.offer_id === a.offer_id) || { offer_id: a.offer_id, company: a.company, title: a.title }, type: a.label || "Interview" });
    });
    interviews.forEach(x => { x.at = (ivDone[x.offer.offer_id] || {}).at || ""; x.contacts = peopleAt(x.offer.company).filter(p => p.st.stage !== "closed"); });

    const due = st => st.due && st.due <= today;
    const by = (f, sort = (a, b) => (a.st.due || "").localeCompare(b.st.due || "")) => P.filter(f).sort(sort);
    const today_ = {
      replies: by(p => p.st.stage === "reply"),
      callLog: by(p => p.st.stage === "call_log"),
      copies: by(p => p.st.s.copied),
      interviews: interviews.filter(x => !x.at || day(x.at) >= today),
      calls: by(p => p.st.stage === "call" && p.st.due && diff(today, p.st.due) <= 1 && p.st.due >= today),
      thanks: by(p => p.st.stage === "thanks" && due(p.st)),
      first: by(p => p.st.stage === "first" && due(p.st) && !p.st.paused),
      followups: by(p => p.st.stage === "followup" && due(p.st) && !p.st.paused),
      keepWarm: by(p => p.st.stage === "keep_warm" && due(p.st)),
      dormant: by(p => p.st.stage === "dormant", (a, b) => levelOf(a.title) - levelOf(b.title)).slice(0, Math.max(0, S.networkPerDay - netDoneToday)),
      network: [],
      referred: by(p => p.st.stage === "to_contact" && p.introduced_by),
      firms: firmsToday.slice(0, Math.max(3, Math.ceil(reqLeft / 2))),
      withdraw: by(p => p.st.stage === "withdraw").slice(0, 10),
      nudges: by(p => p.st.stage === "talking" && due(p.st) && p.st.info.startsWith("You wrote last")),
    };
    today_.network = netCandidates.slice(0, Math.max(0, S.networkPerDay - netDoneToday - today_.dormant.length));
    const tasks = (base.tasks || []).map(t => ({ ...t, status: (ov.tasks || {})[t.id]?.status || t.status }));
    today_.tasks = tasks.filter(t => t.status === "À faire" && t.due && t.due <= today);

    return { S, P, events, people, firms, firmsToday, network, netCandidates, interviews, tasks, today: today_,
             counters: { sentToday, reqToday, req7d, reqLeft, msgLeft, netDoneToday } };
  }

  /* -------------------------------------------------------------- LinkedIn "Sent invitations" page, pasted
     The archive lists every request ever sent (withdrawn ones too), so the only truth for "still pending"
     is LinkedIn's My Network → Manage → Sent page. */
  const cleanName = n => String(n || "").replace(/\(.*?\)/g, " ").split(",")[0].trim();
  function parseSent(text) {
    const L = String(text || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean), out = [];
    L.forEach((l, i) => {
      const m = l.match(/^Sent (\d+|an?|one) (hour|day|week|month)s? ago$/i) || (/^Sent (today|yesterday)$/i.test(l) ? [l, l.split(" ")[1], "day"] : null);
      if (!m || i < 2) return;
      const n = /^(an?|one|today)$/i.test(m[1]) ? (/today/i.test(m[1]) ? 0 : 1) : /yesterday/i.test(m[1]) ? 1 : +m[1];
      const days = { hour: 0, day: 1, week: 7, month: 30 }[m[2].toLowerCase()] * n;
      const name = L[i - 2] === "Withdraw" ? L[i - 1] : L[i - 2], headline = L[i - 2] === "Withdraw" ? "" : L[i - 1];
      out.push({ name: cleanName(name), headline, days });
    });
    return out;
  }
  function syncSent(model, text, today, nowIso, uid) {
    const list = parseSent(text);
    if (!list.length) return null;
    const keyOf = n => nameKey(cleanName(n));
    const inList = new Map(list.map(x => [keyOf(x.name), x]));
    const events = [], people = [];
    model.P.forEach(p => {
      if (!["pending", "withdraw"].includes(p.st.stage)) return;
      if (!inList.has(keyOf(p.name))) events.push({ id: uid(), person: p.id, type: "withdrawn", at: nowIso, source: "sync", reason: "not in LinkedIn's sent list" });
    });
    const known = new Map(model.P.map(p => [keyOf(p.name), p]));
    list.forEach(x => {
      const p = known.get(keyOf(x.name)), at = addDays(today, -x.days);
      if (p && ["pending", "withdraw"].includes(p.st.stage)) return;
      if (p && p.st.s.req && !p.st.s.withdrawn) return;
      const id = p ? p.id : "p-" + keyOf(x.name).replace(/\s+/g, "-");
      if (!p) people.push({ id, name: x.name, title: x.headline, firm: "", lang: "FR", seniority: "", origin: "app", notes: [] });
      events.push({ id: uid(), person: id, type: "request_sent", at, approx: true, source: "sync", channel: "linkedin" });
    });
    return { list, events, people };
  }

  /* -------------------------------------------------------------- weekly funnel */
  function funnel(model, today, weeks = 6) {
    const monday = s => { const x = D(s); const k = (x.getDay() + 6) % 7; x.setDate(x.getDate() - k); return isoDay(x); };
    const w0 = monday(today), rows = [];
    for (let i = weeks - 1; i >= 0; i--) rows.push({ week: addDays(w0, -7 * i), requests: 0, accepted: 0, first: 0, replies: 0, booked: 0, calls: 0 });
    const idx = new Map(rows.map((r, i) => [r.week, i]));
    const replied = new Set();
    model.events.forEach(e => {
      if (e.approx && e.type !== "request_sent" && e.type !== "message_sent") return;
      const r = rows[idx.get(monday(e.at))]; if (!r) return;
      if (e.type === "request_sent") r.requests++;
      else if (e.type === "accepted") r.accepted++;
      else if (e.type === "message_sent" && e.kind === "first") r.first++;
      else if (e.type === "message_received" && !replied.has(e.person + r.week)) { replied.add(e.person + r.week); r.replies++; }
      else if (e.type === "call_booked") r.booked++;
      else if (e.type === "call_done") r.calls++;
    });
    // Acceptance by seniority (people with a request)
    const seg = { senior: [0, 0], junior: [0, 0], student: [0, 0] };
    model.P.forEach(p => {
      if (!p.st.s.req) return;
      const k = p.seniority === "senior" ? "senior" : (p.seniority === "student" || isStudent(p.title)) ? "student" : "junior";
      seg[k][0]++; if (p.st.s.acc) seg[k][1]++;
    });
    return { rows, seg };
  }

  /* -------------------------------------------------------------- message templates */
  function templates(promptText) {
    const out = {}, re = /```(\w+)\n([\s\S]*?)```/g; let m;
    while ((m = re.exec(promptText || ""))) out[m[1]] = m[2].replace(/\s+$/, "");
    return out;
  }
  function form(p) {
    if (String(p.lang || "").toUpperCase() === "EN") return "en";
    return (p.seniority === "student" || isStudent(p.title)) ? "tu" : "vous";
  }
  function fill(tpl, p) {
    const parts = String(p.name || "").trim().split(/\s+/);
    const first = parts[0] || "", last = parts.slice(1).join(" ");
    const role = String(p.title || "").split(/\s(?:at|chez|@)\s|,|\s[–|]\s/i)[0].trim();
    return tpl.replace(/\[Prénom\]/g, first).replace(/\[Nom\]/g, last)
      .replace(/\[firme\]/g, p.firm || "[firme]").replace(/\[métier\]/g, role || "[métier]")
      .replace(/\[école\]/g, p.alumni || "[école]");
  }
  const unresolved = text => [...new Set((String(text).match(/\[[^\]\n]{2,60}\]/g) || []))];

  /* -------------------------------------------------------------- calendar + contact files */
  const icsEsc = s => String(s || "").replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
  function ics(p, at, minutes = 30) {
    const st = new Date(at), en = new Date(st.getTime() + minutes * 6e4);
    const f = x => x.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MyApp//Networking//EN", "BEGIN:VEVENT",
      `UID:myapp-${p.id}-${f(st)}@myapp`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(st)}`, `DTEND:${f(en)}`,
      `SUMMARY:${icsEsc(`Call ${p.name}${p.firm ? " – " + p.firm : ""}`)}`,
      `DESCRIPTION:${icsEsc(`${p.title || ""}\nPrep: MyApp → Networking → Calls${p.phone ? "\nPhone: " + p.phone : ""}`)}`,
      "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc("Call in 30 min: " + p.name)}`, "END:VALARM",
      "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  }
  function vcard(p) {
    const parts = String(p.name || "").trim().split(/\s+/), first = parts[0] || "", last = parts.slice(1).join(" ");
    return ["BEGIN:VCARD", "VERSION:3.0", `N:${last};${first};;;`, `FN:${p.name}${p.firm ? " – " + p.firm : ""}`,
      p.firm ? `ORG:${p.firm}` : "", p.title ? `TITLE:${p.title}` : "", p.phone ? `TEL;TYPE=CELL:${p.phone}` : "",
      p.email ? `EMAIL:${p.email}` : "", p.linkedin ? `URL:${p.linkedin}` : "", "NOTE:Networking (MyApp)", "END:VCARD"]
      .filter(Boolean).join("\r\n");
  }

  return { build, funnel, templates, fill, form, unresolved, ics, vcard, levelOf, firmMatch, norm, nameKey,
           addDays, diff, day, isoDay, DEFAULTS, PERSONAL, parseSent, syncSent };
})();
