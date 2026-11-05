// One-off loader: data/archive/sales_<year>.csv.gz (frozen Sale Report exports, 2020 -> 30 Dec 2025) -> sale_lines (source=archive).
// Idempotent: re-running upserts the same keys. Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Optional: YEARS=2024,2025
import { createReadStream } from "node:fs";
import { readdirSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), ...a);

function parseCsvLine(line) {
  const out = []; let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c;
  }
  out.push(f); return out;
}
async function sb(path, body, attempt = 1) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST", headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    if (attempt < 5 && (r.status >= 500 || r.status === 429)) { log(`retry ${attempt}: ${r.status}`); await new Promise(s => setTimeout(s, 3000 * attempt)); return sb(path, body, attempt + 1); }
    throw new Error(`Supabase ${path}: ${r.status} ${t.slice(0, 300)}`);
  }
}

const files = readdirSync("data/archive").filter(f => /^sales_\d{4}\.csv\.gz$/.test(f)).sort();
const years = process.env.YEARS ? process.env.YEARS.split(",") : null;
let grand = 0;
for (const f of files) {
  const year = f.match(/\d{4}/)[0];
  if (years && !years.includes(year)) continue;
  const rl = createInterface({ input: createReadStream(`data/archive/${f}`).pipe(createGunzip()), crlfDelay: Infinity });
  let header = null, batch = [], n = 0;
  const flush = async () => { if (!batch.length) return; await sb("sale_lines?on_conflict=source,order_no,sku,line_key", batch); n += batch.length; batch = []; };
  for await (const line of rl) {
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (!header) { header = cells; continue; }
    const row = {};
    header.forEach((h, i) => { const v = cells[i]; row[h] = v === "" || v === undefined ? null : v; });
    row.qty = Number(row.qty || 1); row.is_sale = row.is_sale === "true"; row.synced_at = new Date().toISOString();
    batch.push(row);
    if (batch.length >= 2000) { await flush(); if (n % 50000 === 0) log(`${year}: ${n} rows`); }
  }
  await flush();
  grand += n;
  log(`${year}: ${n} rows loaded`);
}
await sb("sync_state?on_conflict=job", [{ job: "sales_archive", status: "ok", last_run: new Date().toISOString(), detail: `${grand} archive lines loaded (2020 -> 30 Dec 2025)` }]);
log(`done: ${grand} rows`);
