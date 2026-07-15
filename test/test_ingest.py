"""Unit tests for the ingest join logic (pure, no xlsx needed).

Run:  python3 -m unittest test.test_ingest
"""
import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ingest import build_catalog  # noqa: E402

# price-file rows: (mfr, cat, desc, upc)
LPF = [
    ("BPT", "230", '1/2" EMT SS CONN', "786331302300"),
    ("ARL", "100", "SNAP2IT 3/8", ""),
    ("DOT", "100", "WIRE NUT ASST", ""),
]

def bin_row(mfr, cat, desc="", zone="A", bin_="A-01-1", qty=5, lot="", lot_qty=None):
    return (mfr, cat, desc, zone, bin_, qty, lot, lot_qty)


class TestBuildCatalog(unittest.TestCase):
    def test_direct_join(self):
        items, stats = build_catalog(LPF, [bin_row("BPT", "230")])
        self.assertEqual(items[("BPT", "230")]["bins"][0]["qty"], 5)
        self.assertEqual(stats["ambiguous"], [])

    def test_ambiguous_join_reported(self):
        # bin row's mfr code doesn't match the price file; two mfrs share cat 100
        items, stats = build_catalog(LPF, [bin_row("XX", "100", qty=7)])
        self.assertEqual(len(stats["ambiguous"]), 1)
        amb = stats["ambiguous"][0]
        self.assertEqual(amb["joinedTo"], "ARL|100")
        self.assertEqual(sorted(amb["candidates"]), ["ARL|100", "DOT|100"])
        self.assertEqual(items[("ARL", "100")]["bins"][0]["qty"], 7)

    def test_single_candidate_fallback_not_reported(self):
        items, stats = build_catalog(LPF, [bin_row("XX", "230")])
        self.assertEqual(stats["ambiguous"], [])
        self.assertEqual(items[("BPT", "230")]["bins"][0]["qty"], 5)

    def test_unknown_cat_creates_bin_only_item(self):
        items, stats = build_catalog(LPF, [bin_row("NEW", "999")])
        self.assertEqual(stats["created"], 1)
        self.assertIn(("NEW", "999"), items)

    def test_lots_collected(self):
        items, _ = build_catalog(LPF, [bin_row("BPT", "230", lot="REEL-1", lot_qty=2500)])
        self.assertEqual(items[("BPT", "230")]["lots"], [{"lot": "REEL-1", "qty": 2500}])


if __name__ == "__main__":
    unittest.main()
