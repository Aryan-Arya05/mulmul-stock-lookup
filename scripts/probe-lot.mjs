// Probe v1/sku/getlotlevelinventory per location; reports results into sync_runs.progress (status 'probe')
const VIN_BASE = "https://mulmul.vineretail.com/RestWS/api/eretail";
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const owner = process.env.PROBE_OWNER || VINCULUM_API_OWNER;
const out = [];
const fmt = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:00`;
async function call(loc, skus, days, page = "1") {
  const now = new Date(), from = new Date(now - (days || 0) * 86400e3);
  const body = { skuCodes: skus, buckets: ["good"], fromDate: days ? fmt(from) : "", toDate: days ? fmt(now) : "", pageNumber: days ? page : "", locCode: loc, extLocCode: loc };
  const json = JSON.stringify(body);
  const r = await fetch(`${VIN_BASE}/v1/sku/getlotlevelinventory`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ApiOwner: owner, ApiKey: VINCULUM_API_KEY, RequestBody: json }).toString(),
    signal: AbortSignal.timeout(120000) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = null; }
  const bins = {}; for (const x of (d?.response || [])) bins[x.binCode] = (bins[x.binCode] || 0) + 1;
  return `${loc} skus=${skus.length ? skus.join("|") : "ALL"} days=${days||0} p${page}: http=${r.status} code=${d?.responseCode} msg=${d?.responseMessage} rows=${d?.response?.length ?? "-"} hasMore=${d?.hasMore} page=${d?.currentPage} bins=${JSON.stringify(bins).slice(0, 200)}`;
}
for (const [loc, skus, days, page] of [["MCS", [], 1], ["MCS", [], 7], ["MCS", [], 7, "2"], ["MKM", [], 7], ["MWH", [], 1], ["", [], 1]]) {
  try { out.push(await call(loc, skus, days, page)); } catch (e) { out.push(`${loc}: ERR ${e.message}`); }
  console.log(out[out.length - 1]);
  await new Promise(r => setTimeout(r, 1500));
}
await fetch(`${SUPABASE_URL}/rest/v1/sync_runs`, { method: "POST", headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ status: "probe", finished_at: new Date().toISOString(), progress: `lotlevel owner=${owner}: ` + out.join(" || ") }) });
