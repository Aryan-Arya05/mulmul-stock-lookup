// "Ask anything" for the Mulmul sales dashboard.
// question -> Claude writes one read-only SQL over the analytical views -> run_dashboard_query() ->
// rows + a short written answer + a chart hint. Secrets: ANTHROPIC_API_KEY (set in Supabase edge secrets).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";

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
You write PostgreSQL for the Mulmul (premium Indian ethnic womenswear) sales dashboard. Only these views exist:

v_sales — one row per sold order line. Filter is_sale = true for units sold (false = cancelled/returned/pending).
  channel is 'Online' or 'Store'; location_code/location_name identify the store for Store sales (NULL for online).
  style_code (e.g. WW2601) + colour (UPPERCASE, e.g. 'RED', 'MATCHA GREEN') identify a style-colour. product_name e.g. 'Bairi Kurta'.
  category: Kurta, Pant, Chunni (dupatta), Saree, Lehenga, BLAZAR (waistcoat), SHOES... size: XS,S,M,L,XL,XXL,3XL or kids '4/5'.
  sale_date (date, IST), week_start (Monday). net_value is INR (online USD/AED storefronts carry their own currency).
  Top/bottom/dupatta of one set are separate style codes: kurta WW2601, pant WWP2601, dupatta WWD2601 — same number, letter P/D inserted.
v_weekly_style_colour / v_daily_style_colour — pre-aggregated units by week/day, style, colour, channel.
v_style_colour_summary — all-time totals per style-colour with collection & fabric (only replenished styles have collection/fabric).
v_store_style_colour — units per store per style-colour. v_size_style_colour — size curve.
v_stock_style_colour — current stock per style-colour: store_on_hand, wh_on_hand, intransit, in_production (manual 'virtual production' bin), vir_store.
v_stock_sku — stock per SKU per location/bin.
v_replenishment_formula — THE replenishment report, one row per replenished style-colour (the kurta/top):
  collection (launch name e.g. 'Karwachauth Drop 1'), fabric, total_sold, first_sale, days_selling, units_per_day,
  formula_qty = total_sold / days_selling * lead_days(60) * buffer(1.5)  (projected need),
  on_hand, pipeline_qty, total_repl (qty already ordered), after_repl_total = on_hand + total_repl,
  shortfall = formula_qty - after_repl_total (positive = need to make more), coverage 'Short'|'Covered', days_of_cover,
  units_7d vs units_prev_7d (trend), online_units/store_units,
  production_stage ('No replenishment','Ordered','Fabric / Embroidery','Cutting / Stitching','Delivered','Overdue' = past expected delivery but stock still in production), emb_fabric_date, cutting_date,
  expected_delivery, days_in_production, days_to_delivery, image_url.
v_launch_summary — totals per collection/launch.
settings — production_lead_days, buffer_multiplier. locations — store master (code, display_name, city, type).

ALWAYS answer by calling the run_sql tool with one query — never reply in prose without calling it.
Rules: one SELECT only, no CTE-less semicolons, max 200 rows (add LIMIT), ORDER BY something meaningful.
Match names case-insensitively with ILIKE '%name%'. "This week" = current ISO week; "last week" = previous Monday-Sunday.
When comparing styles, prefer rate metrics (units_per_day, units_7d) over raw totals when launch dates differ, and say so.
Use CURRENT_DATE for today. Round numerics. Never reference tables that are not listed.`;

const TOOL = {
  name: "run_sql",
  description: "Run one read-only SQL query against the dashboard views and show the result.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title for the result, e.g. 'Top 10 kurtas by units, last 2 weeks'" },
      sql: { type: "string" },
      chart: {
        type: "object",
        description: "Optional chart hint when the result is a series or ranking",
        properties: { type: { type: "string", enum: ["bar", "line", "none"] }, x: { type: "string" }, y: { type: "array", items: { type: "string" } } },
      },
      note: { type: "string", description: "One line on assumptions made (date range, what counts as 'better')." },
    },
    required: ["title", "sql"],
  },
};

async function claude(messages: unknown[], system: string, tools?: unknown[], tool_choice?: unknown, max_tokens = 1500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages, ...(tools ? { tools, tool_choice } : {}) }),
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
  const question = (body.question ?? "").trim().slice(0, 1000);
  if (!question) return json({ error: "question required" }, 400);

  try {
    const system = `${SEMANTICS}\n\nToday is ${new Date().toISOString().slice(0, 10)}.\n\nSchema:\n${await schemaText()}`;
    const history = (body.history ?? []).slice(-6).map(h => ({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content).slice(0, 2000) }));
    const messages: unknown[] = [...history, { role: "user", content: question }];

    // 1) write SQL
    let resp = await claude(messages, system, [TOOL], { type: "auto" });
    let call = resp.content.find((c: { type: string }) => c.type === "tool_use");
    if (!call) {
      const text = resp.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
      return json({ title: "Answer", answer: text || "I could not turn that into a query — try rephrasing with a style, period or metric.", sql: null, rows: [], row_count: 0 });
    }
    let input = call?.input ?? {};
    let rows: unknown[] = [];
    let error: string | null = null;
    try { rows = await runSql(input.sql); } catch (e) { error = String((e as Error).message); }

    // 2) one repair attempt if Postgres rejected it
    if (error) {
      messages.push({ role: "assistant", content: resp.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `SQL error: ${error}. Fix the query.`, is_error: true }] });
      resp = await claude(messages, system, [TOOL], { type: "auto" });
      call = resp.content.find((c: { type: string }) => c.type === "tool_use");
      input = call?.input ?? input;
      error = null;
      try { rows = await runSql(input.sql); } catch (e) { error = String((e as Error).message); }
    }
    if (error) return json({ error: `Could not answer: ${error}`, sql: input.sql, title: input.title }, 200);

    // 3) short written answer from the rows
    const sample = JSON.stringify(rows.slice(0, 60));
    const summary = await claude(
      [{ role: "user", content: `Question: ${question}\nQuery note: ${input.note ?? ""}\nRows (${rows.length} total, first 60 shown): ${sample}\n\nAnswer the question in 2-5 sentences for a merchandising team: lead with the finding, cite the key numbers, flag caveats (e.g. different launch dates, small counts). No markdown headers.` }],
      "You are a concise retail analyst for Mulmul. Plain prose, numbers inline.",
      undefined, undefined, 500,
    );
    const answer = summary.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n").trim();
    return json({ title: input.title, answer, sql: input.sql, chart: input.chart ?? null, note: input.note ?? null, rows, row_count: rows.length });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
});
