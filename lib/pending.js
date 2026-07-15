'use strict';
// Suggestion queue — the approval spine for everything AI-written.
// Nothing lands in jargon/synonyms/knowledge/xref/overrides without a human
// clicking Approve; approving merges into the target file atomically and the
// server's fs.watch hot-reload picks it up.

const fs = require('fs');
const path = require('path');
const { saveJSONAtomic } = require('./store');

const KINDS = ['jargon-rule', 'synonym', 'item-keywords', 'item-note', 'knowledge-entry', 'xref-group'];

// deps: { dataDir, itemExists(id) -> bool, applyOverride({id, keywords, note}) }
function createQueue(deps) {
  const PENDING_PATH = path.join(deps.dataDir, 'pending.json');
  let obj;
  try { obj = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); } catch { obj = { suggestions: [] }; }
  const save = () => saveJSONAtomic(PENDING_PATH, obj);

  let seq = 0;
  function file(source, kind, payload, rationale) {
    if (!KINDS.includes(kind)) throw new Error(`unknown suggestion kind ${kind}`);
    validate(kind, payload); // reject junk at filing time, not approval time
    // don't queue duplicates of something already pending
    const key = JSON.stringify([kind, payload]);
    if (obj.suggestions.some((s) => s.status === 'pending' && JSON.stringify([s.kind, s.payload]) === key)) return null;
    const s = {
      id: 'S' + Date.now().toString(36) + (seq++).toString(36),
      createdAt: new Date().toISOString(),
      source, kind, payload,
      rationale: String(rationale || ''),
      status: 'pending',
    };
    obj.suggestions.push(s);
    save();
    return s;
  }

  function validate(kind, p) {
    const need = (cond, msg) => { if (!cond) throw new Error(`invalid ${kind}: ${msg}`); };
    if (kind === 'jargon-rule') {
      need(p && p.term && p.match, 'needs term + match');
      new RegExp(p.match); // throws if it doesn't compile
    } else if (kind === 'synonym') {
      need(p && ['slang', 'abbrev'].includes(p.type), 'type must be slang|abbrev');
      need(p.key, 'needs key');
      if (p.type === 'slang') need(Array.isArray(p.values) && p.values.length, 'slang needs values[]');
      else need(typeof p.value === 'string' && p.value, 'abbrev needs value');
    } else if (kind === 'item-keywords') {
      need(p && p.id && Array.isArray(p.keywords) && p.keywords.length, 'needs id + keywords[]');
      need(deps.itemExists(p.id), `unknown item ${p && p.id}`);
    } else if (kind === 'item-note') {
      need(p && p.id && p.note, 'needs id + note');
      need(deps.itemExists(p.id), `unknown item ${p && p.id}`);
    } else if (kind === 'knowledge-entry') {
      need(p && p.id && p.title && p.body && Array.isArray(p.match), 'needs id/title/body/match[]');
      for (const m of p.match) {
        if (m.cat) new RegExp(m.cat);
        if (m.desc) new RegExp(m.desc);
      }
    } else if (kind === 'xref-group') {
      need(p && Array.isArray(p.ids) && p.ids.length >= 2, 'needs ids[] with 2+ items');
      for (const id of p.ids) need(deps.itemExists(id), `unknown item ${id}`);
    }
  }

  function mergeFile(name, fallback, fn) {
    const file = path.join(deps.dataDir, name);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = fallback; }
    fn(data);
    saveJSONAtomic(file, data);
  }

  function apply(s) {
    const p = s.payload;
    validate(s.kind, p); // re-validate — catalog may have changed since filing
    if (s.kind === 'jargon-rule') {
      mergeFile('jargon.json', { rules: [] }, (d) => {
        if (d.rules.some((r) => r.term === p.term && r.match === p.match)) return;
        d.rules.push({ term: p.term, aliases: p.aliases || [], mfr: p.mfr || null, match: p.match, hint: p.hint || '' });
      });
    } else if (s.kind === 'synonym') {
      mergeFile('synonyms.json', { slang: {}, abbrev: {} }, (d) => {
        if (p.type === 'slang') {
          const cur = d.slang[p.key] || [];
          d.slang[p.key] = [...new Set([...cur, ...p.values])];
        } else {
          d.abbrev[p.key] = p.value;
        }
      });
    } else if (s.kind === 'item-keywords') {
      deps.applyOverride({ id: p.id, keywords: p.keywords });
    } else if (s.kind === 'item-note') {
      deps.applyOverride({ id: p.id, note: p.note });
    } else if (s.kind === 'knowledge-entry') {
      mergeFile('knowledge.json', { entries: [] }, (d) => {
        if (d.entries.some((e) => e.id === p.id)) throw new Error(`knowledge id ${p.id} already exists`);
        d.entries.push({ id: p.id, title: p.title, match: p.match, body: p.body });
      });
    } else if (s.kind === 'xref-group') {
      mergeFile('xref.json', { groups: [], goesWith: [] }, (d) => {
        d.groups.push({ id: p.id || 'ai-' + s.id, note: p.note || s.rationale || '', ids: p.ids });
      });
    }
  }

  function decide(id, approve) {
    const s = obj.suggestions.find((x) => x.id === id);
    if (!s) throw new Error('unknown suggestion');
    if (s.status !== 'pending') throw new Error(`already ${s.status}`);
    if (approve) apply(s); // throws -> stays pending so the user can see why
    s.status = approve ? 'approved' : 'rejected';
    s.decidedAt = new Date().toISOString();
    save();
    return s;
  }

  return {
    file, decide,
    pending: () => obj.suggestions.filter((s) => s.status === 'pending'),
    all: () => obj.suggestions,
  };
}

module.exports = { createQueue, KINDS };
