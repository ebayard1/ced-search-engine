'use strict';
// Batch web enrichment: pre-fetch top-5 web results for stocked items so
// lookups are instant and their descriptions become searchable.
//
//   node enrich.js              -> enrich 200 most-stocked un-enriched items
//   node enrich.js --limit 1000 -> more (roughly 3s per item; be patient)
//   node enrich.js --all        -> everything with a bin location
//
// Progress is saved continuously in data/webcache.json — safe to Ctrl-C and
// re-run; already-enriched items are skipped. If DuckDuckGo starts rate
// limiting (repeated failures), stop and try again later.

const fs = require('fs');
const path = require('path');
const { webLookup, cached } = require('./lib/web');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'catalog.json'), 'utf8'));
const mfrMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'mfr.json'), 'utf8')).map;

const args = process.argv.slice(2);
const all = args.includes('--all');
const limIdx = args.indexOf('--limit');
const limit = all ? Infinity : limIdx >= 0 ? Number(args[limIdx + 1]) : 200;

const GENERIC = new Set(['WIRE', 'COND', 'CED']); // web search on these is noise

const todo = catalog.items
  .filter((i) => i.bins.length && !GENERIC.has(i.mfr) && !cached(i.id))
  .sort((a, b) => b.bins.reduce((s, x) => s + x.qty, 0) - a.bins.reduce((s, x) => s + x.qty, 0))
  .slice(0, limit);

console.log(`${todo.length} items to enrich (of ${catalog.items.length} total)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ok = 0, fail = 0, consecFail = 0;
  for (const [n, it] of todo.entries()) {
    const name = mfrMap[it.mfr] && !mfrMap[it.mfr].includes('(') ? mfrMap[it.mfr] : it.mfr;
    const q = `${name} ${it.cat} electrical`;
    try {
      const e = await webLookup(it.id, q);
      ok++; consecFail = 0;
      console.log(`[${n + 1}/${todo.length}] ${it.mfr} ${it.cat} -> ${e.results.length} results`);
    } catch (err) {
      fail++; consecFail++;
      console.log(`[${n + 1}/${todo.length}] ${it.mfr} ${it.cat} FAILED: ${err.message}`);
      if (consecFail >= 5) {
        console.log('5 failures in a row — probably rate limited. Stopping; re-run later.');
        break;
      }
      await sleep(15000);
    }
    await sleep(2500 + Math.random() * 1500); // be polite, avoid rate limiting
  }
  console.log(`done: ${ok} enriched, ${fail} failed. Restart server.js to index the new text.`);
})();
