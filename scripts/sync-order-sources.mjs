// Shopify -> Supabase `order_sources`: where each online order came from (web / app / draft order),
// plus the order note and staff timeline comments, so the dashboard can split Online into
// Online / App / Stylist / Store Draft (rules live in SQL: order_bucket()).
//
// Modes:
//   default        orders created in the last LOOKBACK_DAYS (7) — hourly
//   BACKFILL=1     walk back from the oldest order we hold to BACKFILL_FROM (YYYY-MM-DD), time-budgeted, resumable
//
// Env: SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const { SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["SHOPIFY_STORE", "SHOPIFY_ACCESS_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const setState = patch => sb("sync_state?on_conflict=job", { method: "POST", body: [{ job: "order_sources", ...patch }], prefer: "resolution=merge-duplicates,return=minimal" });

async function gql(query, variables, attempt = 1) {
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-07/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  if (r.status === 429 || r.status >= 500) { if (attempt > 6) throw new Error(`Shopify ${r.status}`); await sleep(2000 * attempt); return gql(query, variables, attempt + 1); }
  const j = await r.json();
  if (j.errors?.some(e => /throttled/i.test(e.message))) { await sleep(3000); return gql(query, variables, attempt + 1); }
  if (j.errors?.length && !j.data) throw new Error(`Shopify GraphQL: ${JSON.stringify(j.errors).slice(0, 300)}`);
  const cost = j.extensions?.cost; if (cost && cost.throttleStatus.currentlyAvailable < cost.requestedQueryCost * 2) await sleep(1500);
  return j.data;
}

const Q = `query($first:Int!,$after:String,$q:String){ orders(first:$first, after:$after, sortKey:CREATED_AT, reverse:true, query:$q){
  pageInfo{hasNextPage endCursor}
  nodes{ name createdAt cancelledAt sourceName tags note app{ name } events(first:30){ nodes{ __typename message } } } } }`;

function row(o) {
  return {
    order_no: o.name.replace(/^#/, "").trim().toUpperCase(), shop: SHOPIFY_STORE, created_at: o.createdAt,
    source_name: o.sourceName || null, app_name: o.app?.name || null, tags: o.tags || [], note: o.note || null,
    comments: (o.events?.nodes || []).filter(e => e.__typename === "CommentEvent").map(e => String(e.message || "").replace(/<[^>]+>/g, "").trim()).filter(Boolean),
    cancelled: !!o.cancelledAt, synced_at: new Date().toISOString(),
  };
}
async function upsert(rows) {
  for (let i = 0; i < rows.length; i += 200) await sb("order_sources?on_conflict=order_no", { method: "POST", body: rows.slice(i, i + 200), prefer: "resolution=merge-duplicates,return=minimal" });
}
async function pull(q, budgetMs, onPage) {
  const t0 = Date.now(); let after = null, total = 0, pages = 0;
  while (true) {
    const d = await gql(Q, { first: 50, after, q });
    const nodes = d.orders.nodes; if (!nodes.length) break;
    const rows = nodes.map(row); await upsert(rows); total += rows.length; pages++;
    if (onPage) await onPage(rows, total, pages);
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
    if (Date.now() - t0 > budgetMs) return { total, done: false, last: rows[rows.length - 1].created_at };
  }
  return { total, done: true };
}

try {
  if (process.env.BACKFILL === "1") {
    const stop = process.env.BACKFILL_FROM || "2026-01-01";
    const budget = Number(process.env.BACKFILL_BUDGET_MIN || 300) * 60000;
    const [st] = await sb("sync_state?job=eq.order_sources_backfill&select=*");
    if (st?.status === "done") { log("backfill already complete"); process.exit(0); }
    const bset = patch => sb("sync_state?on_conflict=job", { method: "POST", body: [{ job: "order_sources_backfill", ...patch }], prefer: "resolution=merge-duplicates,return=minimal" });
    const cursorTo = st?.watermark || new Date().toISOString();
    await bset({ status: "running", last_run: new Date().toISOString(), detail: `resuming before ${cursorTo}` });
    const res = await pull(`created_at:>=${stop} AND created_at:<${cursorTo}`, budget, async (rows, total, pages) => { if (pages % 10 === 0) await bset({ watermark: rows[rows.length - 1].created_at, detail: `reached ${rows[rows.length - 1].created_at}; ${total} orders this run` }); });
    await bset({ status: res.done ? "done" : "paused", last_run: new Date().toISOString(), ...(res.last ? { watermark: res.last } : {}), detail: `${res.done ? "complete" : "budget reached"}; ${res.total} orders this run` });
    log(res.done ? "BACKFILL COMPLETE" : "budget reached");
  } else {
    const days = Number(process.env.LOOKBACK_DAYS || 7);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    await setState({ status: "running", last_run: new Date().toISOString(), detail: `orders since ${since}` });
    const res = await pull(`created_at:>=${since}`, 50 * 60000);
    await setState({ status: "ok", watermark: new Date().toISOString(), last_run: new Date().toISOString(), detail: `${res.total} orders since ${since}` });
    log(`done: ${res.total} orders`);
  }
} catch (e) {
  log("FAILED", e.message);
  await setState({ status: "error", detail: e.message.slice(0, 800) }).catch(() => {});
  process.exit(1);
}
