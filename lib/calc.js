'use strict';
// Trade calculators — pure functions over NEC 2023 tables.
// Dual-environment: require()d by node tests and the server, and served to
// the browser as /calc.js (window.calc). No dependencies either way.
//
// Data sources (values are the commonly published NEC 2023 numbers):
//   conduit areas   — NEC Chapter 9, Table 4 (total 100% area, sq in)
//   conductor areas — NEC Chapter 9, Table 5 (sq in)
//   box fill        — NEC 314.16(B)
//   ampacity        — NEC 310.16 (30°C ambient, ≤3 CCC)
//   voltage drop    — K-factor formula (K: Cu 12.9, Al 21.2 Ω·cmil/ft)
// Always verify against the code book for permits/inspections.

/* eslint-disable key-spacing */

// ---------- conduit fill ----------
// NEC ch.9 table 4: internal area (100%), sq in, by trade size
const CONDUIT_AREA = {
  EMT:   { '1/2': 0.304, '3/4': 0.533, '1': 0.864, '1-1/4': 1.496, '1-1/2': 2.036, '2': 3.356, '2-1/2': 5.858, '3': 8.846, '3-1/2': 11.545, '4': 14.753 },
  PVC40: { '1/2': 0.285, '3/4': 0.508, '1': 0.832, '1-1/4': 1.453, '1-1/2': 1.986, '2': 3.291, '2-1/2': 4.695, '3': 7.268, '3-1/2': 9.737, '4': 12.554 },
  RMC:   { '1/2': 0.314, '3/4': 0.549, '1': 0.887, '1-1/4': 1.526, '1-1/2': 2.071, '2': 3.408, '2-1/2': 4.866, '3': 7.499, '3-1/2': 10.010, '4': 12.882 },
};

// NEC ch.9 table 5: conductor area incl. insulation, sq in
const CONDUCTOR_AREA = {
  'THHN': { '14': 0.0097, '12': 0.0133, '10': 0.0211, '8': 0.0366, '6': 0.0507, '4': 0.0824, '3': 0.0973, '2': 0.1158, '1': 0.1562, '1/0': 0.1855, '2/0': 0.2223, '3/0': 0.2679, '4/0': 0.3237, '250': 0.3970, '300': 0.4608, '350': 0.5242, '400': 0.5863, '500': 0.7073 },
  'XHHW-2': { '14': 0.0139, '12': 0.0181, '10': 0.0243, '8': 0.0437, '6': 0.0590, '4': 0.0814, '3': 0.0962, '2': 0.1146, '1': 0.1534, '1/0': 0.1825, '2/0': 0.2190, '3/0': 0.2642, '4/0': 0.3197 },
  'THW': { '14': 0.0139, '12': 0.0181, '10': 0.0243, '8': 0.0437, '6': 0.0726, '4': 0.0973, '3': 0.1134, '2': 0.1333, '1': 0.1901, '1/0': 0.2223, '2/0': 0.2624, '3/0': 0.3117, '4/0': 0.3718 },
};

// NEC ch.9 table 1: max fill fraction by conductor count
function fillLimit(nConductors) {
  return nConductors === 1 ? 0.53 : nConductors === 2 ? 0.31 : 0.40;
}

// conductors: [{insul: 'THHN', size: '12', count: 3}, ...]
function conduitFill({ conduitType, size, conductors }) {
  const areas = CONDUIT_AREA[conduitType];
  if (!areas) throw new Error(`unknown conduit type ${conduitType}`);
  const total = areas[size];
  if (!total) throw new Error(`unknown ${conduitType} size ${size}`);
  let used = 0, n = 0;
  for (const c of conductors) {
    const a = (CONDUCTOR_AREA[c.insul] || {})[c.size];
    if (!a) throw new Error(`unknown conductor ${c.insul} ${c.size}`);
    used += a * c.count;
    n += c.count;
  }
  const limit = fillLimit(n);
  const allowed = total * limit;
  return {
    areaUsed: used, areaAllowed: allowed, conduitArea: total,
    pct: used / total, limitPct: limit, ok: used <= allowed, conductorCount: n,
  };
}

// how many of one conductor fit in a conduit (the counter question)
function conduitMaxCount({ conduitType, size, insul, wireSize }) {
  const total = (CONDUIT_AREA[conduitType] || {})[size];
  const a = (CONDUCTOR_AREA[insul] || {})[wireSize];
  if (!total || !a) throw new Error('unknown conduit or conductor');
  // 40% applies at 3+; check the small counts against their own limits
  for (let n = Math.floor((total * 0.40) / a); n >= 1; n--) {
    if (n * a <= total * fillLimit(n)) return n;
  }
  return 0;
}

