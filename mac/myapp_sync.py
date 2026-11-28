#!/usr/bin/env python3
"""MyApp Mac sync (Networking, phase B).

Runs every 2 minutes (launchd). Reads, only for the people tracked in MyApp:
  - LinkedIn "new message" and "accepted your invitation" e-mails (Gmail, IMAP, read-only)
  - SMS / iMessage (Messages database, needs Full Disk Access)
  - WhatsApp (WhatsApp for Mac database, unofficial: may break after a WhatsApp update)
  - Phone calls (call history synced from the iPhone)
and writes the matching events to state/networking_inbox_mac.json in the private MyOffers repo.
Everything else (friends, other chats) is ignored and never leaves the Mac.
Secrets live in the macOS Keychain (services "myapp-github" and "myapp-gmail"), never in a file.
Standard library only. Usage: myapp_sync.py [--dry-run] [--days N]"""
import base64, email, glob, hashlib, imaplib, json, os, re, socket, sqlite3, subprocess, sys, time, unicodedata, urllib.request
from datetime import datetime, timedelta, timezone
from email.header import decode_header
from email.utils import parsedate_to_datetime

VERSION = 1
REPO = "thomasglx/MyOffers"
OUT = "state/networking_inbox_mac.json"
HOME = os.path.expanduser("~")
DIR = os.environ.get("MYAPP_SYNC_DIR", os.path.join(HOME, "Library/Application Support/MyAppSync"))
PATHS = {  # overridable for tests
    "messages": os.environ.get("MYAPP_CHATDB", os.path.join(HOME, "Library/Messages/chat.db")),
    "whatsapp": os.environ.get("MYAPP_WADB", os.path.join(HOME, "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite")),
    "calls": os.environ.get("MYAPP_CALLDB", os.path.join(HOME, "Library/Application Support/CallHistoryDB/CallHistory.storedata")),
    "contacts": os.environ.get("MYAPP_ABGLOB", os.path.join(HOME, "Library/Application Support/AddressBook/**/AddressBook-v22.abcddb")),
}
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
DRY = "--dry-run" in sys.argv
DAYS = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 30
HEARTBEAT_MIN = 30


def log(*a):
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def secret(service):
    v = os.environ.get("MYAPP_SECRET_" + service.upper().replace("-", "_"))
    if v: return v
    try:
        return subprocess.run(["security", "find-generic-password", "-s", service, "-w"], capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return ""


def iso(dt): return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def apple_time(v):
    v = float(v or 0)
    if v > 1e12: v /= 1e9  # Messages stores nanoseconds
    return APPLE_EPOCH + timedelta(seconds=v)


def key(name):
    s = re.split(r"\s[–—-]\s|,", str(name or ""))[0]   # "Daniel Mullarkey – ADAPT", "Maxence Dhoury, CFA"
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)", " ", s)
    return re.sub(r"[^a-z]+", " ", s).strip()


def phone_key(p):
    d = re.sub(r"\D", "", str(p or ""))
    return d[-9:] if len(d) >= 9 else ""


def slug(url):
    m = re.search(r"/in/([^/?#\"&\s]+)", str(url or ""))
    return m.group(1).lower() if m else ""


def eid(*parts): return "mac-" + hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:14]


# ------------------------------------------------------------------ GitHub
def gh(path, method="GET", body=None, raw=False):
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/contents/{path}", method=method,
                                 data=json.dumps(body).encode() if body else None)
    req.add_header("Authorization", "Bearer " + secret("myapp-github"))
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("Accept", "application/vnd.github.raw+json" if raw else "application/vnd.github+json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise


def load_people(state):
    """Tracked people with their names, phones and LinkedIn slugs (cached 30 min)."""
    cache = os.path.join(DIR, "people.json")
    if os.path.exists(cache) and time.time() - os.path.getmtime(cache) < 1800:
        return json.load(open(cache))
    base = gh("export/networking.json", raw=True) or {}
    ov = gh("state/networking_overrides.json", raw=True) or {}
    people = {p["id"]: p for p in base.get("people", [])}
    people.update({k: {**v, "id": k} for k, v in (ov.get("people_new") or {}).items()})
    for k, patch in (ov.get("people") or {}).items():
        if k in people: people[k] = {**people[k], **patch}
    slim = [{"id": p["id"], "name": p.get("name", ""), "phone": p.get("phone", ""), "linkedin": p.get("linkedin", "")} for p in people.values()]
    os.makedirs(DIR, exist_ok=True)
    json.dump(slim, open(cache, "w"))
    return slim


class Matcher:
    def __init__(self, people, contacts):
        self.by_name, self.by_phone, self.by_slug = {}, {}, {}
        for p in people:
            if key(p["name"]): self.by_name.setdefault(key(p["name"]), p["id"])
            if phone_key(p["phone"]): self.by_phone[phone_key(p["phone"])] = p["id"]
            if slug(p["linkedin"]): self.by_slug[slug(p["linkedin"])] = p["id"]
        for ph, nm in contacts.items():  # phone -> contact name -> tracked person
            pid = self.by_name.get(key(nm))
            if pid and ph not in self.by_phone: self.by_phone[ph] = pid

    def find(self, name=None, phone=None, url=None):
        return (self.by_slug.get(slug(url)) if url else None) or (self.by_phone.get(phone_key(phone)) if phone else None) \
            or (self.by_name.get(key(name)) if name else None)


# ------------------------------------------------------------------ sources
def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)


