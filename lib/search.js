'use strict';
// CED counter search engine: jargon -> catalog numbers.
// Scoring layers: exact catalog / UPC > catalog prefix > jargon cheat-sheet rules
// > keyword & description tokens (with slang + abbreviation expansion) > trigram fuzz.

const STOP = new Set(['A', 'AN', 'THE', 'OF', 'FOR', 'AND', 'OR', 'WITH', 'IN', 'ON', 'TO', 'I', 'IE', 'AKA']);

// commerce noise excluded from web-derived keywords
const WEB_STOP = new Set(['WITH', 'FROM', 'THIS', 'THAT', 'YOUR', 'SHOP', 'FREE', 'SHIP', 'SHIPPING', 'PRICE',
  'PRICES', 'PRICING', 'STOCK', 'ORDER', 'ORDERS', 'ONLINE', 'VIEW', 'HOME', 'DEPOT', 'AMAZON', 'LOWES', 'WALMART',
  'PRODUCTS', 'PRODUCT', 'ITEM', 'ITEMS', 'RESULTS', 'SEARCH', 'QUANTITY', 'WHOLESALE', 'SUPPLY', 'SUPPLIES',
  'DETAILS', 'CATALOG', 'DESCRIPTION', 'REVIEWS', 'PACK', 'IMAGE', 'IMAGES', 'GORDON', 'ELLIOTT', 'PLATT',
  'GRAINGER', 'ZORO', 'EBAY', 'WAREHOUSE', 'DISTRIBUTORS', 'ELECTRIC', 'ELECTRICAL', 'COMPANY', 'BRAND',
  'AVAILABLE', 'QUALITY', 'CONTACT', 'ABOUT', 'MORE', 'FIND', 'BEST', 'DEAL', 'DEALS', 'SALE', 'BUY']);

