// Data gateway for the Sales · Replenishment · Production dashboard.
// The caller sends their Mulmul Threads sign-in token. This function asks the Threads database whether that
// person may open the "sales" dashboard and, only if so, runs one of a fixed list of read-only requests
// against this project with the service key. It does its own authentication, so the platform JWT check is off.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const THREADS_URL = "https://zcnthnhdwdtxalijrcik.supabase.co";
const THREADS_KEY = "sb_publishable_FWivcWTl1QYFEXl5A6akMA_V2hbQcSD"; // public key of the Threads project
const DASHBOARD = "sales";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ORIGINS = new Set(["https://aryan-arya05.github.io", "https://sales.mulmul.co", "https://threads.mulmul.co"]);
const RPCS = new Set(["dashboard_inward_stores", "dashboard_inwards", "dashboard_period", "dashboard_period_daily", "dashboard_products",
  "dashboard_stock_aging", "dashboard_stock_aging_detail", "dashboard_stock_intransit", "dashboard_stock_transfers",
  "dashboard_store_totals", "dashboard_stores", "dashboard_weekly", "dashboard_dist_overview_cached", "dashboard_dist_plan",
  "dashboard_store", "dashboard_store_matrix", "dashboard_sku_store_matrix", "dashboard_sets", "dashboard_set_fill", "dashboard_stock_transfer_skus"]);
const VIEWS = new Set(["v_daily_style_colour", "v_size_style_colour", "v_stock_sku", "v_store_style_colour", "v_weekly_style_colour",
  "v_replenishment_formula", "v_launch_summary", "sync_state", "settings"]);
const SNAPS = new Set(["launches", "products", "replenishment", "store_totals", "sync", "weekly"]);

function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.has(o) ? o : "https://aryan-arya05.github.io",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function reply(req: Request, status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req), ...extra },
  });
}

// Remember each token's answer for a minute so one page load does not ask Threads a dozen times.
const seen = new Map<string, { ok: boolean; until: number }>();
async function mayOpen(token: string): Promise<"yes" | "no" | "signin"> {
  const hit = seen.get(token);
  if (hit && hit.until > Date.now()) return hit.ok ? "yes" : "no";
  const r = await fetch(`${THREADS_URL}/rest/v1/rpc/can_open_dashboard`, {
    method: "POST",
    headers: { apikey: THREADS_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ d: DASHBOARD }),
  });
  if (r.status === 401 || r.status === 403) { await r.body?.cancel(); return "signin"; }
  if (!r.ok) { await r.body?.cancel(); throw new Error(`access check failed (${r.status})`); }
  const ok = (await r.json()) === true;
  if (seen.size > 500) seen.clear();
  seen.set(token, { ok, until: Date.now() + 60_000 });
  return ok ? "yes" : "no";
}

const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "POST only" });
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token.split(".").length !== 3) return reply(req, 401, { error: "Sign in with your Mulmul Threads account.", code: "signin" });
  let who: "yes" | "no" | "signin";
  try { who = await mayOpen(token); } catch (e) { return reply(req, 503, { error: String((e as Error).message) }); }
  if (who === "signin") return reply(req, 401, { error: "Your sign-in has expired. Sign in again.", code: "signin" });
  if (who === "no") return reply(req, 403, { error: "This dashboard has not been shared with you.", code: "no_access" });

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return reply(req, 400, { error: "Body must be JSON" }); }
  const op = String(b.op ?? "");
  try {
    if (op === "whoami") return reply(req, 200, { ok: true });

    if (op === "rpc") {
      const name = String(b.name ?? "");
      if (!RPCS.has(name)) return reply(req, 400, { error: "Unknown request" });
      const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: { ...svc, "Content-Type": "application/json" }, body: JSON.stringify(b.args ?? {}) });
      return reply(req, r.status, await r.text());
    }

    if (op === "rest") {
      const path = String(b.path ?? "");
      const view = path.split("?")[0];
      if (!VIEWS.has(view) || /[\r\n]/.test(path) || /select=[^&]*\(/.test(path)) return reply(req, 400, { error: "Unknown request" });
      const h: Record<string, string> = { ...svc };
      if (typeof b.range === "string" && /^\d+-\d+$/.test(b.range)) { h.Range = b.range; h.Prefer = "count=none"; }
      const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: h });
      return reply(req, r.status === 206 ? 200 : r.status, await r.text());
    }

    if (op === "snap") {
      const name = String(b.name ?? "");
      if (!SNAPS.has(name)) return reply(req, 400, { error: "Unknown request" });
      const r = await fetch(`${SB_URL}/storage/v1/object/dashboard/${name}.json`, { headers: svc });
      if (!r.ok) { await r.body?.cancel(); return reply(req, 404, { error: "No snapshot" }); }
      return reply(req, 200, await r.text());
    }

    if (op === "ask") {
      const r = await fetch(`${SB_URL}/functions/v1/ask-sales`, { method: "POST", headers: { ...svc, "Content-Type": "application/json" }, body: JSON.stringify(b.payload ?? {}) });
      return reply(req, r.status, await r.text());
    }
    return reply(req, 400, { error: "Unknown request" });
  } catch (e) {
    return reply(req, 502, { error: String((e as Error).message) });
  }
});
