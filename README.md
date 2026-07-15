# CED Counter Search

Translates electrician jargon into CED catalog numbers, shows where the part
lives in the warehouse, and teaches you what the part is for. Runs entirely on
your Mac — no accounts, no cloud, zero npm dependencies.

## Run it

```bash
cd ced-search
node server.js
# -> http://localhost:8321 (plus your LAN addresses)
```

Keep the terminal open while you work. `Ctrl-C` stops it. The startup banner
prints LAN URLs — **any counter station or warehouse tablet on your network can
use the same app**, and everyone's keywords/notes are shared. The header shows
how many counters are online and how old the inventory data is.

## What it does

- **Search** — type what the customer says ("sealtight 90 3/4", "minis",
  "jbox 6x6", "gfci 20", "QO120", a UPC…). Matches show catalog #,
  manufacturer, description, and **every bin location**. A green
  key banner shows which cheat-sheet rule translated the jargon. Decimal and
  fraction sizes cross-match (".75" finds 3/4").
- **Edit anything** — click a result to open it: add **keywords** (your own
  jargon → instantly searchable) and notes. Saved to `data/overrides.json`
  with atomic writes and daily backups in `data/backups/` — survives crashes
  and data refreshes. If two stations edit the same item, the later save wins
  and the pane warns.
- **Substitutes & goes-with** — teach interchangeable parts in `data/xref.json`.
  Out-of-stock results show "Out — sub: …" with live stock, nearest bin first
  in warehouse walk order (set your zone order in `data/zones.json`); the item
  detail lists substitutes and companion parts.
- **Web top 3 + images** — per item: the 10 best product images in one row
  (click one to make it the item photo) and 3 web links (DuckDuckGo, cached in
  `data/webcache.json`; cached wording is indexed into search). CED-portal and
  Google Images buttons sit at the top of every item.
- **Barcode scanning** — a USB scanner works anywhere in the app: scans land in
  the search box and run instantly (UPCs already match). On Chrome at
  localhost, 📷 scans with the camera.
- **Calc tab** — conduit fill, box fill, ampacity (with derating), voltage
  drop (with wire-size upsizing), wire weight⇄feet, and a NEMA plug chart.
  NEC 2023 values, unit-tested against published answers — still verify
  against the code book for permits.
- **Shelf labels** — 🏷 on any item prints a label with a Code-128 barcode
  that the scanner reads back into search.
- **Cheat Sheet tab** — the counter cheat sheet digitized, filterable,
  printable, with numbering explanations (e.g. BPT 23X size digits).
- **Learn tab** — write-ups on how part families work and fit together. The
  same text appears on matching items as "What is this?".
- **Counter Rules tab** — the house-rules sheet (COD, stock transfers, wire cuts).
- **Missed tab** — every search that found nothing is logged (typo-debounced).
  That list is your to-do list for teaching new jargon.

## AI assistant (optional)

With a Claude API key, the app gains an assistant and self-teaching tools.
Set the key either way:

```bash
ANTHROPIC_API_KEY=sk-ant-... node server.js
# or put it in data/config.json:  {"anthropicApiKey": "sk-ant-..."}
```

- **💬 Ask** (bottom left) — natural-language questions ("what do we have for
  3/4 sealtight 90s and where?"). Answers are grounded in your live inventory
  via tools — it searches the same engine you do and cites cat #s + bins.
- **✨ Suggest fixes** (Missed tab) — turns failed searches into proposed
  jargon rules and synonyms.
- **Draft knowledge** — `POST /api/ai/draft-knowledge {"topic": "..."}` drafts
  a Learn write-up from your catalog + cached web text.
- **Batch scripts** — `node ai-enrich.js --limit 50 --yes` suggests counter
  keywords for top-stocked items; `node ai-xref.js --yes` proposes substitute
  groups. Both print counts and require `--yes` before spending API credits.

**Nothing AI-written is ever saved directly.** Every suggestion lands in the
**Suggestions tab**, where you approve or reject it; approved entries merge
into the data files and reload live. No key → all AI features hide and the
rest of the app is unaffected.

## Refresh inventory data

When you pull fresh exports (same two reports, any file location):

```bash
python3 ingest.py ~/Downloads/Bin_and_Lot_Quantity.xlsx ~/Downloads/lpf.xlsx
```

No restart needed — the server hot-reloads data files. Your edits/keywords/
notes and the web cache are kept — only stock data changes.
Ingest also writes `data/ingest-report.json` and warns when a bin row could
belong to more than one manufacturer. (Requires `pip3 install --user openpyxl`
once.)

## Pre-fetch web info (optional)

```bash
node enrich.js               # 200 most-stocked items, ~10 min
node enrich.js --limit 1000  # deeper pass
```

Safe to Ctrl-C and re-run — it skips what's already cached.

## Teach it

All knowledge lives in editable JSON under `data/` — the server **hot-reloads**
these on save (a broken file keeps the old data and shows a banner):

| file | what |
|---|---|
| `jargon.json` | jargon phrase → mfr + catalog-number pattern (the cheat sheet) |
| `synonyms.json` | slang → catalog wording, and catalog abbreviations → plain words |
| `knowledge.json` | the Learn write-ups + which items they attach to |
| `mfr.json` | mfr code → real manufacturer name (a few are guesses — fix them!) |
| `xref.json` | substitute groups + goes-with accessories |
| `zones.json` | warehouse walk order used to pick the nearest bin for substitutes: `{"order": ["A","B","WIRE"]}` |
| `map.json` | optional floor map (see `map.json.example`) — highlights an item's zone |
| `counter-rules.json` | the Rules tab |
| `overrides.json` | your per-item edits (managed by the app, backed up daily) |
| `webcache.json`, `missed.json`, `pending.json` | managed by the app |
| `config.json` | optional Claude API key + model choice (never commit) |

## Development

```bash
npm test                     # node --test: search, calcs, barcodes, AI loop, queue
python3 -m unittest test.test_ingest
node scripts/make-fixture-catalog.js   # synthetic catalog so the server boots in a clean checkout
```

## Files

`server.js` (zero-dep HTTP server + API) · `lib/search.js` (scoring engine) ·
`lib/web.js` (DuckDuckGo scraper + cache) · `lib/store.js` (atomic JSON +
backups) · `lib/calc.js` (NEC calculators) · `lib/code128.js` (barcode SVG) ·
`lib/ai.js` (Claude API client) · `lib/pending.js` (suggestion approval queue) ·
`public/` (UI + labels) · `ingest.py` (xlsx → catalog.json) ·
`ai-enrich.js` / `ai-xref.js` (batch AI suggesters).
