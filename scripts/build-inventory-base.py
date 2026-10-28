#!/usr/bin/env python3
"""Convert a Vinculum panel inventory export (xlsx or csv) into data/inventory-base.csv.gz.
Needs columns: SKU, Bin, Available Qty, LocCode (others ignored; 'Inv Bucket' rows other than good are skipped).
Usage: build-inventory-base.py <export.xlsx|csv>"""
import csv, gzip, sys, collections, os
src = sys.argv[1]
if src.lower().endswith(".csv"):
    with open(src, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
else:
    import openpyxl
    it = openpyxl.load_workbook(src, read_only=True).worksheets[0].iter_rows(values_only=True)
    head = [str(h or "").strip() for h in next(it)]
    rows = [dict(zip(head, r)) for r in it]
def col(r, *names):
    for n in names:
        for k in r:
            if k and k.strip().lower() == n.lower(): return r[k]
    return None
inv = collections.Counter(); skipped_bucket = 0
for r in rows:
    sku, lc, b = col(r, "SKU", "Sku Code"), col(r, "LocCode"), col(r, "Bin")
    if not sku or not lc or lc == "OPT": continue
    bucket = (col(r, "Inv Bucket") or "good")
    if str(bucket).strip().lower() != "good": skipped_bucket += 1; continue
    q = int(float(col(r, "Available Qty") or 0))
    inv[(str(sku).strip().upper(), str(lc).strip(), str(b or "").strip().upper())] += q
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "inventory-base.csv.gz")
with gzip.open(out, "wt", newline="") as f:
    w = csv.writer(f); w.writerow(["sku", "location_code", "bin", "qty"])
    w.writerows([k[0], k[1], k[2], v] for k, v in inv.items() if v)
print(f"{sum(1 for v in inv.values() if v)} rows from {len(rows)} export lines (skipped {skipped_bucket} non-good) -> {out}")
