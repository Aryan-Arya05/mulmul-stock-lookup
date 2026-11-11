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
const ENDPOINT = process.env.VINCULUM_ORDER_ENDPOINT || "v2/order/orderPull";   // proven on this tenant (order/status rejects every body)
const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["VINCULUM_API_KEY", "VINCULUM_API_OWNER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])
  if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }

const PROBE = process.env.PROBE === "1";
const TAIL_DAYS = Number(process.env.TAIL_DAYS || 3);   // orderPull filters on updatedDate, so late status changes resurface by themselves
const PAGE_SIZE = 100;
const MAX_PAGES_PER_WINDOW = 400;
const WINDOW_DAYS = 7;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- business rules (identical to the August pipeline) ----------
const SALE_STATUSES = new Set(["allocated", "confirmed", "delivered", "packed", "part allocated", "part picked",
  "partial shipped", "partially shipped", "pick complete", "shipped complete", "pending"]);   // Pending counts as sold (team definition)
const NON_SALE_STATUSES = new Set(["closed", "cancelled", "canceled", "shipped & returned", "shipped and returned",
  "returned", "rto", "rto delivered", "return complete"]);
const ONLINE_CHANNELS = { M01: "INR", M03: "USD", M04: "AED", M10: "USD" };   // Shopify India / USA / UAE / Asia
const EXCLUDED_PREFIXES = ["M0", "MNW", "MWH", "NOO", "KAS", "PCPL", "KARTIK", "ROHAN", "PO"];

