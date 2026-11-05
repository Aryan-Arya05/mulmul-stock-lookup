// Vinculum (Vin eRetail) orders -> Supabase `sale_lines` for the Mulmul sales dashboard.
//
// Endpoint: v2/order/status. Its fromDate/toDate window filters on STATUS-UPDATE date, so an
// order that ships or is returned today resurfaces today even if it was placed weeks ago. We keep a
// watermark in `sync_state` (job = 'vinculum_orders') and re-read TAIL_DAYS below it every run so
// late status changes land. Windows are capped at 7 days (API error 913) and pages at 100 orders.
//
// Env: VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: VINCULUM_BASE, VINCULUM_ORG_ID, FROM_DATE / TO_DATE (dd/MM/yyyy, backfill override),
//           PROBE=1 (fetch one page, print the envelope, write nothing), TAIL_DAYS (default 3)

const VIN_BASE = process.env.VINCULUM_BASE || "https://mulmul.vineretail.com/RestWS/api/eretail";
const ENDPOINT = process.env.VINCULUM_ORDER_ENDPOINT || "v2/order/status";
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["VINCULUM_API_KEY", "VINCULUM_API_OWNER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])
  if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }

const PROBE = process.env.PROBE === "1";
const TAIL_DAYS = Number(process.env.TAIL_DAYS || 3);
const PAGE_SIZE = 100;
const MAX_PAGES_PER_WINDOW = 400;
const WINDOW_DAYS = 7;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- business rules (identical to the August pipeline) ----------
const SALE_STATUSES = new Set(["allocated", "confirmed", "delivered", "packed", "part allocated", "part picked",
  "partial shipped", "partially shipped", "pick complete", "shipped complete"]);
const NON_SALE_STATUSES = new Set(["closed", "cancelled", "canceled", "shipped & returned", "shipped and returned",
  "returned", "rto", "rto delivered", "return complete", "pending"]);
const ONLINE_CHANNELS = { M01: "INR", M03: "USD", M04: "AED", M10: "USD" };   // Shopify India / USA / UAE / Asia
const EXCLUDED_PREFIXES = ["M0", "MNW", "MWH", "NOO", "KAS", "PCPL", "KARTIK", "ROHAN", "PO"];

// ---------- Vinculum transport ----------
let lastCall = 0;
const MIN_GAP_MS = Number(process.env.VINCULUM_MIN_GAP_MS || 3000);
async function vin(path, body, attempt = 1) {
  const json = JSON.stringify(body);
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  let r;
  try {
    r = await fetch(`${VIN_BASE}/${path}`, {
      signal: AbortSignal.timeout(180000),
      method: "POST",
      headers: {
        ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY,
        OrgId: process.env.VINCULUM_ORG_ID || "MULM",
        "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json",
      },
      body: new URLSearchParams({ RequestBody: json, ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY }).toString(),
    });
  } catch (e) {
    if (attempt < 4) { log(`vinculum ${path} attempt ${attempt}: ${e.name} ${e.message}; retrying`); await sleep(5000 * attempt); return vin(path, body, attempt + 1); }
    throw new Error(`Vinculum ${path} unreachable: ${e.name} ${e.message}`);
  }
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const code = data ? Number(data.responseCode) : NaN;
  if (code === 1105) return { ...data, _empty: true };                      // "No Record Found"
  if (code === 13) {                                                         // "API Hit Quota Exceeded"
    if (attempt > 8) throw new Error(`Vinculum ${path}: quota exceeded, gave up`);
    log(`quota hit on ${path}; waiting 65s (attempt ${attempt})`);
    await sleep(65000);
    return vin(path, body, attempt + 1);
  }
  if (!r.ok || !data || (code !== 0 && !Number.isNaN(code))) {
    if (attempt < 4 && (r.status >= 500 || r.status === 429 || !data)) {
      log(`vinculum ${path} attempt ${attempt} failed (${r.status}); retrying`);
      await sleep(3000 * attempt);
      return vin(path, body, attempt + 1);
    }
    throw new Error(`Vinculum ${path} failed: HTTP ${r.status} ${text.slice(0, 400)}`);
  }
  return data;
}

