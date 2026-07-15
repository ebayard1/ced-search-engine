'use strict';
// Scrape the web for manufacturer logos: for every mfr code with a real company
// name, image-search "<name> logo", download the first usable image to
// public/logos/<CODE>.<ext>, and record it in data/mfrlogos.json.
//
//   node logos.js          -> fetch logos for all named manufacturers (skips ones already done)
//   node logos.js --force  -> refetch everything
//
// Safe to Ctrl-C and re-run.

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT_DIR = path.join(HERE, 'public', 'logos');
const MAP_PATH = path.join(HERE, 'data', 'mfrlogos.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const mfrMap = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'mfr.json'), 'utf8')).map;
fs.mkdirSync(OUT_DIR, { recursive: true });
let logoMap = {};
try { logoMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')); } catch {}

const force = process.argv.includes('--force');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/gif': 'gif' };

async function ddgImages(query) {
  const r = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&iax=images&ia=images',
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  const m = /vqd="?([\d-]+)"?/.exec(await r.text());
  if (!m) throw new Error('no vqd');
  const r2 = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${m[1]}&f=,,,&p=1`,
    { headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/' }, signal: AbortSignal.timeout(15000) });
  if (!r2.ok) throw new Error(`i.js ${r2.status}`);
  return (await r2.json()).results || [];
}

async function tryDownload(url, code) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
  const ext = EXT[ct];
  if (!ext) throw new Error(`not an image: ${ct}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500 || buf.length > 3e6) throw new Error(`bad size ${buf.length}`);
  const file = `${code}.${ext}`;
  fs.writeFileSync(path.join(OUT_DIR, file), buf);
  return file;
}

(async () => {
  const targets = Object.entries(mfrMap)
    .filter(([code, name]) => name && !name.includes('(') && !name.includes('internal')
      && !['conduit', 'building wire', 'flexible conduit'].some((g) => name.toLowerCase().startsWith(g)));
  console.log(`${targets.length} manufacturers to fetch logos for`);
  let ok = 0, fail = 0;
  for (const [code, name] of targets) {
    if (!force && logoMap[code]) { ok++; continue; }
    try {
      // prefer results whose thumbnails come from logo-ish sources, then anything image-like
      const results = await ddgImages(`"${name}" company logo`);
      let file = null;
      const ranked = results
        .filter((r) => r.image)
        .sort((a, b) => {
          const score = (r) => (/\.(png|svg)(\?|$)/i.test(r.image) ? 2 : 0) + (/logo/i.test(r.image + r.title) ? 1 : 0);
          return score(b) - score(a);
        })
        .slice(0, 6);
      for (const r of ranked) {
        try { file = await tryDownload(r.image, code); break; }
        catch { try { file = await tryDownload(r.thumbnail, code); break; } catch {} }
      }
      if (!file) throw new Error('no downloadable image in top results');
      logoMap[code] = file;
      fs.writeFileSync(MAP_PATH, JSON.stringify(logoMap, null, 1));
      ok++;
      console.log(`✓ ${code} (${name}) -> ${file}`);
    } catch (e) {
      fail++;
      console.log(`✗ ${code} (${name}): ${e.message}`);
    }
    await sleep(2200 + Math.random() * 1200);
  }
  console.log(`done: ${ok} logos, ${fail} failed. Restart server.js to serve the new map.`);
})();
