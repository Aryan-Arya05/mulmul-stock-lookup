# Mulmul Stock Lookup

Store-staff app to find where an article is in stock (warehouse / store / production) by typing a style code, SKU or name, or scanning the tag barcode.

- **App:** https://aryan-arya05.github.io/mulmul-stock-lookup/ (GitHub Pages, installable PWA)
- **Data:** Supabase project `mulmul-stock-lookup` (ap-south-1). App reads `v_stock`, `products`, `locations` with the public read-only key.
- **Sync:** `.github/workflows/sync.yml` runs `scripts/sync-vinculum.mjs` every 30 min: Vinculum `v4/stock/getWhInventory` → `inventory`, `v1/sku/skuDetail` → `products`.

Repo secrets required: `VINCULUM_API_KEY`, `VINCULUM_API_OWNER`, `SUPABASE_SERVICE_ROLE_KEY`.

Rules: only Vinculum bucket `good` counts; available = qty − committedQty; `OPT` is hidden; `MWH` + bin `vir*` = in production (needs bin-level API, pending).
