'use strict';
// CED counter search — zero-dependency local server.
//   node server.js          -> http://localhost:8321
//   PORT=9000 node server.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { createEngine, cedImageFor } = require('./lib/search');
const { webLookup, imageLookup, verifyImages, cached, cachedText } = require('./lib/web');

const HERE = __dirname;
const DATA = (f) => path.join(HERE, 'data', f);
const PORT = process.env.PORT || 8321;

function loadJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(DATA(f), 'utf8')); } catch { return fallback; }
}

const catalog = loadJSON('catalog.json', null);
if (!catalog) {
  console.error('data/catalog.json missing — run:  python3 ingest.py');
  process.exit(1);
}
const jargon = loadJSON('jargon.json', { rules: [] });
const synonyms = loadJSON('synonyms.json', { slang: {}, abbrev: {} });
const mfrMap = loadJSON('mfr.json', { map: {} }).map;
const knowledge = loadJSON('knowledge.json', { entries: [] });
const counterRules = loadJSON('counter-rules.json', { rules: [] });
const mfrLogos = loadJSON('mfrlogos.json', {});

// user edits: { [itemId]: { desc, keywords: [], notes } }
const OVERRIDES_PATH = DATA('overrides.json');
const overridesObj = loadJSON('overrides.json', {});
const overrides = { get: (id) => overridesObj[id] };

const engine = createEngine({ catalog, jargon, synonyms, mfrMap, overrides, webText: cachedText });

const knowledgeEntries = knowledge.entries.map((e) => ({
  ...e,
  match: (e.match || []).map((m) => ({
    mfr: m.mfr || null,
    cat: m.cat ? new RegExp(m.cat, 'i') : null,
    desc: m.desc ? new RegExp(m.desc, 'i') : null,
  })),
}));

function knowledgeFor(item) {
  const hits = [];
  for (const e of knowledgeEntries) {
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

function saveOverrides() {
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overridesObj, null, 1));
}

function webQueryFor(item) {
  const name = item.mfrName && !item.mfrName.includes('(') ? item.mfrName : item.mfr;
  return `${name} ${item.cat} electrical`.trim();
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(HERE, 'public', path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(path.join(HERE, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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
  try {
    if (u.pathname === '/api/search') {
      const q = u.searchParams.get('q') || '';
      const out = engine.search(q, Number(u.searchParams.get('n')) || 500, u.searchParams.get('mfr') || '');
      // attach cached web results if we have them (no live fetch on search)
      for (const r of out.results) {
        const c = cached(r.id);
        r.web = c ? c.results : null;
        r.knowledge = knowledgeFor(r).map((k) => k.id);
      }
      return json(res, 200, out);
    }

    if (u.pathname === '/api/item' && req.method === 'GET') {
      const it = engine.byId.get(u.searchParams.get('id'));
      if (!it) return json(res, 404, { error: 'unknown id' });
      const c = cached(it.id);
      return json(res, 200, {
        item: {
          id: it.id, mfr: it.mfr, mfrName: it.mfrName, cat: it.cat, desc: it.desc,
          origDesc: it.origDesc, upc: it.upc, bins: it.bins, lots: it.lots,
          keywords: it.keywords, autoKeywords: it.autoKeywords, notes: it.notes,
          image: it.image,
          cedImages: await verifyImages(it.id, [1, 2, 3].map((n) => cedImageFor(it.upc, n)).filter(Boolean)),
          edited: it.edited, totalQty: it.totalQty,
        },
        web: c || null,
        images: cached('img:' + it.id) || null,
        knowledge: knowledgeFor(it),
        webQuery: webQueryFor(it),
      });
    }

    if (u.pathname === '/api/item' && req.method === 'POST') {
      const body = await readBody(req);
      const it = engine.byId.get(body.id);
      if (!it) return json(res, 404, { error: 'unknown id' });
      const o = overridesObj[body.id] || {};
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
      if (Object.keys(o).length) overridesObj[body.id] = o; else delete overridesObj[body.id];
      saveOverrides();
      const updated = engine.reindex(body.id);
      return json(res, 200, { ok: true, item: { id: updated.id, desc: updated.desc, keywords: updated.keywords, notes: updated.notes, edited: updated.edited } });
    }

    if (u.pathname === '/api/images') {
      const id = u.searchParams.get('id');
      const force = u.searchParams.get('force') === '1';
      const it = id && engine.byId.get(id);
      if (!it) return json(res, 404, { error: 'unknown id' });
      try {
        const entry = await imageLookup(it.id, webQueryFor(it), force);
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

    if (u.pathname === '/api/meta') {
      const mfrCounts = new Map();
      for (const i of engine.items) mfrCounts.set(i.mfr, (mfrCounts.get(i.mfr) || 0) + 1);
      const mfrs = [...mfrCounts.entries()]
        .map(([code, count]) => ({ code, name: mfrMap[code] || code, count }))
        .sort((a, b) => b.count - a.count);
      return json(res, 200, {
        items: engine.items.length,
        stocked: engine.items.filter((i) => i.totalQty > 0).length,
        edited: Object.keys(overridesObj).length,
        mfrs,
        mfrLogos,
        jargon: jargon.rules,
        knowledge: knowledge.entries.map(({ id, title, body }) => ({ id, title, body })),
        counterRules: counterRules.rules,
        portal: 'https://cedphx.portalced.com/',
      });
    }

    return serveStatic(res, u.pathname);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`CED counter search: ${engine.items.length} items loaded -> http://localhost:${PORT}`);
});
