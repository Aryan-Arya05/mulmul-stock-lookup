// Google Sheet "Replenishment + Sale Report" -> Supabase for the Mulmul sales dashboard.
//
//   Replenishment sheet  -> `replenishment` (always; this is the team's production/replenishment tracker)
//   Sale Report          -> `sale_lines` with source='sheet' (only when SYNC_SHEET_SALES=1; used for the
//                           historical backfill and as a fallback while the Vinculum pull is being proven)
//
// The sheet must be shared as "Anyone with the link can view"; we read it through the CSV export URL,
// so no Google credentials are needed.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Optional: SHEET_ID, SYNC_SHEET_SALES=1

const SHEET_ID = process.env.SHEET_ID || "1Ly2DjuCYP9m7dsxKZwpY4nZd6lAv39svHCpMnULrpSU";
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- CSV ----------
function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const GIDS = { "Replenishment sheet": 0, "Sale Report": 630341754, "Designers Report": 26648738, "Inventory": 531969054 };
async function fetchTab(name) {
  // /export?format=csv gives the grid exactly as displayed (gviz re-types columns and drops some); gid from GIDS.
  const url = GIDS[name] !== undefined
    ? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GIDS[name]}`
    : `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`sheet tab "${name}": HTTP ${r.status}. Is the sheet shared as "Anyone with the link"?`);
  const text = await r.text();
  if (text.trim().startsWith("<")) throw new Error(`sheet tab "${name}" returned HTML, not CSV — check link sharing`);
  const rows = parseCsv(text);
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(c => c && c.trim())).map((r, i) => {
    const o = { _row: i + 2 };
    header.forEach((h, j) => { o[h] = (r[j] ?? "").trim(); });
    return o;
  });
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
async function setState(job, patch) {
  await sb("sync_state?on_conflict=job", { method: "POST", body: [{ job, ...patch }], prefer: "resolution=merge-duplicates,return=minimal" });
}

// ---------- parsers ----------
const num = v => { const n = Number(String(v ?? "").replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : null; };
const int = v => { const n = num(v); return n === null ? null : Math.round(n); };
const str = v => { const s = String(v ?? "").trim(); return s && s !== "-" ? s : null; };
const pad = n => String(n).padStart(2, "0");
// "28-10-2026" / "28/10/2026" / "2026-10-28" -> "2026-10-28"
function dmy(v) {
  const s = str(v); if (!s) return null;
  let m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/); if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  return null;
}
// "02/11/2026 11:39 PM" (IST) -> ISO with +05:30
function sheetDateTime(v) {
  const s = str(v); if (!s) return null;
  let iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4] || "00"}:${iso[5] || "00"}:${iso[6] || "00"}+05:30`;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (!m) {
    const serial = Number(s);                                   // Sheets date serial (days since 1899-12-30)
    if (Number.isFinite(serial) && serial > 40000 && serial < 60000) {
      const ms = Math.round((serial - 25569) * 86400000); const dt = new Date(ms);
      return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:00+05:30`;
    }
    return null;
  }
  let h = Number(m[4] || 0);
  if (m[7]) { const ap = m[7].toUpperCase(); if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0; }
  return `${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(h)}:${m[5] || "00"}:${m[6] || "00"}+05:30`;
}
const SALE_STATUSES = new Set(["allocated", "confirmed", "delivered", "packed", "part allocated", "part picked",
  "partial shipped", "partially shipped", "pick complete", "shipped complete", "pending"]);   // Pending counts as sold (team definition)

