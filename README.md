# CED Counter Search

Translates electrician jargon into CED catalog numbers, shows where the part
lives in the warehouse, and teaches you what the part is for. Runs entirely on
your Mac — no accounts, no cloud, zero npm dependencies.

## Run it

```bash
cd ced-search
node server.js
# -> http://localhost:8321
```

Keep the terminal open while you work. `Ctrl-C` stops it.

## What it does

- **Search** — type what the customer says ("sealtight 90 3/4", "minis",
  "jbox 6x6", "gfci 20", "QO120", a UPC…). Top 10 matches show catalog #,
  manufacturer, description, and **every bin/zone with quantities**. A green
  key banner shows which cheat-sheet rule translated the jargon.
- **Edit anything** — click a result to open it: rewrite the description,
  add **keywords** (your own jargon → instantly searchable), keep notes.
  Saved to `data/overrides.json`, survives data refreshes.
- **Web top 5** — per item, one click fetches the 5 best product pages
  (DuckDuckGo, cached forever in `data/webcache.json`). Cached titles and
  snippets are **indexed into search** too, so web wording finds parts.
  Buttons deep-link to the CED portal and Google as backup.
- **Cheat Sheet tab** — the counter cheat sheet digitized, filterable, with
  numbering explanations (e.g. BPT 23X size digits).
- **Learn tab** — 18 write-ups on how part families work and fit together
  (EMT → connectors → boxes → mud rings, fuse classes, NEMA configs, Square D
  numbering…). The same text appears on matching items as "What is this?".
- **Counter Rules tab** — the house-rules sheet (COD, stock transfers, wire cuts).

## Refresh inventory data

When you pull fresh exports (same two reports, any file location):

```bash
python3 ingest.py ~/Downloads/Bin_and_Lot_Quantity.xlsx ~/Downloads/lpf.xlsx
# then restart:  node server.js
```

Your edits/keywords/notes and the web cache are kept — only stock data changes.
(Requires `pip3 install --user openpyxl` once.)

## Pre-fetch web info (optional)

```bash
node enrich.js               # 200 most-stocked items, ~10 min
node enrich.js --limit 1000  # deeper pass
```

Safe to Ctrl-C and re-run — it skips what's already cached.

## Teach it

All knowledge lives in editable JSON under `data/` (restart the server after
editing):

| file | what |
|---|---|
| `jargon.json` | jargon phrase → mfr + catalog-number pattern (the cheat sheet) |
| `synonyms.json` | slang → catalog wording, and catalog abbreviations → plain words |
| `knowledge.json` | the Learn write-ups + which items they attach to |
| `mfr.json` | mfr code → real manufacturer name (a few are guesses — fix them!) |
| `counter-rules.json` | the Rules tab |
| `overrides.json` | your per-item edits (managed by the app) |
| `webcache.json` | cached web results (managed by the app) |

## Files

`server.js` (zero-dep HTTP server + API) · `lib/search.js` (scoring engine) ·
`lib/web.js` (DuckDuckGo scraper + cache) · `public/` (UI) ·
`ingest.py` (xlsx → catalog.json).