def read_contacts():
    """phone (last 9 digits) -> full name, from the Mac's Contacts (synced with the iPhone through iCloud)."""
    out = {}
    for db in glob.glob(PATHS["contacts"], recursive=True):
        try:
            c = ro(db)
            for first, last, org, num in c.execute(
                    "SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, p.ZFULLNUMBER FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON p.ZOWNER = r.Z_PK"):
                nm = " ".join(x for x in (first, last) if x) or org or ""
                if phone_key(num) and nm: out[phone_key(num)] = nm
            c.close()
        except Exception as e:
            log("contacts:", db, e)
    return out


def decode_attributed(blob):
    """Text of a message stored only in 'attributedBody' (recent macOS)."""
    if not blob: return ""
    b = bytes(blob)
    i = b.find(b"NSString")
    if i < 0: return ""
    i = b.find(b"\x2b", i)
    if i < 0: return ""
    i += 1
    n = b[i]
    if n == 0x81: n, i = int.from_bytes(b[i + 1:i + 3], "little"), i + 3
    elif n == 0x82: n, i = int.from_bytes(b[i + 1:i + 4], "little"), i + 4
    else: i += 1
    return b[i:i + n].decode("utf-8", "ignore")


def read_messages(m, since):
    evs, unmatched = [], []
    c = ro(PATHS["messages"])
    since_ns = int((since - APPLE_EPOCH).total_seconds() * 1e9)
    rows = c.execute("""SELECT m.ROWID, m.text, m.attributedBody, m.date, m.is_from_me, h.id, m.service, m.cache_roomnames
                        FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
                        WHERE m.date > ? ORDER BY m.date""", (since_ns,)).fetchall()
    for rowid, text, ab, date, mine, handle, service, room in rows:
        if room or not handle: continue  # group chats ignored
        pid = m.find(phone=handle) if "@" not in handle else None
        text = text or decode_attributed(ab)
        if not pid:
            if not mine: unmatched.append({"channel": "sms", "who": handle[-4:], "at": iso(apple_time(date))})
            continue
        ch = "imessage" if (service or "").lower() == "imessage" else "sms"
        evs.append({"id": eid("msg", rowid), "person": pid, "type": "message_sent" if mine else "message_received",
                    "at": iso(apple_time(date)), "channel": ch, "text": text or "", **({"kind": "reply"} if mine else {})})
    c.close()
    return evs, unmatched


def read_whatsapp(m, since):
    evs, unmatched = [], []
    c = ro(PATHS["whatsapp"])
    rows = c.execute("""SELECT w.Z_PK, w.ZTEXT, w.ZMESSAGEDATE, w.ZISFROMME, s.ZCONTACTJID, s.ZPARTNERNAME, s.ZSESSIONTYPE
                        FROM ZWAMESSAGE w JOIN ZWACHATSESSION s ON w.ZCHATSESSION = s.Z_PK
                        WHERE w.ZMESSAGEDATE > ? ORDER BY w.ZMESSAGEDATE""", ((since - APPLE_EPOCH).total_seconds(),)).fetchall()
    for pk, text, date, mine, jid, partner, stype in rows:
        if stype not in (0, None) or "@g.us" in (jid or ""): continue  # groups ignored
        pid = m.find(phone=(jid or "").split("@")[0]) or m.find(name=partner)
        if not pid:
            if not mine: unmatched.append({"channel": "whatsapp", "who": (partner or "")[:20], "at": iso(apple_time(date))})
            continue
        evs.append({"id": eid("wa", pk), "person": pid, "type": "message_sent" if mine else "message_received",
                    "at": iso(apple_time(date)), "channel": "whatsapp", "text": text or "[media]", **({"kind": "reply"} if mine else {})})
    c.close()
    return evs, unmatched


