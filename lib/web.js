'use strict';
// Top-5 web results via DuckDuckGo's lite HTML endpoint (no API key).
// Results are cached forever in data/webcache.json; pass force=true to refresh.

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'webcache.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { cache = {}; }

let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 1), () => {});
  }, 300);
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function parseLite(html) {
  const out = [];
  // anchors: <a rel="nofollow" href="//duckduckgo.com/l/?uddg=ENCODED&rut=...">Title</a>
  const re = /<a rel="nofollow" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a rel="nofollow"|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    const href = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (!uddg) continue;
    let url;
    try { url = decodeURIComponent(uddg[1]); } catch { continue; }
    if (url.includes('duckduckgo.com/y.js') || url.includes('bing.com/aclick')) continue; // ads
    const title = stripTags(m[2]);
    if (!title) continue;
    const snipMatch = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(m[3]);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : '';
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    out.push({ title, url, snippet, domain });
  }
  return out.slice(0, 5);
}

async function ddg(query) {
  const res = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  return parseLite(await res.text());
}

// image search: fetch a vqd token for the query, then hit the JSON endpoint
async function ddgImages(query) {
  const res = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&iax=images&ia=images', {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  const m = /vqd="?([\d-]+)"?/.exec(html);
  if (!m) throw new Error('no vqd token (image search blocked?)');
  const res2 = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${m[1]}&f=,,,&p=1`, {
    headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res2.ok) throw new Error(`image endpoint returned ${res2.status}`);
  const data = await res2.json();
  // keep a deeper pool than the 18 displayed so dead images can be backfilled
  return (data.results || []).slice(0, 40).map((r) => ({
    title: r.title || '', image: r.image, thumbnail: r.thumbnail, url: r.url || '', source: r.source || '',
  }));
}

async function imageLookup(key, query, force = false) {
  const k = 'img:' + key;
  if (!force && cache[k] && cache[k].images && cache[k].images.length) return cache[k];
  const entry = { query, fetchedAt: new Date().toISOString(), images: await ddgImages(query) };
  cache[k] = entry;
  saveCache();
  return entry;
}

// check which CED CDN image URLs actually exist (cached forever)
async function verifyImages(key, urls) {
  const k = 'cedok:' + key;
  if (cache[k]) return cache[k].urls;
  const checks = await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetch(u, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      return r.ok ? u : null;
    } catch { return null; }
  }));
  const ok = checks.filter(Boolean);
  cache[k] = { urls: ok, fetchedAt: new Date().toISOString() };
  saveCache();
  return ok;
}

async function webLookup(key, query, force = false) {
  if (!force && cache[key] && cache[key].results && cache[key].results.length) return cache[key];
  const entry = { query, fetchedAt: new Date().toISOString(), results: await ddg(query) };
  cache[key] = entry;
  saveCache();
  return entry;
}

function cached(key) {
  return cache[key] || null;
}

// searchable text from an item's cached web results
function cachedText(key) {
  const c = cache[key];
  if (!c || !c.results) return '';
  return c.results.map((r) => `${r.title} ${r.snippet}`).join(' ');
}

module.exports = { webLookup, imageLookup, verifyImages, cached, cachedText };
