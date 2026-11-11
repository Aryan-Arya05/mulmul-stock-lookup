# Mulmul Stock Lookup

Store-staff app to find where an article is in stock (warehouse / store / production) by typing a style code, SKU or name, or scanning the tag barcode.

- **App:** https://aryan-arya05.github.io/mulmul-stock-lookup/ (GitHub Pages, installable PWA)
- **Data:** Supabase project `mulmul-stock-lookup` (ap-south-1). App reads `v_stock`, `products`, `locations` with the public read-only key.
- **Sync:** `.github/workflows/sync.yml` runs `scripts/sync-vinculum.mjs` every 30 min: Vinculum `v4/stock/getWhInventory` → `inventory`, `v1/sku/skuDetail` → `products`.

Repo secrets required: `VINCULUM_API_KEY`, `VINCULUM_API_OWNER`, `SUPABASE_SERVICE_ROLE_KEY`.

Rules: only Vinculum bucket `good` counts; available = qty − committedQty; `OPT` is hidden; `MWH` + bin `vir*` = in production (needs bin-level API, pending).

## Stock aging

Ages on-hand stock from its replenishment date, not the SKU creation date.

- **Inward history:** `.github/workflows/sync-inwards.yml` runs `scripts/sync-inwards.mjs` daily: Vinculum `v3/stock/adjustmentDetail` at MNW → `stock_adjustments`. Run it once with `backfill` ticked to load full history for every SKU in stock.
- **Rule:** stock is dated by when it was added: every stock-adding adjustment counts (JIT, MEMO, PRODUCTION, OUTBOND, "… INCREASE", blank), except customer returns and alterations, the INTRANSIT staging bin and virtual bins. Store transfers never reset age. Stock with no addition on record falls back to the SKU's first sale, then the year in its style code. The rule lives in the `v_fresh_inwards` and `v_stock_aging_layers` views.
- **Report:** `v_stock_aging_summary` (product type × year, qty and MRP value) and `v_stock_aging_layers` (SKU level). On-hand is allocated to inwards newest first; virtual bins, OPT and closed stores are excluded, INTRANSIT is counted. SQL in `supabase/stock_aging.sql`.
