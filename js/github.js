/* GitHub API access to the private MyOffers repo. The token lives only in this browser. */
const GH = (() => {
  const OWNER = "thomasglx", REPO = "MyOffers";
  const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;
  const KEY = "myapp.token";
  let memToken = null; // fallback when browser storage is unavailable

  function getToken() {
    try { return localStorage.getItem(KEY) || memToken; } catch { return memToken; }
  }
  function setToken(t) {
    memToken = t;
    try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* memory only */ }
  }

  // Retries network errors ("Load failed" in Safari, e.g. right after the Mac wakes up)
  async function call(path, opts = {}) {
    for (let i = 0; ; i++) {
      try { return await callOnce(path, opts); }
      catch (e) {
        if (e instanceof GhError || i >= 3) throw e;
        await new Promise(r => setTimeout(r, 700 * (i + 1)));
      }
    }
  }
  async function callOnce(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      cache: "no-store",
      headers: { Authorization: `Bearer ${getToken()}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
    });
    if (res.status === 401) throw new GhError("Your access key was refused or has expired.", 401);
    if (res.status === 403) throw new GhError("Your access key doesn't have permission for MyOffers.", 403);
    return res;
  }

  // Raw JSON file (works for files up to 100 MB)
  async function readJson(path) {
    const res = await call(path, { headers: { Accept: "application/vnd.github.raw+json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new GhError(`GitHub error ${res.status} reading ${path}`, res.status);
    return res.json();
  }

  // JSON file + its sha (needed to update it)
  async function readWithSha(path) {
    const res = await call(path);
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new GhError(`GitHub error ${res.status} reading ${path}`, res.status);
    const j = await res.json();
    const text = new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, "")), c => c.charCodeAt(0)));
    return { data: JSON.parse(text || "{}"), sha: j.sha };
  }

  async function writeJson(path, data, sha, message) {
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 1) + "\n");
    let bin = ""; bytes.forEach(b => (bin += String.fromCharCode(b)));
    const body = { message, content: btoa(bin), committer: { name: "MyApp", email: "myapp@users.noreply.github.com" } };
    if (sha) body.sha = sha;
    const res = await call(path, { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    if (res.status === 409 || res.status === 422) throw new GhError("conflict", 409);
    if (!res.ok) throw new GhError(`GitHub error ${res.status} saving ${path}`, res.status);
    return (await res.json()).content.sha;
  }

  /* Read-modify-write with retries: the bot may commit between our read and our write. */
  async function updateJson(path, mutate, message) {
    for (let i = 0; i < 4; i++) {
      const { data, sha } = await readWithSha(path);
      const next = mutate(data || {});
      try { return await writeJson(path, next, sha, message); }
      catch (e) { if (e.status !== 409 || i === 3) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
    }
  }

  class GhError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

  return { getToken, setToken, readJson, updateJson, GhError };
})();
