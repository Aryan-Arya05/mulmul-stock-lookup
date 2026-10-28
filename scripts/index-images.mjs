// Index Shopify product images for photo search.
// Shopify products -> first image per product -> style_code (via variant SKU in `products`) -> Jina CLIP v2 embedding -> product_images
// Env: SHOPIFY_STORE (e.g. shopmulmul.myshopify.com), SHOPIFY_ACCESS_TOKEN, JINA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: REINDEX_ALL=1 (re-embed everything), MAX_PRODUCTS=n

const { SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, JINA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const log = (...a) => console.log(new Date().toISOString(), ...a);
async function report(status, msg) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/sync_runs`, { method: "POST", headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status, finished_at: new Date().toISOString(), progress: `image index: ${msg}`.slice(0, 2000) }) }).catch(() => {});
}
const missing = ["SHOPIFY_STORE", "SHOPIFY_ACCESS_TOKEN", "JINA_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(k => !process.env[k]);
if (missing.length) { await report("index-error", `missing env ${missing.join(",")}`); console.error("Missing env", missing); process.exit(1); }
await report("index-start", "env ok");
try { await main(); } catch (e) { await report("index-error", String(e?.stack || e).slice(0, 1500)); console.error(e); process.exit(1); }
async function main() {
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function shopify(query, variables) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-07/graphql.json`, {
      method: "POST", headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { errors: text }; }
    if (Array.isArray(j.errors) && j.errors.some(e => e.extensions?.code === "THROTTLED") && attempt < 6) { await sleep(2000 * attempt); continue; }
    if (j.errors || !r.ok) throw new Error(`Shopify HTTP ${r.status}: ${JSON.stringify(j.errors ?? text).slice(0, 400)}`);
    return j.data;
  }
}
async function jinaEmbed(items) {   // items: [{image: url}] -> [vector]
  for (let attempt = 1; ; attempt++) {
    const r = await fetch("https://api.jina.ai/v1/embeddings", {
      method: "POST", headers: { Authorization: `Bearer ${JINA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jina-clip-v2", dimensions: 1024, normalized: true, input: items }),
    });
    if (r.status === 429 && attempt < 8) { log(`jina 429 (rate limit), waiting 65s`); await sleep(65000); continue; }
    if (r.status >= 500 && attempt < 6) { log(`jina ${r.status}, retry ${attempt}`); await sleep(3000 * attempt); continue; }
    if (!r.ok) throw new Error(`Jina ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    return j.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  }
}

// 1. product master: sku -> style_code
log("loading sku→style map");
const skuStyle = new Map();
for (let off = 0; ; off += 10000) {
  const rows = await sb(`products?select=sku,style_code&offset=${off}&limit=10000`);
  rows.forEach(p => skuStyle.set(p.sku, p.style_code));
  if (rows.length < 10000) break;
}
const already = new Set(process.env.REINDEX_ALL ? [] : (await sb("product_images?select=style_code,embedding&embedding=not.is.null&limit=100000")).map(r => r.style_code));
log(`known skus ${skuStyle.size}; already indexed styles ${already.size}`);

// 2. walk Shopify products
const Q = `query($after:String){ products(first:100, after:$after, query:"status:active", sortKey:UPDATED_AT, reverse:true){
  pageInfo{hasNextPage endCursor}
  edges{ node{ id title featuredMedia{ preview{ image{ url } } } variants(first:5){ edges{ node{ sku } } } } } } }`;
const todo = new Map(); let after = null, seen = 0;
const max = Number(process.env.MAX_PRODUCTS || 100000);
while (seen < max) {
  const d = await shopify(Q, { after });
  for (const { node } of d.products.edges) {
    seen++;
    const url = node.featuredMedia?.preview?.image?.url; if (!url) continue;
    const skus = node.variants.edges.map(e => (e.node.sku || "").trim().toUpperCase()).filter(Boolean);
    let style = null;
    for (const s of skus) { if (skuStyle.has(s)) { style = skuStyle.get(s); break; } }
    if (!style && skus[0]) { const m = /^([A-Z]+\d+)/.exec(skus[0]); style = m ? m[1] : null; }
    if (!style || already.has(style) || todo.has(style)) continue;
    const base = url.split("?")[0];
    const sized = n => base.replace(/(\.[a-z]+)$/i, `_${n}x$1`);
    todo.set(style, { style_code: style, shopify_product_id: node.id, title: node.title, image_url: url, thumb_url: sized(400), embed_url: sized(512) });
  }
  if (!d.products.pageInfo.hasNextPage) break;
  after = d.products.pageInfo.endCursor;
}
log(`shopify products seen ${seen}; styles to index ${todo.size}`);

// 3. embed in batches and upsert
const list = [...todo.values()]; let reportedBatchErr = false, failed = 0; const t0 = Date.now();
const BATCH = Number(process.env.JINA_BATCH || 20), GAP_MS = Number(process.env.JINA_GAP_MS || 4000);   // paid Jina tier: 2M tokens/min
let lastBatchAt = 0;
for (let i = 0; i < list.length; i += BATCH) {
  const batch = list.slice(i, i + BATCH);
  const wait = lastBatchAt + GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
  lastBatchAt = Date.now();
  try {
    const vecs = await jinaEmbed(batch.map(b => ({ image: b.embed_url })));
    await sb("product_images?on_conflict=style_code", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: batch.map(({ embed_url, ...b }, j) => ({ ...b, embedding: JSON.stringify(vecs[j]), indexed_at: new Date().toISOString() })) });
  } catch (e) {
    log(`batch ${i} failed: ${e.message}; falling back to singles`);
    if (!reportedBatchErr) { reportedBatchErr = true; await report("index-warn", `batch failed: ${e.message}`); }
    for (const { embed_url, ...b } of batch) {
      try { const [v] = await jinaEmbed([{ image: embed_url }]); await sb("product_images?on_conflict=style_code", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: [{ ...b, embedding: JSON.stringify(v) }] }); }
      catch (e2) { log(`skip ${b.style_code}: ${e2.message}`); failed++; }
    }
  }
  if ((i / BATCH) % 10 === 0) { log(`indexed ${Math.min(i + BATCH, list.length)}/${list.length}`); await report("index-progress", `${Math.min(i + BATCH, list.length)}/${list.length} styles`); }
}
await report("index-ok", `indexed ${list.length - failed} new styles, ${failed} failed, in ${Math.round((Date.now() - t0) / 60000)} min (shopify products seen ${seen})`);
log("done");
}
