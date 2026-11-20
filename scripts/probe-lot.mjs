// Probe: explicit-SKU lookups (lot-level per location + warehouse API) for given SKUs; result written to sync_runs status 'probe'
const VIN_BASE = "https://mulmul.vineretail.com/RestWS/api/eretail";
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const skus = (process.env.PROBE_SKUS || "ROP2603FUXL,RO2603FUXL").split(",").map(s => s.trim()).filter(Boolean);
const locs = (process.env.PROBE_LOCS || "MNW,MWH").split(",").map(s => s.trim()).filter(Boolean);
const out = [];
const hdr = { ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY, OrgId: "MULM" };
async function lot(loc) {
  const body = { skuCodes: skus, buckets: [], fromDate: "", toDate: "", pageNumber: "", locCode: loc, extLocCode: loc };
  const r = await fetch(`${VIN_BASE}/v1/sku/getlotlevelinventory`, { method: "POST", signal: AbortSignal.timeout(170000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...hdr },
    body: new URLSearchParams({ ...hdr, RequestBody: JSON.stringify(body) }).toString() });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = null; }
  return `LOT ${loc}: code=${d?.responseCode} msg=${d?.responseMessage} rows=${JSON.stringify((d?.response || []).map(x => ({ sku: x.skuCode, bin: x.binCode ?? x.bin, bucket: x.invBucket ?? x.bucket, qty: x.qty ?? x.availableQty, lot: x.lotNo, raw: Object.keys(x).join("|") })))} :: ${t.slice(0, 600)}`;
}
async function wh() {
  const to = new Date(), from = new Date(Date.now() - 6 * 864e5);
  const f = d => d.toISOString().slice(0, 10);
  const body = { skuCodes: skus, fromDate: "", toDate: "", pageNumber: "1" };
  const r = await fetch(`${VIN_BASE}/v4/stock/getWhInventory`, { method: "POST", signal: AbortSignal.timeout(170000),
    headers: { "Content-Type": "application/json", Accept: "application/json", ...hdr }, body: JSON.stringify(body) });
  const t = await r.text();
  return `WH(explicit skus): http=${r.status} ${t.slice(0, 1200)}`;
}
for (const l of locs) { try { out.push(await lot(l)); } catch (e) { out.push(`LOT ${l}: ERR ${e.message}`); } console.log(out.at(-1)); await new Promise(r => setTimeout(r, 1500)); }
try { out.push(await wh()); } catch (e) { out.push(`WH: ERR ${e.message}`); } console.log(out.at(-1));
await fetch(`${SUPABASE_URL}/rest/v1/sync_runs`, { method: "POST", headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ status: "probe", finished_at: new Date().toISOString(), progress: ("sku probe " + skus.join(",") + ": " + out.join(" || ")).slice(0, 4000) }) });
