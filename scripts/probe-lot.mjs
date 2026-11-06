// Probe: explicit-SKU lookups at one store with various chunk sizes; report timing + outcome
const VIN_BASE = "https://mulmul.vineretail.com/RestWS/api/eretail";
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const out = [];
const held = (await (await fetch(`${SUPABASE_URL}/rest/v1/inventory?select=sku&location_code=eq.MKM&qty=gt.0&order=sku&limit=400`, { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } })).json()).map(r => r.sku);
async function call(loc, skus) {
  const t0 = Date.now();
  const body = { skuCodes: skus, buckets: ["good"], fromDate: "", toDate: "", pageNumber: "", locCode: loc, extLocCode: loc };
  try {
    const r = await fetch(`${VIN_BASE}/v1/sku/getlotlevelinventory`, { method: "POST", signal: AbortSignal.timeout(170000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY, RequestBody: JSON.stringify(body) }).toString() });
    const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = null; }
    const found = new Set((d?.response || []).map(x => String(x.skuCode).toUpperCase()));
    return `${loc} n=${skus.length}: ${((Date.now()-t0)/1000).toFixed(1)}s http=${r.status} code=${d?.responseCode} msg=${(d?.responseMessage||t).slice(0,60)} rows=${d?.response?.length ?? "-"} hasMore=${d?.hasMore} distinctSkus=${found.size} missing=${skus.filter(s=>!found.has(s)).length}`;
  } catch (e) { return `${loc} n=${skus.length}: ERR ${((Date.now()-t0)/1000).toFixed(1)}s ${e.name} ${e.message}`; }
}
for (const n of [10, 25, 50, 100]) { out.push(await call("MKM", held.slice(0, n))); console.log(out.at(-1)); await new Promise(r => setTimeout(r, 1500)); }
out.push(await call("MKM", ["DD2607DEXS", "DDP2607DEXS", ...held.slice(0, 8)])); console.log(out.at(-1));
await fetch(`${SUPABASE_URL}/rest/v1/sync_runs`, { method: "POST", headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ status: "probe", finished_at: new Date().toISOString(), progress: "chunk probe: " + out.join(" || ") }) });