def read_calls(m, since):
    evs = []
    c = ro(PATHS["calls"])
    rows = c.execute("SELECT Z_PK, ZADDRESS, ZDATE, ZDURATION, ZORIGINATED, ZANSWERED FROM ZCALLRECORD WHERE ZDATE > ? ORDER BY ZDATE",
                     ((since - APPLE_EPOCH).total_seconds(),)).fetchall()
    for pk, addr, date, dur, out, ans in rows:
        addr = addr.decode() if isinstance(addr, bytes) else addr
        pid = m.find(phone=addr)
        if not pid or not dur or dur < 20: continue
        evs.append({"id": eid("call", pk), "person": pid, "type": "contact_logged", "at": iso(apple_time(date)), "channel": "phone",
                    "duration": int(dur), "text": f"Call {round(dur / 60)} min ({'outgoing' if out else 'incoming'})"})
    c.close()
    return evs


def mail_text(msg):
    plain = html = ""
    for part in msg.walk():
        ct = part.get_content_type()
        if ct in ("text/plain", "text/html"):
            t = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "ignore")
            if ct == "text/plain": plain += t
            else: html += t
    return plain, html


def parse_linkedin_mail(raw, m):
    """One LinkedIn e-mail -> (events, unmatched). LinkedIn's message e-mails never contain the message text."""
    evs, unmatched = [], []
    msg = email.message_from_bytes(raw)
    subj = "".join(t.decode(c or "utf-8", "ignore") if isinstance(t, bytes) else t for t, c in decode_header(msg["Subject"] or ""))
    at = parsedate_to_datetime(msg["Date"]).astimezone(timezone.utc)
    mid = msg["Message-ID"] or subj + iso(at)
    plain, html = mail_text(msg)
    sender = (msg["From"] or "").lower()
    if "messaging-digest" in sender:
        # "Name (headline)\n(https://…/in/slug)\n\nView message: https://www.linkedin.com/comm/messaging/thread/…"
        for name, url, thread in re.findall(r"\n([^\n()]{2,80}) \([^\n]*\)\n\((https://[^)\s]*linkedin\.com/in/[^)\s]+)\)\s*\n\s*View message: (\S+)", "\n" + plain):
            pid = m.find(name=name.strip(), url=url)
            if not pid: unmatched.append({"channel": "linkedin", "who": name.strip()[:40], "at": iso(at)}); continue
            evs.append({"id": eid("li", mid, slug(url)), "person": pid, "type": "message_received", "at": iso(at), "channel": "linkedin",
                        "text": "", "digest": True, "thread_url": thread.split("?")[0]})
    elif "accepted your invitation" in subj:
        first = subj.split(" accepted")[0].strip()
        alts = re.findall(r'alt="([^"]+?)(?:’|&#39;|\')s profile image"', html)
        name = next((a for a in alts if a.lower().startswith(first.lower())), "")
        slugs = [x for x in re.findall(r"linkedin\.com/comm/in/([^?\"&]+)", html) if key(first)[:4] and key(first)[:4] in x.lower()]
        pid = m.find(name=name, url="/in/" + slugs[0] if slugs else None)
        if pid: evs.append({"id": eid("acc", mid), "person": pid, "type": "accepted", "at": iso(at), "channel": "linkedin"})
        else: unmatched.append({"channel": "linkedin-accept", "who": (name or first)[:40], "at": iso(at)})
    return evs, unmatched


def read_linkedin_mail(m, since, state):
    """Only e-mails not seen before are downloaded (UIDs remembered); their events are kept in state."""
    pw = secret("myapp-gmail")
    user = os.environ.get("MYAPP_GMAIL_USER") or secret("myapp-gmail-user")
    if not pw or not user: raise RuntimeError("Gmail address or app password missing in the Keychain")
    cache = state.setdefault("mail", {"uids": [], "events": [], "unmatched": []})
    seen = set(cache["uids"])
    imap = imaplib.IMAP4_SSL("imap.gmail.com")
    imap.login(user, pw)
    imap.select('"[Gmail]/All Mail"', readonly=True)
    day = since.strftime("%d-%b-%Y")
    for frm in ("messaging-digest-noreply@linkedin.com", "invitations@linkedin.com"):
        typ, data = imap.uid("search", None, f'(FROM "{frm}" SINCE {day})')
        for uid in (data[0].split() if data and data[0] else []):
            u = uid.decode()
            if u in seen: continue
            typ, d = imap.uid("fetch", uid, "(BODY.PEEK[])")
            if not d or not isinstance(d[0], tuple): continue
            ev, un = parse_linkedin_mail(d[0][1], m)
            cache["events"] += ev; cache["unmatched"] += un; seen.add(u)
    imap.logout()
    cutoff = iso(datetime.now(timezone.utc) - timedelta(days=120))
    cache["events"] = [e for e in cache["events"] if e["at"] >= cutoff]
    cache["unmatched"] = cache["unmatched"][-50:]
    cache["uids"] = list(seen)[-3000:]
    return cache["events"], cache["unmatched"]


