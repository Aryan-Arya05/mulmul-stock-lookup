// Probe v1/sku/getlotlevelinventory per location; reports results into sync_runs.progress (status 'probe')
const VIN_BASE = "https://mulmul.vineretail.com/RestWS/api/eretail";
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const owner = process.env.PROBE_OWNER || VINCULUM_API_OWNER;
const out = [];
async function call(loc, skus) {
  const body = { skuCodes: skus, buckets: ["good"], fromDate: "", toDate: "", pageNumber: "", locCode: loc, extLocCode: loc };
  const json = JSON.stringify(body);
  const r = await fetch(`${VIN_BASE}/v1/sku/getlotlevelinventory`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ApiOwner: owner, ApiKey: VINCULUM_API_KEY, RequestBody: json }).toString(),
    signal: AbortSignal.timeout(120000) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = null; }
  const bins = {}; for (const x of (d?.response || [])) bins[x.binCode] = (bins[x.binCode] || 0) + 1;
  return `${loc} skus=${skus.length ? skus.join("|") : "ALL"}: http=${r.status} code=${d?.responseCode} msg=${d?.responseMessage} rows=${d?.response?.length ?? "-"} hasMore=${d?.hasMore} page=${d?.currentPage} bins=${JSON.stringify(bins).slice(0, 200)}`;
}
for (const [loc, skus] of [["MCS", ["WWSKY12MLT"]], ["MCS", []], ["MKM", []], ["MWH", []]]) {
  try { out.push(await call(loc, skus)); } catch (e) { out.push(`${loc}: ERR ${e.message}`); }
  console.log(out[out.length - 1]);
  await new Promise(r => setTimeout(r, 1500));
}
await fetch(`${SUPABASE_URL}/rest/v1/sync_runs`, { method: "POST", headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ status: "probe", finished_at: new Date().toISOString(), progress: `lotlevel owner=${owner}: ` + out.join(" || ") }) });
