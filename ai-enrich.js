'use strict';
// Batch keyword enrichment via Claude: suggest counter-jargon keywords for
// top-stocked items that have none. Everything lands in the pending queue —
// nothing is applied without approval in the Suggestions tab.
//
//   node ai-enrich.js --limit 50 --yes
//
// Uses the cheap model (default claude-haiku-4-5). Costs real money at scale:
// the script prints the item count and requires --yes before calling the API.

const fs = require('fs');
const path = require('path');
const ai = require('./lib/ai');
const { createQueue } = require('./lib/pending');
const { cachedText } = require('./lib/web');

const DATA = (f) => path.join(__dirname, 'data', f);
const catalog = JSON.parse(fs.readFileSync(DATA('catalog.json'), 'utf8'));
const overrides = JSON.parse(fs.existsSync(DATA('overrides.json')) ? fs.readFileSync(DATA('overrides.json'), 'utf8') : '{}');
const mfrMap = JSON.parse(fs.readFileSync(DATA('mfr.json'), 'utf8')).map;

const args = process.argv.slice(2);
const limIdx = args.indexOf('--limit');
const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : 50;
const yes = args.includes('--yes');

if (!ai.enabled()) {
  console.error('AI is not configured — set ANTHROPIC_API_KEY or data/config.json');
  process.exit(1);
}

const ids = new Set(catalog.items.map((i) => i.id));
const queue = createQueue({
  dataDir: path.join(__dirname, 'data'),
  itemExists: (id) => ids.has(id),
  applyOverride: () => { throw new Error('approve suggestions in the app, not from this script'); },
});
const alreadyPending = new Set(queue.pending().filter((s) => s.kind === 'item-keywords').map((s) => s.payload.id));

const todo = catalog.items
  .filter((i) => i.bins.some((b) => b.qty > 0))
  .filter((i) => !(overrides[i.id] || {}).keywords?.length && !alreadyPending.has(i.id))
  .sort((a, b) => b.bins.reduce((s, x) => s + x.qty, 0) - a.bins.reduce((s, x) => s + x.qty, 0))
  .slice(0, limit);

const BATCH = 10;
const batches = Math.ceil(todo.length / BATCH);
console.log(`${todo.length} items to enrich in ${batches} API calls (model: ${ai.config().cheapModel}).`);
console.log(`Rough cost: well under $0.01 per batch at Haiku rates — ~${batches} batches total.`);
if (!yes) {
  console.log('Dry run. Add --yes to call the API.');
  process.exit(0);
}

(async () => {
  let queued = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH).map((it) => ({
      id: it.id, mfr: mfrMap[it.mfr] || it.mfr, cat: it.cat, desc: it.desc,
      web: cachedText(it.id).slice(0, 400),
    }));
    const prompt = `For each electrical part below, suggest 2-5 search keywords a counter customer would actually say — trade slang, plain-English names, common misspellings (e.g. "sealtite"). Skip anything already in the description verbatim.
Parts: ${JSON.stringify(chunk)}
Reply with ONLY a JSON array: [{"id":"<id>","keywords":["..."],"why":"<one line>"}] — omit items you can't improve.`;
    try {
      const r = await ai.msg({ model: ai.config().cheapModel, messages: [{ role: 'user', content: prompt }], maxTokens: 2000 });
      for (const s of ai.parseJSON(ai.textOf(r))) {
        try {
          const filed = queue.file('enricher', 'item-keywords', { id: s.id, keywords: s.keywords }, s.why || '');
          if (filed) queued++;
        } catch (e) { console.error(`  skip ${s.id}: ${e.message}`); }
      }
      console.log(`batch ${i / BATCH + 1}/${batches} done (${queued} queued so far)`);
    } catch (e) {
      console.error(`batch ${i / BATCH + 1} failed: ${e.message} — continuing`);
    }
  }
  console.log(`\n${queued} suggestions queued — review them in the app's Suggestions tab.`);
})();
