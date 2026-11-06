// Publishes the dashboard's read payloads as static JSON files in the public `dashboard` storage bucket.
// The page reads these from the CDN, so page loads never touch the database. Triggered by pg_cron after each
// snapshot refresh, and by the sync workflow after it writes new orders.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

async function get(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function rpc(name: string, args: unknown = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: H, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function put(name: string, data: unknown) {
  const body = JSON.stringify(data);
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/dashboard/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", "x-upsert": "true", "cache-control": "60" },
    body,
  });
  if (!r.ok) throw new Error(`upload ${name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return body.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  try {
    const monday = new Date(); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const since = new Date(monday.getTime() - 8 * 7 * 86400000).toISOString().slice(0, 10);
    const [launches, replenishment, products, weekly, storeTotals, sync, settings] = await Promise.all([
      get("v_launch_summary?select=*&order=launch_date.desc"),
      get("v_replenishment_formula?select=*&order=collection,top_name,colour"),
      rpc("dashboard_products"),
      rpc("dashboard_weekly", { since }),
      rpc("dashboard_store_totals"),
      get("sync_state?select=*"),
      get("settings?select=*"),
    ]);
    const generated_at = new Date().toISOString();
    const sizes: Record<string, number> = {};
    for (const [name, data] of Object.entries({ launches, replenishment, products, weekly, store_totals: storeTotals, sync: { sync, settings, generated_at } }))
      sizes[name] = await put(`${name}.json`, data);
    await put("meta.json", { generated_at, sizes, ms: Date.now() - t0 });
    return new Response(JSON.stringify({ ok: true, generated_at, sizes, ms: Date.now() - t0 }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
