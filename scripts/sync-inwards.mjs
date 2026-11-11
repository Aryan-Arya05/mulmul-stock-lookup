// Vinculum stock adjustments -> Supabase `stock_adjustments`, the inward history behind the stock aging report.
//
// Production stock is received only at MNW, as a manual positive adjustment into the JIT bin, so the
// adjustment date is the replenishment date. Every adjustment is stored as-is; the rule for what counts as
// a fresh inward lives in the `v_fresh_inwards` view (supabase/stock_aging.sql).
//
// Endpoint: v3/stock/adjustmentDetail (100 rows per page, hit quota 40 per 5 min).
//
// Modes:
//   default     incremental: every adjustment since the watermark (minus TAIL_DAYS), in windows of WINDOW_DAYS
//   BACKFILL=1  full history for every SKU that has physical stock today, 100 SKUs per call, no date filter.
//               Resumable (cursor in sync_state job 'stock_adjustments_backfill') and time-budgeted.
//               BACKFILL_SOURCE / BACKFILL_JOB / LOCATIONS narrow it, e.g. SKUs in v_stock_no_inward at the
//               stores and MWH, to find where stock with no Noida record was first added.
//   DRY_FILE=x  parse a saved API response and print the rows; calls nothing, writes nothing
//
// Env: VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: VINCULUM_BASE, VINCULUM_ORG_ID, LOCATIONS (default MNW), BACKFILL_SOURCE, BACKFILL_JOB, TAIL_DAYS (2), WINDOW_DAYS (6),
//           BACKFILL_BUDGET_MIN (300), VINCULUM_MIN_GAP_MS (7600)
import { readFileSync } from "node:fs";

const VIN_BASE = process.env.VINCULUM_BASE || "https://mulmul.vineretail.com/RestWS/api/eretail";
const ENDPOINT = "v3/stock/adjustmentDetail";
const LOCATIONS = (process.env.LOCATIONS || "MNW").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const TAIL_DAYS = Number(process.env.TAIL_DAYS || 2);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 6);
const MIN_GAP_MS = Number(process.env.VINCULUM_MIN_GAP_MS || 7600);   // 40 hits per 5 min
const MAX_PAGES = 2000;
const DAY = 86400000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, "0");

