// "Ask anything" for the Mulmul sales dashboard — analyst mode.
// The model investigates with several read-only SQL queries (run_sql tool, up to MAX_STEPS), then writes a
// structured answer: headline, what the data shows (with numbers), recommendation, caveats.
// Secrets: ANTHROPIC_API_KEY. Optional: ANTHROPIC_MODEL (default claude-sonnet-5-5).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
const MAX_STEPS = 8;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text.slice(0, 600));
  return text ? JSON.parse(text) : null;
}

let schemaCache: { text: string; at: number } | null = null;
async function schemaText() {
  if (schemaCache && Date.now() - schemaCache.at < 10 * 60_000) return schemaCache.text;
  const cols: { view_name: string; column_name: string; data_type: string }[] = await sb("v_dashboard_schema?select=*");
  const byView = new Map<string, string[]>();
  for (const c of cols) byView.set(c.view_name, [...(byView.get(c.view_name) ?? []), `${c.column_name} ${c.data_type}`]);
  const text = [...byView.entries()].map(([v, cs]) => `${v}(${cs.join(", ")})`).join("\n");
  schemaCache = { text, at: Date.now() };
  return text;
}

const SEMANTICS = `
You are the merchandising analyst for Mulmul (premium Indian ethnic womenswear; ~26 stores + online in India/USA/UAE). You answer
questions by investigating the data with SQL (run_sql), then giving a decisive, numbers-backed answer with a recommendation.

DATA (PostgreSQL views; only these exist):
v_sales — one row per order line, Jan 2020 → today. is_sale=true = sold (false = cancelled/returned). channel 'Online'|'Store';
  location_code/location_name = store (NULL online). style_code (WW2601) + colour (UPPERCASE) = a style-colour; product_name 'Bairi Kurta'.
  category: Kurta, Pant, Chunni(dupatta), Saree, Lehenga, BLAZAR, SHOES…  size XS…3XL / kids '4/5'. sale_date (IST), week_start (Mon).
  segment: Classic/Festive/Kids/Bottom/Dupatta… net_value INR (unit price only on 2026+ lines). Sets: kurta WW2601, pant WWP2601, dupatta WWD2601.
v_daily_style_colour / v_weekly_style_colour — units by day/week, style, colour, channel (fast; prefer these for trends).
v_style_colour_summary — all-time per style-colour: units, online/store, orders, first/last sale, category, segment, collection, fabric.
v_store_style_colour — all-time units per store per style-colour.    v_size_style_colour — units per size per style-colour per channel.
v_stock_style_colour — CURRENT stock per style-colour: store_on_hand, wh_on_hand, intransit, in_production, vir_store.
v_stock_sku — CURRENT stock per SKU per location (location_name, location_type 'Store'|'WH', bin, size, qty)  → use for store-wise distribution.
v_replenishment_formula — the replenishment report (only styles the team put in the replenishment sheet): collection, fabric, planned_qty,
  total_sold, sell_through_pct (sold/planned), first_sale, days_selling, units_per_day, units_7d vs units_prev_7d, online/store units,
  formula_qty = units_per_day × 60-day lead × 1.5 buffer, on_hand, pipeline_qty, total_repl (ordered), after_repl_total, shortfall
  (formula − after_repl), coverage Short|Covered, days_of_cover, production_stage, expected_delivery, image_url.
v_launch_summary — totals per collection. v_monthly_channel — units by month × channel × category. settings, locations (store master).

BUSINESS RULES / DEFINITIONS the team uses:
- Sell-through % = sold ÷ (sold + current on hand) when there is no planned qty; = sold ÷ planned when planned_qty exists. Say which you used.
- Replenish when: formula_qty > on_hand + ordered (shortfall > 0) AND the style is still selling (units_7d > 0, trend not collapsing).
  Urgency = days_of_cover (on_hand ÷ daily rate) vs the 60-day production lead: < 30 days = urgent, 30–60 = order now, > 60 = can wait.
- Store distribution check: compare each store's share of CURRENT stock vs its share of SALES for that style (last 8–12 weeks and all-time);
  days of cover per store = store on hand ÷ store daily rate. Over-stocked = high stock share, low sales share, cover > 60 days;
  starved = sales share ≫ stock share or 0 on hand with recent sales. Recommend concrete transfers (from → to, qty) and warehouse top-ups.
- Size curve: compare size share of sales vs size share of on hand; sizes that sold ≥15% but have 0–1 left are broken sizes → flag.
- Compare launches by rate (units/day since first sale), not raw totals, when launch dates differ.
- "This week" = current ISO week (Mon–today, partial); last week = previous Mon–Sun. Normalise partial weeks to per-day when comparing.

HOW TO WORK:
1. Plan 2–5 queries that answer the question properly (overview → breakdown → stock/cover → trend). Run them with run_sql.
2. If a query returns 0 rows or looks wrong, do NOT conclude "no data": run a diagnostic (min/max date, distinct values, ILIKE on the name) and fix the filter.
3. Use CURRENT_DATE. Match names with ILIKE '%name%'. One SELECT per call, LIMIT ≤ 200, ORDER BY meaningfully. Round numbers.
4. Then STOP calling tools and write the answer in this exact markdown shape:
**Answer** — one or two sentences, a clear verdict (yes/no/which ones), no hedging.
**What the data shows** — 3–7 bullets, each with the key numbers (units, %, days of cover, dates).
**Recommendation** — specific actions: what to replenish/transfer/stop, quantities, from→to, priority order.
**Caveats** — 1–3 bullets only where they matter (small counts, partial week, missing planned qty, data to 'sales to' date).
Mark the ONE query whose rows the reader should see as the main table with show_table=true (usually the breakdown).`;

