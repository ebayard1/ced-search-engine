'use strict';
// CED counter search — zero-dependency local server.
//   node server.js          -> http://localhost:8321 (+ LAN addresses)
//   PORT=9000 node server.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { createEngine, cedImageFor } = require('./lib/search');
const { webLookup, imageLookup, verifyImages, cached, cachedText, webHealth } = require('./lib/web');
const { saveJSONAtomic, rotateBackup, loadJSONGuarded } = require('./lib/store');
const ai = require('./lib/ai');
const { createQueue } = require('./lib/pending');
const { createAuth, parseCookies } = require('./lib/auth');

const HERE = __dirname;
const DATA_DIR = path.join(HERE, 'data');
const DATA = (f) => path.join(DATA_DIR, f);
const PUB = path.join(HERE, 'public');
const PORT = process.env.PORT || 8321;

function loadJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(DATA(f), 'utf8')); } catch { return fallback; }
}

// ---------- shared-password gate (optional) ----------
// CED_PASSWORD env var, or data/config.json {"password": "..."}. Without one the
// app stays open exactly as before — set one before exposing it beyond the LAN.
const auth = createAuth({ password: process.env.CED_PASSWORD || loadJSON('config.json', {}).password || '' });

// Paths reachable without a session: the login flow and the logo it displays.
const AUTH_OPEN = new Set(['/login', '/logout', '/ced-logo.png']);

