-- Stock aging: age on-hand stock from its replenishment (inward) date, not the SKU creation date.
-- Applied to the Supabase project as migration `stock_aging`; kept here for reference.
--
-- Source of inward dates: Vinculum v3/stock/adjustmentDetail at MNW, loaded by scripts/sync-inwards.mjs.
-- Production stock is received only at MNW, as a manual positive adjustment into the JIT bin
-- (remark "MEMO IS CREATING") or, occasionally, straight into a rack bin with a "MEMO ..." remark.
-- Everything else (OUTBOND add-backs, returns, alterations, store transfers) is not a fresh inward.

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

-- Fresh production inwards: the rule lives here, so it can change without re-pulling history.
create or replace view public.v_fresh_inwards with (security_invoker = true) as
select id, sku, bin, qty, remarks, created_by, created_at,
       (created_at at time zone 'Asia/Kolkata')::date as inward_date
from public.stock_adjustments
where location_code = 'MNW'
  and qty > 0
  and (upper(bin) = 'JIT' or remarks ilike '%MEMO%');

-- Physical on-hand per SKU: every warehouse and store, INTRANSIT included;
-- virtual bins (VIRTUAL, VIRTUAL-PRODUCTION, VIR-STORE), OPT and the closed stores are excluded.
create or replace view public.v_stock_on_hand with (security_invoker = true) as
select i.sku, sum(i.qty)::numeric as on_hand
from public.inventory i
where i.qty > 0
  and upper(i.bin) not like 'VIR%'
  and i.location_code not in ('OPT', 'BNG', 'MRS')
group by i.sku;

-- FIFO layers: the units still on hand are assumed to be the most recently received ones,
-- so on-hand is allocated to inwards newest first. Units with no inward on record fall in
-- the 'No inward record' bucket.
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
  select sku, inward_date, qty from alloc where qty > 0
  union all
  select o.sku, null::date, o.on_hand - coalesce(a.qty, 0)
  from public.v_stock_on_hand o
  left join (select sku, sum(qty) as qty from alloc group by sku) a using (sku)
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
       l.qty * coalesce(p.mrp, 0) as mrp_value
from layers l
left join public.products p on p.sku = l.sku;

-- The report: product type x year bucket, quantity and MRP value.
create or replace view public.v_stock_aging_summary with (security_invoker = true) as
select product_type, age_bucket, sum(qty) as available_qty, sum(mrp_value) as mrp_value
from public.v_stock_aging_layers
group by product_type, age_bucket;