// Vinculum speaks IST wall-clock time; the runner is UTC. Format a Date as dd/MM/yyyy HH:mm:ss in IST.
function fmtIST(d) {
  const t = new Date(d.getTime() + 5.5 * 3600000);
  return `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}
// "09/07/2026 17:33 PM" (24-hour clock with a stray AM/PM) or "05/11/2026 10:37 AM" -> ISO with +05:30
export function parseVinDate(s) {
  const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (!m) return null;
  let h = Number(m[4] || 0);
  if (m[7]) { const ap = m[7].toUpperCase(); if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0; }
  return `${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(h)}:${m[5] || "00"}:${m[6] || "00"}+05:30`;
}
export function flatten(payload) {
  const rows = [];
  for (const x of payload?.skuList || []) {
    const created_at = parseVinDate(x.createdDate);
    const sku = String(x.skuCode || "").trim().toUpperCase();
    if (!x.id || !sku || !created_at) continue;
    rows.push({
      id: String(x.id), sku,
      location_code: String(x.location || "").trim().toUpperCase(),
      bin: String(x.bin || "").trim().toUpperCase(),
      qty: Number(x.qty || 0),
      reason: String(x.reason || "").trim() || null,
      remarks: String(x.remarks || "").trim() || null,
      created_by: String(x.createdBy || "").trim() || null,
      created_at,
    });
  }
  return rows;
}

if (process.env.DRY_FILE) {
  const rows = flatten(JSON.parse(readFileSync(process.env.DRY_FILE, "utf8")));
  console.log(JSON.stringify(rows));
  process.exit(0);
}

const { VINCULUM_API_KEY, VINCULUM_API_OWNER, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
for (const k of ["VINCULUM_API_KEY", "VINCULUM_API_OWNER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])
  if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }

// ---------- Vinculum transport (same styles as sync-sales-vinculum.mjs) ----------
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
  if (code === 1105) return { skuList: [], totalPages: 0 };                  // "No Record Found"
  if ((code === 10058 || r.status === 415) && styleIdx < STYLES.length - 1) {
    log(`style "${style}" rejected (${r.status} / ${code}); trying "${STYLES[styleIdx + 1]}"`);
    styleIdx++;
    return vin(body, attempt);
  }
  if (code === 9 && attempt < 6) { log(`generic error (9); retrying in ${20 * attempt}s`); await sleep(20000 * attempt); return vin(body, attempt + 1); }
  if (code === 13) {                                                         // "API Hit Quota Exceeded"
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
// All pages for one request shape (pageNumber is filled in here).
async function fetchAll(body) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const d = await vin({ ...body, pageNumber: String(page) });
    const got = flatten(d);
    rows.push(...got);
    if (!got.length || page >= Number(d.totalPages || 0)) return rows;
  }
  throw new Error(`pagination runaway: more than ${MAX_PAGES} pages`);
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
async function save(rows) {
  const now = new Date().toISOString();
  const byId = new Map(rows.map(r => [r.id, { ...r, synced_at: now }]));   // one statement cannot upsert the same id twice
  const unique = [...byId.values()];
  for (let i = 0; i < unique.length; i += 500)
    await sb("stock_adjustments?on_conflict=id", { method: "POST", body: unique.slice(i, i + 500), prefer: "resolution=merge-duplicates,return=minimal" });
  return unique.length;
}
const setState = (job, patch) => sb("sync_state?on_conflict=job", { method: "POST", body: [{ job, ...patch }], prefer: "resolution=merge-duplicates,return=minimal" });

// ---------- backfill: full adjustment history for every SKU in stock ----------
if (process.env.BACKFILL === "1") {
  const JOB = process.env.BACKFILL_JOB || "stock_adjustments_backfill";
  const SOURCE = process.env.BACKFILL_SOURCE || "v_stock_on_hand";   // any view with a `sku` column, e.g. v_stock_no_inward
  const BUDGET_MS = Number(process.env.BACKFILL_BUDGET_MIN || 300) * 60000;
  const t0 = Date.now();
  const [st] = await sb(`sync_state?job=eq.${JOB}&select=*`);
  if (st?.status === "done" && process.env.BACKFILL_RESTART !== "1") { log("backfill already complete:", st.detail); process.exit(0); }
  // cursor = number of SKUs (in sku order) already done; kept in `detail` as done=N
  let done = process.env.BACKFILL_RESTART === "1" ? 0 : Number((st?.detail || "").match(/done=(\d+)/)?.[1] || 0);
  const skus = [];
  for (let off = 0; ; off += 1000) {
    const page = await sb(`${SOURCE}?select=sku&order=sku&offset=${off}&limit=1000`);
    page.forEach(r => skus.push(r.sku));
    if (page.length < 1000) break;
  }
  log(`backfill (${JOB}): ${skus.length} SKUs from ${SOURCE}, resuming at ${done}; locations ${LOCATIONS.join(",")}`);
  let written = 0;
  await setState(JOB, { status: "running", last_run: new Date().toISOString(), detail: `done=${done} of ${skus.length}` });
  try {
    while (done < skus.length && Date.now() - t0 < BUDGET_MS) {
      const chunk = skus.slice(done, done + 100);
      const rows = [];
      for (const location of LOCATIONS) rows.push(...await fetchAll({ skuCode: chunk, location, date_from: "", date_to: "" }));
      written += await save(rows);
      done += chunk.length;
      log(`  ${done}/${skus.length} SKUs, ${rows.length} adjustments in this chunk, ${calls} calls`);
      await setState(JOB, { last_run: new Date().toISOString(), detail: `done=${done} of ${skus.length}; this run ${written} rows, ${calls} calls` });
    }
    const finished = done >= skus.length;
    await setState(JOB, { status: finished ? "done" : "paused", last_run: new Date().toISOString(), detail: `done=${done} of ${skus.length}; ${finished ? "complete" : "budget reached"}; this run ${written} rows, ${calls} calls` });
    log(finished ? "BACKFILL COMPLETE" : "budget reached; will continue next run");
    process.exit(0);
  } catch (e) {
    log("FAILED", e.message);
    await setState(JOB, { status: "error", detail: `done=${done} of ${skus.length}; ${e.message.slice(0, 600)}` }).catch(() => {});
    process.exit(1);
  }
}

// ---------- incremental: everything adjusted since the last run ----------
const JOB = "stock_adjustments";
const [state] = await sb(`sync_state?job=eq.${JOB}&select=watermark`);
const to = new Date();
const from = new Date((state?.watermark ? new Date(state.watermark).getTime() : to.getTime() - 7 * DAY) - TAIL_DAYS * DAY);
log(`incremental ${fmtIST(from)} -> ${fmtIST(to)}; locations ${LOCATIONS.join(",")}`);
await setState(JOB, { status: "running", last_run: new Date().toISOString(), detail: `window ${fmtIST(from)} -> ${fmtIST(to)}` });
try {
  let written = 0;
  for (let ws = from; ws < to; ws = new Date(ws.getTime() + WINDOW_DAYS * DAY)) {
    const we = new Date(Math.min(to.getTime(), ws.getTime() + WINDOW_DAYS * DAY - 1000));
    for (const location of LOCATIONS) {
      const rows = await fetchAll({ skuCode: [], location, date_from: fmtIST(ws), date_to: fmtIST(we) });
      written += await save(rows);
      log(`  ${location} ${fmtIST(ws).slice(0, 10)}..${fmtIST(we).slice(0, 10)}: ${rows.length} adjustments`);
    }
  }
  await sb("rpc/refresh_stock_aging", { method: "POST", body: {} }).catch(e => log("refresh_stock_aging failed:", e.message));
  await setState(JOB, { status: "ok", watermark: to.toISOString(), last_run: new Date().toISOString(), detail: `wrote ${written} rows; window ${fmtIST(from)} -> ${fmtIST(to)}; ${calls} calls` });
  log(`done: ${written} rows, ${calls} calls`);
} catch (e) {
  log("FAILED", e.message);
  await setState(JOB, { status: "error", detail: e.message.slice(0, 800) }).catch(() => {});
  process.exit(1);
}
