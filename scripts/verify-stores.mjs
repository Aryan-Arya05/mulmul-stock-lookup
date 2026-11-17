// Continuous verifier: for each store (least-recently-verified first) ask Vinculum explicitly for every SKU we believe
// it holds (100 per call). Present → replace its bin rows with current qty; absent → sold out → delete rows.
// Paced (GAP_MS between calls) and time-boxed (BUDGET_MIN) so an hourly run never overlaps the next; on Vinculum
// quota code 13 it waits and continues. Progress persists in verify_state so the next run picks up where this stopped.
// Env: VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; optional GAP_MS (3000), BUDGET_MIN (52), CHUNK (100)
const VIN_BASE = process.env.VINCULUM_BASE || "https://mulmul.vineretail.com/RestWS/api/eretail";
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["VINCULUM_API_KEY", "VINCULUM_API_OWNER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
const GAP_MS = Number(process.env.GAP_MS || 1200), BUDGET_MS = Number(process.env.BUDGET_MIN || 52) * 60000, CHUNK = Number(process.env.CHUNK || 20);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();

async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
let lastCall = 0, quotaWaits = 0;
async function vin(body, attempt = 1) {
  const wait = lastCall + GAP_MS - Date.now(); if (wait > 0) await sleep(wait); lastCall = Date.now();
  let r;
  try {
    r = await fetch(`${VIN_BASE}/v1/sku/getlotlevelinventory`, { method: "POST", signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY, RequestBody: JSON.stringify(body) }).toString() });
  } catch (e) { if (attempt < 3) { log(`network ${e.name}; retry ${attempt}`); await sleep(5000 * attempt); return vin(body, attempt + 1); } throw e; }
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = null; }
  if (d && [1105, 9].includes(Number(d.responseCode))) return { response: [] };           // No Record Found = all sold out
  if (d && Number(d.responseCode) === 13) { quotaWaits++; if (attempt > 8) throw new Error("quota: gave up"); log("quota hit; waiting 65s"); await sleep(65000); return vin(body, attempt + 1); }
  if (!r.ok || !d || Number(d.responseCode) !== 0) { if (attempt < 3 && (r.status >= 500 || !d)) { await sleep(3000 * attempt); return vin(body, attempt + 1); } throw new Error(`lotlevel: HTTP ${r.status} ${t.slice(0, 200)}`); }
  return d;
}

const runStart = new Date().toISOString();
const [run] = await sb("sync_runs", { method: "POST", body: { started_at: runStart, status: "running", progress: "verify: starting" }, prefer: "return=representation" });
const progress = async m => { log(m); await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { progress: m.slice(0, 500) } }).catch(() => {}); };
let checked = 0, soldOut = 0, calls = 0, storesDone = [];
try {
  const stores = await sb("locations?select=code&type=eq.Store&is_active=eq.true");
  const state = await sb("verify_state?select=location_code,last_verified_at");
  const last = Object.fromEntries(state.map(s => [s.location_code, s.last_verified_at]));
  const order = stores.map(s => s.code).sort((a, b) => (last[a] || "").localeCompare(last[b] || ""));   // never/oldest first
  for (const lc of order) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const held = [];
    for (let off = 0; ; off += 1000) { const p = await sb(`inventory?select=sku&location_code=eq.${lc}&qty=gt.0&order=sku&offset=${off}&limit=1000`); p.forEach(r => held.push(r.sku)); if (p.length < 1000) break; }
    const skus = [...new Set(held)];
    let storeZero = 0;
    for (let i = 0; i < skus.length; i += CHUNK) {
      if (Date.now() - t0 > BUDGET_MS) { await progress(`verify: budget reached mid-${lc} (${i}/${skus.length})`); break; }
      const chunk = skus.slice(i, i + CHUNK);
      const d = await vin({ skuCodes: chunk, buckets: ["good"], fromDate: "", toDate: "", pageNumber: "", locCode: lc, extLocCode: lc });
      calls++;
      const agg = new Map(), seen = new Set();
      for (const x of d.response || []) {
        if (String(x.location || "").trim() !== lc) continue;
        const sku = String(x.skuCode).trim().toUpperCase(), bin = String(x.binCode || "").trim().toUpperCase();
        const qty = Math.max(0, Math.round(Number(x.qty || 0) - Number(x.committedQty || 0)));
        seen.add(sku); const k = `${sku}|${bin}`; agg.set(k, (agg.get(k) || 0) + qty);
      }
      // replace rows for this chunk at this store
      await sb(`inventory?location_code=eq.${lc}&sku=in.(${chunk.map(s => `"${s}"`).join(",")})`, { method: "DELETE", prefer: "return=minimal" });
      const rows = [...agg.entries()].filter(([, q]) => q > 0).map(([k, qty]) => { const [sku, bin] = k.split("|"); return { sku, location_code: lc, bin, qty, synced_at: new Date().toISOString() }; });
      if (rows.length) await sb("inventory?on_conflict=sku,location_code,bin", { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
      const zero = chunk.filter(s => !seen.has(s) || ![...agg.entries()].some(([k, q]) => k.startsWith(s + "|") && q > 0)).length;
      storeZero += zero; soldOut += zero; checked += chunk.length;
    }
    if (Date.now() - t0 <= BUDGET_MS) {
      storesDone.push(lc);
      await sb("verify_state?on_conflict=location_code", { method: "POST", body: [{ location_code: lc, last_verified_at: new Date().toISOString(), held: skus.length, sold_out: storeZero }], prefer: "resolution=merge-duplicates,return=minimal" });
      await progress(`verify: ${storesDone.length} stores done (${lc}: ${skus.length} held, ${storeZero} sold out); ${checked} checked, ${soldOut} sold out, ${calls} calls, ${quotaWaits} quota waits`);
    }
  }
  await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "ok", finished_at: new Date().toISOString(), rows_upserted: checked,
    progress: `verify ok: ${storesDone.length} stores [${storesDone.join(",")}], ${checked} SKU-stores checked, ${soldOut} sold out, ${calls} calls, ${quotaWaits} quota waits, ${Math.round((Date.now() - t0) / 60000)} min` } });
} catch (e) {
  log("FAILED", e.message);
  await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "error", finished_at: new Date().toISOString(), error: String(e.message).slice(0, 1500), progress: `verify failed after ${storesDone.length} stores, ${checked} checked, ${calls} calls` } }).catch(() => {});
  process.exit(1);
}
