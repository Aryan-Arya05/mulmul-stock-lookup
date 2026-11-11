// Vinculum v2/order/stoDetails -> Supabase `sto_details`: where each stock transfer is moving from and to,
// when it was actually shipped, and how much of it the destination has received.
//
// The order pull (sync-sales-vinculum.mjs) already lists every transfer in `sto_orders`. This script asks
// stoDetails only about the ones in a shipped state whose detail is missing, changed, or older than 6 hours
// (view v_sto_details_todo), 20 transfers per call (the API's limit), 40 calls per 5 minutes.
//
// Env: VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: VINCULUM_BASE, VINCULUM_ORG_ID, MAX_ORDERS (default 400 per run), VINCULUM_MIN_GAP_MS (7600),
//           DRY_FILE (parse a saved response and print the rows; calls nothing, writes nothing)
import { readFileSync } from "node:fs";

const VIN_BASE = process.env.VINCULUM_BASE || "https://mulmul.vineretail.com/RestWS/api/eretail";
const ENDPOINT = "v2/order/stoDetails";
const MAX_ORDERS = Number(process.env.MAX_ORDERS || 400);
const MIN_GAP_MS = Number(process.env.VINCULUM_MIN_GAP_MS || 7600);
const PER_CALL = 20;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, "0");
const num = v => { const n = Number(v); return v === "" || v == null || Number.isNaN(n) ? null : n; };
const str = v => { const s = String(v ?? "").trim(); return s || null; };

// "05/11/2026 16:33:43" (IST) -> ISO with +05:30
export function parseVinDate(s) {
  const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (!m) return null;
  let h = Number(m[4] || 0);
  if (m[7]) { const ap = m[7].toUpperCase(); if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0; }
  return `${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(h)}:${m[5] || "00"}:${m[6] || "00"}+05:30`;
}

// One row per transfer x shipment (delivery) x line.
export function flatten(payload) {
  const rows = [], seen = [];
  for (const o of payload?.stoList || []) {
    const order_no = str(o.orderNo);
    if (!order_no) continue;
    seen.push({ order_no, order_updated: str(o.updatedDate) });
    const head = {
      order_no,
      from_code: str(o.fromSiteCode)?.toUpperCase() || null, from_name: str(o.fromSiteName),
      to_code: str(o.toSiteCode)?.toUpperCase() || null, to_name: str(o.toSiteName),
      order_status: str(o.status), sto_type: str(o.stoType),
    };
    for (const d of o.shipmentDetail || []) {
      const del = {
        delivery_no: str(d.deliveryNumber) || "", delivery_status: str(d.status),
        ship_date: parseVinDate(d.shipDate), pick_date: parseVinDate(d.pickDate), pack_date: parseVinDate(d.packDate),
        transporter: str(d.extTransporterName) || str(d.transporter), tracking_no: str(d.trackingNumber),
        inbound_codes: (d.inBoundCodes || []).map(x => (typeof x === "string" ? x : x?.inboundCode || x?.code || JSON.stringify(x))).filter(Boolean),
      };
      for (const it of d.items || []) {
        const sku = str(it.sku)?.toUpperCase();
        if (!sku) continue;
        rows.push({
          ...head, ...del, sku, line_key: str(it.lineno) || "1",
          order_qty: num(it.orderQty), shipped_qty: num(it.orderShippedQty), delivery_qty: num(it.delQty),
          received_qty: num(it.recievedQty), line_status: str(it.status),
          raw: { ...it, _delivery: { ...d, items: undefined } },
        });
      }
    }
  }
  return { rows, seen };
}

if (process.env.DRY_FILE) {
  console.log(JSON.stringify(flatten(JSON.parse(readFileSync(process.env.DRY_FILE, "utf8"))), null, 1));
  process.exit(0);
}

const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["VINCULUM_API_KEY", "VINCULUM_API_OWNER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])
  if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }

