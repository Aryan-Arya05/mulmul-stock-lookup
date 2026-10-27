// Probe Vinculum getWhInventory with explicit location codes; writes a summary into sync_runs.progress
const VIN_BASE = "https://mulmul.vineretail.com/RestWS/api/eretail";
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const fmt = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:00`;
const now = new Date(), from = new Date(now - 6.9 * 86400e3);
const out = [];
for (const loc of (process.env.PROBE_LOCS || "MKM,GGN,JUH,MCS,MNW").split(",")) {
  const body = { skuCodes: [], buckets: [], fromDate: fmt(from), toDate: fmt(now), pageNumber: "1", reqType: "", locCode: loc };
  const r = await fetch(`${VIN_BASE}/v4/stock/getWhInventory`, { method: "POST", headers: { ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY, OrgId: "MULM", "Content-Type": "application/json", RequestBody: JSON.stringify(body) }, body: JSON.stringify(body) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = null; }
  const locs = {}; for (const x of (d?.response || [])) locs[x.location] = (locs[x.location] || 0) + 1;
  out.push(`${loc}: code=${d?.responseCode} msg=${d?.responseMessage} rows=${d?.response?.length ?? "-"} hasMore=${d?.hasMore} locs=${JSON.stringify(locs)} sample=${JSON.stringify((d?.response||[])[0]||null)}`);
  console.log(out[out.length - 1]);
  await new Promise(r => setTimeout(r, 1500));
}
await fetch(`${SUPABASE_URL}/rest/v1/sync_runs`, { method: "POST", headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ status: "probe", finished_at: new Date().toISOString(), progress: out.join(" || ").slice(0, 4000) }) });
