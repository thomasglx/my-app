#!/usr/bin/env node
/* Who still needs a profile, most urgent first (same order as the capture bar in the app).
   Usage: node tools/profile_queue.js <path to the MyOffers repo> [max]  → JSON on stdout.
   Read by the Mac agent (People Data Labs) and by the scheduled Claude run (web lookup). No personal data in this file. */
const fs = require("fs"), path = require("path");
const repo = process.argv[2] || "../MyOffers", max = +(process.argv[3] || 400);
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
eval(fs.readFileSync(path.join(__dirname, "../js/net-engine.js"), "utf8") + ";global.NetEngine = NetEngine;");
const rd = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(path.join(repo, f), "utf8")); } catch { return d; } };
const m = NetEngine.build(rd("export/networking.json"), rd("state/networking_overrides.json"), rd("export/offers.json"), today, rd("state/networking_inbox_mac.json", null));
const prof = rd("state/networking_profiles.json");
const t = m.today, STAGES = ["reply", "talking", "thanks", "call", "call_log", "first", "dormant", "followup", "keep_warm", "third"];
const urgent = [...t.replies, ...t.nudges, ...t.first, ...t.dormant, ...t.followups, ...t.keepWarm, ...m.P.filter(p => p.st.stage === "thanks")];
const rest = m.P.filter(p => STAGES.includes(p.st.stage)).sort((a, b) => STAGES.indexOf(a.st.stage) - STAGES.indexOf(b.st.stage));
const seen = new Set(), out = [];
for (const p of [...urgent, ...rest]) {
  if (seen.has(p.id)) continue; seen.add(p.id);
  const have = prof[p.id] || {};
  if (have.text && !/^(web|pdl)/.test(have.source || "")) continue;      // a real capture: nothing to do
  if (have.text && have.source === "pdl") continue;                      // PDL already gave the full career
  out.push({ id: p.id, name: p.name, firm: p.firm || "", title: p.title || "", linkedin: p.linkedin || "", stage: p.st.stage,
             urgent: urgent.includes(p), tried: (have.tried || []).concat(have.source && !have.text ? [have.source] : []), has: have.source || "" });
  if (out.length >= max) break;
}
console.log(JSON.stringify({ at: new Date().toISOString(), count: out.length, items: out }, null, 1));
