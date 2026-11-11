-- Stock aging: age on-hand stock from its replenishment (inward) date, not the SKU creation date.
-- Applied to the Supabase project as migration `stock_aging`; kept here for reference.
--
-- Source of inward dates: Vinculum v3/stock/adjustmentDetail, loaded by scripts/sync-inwards.mjs.
-- Stock enters Vinculum as a manual positive adjustment, almost all of it at MNW (Noida): into the JIT bin
-- ("MEMO IS CREATING"), into rack bins ("OUTBOND NOT CREATED", "FOR PRODUCTION", "FOOTWEAR INCREASE", ...).
-- The date of that adjustment is the date the stock was added. Store transfers never reset age.

create table if not exists public.stock_adjustments (
  id            text primary key,              -- Vinculum adjustment id
  sku           text not null,
  location_code text not null,
  bin           text not null default '',
  qty           numeric not null,
  reason        text,
  remarks       text,
  created_by    text,
  created_at    timestamptz not null,          -- adjustment date (IST in Vinculum)
  synced_at     timestamptz not null default now()
);
create index if not exists stock_adjustments_sku_idx on public.stock_adjustments (sku, created_at desc);
alter table public.stock_adjustments enable row level security;   -- service role only

-- Inward = the date stock was added at any location. Every stock-adding adjustment counts, whatever its
-- remark (JIT / MEMO / PRODUCTION / OUTBOND / "... INCREASE" / blank), except customer returns and alterations
-- (old units coming back), the INTRANSIT staging bin and the virtual bins.
-- The rule lives here, so it can change without re-pulling history.
create or replace view public.v_fresh_inwards with (security_invoker = true) as
select id, sku, bin, qty, remarks, created_by, created_at,
       (created_at at time zone 'Asia/Kolkata')::date as inward_date
from public.stock_adjustments
where qty > 0
  and upper(bin) not like 'VIR%'
  and upper(bin) <> 'INTRANSIT'
  and coalesce(remarks, '') !~* 'REVERSE|RTO|RETURN|ALTER|EXCHANGE|ORDER PCS|CANCEL';

-- Physical on-hand per SKU: every warehouse and store, INTRANSIT included;
-- virtual bins (VIRTUAL, VIRTUAL-PRODUCTION, VIR-STORE), OPT and the closed stores are excluded.
create or replace view public.v_stock_on_hand with (security_invoker = true) as
select i.sku, sum(i.qty)::numeric as on_hand
from public.inventory i
where i.qty > 0
  and upper(i.bin) not like 'VIR%'
  and i.location_code not in ('OPT', 'BNG', 'MRS')
group by i.sku;

-- First sale date per SKU: fallback date for stock that has no stock-addition on record.
-- Refreshed by refresh_stock_aging(), which scripts/sync-inwards.mjs calls after each daily run.
create materialized view if not exists public.mv_sku_first_sale as
select sku, min(sale_date) as first_sale from public.mv_sales where is_sale group by sku;
create unique index if not exists mv_sku_first_sale_sku on public.mv_sku_first_sale (sku);
grant select on public.mv_sku_first_sale to anon, authenticated, service_role;

create or replace function public.refresh_stock_aging() returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  refresh materialized view mv_sku_first_sale;
  refresh materialized view mv_stock_aging_layers;   -- defined further down
end $$;
revoke execute on function public.refresh_stock_aging() from public, anon, authenticated;

-- SKUs whose stock is not fully covered by a stock-addition record (targets extra history pulls).
create or replace view public.v_stock_no_inward with (security_invoker = true) as
select o.sku
from public.v_stock_on_hand o
left join (select sku, sum(qty) as qty from public.v_fresh_inwards group by sku) f using (sku)
where o.on_hand > coalesce(f.qty, 0);

