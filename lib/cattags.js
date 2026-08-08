'use strict';
// Catalog-number tagging: read a manufacturer's numbering system straight off
// the catalog number and turn it into counter-readable tags.
//
// Why: the cheat sheet (data/jargon.json) maps a trade phrase to a whole
// FAMILY of numbers ("^23\\d" = EMT set screw connectors). It can't tell you
// what the individual digits mean, so a counter guy still has to know that
// VH322NRB is a heavy-duty fused 3-pole 240V 60A disconnect in a 3R hub can.
// A family decoder does that per item: the tags show in the item detail and
// every one of them is indexed, so "60 amp 3 pole fusible disconnect" finds
// the switch even though none of those words appear in the description.
//
// Adding a family: push an entry onto FAMILIES with a `mfrs` list and a
// decode(cat) that returns { title, tags, keywords, unknown } or null.
// Everything else (indexing, UI, API) is generic.

// Manufacturer codes that mean Square D / Schneider in CED's export.
const SQD_MFRS = ['SQD', 'SQUARED', 'SQUARE', 'SCHN', 'SCHNEIDER', 'SE'];

// ---------- Square D safety switches (VisiPacT and the classic line) ----------
// Numbering per the Square D "Catalog numbering system for safety switches"
// sheet:  VH  3  2  1  N  RB
//         |   |  |  |  |  '-- enclosure
//         |   |  |  |  '----- neutral
//         |   |  |  '-------- ampere rating
//         |   |  '----------- voltage rating
//         |   '-------------- switchable poles
//         '------------------ type of switch (U = non-fusible)

const SQD_TYPE = {
  L: { duty: 'Light-duty', fusible: true },
  D: { duty: 'General-duty', fusible: true },
  VH: { duty: 'Heavy-duty', fusible: true },
  DT: { duty: 'Double-throw', fusible: true },
  DU: { duty: 'General-duty', fusible: false },
  VHU: { duty: 'Heavy-duty', fusible: false },
  DTU: { duty: 'Double-throw', fusible: false },
  // not on the VisiPacT sheet, but the same grammar and still all over the
  // shelves: the pre-VisiPacT heavy-duty series
  H: { duty: 'Heavy-duty', fusible: true, classic: true },
  HU: { duty: 'Heavy-duty', fusible: false, classic: true },
};
const SQD_POLES = { 1: 'One-pole', 2: 'Two-pole', 3: 'Three-pole', 4: 'Four-pole', 6: 'Six-pole' };
const SQD_VOLTS = { 1: '120 Vac (plug fuse)', 2: '240 Vac', 6: '600 Vac' };
const SQD_AMPS = { 1: '30 A', 2: '60 A', 3: '100 A', 4: '200 A', 5: '400 A', 6: '600 A', 7: '800 A', 8: '1,200 A' };
const SQD_NEUTRAL = {
  N: 'Factory-installed neutral',
  B: 'Factory-installed neutral bonded to the enclosure (service entrance, USA only)',
};
// longest first — RB must win over R, DTU over DT
const SQD_ENCLOSURE = [
  ['AWK', 'Type 12, no knockouts (ships with a removable drip hole for Type 3R use)'],
  ['DS', 'Types 4, 4X, 5 — 304 stainless steel'],
  ['SS', 'Types 4, 4X, 5 — 316 stainless steel'],
  ['RB', 'Type 3R with Type B hub provision'],
  ['R', 'Type 3R (rainproof — outdoor)'],
];
const SQD_MISC = [
  ['KIKI', 'Two-key interlock'],
  ['KI', 'One-key interlock'],
  // the sheet prints this one ambiguously (SPLO / SPIO) — accept both spellings
  ['SPLO', 'Lock-on provision'],
  ['SPIO', 'Lock-on provision'],
  ['GL', 'Ground lugs'],
];

const SQD_HEAD = /^(VHU|VH|DTU|DT|DU|D|L|HU|H)(\d)(\d)(\d)/;