const pad = n => String(n).padStart(2, "0");
const fmtIST = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function buildBody(from, to, page) {
  // Empty strings / arrays rather than missing keys: the API parse-errors on missing keys.
  return {
    orderNo: "", statuses: [], fromDate: fmtIST(from), toDate: fmtIST(to), pageNumber: String(page),
    order_Location: "", fulfillmentLocation: "", orderSource: "", paymentType: [], skuCodes: [], brand: [],
    IsReplacementOrder: "", reqType: "",
  };
}

// The order list sits under a key that varies by endpoint/version. Find the first list of order-like dicts.
function findOrders(payload) {
  if (!payload || typeof payload !== "object") return [];
  const looks = v => Array.isArray(v) && v.length && typeof v[0] === "object" && ["orderNo", "orderNumber", "OrderNo"].some(k => k in v[0]);
  for (const v of Object.values(payload)) if (looks(v)) return v;
  for (const v of Object.values(payload)) if (v && typeof v === "object" && !Array.isArray(v)) for (const inner of Object.values(v)) if (looks(inner)) return inner;
  for (const v of Object.values(payload)) if (Array.isArray(v) && v.length === 0) return [];
  return [];
}
const pick = (o, ...names) => { for (const n of names) if (o && o[n] !== undefined && o[n] !== null && o[n] !== "") return o[n]; return undefined; };