// ---------- Replenishment sheet ----------
async function syncReplenishment() {
  const rows = await fetchTab("Replenishment sheet");
  const out = []; const seen = new Set();
  for (const r of rows) {
    const style = str(r["Styles No"]); const colour = str(r["STYLE COLOUR"]);
    if (!style || !colour) continue;
    const key = `${style}|${colour.toUpperCase()}`;
    if (seen.has(key)) { log(`duplicate style/colour on row ${r._row}: ${key} (keeping first)`); continue; }
    seen.add(key);
    const r1 = int(r["1st Replenishment"]) || 0, r2 = int(r["2nd Replenishment"]) || 0, r3 = int(r["3rd Replenishment"]) || 0;
    out.push({
      style_code: style, colour, collection: str(r["Collection"]), fabric: str(r["Fabric Quality"]),
      top_name: str(r["Top Name"]), top_sold_sheet: int(r["Top Sold"]),
      paired_bottom: str(r["Paired Bottom"]), bottom_sold_sheet: int(r["Bottom Sold"]),
      paired_dupatta: str(r["Paired Dupatta"]), dupatta_sold_sheet: int(r["Dupattas Sold"]),
      image_url: str(r["IMAGE"]),
      repl_1: r1, repl_2: r2, repl_3: r3, total_repl: int(r["Total Replenishment"]) ?? (r1 + r2 + r3),
      emb_fabric_date: dmy(r["Emb Fabric Date"]), cutting_date: dmy(r["Cutting Date"]), delivery_date: dmy(r["Delivery Date"]),
      changed_delivery_date: dmy(r["Changed Delivery Date"]), final_delivery_date: dmy(r["Final Delivery Date"]),
      remark: str(r["Remark"]) || str(r["Remark "]), bottom_colour: str(r["Bottom Colour (if different)"]), dupatta_colour: str(r["Dupatta Colour (if different)"]),
      sheet_row: r._row, synced_at: new Date().toISOString(),
    });
  }
  await upsert("replenishment", out, "style_code,colour");
  // rows removed from the sheet disappear from the dashboard too
  const keep = out.map(o => `"${o.style_code}|${o.colour}"`);
  const existing = await sb("replenishment?select=style_code,colour");
  const gone = existing.filter(e => !keep.includes(`"${e.style_code}|${e.colour}"`));
  for (const g of gone) await sb(`replenishment?style_code=eq.${encodeURIComponent(g.style_code)}&colour=eq.${encodeURIComponent(g.colour)}`, { method: "DELETE" });
  log(`replenishment: ${out.length} rows upserted, ${gone.length} removed`);
  return out.length;
}

// ---------- Sale Report (historical / fallback) ----------
async function syncSheetSales() {
  const locs = new Set((await sb("locations?select=code")).map(l => l.code));
  const rows = await fetchTab("Sale Report");
  log(`sale report: ${rows.length} rows; headers: ${Object.keys(rows[0] || {}).join(" | ")}`);
  log(`sample row: ${JSON.stringify(rows[0])}`);
  const occ = new Map(); const out = []; let skipped = 0;
  for (const r of rows) {
    const orderNo = str(r["ExternOrderNo"]); const sku = str(r["SKU"]); const date = sheetDateTime(r["OrderDate"]) || sheetDateTime(r["OrderDt"]);
    if (!orderNo || !sku || !date) { skipped++; continue; }
    const k = `${orderNo}|${sku}`; const n = (occ.get(k) || 0) + 1; occ.set(k, n);
    const channel = /store/i.test(r["Channel"]) ? "Store" : "Online";
    const prefix = (orderNo.match(/^[A-Z]+/) || [""])[0];
    const status = str(r["Status"]) || "";
    out.push({
      source: "sheet", order_no: orderNo, sku, line_key: String(n), order_date: date, channel,
      channel_code: channel === "Online" ? (prefix === "ML" ? "M01" : null) : null,
      location_code: channel === "Store" && locs.has(prefix) ? prefix : null,
      order_type: "SO", status, line_status: null, qty: num(r["Order Qty"]) ?? 1,
      sku_desc: str(r["SKU Desc"]), colour: str(r["Color"]), size: str(r["Size"]), sub_category: str(r["Sub Category"]),
      is_sale: SALE_STATUSES.has(status.toLowerCase()),
      synced_at: new Date().toISOString(),
    });
  }
  await upsert("sale_lines", out, "source,order_no,sku,line_key");
  log(`sheet sales: ${out.length} lines upserted, ${skipped} skipped`);
  return out.length;
}

try {
  const n = await syncReplenishment();
  await setState("sheet_replenishment", { status: "ok", last_run: new Date().toISOString(), detail: `${n} rows` });
  if (process.env.SYNC_SHEET_SALES === "1") {
    const m = await syncSheetSales();
    await setState("sheet_sales", { status: "ok", last_run: new Date().toISOString(), detail: `${m} lines` });
  }
  await sb("rpc/refresh_sales_views", { method: "POST", body: {} });
  log("materialized views refreshed");
} catch (e) {
  log("FAILED", e.message);
  await setState("sheet_replenishment", { status: "error", last_run: new Date().toISOString(), detail: e.message.slice(0, 800) }).catch(() => {});
  process.exit(1);
}
