// Upserts data/product_attributes.csv (one row per product name) into product_attributes.
// Source: the team's Attributes workbook (segment / fabric / silhouette / print type), cleaned and de-duplicated by name.
import fs from "node:fs";
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const text = fs.readFileSync(new URL("../data/product_attributes.csv", import.meta.url), "utf8");
const [head, ...lines] = text.trim().split(/\r?\n/);
const cols = head.split(",");
const parse = l => { const out=[]; let cur="", q=false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur=""; } else cur += ch; } out.push(cur); return out; };
const rows = lines.map(l => { const v = parse(l); const o = {}; cols.forEach((c,i) => o[c] = v[i] === "" ? null : v[i]); return o; });
for (let i = 0; i < rows.length; i += 500) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/product_attributes?on_conflict=name_key`, { method: "POST",
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.slice(i, i + 500)) });
  if (!r.ok) throw new Error(`product_attributes upsert: ${r.status} ${await r.text()}`);
}
console.log(`product_attributes: ${rows.length} rows upserted`);