// ---------- Vinculum transport (same styles as the other sync scripts) ----------
const STYLES = ["form", "form+headers", "json"];
let styleIdx = Number(process.env.VINCULUM_STYLE_INDEX || 1);
let lastCall = 0, calls = 0;
async function vin(body, attempt = 1) {
  const json = JSON.stringify(body);
  const style = STYLES[styleIdx];
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now(); calls++;
  const authHeaders = { ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY, OrgId: process.env.VINCULUM_ORG_ID || "MULM" };
  let r;
  try {
    r = await fetch(`${VIN_BASE}/${ENDPOINT}`, {
      signal: AbortSignal.timeout(180000),
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(style === "form" ? {} : authHeaders),
        ...(style === "json" ? { RequestBody: json, "Content-Type": "application/json" } : { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      body: style === "json" ? json : new URLSearchParams({ RequestBody: json, ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY }).toString(),
    });
  } catch (e) {
    if (attempt < 4) { log(`network ${e.name} ${e.message}; retry ${attempt}`); await sleep(5000 * attempt); return vin(body, attempt + 1); }
    throw new Error(`Vinculum unreachable: ${e.name} ${e.message}`);
  }
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const code = data ? Number(data.responseCode) : NaN;
  if (code === 1105 || /no record/i.test(String(data?.responseMessage || ""))) return { stoList: [], totalPages: 0 };
  if ((code === 10058 || code === 11 || r.status === 415) && styleIdx < STYLES.length - 1) {
    log(`style "${style}" rejected (${r.status} / ${code}); trying "${STYLES[styleIdx + 1]}"`);
    styleIdx++;
    return vin(body, attempt);
  }
  if (code === 9 && attempt < 5) { log(`generic error (9); retrying in ${20 * attempt}s`); await sleep(20000 * attempt); return vin(body, attempt + 1); }
  if (code === 13) {
    if (attempt > 8) throw new Error("Vinculum quota exceeded, gave up");
    log(`quota hit; waiting 65s (attempt ${attempt})`);
    await sleep(65000);
    return vin(body, attempt + 1);
  }
  if (!r.ok || !data || code !== 0) {
    if (attempt < 4 && (r.status >= 500 || r.status === 429 || !data)) { log(`attempt ${attempt} failed (${r.status}); retrying`); await sleep(3000 * attempt); return vin(body, attempt + 1); }
    throw new Error(`Vinculum ${ENDPOINT} failed: HTTP ${r.status} ${text.slice(0, 400)}`);
  }
  return data;
}

// ---------- Supabase ----------
async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 400)
    await sb(`${table}?on_conflict=${onConflict}`, { method: "POST", body: rows.slice(i, i + 400), prefer: "resolution=merge-duplicates,return=minimal" });
}
const setState = patch => sb("sync_state?on_conflict=job", { method: "POST", body: [{ job: "sto_details", ...patch }], prefer: "resolution=merge-duplicates,return=minimal" });

// ---------- main ----------
try {
  // never-fetched transfers first, then the stale ones
  const todo = (await sb(`v_sto_details_todo?select=order_no&order=never_fetched.desc,order_no&limit=${MAX_ORDERS}`)).map(r => r.order_no);
  log(`${todo.length} transfers to look up (cap ${MAX_ORDERS})`);
  let written = 0, looked = 0;
  for (let i = 0; i < todo.length; i += PER_CALL) {
    const batch = todo.slice(i, i + PER_CALL);
    const rows = [], seen = new Map();
    for (let page = 1; page <= 50; page++) {
      const d = await vin({ stoNos: batch, fromDate: "", toDate: "", srcLocation: "", stoType: [], status: [], pageNumber: String(page), filterBy: "" });
      const f = flatten(d);
      rows.push(...f.rows); f.seen.forEach(s => seen.set(s.order_no, s.order_updated));
      if (!f.seen.length || page >= Number(d.totalPages || 0)) break;
    }
    const now = new Date().toISOString();
    const unique = [...new Map(rows.map(r => [`${r.order_no}|${r.delivery_no}|${r.sku}|${r.line_key}`, { ...r, synced_at: now }])).values()];
    if (unique.length) await upsert("sto_details", unique, "order_no,delivery_no,sku,line_key");
    // record every transfer we asked about, so one that returns nothing is not asked again on every run
    const ordersUpdated = Object.fromEntries((await sb(`sto_orders?select=order_no,updated:raw->>updatedDate&order_no=in.(${batch.map(o => `"${o}"`).join(",")})`)).map(o => [o.order_no, o.updated]));
    await upsert("sto_detail_fetch", batch.map(order_no => ({ order_no, order_updated: ordersUpdated[order_no] ?? seen.get(order_no) ?? null, fetched_at: now })), "order_no");
    written += unique.length; looked += batch.length;
    log(`  ${looked}/${todo.length} transfers, ${unique.length} shipment lines in this batch, ${calls} calls`);
  }
  await setState({ status: "ok", last_run: new Date().toISOString(), detail: `looked up ${looked} transfers, wrote ${written} shipment lines, ${calls} calls` });
  log(`done: ${looked} transfers, ${written} lines, ${calls} calls`);
} catch (e) {
  log("FAILED", e.message);
  await setState({ status: "error", last_run: new Date().toISOString(), detail: e.message.slice(0, 800) }).catch(() => {});
  process.exit(1);
}
