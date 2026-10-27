// Vinculum (Vin eRetail) -> Supabase stock sync for the Mulmul store lookup app.
//
// 1. getWhInventory (v4), paginated, all locations -> `inventory` (only bucket "good", qty - committedQty)
// 2. sku/skuDetail (v1) for any SKU not yet in `products` (or stale) -> `products`
// 3. Rows not seen in this run are deleted, so sold-out SKUs disappear instead of going stale.
//
// Env: VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: VINCULUM_BASE, FULL_SKU_REFRESH=1, BACKFILL_DAYS=n (walk back n days in 7-day windows; also purges rows not seen)

const VIN_BASE = process.env.VINCULUM_BASE || "https://mulmul.vineretail.com/RestWS/api/eretail";
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["VINCULUM_API_KEY", "VINCULUM_API_OWNER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])
  if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Vinculum ----------
let lastCall = 0;
const MIN_GAP_MS = Number(process.env.VINCULUM_MIN_GAP_MS || 1000);
async function vin(path, body, attempt = 1) {
  const json = JSON.stringify(body);
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const r = await fetch(`${VIN_BASE}/${path}`, {
    method: "POST",
    headers: {
      ApiOwner: VINCULUM_API_OWNER,
      ApiKey: VINCULUM_API_KEY,
      RequestBody: json,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: json,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (data && Number(data.responseCode) === 1105) return { ...data, response: [], hasMore: false }; // "No Record Found" = empty page
  if (data && Number(data.responseCode) === 13) {                                                   // "API Hit Quota Exceeded"
    if (attempt > 6) throw new Error(`Vinculum ${path}: quota exceeded, gave up after ${attempt - 1} waits`);
    log(`vinculum quota hit on ${path}; waiting 65s (attempt ${attempt})`);
    await sleep(65000);
    return vin(path, body, attempt + 1);
  }
  if (!r.ok || !data || Number(data.responseCode) !== 0) {
    if (attempt < 4 && (r.status >= 500 || r.status === 429 || !data)) {
      log(`vinculum ${path} attempt ${attempt} failed (${r.status}); retrying`);
      await sleep(1500 * attempt);
      return vin(path, body, attempt + 1);
    }
    throw new Error(`Vinculum ${path} failed: HTTP ${r.status} ${text.slice(0, 300)}`);
  }
  return data;
}

const fmt = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;

// getWhInventory only returns SKUs whose stock changed inside a window of <= 7 days,
// and for each such SKU returns every location/bucket with its CURRENT qty (zeros included).
async function fetchWhWindow(from, to, locSeen, buckets) {
  const rows = [];
  for (let page = 1; ; page++) {
    const data = await vin("v4/stock/getWhInventory", {
      skuCodes: [], buckets: [], fromDate: fmt(from), toDate: fmt(to),
      pageNumber: String(page), reqType: "", locCode: "",
    });
    const list = data.response || [];
    for (const r of list) {
      locSeen.set(r.location, (locSeen.get(r.location) || 0) + 1);
      buckets.set(r.bucket, (buckets.get(r.bucket) || 0) + 1);
      if (String(r.bucket).toLowerCase() !== "good") continue;
      const qty = Math.max(0, Math.round(Number(r.qty || 0) - Number(r.committedQty || 0)));
      rows.push({ sku: String(r.skuCode).trim().toUpperCase(), location_code: r.location, bin: "", qty });
    }
    if (!data.hasMore || list.length === 0) break;
    if (page > 2000) throw new Error("pagination runaway");
  }
  return rows;
}

async function fetchWhInventory(backfillDays, onWindow) {
  const locSeen = new Map(), buckets = new Map();
  const merged = new Map();            // later windows overwrite earlier ones
  const now = new Date();
  const totalDays = Math.max(7, backfillDays || 7);
  let from = new Date(now.getTime() - totalDays * 86400e3);
  let windows = 0;
  while (from < now) {
    const to = new Date(Math.min(now.getTime(), from.getTime() + 7 * 86400e3 - 1000));
    const rows = await fetchWhWindow(from, to, locSeen, buckets);
    for (const r of rows) merged.set(`${r.sku}|${r.location_code}|${r.bin}`, r);
    windows++;
    if (onWindow) await onWindow(rows, `window ${windows} ${fmt(from).slice(0,10)}→${fmt(to).slice(0,10)}: ${rows.length} rows (cumulative ${merged.size})`);
    from = new Date(to.getTime() + 1000);
    await sleep(120);
  }
  if (onWindow) await onWindow([], `fetched ${windows} windows; locations ${JSON.stringify(Object.fromEntries(locSeen))}; buckets ${JSON.stringify(Object.fromEntries(buckets))}`, true);
  return [...merged.values()];
}

function parseStyle(sku, parent) {
  if (parent) return String(parent).trim().toUpperCase();
  const m = /^([A-Z]+\d+)/.exec(sku);
  return m ? m[1] : sku;
}
const titleCase = s => String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim();

async function fetchSkuDetails(skus, onProgress) {
  const out = [];
  for (let i = 0; i < skus.length; i += 50) {
    const batch = skus.slice(i, i + 50);
    const data = await vin("v1/sku/skuDetail", {
      skuCodes: batch, date_from: "", date_to: "", pageNumber: "1",
      lastHierarchyCode: "", brand: "", filterBy: "1",
    });
    const list = data.response?.skuList || [];
    for (const s of list) {
      if (String(s.classification).toLowerCase() === "style") continue;
      const sku = String(s.skuCode).trim().toUpperCase();
      out.push({
        sku,
        style_code: parseStyle(sku, s.parentSKU),
        product_name: s.skuName || null,
        colour: s.color ? titleCase(s.color) : null,
        size: s.size && s.size !== "Default|" ? String(s.size).toUpperCase() : null,
        mrp: s.mrp ? Number(s.mrp) : null,
        category: s.categories?.subCategory?.category_desc ? titleCase(s.categories.subCategory.category_desc) : null,
        image_url: s.skuImg1 || s.imageURL || null,
        updated_at: new Date().toISOString(),
      });
    }
    if (onProgress) await onProgress(`skuDetail ${i + batch.length}/${skus.length}`);
    await sleep(150);
  }
  return out;
}

// ---------- Supabase (PostgREST, service role) ----------
async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 1000) {
    await sb(`${table}?on_conflict=${onConflict}`, { method: "POST", body: rows.slice(i, i + 1000), prefer: "resolution=merge-duplicates,return=minimal" });
  }
}

// ---------- main ----------
const runStart = new Date().toISOString();
const [run] = await sb("sync_runs", { method: "POST", body: { started_at: runStart, status: "running" }, prefer: "return=representation" });
let lastProgress = 0;
async function progress(msg, force) {
  log(msg);
  if (!force && Date.now() - lastProgress < 20000) return;
  lastProgress = Date.now();
  await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { progress: msg.slice(0, 500) } }).catch(() => {});
}
try {
  const knownLocs = new Set((await sb("locations?select=code")).map(l => l.code));

  const backfillDays = Number(process.env.BACKFILL_DAYS || 0);
  log(backfillDays ? `BACKFILL ${backfillDays} days` : "incremental: last 7 days");
  const inv = await fetchWhInventory(backfillDays, async (rows, msg, force) => {
    const ok = rows.filter(r => knownLocs.has(r.location_code)).map(r => ({ ...r, synced_at: runStart }));
    if (ok.length) await upsert("inventory", ok, "sku,location_code,bin");
    await progress(msg, force);
  });
  const unknown = [...new Set(inv.filter(r => !knownLocs.has(r.location_code)).map(r => r.location_code))];
  if (unknown.length) log("WARNING: inventory rows for locations not in master, skipped:", unknown);
  const invRows = inv.filter(r => knownLocs.has(r.location_code)).map(r => ({ ...r, synced_at: runStart }));
  log(`inventory rows to write: ${invRows.length}`);

  // product master: fetch SKUs we don't have (or all, on full refresh)
  const skusInStock = [...new Set(invRows.map(r => r.sku))];
  let need = skusInStock;
  if (!process.env.FULL_SKU_REFRESH) {
    const have = new Set();
    for (let i = 0; i < skusInStock.length; i += 500) {
      const chunk = skusInStock.slice(i, i + 500);
      const got = await sb(`products?select=sku&sku=in.(${chunk.map(s => `"${s}"`).join(",")})`);
      got.forEach(p => have.add(p.sku));
    }
    need = skusInStock.filter(s => !have.has(s));
  }
  log(`SKU details to fetch: ${need.length}`);
  if (need.length) {
    const prods = await fetchSkuDetails(need, progress);
    await upsert("products", prods, "sku");
    // SKUs Vinculum returned nothing for: insert a stub so the app can still show the code
    const got = new Set(prods.map(p => p.sku));
    const stubs = need.filter(s => !got.has(s)).map(sku => ({ sku, style_code: parseStyle(sku), updated_at: new Date().toISOString() }));
    if (stubs.length) { log(`stub products: ${stubs.length}`); await upsert("products", stubs, "sku"); }
  }

  // inventory rows were written per window above; final pass guarantees the merged latest state
  await upsert("inventory", invRows, "sku,location_code,bin");
  if (backfillDays) await sb(`inventory?synced_at=lt.${encodeURIComponent(runStart)}`, { method: "DELETE", prefer: "return=minimal" });

  await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "ok", finished_at: new Date().toISOString(), rows_upserted: invRows.length } });
  log("done");
} catch (e) {
  log("FAILED", e.message);
  await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "error", finished_at: new Date().toISOString(), error: String(e.message).slice(0, 2000) } }).catch(() => {});
  process.exit(1);
}