function sqdSafetySwitch(cat) {
  const m = SQD_HEAD.exec(cat);
  if (!m) return null;
  const [, code, poleD, voltD, ampD] = m;
  const type = SQD_TYPE[code];
  const poles = SQD_POLES[poleD];
  const volts = SQD_VOLTS[voltD];
  const amps = SQD_AMPS[ampD];
  // every one of the three digits has to be a real table entry — otherwise
  // this is some other Square D number that happens to start with D/L/VH
  if (!type || !poles || !volts || !amps) return null;

  let rest = cat.slice(m[0].length);
  const tags = [];
  const fuse = type.fusible ? 'Fusible' : 'Non-fusible';
  tags.push({
    label: 'Type',
    code,
    value: `${type.duty}, ${fuse.toLowerCase()}${type.classic ? ' (classic series, pre-VisiPacT)' : ''}`,
  });
  tags.push({ label: 'Poles', code: poleD, value: poles });
  tags.push({ label: 'Voltage', code: voltD, value: volts });
  tags.push({ label: 'Amps', code: ampD, value: amps });

  let neutral = null;
  if (rest[0] === 'N' || rest[0] === 'B') {
    neutral = rest[0];
    tags.push({ label: 'Neutral', code: neutral, value: SQD_NEUTRAL[neutral] });
    rest = rest.slice(1);
  } else {
    tags.push({ label: 'Neutral', code: '', value: 'No factory neutral (field-installable on most general- and heavy-duty switches)' });
  }

  let enclosure = ['', 'Type 1 (indoor, general purpose)'];
  for (const [sfx, desc] of SQD_ENCLOSURE) {
    if (rest.startsWith(sfx)) { enclosure = [sfx, desc]; rest = rest.slice(sfx.length); break; }
  }
  tags.push({ label: 'Enclosure', code: enclosure[0], value: enclosure[1] });

  const misc = [];
  let scanning = true;
  while (scanning && rest) {
    scanning = false;
    for (const [sfx, desc] of SQD_MISC) {
      if (rest.startsWith(sfx)) {
        misc.push([sfx, desc]);
        tags.push({ label: 'Option', code: sfx, value: desc });
        rest = rest.slice(sfx.length);
        scanning = true;
        break;
      }
    }
  }
  // a long unexplained tail means we're probably not looking at a safety switch
  if (rest.length > 4) return null;

  const ampNum = amps.replace(/[^\d]/g, '');
  const poleNum = poleD;
  const voltNum = volts.replace(/\D.*$/, '');
  // "fusible" is deliberately never emitted for a non-fusible switch — the
  // tokenizer can't tell "non fusible" from "fusible", so an unfused switch
  // carrying that word outranks the fused one on a "fusible disconnect" ask
  const fuseWords = type.fusible
    ? ['fusible disconnect', 'fused disconnect', 'fusible safety switch']
    : ['nonfusible disconnect', 'non fused disconnect', 'unfused safety switch'];
  const keywords = [
    'safety switch', 'disconnect', `${type.duty.toLowerCase()} safety switch`,
    ...fuseWords,
    `${ampNum} amp`, `${poleNum} pole`, `${voltNum} volt`,
    `${ampNum} amp ${poleNum} pole disconnect`,
  ];
  if (code === 'DT' || code === 'DTU') keywords.push('double throw switch', 'transfer switch');
  if (neutral) keywords.push('with neutral', 'solid neutral');
  if (enclosure[0] === 'R' || enclosure[0] === 'RB') keywords.push('type 3r', 'outdoor disconnect', 'rainproof');
  if (enclosure[0] === 'RB') keywords.push('hub provision');
  if (enclosure[0] === 'AWK') keywords.push('type 12', 'dust tight');
  if (enclosure[0] === 'DS' || enclosure[0] === 'SS') keywords.push('type 4x', 'stainless steel', 'washdown');
  if (!enclosure[0]) keywords.push('type 1', 'indoor disconnect');
  for (const [, desc] of misc) keywords.push(desc.toLowerCase());

  const encShort = { '': 'Type 1', AWK: 'Type 12', DS: 'Type 4X 304SS', SS: 'Type 4X 316SS', R: 'Type 3R', RB: 'Type 3R hub' };
  const summary = [
    `${ampNum}A`, `${poleNum}P`, `${voltNum}V`, fuse.toLowerCase(),
    encShort[enclosure[0]], neutral ? 'neutral' : null,
  ].filter(Boolean).join(' · ');

  return {
    title: `Square D safety switch — ${type.duty.toLowerCase()}, ${fuse.toLowerCase()}`,
    summary,
    tags,
    keywords,
    unknown: rest || '',
  };
}

const FAMILIES = [
  {
    id: 'sqd-safety-switch',
    name: 'Square D safety switches (VisiPacT / classic)',
    mfrs: SQD_MFRS,
    ref: 'Square D catalog numbering system for safety switches: type + poles + voltage + amps + neutral + enclosure + options.',
    decode: sqdSafetySwitch,
  },
];

// mfr code + catalog # -> { family, title, tags, keywords, unknown } or null.
function decodeCat(mfr, cat) {
  const code = String(mfr || '').toUpperCase();
  const num = String(cat || '').toUpperCase().replace(/[\s.–—-]/g, '');
  if (!num) return null;
  for (const fam of FAMILIES) {
    if (fam.mfrs.length && !fam.mfrs.includes(code)) continue;
    const out = fam.decode(num);
    if (out) return { family: fam.id, ref: fam.ref, ...out };
  }
  return null;
}

// Flat, searchable phrases for the index (deduped, lowercase).
function tagKeywords(mfr, cat) {
  const d = decodeCat(mfr, cat);
  if (!d) return [];
  return [...new Set(d.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))];
}

module.exports = { decodeCat, tagKeywords, FAMILIES };