// ---------- box fill (NEC 314.16) ----------
// volume allowance per conductor, cu in
const BOX_VOL_PER_COND = { '18': 1.5, '16': 1.75, '14': 2.0, '12': 2.25, '10': 2.5, '8': 3.0, '6': 5.0 };

// common steel boxes (trade name -> cu in), NEC table 314.16(A)
const COMMON_BOXES = {
  '4x1-1/4 round/oct': 12.5, '4x1-1/2 round/oct': 15.5, '4x2-1/8 round/oct': 21.5,
  '4x1-1/4 square': 18.0, '4x1-1/2 square': 21.0, '4x2-1/8 square': 30.3,
  '4-11/16x1-1/4 square': 25.5, '4-11/16x1-1/2 square': 29.5, '4-11/16x2-1/8 square': 42.0,
  '3x2x1-1/2 device': 7.5, '3x2x2 device': 10.0, '3x2x2-1/4 device': 10.5,
  '3x2x2-1/2 device': 12.5, '3x2x2-3/4 device': 14.0, '3x2x3-1/2 device': 18.0,
};

// counts: {conductors: {'12': 5, '14': 2}, devices: [{size: '12'}, ...],
//          clamps: bool, supportFittings: 0, groundsPresent: bool}
function boxFill({ conductors = {}, devices = [], clamps = false, supportFittings = 0, groundsPresent = false }) {
  const sizes = Object.keys(conductors).filter((s) => conductors[s] > 0);
  if (!sizes.length) return { volume: 0, lines: [] };
  const vol = (s) => {
    const v = BOX_VOL_PER_COND[s];
    if (!v) throw new Error(`no box-fill volume for #${s}`);
    return v;
  };
  const largest = sizes.sort((a, b) => vol(b) - vol(a))[0];
  const lines = [];
  let volume = 0;
  for (const s of sizes) {
    const v = vol(s) * conductors[s];
    lines.push({ what: `${conductors[s]} × #${s} conductors`, vol: v });
    volume += v;
  }
  if (clamps) { const v = vol(largest); lines.push({ what: 'internal clamps (1 × largest)', vol: v }); volume += v; }
  if (supportFittings) { const v = vol(largest) * supportFittings; lines.push({ what: `${supportFittings} support fitting(s)`, vol: v }); volume += v; }
  for (const d of devices) {
    const v = vol(d.size || largest) * 2;
    lines.push({ what: `device/yoke (2 × #${d.size || largest})`, vol: v });
    volume += v;
  }
  if (groundsPresent) { const v = vol(largest); lines.push({ what: 'equipment grounds (1 × largest)', vol: v }); volume += v; }
  return { volume, lines, largest };
}

// ---------- ampacity (NEC 310.16) ----------
// base ampacity at 30°C, ≤3 current-carrying conductors
const AMPACITY = {
  CU: {
    60: { '14': 15, '12': 20, '10': 30, '8': 40, '6': 55, '4': 70, '3': 85, '2': 95, '1': 110, '1/0': 125, '2/0': 145, '3/0': 165, '4/0': 195 },
    75: { '14': 20, '12': 25, '10': 35, '8': 50, '6': 65, '4': 85, '3': 100, '2': 115, '1': 130, '1/0': 150, '2/0': 175, '3/0': 200, '4/0': 230, '250': 255, '300': 285, '350': 310, '400': 335, '500': 380 },
    90: { '14': 25, '12': 30, '10': 40, '8': 55, '6': 75, '4': 95, '3': 110, '2': 130, '1': 145, '1/0': 170, '2/0': 195, '3/0': 225, '4/0': 260, '250': 290, '300': 320, '350': 350, '400': 380, '500': 430 },
  },
  AL: {
    75: { '12': 20, '10': 30, '8': 40, '6': 50, '4': 65, '3': 75, '2': 90, '1': 100, '1/0': 120, '2/0': 135, '3/0': 155, '4/0': 180, '250': 205, '300': 230, '350': 250, '400': 270, '500': 310 },
    90: { '12': 25, '10': 35, '8': 45, '6': 55, '4': 75, '3': 85, '2': 100, '1': 115, '1/0': 135, '2/0': 150, '3/0': 175, '4/0': 205, '250': 230, '300': 260, '350': 280, '400': 305, '500': 350 },
  },
};

