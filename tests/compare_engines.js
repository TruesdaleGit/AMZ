// Runs the same actions through the Python server and the in-browser JavaScript backend,
// then checks that both report the same state.   node tests/compare_engines.js
"use strict";
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const Backend = require("../static/backend.js");
const ROOT = path.join(__dirname, ".."), PORT = 8791, BASE = `http://127.0.0.1:${PORT}/api/`;
const sample = (name) => fs.readFileSync(path.join(ROOT, "sample_data", name), "utf8");

async function py(method, route, body) {
  const res = await fetch(BASE + route, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? { status: res.status, data: await res.json() } : { status: res.status, file: { bytes: new Uint8Array(await res.arrayBuffer()) } };
}
const js = (method, route, body) => Backend.request(method, route, body);

const IGNORE = new Set(["web", "site_built", "folder", "saved_at", "exported_at", "titles_shortened"]);
function diff(a, b, where, out) {
  if (typeof a === "number" && typeof b === "number") { if (Math.abs(a - b) > 0.011) out.push(`${where}: python ${a} vs js ${b}`); return; }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { if (a !== b) out.push(`${where}: python ${JSON.stringify(a)} vs js ${JSON.stringify(b)}`); return; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${where}: array vs object`); return; }
  if (Array.isArray(a) && a.length !== b.length) { out.push(`${where}: length ${a.length} vs ${b.length}`); return; }
  for (const key of new Set(Object.keys(a).concat(Object.keys(b)))) if (!IGNORE.has(key)) diff(a[key], b[key], `${where}.${key}`, out);
}

let failures = 0, checks = 0;
async function both(label, method, route, body) {
  const [p, j] = [await py(method, route, body), await js(method, route, body)];
  const out = [];
  if (p.status !== j.status) out.push(`status ${p.status} vs ${j.status}`);
  if (p.data !== undefined || j.data !== undefined) diff(p.data, j.data, "", out);
  checks += 1;
  if (out.length) { failures += 1; console.log(`MISMATCH ${label} (${method} ${route})\n  ` + out.slice(0, 12).join("\n  ") + (out.length > 12 ? `\n  ...and ${out.length - 12} more` : "")); }
  return [p, j];
}
const state = (label, days) => both(`state after ${label}, days=${days}`, "GET", "state?days=" + days);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-compare-"));
  const server = spawn("python3", [path.join(ROOT, "app.py")], { env: { ...process.env, SELLER_TOOLKIT_DB: path.join(dir, "t.db"), PORT: String(PORT), NO_BROWSER: "1" }, stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + "state"); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
    const isoDay = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

    await state("start", 30);
    await both("import products", "POST", "import/products", { csv: sample("products.csv") });
    await both("re-import", "POST", "import/products", { csv: sample("products.csv") });
    const long = 'ASIN,Title,Brand,Category,Price,ASIN Sales,Review Count,Reviews Rating,Weight,Image URL,URL\n'
      + 'B0TEST0001,"PawCalm Slow Feeder Lick Pad for Dogs & Cats, Anxiety Relief, Bathing and Grooming (2 Pack, Blue)",PawCalm,Pet Supplies,"$19.99","1,240",3800,4.7,0.4,https://example.com/a.jpg,\n'
      + 'B0TEST0002,"Halloween Costumes for Small Dogs - Pumpkin Outfit; Funny",,Pet Supplies,12.5,900,90,4.1,,,https://www.amazon.com/dp/B0TEST0002\n'
      + ',"ACME, Heavy Duty Garage Storage Shelving Unit 72 Inch 5 Tier",,Tools,189,60,45,4.4,62,,\n'
      + ',Compatible Ink Cartridges for HP 61,,Office Products,27.99,2000,5000,4.3,0.3,,\n,,,,,,,,,,\n'
      + ',"Resistance Loop Bands for Working Out with Handles and Door Anchor for Men and Women Home Gym",,Sports,25,300,200,4.2,1,,\n'
      + ',"Extraordinarily Supercalifragilistic Hyperdimensional Multifunctional Organizer Thing Extra Words",,Home,30,100,50,4.0,2,,\n'
      + ',"Kitchen Scale | Digital, with Bowl",,Home,18,400,900,4.5,1.2,,\n';
    await both("import long titles", "POST", "import/products", { csv: long });
    await both("import semicolon csv", "POST", "import/products", { csv: "Name;Price;Monthly Sales\nBamboo Drawer Divider;23,5;310\n" });
    await both("import without name column", "POST", "import/products", { csv: "Foo,Bar\n1,2\n" });
    await state("imports", 30);

    const [st] = await state("imports again", 0);
    const id = (name) => st.data.products.find((p) => p.name.startsWith(name)).id;
    const dog = id("Dog Lick Mat"), bands = id("Resistance Bands"), stand = id("Pour Over"), sink = id("Under Sink");

    await both("supplier 1", "POST", "suppliers", { name: "Shenzhen PetGoods Co", contact: "Lily", country: "China" });
    await both("supplier 2", "POST", "suppliers", { name: "Ningbo Silicone Ltd" });
    await both("supplier no name", "POST", "suppliers", { name: " " });
    await both("quote usd", "POST", "quotes", { product_id: dog, supplier_id: 1, unit_cost: "3.20", moq: 500, lead_time_days: 25, freight_per_unit: 0.9, duty_pct: 8 });
    await both("quote cny", "POST", "quotes", { product_id: dog, supplier_id: 2, unit_cost: 19, currency: "CNY", fx_rate: 0.14, moq: 1000, lead_time_days: 40, freight_per_unit: 1.1, duty_pct: 8, price_breaks: "2000: 18, 1000:19, x" });
    await both("quote no supplier", "POST", "quotes", { product_id: dog, unit_cost: 3 });
    await both("choose quote 2", "PUT", "quotes/2", { chosen: 1 });
    await both("choose quote 1", "PUT", "quotes/1", { chosen: 1 });
    await both("alibaba cost", "PUT", `products/${bands}`, { cost_low: "2.1", cost_high: "3.4", cost_moq: 300 });
    await both("alibaba one price", "PUT", `products/${stand}`, { cost_low: "", cost_high: 9 });
    await both("fees override", "PUT", `products/${sink}`, { fba_fee_override: 7.25, referral_pct: 12, stock_on_hand: 40 });
    await both("stock", "PUT", `products/${dog}`, { stock_on_hand: 300, status: "live", on_site: 1, checkout_url: "https://buy.stripe.com/test", images: "https://example.com/1.jpg\nhttps://example.com/2.jpg", image_url: "https://example.com/1.jpg" });
    await state("quotes and costs", 30);

    await both("import sales", "POST", "import/sales", { csv: sample("sales.csv") });
    await both("recent sales", "POST", "import/sales", { csv: `Date,Product,Units,Revenue,Ad Spend,Refunds,Sales Tax\n${isoDay(3)},Dog Lick Mat with Suction Cups,40,999.6,120,24.99,61.2\n${isoDay(12)},Resistance Bands for Seniors,22,473,90,0,0\n13/40/2026,Dog Lick Mat with Suction Cups,1,1,0,0,0\n${isoDay(400)},Nope,1,1,0,0,0\n` });
    await both("sale by hand", "POST", "sales", { product_id: sink, units: 3, revenue: 104.97, date: isoDay(1) });
    await both("overhead", "POST", "overheads", { name: "Helium 10", monthly_amount: 99 });
    await both("overhead 2", "POST", "overheads", { name: "Storage", monthly_amount: "45.50" });
    for (const days of [30, 90, 365, 0]) await state("sales", days);

    await both("po", "POST", "purchase_orders", { product_id: dog, supplier_id: 1, quantity: 500, unit_cost: 3.33, freight_total: 450, deposit_pct: 30, order_date: isoDay(-5), balance_due_date: isoDay(-40), expected_arrival: isoDay(-70) });
    await both("po 2", "POST", "purchase_orders", { product_id: bands, quantity: 300, unit_cost: 2.75, order_date: "", status: "planned" });
    await both("po 3 received", "POST", "purchase_orders", { product_id: sink, quantity: 120, unit_cost: 9, status: "received", order_date: isoDay(60) });
    await both("po receive", "PUT", "purchase_orders/1", { status: "received", units_received: 480 });
    await both("po receive again", "PUT", "purchase_orders/1", { status: "received" });
    await both("po reopen", "PUT", "purchase_orders/1", { status: "shipped" });
    await both("cash settings", "PUT", "settings", { starting_cash: "2500", sales_growth_pct: "5", payout_delay_days: "10", bogus: "x" });
    await state("orders", 30);

    await both("keywords", "POST", "import/keywords", { product_id: dog, csv: sample("keywords.csv") });
    await both("keywords again", "POST", "import/keywords", { product_id: dog, csv: sample("keywords.csv") });
    await both("keyword by hand", "POST", "keywords", { product_id: dog, keyword: "lick pad", search_volume: 80 });
    await both("ads", "POST", "import/ads", { product_id: dog, csv: sample("ads.csv") });
    await both("ads undated", "POST", "import/ads", { product_id: dog, csv: "Campaign,Targeting,Clicks,Spend,Sales\nAuto,*,10,12.5,0\nAuto,b,0,0,0\n" });
    await both("tasks", "POST", "tasks/template", { product_id: dog });
    await both("tasks again", "POST", "tasks/template", { product_id: dog });
    await both("task done", "PUT", "tasks/2", { done: true });
    await both("competitor", "POST", "competitors", { product_id: dog, name: "LickiMat", asin: "B000TEST01" });
    await both("snapshot", "POST", "snapshots", { competitor_id: 1, date: "2026-10-01", price: 14.99, reviews: 5200, rating: 4.4 });
    await both("snapshot 2", "POST", "snapshots", { competitor_id: 1, date: "2026-11-10", price: 12.99, reviews: 5810, rating: 4.4 });
    await both("reviews", "POST", "reviews", { product_id: dog, text: "The suction cups won't stay on the tub, it slides around.\nBroke after a week, very flimsy silicone.\nGreat mat my dog loves it\nToo small for a large dog and it fell off the wall\nFlimsy silicone and it smells like chemical\nok" });
    await both("reviews update", "POST", "reviews", { product_id: dog, text: "Flimsy plastic, broke fast.\n\nFlimsy plastic and it leaks everywhere, total waste of money!\n\nLove it works great every single day" });
    for (const days of [30, 0]) await state("research", days);

    await both("listing", "POST", "listings", { product_id: dog, brand: "PawCalm", features: "Stays put: strong suction cups grip tile and tubs\neasy to clean: dishwasher safe silicone.\nCalms pets\nSlows eating: raised ridges make treats last\nTwo textures: for spreads and kibble\nextra: ignored", keywords: "slow feeder, anxiety relief, peanut butter mat, dog lick mat" });
    await both("kw to listing", "POST", "keywords/to-listing", { product_id: dog, count: 5 });
    await both("draft", "POST", "listings/draft", { product_id: dog });
    await both("version", "POST", "listings/version", { product_id: dog, label: " first " });
    await both("bad listing", "POST", "listings", { product_id: dog, title: "PawCalm BEST SELLER mat!! mat mat mat #1", bullet1: "lowercase start with free shipping", search_terms: "pawcalm, mat " + "x".repeat(260), aplus: "Made to last | Food-grade silicone\nnot a section" });
    await state("bad listing", 30);
    await both("restore", "POST", "listings/restore", { version_id: 1 });
    await both("draft without listing", "POST", "listings/draft", { product_id: stand });
    await both("outreach", "POST", "outreach", { product_id: dog, supplier_id: 1, quantity: "1,500", target_price: 3 });
    await both("outreach plain", "POST", "outreach", { product_id: sink });
    await both("weights", "PUT", "settings", { w_demand: "50", w_size: "0", capture_share_pct: "40", min_monthly_profit: "600", store_theme: "ocean", about_text: "We make calm.\nSince 2026.", contact_email: "hello@example.com" });
    await both("drop", "POST", "products/drop", { ids: [id("Compatible Ink"), "abc"] });
    await both("shortlist", "POST", "products/shortlist-proceed", {});
    for (const days of [30, 0]) await state("listing and settings", days);

    // Backups: each engine must be able to restore the other's file and end up in the same state.
    const pyBackup = (await py("GET", "backup")).data;   // served as JSON, so already parsed
    const jsBackup = JSON.parse(new TextDecoder().decode((await js("GET", "backup")).file.bytes));
    await py("POST", "restore", { backup: jsBackup });
    await js("POST", "restore", { backup: pyBackup });
    for (const days of [30, 0]) await state("swapping backups", days);
    await both("restore rubbish", "POST", "restore", { backup: { format: "other" } });
    await both("add after restore", "POST", "suppliers", { name: "After Restore Ltd" });

    const [pf, jf] = await both("flat file", "GET", "export/flatfile");
    const text = (r) => new TextDecoder().decode(r.file.bytes);
    checks += 1;
    if (text(pf) !== text(jf)) { failures += 1; console.log("MISMATCH flat file text\n" + text(pf) + "\n---\n" + text(jf)); }
    await both("site build", "POST", "site/build", {});
    await both("delete quote", "DELETE", "quotes/2");
    await both("delete supplier", "DELETE", "suppliers/1");
    await both("delete product", "DELETE", `products/${dog}`);
    await both("unknown table", "POST", "nothing", {});
    for (const days of [30, 0]) await state("deletes", days);
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures ? `${failures} of ${checks} comparisons differ` : `All ${checks} comparisons match`);
  process.exit(failures ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