// "dd/MM/yyyy HH:mm:ss" (IST) or ISO -> ISO string with +05:30
function parseVinDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (m) {
    let h = Number(m[4] || 0);
    if (m[7]) { const ap = m[7].toUpperCase(); if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0; }
    return `${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(h)}:${m[5] || "00"}:${m[6] || "00"}+05:30`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function flatten(orders) {
  const rows = [];
  for (const o of orders) {
    const orderNo = String(pick(o, "orderNo", "orderNumber", "OrderNo") || "").trim();
    if (!orderNo) continue;
    const orderType = String(pick(o, "orderType") || "SO").trim().toUpperCase();
    if (orderType !== "SO") continue;                                        // STO = internal transfer, never a sale
    if (EXCLUDED_PREFIXES.some(p => orderNo.toUpperCase().startsWith(p))) continue;
    const items = pick(o, "items", "orderItems", "lineItems") || [];
    const explicit = pick(o, "status", "orderStatus", "orderStatusDesc");
    let oStatus = explicit ? String(explicit).trim() : "";
    if (!oStatus && items.length) {
      const counts = {};
      for (const it of items) { const s = String(pick(it, "status", "itemStatus") || "").trim(); if (s) counts[s] = (counts[s] || 0) + 1; }
      oStatus = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    }
    const norm = oStatus.toLowerCase();
    const channelCode = String(pick(o, "channelCode", "orderSource", "channel") || "").trim().toUpperCase();
    const isOnline = channelCode in ONLINE_CHANNELS;
    const loc = String(pick(o, "fulfillmentLocCode", "fulfillmentLocation", "orderLocation", "order_Location", "locCode") || "").trim().toUpperCase();
    const prefix = (orderNo.match(/^[A-Z]+/) || [""])[0];
    const orderDate = parseVinDate(pick(o, "orderDate", "order_date", "createdDate"));
    if (!orderDate) continue;
    for (const it of items) {
      const sku = String(pick(it, "skuCode", "sku", "skucode") || "").trim();
      if (!sku) continue;
      const internal = pick(it, "internalLineNo", "internalLineNumber", "lineId", "lineno", "lineNo");
      const qty = Number(pick(it, "qty", "quantity", "orderQty") || 0);
      const cancelled = Number(pick(it, "cancelledQty") || 0);
      const lStatus = String(pick(it, "status", "itemStatus") || "").trim();
      rows.push({
        source: "vinculum", order_no: orderNo, sku, line_key: internal !== undefined ? String(internal) : "1",
        order_date: orderDate, channel: isOnline ? "Online" : "Store",
        channel_code: isOnline ? channelCode : (channelCode || null),
        location_code: isOnline ? null : (loc || prefix || null),
        order_type: orderType, status: oStatus, line_status: lStatus,
        qty: Math.max(0, qty - cancelled) || qty, unit_price: Number(pick(it, "unitPrice", "unitprice") || 0),
        discount_amt: Number(pick(it, "discountAmt", "discountAmount", "discount") || 0),
        currency: pick(o, "currency", "currencyCode") || (ONLINE_CHANNELS[channelCode] || "INR"),
        sku_desc: pick(it, "skuName", "itemName", "productName") || null,
        colour: pick(it, "color", "colour") || null, size: pick(it, "size") || null,
        is_sale: SALE_STATUSES.has(norm),
        synced_at: new Date().toISOString(),
      });
    }
  }
  return rows;
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
  for (let i = 0; i < rows.length; i += 1000)
    await sb(`${table}?on_conflict=${onConflict}`, { method: "POST", body: rows.slice(i, i + 1000), prefer: "resolution=merge-duplicates,return=minimal" });
}
async function setState(patch) {
  await sb("sync_state?on_conflict=job", { method: "POST", body: [{ job: "vinculum_orders", ...patch }], prefer: "resolution=merge-duplicates,return=minimal" });
}

// ---------- main ----------
const parseDMY = s => { const [d, m, y] = s.split("/").map(Number); return new Date(y, m - 1, d); };
let from, to = new Date();
if (process.env.FROM_DATE) {
  from = parseDMY(process.env.FROM_DATE);
  if (process.env.TO_DATE) { to = parseDMY(process.env.TO_DATE); to.setHours(23, 59, 59); }
} else {
  const [state] = await sb("sync_state?job=eq.vinculum_orders&select=watermark");
  from = state?.watermark ? new Date(state.watermark) : new Date(Date.now() - 7 * 86400000);
  from = new Date(from.getTime() - TAIL_DAYS * 86400000);
}
log(`window ${fmtIST(from)} -> ${fmtIST(to)} via ${ENDPOINT}`);

if (PROBE) {
  const payload = await vin(ENDPOINT, buildBody(from, new Date(Math.min(to, from.getTime() + WINDOW_DAYS * 86400000)), 1));
  const orders = findOrders(payload);
  console.log("envelope keys:", Object.keys(payload), "responseCode:", payload.responseCode, payload.responseMessage);
  console.log("orders on page 1:", orders.length);
  if (orders.length) {
    console.log("order keys:", Object.keys(orders[0]));
    const items = pick(orders[0], "items", "orderItems", "lineItems") || [];
    if (items.length) console.log("line keys:", Object.keys(items[0]));
    console.log(JSON.stringify(orders[0], null, 2).slice(0, 3000));
    console.log("flattened sample:", JSON.stringify(flatten(orders.slice(0, 2)), null, 2).slice(0, 2000));
  }
  process.exit(0);
}

await setState({ status: "running", last_run: new Date().toISOString(), detail: `window ${fmtIST(from)} -> ${fmtIST(to)}` });
try {
  let total = 0, maxSeen = from;
  for (let ws = new Date(from); ws < to; ws = new Date(ws.getTime() + WINDOW_DAYS * 86400000)) {
    const we = new Date(Math.min(to.getTime(), ws.getTime() + WINDOW_DAYS * 86400000 - 1000));
    const orders = [];
    for (let page = 1; page <= MAX_PAGES_PER_WINDOW; page++) {
      const payload = await vin(ENDPOINT, buildBody(ws, we, page));
      const list = payload._empty ? [] : findOrders(payload);
      log(`  ${fmtIST(ws).slice(0, 10)}..${fmtIST(we).slice(0, 10)} page ${page}: ${list.length} orders`);
      if (!list.length) break;
      orders.push(...list);
      if (list.length < PAGE_SIZE) break;
    }
    const rows = flatten(orders);
    if (rows.length) {
      await upsert("sale_lines", rows, "source,order_no,sku,line_key");
      total += rows.length;
      for (const r of rows) { const d = new Date(r.order_date); if (d > maxSeen) maxSeen = d; }
    }
    await setState({ detail: `written ${total} lines; through ${fmtIST(we)}` });
  }
  // Watermark = end of the window actually fetched (status-update time), not max order date.
  await setState({ status: "ok", watermark: to.toISOString(), last_run: new Date().toISOString(), detail: `wrote ${total} lines; window ${fmtIST(from)} -> ${fmtIST(to)}` });
  log(`done: ${total} lines`);
} catch (e) {
  log("FAILED", e.message);
  await setState({ status: "error", detail: e.message.slice(0, 800) }).catch(() => {});
  process.exit(1);
}