function loginPage(res, { error = '', code = 200 } = {}) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CED Counter Search — Sign in</title>
<style>
  body { margin:0; font:15px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;
         background:#14335F; color:#182234; display:grid; place-items:center; min-height:100vh; }
  .card { background:#fff; border-radius:14px; padding:34px 38px; width:min(360px, 90vw);
          box-shadow:0 12px 40px rgba(0,0,0,.35); border-top:4px solid #ED1C24; text-align:center; }
  img { height:52px; margin-bottom:10px; }
  h1 { font-size:17px; margin:0 0 18px; color:#14335F; }
  input { width:100%; font-size:16px; padding:10px 12px; border:1px solid #BCCDE4; border-radius:8px; }
  button { width:100%; margin-top:12px; font-size:15px; font-weight:600; padding:10px;
           border:0; border-radius:8px; background:#14335F; color:#fff; cursor:pointer; }
  button:hover { background:#0C2547; }
  .err { color:#C8102E; font-size:13px; margin:10px 0 0; min-height:1em; }
</style>
<div class="card">
  <img src="/ced-logo.png" alt="CED">
  <h1>Counter Search</h1>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Team password" autofocus autocomplete="current-password">
    <button>Sign in</button>
  </form>
  <p class="err">${error}</p>
</div>`);
}

function setSessionCookie(req, res, value, maxAgeSec) {
  // Secure only when the request arrived over https (e.g. via cloudflared) so
  // plain-http LAN use keeps working.
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `ced_session=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure}`);
}

// Returns true when the request was fully handled (login flow or rejection);
// false means the caller should serve it normally.
function handleAuth(req, res, u, ip) {
  if (!auth.enabled) return false;

  if (u.pathname === '/login') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        if (!auth.allowAttempt(ip)) return loginPage(res, { error: 'Too many tries — wait 15 minutes.', code: 429 });
        const attempt = new URLSearchParams(body).get('password') || '';
        if (!auth.checkPassword(attempt)) return loginPage(res, { error: 'Wrong password.', code: 401 });
        setSessionCookie(req, res, auth.issue(), Math.floor(auth.ttlMs / 1000));
        res.writeHead(303, { Location: '/' });
        res.end();
      });
    } else {
      loginPage(res);
    }
    return true;
  }

  if (u.pathname === '/logout') {
    setSessionCookie(req, res, '', 0);
    res.writeHead(303, { Location: '/login' });
    res.end();
    return true;
  }

  if (AUTH_OPEN.has(u.pathname)) return false;

  if (auth.verify(parseCookies(req.headers.cookie).ced_session)) return false;

  if (u.pathname.startsWith('/api/')) {
    json(res, 401, { error: 'auth-required' });
  } else {
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
    res.end();
  }
  return true;
}

// ---------- overrides: user edits, guarded against corruption ----------
// { [itemId]: { desc, keywords: [], notes, image, updatedAt } }
const OVERRIDES_PATH = DATA('overrides.json');
let overridesObj;
try {
  overridesObj = loadJSONGuarded(OVERRIDES_PATH, {});
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (Object.keys(overridesObj).length) rotateBackup(OVERRIDES_PATH);
const overrides = { get: (id) => overridesObj[id] };

function saveOverrides() {
  try { saveJSONAtomic(OVERRIDES_PATH, overridesObj); }
  catch (e) { console.error('FAILED to save overrides.json:', e.message); }
}

// ---------- state: everything rebuilt on data-file changes ----------
function buildState() {
  const t0 = Date.now();
  const catalog = loadJSON('catalog.json', null);
  if (!catalog) throw new Error('data/catalog.json missing — run:  python3 ingest.py');
  const jargon = loadJSON('jargon.json', { rules: [] });
  const synonyms = loadJSON('synonyms.json', { slang: {}, abbrev: {} });
  const mfrMap = loadJSON('mfr.json', { map: {} }).map;
  const knowledge = loadJSON('knowledge.json', { entries: [] });
  const counterRules = loadJSON('counter-rules.json', { rules: [] });
  const mfrLogos = loadJSON('mfrlogos.json', {});

  const engine = createEngine({ catalog, jargon, synonyms, mfrMap, overrides, webText: cachedText });

  const zones = loadJSON('zones.json', { order: [] });
  const map = loadJSON('map.json', null); // optional hand-drawn warehouse map

  // cross-references: substitute groups + goes-with accessories
  const xref = loadJSON('xref.json', { groups: [], goesWith: [] });
  const xrefById = new Map(); // itemId -> [group, ...]
  for (const g of xref.groups || []) {
    for (const id of g.ids || []) {
      if (!xrefById.has(id)) xrefById.set(id, []);
      xrefById.get(id).push(g);
    }
  }
  const goesWith = (xref.goesWith || []).map((g) => ({
    ...g,
    mfr: (g.for || {}).mfr || null,
    catRe: (g.for || {}).cat ? new RegExp(g.for.cat, 'i') : null,
  }));

  const knowledgeEntries = knowledge.entries.map((e) => ({
    ...e,
    match: (e.match || []).map((m) => ({
      mfr: m.mfr || null,
      cat: m.cat ? new RegExp(m.cat, 'i') : null,
      desc: m.desc ? new RegExp(m.desc, 'i') : null,
    })),
  }));

  let catalogMtime = null;
  try { catalogMtime = fs.statSync(DATA('catalog.json')).mtimeMs; } catch {}

  const orphans = Object.keys(overridesObj)
    .filter((id) => !engine.byId.has(id))
    .map((id) => ({ id, ...overridesObj[id] }));

  return {
    engine, jargon, synonyms, mfrMap, knowledge, knowledgeEntries, counterRules, mfrLogos, zones, map,
    xref, xrefById, goesWith,
    catalogMtime, orphans, builtAt: Date.now(), buildMs: Date.now() - t0, reloadError: null,
  };
}

let state;
try { state = buildState(); } catch (e) {
  console.error(e.message);
  process.exit(1);
}

// hot reload: human-edited files only; app-managed files (overrides, webcache,
// missed, pending) must NOT trigger a rebuild
const WATCHED = new Set(['catalog.json', 'jargon.json', 'synonyms.json', 'knowledge.json',
  'mfr.json', 'counter-rules.json', 'mfrlogos.json', 'xref.json', 'zones.json', 'map.json']);

function reloadState(reason) {
  try {
    state = buildState();
    console.log(`data reloaded (${reason}) — ${state.engine.items.length} items in ${state.buildMs}ms`);
  } catch (e) {
    state.reloadError = e.message; // keep serving the old state
    console.error(`reload failed (${reason}): ${e.message} — keeping previous data`);
  }
}

let reloadTimer = null;
try {
  fs.watch(DATA_DIR, (ev, fname) => {
    if (!fname || !WATCHED.has(fname)) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reloadState(fname), 500);
  });
} catch (e) {
  console.error('fs.watch unavailable — use POST /api/reload after editing data files');
}

// ---------- missed searches: zero-result queries, settle-timer per client ----------
const MISSED_PATH = DATA('missed.json');
const missedObj = loadJSON('missed.json', {}); // { [query]: {count, first, last} }
let missedSaveTimer = null;
function saveMissed() {
  clearTimeout(missedSaveTimer);
  missedSaveTimer = setTimeout(() => {
    try { saveJSONAtomic(MISSED_PATH, missedObj); } catch (e) { console.error('missed.json save failed:', e.message); }
  }, 500);
}
function recordMissed(q) {
  const key = q.toLowerCase().trim();
  const now = new Date().toISOString();
  const e = missedObj[key] || { count: 0, first: now };
  e.count++; e.last = now;
  missedObj[key] = e;
  const keys = Object.keys(missedObj);
  if (keys.length > 500) {
    for (const k of keys.sort((a, b) => (missedObj[a].last < missedObj[b].last ? -1 : 1)).slice(0, keys.length - 500)) {
      delete missedObj[k];
    }
  }
  saveMissed();
}
// A query only counts as "missed" if the user stops typing for 3s — every new
// search from the same client cancels the pending one, so debounce prefixes
// ("sealt", "sealti"…) of an eventually-successful search never log.
const missedTimers = new Map(); // clientIp -> timeout
function noteSearch(ip, q, hadResults, mfrFiltered) {
  const prev = missedTimers.get(ip);
  if (prev) { clearTimeout(prev); missedTimers.delete(ip); }
  if (hadResults || mfrFiltered || !q || q.trim().length < 3) return;
  missedTimers.set(ip, setTimeout(() => { missedTimers.delete(ip); recordMissed(q); }, 3000));
}

// natural sort in warehouse walk order: zones.json order first, then bin
// segments compared numerically where numeric (A-4-2 before A-10-1)
// (used by xrefFor to show the nearest bin for substitutes)
function binKey(bin) {
  return String(bin || '').split(/[-\s]+/).map((seg) => (/^\d+$/.test(seg) ? seg.padStart(6, '0') : seg));
}
function walkOrderSort(a, b) {
  const order = state.zones.order || [];
  const za = order.indexOf(a.zone), zb = order.indexOf(b.zone);
  const ka = za === -1 ? [1, a.zone || '~'] : [0, za];
  const kb = zb === -1 ? [1, b.zone || '~'] : [0, zb];
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1;
  const sa = binKey(a.bin), sb = binKey(b.bin);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if ((sa[i] || '') !== (sb[i] || '')) return (sa[i] || '') < (sb[i] || '') ? -1 : 1;
  }
  return 0;
}

// ---------- AI suggestion queue: everything AI-written is approve-gated ----------
const pendingQueue = createQueue({
  dataDir: DATA_DIR,
  itemExists: (id) => state.engine.byId.has(id),
  applyOverride({ id, keywords, note }) {
    const o = overridesObj[id] || {};
    if (keywords) o.keywords = [...new Set([...(o.keywords || []), ...keywords.map((k) => String(k).trim()).filter(Boolean)])];
    if (note) o.notes = o.notes ? `${o.notes}\n${note}` : String(note);
    o.updatedAt = new Date().toISOString();
    overridesObj[id] = o;
    saveOverrides();
    state.engine.reindex(id);
  },
});

// ---------- counter assistant: read-only tools over local state ----------
const CHAT_SYSTEM = `You are the counter assistant at CED (Consolidated Electrical Distributors), Phoenix.
You help counter staff find parts, substitutes, and answers fast.
Rules:
- Ground every claim about a part or location in a tool result from this conversation. Never invent catalog numbers or bins.
- You don't have stock quantities or pricing — never state or estimate either. For price or availability counts, point people to the counter staff or the CED portal.
- Answer short: catalog # + bin + one line of why. Counter staff are mid-conversation with a customer.
- If nothing matches, say so and suggest what to search or which knowledge write-up helps.
- You can tag items with searchable keywords. When someone asks you to tag/label an item, or you notice trade slang that should find a part, first pin down the exact item id with search_inventory or get_item, then call add_tags. Confirm which item you tagged in your reply.
- When you learn a jargon mapping or fact worth keeping (not tied to one item), call the suggest tool instead.
- Anything you tag or suggest queues for human approval in the Suggestions tab — say so, don't imply it's saved immediately.`;

const CHAT_TOOLS = [
  { name: 'search_inventory', description: 'Search the local catalog the way the counter search does: jargon, catalog #, UPC, sizes. Returns top matches with bin locations.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, mfr: { type: 'string', description: 'optional manufacturer code filter' } }, required: ['query'] } },
  { name: 'get_item', description: 'Full detail for one item id (MFR|CAT): bin locations, keywords, notes, knowledge write-ups, cached web results.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'find_substitutes', description: 'Cross-referenced substitutes and goes-with accessories for an item id, with bin locations.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'lookup_knowledge', description: 'Search the Learn write-ups (how part families work and fit together).',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'list_cheatsheet', description: 'Jargon cheat-sheet rules (term -> mfr + catalog pattern). Optionally filter by term.',
    input_schema: { type: 'object', properties: { term: { type: 'string' } } } },
  { name: 'add_tags', description: 'Tag one item with searchable keywords (trade slang, plain-English names, anything a customer might say). Queues for human approval — tell the user that.',
    input_schema: { type: 'object', properties: {
      id: { type: 'string', description: 'exact item id, MFR|CAT — look it up first if unsure' },
      tags: { type: 'array', items: { type: 'string' }, description: '1-6 keywords to add' },
      rationale: { type: 'string', description: 'why these tags help find this item' },
    }, required: ['id', 'tags', 'rationale'] } },
  { name: 'suggest', description: 'Queue a suggestion for human approval: a jargon rule, synonym, or item note the team should keep (use add_tags for item keywords instead).',
    input_schema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['jargon-rule', 'synonym', 'item-note'] },
      payload: { type: 'object' },
      rationale: { type: 'string' },
    }, required: ['kind', 'payload', 'rationale'] } },
];

function chatExecTool(name, input) {
  const engine = state.engine;
  const brief = (it) => ({
    id: it.id, cat: it.cat, mfr: it.mfr, mfrName: it.mfrName, desc: it.desc,
    bins: (it.bins || []).slice(0, 3).map((b) => b.bin),
  });
  if (name === 'search_inventory') {
    const out = engine.search(String(input.query || ''), 10, String(input.mfr || ''));
    return { matches: out.results.slice(0, 10).map(brief), jargonHits: out.jargon };
  }
  if (name === 'get_item') {
    const it = engine.byId.get(String(input.id || ''));
    if (!it) return { error: 'unknown id' };
    const c = cached(it.id);
    return {
      ...brief(it), origDesc: it.origDesc, upc: it.upc, keywords: it.keywords,
      notes: it.notes, knowledge: knowledgeFor(it), web: c ? c.results.slice(0, 3) : [],
    };
  }
  if (name === 'find_substitutes') {
    const it = engine.byId.get(String(input.id || ''));
    if (!it) return { error: 'unknown id' };
    return xrefFor(it);
  }
  if (name === 'lookup_knowledge') {
    const q = String(input.query || '').toLowerCase();
    return state.knowledge.entries
      .filter((e) => e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q))
      .slice(0, 4).map(({ id, title, body }) => ({ id, title, body }));
  }
  if (name === 'list_cheatsheet') {
    const q = String(input.term || '').toLowerCase();
    return state.jargon.rules
      .filter((r) => !q || r.term.toLowerCase().includes(q) || (r.aliases || []).some((a) => a.toLowerCase().includes(q)))
      .slice(0, 12).map(({ term, aliases, mfr, match, hint }) => ({ term, aliases, mfr, match, hint }));
  }
  if (name === 'add_tags') {
    const itemId = String(input.id || '');
    if (!engine.byId.has(itemId)) return { error: `unknown item id ${itemId} — look it up with search_inventory or get_item first` };
    const tags = (input.tags || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
    if (!tags.length) return { error: 'need at least one tag' };
    const s = pendingQueue.file('chat', 'item-keywords', { id: itemId, keywords: tags }, input.rationale || '');
    return s ? { queued: s.id, note: 'pending human approval in the Suggestions tab' } : { note: 'these tags are already pending for this item' };
  }
  if (name === 'suggest') {
    const s = pendingQueue.file('chat', input.kind, input.payload, input.rationale);
    return s ? { queued: s.id, note: 'pending human approval in the Suggestions tab' } : { note: 'an identical suggestion is already pending' };
  }
  throw new Error(`unknown tool ${name}`);
}

// ---------- LAN awareness ----------
const clientsSeen = new Map(); // ip -> last-seen ms
function touchClient(ip) {
  if (ip) clientsSeen.set(ip, Date.now());
}
function clientsOnline() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  let n = 0;
  for (const [ip, t] of clientsSeen) {
    if (t >= cutoff) n++; else clientsSeen.delete(ip);
  }
  return n;
}
function lanURLs() {
  const urls = [`http://localhost:${PORT}`];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
    }
  }
  return urls;
}

// ---------- helpers ----------
function knowledgeFor(item) {
  const hits = [];
  for (const e of state.knowledgeEntries) {
    for (const m of e.match) {
      if (m.mfr && m.mfr !== item.mfr) continue;
      if (m.cat && !m.cat.test(item.cat)) continue;
      if (m.desc && !m.desc.test(item.origDesc || item.desc || '')) continue;
      hits.push({ id: e.id, title: e.title, body: e.body });
      break;
    }
  }
  return hits;
}

// resolve an item's cross-references (locations only — no stock numbers)
function briefItem(id) {
  const it = state.engine.byId.get(id);
  if (!it) return null;
  const bins = (it.bins || []).slice().sort(walkOrderSort);
  return { id: it.id, mfr: it.mfr, mfrName: it.mfrName, cat: it.cat, desc: it.desc,
           firstBin: bins[0] ? bins[0].bin : null };
}
function xrefFor(item) {
  const seen = new Set([item.id]);
  const equivalents = [];
  for (const g of state.xrefById.get(item.id) || []) {
    for (const id of g.ids || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const b = briefItem(id);
      if (b) equivalents.push({ ...b, note: g.note || '' });
    }
  }
  const accessories = [];
  const accSeen = new Set();
  for (const g of state.goesWith) {
    if (g.mfr && g.mfr !== item.mfr) continue;
    if (g.catRe && !g.catRe.test(item.cat)) continue;
    for (const id of g.items || []) {
      if (id === item.id || accSeen.has(id)) continue;
      accSeen.add(id);
      const b = briefItem(id);
      if (b) accessories.push({ ...b, note: g.note || '' });
    }
  }
  return { equivalents, accessories };
}
function webQueryFor(item) {
  const name = item.mfrName && !item.mfrName.includes('(') ? item.mfrName : item.mfr;
  return `${name} ${item.cat} electrical`.trim();
}

// image search matches Google behavior best as "<brand> <cat#> <what it is>",
// e.g. "Bridgeport T46CG conduit body" — not the generic "... electrical"
function imageQueryFor(item) {
  const name = item.mfrName && !item.mfrName.includes('(') ? item.mfrName : item.mfr;
  const words = String(item.desc || '')
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]{3,}$/.test(w))
    .slice(0, 3)
    .join(' ')
    .toLowerCase();
  return `${name} ${item.cat} ${words}`.trim();
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUB, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    // html/css/js must always revalidate so UI updates land without hard refreshes
    const cache = ['.html', '.css', '.js'].includes(ext) ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  // Behind cloudflared/a proxy every socket is localhost — recover the real
  // client IP from headers, but only for loopback connections so LAN clients
  // can't spoof their identity (the login rate limit keys on this).
  const sockIp = req.socket.remoteAddress || '';
  const viaProxy = sockIp === '127.0.0.1' || sockIp === '::1' || sockIp === '::ffff:127.0.0.1';
  const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = (viaProxy && fwd) || sockIp;
  if (handleAuth(req, res, u, ip)) return;
  if (u.pathname.startsWith('/api/')) touchClient(ip);
  const engine = state.engine;
  try {
    if (u.pathname === '/api/search') {
      const q = u.searchParams.get('q') || '';
      const mfr = u.searchParams.get('mfr') || '';
      const out = engine.search(q, Number(u.searchParams.get('n')) || 500, mfr);
      noteSearch(ip, q, out.results.length > 0, !!mfr);
      // attach cached web results if we have them (no live fetch on search)
      for (const r of out.results) {
        const c = cached(r.id);
        r.web = c ? c.results : null;
        r.knowledge = knowledgeFor(r).map((k) => k.id);
      }
      return json(res, 200, out);
    }

    if (u.pathname === '/api/items') {
      const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 60);
      return json(res, 200, { items: ids.map((id) => engine.resultFor(id)).filter(Boolean) });
    }

    if (u.pathname === '/api/item' && req.method === 'GET') {
      const it = engine.byId.get(u.searchParams.get('id'));
      if (!it) return json(res, 404, { error: 'unknown id' });
      const c = cached(it.id);
      return json(res, 200, {
        item: {
          id: it.id, mfr: it.mfr, mfrName: it.mfrName, cat: it.cat, desc: it.desc,
          origDesc: it.origDesc, upc: it.upc, bins: (it.bins || []).map(({ bin, zone }) => ({ bin, zone })),
          keywords: it.keywords, autoKeywords: it.autoKeywords, notes: it.notes,
          image: it.image,
          cedImages: await verifyImages(it.id, [1, 2, 3].map((n) => cedImageFor(it.upc, n)).filter(Boolean)),
          edited: it.edited,
        },
        updatedAt: (overridesObj[it.id] || {}).updatedAt || null,
        web: c || null,
        images: cached('img:' + it.id) || null,
        knowledge: knowledgeFor(it),
        webQuery: webQueryFor(it),
        xref: xrefFor(it),
      });
    }

    if (u.pathname === '/api/item' && req.method === 'POST') {
      const body = await readBody(req);
      const it = engine.byId.get(body.id);
      if (!it) return json(res, 404, { error: 'unknown id' });
      const o = overridesObj[body.id] || {};
      // multi-user: warn (but still apply, last-write-wins) when someone else
      // saved since this client loaded the item
      const conflict = 'knownUpdatedAt' in body && (o.updatedAt || null) !== (body.knownUpdatedAt || null);
      if ('desc' in body) {
        const d = String(body.desc || '').trim();
        o.desc = d && d !== it.origDesc ? d : undefined; // identical to original = not an edit
      }
      if ('keywords' in body) o.keywords = [...new Set((body.keywords || []).map((k) => String(k).trim()).filter(Boolean))];
      if ('notes' in body) o.notes = String(body.notes || '').trim() || undefined;
      if ('image' in body) o.image = String(body.image || '').trim() || undefined;
      if (!o.desc) delete o.desc;
      if (!o.notes) delete o.notes;
      if (!o.image) delete o.image;
      if (o.keywords && !o.keywords.length) delete o.keywords;
      const hasContent = Object.keys(o).filter((k) => k !== 'updatedAt').length > 0;
      if (hasContent) {
        o.updatedAt = new Date().toISOString();
        overridesObj[body.id] = o;
      } else {
        delete overridesObj[body.id];
      }
      saveOverrides();
      const updated = engine.reindex(body.id);
      return json(res, 200, {
        ok: true, conflict,
        updatedAt: hasContent ? o.updatedAt : null,
        item: { id: updated.id, desc: updated.desc, keywords: updated.keywords, notes: updated.notes, edited: updated.edited },
      });
    }

    if (u.pathname === '/api/images') {
      const id = u.searchParams.get('id');
      const force = u.searchParams.get('force') === '1';
      const it = id && engine.byId.get(id);
      if (!it) return json(res, 404, { error: 'unknown id' });
      try {
        const entry = await imageLookup(it.id, imageQueryFor(it), force, it.cat);
        return json(res, 200, entry);
      } catch (e) {
        return json(res, 502, { error: `image lookup failed: ${e.message}` });
      }
    }

    if (u.pathname === '/api/web') {
      const id = u.searchParams.get('id');
      const force = u.searchParams.get('force') === '1';
      const it = id && engine.byId.get(id);
      const q = u.searchParams.get('q') || (it ? webQueryFor(it) : '');
      if (!q) return json(res, 400, { error: 'need id or q' });
      try {
        const entry = await webLookup(id || `q:${q}`, q, force);
        if (it) engine.reindex(it.id); // web titles/snippets become searchable immediately
        return json(res, 200, entry);
      } catch (e) {
        return json(res, 502, { error: `web lookup failed: ${e.message}`, query: q });
      }
    }

    if (u.pathname === '/api/missed' && req.method === 'GET') {
      const list = Object.entries(missedObj)
        .map(([q, e]) => ({ q, ...e }))
        .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
      return json(res, 200, { missed: list });
    }

    if (u.pathname === '/api/missed/clear' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.q) delete missedObj[String(body.q).toLowerCase().trim()];
      else for (const k of Object.keys(missedObj)) delete missedObj[k];
      saveMissed();
      return json(res, 200, { ok: true });
    }

    if (u.pathname === '/api/pending' && req.method === 'GET') {
      return json(res, 200, { suggestions: pendingQueue.pending() });
    }

    if (u.pathname === '/api/pending/decide' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const s = pendingQueue.decide(String(body.id || ''), !!body.approve);
        return json(res, 200, { ok: true, suggestion: s });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (u.pathname === '/api/chat' && req.method === 'POST') {
      if (!ai.enabled()) return json(res, 503, { error: 'ai-disabled' });
      const body = await readBody(req);
      const history = (body.messages || []).slice(-20).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 4000),
      }));
      if (!history.length) return json(res, 400, { error: 'need messages' });
      try {
        const out = await ai.toolLoop({
          system: CHAT_SYSTEM, messages: history,
          tools: CHAT_TOOLS, execTool: chatExecTool, maxTokens: 1500,
        });
        return json(res, 200, { text: out.text, toolsUsed: out.toolsUsed, truncated: !!out.truncated });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (u.pathname === '/api/ai/suggest-jargon' && req.method === 'POST') {
      if (!ai.enabled()) return json(res, 503, { error: 'ai-disabled' });
      const missed = Object.entries(missedObj)
        .sort((a, b) => b[1].count - a[1].count).slice(0, 20).map(([q, e]) => ({ q, count: e.count }));
      if (!missed.length) return json(res, 400, { error: 'no missed searches to learn from' });
      const known = {
        jargonTerms: state.jargon.rules.flatMap((r) => [r.term, ...(r.aliases || [])]).slice(0, 200),
        slangKeys: Object.keys(state.synonyms.slang || {}),
        abbrevKeys: Object.keys(state.synonyms.abbrev || {}),
      };
      const sample = state.engine.items.filter((i) => i.totalQty > 0).slice(0, 150)
        .map((i) => `${i.mfr} ${i.cat} ${i.desc}`);
      const prompt = `These searches at an electrical counter found NOTHING:\n${JSON.stringify(missed)}\n
Already-known jargon terms (don't re-suggest): ${JSON.stringify(known)}\n
A sample of what IS in the catalog (mfr cat description):\n${sample.join('\n')}\n
For each missed search you can confidently explain, propose how the app should learn it. Reply with ONLY a JSON array; each element:
{"kind": "synonym"|"jargon-rule", "forQuery": "<the missed search>", "rationale": "<one line>", "payload": ...}
synonym payload: {"type":"slang","key":"<what people say>","values":["<catalog wording>", ...]} or {"type":"abbrev","key":"<catalog shorthand>","value":"<plain words>"}
jargon-rule payload: {"term":"<trade name>","aliases":[...],"mfr":"<code or null>","match":"<catalog # regex>","hint":"<numbering explained>"}
Only include suggestions you're confident help these specific searches match this catalog. Skip typos and one-off part numbers.`;
      try {
        const r = await ai.msg({ messages: [{ role: 'user', content: prompt }], maxTokens: 3000 });
        const list = ai.parseJSON(ai.textOf(r));
        const queued = [], skipped = [];
        for (const s of Array.isArray(list) ? list : []) {
          try {
            const filed = pendingQueue.file('jargon-suggester', s.kind, s.payload, `${s.rationale} (for: "${s.forQuery}")`);
            if (filed) queued.push(filed.id); else skipped.push(s.forQuery);
          } catch (e) { skipped.push(`${s.forQuery}: ${e.message}`); }
        }
        return json(res, 200, { queued: queued.length, skipped });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (u.pathname === '/api/ai/draft-knowledge' && req.method === 'POST') {
      if (!ai.enabled()) return json(res, 503, { error: 'ai-disabled' });
      const body = await readBody(req);
      const topic = String(body.topic || '').trim();
      if (!topic) return json(res, 400, { error: 'need topic' });
      const hits = state.engine.search(topic, 30, '').results.slice(0, 30)
        .map((r) => ({ id: r.id, mfr: r.mfr, cat: r.cat, desc: r.desc }));
      const example = state.knowledge.entries[0] || { id: 'example', title: 'Example', match: [{ desc: 'EXAMPLE' }], body: '…' };
      const web = hits.slice(0, 5).map((h) => cachedText(h.id)).filter(Boolean).join('\n').slice(0, 3000);
      const prompt = `Write ONE "Learn" entry for the counter-search app at an electrical distributor: how this part family works, how the numbering reads, what it fits with, what customers actually ask for. Topic: "${topic}"\n
Matching catalog items:\n${JSON.stringify(hits)}\n
${web ? `Cached web snippets:\n${web}\n` : ''}
Style/shape example (JSON): ${JSON.stringify(example)}\n
Reply with ONLY one JSON object: {"id":"<kebab-slug>","title":"...","match":[{"mfr":"<code, optional>","cat":"<regex, optional>","desc":"<regex, optional>"}],"body":"<the write-up, plain text, ~150 words, counter-practical>"}
match must select the items above (test your regexes mentally against them).`;
      try {
        const r = await ai.msg({ messages: [{ role: 'user', content: prompt }], maxTokens: 2000 });
        const entry = ai.parseJSON(ai.textOf(r));
        const filed = pendingQueue.file('knowledge-writer', 'knowledge-entry', entry, `drafted for topic "${topic}"`);
        return json(res, 200, { queued: filed ? filed.id : null, title: entry.title });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (u.pathname === '/api/reload' && req.method === 'POST') {
      reloadState('manual');
      return json(res, 200, { ok: !state.reloadError, error: state.reloadError, items: state.engine.items.length });
    }

    if (u.pathname === '/api/meta') {
      const mfrCounts = new Map();
      for (const i of engine.items) mfrCounts.set(i.mfr, (mfrCounts.get(i.mfr) || 0) + 1);
      const mfrs = [...mfrCounts.entries()]
        .map(([code, count]) => ({ code, name: state.mfrMap[code] || code, count }))
        .sort((a, b) => b.count - a.count);
      return json(res, 200, {
        items: engine.items.length,
        edited: Object.keys(overridesObj).length,
        mfrs,
        mfrLogos: state.mfrLogos,
        jargon: state.jargon.rules,
        knowledge: state.knowledge.entries.map(({ id, title, body }) => ({ id, title, body })),
        counterRules: state.counterRules.rules,
        portal: 'https://cedphx.portalced.com/',
        catalogMtime: state.catalogMtime,
        catalogAgeDays: state.catalogMtime ? (Date.now() - state.catalogMtime) / 86400000 : null,
        reloadError: state.reloadError,
        orphanOverrides: state.orphans,
        clients: clientsOnline(),
        missedCount: Object.keys(missedObj).length,
        webHealth: webHealth(),
        ai: { enabled: ai.enabled(), model: ai.config().model },
        pendingCount: pendingQueue.pending().length,
        map: state.map,
      });
    }

    if (u.pathname === '/code128.js') {
      return fs.readFile(path.join(HERE, 'lib', 'code128.js'), (err, buf) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }

    if (u.pathname === '/calc.js') {
      // lib/calc.js is dual-environment: node tests require() it, the browser
      // loads it here (single source, no build step)
      return fs.readFile(path.join(HERE, 'lib', 'calc.js'), (err, buf) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }

    return serveStatic(res, u.pathname);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`CED counter search: ${state.engine.items.length} items loaded`);
  for (const url of lanURLs()) console.log(`  -> ${url}`);
  if (auth.enabled) {
    console.log('Password required — team members sign in once per station (30 days).');
  } else {
    console.log('Anyone on your network can use those addresses — edits are shared.');
    console.log('Going beyond the LAN? Set a password first: CED_PASSWORD=... node server.js');
  }
});