// ---------- Vinculum transport ----------
let lastCall = 0;
const MIN_GAP_MS = Number(process.env.VINCULUM_MIN_GAP_MS || 3000);
// Transport styles: the tenant accepts form-encoded RequestBody for most endpoints; which auth placement
// works varies per endpoint, so we try: form fields only -> form + headers -> JSON body, and remember the winner.
const STYLES = ["form", "form+headers", "json"];
let styleIdx = Number(process.env.VINCULUM_STYLE_INDEX || 1);
async function vin(path, body, attempt = 1) {
  const json = JSON.stringify(body);
  const style = STYLES[styleIdx];
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const authHeaders = { ApiOwner: VINCULUM_API_OWNER, ApiKey: VINCULUM_API_KEY, OrgId: process.env.VINCULUM_ORG_ID || "MULM" };
  let r;
  try {
    r = await fetch(`${VIN_BASE}/${path}`, {
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
    if (attempt < 4) { log(`vinculum ${path} attempt ${attempt}: ${e.name} ${e.message}; retrying`); await sleep(5000 * attempt); return vin(path, body, attempt + 1); }
    throw new Error(`Vinculum ${path} unreachable: ${e.name} ${e.message}`);
  }
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const code = data ? Number(data.responseCode) : NaN;
  if (code === 1105) return { ...data, _empty: true };                      // "No Record Found"
  if ((code === 10058 || r.status === 415) && styleIdx < STYLES.length - 1) {
    log(`${path}: style "${style}" rejected (${r.status} / ${code} ${data?.responseMessage || ""}), trying "${STYLES[styleIdx + 1]}"`);
    styleIdx++;
    return vin(path, body, attempt);
  }
  if (code === 9 && attempt < 6) {                                           // "Generic Error" — transient on this tenant
    log(`${path}: generic error (9); retrying in ${20 * attempt}s (attempt ${attempt})`);
    await sleep(20000 * attempt);
    return vin(path, body, attempt + 1);
  }
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
    orderNo: "", statuses: [], fromDate: fmtIST(from), toDate: fmtIST(to), pageNumber: page,
    order_Location: "", fulfillmentLocation: "", orderSource: "", paymentType: [], skuCodes: [], brand: [],
    IsReplacementOrder: "", reqType: "",
  };
}

// The order list sits under a key that varies by endpoint/version. Find the first list of order-like dicts.
function findOrders(payload) {
  if (!payload || typeof payload !== "object") return [];
  const isOrder = o => o && typeof o === "object" && ["orderNo", "orderNumber", "OrderNo"].some(k => k in o);
  // orderPull returns [{ "<orderNo>": {...order} }, ...]; unwrap that shape
  const unwrap = v => v.map(o => isOrder(o) ? o : (o && typeof o === "object" && Object.keys(o).length === 1 && isOrder(Object.values(o)[0]) ? Object.values(o)[0] : null)).filter(Boolean);
  const looks = v => Array.isArray(v) && v.length && unwrap(v).length;
  for (const v of Object.values(payload)) if (looks(v)) return unwrap(v);
  for (const v of Object.values(payload)) if (v && typeof v === "object" && !Array.isArray(v)) for (const inner of Object.values(v)) if (looks(inner)) return unwrap(inner);
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

// Stock transfer orders arrive in the same pull. They are never sales, but they say what is moving between
// locations, so they are kept in sto_orders / sto_lines (see flushSto) for the dashboard's in-transit view.
const stoBuf = { orders: new Map(), lines: new Map() };
function captureSto(o, orderNo) {
  const items = pick(o, "items", "orderItems", "lineItems") || [];
  const header = Object.fromEntries(Object.entries(o).filter(([k]) => !["items", "orderItems", "lineItems"].includes(k)));
  const explicit = pick(o, "status", "orderStatus", "orderStatusDesc");
  let status = explicit ? String(explicit).trim() : "";
  if (!status && items.length) {
    const counts = {};
    for (const it of items) { const st = String(pick(it, "status", "itemStatus") || "").trim(); if (st) counts[st] = (counts[st] || 0) + 1; }
    status = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }
  const now = new Date().toISOString();
  stoBuf.orders.set(orderNo, {
    order_no: orderNo,
    order_date: parseVinDate(pick(o, "orderDate", "order_date", "createdDate")),
    status: status || null,
    from_code: String(pick(o, "fulfillmentLocCode", "fulfillmentLocation", "orderLocation", "order_Location", "locCode") || "").trim().toUpperCase() || null,
    to_code: String(pick(o, "customerCode", "customer_code", "toLocation", "deliveryLocation", "shipToCode") || "").trim().toUpperCase() || null,
    to_name: String(pick(o, "customerName", "shipName", "shipToName", "deliveryLocationName") || "").trim() || null,
    raw: header, synced_at: now,
  });
  for (const it of items) {
    const sku = String(pick(it, "skuCode", "sku", "skucode") || "").trim().toUpperCase();
    if (!sku) continue;
    const internal = pick(it, "internalLineNo", "internalLineNumber", "lineId", "lineno", "lineNo");
    const key = internal !== undefined ? String(internal) : "1";
    stoBuf.lines.set(`${orderNo}|${sku}|${key}`, {
      order_no: orderNo, sku, line_key: key,
      qty: Math.max(0, Number(pick(it, "qty", "quantity", "orderQty") || 0) - Number(pick(it, "cancelledQty") || 0)),
      line_status: String(pick(it, "status", "itemStatus") || "").trim() || null,
      raw: it, synced_at: now,
    });
  }
}
// Never let transfer capture break the sales sync.
async function flushSto() {
  if (!stoBuf.orders.size) return;
  const orders = [...stoBuf.orders.values()], lines = [...stoBuf.lines.values()];
  stoBuf.orders.clear(); stoBuf.lines.clear();
  try {
    await upsert("sto_orders", orders, "order_no");
    if (lines.length) await upsert("sto_lines", lines, "order_no,sku,line_key");
    log(`  transfers: ${orders.length} STO orders, ${lines.length} lines`);
  } catch (e) { log("WARNING: could not save transfer orders:", e.message.slice(0, 200)); }
}

function flatten(orders) {
  const rows = [];
  for (const o of orders) {
    const orderNo = String(pick(o, "orderNo", "orderNumber", "OrderNo") || "").trim();
    if (!orderNo) continue;
    const orderType = String(pick(o, "orderType") || "SO").trim().toUpperCase();
    if (orderType === "STO") captureSto(o, orderNo);
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
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    for (let attempt = 1; ; attempt++) {
      try { await sb(`${table}?on_conflict=${onConflict}`, { method: "POST", body: chunk, prefer: "resolution=merge-duplicates,return=minimal" }); break; }
      catch (e) { if (attempt >= 5 || !/57014|timeout|5\d\d/.test(e.message)) throw e; log(`upsert retry ${attempt}: ${e.message.slice(0, 80)}`); await sleep(5000 * attempt); }
    }
  }
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
  const f = fmtIST(from), t = fmtIST(new Date(Math.min(to, from.getTime() + 2 * 86400000)));
  const bodies = {
    full_int:   buildBody(from, new Date(Math.min(to, from.getTime() + 2 * 86400000)), 1),
    full_str:   { ...buildBody(from, new Date(Math.min(to, from.getTime() + 2 * 86400000)), 1), pageNumber: "1" },
    no_reqtype: (() => { const b = { ...buildBody(from, new Date(Math.min(to, from.getTime() + 2 * 86400000)), 1), pageNumber: "1" }; delete b.reqType; return b; })(),
    minimal:    { orderNo: "", fromDate: f, toDate: t, pageNumber: "1" },
    strings:    { orderNo: "", statuses: "", fromDate: f, toDate: t, pageNumber: "1", order_Location: "", fulfillmentLocation: "", orderSource: "", paymentType: "", skuCodes: "", brand: "", IsReplacementOrder: "" },
    dateType:   { orderNo: "", statuses: [], fromDate: f, toDate: t, pageNumber: "1", order_Location: "", fulfillmentLocation: "", orderSource: "", paymentType: [], skuCodes: [], brand: [], IsReplacementOrder: "", dateType: "orderDate" },
    pull:       { fromDate: f, toDate: t, pageNumber: "1", filterBy: 2, orderLocation: "", status: "" },
  };
  const endpoints = (process.env.VINCULUM_PROBE_ENDPOINTS || "v2/order/orderPull").split(",");
  for (const ep of endpoints) for (const [name, b] of Object.entries(bodies).slice(0, 1)) {
    styleIdx = 1;
    try {
      const payload = await vin(ep, b);
      const orders = findOrders(payload);
      console.log(`\n=== ${ep} / ${name}: responseCode ${payload.responseCode} ${payload.responseMessage || ""} keys=${Object.keys(payload)} orders=${orders.length}`);
      if (orders.length) {
        console.log("order keys:", Object.keys(orders[0]));
        const items = pick(orders[0], "items", "orderItems", "lineItems") || [];
        if (items.length) console.log("line keys:", Object.keys(items[0]));
        console.log(JSON.stringify(orders[0], null, 1).slice(0, 2500));
        console.log("flattened:", JSON.stringify(flatten(orders.slice(0, 1)), null, 1).slice(0, 1200));
        console.log(`\nWINNER: endpoint=${ep} body=${name}`);
        process.exit(0);
      }
      if (Number(payload.responseCode) === 0 || payload._empty) { console.log(`accepted but empty; raw: ${JSON.stringify(payload).slice(0, 600)}`); }
    } catch (e) { console.log(`\n=== ${ep} / ${name}: ${e.message.slice(0, 300)}`); }
  }
  console.log("no variant returned orders");
  process.exit(1);
}

// ---------- full-history backfill (BACKFILL=1): walk backward in 7-day windows, resumable, time-budgeted ----------
if (process.env.BACKFILL === "1") {
  const BUDGET_MS = Number(process.env.BACKFILL_BUDGET_MIN || 300) * 60000;
  const EMPTY_STOP = Number(process.env.BACKFILL_EMPTY_WINDOWS || 26);      // ~6 months of empty windows = end of history
  const t0 = Date.now();
  const bset = patch => sb("sync_state?on_conflict=job", { method: "POST", body: [{ job: "vinculum_backfill", ...patch }], prefer: "resolution=merge-duplicates,return=minimal" });
  const [st] = await sb("sync_state?job=eq.vinculum_backfill&select=*");
  if (st?.status === "done") { log("backfill already complete:", st.detail); process.exit(0); }
  let cursor = st?.watermark ? new Date(st.watermark) : parseDMY(process.env.BACKFILL_START || "20/09/2026");
  let empties = Number((st?.detail || "").match(/empties=(\d+)/)?.[1] || 0);
  const STOP_AT = process.env.BACKFILL_STOP_DATE ? parseDMY(process.env.BACKFILL_STOP_DATE) : null;   // history before this comes from the archive load
  if (STOP_AT && cursor <= STOP_AT) { await bset({ status: "done", last_run: new Date().toISOString(), detail: `complete: reached stop date ${fmtIST(STOP_AT).slice(0, 10)}` }); log("backfill reached stop date"); process.exit(0); }
  let total = 0, windows = 0; const skipped = [];
  // Pull all pages of [ws, we]; on a persistent Vinculum error split the window down to single days and skip only those.
  async function fetchWindow(ws, we) {
    try {
      const orders = [];
      for (let page = 1; page <= MAX_PAGES_PER_WINDOW; page++) {
        const payload = await vin(ENDPOINT, buildBody(ws, we, page));
        const list = payload._empty ? [] : findOrders(payload);
        if (!list.length) break;
        orders.push(...list);
        const totalPages = Number(payload.totalPages || 0);
        if (totalPages ? page >= totalPages : list.length < PAGE_SIZE) break;
      }
      return orders;
    } catch (e) {
      const span = we.getTime() - ws.getTime();
      if (span <= 86400000) { log(`  SKIP ${fmtIST(ws).slice(0, 10)}: ${e.message.slice(0, 120)}`); skipped.push(fmtIST(ws).slice(0, 10)); return []; }
      const mid = new Date(ws.getTime() + Math.floor(span / 2 / 86400000) * 86400000 || ws.getTime() + span / 2);
      log(`  window ${fmtIST(ws).slice(0, 10)}..${fmtIST(we).slice(0, 10)} failed (${e.message.slice(0, 60)}); splitting`);
      return [...await fetchWindow(ws, new Date(mid.getTime() - 1000)), ...await fetchWindow(mid, we)];
    }
  }
  await bset({ status: "running", last_run: new Date().toISOString(), watermark: cursor.toISOString(), detail: `resuming at ${fmtIST(cursor)} empties=${empties}` });
  try {
    while (Date.now() - t0 < BUDGET_MS && empties < EMPTY_STOP && !(STOP_AT && cursor <= STOP_AT)) {
      const we = new Date(cursor.getTime() - 1000), ws = new Date(cursor.getTime() - WINDOW_DAYS * 86400000);
      const orders = await fetchWindow(ws, we);
      const rows = flatten(orders);
      await flushSto();
      if (rows.length) await upsert("sale_lines", rows, "source,order_no,sku,line_key");
      empties = orders.length ? 0 : empties + 1;
      total += rows.length; windows++;
      cursor = ws;
      log(`  ${fmtIST(ws).slice(0, 10)}..${fmtIST(we).slice(0, 10)}: ${orders.length} orders, ${rows.length} lines`);
      await bset({ watermark: cursor.toISOString(), detail: `reached ${fmtIST(cursor).slice(0, 10)}; this run ${total} lines over ${windows} windows; empties=${empties}${skipped.length ? `; skipped days: ${skipped.join(",")}` : ""}` });
    }
    const done = empties >= EMPTY_STOP || (STOP_AT && cursor <= STOP_AT);
    await bset({ status: done ? "done" : "paused", last_run: new Date().toISOString(), watermark: cursor.toISOString(), detail: `${done ? "complete" : "budget reached"} at ${fmtIST(cursor).slice(0, 10)}; last run ${total} lines; empties=${empties}${skipped.length ? `; skipped days: ${skipped.join(",")}` : ""}` });
    await fetch(`${SUPABASE_URL}/functions/v1/publish-snapshot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(e => log("snapshot publish skipped:", e.message));
    log(done ? "BACKFILL COMPLETE" : "budget reached; will continue next run");
    process.exit(0);
  } catch (e) {
    log("FAILED", e.message);
    await bset({ status: "error", detail: e.message.slice(0, 800), watermark: cursor.toISOString() }).catch(() => {});
    process.exit(1);
  }
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
      const totalPages = Number(payload.totalPages || 0);
      if (totalPages ? page >= totalPages : list.length < PAGE_SIZE) break;
    }
    const rows = flatten(orders);
    await flushSto();
    if (rows.length) {
      await upsert("sale_lines", rows, "source,order_no,sku,line_key");
      total += rows.length;
      for (const r of rows) { const d = new Date(r.order_date); if (d > maxSeen) maxSeen = d; }
    }
    await setState({ detail: `written ${total} lines; through ${fmtIST(we)}` });
  }
  // Watermark = end of the window actually fetched (status-update time), not max order date.
  await setState({ status: "ok", watermark: to.toISOString(), last_run: new Date().toISOString(), detail: `wrote ${total} lines; window ${fmtIST(from)} -> ${fmtIST(to)}` });
  await fetch(`${SUPABASE_URL}/functions/v1/publish-snapshot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(e => log("snapshot publish skipped:", e.message));
  log(`done: ${total} lines; views refreshed`);
} catch (e) {
  log("FAILED", e.message);
  await setState({ status: "error", detail: e.message.slice(0, 800) }).catch(() => {});
  process.exit(1);
}
