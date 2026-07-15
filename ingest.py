#!/usr/bin/env python3
"""Build data/catalog.json from the two CED exports.

Usage:
  python3 ingest.py [path/to/Bin_and_Lot_Quantity.xlsx] [path/to/lpf.xlsx]

Re-run any time you pull fresh exports; user edits live in data/overrides.json
and are never touched by this script.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BIN_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/Bin_and_Lot_Quantity.xlsx")
LPF_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/Downloads/lpf.xlsx")
OUT_PATH = os.path.join(HERE, "data", "catalog.json")


def rows_of(path):
    try:
        import openpyxl
    except ImportError:
        sys.exit("openpyxl is required:  pip3 install --user openpyxl")
    wb = openpyxl.load_workbook(path, read_only=True)
    rows = list(wb.active.iter_rows(values_only=True))
    return rows[1:]


def s(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def build_catalog(lpf_rows, bin_rows):
    """Join the price-file master list with bin/lot rows.

    Returns (items dict, stats dict). Pure so it's unit-testable with
    in-memory rows. Bin rows whose (mfr, cat) isn't in the price file fall
    back to any price-file item sharing the catalog number; when several
    manufacturers share it, the join is ambiguous and gets reported —
    stock may be attached to the wrong manufacturer.
    """
    items = {}          # key: (mfr, cat)
    by_cat = {}         # cat -> list of keys, for joining bin rows
    for r in lpf_rows:
        mfr, cat, desc, upc = s(r[0]), s(r[1]), s(r[2]), s(r[3])
        if not cat:
            continue
        key = (mfr, cat)
        items[key] = {"id": f"{mfr}|{cat}", "mfr": mfr, "cat": cat,
                      "desc": desc, "upc": upc, "bins": [], "lots": []}
        by_cat.setdefault(cat, []).append(key)

    joined = created = 0
    ambiguous = []
    for r in bin_rows:
        mfr, cat, desc, zone, bin_, bin_qty, lot, lot_qty = (
            s(r[0]), s(r[1]), s(r[2]), s(r[3]), s(r[4]), r[5], s(r[6]), r[7])
        if not cat:
            continue
        key = (mfr, cat)
        if key not in items:
            alt = by_cat.get(cat)
            if alt:
                if len(alt) > 1:
                    ambiguous.append({
                        "binMfr": mfr, "cat": cat, "binDesc": desc,
                        "candidates": [f"{m}|{c}" for m, c in alt],
                        "joinedTo": f"{alt[0][0]}|{alt[0][1]}",
                        "bin": bin_, "qty": bin_qty if isinstance(bin_qty, (int, float)) else 0,
                    })
                key = alt[0]
            else:
                items[key] = {"id": f"{mfr}|{cat}", "mfr": mfr, "cat": cat,
                              "desc": desc, "upc": "", "bins": [], "lots": []}
                by_cat.setdefault(cat, []).append(key)
                created += 1
        it = items[key]
        if zone or bin_ or bin_qty:
            it["bins"].append({"zone": zone, "bin": bin_,
                               "qty": int(bin_qty) if isinstance(bin_qty, (int, float)) else 0})
        if lot:
            it["lots"].append({"lot": lot,
                               "qty": int(lot_qty) if isinstance(lot_qty, (int, float)) else 0})
        joined += 1

    return items, {"joined": joined, "created": created, "ambiguous": ambiguous}


def main():
    items, stats = build_catalog(rows_of(LPF_PATH), rows_of(BIN_PATH))

    out = sorted(items.values(), key=lambda x: (x["mfr"], x["cat"]))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump({"items": out}, f)

    from datetime import datetime, timezone
    report = {"generatedAt": datetime.now(timezone.utc).isoformat(),
              "joined": stats["joined"], "created": stats["created"],
              "ambiguous": stats["ambiguous"]}
    report_path = os.path.join(HERE, "data", "ingest-report.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=1)

    stocked = sum(1 for i in out if i["bins"])
    print(f"catalog.json written: {len(out)} items "
          f"({stocked} with bin locations, {stats['created']} bin-only items, "
          f"{stats['joined']} bin rows merged)")
    amb = stats["ambiguous"]
    if amb:
        print(f"\nWARNING: {len(amb)} ambiguous joins — stock may be attached to the "
              f"wrong manufacturer (full list in data/ingest-report.json):")
        for a in amb[:10]:
            print(f"  bin row {a['binMfr']} {a['cat']} -> joined to {a['joinedTo']} "
                  f"(candidates: {', '.join(a['candidates'])})")
        if len(amb) > 10:
            print(f"  … and {len(amb) - 10} more")


if __name__ == "__main__":
    main()
