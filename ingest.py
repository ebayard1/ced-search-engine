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

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required:  pip3 install --user openpyxl")

HERE = os.path.dirname(os.path.abspath(__file__))
BIN_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/Bin_and_Lot_Quantity.xlsx")
LPF_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/Downloads/lpf.xlsx")
OUT_PATH = os.path.join(HERE, "data", "catalog.json")


def rows_of(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    rows = list(wb.active.iter_rows(values_only=True))
    return rows[1:]


def s(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def main():
    # --- price file: master catalog (mfr, cat#, desc, upc) ---
    items = {}          # key: (mfr, cat)
    by_cat = {}         # cat -> list of keys, for joining bin rows
    for r in rows_of(LPF_PATH):
        mfr, cat, desc, upc = s(r[0]), s(r[1]), s(r[2]), s(r[3])
        if not cat:
            continue
        key = (mfr, cat)
        items[key] = {"id": f"{mfr}|{cat}", "mfr": mfr, "cat": cat,
                      "desc": desc, "upc": upc, "bins": [], "lots": []}
        by_cat.setdefault(cat, []).append(key)

    # --- bin/lot file: locations & quantities ---
    joined = created = 0
    for r in rows_of(BIN_PATH):
        mfr, cat, desc, zone, bin_, bin_qty, lot, lot_qty = (
            s(r[0]), s(r[1]), s(r[2]), s(r[3]), s(r[4]), r[5], s(r[6]), r[7])
        if not cat:
            continue
        key = (mfr, cat)
        if key not in items:
            alt = by_cat.get(cat)
            if alt:
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

    out = sorted(items.values(), key=lambda x: (x["mfr"], x["cat"]))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump({"items": out}, f)
    stocked = sum(1 for i in out if i["bins"])
    print(f"catalog.json written: {len(out)} items "
          f"({stocked} with bin locations, {created} bin-only items, {joined} bin rows merged)")


if __name__ == "__main__":
    main()
