'use strict';
// Materialize synthetic data/ files so `node server.js` boots in a clean
// checkout (the real exports are gitignored). Never run on a machine with
// real data — it refuses to overwrite an existing catalog.json.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
// Only the generated catalog may be written here. The knowledge files
// (jargon/synonyms/knowledge/mfr/…) are real, git-tracked data — never touch
// them. writeFixtureData() is for tests in temp dirs only.
const CATALOG = path.join(DATA, 'catalog.json');
if (fs.existsSync(CATALOG)) {
  console.error('data/catalog.json already exists — refusing to overwrite real data.');
  process.exit(1);
}
const { catalog } = require('../test/fixtures');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 1));
console.log('fixture catalog.json written — run: node server.js');
