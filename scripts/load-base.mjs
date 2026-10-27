// One-shot base load from Vinculum panel exports committed under data/:
//   data/products.csv.gz        sku,style_code,product_name,colour,size,mrp,category
//   data/inventory-base.csv.gz  sku,location_code,bin,qty   (all locations, bin-level)
// Replaces the whole inventory table with the export; products are upserted.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const log = (...a) => console.log(new Date().toISOString(), ...a);

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(",");
  return lines.map(l => {
    const cells = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ",") { cells.push(cur); cur = ""; } else cur += c;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] === "" ? null : cells[i]]));
  });
}
async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 2000) {
    await sb(`${table}?on_conflict=${onConflict}`, { method: "POST", body: rows.slice(i, i + 2000), prefer: "resolution=merge-duplicates,return=minimal" });
    if ((i / 2000) % 5 === 0) log(`${table}: ${Math.min(i + 2000, rows.length)}/${rows.length}`);
  }
}

const runStart = new Date().toISOString();
const [run] = await sb("sync_runs", { method: "POST", body: { started_at: runStart, status: "running", progress: "base load from data/ exports" }, prefer: "return=representation" });
try {
  const knownLocs = new Set((await sb("locations?select=code")).map(l => l.code));
  const products = parseCsv(gunzipSync(readFileSync("data/products.csv.gz")).toString("utf8"))
    .map(p => ({ ...p, mrp: p.mrp ? Number(p.mrp) : null, updated_at: runStart }));
  log(`products: ${products.length}`);
  await upsert("products", products, "sku");

  const inv = parseCsv(gunzipSync(readFileSync("data/inventory-base.csv.gz")).toString("utf8"))
    .filter(r => knownLocs.has(r.location_code))
    .map(r => ({ sku: r.sku, location_code: r.location_code, bin: r.bin || "", qty: Number(r.qty), synced_at: runStart }));
  log(`inventory: ${inv.length}`);
  await upsert("inventory", inv, "sku,location_code,bin");
  await sb(`inventory?synced_at=lt.${encodeURIComponent(runStart)}`, { method: "DELETE", prefer: "return=minimal" });
  await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "ok", finished_at: new Date().toISOString(), rows_upserted: inv.length, progress: `base load: ${products.length} products, ${inv.length} inventory rows` } });
  log("done");
} catch (e) {
  log("FAILED", e.message);
  await sb(`sync_runs?id=eq.${run.id}`, { method: "PATCH", body: { status: "error", finished_at: new Date().toISOString(), error: String(e.message).slice(0, 2000) } }).catch(() => {});
  process.exit(1);
}