function collapse(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Keep sizes like 1/2, 1-1/2, 5-20R intact AND emit their atomic parts.
function tokenize(s) {
  const up = String(s || '').toUpperCase();
  const out = new Set();
  const compounds = up.match(/[A-Z0-9]+(?:[/-][A-Z0-9]+)+/g) || [];
  for (const c of compounds) {
    out.add(c);
    for (const p of c.split(/[/-]/)) if (p) out.add(p);
  }
  const atoms = up.match(/[A-Z0-9]+/g) || [];
  for (const a of atoms) {
    out.add(a);
    // split alpha<->digit boundaries so FLNR060 -> FLNR + 060 (+ 60), QO120 -> QO + 120
    const parts = a.match(/[A-Z]+|\d+/g) || [];
    if (parts.length > 1) {
      for (const p of parts) {
        out.add(p);
        if (/^\d+$/.test(p)) out.add(String(Number(p)));
      }
    }
  }
  for (const t of [...out]) if (STOP.has(t)) out.delete(t);
  return out;
}

// Trade sizes come in two spellings — 3/4 and .75 — and both appear in
// catalogs and speech. Decimals canonicalize to the fraction form (which
// tokenize() keeps intact), applied on both the query and the description
// so either spelling finds the other.
const DEC2FRAC = {
  '.125': '1/8', '.25': '1/4', '.375': '3/8', '.5': '1/2', '.625': '5/8', '.75': '3/4', '.875': '7/8',
  '1.25': '1-1/4', '1.5': '1-1/2', '1.75': '1-3/4', '2.5': '2-1/2', '3.5': '3-1/2',
};
function numberVariants(s) {
  const out = new Set();
  for (const m of String(s || '').matchAll(/\d*\.\d+/g)) {
    const d = m[0].replace(/^0(?=\.)/, ''); // 0.75 -> .75
    const f = DEC2FRAC[d];
    if (f) {
      out.add(f);
      for (const p of f.split(/[/-]/)) if (p) out.add(p);
    }
  }
  return out;
}

// CED's product-image CDN path is derived from the UPC
function cedImageFor(upc, n = 1) {
  const u = String(upc || '').replace(/\D/g, '');
  if (u.length < 8) return null;
  return `https://cdn.myced.com/images/Products/${u[0]}00000/${u.slice(0, 6)}/${u[6]}0000/${u}_O${n}_600x600.jpg`;
}

function trigrams(s) {
  const t = new Set();
  const str = `  ${collapse(s)} `;
  for (let i = 0; i < str.length - 2; i++) t.add(str.slice(i, i + 3));
  return t;
}

function setOverlap(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function createEngine({ catalog, jargon, synonyms, mfrMap, overrides, webText }) {
  const slang = {};
  for (const [k, v] of Object.entries(synonyms.slang || {})) slang[k.toUpperCase()] = v.map((x) => x.toUpperCase());
  const abbrev = {};
  for (const [k, v] of Object.entries(synonyms.abbrev || {})) abbrev[k.toUpperCase()] = v.toUpperCase();

  // reverse slang: expansion word -> the trade-slang keys that produce it
  // ("SWITCH" -> toggle, rocker, paddle), used to keyword items by their descriptions
  const revSlang = new Map();
  for (const [k, vals] of Object.entries(slang)) {
    for (const v of vals) {
      for (const w of tokenize(v)) {
        if (w.length < 4) continue;
        if (!revSlang.has(w)) revSlang.set(w, []);
        if (revSlang.get(w).length < 4) revSlang.get(w).push(k.toLowerCase());
      }
    }
  }

  const rules = (jargon.rules || []).map((r) => ({
    ...r,
    re: new RegExp(r.match, 'i'),
    aliasSets: [r.term, ...(r.aliases || [])].map((a) => tokenize(a)),
  }));

  const items = [];
  const byId = new Map();

  function indexItem(raw) {
    const o = (overrides.get && overrides.get(raw.id)) || {};
    const desc = o.desc || raw.desc || '';
    const keywords = o.keywords || [];
    const descTokens = tokenize(desc);
    for (const t of numberVariants(desc)) descTokens.add(t); // 0.75 in desc -> searchable as 3/4
    const expTokens = new Set();
    for (const t of descTokens) if (abbrev[t]) for (const w of tokenize(abbrev[t])) expTokens.add(w);
    // also expand original-file desc if overridden, so old shorthand still matches
    if (o.desc && raw.desc) for (const t of tokenize(raw.desc)) { descTokens.add(t); if (abbrev[t]) for (const w of tokenize(abbrev[t])) expTokens.add(w); }
    const kwTokens = new Set();
    for (const k of keywords) for (const t of tokenize(k)) kwTokens.add(t);
    // B-Line style zero-padded dims (SC060604NK) -> searchable 6X6X4 / 6X6 tokens
    const dim = /R?SC(\d{2})(\d{2})(\d{2})/.exec(`${raw.cat} ${desc}`);
    if (dim) {
      const [a, b, c] = dim.slice(1).map(Number);
      descTokens.add(`${a}X${b}`); descTokens.add(`${a}X${b}X${c}`); descTokens.add(`${a}${b}${c}`);
    }
    // cached web result titles/snippets become searchable (lower weight, via expTokens)
    if (webText) for (const t of tokenize(webText(raw.id))) expTokens.add(t);
    // auto-keywords, three sources so EVERY item gets some:
    // 1. cheat-sheet rules (trade names), 2. expanded description shorthand,
    // 3. frequent words from its cached web results (incl. CED portal wording)
    const autoKeywords = [];
    const autoTokens = new Set();
    for (const r of rules) {
      if (r.mfr && r.mfr !== raw.mfr) continue;
      if (!r.re.test(raw.cat)) continue;
      autoKeywords.push(r.term, ...(r.aliases || []));
      for (const a of [r.term, ...(r.aliases || [])]) for (const t of tokenize(a)) autoTokens.add(t);
    }
    for (const t of tokenize(`${raw.desc || ''} ${raw.cat || ''}`)) {
      if (abbrev[t]) {
        const kw = abbrev[t].toLowerCase();
        autoKeywords.push(kw);
        for (const w of tokenize(kw)) autoTokens.add(w);
      }
      const rev = revSlang.get(t) || (slang[t] ? [t.toLowerCase()] : null); // slang keys in cat #s count too (THHN, MC…)
      if (rev) {
        for (const k of rev.slice(0, 2)) {
          if (autoKeywords.length > 14) break;
          autoKeywords.push(k);
          for (const w of tokenize(k)) autoTokens.add(w);
        }
      }
    }
    if (webText) {
      const known = new Set([...descTokens, ...tokenize(raw.cat), ...tokenize(mfrMap[raw.mfr] || ''), ...autoTokens]);
      const counts = new Map();
      for (const t of tokenize(webText(raw.id))) {
        if (t.length < 4 || /\d/.test(t) || known.has(t) || WEB_STOP.has(t)) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
      const top = [...counts].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5);
      for (const [t] of top) {
        autoKeywords.push(t.toLowerCase());
        autoTokens.add(t);
      }
    }
    // 4. guarantee: every catalog number ships with AT LEAST 5 tags, even with
    // no rule hit and no web cache — topped up from (in order) plain-English
    // words, word pairs the way customers say them, spoken sizes, and the
    // manufacturer name
    {
      // count UNIQUE tags — earlier layers can push duplicates ("jbox" x3)
      const seen = new Set(autoKeywords.map((k) => String(k).toLowerCase()));
      const add = (w) => {
        const k = String(w).toLowerCase().trim();
        if (!k || seen.has(k)) return;
        seen.add(k);
        autoKeywords.push(k);
        for (const x of tokenize(k)) autoTokens.add(x);
      };
      const full = () => seen.size >= 5;
      // single words from the abbrev-expanded description ("RECPT" -> receptacle);
      // words like SNAP2IT keep their digits, pure sizes/amp ratings don't count
      const singles = [];
      for (const t of tokenize(desc)) {
        const w = (abbrev[t] || t).toLowerCase();
        if (w.length >= 3 && (w.match(/[a-z]/g) || []).length >= 2 && !STOP.has(w.toUpperCase()) && !singles.includes(w)) singles.push(w);
      }
      singles.sort((a, b) => b.length - a.length);
      for (const w of singles) { if (full()) break; add(w); }
      // consecutive word pairs the way customers say them ("set screw", "wire nut")
      const words = String(desc).toLowerCase().split(/\s+/)
        .map((w) => w.replace(/[^a-z0-9/#.-]/g, '')).filter(Boolean);
      for (let i = 0; i < words.length - 1 && !full(); i++) {
        if (/[a-z]/.test(words[i]) || /[a-z]/.test(words[i + 1])) add(`${words[i]} ${words[i + 1]}`);
      }
      // trade sizes spoken aloud ("3/4 inch")
      for (const t of tokenize(desc)) {
        if (full()) break;
        if (t.includes('/') && /^\d+(?:\/\d+)?(?:-\d+\/\d+)?$/.test(t)) add(`${t} inch`);
      }
      // electrical shorthand spoken aloud ("20A" -> "20 amp", "2P" -> "2 pole")
      for (const t of tokenize(desc)) {
        if (full()) break;
        let m;
        if ((m = /^(\d+)A$/.exec(t))) add(`${m[1]} amp`);
        else if ((m = /^(\d+)V$/.exec(t))) add(`${m[1]} volt`);
        else if ((m = /^(\d+)P$/.exec(t))) add(`${m[1]} pole`);
      }
      const mn = mfrMap[raw.mfr] && !mfrMap[raw.mfr].includes('(') ? mfrMap[raw.mfr] : '';
      const mfrTag = mn || String(raw.mfr); // fall back to the code when the name is a guess
      if (!full()) add(mfrTag);
      // catalog number the way it's said out loud ("ph 750"), its prefix
      // family ("ya44"), then verbatim part codes and manufacturer combos —
      // last resorts for items whose description is all codes
      if (!full()) {
        const parts = String(raw.cat).match(/[A-Za-z]+|\d+/g) || [];
        if (parts.length >= 2) add(parts.slice(0, 2).join(' '));
      }
      if (!full()) add(String(raw.cat));
      if (!full()) {
        const pref = /^([A-Za-z]+\d+)/.exec(String(raw.cat));
        if (pref && pref[1].length < String(raw.cat).length) add(pref[1]);
      }
      for (const w of String(desc).toLowerCase().split(/\s+/)) {
        if (full()) break;
        const clean = w.replace(/[^a-z0-9/#.-]/g, '');
        if (clean.length >= 3) add(clean);
      }
      if (!full() && singles.length) add(`${mfrTag} ${singles[0]}`);
      if (!full()) add(`${mfrTag} ${String(raw.cat)}`);
    }
    const mfrName = mfrMap[raw.mfr] || '';
    const it = {
      ...raw,
      desc,
      origDesc: raw.desc,
      keywords,
      notes: o.notes || '',
      image: o.image || '',
      edited: !!(o.desc || (o.keywords && o.keywords.length) || o.notes),
      mfrName,
      ncat: collapse(raw.cat),
      catTokens: tokenize(raw.cat),
      descTokens,
      expTokens,
      kwTokens,
      autoKeywords: [...new Set(autoKeywords)],
      autoTokens,
      mfrTokens: new Set([raw.mfr.toUpperCase(), ...tokenize(mfrName)]),
      tri: trigrams(`${raw.cat} ${desc}`),
      totalQty: (raw.bins || []).reduce((s, b) => s + (b.qty || 0), 0),
    };
    return it;
  }

  for (const raw of catalog.items) {
    const it = indexItem(raw);
    items.push(it);
    byId.set(it.id, it);
  }

  function reindex(id, rawPatch) {
    const cur = byId.get(id);
    if (!cur) return null;
    const raw = { id: cur.id, mfr: cur.mfr, cat: cur.cat, desc: cur.origDesc, upc: cur.upc, bins: cur.bins, lots: cur.lots };
    const it = indexItem(raw);
    const idx = items.findIndex((x) => x.id === id);
    items[idx] = it;
    byId.set(id, it);
    return it;
  }

  function matchRules(qTokens) {
    // significant query tokens: words like "gfci"/"sealtight", not sizes or digits
    const sig = [...qTokens].filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !t.includes('/'));
    const hits = [];
    for (const r of rules) {
      let best = 0;
      for (const aset of r.aliasSets) {
        if (!aset.size) continue;
        let m = 0;
        for (const w of aset) {
          if (qTokens.has(w)) { m++; continue; }
          for (const qt of qTokens) if (qt.length >= 3 && (w.startsWith(qt) || qt.startsWith(w))) { m += 0.75; break; }
        }
        const frac = m / aset.size;
        if (frac > best) best = frac;
        // subset match: every significant query word appears in this alias
        // ("gfci" alone should still hit "gfci 15"), weaker than full coverage
        if (frac < 0.7 && sig.length && sig.length <= 2 && sig.every((t) => aset.has(t))) best = Math.max(best, 0.7);
      }
      if (best >= 0.65) hits.push({ rule: r, strength: best });
    }
    hits.sort((a, b) => b.strength - a.strength);
    return hits;
  }

  function toResult(it, extra) {
    // bin quantities and lot counts are internal — only locations leave the server
    return {
      id: it.id, mfr: it.mfr, mfrName: it.mfrName, cat: it.cat, desc: it.desc,
      origDesc: it.origDesc, upc: it.upc, bins: (it.bins || []).map(({ bin, zone }) => ({ bin, zone })),
      keywords: it.keywords, autoKeywords: it.autoKeywords, notes: it.notes, edited: it.edited,
      image: it.image, cedImage: cedImageFor(it.upc), score: 0, why: [], ruleName: null, ...extra,
    };
  }

  function search(q, limit = 10, mfrFilter = '') {
    q = String(q || '').trim();
    mfrFilter = String(mfrFilter || '').trim().toUpperCase();
    if (!q) {
      // browse mode: no query but a manufacturer picked -> alphabetical listing
      if (mfrFilter) {
        const list = items.filter((it) => it.mfr === mfrFilter)
          .sort((a, b) => a.cat.localeCompare(b.cat))
          .slice(0, Math.max(limit, 300))
          .map((it) => toResult(it, { why: ['browsing manufacturer'] }));
        return { query: q, results: list, jargon: [] };
      }
      return { query: q, results: [], jargon: [] };
    }
    const nq = collapse(q);
    const qDigits = q.replace(/\D/g, '');
    const qTokens = tokenize(q);
    // dimension asks: "6x6" / "12x12x4" also match collapsed digits in catalog #s (664SCNK, 12124SCNK)
    for (const t of [...qTokens]) {
      const dim = /^(\d{1,2})X(\d{1,2})(?:X(\d{1,2}))?$/.exec(t);
      if (dim) qTokens.add(dim.slice(1).filter(Boolean).join(''));
    }
    const origTokens = [...qTokens];
    // slang expansion (lower weight)
    const expanded = new Map(); // token -> weight
    for (const t of qTokens) {
      if (slang[t]) for (const s of slang[t]) for (const st of tokenize(s)) if (!qTokens.has(st)) expanded.set(st, 0.6);
    }
    // decimal sizes in the query match fraction spellings (".75" -> 3/4)
    for (const t of numberVariants(q)) if (!qTokens.has(t)) expanded.set(t, 0.9);
    const ruleHits = matchRules(qTokens);
    const qTri = trigrams(q);

    const scored = [];
    for (const it of items) {
      if (mfrFilter && it.mfr !== mfrFilter) continue;
      let score = 0;
      const why = [];

      // catalog number layers
      if (nq && it.ncat === nq) { score += 1000; why.push('exact catalog #'); }
      else if (nq.length >= 3 && it.ncat.startsWith(nq)) { score += 420 + Math.round(160 * (nq.length / it.ncat.length)); why.push('catalog # prefix'); }
      else if (nq.length >= 4 && it.ncat.includes(nq)) { score += 220; why.push('catalog # contains'); }
      if (qDigits.length >= 8 && it.upc && it.upc.includes(qDigits)) { score += 900; why.push('UPC'); }

      // jargon cheat-sheet rules
      let ruleName = null;
      for (const h of ruleHits) {
        if ((!h.rule.mfr || h.rule.mfr === it.mfr) && h.rule.re.test(it.cat)) {
          score += Math.round(480 * h.strength);
          ruleName = h.rule.term;
          why.push(`cheat sheet: ${h.rule.term}`);
          break;
        }
      }

      // token layers — short pure-digit tokens (split debris like "1","2") count much less
      let matched = 0;
      for (const t of origTokens) {
        const w = /^\d{1,2}$/.test(t) && t.length === 1 ? 0.2 : t.length === 2 && /^\d+$/.test(t) ? 0.6 : 1;
        let s = 0;
        if (it.kwTokens.has(t)) s = 150;
        else if (it.autoTokens.has(t)) s = 100;
        else if (it.descTokens.has(t) || it.catTokens.has(t)) s = 90;
        else if (it.expTokens.has(t) || it.mfrTokens.has(t)) s = 60;
        else if (t.length >= 3) {
          for (const dt of it.catTokens) if (dt.startsWith(t)) { s = 45; break; }
          if (!s) for (const dt of it.descTokens) if (dt.startsWith(t)) { s = 40; break; }
          if (!s) for (const dt of it.expTokens) if (dt.startsWith(t)) { s = 30; break; }
          if (!s && t.length >= 4) { // substring fallback: "tight" finds LIQUIDTIGHT
            for (const dt of it.descTokens) if (dt.includes(t)) { s = 25; break; }
            if (!s) for (const dt of it.expTokens) if (dt.includes(t)) { s = 20; break; }
          }
        }
        if (s) matched++;
        score += Math.round(s * w);
      }
      for (const [t, w] of expanded) {
        if (it.descTokens.has(t) || it.catTokens.has(t) || it.kwTokens.has(t)) score += Math.round(70 * w);
        else if (it.expTokens.has(t)) score += Math.round(45 * w);
      }
      if (origTokens.length > 1) score += Math.round(140 * (matched / origTokens.length));

      // typo tolerance
      if (score < 200 && nq.length >= 4) {
        const ov = setOverlap(qTri, it.tri);
        const sim = ov / (qTri.size + it.tri.size - ov);
        if (sim > 0.3) { score += Math.round(90 * sim); why.push('fuzzy'); }
      }

      if (score <= 25) continue;
      if (it.totalQty > 0) score += 25;
      scored.push({ it, score, why, ruleName });
    }

    scored.sort((a, b) => b.score - a.score || b.it.totalQty - a.it.totalQty);
    // show everything related, not a fixed top-10: keep anything scoring within
    // a fraction of the best hit (plus an absolute floor), capped only for sanity
    const topScore = scored.length ? scored[0].score : 0;
    const floor = Math.max(45, topScore * 0.12);
    const kept = scored.filter((s) => s.score >= floor).slice(0, Math.max(limit, 500));
    const top = kept.map(({ it, score, why, ruleName }) => toResult(it, { score, why, ruleName }));
    return {
      query: q,
      results: top,
      jargon: ruleHits.slice(0, 4).map((h) => ({ term: h.rule.term, mfr: h.rule.mfr, match: h.rule.match, hint: h.rule.hint })),
    };
  }

  return { search, byId, items, rules, reindex, resultFor: (id) => { const it = byId.get(id); return it ? toResult(it, {}) : null; } };
}

module.exports = { createEngine, collapse, tokenize, cedImageFor, numberVariants };
