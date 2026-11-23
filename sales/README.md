# Mulmul sales, replenishment & production dashboard

Live at https://sales.mulmul.co/. The page itself lives in the `Aryan-Arya05-mulmul-sales-dashboard` repo; `sales/index.html` here only forwards to it. Same Supabase project as the stock lookup
(`idhtjxirqvaensqhozdc`).

**Access:** people sign in with their Mulmul Threads account. Every data request goes through the `dash` edge function
(`supabase/functions/dash`), which checks in Threads that the person may open the `sales` dashboard and then reads with the
service key. Access is given in Threads under Admin, People & access. The sales tables, views, snapshot files and the
`ask-sales` function are closed to the public key; the stock lookup app's tables stay open.

## Data flow

| Source | Job | Lands in | Cadence |
|---|---|---|---|
| Vinculum `v2/order/orderPull` (windows on **updatedDate**, 7-day max, 100/page) | `scripts/sync-sales-vinculum.mjs` | `sale_lines` (source=`vinculum`) | every 30 min (`sync-sales.yml`), 3-day tail |
| Google Sheet "Replenishment sheet" tab (CSV export by gid) | `scripts/sync-sales-sheet.mjs` | `replenishment` | every 30 min |
| Google Sheet "Sale Report" tab | same, with `sheet_sales=true` | `sale_lines` (source=`sheet`) | manual (history backfill / fallback) |
| Vinculum inventory (existing stock sync) | `scripts/sync-vinculum.mjs` | `inventory`, `products` | existing schedule |

Sheet rows are only used for orders the Vinculum pull hasn't delivered (`mv_sales` anti-joins on `order_no`), so the two
never double count. Every sync ends with `refresh_sales_views()` which rebuilds `mv_sales` and `mv_stock_style_colour`.

## Views (what the dashboard and the "Ask" box query)

- `v_sales` — enriched sale lines (style, colour, size, category, channel Online/Store, store, week).
- `v_replenishment_formula` — the Designers Report, live: `formula = total_sold / days_selling × lead(60) × buffer(1.5)`,
  `after_repl_total = on_hand + ordered`, `shortfall = formula − after_repl_total`, production stage from the sheet's dates,
  pipeline from Vinculum bins (INTRANSIT / VIRTUAL-PRODUCTION / VIR-STORE). Lead and buffer live in `settings`.
- `v_launch_summary`, `v_weekly_style_colour`, `v_daily_style_colour`, `v_style_colour_summary`, `v_store_style_colour`,
  `v_size_style_colour`, `v_stock_style_colour`, `v_stock_sku`.

Counting rule: statuses allocated/confirmed/packed/picked/shipped/delivered/**pending** count as sold (matches the team's
sheet); cancelled / returned / closed do not. Only `orderType = SO` is a sale (STO = internal transfer).

## Ask anything

Edge function `ask-sales` (Supabase) → Claude writes one SELECT over the views → `run_dashboard_query()` runs it as the
`dashboard_reader` role (SELECT on views only, 20 s timeout, 200 rows) → short written answer + table + chart.
Needs the `ANTHROPIC_API_KEY` secret on the edge function (Supabase → Edge Functions → Secrets). Optional `ANTHROPIC_MODEL`.

## Manual runs (Actions → "Sync sales")

- `probe=true` — fetch one page from Vinculum and print the envelope, write nothing.
- `from_date` / `to_date` (dd/MM/yyyy) — backfill a window (by updatedDate).
- `sheet_sales=true` — reload the Sale Report tab into `sale_lines`.
- `skip_vinculum=true` — sheet only.

## Aging tab

Product type × year, quantity and MRP value, aged from the last replenishment date (not SKU creation). Loaded on
first open from `dashboard_stock_aging()`; clicking a number calls `dashboard_stock_aging_detail(type, bucket)` for the
styles behind it. Inward history comes from `scripts/sync-inwards.mjs` (see the main README, "Stock aging").