def notify(title, text):
    if DRY: log("notify:", title, "|", text); return
    t = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')[:180]
    subprocess.run(["osascript", "-e", f'display notification "{t(text)}" with title "{t(title)}" sound name "Glass"'], capture_output=True)


# ------------------------------------------------------------------ main
def main():
    os.makedirs(DIR, exist_ok=True)
    sp = os.path.join(DIR, "state.json")
    state = json.load(open(sp)) if os.path.exists(sp) else {}
    since = datetime.now(timezone.utc) - timedelta(days=DAYS if not state.get("seen") else 3)
    people = load_people(state)
    names = {p["id"]: p["name"] for p in people}
    sources, events, unmatched = {}, [], []
    try:
        contacts = read_contacts(); sources["contacts"] = f"ok ({len(contacts)} numbers)"
    except Exception as e:
        contacts = {}; sources["contacts"] = "error: " + str(e)[:120]
    m = Matcher(people, contacts)
    for name, fn in (("linkedin", lambda m, since: read_linkedin_mail(m, since, state)), ("sms", read_messages),
                     ("whatsapp", read_whatsapp), ("calls", read_calls)):
        try:
            r = fn(m, since)
            ev, un = r if isinstance(r, tuple) else (r, [])
            events += ev; unmatched += un; sources[name] = "ok"
        except Exception as e:
            sources[name] = "error: " + str(e)[:160]
            log(name, "failed:", e)

    seen = set(state.get("seen", []))
    new = [e for e in events if e["id"] not in seen]
    for e in new:
        if e["type"] == "message_received":
            ch = {"linkedin": "LinkedIn", "whatsapp": "WhatsApp", "sms": "SMS", "imessage": "iMessage"}.get(e["channel"], e["channel"])
            notify(f"{names.get(e['person'], 'A contact')} wrote on {ch}", e.get("text") or "Open MyApp → Today")
        elif e["type"] == "accepted":
            notify(f"{names.get(e['person'], 'Someone')} accepted your request", "First message from tomorrow (MyApp)")

    now = datetime.now(timezone.utc)
    last_up = state.get("last_upload")
    need_upload = bool(new) or not last_up or (now - datetime.fromisoformat(last_up)).total_seconds() > HEARTBEAT_MIN * 60 \
        or state.get("sources") != sources
    log(f"{len(events)} events ({len(new)} new), {len(unmatched)} unmatched, sources {sources}")
    if DRY:
        print(json.dumps({"new": new[:20], "unmatched": unmatched[:20]}, ensure_ascii=False, indent=1)); return
    if need_upload:
        cur = gh(OUT) or {}
        old = json.loads(base64.b64decode(cur["content"]).decode()) if cur.get("content") else {}
        keep_after = iso(now - timedelta(days=120))
        merged = {e["id"]: e for e in old.get("events", []) if e["at"] >= keep_after}
        merged.update({e["id"]: e for e in events})
        doc = {"device": {"name": socket.gethostname(), "last_run": iso(now), "version": VERSION, "sources": sources},
               "events": sorted(merged.values(), key=lambda e: e["at"]), "unmatched": unmatched[-50:]}
        body = {"message": f"Mac sync: {len(new)} new" if new else "Mac sync: heartbeat",
                "content": base64.b64encode(json.dumps(doc, ensure_ascii=False, indent=1).encode()).decode(),
                "committer": {"name": "MyApp Mac", "email": "myapp@users.noreply.github.com"}}
        if cur.get("sha"): body["sha"] = cur["sha"]
        gh(OUT, "PUT", body)
        state["last_upload"] = iso(now)
    state["seen"] = list(seen | {e["id"] for e in events})[-5000:]
    state["sources"] = sources
    json.dump(state, open(sp, "w"))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("FAILED:", repr(e))
        sys.exit(1)