-- FIFO layers: the units still on hand are assumed to be the most recently added ones, so on-hand is
-- allocated to stock additions newest first. Units with no addition on record are dated by the SKU's
-- first sale, then by the year in its style code, so nothing is left without a year.
create or replace view public.v_stock_aging_layers with (security_invoker = true) as
with inw as (
  select f.sku, f.inward_date, f.qty,
         sum(f.qty) over (partition by f.sku order by f.created_at desc, f.id desc) as cum
  from public.v_fresh_inwards f
),
alloc as (
  select o.sku, i.inward_date,
         greatest(0, least(i.qty, o.on_hand - (i.cum - i.qty))) as qty
  from public.v_stock_on_hand o
  join inw i using (sku)
),
layers as (
  select sku, inward_date, qty, 'Stock added'::text as date_source from alloc where qty > 0
  union all
  select o.sku,
         coalesce(fs.first_sale,
                  case when substring(o.sku from '^[A-Z]+(\d{2})\d{2}') between '15' and to_char(now(), 'YY')
                       then make_date(2000 + substring(o.sku from '^[A-Z]+(\d{2})\d{2}')::int, 1, 1) end),
         o.on_hand - coalesce(a.qty, 0),
         case when fs.first_sale is not null then 'First sale'
              when substring(o.sku from '^[A-Z]+(\d{2})\d{2}') between '15' and to_char(now(), 'YY') then 'Style code year'
              else 'None' end
  from public.v_stock_on_hand o
  left join (select sku, sum(qty) as qty from alloc group by sku) a using (sku)
  left join public.mv_sku_first_sale fs on fs.sku = o.sku
  where o.on_hand - coalesce(a.qty, 0) > 0
)
select l.sku, p.style_code, p.product_name, p.colour, p.size,
       coalesce(p.category, 'Uncategorised') as product_type,
       p.mrp,
       l.inward_date,
       case
         when l.inward_date is null then 'No inward record'
         when l.inward_date < date '2024-01-01' then 'Upto 2023'
         else extract(year from l.inward_date)::int::text
       end as age_bucket,
       l.qty,
       l.qty * coalesce(p.mrp, 0) as mrp_value,
       l.date_source
from layers l
left join public.products p on p.sku = l.sku
-- non-merchandise product types kept out of the report
where lower(coalesce(p.category, '')) not in ('bom set', 'box', 'carry bag', 'fabric', 'perfume');

-- The report: product type x year bucket, quantity and MRP value.
create or replace view public.v_stock_aging_summary with (security_invoker = true) as
select product_type, age_bucket, sum(qty) as available_qty, sum(mrp_value) as mrp_value
from public.v_stock_aging_layers
group by product_type, age_bucket;

-- The calculation is too heavy to run on every page load (it hit the API statement timeout), so the layers
-- are stored and refreshed: pg_cron job `refresh-stock-aging` at :14 and :44, and after each daily inward sync.
create materialized view if not exists public.mv_stock_aging_layers as
select * from public.v_stock_aging_layers;
create index if not exists mv_stock_aging_layers_type_bucket on public.mv_stock_aging_layers (product_type, age_bucket);
revoke all on public.mv_stock_aging_layers from anon, authenticated;
-- select cron.schedule('refresh-stock-aging', '14,44 * * * *', $c$set statement_timeout = '10min'; select public.refresh_stock_aging();$c$);

