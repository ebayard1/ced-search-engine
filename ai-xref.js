'use strict';
// Substitute-group discovery via Claude: cluster similar items across
// manufacturers locally (cheap), then ask the model to confirm which are
// true interchangeable substitutes. Confirmed groups land in the pending
// queue — wrong subs cost real money, so approval is never skipped.
//
//   node ai-xref.js --limit 20 --yes

const fs = require('fs');
const path = require('path');
const ai = require('./lib/ai');
const { createQueue } = require('./lib/pending');
const { tokenize } = require('./lib/search');

const DATA = (f) => path.join(__dirname, 'data', f);
const catalog = JSON.parse(fs.readFileSync(DATA('catalog.json'), 'utf8'));
const xref = JSON.parse(fs.existsSync(DATA('xref.json')) ? fs.readFileSync(DATA('xref.json'), 'utf8') : '{"groups":[]}');

const args = process.argv.slice(2);
const limIdx = args.indexOf('--limit');
const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : 20;
const yes = args.includes('--yes');

if (!ai.enabled()) {
  console.error('AI is not configured — set ANTHROPIC_API_KEY or data/config.json');
  process.exit(1);
}

// local pre-clustering: stocked items from different mfrs whose descriptions
// share most of their meaningful tokens
const grouped = new Set(xref.groups.flatMap((g) => g.ids));
const items = catalog.items
  .filter((i) => i.bins.length && !grouped.has(i.id))
  .map((i) => ({ ...i, toks: new Set([...tokenize(i.desc)].filter((t) => t.length >= 3)) }));

function jaccard(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / (a.size + b.size - n || 1);
}

const clusters = [];
const used = new Set();
for (const it of items) {
  if (used.has(it.id) || it.toks.size < 2) continue;
  const near = items.filter((o) => o !== it && !used.has(o.id) && o.mfr !== it.mfr && jaccard(it.toks, o.toks) >= 0.6);
  if (near.length) {
    const c = [it, ...near.slice(0, 4)];
    c.forEach((x) => used.add(x.id));
    clusters.push(c);
  }
  if (clusters.length >= limit) break;
}

console.log(`${clusters.length} candidate clusters (model: ${ai.config().cheapModel}, 1 API call per ~8 clusters).`);
if (!clusters.length) process.exit(0);
if (!yes) {
  clusters.slice(0, 5).forEach((c) => console.log(' ', c.map((i) => `${i.id}`).join('  <->  ')));
  console.log('Dry run. Add --yes to call the API.');
  process.exit(0);
}

const ids = new Set(catalog.items.map((i) => i.id));
const queue = createQueue({
  dataDir: path.join(__dirname, 'data'),
  itemExists: (id) => ids.has(id),
  applyOverride: () => { throw new Error('approve suggestions in the app'); },
});

(async () => {
  let queued = 0;
  const CHUNK = 8;
  for (let i = 0; i < clusters.length; i += CHUNK) {
    const chunk = clusters.slice(i, i + CHUNK).map((c, n) => ({
      cluster: n, items: c.map((x) => ({ id: x.id, mfr: x.mfr, cat: x.cat, desc: x.desc })),
    }));
    const prompt = `Each cluster below groups electrical parts from DIFFERENT manufacturers with similar descriptions. For each cluster, decide whether the items are true interchangeable substitutes (same function, size, rating — a counter person could hand one over when the other is out). Be conservative: different sizes, amperages, or materials are NOT substitutes.
${JSON.stringify(chunk)}
Reply with ONLY a JSON array of the clusters that ARE substitutes: [{"ids":["MFR|CAT", ...],"note":"<what they are + any caveat>"}]`;
    try {
      const r = await ai.msg({ model: ai.config().cheapModel, messages: [{ role: 'user', content: prompt }], maxTokens: 2000 });
      for (const g of ai.parseJSON(ai.textOf(r))) {
        try {
          const filed = queue.file('sub-finder', 'xref-group', { ids: g.ids, note: g.note }, g.note || '');
          if (filed) queued++;
        } catch (e) { console.error(`  skip: ${e.message}`); }
      }
    } catch (e) {
      console.error(`chunk failed: ${e.message} — continuing`);
    }
  }
  console.log(`${queued} substitute groups queued — review in the Suggestions tab.`);
})();