const TOOL = {
  name: "run_sql",
  description: "Run one read-only SQL SELECT against the dashboard views. Returns up to 200 rows (first 60 are echoed back to you).",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "What this query answers, e.g. 'Maru Kurta: stock vs sales share by store (12 wks)'" },
      sql: { type: "string" },
      show_table: { type: "boolean", description: "true for the one result the reader should see as the main table" },
      chart: { type: "object", description: "Optional chart hint for the main table", properties: { type: { type: "string", enum: ["bar", "line", "none"] }, x: { type: "string" }, y: { type: "array", items: { type: "string" } } } },
    },
    required: ["title", "sql"],
  },
};

async function claude(messages: unknown[], system: string, max_tokens = 2500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages, tools: [TOOL], tool_choice: { type: "auto" } }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}
async function runSql(sql: string) {
  return await sb("rpc/run_dashboard_query", { method: "POST", body: JSON.stringify({ q: sql, max_rows: 200 }) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY is not set in the edge function secrets" }, 500);
  let body: { question?: string; history?: { role: string; content: string }[] };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const question = (body.question ?? "").trim().slice(0, 1500);
  if (!question) return json({ error: "question required" }, 400);

  const t0 = Date.now();
  try {
    const system = `${SEMANTICS}\n\nToday is ${new Date().toISOString().slice(0, 10)}.\n\nSchema:\n${await schemaText()}`;
    const history = (body.history ?? []).slice(-6).map(h => ({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content).slice(0, 3000) }));
    const messages: unknown[] = [...history, { role: "user", content: question }];
    const queries: { title: string; sql: string; rows: unknown[]; row_count: number; error?: string; show_table?: boolean; chart?: unknown }[] = [];
    let answer = "";

    for (let step = 0; step < MAX_STEPS + 1; step++) {
      const resp = await claude(messages, system);
      const calls = resp.content.filter((c: { type: string }) => c.type === "tool_use");
      const text = resp.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n").trim();
      if (!calls.length || step === MAX_STEPS) { answer = text; break; }
      messages.push({ role: "assistant", content: resp.content });
      const results: unknown[] = [];
      for (const call of calls) {
        const input = call.input ?? {};
        let rows: unknown[] = [], error: string | undefined;
        try { rows = await runSql(input.sql); } catch (e) { error = String((e as Error).message).slice(0, 500); }
        queries.push({ title: input.title, sql: input.sql, rows, row_count: rows.length, error, show_table: !!input.show_table, chart: input.chart ?? null });
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: !!error,
          content: error ? `SQL error: ${error}` : `${rows.length} rows${rows.length > 60 ? " (first 60 shown)" : ""}: ${JSON.stringify(rows.slice(0, 60))}` });
      }
      messages.push({ role: "user", content: results });
    }
    if (!answer) answer = "I ran out of steps before finishing — try a narrower question.";
    const main = queries.filter(q => !q.error && q.rows.length).sort((a, b) => Number(b.show_table) - Number(a.show_table))[0];
    return json({
      answer, title: main?.title ?? null, sql: main?.sql ?? null, rows: main?.rows ?? [], row_count: main?.row_count ?? 0, chart: main?.chart ?? null,
      queries: queries.map(q => ({ title: q.title, sql: q.sql, row_count: q.row_count, error: q.error })),
      steps: queries.length, ms: Date.now() - t0, model: MODEL,
    });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
});
