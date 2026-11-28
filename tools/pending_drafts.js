#!/usr/bin/env node
/* Lists the messages that need a draft right now, with everything needed to write them.
   Usage: node tools/pending_drafts.js <path to the MyOffers repo> [YYYY-MM-DD] [max]
   Output (stdout): JSON array. Used by the scheduled Claude task (phase C). No personal data in this file. */
const fs = require("fs"), path = require("path");
const repo = process.argv[2] || "../MyOffers";
const today = process.argv[3] || new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const max = +(process.argv[4] || 25);
eval(fs.readFileSync(path.join(__dirname, "../js/net-engine.js"), "utf8") + ";global.NetEngine = NetEngine;");
const rd = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(path.join(repo, f), "utf8")); } catch { return d; } };
const base = rd("export/networking.json"), ov = rd("state/networking_overrides.json"), offers = rd("export/offers.json");
const inbox = rd("state/networking_inbox_mac.json", null), drafts = rd("state/networking_drafts.json", { drafts: {} }).drafts || {};
const profiles = rd("state/networking_profiles.json");
const prompts = rd("state/networking_prompts.json", { prompts: [] }).prompts;
const m = NetEngine.build(base, ov, offers, today, inbox);
const t = m.today;
const PROMPT = { reply: "reply", first: "first_message", followup: "followup", thanks: "thanks", keep_warm: "keep_warm" };

const wanted = [...t.replies, ...t.nudges, ...m.P.filter(p => p.st.stage === "thanks"), ...t.first, ...t.followups, ...t.keepWarm, ...t.dormant];
const seen = new Set(), out = [];
for (const p of wanted) {
  const key = NetEngine.draftKey(p);
  if (!key || seen.has(key) || drafts[key]) continue;
  seen.add(key);
  const kind = NetEngine.DRAFT_KIND[p.st.stage];
  if (kind === "first" && !(profiles[p.id] || {}).text) continue; // his rule: no profile, no first message
  const conv = p.evs.filter(e => ["message_sent", "message_received", "call_done", "call_booked", "note", "contact_logged"].includes(e.type))
    .slice(-14).map(e => ({ at: e.at, type: e.type, channel: e.channel, kind: e.kind, text: (e.text || "").slice(0, 1500), ...(e.digest ? { note: "LinkedIn e-mail notice: text not available" } : {}) }));
  out.push({
    key, kind, prompt_id: PROMPT[kind], stage: p.st.stage, reason: p.st.info,
    form: NetEngine.form(p), channel: kind === "reply" || kind === "keep_warm" ? p.st.bestChannel : "linkedin",
    person: { id: p.id, name: p.name, title: p.title, firm: p.firm, lang: p.lang, seniority: p.seniority, alumni: p.alumni,
              introduced_by: p.introduced_by, relationship: p.relationship || "", notes: (p.notes || []).slice(-6) },
    profile: (profiles[p.id] || {}).text || "",
    conversation: conv,
  });
  if (out.length >= max) break;
}
const promptTexts = Object.fromEntries(prompts.map(x => [x.id, x.versions[x.versions.length - 1].text]));
console.log(JSON.stringify({ today, count: out.length, prompts: promptTexts, items: out }, null, 1));
