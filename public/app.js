'use strict';
/* CED Counter Search frontend — vanilla JS, no deps. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let META = { jargon: [], knowledge: [], counterRules: [], mfrs: [] };
let openId = null; // expanded card

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (res.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { // fallback for older setups
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
}

// ---------- recent searches ----------
const RECENT_KEY = 'ced-recent-searches';
function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function pushRecent(q, mfr) {
  if (!q) return;
  const list = getRecent();
  const hit = list.find((r) => r.q === q && r.mfr === mfr);
  if (hit) { hit.count = (hit.count || 1) + 1; hit.t = Date.now(); }
  else list.unshift({ q, mfr, t: Date.now(), count: 1 });
  list.sort((a, b) => b.t - a.t);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 30)));
}
const saveRecent = debounce((q, mfr) => pushRecent(q, mfr), 2500); // after you stop typing

// ---------- item interaction tracking (feeds the empty-state rotation) ----------
const ITEMS_KEY = 'ced-item-hits';
function getItemHits() {
  try { return JSON.parse(localStorage.getItem(ITEMS_KEY) || '{}'); } catch { return {}; }
}
function bumpItem(id, cat, desc, mfr) {
  if (!id) return;
  const hits = getItemHits();
  const h = hits[id] || { cat, desc, mfr, count: 0 };
  h.count += 1; h.t = Date.now(); h.cat = cat || h.cat; h.desc = desc || h.desc; h.mfr = mfr || h.mfr;
  hits[id] = h;
  // keep the 60 most recently touched
  const keep = Object.entries(hits).sort((a, b) => b[1].t - a[1].t).slice(0, 60);
  localStorage.setItem(ITEMS_KEY, JSON.stringify(Object.fromEntries(keep)));
}
async function renderRecent() {
  // every part you've used, most-used first — full cards, full list, no cap
  const hits = Object.entries(getItemHits()).sort((a, b) => b[1].count - a[1].count || b[1].t - a[1].t);
  if (!hits.length) { $('#results').innerHTML = ''; return; }
  let full = [];
  try { full = (await api('/api/items?ids=' + encodeURIComponent(hits.map(([id]) => id).join(',')))).items; } catch {}
  if (qInput.value.trim() || mfrSel.value) return; // user started typing while we fetched
  if (!full.length) { $('#results').innerHTML = ''; return; }
  $('#results').innerHTML = `<div class="recent">
    <div class="recenthead">Your most-used parts
      <button class="btn tiny" id="clearrecent">clear</button></div>
    <div class="rotstack">${full.map((r) => `
      <div class="rotitem rotcard" data-q="${esc(r.cat)}">${card(r)}</div>`).join('')}
    </div></div>`;
  $('#clearrecent').addEventListener('click', () => { localStorage.removeItem(ITEMS_KEY); renderRecent(); });
  $$('.rotitem').forEach((b) => b.addEventListener('click', (ev) => {
    if (ev.target.closest('a,button,input,textarea')) return;
    qInput.value = b.dataset.q;
    mfrSel.value = '';
    doSearch();
    qInput.focus();
  }));
}

// keep the sticky search bar pinned right below the header, whatever its height
function setHeaderVar() {
  document.documentElement.style.setProperty('--header-h', document.querySelector('header').offsetHeight + 'px');
}
window.addEventListener('resize', setHeaderVar);
window.addEventListener('load', setHeaderVar);
setHeaderVar();

// ---------- tabs ----------
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'search') $('#q').focus();
  if (b.dataset.tab === 'missed') renderMissed();
  if (b.dataset.tab === 'suggest') renderPending();
}));

// ---------- manufacturer suggestions ----------
function mfrSuggestions(q) {
  if (!q || q.length < 2 || mfrSel.value) return [];
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  const out = [];
  for (const m of META.mfrs || []) {
    const code = m.code.toLowerCase();
    const name = (m.name || '').toLowerCase();
    if (words.some((w) => code === w || code.startsWith(w) || name.split(/[\s&()/.,-]+/).some((nw) => nw.startsWith(w) && w.length >= 3))) {
      out.push(m);
      if (out.length >= 6) break;
    }
  }
  return out;
}
function renderMfrSuggest(q) {
  const sugg = mfrSuggestions(q);
  $('#mfrsuggest').innerHTML = sugg.length
    ? `<span class="sugglabel">Filter by manufacturer:</span>` + sugg.map((m) =>
      `<button class="suggchip" data-code="${esc(m.code)}">${esc(m.name === m.code ? m.code : m.name)} <span class="suggn">${m.count}</span></button>`).join('')
    : '';
  $$('.suggchip').forEach((b) => b.addEventListener('click', () => {
    mfrSel.value = b.dataset.code;
    doSearch();
    qInput.focus();
  }));
}

// ---------- search ----------
const qInput = $('#q');
const mfrSel = $('#mfrsel');

// typed text -> mfr code: accepts "LEV", "leviton", "LEV — Leviton", "brid"…
function resolveMfr(text) {
  text = String(text || '').trim();
  if (!text) return '';
  const t = text.toLowerCase();
  const list = META.mfrs || [];
  const exact = list.find((m) => m.code.toLowerCase() === t);
  if (exact) return exact.code;
  const dash = list.find((m) => `${m.code} — ${m.name}`.toLowerCase() === t);
  if (dash) return dash.code;
  const byName = list.filter((m) => m.name.toLowerCase() === t);
  if (byName.length === 1) return byName[0].code;
  if (t.length >= 2) {
    const pref = list.filter((m) => m.code.toLowerCase().startsWith(t) ||
      m.name.toLowerCase().split(/[\s&()/.,-]+/).some((w) => w.startsWith(t)));
    if (pref.length === 1) return pref[0].code;
  }
  return null; // unrecognized — don't filter yet
}

const doSearch = debounce(async () => {
  const q = qInput.value.trim();
  const mfrText = mfrSel.value;
  const mfr = resolveMfr(mfrText) || '';
  mfrSel.classList.toggle('unknown', !!mfrText.trim() && !mfr);
  renderMfrSuggest(q);
  if (!q && !mfr) { $('#jargonhits').innerHTML = ''; renderRecent(); return; }
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q) + '&mfr=' + encodeURIComponent(mfr));
    if (qInput.value.trim() !== q || mfrSel.value !== mfrText) return; // stale
    renderJargon(data.jargon);
    renderResults(data.results, q, mfr);
    if (data.results.length && q) saveRecent(q, mfr);
  } catch (e) {
    $('#results').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}, 160);
qInput.addEventListener('input', () => { openId = null; doSearch(); });
mfrSel.addEventListener('input', () => { openId = null; renderMfrDrop(mfrSel.value); doSearch(); });

// ---------- manufacturer dropdown ----------
// Custom, not a native <datalist>: the native one hides its options once the
// box holds a full match, so clicking a filled box showed nothing. This one
// always opens with the full list on click/focus and filters while you type.
const mfrDrop = $('#mfrdrop');
let mfrDropIdx = -1;
function mfrLabel(m) { return m.name === m.code ? m.code : `${m.code} — ${m.name}`; }
function closeMfrDrop() { mfrDrop.hidden = true; mfrDrop.innerHTML = ''; mfrDropIdx = -1; }
function renderMfrDrop(filter) {
  const f = String(filter || '').trim().toLowerCase();
  const list = (META.mfrs || []).filter((m) => !f ||
    m.code.toLowerCase().includes(f) || (m.name || '').toLowerCase().includes(f));
  mfrDropIdx = -1;
  if (!list.length) { closeMfrDrop(); return; }
  const cur = resolveMfr(mfrSel.value);
  mfrDrop.innerHTML = list.map((m) =>
    `<button class="mfropt${m.code === cur ? ' current' : ''}" data-label="${esc(mfrLabel(m))}">
      <span>${esc(mfrLabel(m))}</span><span class="mfrn">${m.count}</span></button>`).join('');
  mfrDrop.hidden = false;
  const c = $('.mfropt.current', mfrDrop);
  if (c) c.scrollIntoView({ block: 'nearest' });
  $$('.mfropt', mfrDrop).forEach((b) => {
    // mousedown, not click — it fires before the input's blur closes the list
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mfrSel.value = b.dataset.label;
      closeMfrDrop();
      openId = null;
      doSearch();
    });
  });
}
mfrSel.addEventListener('focus', () => renderMfrDrop(''));
mfrSel.addEventListener('click', () => { if (mfrDrop.hidden) renderMfrDrop(''); });
mfrSel.addEventListener('blur', closeMfrDrop);
mfrSel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMfrDrop(); return; }
  const opts = $$('.mfropt', mfrDrop);
  if (!opts.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mfrDropIdx = (mfrDropIdx + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle('active', i === mfrDropIdx));
    opts[mfrDropIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && mfrDropIdx >= 0) {
    e.preventDefault();
    mfrSel.value = opts[mfrDropIdx].dataset.label;
    closeMfrDrop();
    openId = null;
    doSearch();
  }
});

$('#clearsearch').addEventListener('click', () => {
  qInput.value = '';
  mfrSel.value = '';
  mfrSel.classList.remove('unknown');
  openId = null;
  $('#jargonhits').innerHTML = '';
  $('#mfrsuggest').innerHTML = '';
  renderRecent();
  qInput.focus();
});

function renderJargon(hits) {
  $('#jargonhits').innerHTML = (hits || []).map((h) =>
    `<div class="jhit">🔑 <b>${esc(h.term)}</b> → <span class="pat">${esc(h.mfr || '')} ${esc(h.match)}</span><br>${esc(h.hint || '')}</div>`
  ).join('');
}

const HIDDEN_ZONES = new Set(['CART', 'RECEIVING', 'ISSUE']); // not real shelf locations
function locChips(r) {
  const seen = new Set();
  const chips = [];
  for (const b of r.bins || []) {
    if (HIDDEN_ZONES.has(b.zone) || b.bin.startsWith('RECV')) continue;
    if (seen.has(b.bin)) continue;
    seen.add(b.bin);
    chips.push(`<span class="loc">${esc(b.bin)}</span>`);
  }
  return chips;
}

// equal visual weight for every logo: squarish marks get more height, wide wordmarks less
window.sizeMfrLogo = function (img) {
  const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
  const h = Math.max(24, Math.min(48, Math.round(Math.sqrt(4600 / Math.max(0.5, aspect)))));
  img.style.height = h + 'px';
};
function mfrLogoImg(code) {
  const f = (META.mfrLogos || {})[code];
  return f ? `<img class="mfrlogo" src="/logos/${esc(f)}?v=4" alt="" onload="sizeMfrLogo(this)" onerror="this.remove()">` : '';
}

function kwChips(r) {
  const user = (r.keywords || []).map((k) => `<span class="kw">${esc(k)}</span>`);
  const auto = (r.autoKeywords || []).slice(0, 8).map((k) => `<span class="kw auto">${esc(k)}</span>`);
  return user.concat(auto).join('');
}

function card(r) {
  const whys = (r.why || [])
    .filter((w) => w !== 'browsing manufacturer')
    .map((w) => `<span class="why${w.startsWith('cheat sheet') ? ' rule' : ''}">${esc(w)}</span>`);
  const locs = locChips(r);
  const row2 = [
    ...locs,
    ...(locs.length ? [] : ['<span class="nobins">no bin on file</span>']),
    kwChips(r),
    ...whys,
  ].join('');
  const photo = r.image || r.cedImage; // your pick wins; else the CED portal product photo
  return `<div class="card${photo ? ' haspic' : ''}" data-id="${esc(r.id)}">
    ${photo ? `<img class="itemphoto" src="${esc(photo)}" alt="" onerror="this.closest('.card').classList.remove('haspic');this.remove()">` : ''}
    <div class="top">
      <span class="cat">${esc(r.cat)}</span>
      <button class="copycat" data-cat="${esc(r.cat)}" title="copy catalog #">⧉</button>
      <span class="desc">${esc(r.desc)}${r.edited ? '<span class="editedflag">✎</span>' : ''}</span>
      <span class="mfr" title="${esc(r.mfrName || r.mfr)}">${mfrLogoImg(r.mfr)}${esc(r.mfr)}</span>
    </div>
    <div class="row2">${row2}</div>
    <div class="detailslot"></div>
  </div>`;
}

const RENDER_CHUNK = 80;
function renderResults(results, q, mfr) {
  const el = $('#results');
  if (!results.length) { el.innerHTML = '<p class="note">Nothing matched. Try the trade name (“sealtight”, “minis”, “jbox”) or a catalog # fragment.</p>'; return; }
  const head = `<div class="resultcount">${results.length} related part${results.length === 1 ? '' : 's'}${mfr ? ` · ${esc(mfr)}` : ''}</div>`;
  let shown = Math.min(RENDER_CHUNK, results.length);
  el.innerHTML = head + results.slice(0, shown).map(card).join('');
  $$('.card', el).forEach((c, i) => { c.style.animationDelay = Math.min(i * 28, 480) + 'ms'; });

  function bind(scope) {
    $$('.card', scope).forEach((c) => {
      if (c.dataset.bound) return;
      c.dataset.bound = '1';
      c.addEventListener('click', (ev) => {
        if (ev.target.closest('.detail') || ev.target.closest('a,button,input,textarea')) return;
        toggleDetail(c);
      });
      const cp = $('.copycat', c);
      if (cp) cp.addEventListener('click', async () => {
        await copyText(cp.dataset.cat);
        cp.textContent = '✓';
        cp.classList.add('copied');
        bumpItem(c.dataset.id, cp.dataset.cat, $('.top .desc', c)?.textContent?.replace('✎', '').trim(), $('.mfr', c)?.textContent?.trim());
        setTimeout(() => { cp.textContent = '⧉'; cp.classList.remove('copied'); }, 1200);
      });
    });
  }
  bind(el);

  function addMoreButton() {
    if (shown >= results.length) return;
    const btn = document.createElement('button');
    btn.className = 'btn showmore';
    btn.textContent = `Show ${Math.min(RENDER_CHUNK, results.length - shown)} more (${results.length - shown} left)`;
    btn.addEventListener('click', () => {
      const next = results.slice(shown, shown + RENDER_CHUNK);
      shown += next.length;
      btn.remove();
      el.insertAdjacentHTML('beforeend', next.map(card).join(''));
      bind(el);
      addMoreButton();
    });
    el.appendChild(btn);
  }
  addMoreButton();

  if (openId) { const c = $(`.card[data-id="${CSS.escape(openId)}"]`); if (c) toggleDetail(c, true); }
}

// warehouse zone map (optional data/map.json), item's zones highlighted
function zoneMapSVG(it) {
  const map = META.map;
  if (!map || !Array.isArray(map.zones) || !map.zones.length) return '';
  const mine = new Set((it.bins || []).map((b) => b.zone));
  const W = map.width || 100, H = map.height || 60;
  return `<svg class="zonemap" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">
    ${map.zones.map((z) => `
      <rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="2"
        fill="${mine.has(z.id) ? '#ED1C24' : '#EAF0F8'}" stroke="#14335F" stroke-width="0.8"/>
      <text x="${z.x + z.w / 2}" y="${z.y + z.h / 2 + 2.2}" text-anchor="middle" font-size="6"
        fill="${mine.has(z.id) ? '#fff' : '#14335F'}" font-weight="700">${esc(z.label || z.id)}</text>`).join('')}
  </svg>`;
}

// substitutes + accessories in the item detail (from data/xref.json)
function xrefRow(x) {
  return `<li><button class="altlink xr" data-q="${esc(x.cat)}"><b>${esc(x.mfr)} ${esc(x.cat)}</b></button>
    ${esc(x.desc)}${x.firstBin ? ` — <span class="loc">${esc(x.firstBin)}</span>` : ''}
    ${x.note ? `<span class="soft">(${esc(x.note)})</span>` : ''}</li>`;
}
function xrefSection(xref) {
  if (!xref || (!xref.equivalents.length && !xref.accessories.length)) return '';
  return `${xref.equivalents.length ? `<h4>Substitutes</h4><ul class="xreflist">${xref.equivalents.map(xrefRow).join('')}</ul>` : ''}
    ${xref.accessories.length ? `<h4>Goes with</h4><ul class="xreflist">${xref.accessories.map(xrefRow).join('')}</ul>` : ''}`;
}

// ---------- item detail (edit / web / images / learn) ----------
async function toggleDetail(cardEl, forceOpen = false) {
  const slot = $('.detailslot', cardEl);
  if (slot.innerHTML && !forceOpen) { slot.innerHTML = ''; openId = null; return; }
  // keep the clicked card where it is on screen — layout shifts above (other
  // cards closing) or below must not move the reading position
  const anchorTop = cardEl.getBoundingClientRect().top;
  const holdAnchor = () => window.scrollBy(0, cardEl.getBoundingClientRect().top - anchorTop);
  $$('.detailslot').forEach((s) => { if (s !== slot) s.innerHTML = ''; });
  holdAnchor();
  const id = cardEl.dataset.id;
  openId = id;
  slot.innerHTML = '<div class="detail"><span class="note">loading…</span></div>';
  holdAnchor();
  let data;
  try { data = await api('/api/item?id=' + encodeURIComponent(id)); }
  catch (e) { slot.innerHTML = `<div class="detail err">${esc(e.message)}</div>`; return; }
  const it = data.item;
  bumpItem(it.id, it.cat, it.desc, it.mfr);
  const know = data.knowledge || [];
  const autoKws = (it.autoKeywords || []).map((k) => `<span class="kw auto">${esc(k)}</span>`).join('');
  slot.innerHTML = `<div class="detail">
    <div class="row toplinks">
      <a class="btn tiny" target="_blank" rel="noopener" href="https://cedphx.portalced.com/product-list?term=${encodeURIComponent(it.cat)}">CED search: ${esc(it.cat)} ↗</a>
      <a class="btn tiny" target="_blank" rel="noopener" href="https://www.google.com/search?udm=2&q=${encodeURIComponent(data.webQuery)}">Google Images ↗</a>
      <a class="btn tiny" target="_blank" href="/labels.html?ids=${encodeURIComponent(it.id)}">🏷 Label</a>
    </div>
    ${zoneMapSVG(it)}
    <h4>Description</h4>
    <div class="descline">${esc(it.desc)}</div>
    <h4>Keywords <span class="soft">(searchable — teach it your jargon)</span></h4>
    <div class="kws ed-kws">${it.keywords.map((k) => `<span class="kw">${esc(k)}<button title="remove" data-kw="${esc(k)}">×</button></span>`).join('')}</div>
    <div class="row"><input type="text" class="ed-kw-new" placeholder="add keyword, press Enter (e.g. “sealtite”, “ac whip connector”)"></div>
    ${autoKws ? `<h4>Auto keywords <span class="soft">(from the cheat sheet — already searchable)</span></h4><div class="kws">${autoKws}</div>` : ''}
    <h4>Notes</h4>
    <textarea class="ed-notes" rows="2" placeholder="counter notes: substitutions, who buys it, gotchas…">${esc(it.notes)}</textarea>
    <div class="row">
      <button class="btn primary ed-save">Save</button>
      <span class="saved" style="display:none">saved ✓</span>
      <span class="conflictwarn" style="display:none">⚠ edited by someone else — their change was merged over</span>
    </div>
    ${xrefSection(data.xref)}
    <h4>Images — top 10</h4>
    <div class="imgslot"><span class="note">loading images…</span></div>
    <h4>Web — top 3</h4>
    <div class="webslot"><span class="note">searching the web…</span></div>
    ${know.length ? `<h4>What is this?</h4>${know.map((k) => `<details class="learn" open><summary>${esc(k.title)}</summary><div class="kbody">${esc(k.body)}</div></details>`).join('')}` : ''}
  </div>`;
  holdAnchor();

  const detail = $('.detail', slot);
  $$('.altlink', detail).forEach((b) => b.addEventListener('click', () => {
    qInput.value = b.dataset.q;
    doSearch();
    qInput.focus();
  }));
  let keywords = [...it.keywords];
  let savedImage = it.image || '';
  let knownUpdatedAt = data.updatedAt || null; // multi-user conflict detection

  // every edit auto-saves to the server (overrides.json) — nothing is lost
  async function persist(fields, refreshCards = false) {
    try {
      const body = await api('/api/item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, knownUpdatedAt, ...fields }),
      });
      knownUpdatedAt = body.updatedAt || null;
      const w = $('.conflictwarn', detail);
      if (w && body.conflict) { w.style.display = ''; setTimeout(() => (w.style.display = 'none'), 6000); }
      const s = $('.saved', detail);
      if (s) { s.style.display = ''; setTimeout(() => (s.style.display = 'none'), 1500); }
      if (refreshCards) doSearch();
    } catch (e) { alert('save failed: ' + e.message); }
  }
  const autosaveText = debounce(() => persist({
    notes: $('.ed-notes', detail).value,
    keywords,
  }), 900);

  function renderKws() {
    $('.ed-kws', detail).innerHTML = keywords.map((k) => `<span class="kw">${esc(k)}<button title="remove" data-kw="${esc(k)}">×</button></span>`).join('');
    bindKwRemove();
  }
  function bindKwRemove() {
    $$('.ed-kws button', detail).forEach((b) => b.addEventListener('click', () => {
      keywords = keywords.filter((k) => k !== b.dataset.kw);
      renderKws();
      persist({ keywords });
    }));
  }
  bindKwRemove();

  $('.ed-kw-new', detail).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim();
    if (v && !keywords.includes(v)) { keywords.push(v); renderKws(); persist({ keywords }); }
    e.target.value = '';
  });

  $('.ed-notes', detail).addEventListener('input', autosaveText);

  $('.ed-save', detail).addEventListener('click', () => {
    const kwNew = $('.ed-kw-new', detail).value.trim();
    if (kwNew && !keywords.includes(kwNew)) { keywords.push(kwNew); $('.ed-kw-new', detail).value = ''; renderKws(); }
    persist({ notes: $('.ed-notes', detail).value, keywords }, true);
  });

  // --- images (auto-load, cached server-side; click one to set it as the item photo) ---
  // Infinite scroll, not a fixed top-N: cells append as the sentinel scrolls into
  // view, and each <img> uses loading="lazy" so bytes only fetch once a cell is
  // actually near the visible area of the horizontally-scrolling strip.
  const imgslot = $('.imgslot', detail);
  function renderImages(entry) {
    // CED portal product photos always lead (server-verified); web images fill the rest
    const ced = (data.item.cedImages || []).map((src) => ({
      thumbnail: src, image: src, title: `${it.cat} — CED portal photo`,
      url: `https://cedphx.portalced.com/product-list?term=${encodeURIComponent(it.cat)}`, ced: true,
    }));
    const candidates = [...ced, ...(entry.images || [])];
    if (!candidates.length) { imgslot.innerHTML = '<span class="note">no images found</span>'; return; }
    const cellHtml = (im) => {
      const src = im.thumbnail || im.image;
      return `
      <div class="imgcell${savedImage === src ? ' picked' : ''}${im.ced ? ' cedimg' : ''}" data-src="${esc(src)}" title="${esc(im.title)}\nClick to set as this item's photo">
        <img src="${esc(src)}" alt="${esc(im.title)}" loading="lazy">
        ${im.ced ? '<span class="cedtag">CED</span>' : ''}
        <a class="imgopen" href="${esc(im.url || im.image)}" target="_blank" rel="noopener" title="open source page">↗</a>
        <span class="imgpicked">✓ item photo</span>
      </div>`;
    };
    imgslot.innerHTML = `<div class="note" style="margin:0 0 4px">Click an image to make it this item's photo (shows on the search result card — saved automatically). Scroll for more. Click again to remove.</div>
       <div class="imgs"><div class="imgsentinel"></div></div>
       <div class="row"><button class="btn tiny img-refresh">↻ refresh images</button></div>`;
    const imgsEl = $('.imgs', imgslot);
    const sentinel = $('.imgsentinel', imgslot);
    const rb = $('.img-refresh', imgslot);
    if (rb) rb.addEventListener('click', () => fetchImages(true));

    function bindCell(cell) {
      cell.addEventListener('click', (ev) => {
        if (ev.target.closest('.imgopen')) return; // ↗ opens the source page instead
        const src = cell.dataset.src;
        savedImage = savedImage === src ? '' : src; // toggle
        persist({ image: savedImage }, true); // auto-save + refresh cards so the photo appears
        $$('.imgcell', imgslot).forEach((c) => c.classList.toggle('picked', c.dataset.src === savedImage));
      });
      const img = cell.querySelector('img');
      img.addEventListener('error', () => cell.remove()); // dead image: scrolling further just loads more
    }

    const BATCH = 10;
    let shown = 0;
    function appendBatch() {
      const next = candidates.slice(shown, shown + BATCH);
      if (!next.length) { io.disconnect(); sentinel.remove(); return; }
      shown += next.length;
      const wrap = document.createElement('div');
      wrap.innerHTML = next.map(cellHtml).join('');
      [...wrap.children].forEach((cell) => { imgsEl.insertBefore(cell, sentinel); bindCell(cell); });
      if (shown >= candidates.length) { io.disconnect(); sentinel.remove(); }
    }
    // rootMargin gives it a head start so the next batch is ready before you
    // actually reach the end of the strip
    const io = new IntersectionObserver((ioEntries) => {
      if (ioEntries.some((e) => e.isIntersecting)) appendBatch();
    }, { root: imgsEl, rootMargin: '0px 300px 0px 0px' });
    io.observe(sentinel);
    appendBatch(); // first batch immediately, no need to wait for the observer
  }
  async function fetchImages(force) {
    imgslot.innerHTML = '<span class="note">loading images…</span>';
    try { renderImages(await api(`/api/images?id=${encodeURIComponent(id)}${force ? '&force=1' : ''}`)); }
    catch (e) { imgslot.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  }
  if (data.images) renderImages(data.images); else fetchImages(false);

  // --- web top 5 (auto-load; results get indexed into search) ---
  const webslot = $('.webslot', detail);
  function renderWeb(entry) {
    const list = (entry.results || []).slice(0, 3).map((w) => `<li>
      <a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.title)}</a><span class="dom">${esc(w.domain)}</span>
      ${w.snippet ? `<div class="snip">${esc(w.snippet)}</div>` : ''}
    </li>`).join('');
    webslot.innerHTML = `<ul class="weblist">${list || '<li class="note">no results</li>'}</ul>
      <div class="row">
        <span class="note">“${esc(entry.query)}” · ${esc((entry.fetchedAt || '').slice(0, 10))}</span>
        <button class="btn tiny web-refresh">↻ refresh</button>
      </div>`;
    $('.web-refresh', webslot).addEventListener('click', () => fetchWeb(true));
  }
  async function fetchWeb(force) {
    webslot.innerHTML = '<span class="note">searching the web…</span>';
    try { renderWeb(await api(`/api/web?id=${encodeURIComponent(id)}${force ? '&force=1' : ''}`)); }
    catch (e) { webslot.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  }
  if (data.web) renderWeb(data.web); else fetchWeb(false);
}

// ---------- static tabs ----------
function renderCheat(filter = '') {
  const f = filter.trim().toLowerCase();
  const rows = META.jargon.filter((r) => !f ||
    r.term.toLowerCase().includes(f) || (r.aliases || []).some((a) => a.includes(f)) ||
    (r.hint || '').toLowerCase().includes(f) || (r.mfr || '').toLowerCase().includes(f));
  $('#cheatlist').innerHTML = rows.map((r) => `<div class="cheatrow">
    <span class="term">${esc(r.term)}</span><span class="code">${esc(r.mfr || '')} ${esc(r.match)}</span>
    ${r.aliases && r.aliases.length ? `<div class="aliases">aka: ${esc(r.aliases.join(', '))}</div>` : ''}
    <div class="hint">${esc(r.hint || '')}</div>
  </div>`).join('') || '<p class="note">no matches</p>';
}
$('#cheatfilter').addEventListener('input', (e) => renderCheat(e.target.value));

function renderLearn() {
  $('#learnlist').innerHTML = META.knowledge.map((k) =>
    `<details class="learn"><summary>${esc(k.title)}</summary><div class="kbody">${esc(k.body)}</div></details>`).join('');
}
function renderRules() {
  $('#ruleslist').innerHTML = META.counterRules.map((r) => `<li>${esc(r)}</li>`).join('');
}

// ---------- missed searches tab ----------
async function renderMissed() {
  let data;
  try { data = await api('/api/missed'); } catch { return; }
  const badge = $('#missedbadge');
  if (badge) {
    badge.textContent = data.missed.length;
    badge.hidden = !data.missed.length;
  }
  const el = $('#missedlist');
  if (!el) return;
  el.innerHTML = data.missed.length ? `<table class="missed">
    <thead><tr><th>search</th><th>times</th><th>last</th><th></th></tr></thead><tbody>
    ${data.missed.map((m) => `<tr>
      <td class="mq">${esc(m.q)}</td><td>${m.count}</td><td>${esc((m.last || '').slice(0, 10))}</td>
      <td><button class="btn tiny m-again" data-q="${esc(m.q)}">search again</button>
          <button class="btn tiny m-dismiss" data-q="${esc(m.q)}">dismiss ✓</button></td>
    </tr>`).join('')}
    </tbody></table>` : '<p class="note">Nothing missed — every recent search found something.</p>';
  $$('.m-again', el).forEach((b) => b.addEventListener('click', () => {
    qInput.value = b.dataset.q;
    $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'search'));
    $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-search'));
    doSearch();
    qInput.focus();
  }));
  $$('.m-dismiss', el).forEach((b) => b.addEventListener('click', async () => {
    await api('/api/missed/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: b.dataset.q }) });
    renderMissed();
  }));
}
$('#clearmissed').addEventListener('click', async () => {
  await api('/api/missed/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  renderMissed();
});

// ---------- AI: suggestions tab + chat drawer ----------
async function renderPending() {
  let data;
  try { data = await api('/api/pending'); } catch { return; }
  const list = data.suggestions;
  const badge = $('#pendingbadge');
  if (badge) { badge.textContent = list.length; badge.hidden = !list.length; }
  const el = $('#pendinglist');
  if (!el) return;
  el.innerHTML = list.length ? list.map((s) => `
    <div class="pendcard" data-id="${esc(s.id)}">
      <div class="pendhead"><span class="pendkind">${esc(s.kind)}</span>
        <span class="soft">from ${esc(s.source)} · ${esc((s.createdAt || '').slice(0, 10))}</span></div>
      <div class="pendwhy">${esc(s.rationale)}</div>
      <pre class="pendpayload">${esc(JSON.stringify(s.payload, null, 1))}</pre>
      <div class="row">
        <button class="btn primary p-approve">✓ Approve</button>
        <button class="btn p-reject">✕ Reject</button>
        <span class="err p-err"></span>
      </div>
    </div>`).join('') : '<p class="note">Nothing pending.</p>';
  $$('.pendcard').forEach((c) => {
    const decide = async (approve) => {
      try {
        await api('/api/pending/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.dataset.id, approve }) });
        renderPending();
      } catch (e) { $('.p-err', c).textContent = e.message; }
    };
    $('.p-approve', c).addEventListener('click', () => decide(true));
    $('.p-reject', c).addEventListener('click', () => decide(false));
  });
}

function wireAI(meta) {
  const on = meta.ai && meta.ai.enabled;
  const st = $('#suggesttab');
  // suggestions tab shows whenever there's a queue to review, even with AI off
  if (st) st.hidden = !on && !meta.pendingCount;
  $('#chatdock').hidden = !on;
  const aib = $('#aisuggest');
  if (aib) aib.hidden = !on;
}

$('#aisuggest').addEventListener('click', async () => {
  const out = $('#aisuggestout');
  out.textContent = 'asking Claude…';
  try {
    const r = await api('/api/ai/suggest-jargon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    out.textContent = `${r.queued} suggestion${r.queued === 1 ? '' : 's'} queued — see the Suggestions tab`;
    refreshMeta().then(() => renderPending()).catch(() => {});
  } catch (e) { out.textContent = e.message; }
});

// ---------- Bolt the mascot ----------
// One source of truth: if public/bolt.png exists (drop in the original art),
// it is used verbatim everywhere; otherwise the hand-drawn SVG below renders.
// The SVG is fully inlined (not <use>) so its arms/body are real, animatable
// DOM nodes — classes, not ids, since several instances can exist at once.
const BOLT_SVG = `<svg viewBox="0 0 120 130" aria-hidden="true">
  <g class="bt-leg-l"><path d="M56 92 L48 106" stroke="#000" stroke-width="3.8" stroke-linecap="round" fill="none"/>
    <ellipse cx="44" cy="111.5" rx="12" ry="6.5" fill="#fff" stroke="#000" stroke-width="3"/>
    <path d="M33.5 114 Q44 118 55.5 113.5" stroke="#000" stroke-width="1.8" fill="none"/></g>
  <g class="bt-leg-r"><path d="M66 88 L75 101" stroke="#000" stroke-width="3.8" stroke-linecap="round" fill="none"/>
    <ellipse cx="79" cy="106.5" rx="12" ry="6.5" fill="#fff" stroke="#000" stroke-width="3"/>
    <path d="M68.5 109 Q79 113 90.5 108.5" stroke="#000" stroke-width="1.8" fill="none"/></g>
  <g class="bt-arm-l">
    <path d="M47 48 L20 39" stroke="#000" stroke-width="3.8" stroke-linecap="round" fill="none"/>
    <circle cx="17.5" cy="37.5" r="5.5" fill="#fff" stroke="#000" stroke-width="2.6"/>
    <path d="M15.5 35 L10 28.5" stroke="#000" stroke-width="7" stroke-linecap="round"/>
    <path d="M15.5 35 L10.5 29" stroke="#fff" stroke-width="3.8" stroke-linecap="round"/>
  </g>
  <g class="bt-arm-r">
    <path d="M81 53 L94 58" stroke="#000" stroke-width="3.8" stroke-linecap="round" fill="none"/>
    <path d="M103 54 L108 48.5" stroke="#000" stroke-width="5.6" stroke-linecap="round"/>
    <path d="M103 54 L107.5 49" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M105.5 57.5 L112 54" stroke="#000" stroke-width="5.6" stroke-linecap="round"/>
    <path d="M105.5 57.5 L111.5 54.3" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M106 61.5 L112.5 60" stroke="#000" stroke-width="5.6" stroke-linecap="round"/>
    <path d="M106 61.5 L112 60.2" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M97 53.5 L96 47.5" stroke="#000" stroke-width="5.6" stroke-linecap="round"/>
    <path d="M97 53.5 L96.2 48" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>
    <ellipse cx="100" cy="60" rx="7" ry="6.3" fill="#fff" stroke="#000" stroke-width="2.6" transform="rotate(-20 100 60)"/>
  </g>
  <polygon class="bt-poly" points="88,6 47,38 45,66 57,66 43,95 81,47 68,47"
    fill="#FFC72C" stroke="#000" stroke-width="3.8" stroke-linejoin="round"/>
  <ellipse cx="57.5" cy="40" rx="3.4" ry="5" fill="#fff" stroke="#000" stroke-width="2.2"/>
  <ellipse cx="66" cy="37.5" rx="3.4" ry="5" fill="#fff" stroke="#000" stroke-width="2.2"/>
  <ellipse cx="58.2" cy="41.5" rx="1.6" ry="2.6" fill="#000"/>
  <ellipse cx="66.6" cy="39" rx="1.6" ry="2.6" fill="#000"/>
  <path d="M52.5 31 Q56.5 28.5 60.5 30.5" stroke="#000" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  <path d="M62.5 28.5 Q66.5 26 70.5 28" stroke="#000" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  <path d="M50.5 45.5 q-2 1.8 -1.2 4" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <path d="M70.5 43 q2 1.8 1.2 4" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <path d="M47.5 49.5 Q58 54.5 70.5 46.5 Q71 57 60.5 61.5 Q50 62 47.5 49.5 Z" fill="#fff" stroke="#000" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M50 54.5 Q59 58.5 68.5 51" stroke="#000" stroke-width="1.4" fill="none"/>
  <path d="M54 59 Q59.5 62.5 65 56.5 Q62.5 61.5 57.5 61.3 Z" fill="#C8102E"/>
  <path d="M46.5 48 q-1.6 .4 -2.2 2" stroke="#000" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  <path d="M71.5 45.5 q1.6 0 2.2 1.6" stroke="#000" stroke-width="1.6" fill="none" stroke-linecap="round"/>
</svg>`;
function boltMarkup() {
  // ?v= busts the day-long image cache whenever the artwork file changes
  return `<img class="bolt-img" src="/bolt.png?v=2" alt="Bolt"
    onerror="this.parentElement.classList.add('svgfallback'); this.remove()">${BOLT_SVG}`;
}
// static icons: the Ask Bolt pill + panel header
$$('.bolt-slot').forEach((s) => { s.innerHTML = boltMarkup(); });

function boltThinkingHTML() {
  return `<span class="bolt-slot think">${boltMarkup()}</span>
  <span class="think-label">Bolt is thinking<span class="think-dots"><span></span><span></span><span></span></span></span>`;
}

// chat drawer
(() => {
  const transcript = []; // [{role, content}]
  const log = $('#chatlog');
  const pill = $('#chatpill');
  const panel = $('#chatpanel');
  const dock = $('#chatdock');
  const syncPill = () => dock.classList.toggle('open', !panel.hidden); // button shrinks while the panel is open
  const close = () => { panel.hidden = true; syncPill(); };
  pill.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    syncPill();
    if (!panel.hidden) $('#chatinput').focus();
  });
  $('#chatclose').addEventListener('click', close);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  function push(role, content, cls = '') {
    const div = document.createElement('div');
    div.className = 'chatmsg ' + role + (cls ? ' ' + cls : '');
    div.textContent = content;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }
  $('#chatform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#chatinput');
    const q = inp.value.trim();
    if (!q) return;
    inp.value = '';
    transcript.push({ role: 'user', content: q });
    push('user', q);
    const wait = push('assistant', '', 'wait');
    wait.classList.add('bolt-think');
    wait.innerHTML = boltThinkingHTML();
    log.scrollTop = log.scrollHeight;
    try {
      const r = await api('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: transcript }) });
      transcript.push({ role: 'assistant', content: r.text });
      wait.classList.remove('wait', 'bolt-think');
      wait.textContent = r.text;
      if (r.toolsUsed && r.toolsUsed.length) {
        const t = document.createElement('div');
        t.className = 'chattools';
        t.textContent = 'checked: ' + r.toolsUsed.join(', ');
        wait.appendChild(t);
      }
      if (r.toolsUsed && (r.toolsUsed.includes('suggest') || r.toolsUsed.includes('add_tags'))) {
        refreshMeta().then(() => renderPending()).catch(() => {});
      }
    } catch (err) {
      wait.classList.remove('wait', 'bolt-think');
      wait.classList.add('err');
      wait.textContent = err.message === 'ai-disabled' ? 'AI is not configured on the server.' : err.message;
      transcript.pop(); // let the user retry the same question
    }
    log.scrollTop = log.scrollHeight;
  });
})();

// ---------- header meta + status banners ----------
function renderMeta(meta) {
  const bits = [`${meta.items.toLocaleString()} items`, `${meta.edited} edited`];
  if (meta.clients > 1) bits.push(`${meta.clients} counters online`);
  let freshness = '';
  if (meta.catalogAgeDays != null) {
    const d = Math.floor(meta.catalogAgeDays);
    const cls = d > 14 ? 'verystale' : d > 7 ? 'stale' : '';
    freshness = ` · <span class="fresh ${cls}" title="run: python3 ingest.py, then the data reloads automatically">inventory ${d === 0 ? 'today' : d + 'd old'}</span>`;
  }
  $('#meta').innerHTML = bits.map(esc).join(' · ') + freshness;
}

function renderBanners(meta) {
  const banners = [];
  if (meta.reloadError) {
    banners.push(`<div class="banner err">Data file error — still serving the previous data: ${esc(meta.reloadError)}</div>`);
  }
  if ((meta.orphanOverrides || []).length) {
    const o = meta.orphanOverrides;
    banners.push(`<div class="banner warn"><details><summary>${o.length} saved edit${o.length === 1 ? '' : 's'} no longer match any catalog item (kept, not deleted)</summary>
      <ul>${o.map((x) => `<li><b>${esc(x.id)}</b>${x.desc ? ` — ${esc(x.desc)}` : ''}${x.notes ? ` <i>${esc(x.notes)}</i>` : ''}</li>`).join('')}</ul>
    </details></div>`);
  }
  if (meta.webHealth && meta.webHealth.consecFails >= 3) {
    banners.push(`<div class="banner warn dismissible">Web lookups are failing (likely DuckDuckGo rate limiting) — cached results still work. <button class="btn tiny b-dismiss">dismiss</button></div>`);
  }
  $('#banners').innerHTML = banners.join('');
  $$('.b-dismiss').forEach((b) => b.addEventListener('click', () => b.closest('.banner').remove()));
}

// ---------- barcode scanning ----------
// USB scanners are keyboards: catch bursts that land nowhere and route them
// into the search box; a burst ending in Enter searches instantly.
(() => {
  let burst = '';
  let lastKey = 0;
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    const now = Date.now();
    if (now - lastKey > 80) burst = ''; // human-speed gap resets the burst
    lastKey = now;
    if (e.key === 'Enter') {
      if (!inField && burst.length >= 8 && /^\d+$/.test(burst)) {
        // scanner burst landed nowhere — run the UPC search now
        qInput.value = burst;
        qInput.focus();
        doSearch();
      }
      burst = '';
      return;
    }
    if (e.key.length !== 1) return;
    burst += e.key;
    if (!inField) {
      // any stray typing belongs in the search box
      $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'search'));
      $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-search'));
      qInput.focus();
      qInput.value += e.key;
      e.preventDefault();
      doSearch();
    }
  });
})();

// ---------- Calc tab: trade calculators over lib/calc.js ----------
const WIRE_SIZES = ['14', '12', '10', '8', '6', '4', '3', '2', '1', '1/0', '2/0', '3/0', '4/0', '250', '300', '350', '400', '500'];
function opts(list, selected) {
  return list.map((v) => `<option${String(v) === String(selected) ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function renderCalcTab() {
  if (typeof calc === 'undefined') { $('#calcpanes').innerHTML = '<p class="err">calc.js failed to load</p>'; return; }
  $('#calcpanes').innerHTML = `
  <div class="calcgrid">
    <div class="calcbox" id="c-fill">
      <h4>Conduit fill <span class="soft">(NEC ch.9)</span></h4>
      <div class="row">
        <label>Qty <input type="number" name="count" value="3" min="1"></label>
        <label>Wire <select name="wire">${opts(WIRE_SIZES, '12')}</select></label>
        <label>Insul <select name="insul">${opts(Object.keys(calc.CONDUCTOR_AREA), 'THHN')}</select></label>
      </div>
      <div class="row">
        <label>in <select name="ctype">${opts(Object.keys(calc.CONDUIT_AREA), 'EMT')}</select></label>
        <label>size <select name="csize">${opts(Object.keys(calc.CONDUIT_AREA.EMT), '3/4')}</select></label>
      </div>
      <div class="calcout"></div>
    </div>
    <div class="calcbox" id="c-box">
      <h4>Box fill <span class="soft">(NEC 314.16)</span></h4>
      <div class="row">
        <label>#14 <input type="number" name="n14" value="0" min="0"></label>
        <label>#12 <input type="number" name="n12" value="0" min="0"></label>
        <label>#10 <input type="number" name="n10" value="0" min="0"></label>
      </div>
      <div class="row">
        <label>devices <input type="number" name="dev" value="1" min="0"></label>
        <label><input type="checkbox" name="clamps" checked> clamps</label>
        <label><input type="checkbox" name="gnd" checked> grounds</label>
      </div>
      <div class="calcout"></div>
    </div>
    <div class="calcbox" id="c-amp">
      <h4>Ampacity <span class="soft">(NEC 310.16)</span></h4>
      <div class="row">
        <label>Wire <select name="wire">${opts(WIRE_SIZES, '12')}</select></label>
        <label>Metal <select name="mat"><option>CU</option><option>AL</option></select></label>
        <label>Rating <select name="temp"><option>60</option><option selected>75</option><option>90</option></select>°C</label>
      </div>
      <div class="row">
        <label>Ambient <input type="number" name="amb" value="30" min="10" max="55">°C</label>
        <label>CCC <input type="number" name="ccc" value="3" min="1" max="40"></label>
      </div>
      <div class="calcout"></div>
    </div>
    <div class="calcbox" id="c-vd">
      <h4>Voltage drop</h4>
      <div class="row">
        <label>V <input type="number" name="volts" value="120"></label>
        <label>A <input type="number" name="amps" value="20"></label>
        <label>ft <input type="number" name="feet" value="100"></label>
      </div>
      <div class="row">
        <label>Wire <select name="wire">${opts(WIRE_SIZES, '12')}</select></label>
        <label>Metal <select name="mat"><option>CU</option><option>AL</option></select></label>
        <label>Phase <select name="phase"><option value="1">1φ</option><option value="3">3φ</option></select></label>
      </div>
      <div class="calcout"></div>
    </div>
    <div class="calcbox" id="c-wt">
      <h4>Wire weight ⇄ feet <span class="soft">(THHN Cu, ±5%)</span></h4>
      <div class="row">
        <label>Wire <select name="wire">${opts(Object.keys(calc.LB_PER_KFT), '12')}</select></label>
        <label>ft <input type="number" name="feet" value="500"></label>
        <label>or lb <input type="number" name="lbs" value="" placeholder="—"></label>
      </div>
      <div class="calcout"></div>
    </div>
  </div>`;

  const val = (box, name) => {
    const el = box.querySelector(`[name=${name}]`);
    return el.type === 'checkbox' ? el.checked : el.value;
  };
  const wire = (box) => {
    const b = $('#' + box);
    return { b, out: $('.calcout', b) };
  };

  const fill = wire('c-fill');
  function calcFill() {
    try {
      const count = Number(val(fill.b, 'count')) || 0;
      const args = { conduitType: val(fill.b, 'ctype'), size: val(fill.b, 'csize') };
      const r = calc.conduitFill({ ...args, conductors: [{ insul: val(fill.b, 'insul'), size: val(fill.b, 'wire'), count }] });
      const max = calc.conduitMaxCount({ ...args, insul: val(fill.b, 'insul'), wireSize: val(fill.b, 'wire') });
      fill.out.innerHTML = `<b class="${r.ok ? 'good' : 'bad'}">${r.ok ? 'OK' : 'TOO FULL'}</b> — ${(r.pct * 100).toFixed(1)}% of ${(r.limitPct * 100)}% allowed · max <b>${max}</b> fit`;
    } catch (e) { fill.out.textContent = e.message; }
  }

  const box = wire('c-box');
  function calcBox() {
    try {
      const devN = Number(val(box.b, 'dev')) || 0;
      const conductors = { '14': Number(val(box.b, 'n14')) || 0, '12': Number(val(box.b, 'n12')) || 0, '10': Number(val(box.b, 'n10')) || 0 };
      const r = calc.boxFill({
        conductors, devices: Array.from({ length: devN }, () => ({})),
        clamps: val(box.b, 'clamps'), groundsPresent: val(box.b, 'gnd'),
      });
      if (!r.volume) { box.out.textContent = 'enter conductor counts'; return; }
      const fits = Object.entries(calc.COMMON_BOXES).filter(([, v]) => v >= r.volume).slice(0, 3)
        .map(([n, v]) => `${n} (${v})`).join(', ');
      box.out.innerHTML = `needs <b>${r.volume.toFixed(2)} cu in</b>${fits ? ` — fits: ${esc(fits)}` : ' — bigger than common boxes'}`;
    } catch (e) { box.out.textContent = e.message; }
  }

  const amp = wire('c-amp');
  function calcAmp() {
    try {
      const r = calc.ampacity({
        size: val(amp.b, 'wire'), material: val(amp.b, 'mat'),
        tempRating: Number(val(amp.b, 'temp')), ambientC: Number(val(amp.b, 'amb')), ccc: Number(val(amp.b, 'ccc')),
      });
      amp.out.innerHTML = `base <b>${r.base}A</b> × ${r.ambientFactor} × ${r.cccFactor} = <b>${r.adjusted.toFixed(1)}A</b>` +
        (r.breakerCap ? ` <span class="soft">(breaker max ${r.breakerCap}A — 240.4(D))</span>` : '');
    } catch (e) { amp.out.textContent = e.message; }
  }

  const vd = wire('c-vd');
  function calcVd() {
    try {
      const args = {
        volts: Number(val(vd.b, 'volts')), amps: Number(val(vd.b, 'amps')), feet: Number(val(vd.b, 'feet')),
        size: val(vd.b, 'wire'), material: val(vd.b, 'mat'), phase: Number(val(vd.b, 'phase')),
      };
      const r = calc.voltageDrop(args);
      let up = '';
      if (!r.ok) {
        const better = WIRE_SIZES.slice(WIRE_SIZES.indexOf(args.size) + 1)
          .find((s) => { try { return calc.voltageDrop({ ...args, size: s }).ok; } catch { return false; } });
        if (better) up = ` — <b>#${esc(better)}</b> stays under 3%`;
      }
      vd.out.innerHTML = `<b class="${r.ok ? 'good' : 'bad'}">${r.drop.toFixed(2)}V (${(r.pct * 100).toFixed(1)}%)</b> · ${r.endVolts.toFixed(1)}V at the load${up}`;
    } catch (e) { vd.out.textContent = e.message; }
  }

  const wt = wire('c-wt');
  function calcWt() {
    try {
      const lbs = Number(val(wt.b, 'lbs'));
      if (lbs > 0) {
        const r = calc.wireFeetFromWeight({ size: val(wt.b, 'wire'), pounds: lbs });
        wt.out.innerHTML = `${lbs} lb ≈ <b>${Math.round(r.feet)} ft</b> <span class="soft">(${r.lbPerKft} lb/kft)</span>`;
      } else {
        const r = calc.wireWeight({ size: val(wt.b, 'wire'), feet: Number(val(wt.b, 'feet')) || 0 });
        wt.out.innerHTML = `≈ <b>${r.pounds.toFixed(1)} lb</b> <span class="soft">(${r.lbPerKft} lb/kft)</span>`;
      }
    } catch (e) { wt.out.textContent = e.message; }
  }

  const wiring = [[fill.b, calcFill], [box.b, calcBox], [amp.b, calcAmp], [vd.b, calcVd], [wt.b, calcWt]];
  for (const [el, fn] of wiring) {
    el.addEventListener('input', fn);
    fn();
  }
  renderNema();
}

// ---------- NEMA chart: simplified faces ----------
// slot primitives, drawn in a 64×64 face
const NEMA = [
  { id: '5-15', v: '125V', a: '15A', w: '2P 3W', slots: [['v', 22, 20, 11], ['v', 42, 20, 9], ['u', 32, 44]] },
  { id: '5-20', v: '125V', a: '20A', w: '2P 3W', slots: [['t', 22, 24], ['v', 42, 20, 9], ['u', 32, 44]] },
  { id: '6-15', v: '250V', a: '15A', w: '2P 3W', slots: [['h', 16, 24], ['h', 38, 24], ['u', 32, 44]] },
  { id: '6-20', v: '250V', a: '20A', w: '2P 3W', slots: [['h', 16, 24], ['v', 42, 20, 9], ['u', 32, 44]] },
  { id: '6-30', v: '250V', a: '30A', w: '2P 3W', slots: [['h', 16, 22], ['h', 38, 22], ['u', 32, 44]] },
  { id: '6-50', v: '250V', a: '50A', w: '2P 3W', slots: [['h', 16, 22], ['h', 38, 22], ['u', 32, 44]] },
  { id: '10-30', v: '125/250V', a: '30A', w: '3P 3W', slots: [['s', 18, 22, 1], ['s', 46, 22, -1], ['l', 32, 44]] },
  { id: '10-50', v: '125/250V', a: '50A', w: '3P 3W', slots: [['s', 18, 22, 1], ['s', 46, 22, -1], ['l', 32, 44]] },
  { id: '14-30', v: '125/250V', a: '30A', w: '3P 4W', slots: [['v', 18, 24, 10], ['v', 46, 24, 10], ['l', 32, 46], ['u', 32, 14]] },
  { id: '14-50', v: '125/250V', a: '50A', w: '3P 4W', slots: [['v', 18, 24, 10], ['v', 46, 24, 10], ['h', 26, 48], ['u', 32, 12]] },
  { id: '14-60', v: '125/250V', a: '60A', w: '3P 4W', slots: [['v', 18, 24, 10], ['v', 46, 24, 10], ['h', 26, 48], ['u', 32, 12]] },
  { id: 'L5-20', v: '125V', a: '20A', w: '2P 3W', lock: 3 },
  { id: 'L5-30', v: '125V', a: '30A', w: '2P 3W', lock: 3 },
  { id: 'L6-20', v: '250V', a: '20A', w: '2P 3W', lock: 3 },
  { id: 'L6-30', v: '250V', a: '30A', w: '2P 3W', lock: 3 },
  { id: 'L14-20', v: '125/250V', a: '20A', w: '3P 4W', lock: 4 },
  { id: 'L14-30', v: '125/250V', a: '30A', w: '3P 4W', lock: 4 },
];
function nemaFace(cfg) {
  const parts = ['<circle cx="32" cy="32" r="28" fill="#fff" stroke="#14335F" stroke-width="2.5"/>'];
  if (cfg.lock) {
    for (let i = 0; i < cfg.lock; i++) {
      const a0 = (i * 360) / cfg.lock - 90;
      parts.push(`<path d="M 32 32 m ${16 * Math.cos(a0 * Math.PI / 180)} ${16 * Math.sin(a0 * Math.PI / 180)}
        a 16 16 0 0 1 ${16 * (Math.cos((a0 + 42) * Math.PI / 180) - Math.cos(a0 * Math.PI / 180))} ${16 * (Math.sin((a0 + 42) * Math.PI / 180) - Math.sin(a0 * Math.PI / 180))}"
        stroke="#14335F" stroke-width="5" fill="none" stroke-linecap="round"/>`);
    }
    parts.push('<circle cx="32" cy="32" r="3" fill="#14335F"/>');
  } else {
    for (const [kind, x, y, len] of cfg.slots) {
      if (kind === 'v') parts.push(`<rect x="${x - 1.5}" y="${y}" width="3.6" height="${len || 12}" rx="1.5" fill="#14335F"/>`);
      else if (kind === 'h') parts.push(`<rect x="${x}" y="${y - 1.5}" width="12" height="3.6" rx="1.5" fill="#14335F"/>`);
      else if (kind === 't') parts.push(`<rect x="${x - 1.5}" y="${y - 6}" width="3.6" height="12" rx="1.5" fill="#14335F"/><rect x="${x - 6}" y="${y - 1.5}" width="9" height="3.6" rx="1.5" fill="#14335F"/>`);
      else if (kind === 'u') parts.push(`<path d="M ${x - 4} ${y} v 5 a 4 4 0 0 0 8 0 v -5 z" fill="#14335F"/>`);
      else if (kind === 'l') parts.push(`<rect x="${x - 6}" y="${y - 1.5}" width="9" height="3.6" fill="#14335F"/><rect x="${x + 1}" y="${y - 6}" width="3.6" height="8" fill="#14335F"/>`);
      else if (kind === 's') parts.push(`<g transform="rotate(${18 * (len || 1)} ${x} ${y + 6})"><rect x="${x - 1.8}" y="${y}" width="3.6" height="12" rx="1.5" fill="#14335F"/></g>`);
    }
  }
  return `<svg viewBox="0 0 64 64" width="64" height="64">${parts.join('')}</svg>`;
}
function renderNema() {
  $('#nemachart').innerHTML = `<div class="nemagrid">${NEMA.map((c) => `
    <div class="nemacell">
      ${nemaFace(c)}
      <div class="nname">${esc(c.id)}${c.lock ? ' <span class="soft">(twist-lock)</span>' : ''}</div>
      <div class="ninfo">${esc(c.v)} · ${esc(c.a)} · ${esc(c.w)}</div>
    </div>`).join('')}</div>
    <p class="note">Faces are simplified mnemonics — R = receptacle, P = plug. 5=125V, 6=250V, 10=3-wire dryer/range (no ground, legacy), 14=4-wire dryer/range, L=twist-lock.</p>`;
}

// ---------- boot ----------
async function refreshMeta() {
  META = await api('/api/meta');
  renderMeta(META);
  renderBanners(META);
  wireAI(META);
  const badge = $('#missedbadge');
  if (badge) { badge.textContent = META.missedCount || 0; badge.hidden = !META.missedCount; }
  const pb = $('#pendingbadge');
  if (pb) { pb.textContent = META.pendingCount || 0; pb.hidden = !META.pendingCount; }
}

(async function boot() {
  try {
    await refreshMeta();
    renderCheat();
    renderLearn();
    renderRules();
    renderCalcTab();
    renderRecent();
    renderMissed();
    setInterval(() => { refreshMeta().catch(() => {}); }, 60000);
  } catch (e) {
    $('#meta').textContent = 'failed to load: ' + e.message;
  }
})();