-- Dashboard read access (sales/index.html, Aging tab). `stock_adjustments` stays private;
-- these functions expose aggregates only. Applied as migration `stock_aging_dashboard_rpcs`.
create or replace function public.dashboard_stock_aging()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'summary', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
        select product_type, age_bucket, sum(qty) as qty, round(sum(mrp_value)) as mrp_value
        from mv_stock_aging_layers group by 1, 2) t),
    -- stock sitting in INTRANSIT bins; it is part of the totals above, shown separately for visibility
    'intransit', (select row_to_json(t) from (
        select coalesce(sum(i.qty), 0) as qty, coalesce(round(sum(i.qty * coalesce(p.mrp, 0))), 0) as mrp_value, count(distinct i.sku) as skus
        from inventory i left join products p on p.sku = i.sku
        where i.qty > 0 and upper(i.bin) = 'INTRANSIT' and i.location_code not in ('OPT', 'BNG', 'MRS')
          and lower(coalesce(p.category, '')) not in ('bom set', 'box', 'carry bag', 'fabric', 'perfume')) t),
    -- transfer orders dispatched and not yet received (see v_sto_in_transit below)
    'transfers', (select row_to_json(t) from (
        select coalesce(sum(v.qty), 0) as qty, coalesce(round(sum(v.qty * coalesce(p.mrp, 0))), 0) as mrp_value,
               count(distinct v.order_no) as orders,
               coalesce(max(floor(extract(epoch from now() - v.dispatched_at) / 86400)), 0)::int as oldest_days,
               (select max(synced_at) from sto_orders) as as_of
        from v_sto_in_transit v left join products p on p.sku = v.sku
        where lower(coalesce(p.category, '')) not in ('bom set', 'box', 'carry bag', 'fabric', 'perfume')) t),
    'backfill', (select row_to_json(s) from (select status, detail, last_run from sync_state where job = 'stock_adjustments_backfill') s),
    'incremental', (select row_to_json(s) from (select status, last_run from sync_state where job = 'stock_adjustments') s),
    'stock_as_of', (select max(synced_at) from inventory),
    'generated_at', now())
$$;

create or replace function public.dashboard_stock_aging_detail(p_type text, p_bucket text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
    select style_code, product_name, colour, product_type, age_bucket,
           sum(qty) as qty, round(sum(mrp_value)) as mrp_value,
           count(distinct sku) as skus, min(inward_date) as oldest_inward, max(inward_date) as latest_inward
    from mv_stock_aging_layers
    where (p_type is null or product_type = p_type) and (p_bucket is null or age_bucket = p_bucket)
    group by 1, 2, 3, 4, 5
    order by sum(mrp_value) desc
    limit 5000) t
$$;

create or replace function public.dashboard_stock_intransit()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
    select p.style_code, p.product_name, p.colour, coalesce(p.category, 'Uncategorised') as product_type,
           string_agg(distinct i.location_code, ', ') as location,
           sum(i.qty) as qty, round(sum(i.qty * coalesce(p.mrp, 0))) as mrp_value, count(distinct i.sku) as skus
    from inventory i left join products p on p.sku = i.sku
    where i.qty > 0 and upper(i.bin) = 'INTRANSIT' and i.location_code not in ('OPT', 'BNG', 'MRS')
      and lower(coalesce(p.category, '')) not in ('bom set', 'box', 'carry bag', 'fabric', 'perfume')
    group by 1, 2, 3, 4
    order by sum(i.qty) desc) t
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Stock in transit: transfer orders (STO) dispatched but not yet received.
-- sto_orders / sto_lines are filled by scripts/sync-sales-vinculum.mjs from the same order pull as sales
-- (backfill: .github/workflows/backfill-sto.yml). Applied as migrations `sto_orders` and `sto_in_transit`;
-- dashboard_stock_aging() above also returns a `transfers` summary built from v_sto_in_transit.
create table if not exists public.sto_orders (
  order_no text primary key, order_date timestamptz, status text, from_code text, to_code text, to_name text,
  raw jsonb, synced_at timestamptz not null default now());
create table if not exists public.sto_lines (
  order_no text not null references public.sto_orders(order_no) on delete cascade, sku text not null,
  line_key text not null default '1', qty numeric not null default 0, line_status text, raw jsonb,
  synced_at timestamptz not null default now(), primary key (order_no, sku, line_key));
create index if not exists sto_lines_sku_idx on public.sto_lines (sku);
alter table public.sto_orders enable row level security;
alter table public.sto_lines enable row level security;

