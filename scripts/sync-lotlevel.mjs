// Hourly bin-level stock refresh from Vinculum v1/sku/getlotlevelinventory, all locations.
// Pulls rows whose lot changed in the last LOOKBACK_DAYS (default 2) and upserts (sku, location, bin) = sum(qty - committed).
// Rows for a (sku, location) pair seen in the pull replace that pair's existing rows (so bins that emptied disappear).
// Env: VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; optional LOOKBACK_DAYS, LOC_CODES (comma list; blank = all)

const VIN_BASE = process.env.VINCULUM_BASE || "https://mulmul.vineretail.com/RestWS/api/eretail";
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["VINCULUM_API_KEY", "VINCULUM_API_OWNER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;

async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 1000)
    await sb(`${table}?on_conflict=${onConflict}`, { method: "POST", body: rows.slice(i, i + 1000), prefer: "resolution=merge-duplicates,return=minimal" });
}
let lastCall = 0;
async function vin(body, attempt = 1) {
  const wait = lastCall + 700 - Date.now(); if (wait > 0) await sleep(wait); lastCall = Date.now();
  let r;
  try {
    r = await fetch(`${VIN_BASE}/v1/sku/getlotlevelinventory`, { method: "POST", signal: AbortSignal.timeout(45000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY, RequestBody: JSON.stringify(body) }).toString() });
  } catch (e) { if (attempt < 4) { log(`network ${e.name}; retry ${attempt}`); await sleep(5000 * attempt); return vin(body, attempt + 1); } throw e; }
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = null; }
  if (d && Number(d.responseCode) === 1105) return { response: [], hasMore: false };
  if (d && Number(d.responseCode) === 13) { if (attempt > 6) throw new Error("quota exceeded"); log("quota hit; waiting 65s"); await sleep(65000); return vin(body, attempt + 1); }
  if (!r.ok || !d || Number(d.responseCode) !== 0) {
    if (attempt < 4 && (r.status >= 500 || !d)) { await sleep(3000 * attempt); return vin(body, attempt + 1); }
    throw new Error(`lotlevel: HTTP ${r.status} ${t.slice(0, 300)}`);
  }
  return d;
}

const runStart = new Date().toISOString();
const [run] = await sb("sync_runs", { method: "POST", body: { started_at: runStart, status: "running", progress: "lotlevel: starting" }, prefer: "return=representation" });
const progress = async m => { log(m); await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { progress: m.slice(0, 500) } }).catch(() => {}); };
try {
  const knownLocs = new Set((await sb("locations?select=code")).map(l => l.code));
  const days = Number(process.env.LOOKBACK_DAYS || 2);
  const allLocs = await sb("locations?select=code,type&is_active=eq.true&order=sort_order,code");
  const locs = (process.env.LOC_CODES || "").split(",").map(s => s.trim()).filter(Boolean).length
    ? process.env.LOC_CODES.split(",").map(s => s.trim()).filter(Boolean)
    : allLocs.filter(l => l.type === "Store").map(l => l.code);   // stores only; warehouses come from the WH sync
  const now = new Date(), from = new Date(now - days * 86400e3);
  const agg = new Map();   // sku|loc|bin -> qty
  const pairs = new Set(); // sku|loc seen
  const binsSeen = {}; let pages = 0, rawRows = 0, locsDone = 0; const failed = [];
  for (const loc of locs) {
    try {
    for (let page = 1; ; page++) {
      const d = await vin({ skuCodes: [], buckets: ["good"], fromDate: fmt(from), toDate: fmt(now), pageNumber: String(page), locCode: loc, extLocCode: loc });
      pages++;
      for (const x of d.response || []) {
        rawRows++;
        const bin = String(x.binCode || "").trim().toUpperCase();
        binsSeen[bin] = (binsSeen[bin] || 0) + 1;
        const lc = String(x.location || "").trim();
        if (!knownLocs.has(lc) || lc === "OPT") continue;
        const sku = String(x.skuCode).trim().toUpperCase();
        const qty = Math.max(0, Math.round(Number(x.qty || 0) - Number(x.committedQty || 0)));
        pairs.add(`${sku}|${lc}`);
        const k = `${sku}|${lc}|${bin}`;
        agg.set(k, (agg.get(k) || 0) + qty);
      }
      if (!d.hasMore || !(d.response || []).length) break;
      if (page > 400) throw new Error(`pagination runaway at ${loc}`);
    }
    locsDone++;
    await progress(`lotlevel: ${locsDone}/${locs.length} locations (${loc}), ${pages} pages, ${rawRows} rows`);
    } catch (e) { failed.push(`${loc}: ${String(e.message).slice(0, 80)}`); log(`location ${loc} failed: ${e.message}`); }
  }
  if (failed.length === locs.length) throw new Error(`all locations failed: ${failed[0]}`);
  await progress(`lotlevel: fetched ${pages} pages, ${rawRows} rows, ${pairs.size} sku-locations; bins ${JSON.stringify(binsSeen).slice(0, 300)}`);

  // replace all rows for seen (sku, location) pairs: delete old bins, insert current
  const byLoc = new Map();
  for (const p of pairs) { const [sku, lc] = p.split("|"); if (!byLoc.has(lc)) byLoc.set(lc, []); byLoc.get(lc).push(sku); }
  for (const [lc, skus] of byLoc) for (let i = 0; i < skus.length; i += 300) {
    const chunk = skus.slice(i, i + 300);
    await sb(`inventory?location_code=eq.${lc}&sku=in.(${chunk.map(s => `"${s}"`).join(",")})`, { method: "DELETE", prefer: "return=minimal" });
  }
  const rows = [...agg.entries()].filter(([, q]) => q > 0).map(([k, qty]) => { const [sku, location_code, bin] = k.split("|"); return { sku, location_code, bin, qty, synced_at: runStart }; });
  await upsert("inventory", rows, "sku,location_code,bin");

  // product stubs for unknown SKUs (names come from skuDetail in the other sync or the SKU master)
  const skus = [...new Set(rows.map(r => r.sku))]; const have = new Set();
  for (let i = 0; i < skus.length; i += 500) { const got = await sb(`products?select=sku&sku=in.(${skus.slice(i, i + 500).map(s => `"${s}"`).join(",")})`); got.forEach(p => have.add(p.sku)); }
  const stubs = skus.filter(s => !have.has(s)).map(sku => ({ sku, style_code: (/^([A-Z]+\d+)/.exec(sku) || [, sku])[1], updated_at: new Date(0).toISOString() }));
  if (stubs.length) await upsert("products", stubs, "sku");

  await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "ok", finished_at: new Date().toISOString(), rows_upserted: rows.length, progress: `lotlevel ok: ${rows.length} rows across ${byLoc.size} locations (${pairs.size} sku-locations, ${days}d lookback, ${pages} pages)${failed.length ? "; FAILED " + failed.join(" | ") : ""}` } });
  log("done");
} catch (e) {
  log("FAILED", e.message);
  await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "error", finished_at: new Date().toISOString(), error: String(e.message).slice(0, 2000) } }).catch(() => {});
  process.exit(1);
}
