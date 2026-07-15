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
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
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
let rotTimer = null;
function renderRecent() {
  clearInterval(rotTimer);
  // most common first — the stack slowly cycles, shrinking + fading toward the bottom
  const list = getRecent().slice().sort((a, b) => (b.count || 1) - (a.count || 1) || b.t - a.t).slice(0, 7);
  if (!list.length) { $('#results').innerHTML = ''; return; }
  const ROW = 50;
  $('#results').innerHTML = `<div class="recent">
    <div class="recenthead">Top searches
      <button class="btn tiny" id="clearrecent">clear</button></div>
    <div class="rotstack" style="height:${list.length * ROW + 14}px">${list.map((r) => `
      <button class="rotitem" data-q="${esc(r.q)}" data-mfr="${esc(r.mfr || '')}">
        🔍 ${esc(r.q)}${r.mfr ? `<span class="rmfr">${esc(r.mfr)}</span>` : ''}
      </button>`).join('')}
    </div></div>`;
  $('#clearrecent').addEventListener('click', () => { localStorage.removeItem(RECENT_KEY); renderRecent(); });
  const items = $$('.rotitem');
  items.forEach((b) => b.addEventListener('click', () => {
    qInput.value = b.dataset.q;
    mfrSel.value = b.dataset.mfr || '';
    doSearch();
    qInput.focus();
  }));
  let order = items.map((_, i) => i);
  function place() {
    order.forEach((elIdx, pos) => {
      const el = items[elIdx];
      el.style.transform = `translateY(${pos * ROW}px) scale(${Math.max(.55, 1 - pos * 0.07)})`;
      el.style.opacity = String(Math.max(.22, 1 - pos * 0.14));
      el.style.zIndex = String(30 - pos);
    });
  }
  place();
  if (items.length > 2) {
    rotTimer = setInterval(() => {
      if (!document.body.contains(items[0])) { clearInterval(rotTimer); return; }
      order = [...order.slice(1), order[0]];
      place();
    }, 3200);
  }
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
mfrSel.addEventListener('input', () => { openId = null; doSearch(); });
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
  return f ? `<img class="mfrlogo" src="/logos/${esc(f)}?v=3" alt="" onload="sizeMfrLogo(this)" onerror="this.remove()">` : '';
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
  clearInterval(rotTimer);
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
        try { await navigator.clipboard.writeText(cp.dataset.cat); }
        catch { // fallback for older setups
          const ta = document.createElement('textarea');
          ta.value = cp.dataset.cat; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
        }
        cp.textContent = '✓';
        cp.classList.add('copied');
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

// ---------- item detail (edit / web / images / learn) ----------
async function toggleDetail(cardEl, forceOpen = false) {
  const slot = $('.detailslot', cardEl);
  if (slot.innerHTML && !forceOpen) { slot.innerHTML = ''; openId = null; return; }
  $$('.detailslot').forEach((s) => { if (s !== slot) s.innerHTML = ''; });
  const id = cardEl.dataset.id;
  openId = id;
  slot.innerHTML = '<div class="detail"><span class="note">loading…</span></div>';
  let data;
  try { data = await api('/api/item?id=' + encodeURIComponent(id)); }
  catch (e) { slot.innerHTML = `<div class="detail err">${esc(e.message)}</div>`; return; }
  const it = data.item;
  const know = data.knowledge || [];
  const autoKws = (it.autoKeywords || []).map((k) => `<span class="kw auto">${esc(k)}</span>`).join('');
  slot.innerHTML = `<div class="detail">
    <h4>Description <span class="soft">(yours — original: “${esc(it.origDesc)}”)</span></h4>
    <textarea class="ed-desc" rows="2">${esc(it.desc)}</textarea>
    <h4>Keywords <span class="soft">(searchable — teach it your jargon)</span></h4>
    <div class="kws ed-kws">${it.keywords.map((k) => `<span class="kw">${esc(k)}<button title="remove" data-kw="${esc(k)}">×</button></span>`).join('')}</div>
    <div class="row"><input type="text" class="ed-kw-new" placeholder="add keyword, press Enter (e.g. “sealtite”, “ac whip connector”)"></div>
    ${autoKws ? `<h4>Auto keywords <span class="soft">(from the cheat sheet — already searchable)</span></h4><div class="kws">${autoKws}</div>` : ''}
    <h4>Notes</h4>
    <textarea class="ed-notes" rows="2" placeholder="counter notes: substitutions, who buys it, gotchas…">${esc(it.notes)}</textarea>
    <div class="row">
      <button class="btn primary ed-save">Save</button>
      <span class="saved" style="display:none">saved ✓</span>
    </div>
    <h4>Images — top 18</h4>
    <div class="imgslot"><span class="note">loading images…</span></div>
    <h4>Web — top 5</h4>
    <div class="webslot"><span class="note">searching the web…</span></div>
    ${know.length ? `<h4>What is this?</h4>${know.map((k) => `<details class="learn" open><summary>${esc(k.title)}</summary><div class="kbody">${esc(k.body)}</div></details>`).join('')}` : ''}
  </div>`;

  const detail = $('.detail', slot);
  let keywords = [...it.keywords];
  let savedImage = it.image || '';

  // every edit auto-saves to the server (overrides.json) — nothing is lost
  async function persist(fields, refreshCards = false) {
    try {
      await api('/api/item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      });
      const s = $('.saved', detail);
      if (s) { s.style.display = ''; setTimeout(() => (s.style.display = 'none'), 1500); }
      if (refreshCards) doSearch();
    } catch (e) { alert('save failed: ' + e.message); }
  }
  const autosaveText = debounce(() => persist({
    desc: $('.ed-desc', detail).value,
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

  $('.ed-desc', detail).addEventListener('input', autosaveText);
  $('.ed-notes', detail).addEventListener('input', autosaveText);

  $('.ed-save', detail).addEventListener('click', () => {
    const kwNew = $('.ed-kw-new', detail).value.trim();
    if (kwNew && !keywords.includes(kwNew)) { keywords.push(kwNew); $('.ed-kw-new', detail).value = ''; renderKws(); }
    persist({ desc: $('.ed-desc', detail).value, notes: $('.ed-notes', detail).value, keywords }, true);
  });

  // --- images (auto-load, cached server-side; click one to set it as the item photo) ---
  const imgslot = $('.imgslot', detail);
  function renderImages(entry) {
    // CED portal product photos always lead (server-verified); web images fill to 18 total
    const ced = (data.item.cedImages || []).map((src) => ({
      thumbnail: src, image: src, title: `${it.cat} — CED portal photo`,
      url: `https://cedphx.portalced.com/product-list?term=${encodeURIComponent(it.cat)}`, ced: true,
    }));
    const candidates = [...ced, ...(entry.images || [])];
    const shownList = candidates.slice(0, 18);
    let nextIdx = shownList.length; // backfill pointer into candidates
    const cellHtml = (im) => {
      const src = im.thumbnail || im.image;
      return `
      <div class="imgcell${savedImage === src ? ' picked' : ''}${im.ced ? ' cedimg' : ''}" data-src="${esc(src)}" title="${esc(im.title)}\nClick to set as this item's photo">
        <img src="${esc(src)}" alt="${esc(im.title)}">
        ${im.ced ? '<span class="cedtag">CED</span>' : ''}
        <a class="imgopen" href="${esc(im.url || im.image)}" target="_blank" rel="noopener" title="open source page">↗</a>
        <span class="imgpicked">✓ item photo</span>
      </div>`;
    };
    const imgs = shownList.map(cellHtml).join('');
    imgslot.innerHTML = imgs
      ? `<div class="note" style="margin:0 0 4px">Click an image to make it this item's photo (shows on the search result card — saved automatically). Click again to remove.</div>
         <div class="imgs">${imgs}</div><div class="row"><button class="btn tiny img-refresh">↻ refresh images</button></div>`
      : '<span class="note">no images found</span>';
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
      img.addEventListener('error', () => {
        // dead image: swap in the next candidate so the grid stays at 18
        if (nextIdx < candidates.length) {
          const wrap = document.createElement('div');
          wrap.innerHTML = cellHtml(candidates[nextIdx++]);
          const fresh = wrap.firstElementChild;
          cell.replaceWith(fresh);
          bindCell(fresh);
        } else {
          cell.remove();
        }
      });
    }
    $$('.imgcell', imgslot).forEach(bindCell);
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
    const list = (entry.results || []).map((w) => `<li>
      <a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.title)}</a><span class="dom">${esc(w.domain)}</span>
      ${w.snippet ? `<div class="snip">${esc(w.snippet)}</div>` : ''}
    </li>`).join('');
    webslot.innerHTML = `<ul class="weblist">${list || '<li class="note">no results</li>'}</ul>
      <div class="row">
        <span class="note">“${esc(entry.query)}” · ${esc((entry.fetchedAt || '').slice(0, 10))}</span>
        <button class="btn tiny web-refresh">↻ refresh</button>
        <a class="btn tiny" target="_blank" rel="noopener" href="https://cedphx.portalced.com/product-list?term=${encodeURIComponent(it.cat)}">CED search: ${esc(it.cat)} ↗</a>
        <a class="btn tiny" target="_blank" rel="noopener" href="https://www.google.com/search?udm=2&q=${encodeURIComponent(data.webQuery)}">Google Images ↗</a>
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

// ---------- boot ----------
(async function boot() {
  try {
    META = await api('/api/meta');
    $('#meta').textContent = `${META.items.toLocaleString()} items · ${META.stocked.toLocaleString()} stocked · ${META.edited} edited`;
    const dl = $('#mfrlist');
    for (const m of META.mfrs || []) {
      const o = document.createElement('option');
      o.value = m.name === m.code ? m.code : `${m.code} — ${m.name}`;
      dl.appendChild(o);
    }
    renderCheat();
    renderLearn();
    renderRules();
    renderRecent();
  } catch (e) {
    $('#meta').textContent = 'failed to load: ' + e.message;
  }
})();
