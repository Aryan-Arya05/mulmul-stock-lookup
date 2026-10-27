#!/usr/bin/env python3
"""Convert a Vinculum panel inventory export (xlsx or csv with columns
SKU, Style, SKU Desc, Hierarchy Code, Size, Bin, Available Qty, Site Location, LocCode)
into data/inventory-base.csv.gz. Usage: build-inventory-base.py <export.xlsx|csv>"""
import csv, gzip, sys, collections, os
src = sys.argv[1]
if src.lower().endswith(".csv"):
    with open(src, encoding="utf-8-sig", newline="") as f:
        rows = [tuple(r.values()) for r in csv.DictReader(f)]
else:
    import openpyxl
    rows = list(openpyxl.load_workbook(src, read_only=True).worksheets[0].iter_rows(values_only=True))[1:]
inv = collections.Counter()
for sku, style, desc, hier, size, b, q, site, lc in rows:
    if not sku or lc == "OPT": continue
    inv[(str(sku).strip().upper(), str(lc).strip(), str(b or "").strip().upper())] += int(float(q or 0))
out = os.path.join(os.path.dirname(__file__), "..", "data", "inventory-base.csv.gz")
with gzip.open(out, "wt", newline="") as f:
    w = csv.writer(f); w.writerow(["sku", "location_code", "bin", "qty"])
    w.writerows([k[0], k[1], k[2], v] for k, v in inv.items() if v)
print(f"{len(inv)} rows from {len(rows)} export lines -> {out}")