// 310.15(B)(1) ambient correction (30°C basis)
const AMBIENT_CORR = [
  { max: 25, f: { 60: 1.08, 75: 1.05, 90: 1.04 } },
  { max: 30, f: { 60: 1.0, 75: 1.0, 90: 1.0 } },
  { max: 35, f: { 60: 0.91, 75: 0.94, 90: 0.96 } },
  { max: 40, f: { 60: 0.82, 75: 0.88, 90: 0.91 } },
  { max: 45, f: { 60: 0.71, 75: 0.82, 90: 0.87 } },
  { max: 50, f: { 60: 0.58, 75: 0.75, 90: 0.82 } },
  { max: 55, f: { 60: 0.41, 75: 0.67, 90: 0.76 } },
];

// 310.15(C)(1) adjustment for >3 current-carrying conductors
function cccAdjust(n) {
  if (n <= 3) return 1;
  if (n <= 6) return 0.8;
  if (n <= 9) return 0.7;
  if (n <= 20) return 0.5;
  if (n <= 30) return 0.45;
  if (n <= 40) return 0.4;
  return 0.35;
}

// small-conductor overcurrent caps (240.4(D)), copper
const SMALL_COND_CAP = { '14': 15, '12': 20, '10': 30 };

function ampacity({ size, material = 'CU', tempRating = 75, ambientC = 30, ccc = 3 }) {
  const table = (AMPACITY[material] || {})[tempRating];
  if (!table) throw new Error(`no ampacity table for ${material} ${tempRating}°C`);
  const base = table[size];
  if (!base) throw new Error(`no ${material} ${tempRating}°C ampacity for #${size}`);
  const row = AMBIENT_CORR.find((r) => ambientC <= r.max) || AMBIENT_CORR[AMBIENT_CORR.length - 1];
  const corr = row.f[tempRating];
  const adj = cccAdjust(ccc);
  const adjusted = base * corr * adj;
  const cap = material === 'CU' ? SMALL_COND_CAP[size] : undefined;
  return { base, ambientFactor: corr, cccFactor: adj, adjusted, breakerCap: cap || null };
}

// ---------- voltage drop ----------
const CMIL = { '14': 4110, '12': 6530, '10': 10380, '8': 16510, '6': 26240, '4': 41740, '3': 52620, '2': 66360, '1': 83690, '1/0': 105600, '2/0': 133100, '3/0': 167800, '4/0': 211600, '250': 250000, '300': 300000, '350': 350000, '400': 400000, '500': 500000 };
const K_FACTOR = { CU: 12.9, AL: 21.2 }; // Ω·cmil/ft (75°C approximation)

function voltageDrop({ volts, amps, feet, size, material = 'CU', phase = 1 }) {
  const cm = CMIL[size];
  if (!cm) throw new Error(`unknown wire size ${size}`);
  const k = K_FACTOR[material];
  const mult = phase === 3 ? Math.sqrt(3) : 2;
  const drop = (mult * k * amps * feet) / cm;
  return { drop, pct: drop / volts, endVolts: volts - drop, ok: drop / volts <= 0.03 };
}

// ---------- wire weight <-> feet (THHN copper, approximate) ----------
// lb per 1000 ft — varies a few percent by manufacturer/spec
const LB_PER_KFT = { '14': 16, '12': 24, '10': 38, '8': 62, '6': 95, '4': 153, '2': 234, '1': 299, '1/0': 372, '2/0': 462, '3/0': 575, '4/0': 715 };

function wireWeight({ size, feet }) {
  const w = LB_PER_KFT[size];
  if (!w) throw new Error(`unknown wire size ${size}`);
  return { pounds: (w * feet) / 1000, lbPerKft: w };
}
function wireFeetFromWeight({ size, pounds }) {
  const w = LB_PER_KFT[size];
  if (!w) throw new Error(`unknown wire size ${size}`);
  return { feet: (pounds / w) * 1000, lbPerKft: w };
}

const calc = {
  CONDUIT_AREA, CONDUCTOR_AREA, COMMON_BOXES, AMPACITY, CMIL, LB_PER_KFT,
  conduitFill, conduitMaxCount, boxFill, ampacity, voltageDrop, wireWeight, wireFeetFromWeight,
  necEdition: '2023',
};

if (typeof module !== 'undefined' && module.exports) module.exports = calc;
if (typeof window !== 'undefined') window.calc = calc;