-- Per-shipment detail from Vinculum v2/order/stoDetails (scripts/sync-sto-details.mjs, hourly):
-- real from/to sites, the actual ship date and the quantity received at the destination.
-- Applied as migrations `sto_details` and `sto_in_transit_from_details`.
create table if not exists public.sto_details (
  order_no text not null, delivery_no text not null default '', sku text not null, line_key text not null default '1',
  from_code text, from_name text, to_code text, to_name text, order_status text, sto_type text, delivery_status text,
  ship_date timestamptz, pick_date timestamptz, pack_date timestamptz, transporter text, tracking_no text,
  inbound_codes text[], order_qty numeric, shipped_qty numeric, delivery_qty numeric, received_qty numeric,
  line_status text, raw jsonb, synced_at timestamptz not null default now(),
  primary key (order_no, delivery_no, sku, line_key));
create index if not exists sto_details_sku_idx on public.sto_details (sku);
alter table public.sto_details enable row level security;
create table if not exists public.sto_detail_fetch (
  order_no text primary key, order_updated text, fetched_at timestamptz not null default now());
alter table public.sto_detail_fetch enable row level security;

-- Shipped transfers whose detail is missing, out of date (the order changed) or older than 6 hours.
create or replace view public.v_sto_details_todo with (security_invoker = true) as
select o.order_no, (f.order_no is null) as never_fetched
from public.sto_orders o
left join public.sto_detail_fetch f using (order_no)
where o.status ilike '%shipped%'
  and (f.order_no is null
       or f.order_updated is distinct from (o.raw->>'updatedDate')
       or f.fetched_at < now() - interval '6 hours');

-- In transit = shipped from the source and not yet received at the destination.
-- Exact where stoDetails has been fetched (ship date, shipped minus received per shipment);
-- for a shipped transfer not looked up yet, falls back to the order pull (last update as the dispatch date).
create or replace view public.v_sto_in_transit with (security_invoker = true) as
select d.order_no, d.delivery_no, d.from_code, d.to_code,
       d.ship_date as dispatched_at,
       d.sku,
       coalesce(d.delivery_qty, d.shipped_qty, 0) - coalesce(d.received_qty, 0) as qty,
       d.transporter, d.tracking_no,
       true as exact
from public.sto_details d
join public.sto_orders o using (order_no)
where o.status ilike '%shipped%'
  and d.ship_date is not null
  and coalesce(d.delivery_qty, d.shipped_qty, 0) - coalesce(d.received_qty, 0) > 0
union all
select o.order_no, ''::text, upper(o.raw->>'orderLocation'), upper(o.raw->>'customerCode'),
       (to_timestamp(o.raw->>'updatedDate', 'DD/MM/YYYY HH24:MI:SS')::timestamp at time zone 'Asia/Kolkata'),
       l.sku,
       case when coalesce((l.raw->>'shippedQty')::numeric, 0) > 0 then (l.raw->>'shippedQty')::numeric else l.qty end,
       null::text, null::text,
       false
from public.sto_orders o
join public.sto_lines l using (order_no)
where o.status ilike '%shipped%'
  and l.line_status ilike '%shipped%'
  and not exists (select 1 from public.sto_detail_fetch f where f.order_no = o.order_no);

create or replace function public.dashboard_stock_transfers()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
    select v.order_no, v.from_code, coalesce(lf.display_name, v.from_code) as from_name,
           v.to_code, coalesce(lt.display_name, v.to_code) as to_name,
           (v.dispatched_at at time zone 'Asia/Kolkata')::date as dispatched_on,
           greatest(0, floor(extract(epoch from now() - v.dispatched_at) / 86400))::int as days_in_transit,
           p.style_code, p.product_name, p.colour, coalesce(p.category, 'Uncategorised') as product_type,
           max(v.transporter) as transporter, max(v.tracking_no) as tracking_no,
           sum(v.qty) as qty, round(sum(v.qty * coalesce(p.mrp, 0))) as mrp_value, count(distinct v.sku) as skus
    from v_sto_in_transit v
    left join products p on p.sku = v.sku
    left join locations lf on lf.code = v.from_code
    left join locations lt on lt.code = v.to_code
    where lower(coalesce(p.category, '')) not in ('bom set', 'box', 'carry bag', 'fabric', 'perfume')
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    order by 7 desc, sum(v.qty) desc
    limit 20000) t
$$;
