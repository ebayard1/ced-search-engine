'use strict';
// Safe JSON persistence: atomic writes (temp + rename) and rotating daily
// backups. overrides.json holds irreplaceable counter knowledge — a crash
// mid-write must never truncate it, and a corrupt file must never be
// silently replaced with {}.

const fs = require('fs');
const path = require('path');

// Atomic on the same volume: write a sibling temp file, then rename over.
function saveJSONAtomic(file, obj, indent = 1) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, indent));
  fs.renameSync(tmp, file);
}

const KEEP_BACKUPS = 14;

// Copy file into <dir>/backups/<name>-YYYY-MM-DD<ext> once per day; prune old ones.
function rotateBackup(file) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const today = new Date().toISOString().slice(0, 10);
  const dest = path.join(dir, `${base}-${today}${ext}`);
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
  const mine = fs.readdirSync(dir).filter((f) => f.startsWith(base + '-') && f.endsWith(ext)).sort();
  for (const f of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) {
    fs.unlinkSync(path.join(dir, f));
  }
  return dest;
}

function newestBackup(file) {
  const dir = path.join(path.dirname(file), 'backups');
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  let list;
  try { list = fs.readdirSync(dir); } catch { return null; }
  const mine = list.filter((f) => f.startsWith(base + '-') && f.endsWith(ext)).sort();
  return mine.length ? path.join(dir, mine[mine.length - 1]) : null;
}

// Load a JSON file that must not be silently lost. Missing file -> fallback.
// Corrupt file -> try the newest backup; if none parses, throw loudly so the
// operator restores by hand instead of the app booting with empty data.
function loadJSONGuarded(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(raw); } catch (e) {
    const bak = newestBackup(file);
    if (bak) {
      try {
        const obj = JSON.parse(fs.readFileSync(bak, 'utf8'));
        console.error(`WARNING: ${path.basename(file)} is corrupt (${e.message}) — restored from ${bak}`);
        saveJSONAtomic(file, obj);
        return obj;
      } catch { /* fall through */ }
    }
    throw new Error(`${file} is corrupt (${e.message}) and no readable backup exists. ` +
      `Refusing to start with empty data — fix or delete the file manually.`);
  }
}

module.exports = { saveJSONAtomic, rotateBackup, newestBackup, loadJSONGuarded };
