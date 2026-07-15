'use strict';
// Synthetic data for tests — the real data/ files are gitignored and absent
// in clean checkouts, so every test builds from these fixtures.

const fs = require('fs');
const path = require('path');

const catalog = {
  items: [
    { id: 'BPT|230', mfr: 'BPT', cat: '230', desc: '1/2" EMT SET SCREW CONN', upc: '78633130230',
      bins: [{ zone: 'A', bin: 'A-04-3', qty: 120 }, { zone: 'A', bin: 'A-04-3', qty: 30 }, { zone: 'RECEIVING', bin: 'RECV1', qty: 50 }], lots: [] },
    { id: 'BPT|231', mfr: 'BPT', cat: '231', desc: '3/4" EMT SET SCREW CONN', upc: '78633130231',
      bins: [{ zone: 'A', bin: 'A-04-4', qty: 200 }], lots: [] },
    { id: 'BPT|250', mfr: 'BPT', cat: '250', desc: '1/2" EMT SET SCREW COUP', upc: '',
      bins: [], lots: [] },
    { id: 'LEV|GFWR1', mfr: 'LEV', cat: 'GFWR1', desc: 'GFCI RECPT 15A WR WHITE', upc: '07847765432',
      bins: [], lots: [] },
    { id: 'HUBW|GFRST15W', mfr: 'HUBW', cat: 'GFRST15W', desc: 'GFCI RECEPTACLE 15A SELF TEST WH', upc: '',
      bins: [{ zone: 'B', bin: 'B-12-1', qty: 23 }], lots: [] },
    { id: 'SQD|QO120', mfr: 'SQD', cat: 'QO120', desc: 'QO BREAKER 1P 20A', upc: '78590112345',
      bins: [{ zone: 'C', bin: 'C-01-1', qty: 44 }], lots: [] },
    { id: 'SOUTH|THHN12', mfr: 'SOUTH', cat: 'THHN12', desc: '#12 AWG THHN STRANDED BLACK', upc: '',
      bins: [{ zone: 'WIRE', bin: 'W-01', qty: 5000 }],
      lots: [{ lot: 'REEL-8841', qty: 2500 }, { lot: 'REEL-902', qty: 2500 }] },
    // two manufacturers sharing a catalog number — the ambiguous-join case
    { id: 'ARL|100', mfr: 'ARL', cat: '100', desc: 'ARLINGTON SNAP2IT 3/8', upc: '',
      bins: [{ zone: 'A', bin: 'A-09-1', qty: 10 }], lots: [] },
    { id: 'DOT|100', mfr: 'DOT', cat: '100', desc: 'DOTTIE WIRE NUT ASST', upc: '',
      bins: [], lots: [] },
    { id: 'BLINE|SC060604NK', mfr: 'BLINE', cat: 'SC060604NK', desc: 'SCREW COVER JBOX', upc: '',
      bins: [{ zone: 'B', bin: 'B-03-2', qty: 6 }], lots: [] },
    { id: 'LF|FLNR060', mfr: 'LF', cat: 'FLNR060', desc: 'FUSE CLASS RK5 60A TIME DELAY', upc: '',
      bins: [{ zone: 'C', bin: 'C-08-4', qty: 12 }], lots: [] },
  ],
};

const jargon = {
  rules: [
    { term: 'EMT set screw connector', aliases: ['set screw connector', 'emt connector'], mfr: 'BPT', match: '^23\\d',
      hint: 'BPT 23X. Last digit = size: 0=1/2", 1=3/4".' },
    { term: 'gfci', aliases: ['gfi', 'ground fault'], mfr: null, match: 'GF',
      hint: 'Ground-fault receptacles.' },
  ],
};

const synonyms = {
  slang: {
    jbox: ['junction box', 'screw cover box'],
    sealtight: ['liquidtight flexible metal conduit'],
  },
  abbrev: {
    CONN: 'CONNECTOR',
    COUP: 'COUPLING',
    RECPT: 'RECEPTACLE',
    WH: 'WHITE',
  },
};

const mfr = {
  map: { BPT: 'Bridgeport', LEV: 'Leviton', HUBW: 'Hubbell', SQD: 'Square D', SOUTH: 'Southwire', BLINE: 'B-Line', LF: 'Littelfuse', ARL: 'Arlington', DOT: 'L.H. Dottie' },
};

const knowledge = {
  entries: [
    { id: 'gfci-basics', title: 'GFCI receptacles', match: [{ desc: 'GFCI' }],
      body: 'GFCIs trip on ground-fault current. WR = weather resistant.' },
  ],
};

const counterRules = { rules: ['COD customers pay before wire is cut.'] };

// Materialize a full data/ directory for server-level tests.
function writeFixtureData(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'catalog.json': catalog,
    'jargon.json': jargon,
    'synonyms.json': synonyms,
    'mfr.json': mfr,
    'knowledge.json': knowledge,
    'counter-rules.json': counterRules,
    'mfrlogos.json': {},
  };
  for (const [f, obj] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, f), JSON.stringify(obj, null, 1));
  }
  return dir;
}

module.exports = { catalog, jargon, synonyms, mfr, knowledge, counterRules, writeFixtureData };
