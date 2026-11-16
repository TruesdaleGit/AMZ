"use strict";
// In-browser backend for the iPhone / web version: the same API as app.py, with the data kept on the device.
// tests/compare_engines.js runs this and the Python server on the same data and compares the results.
(function (root) {

const Core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.Core;
const { num, r1, r2 } = Core;

// ------------------------------------------------------------------ schema
// column: [kind, default]. kinds: t text, n number, o optional number (null = not set), f flag, s server-owned
const T = (d = "") => ["t", d], N = (d = 0) => ["n", d], O = ["o", null], F = ["f", 0];
const TABLES = {
  products: { name: T(), description: T(), asin: T(), ref_url: T(), thumb_url: T(), category: T(), price: N(), monthly_sales: N(),
    reviews: N(), rating: N(), weight_lb: N(), length_in: N(), width_in: N(), height_in: N(), referral_pct: O, fba_fee_override: O,
    cost_low: O, cost_high: O, cost_moq: N(), status: T("idea"), stock_on_hand: N(), image_url: T(), images: T(), amazon_url: T(),
    checkout_url: T(), on_site: F, notes: T() },
  suppliers: { name: T(), contact: T(), country: T(), url: T(), notes: T() },
  quotes: { product_id: N(null), supplier_id: O, unit_cost: N(), currency: T("USD"), fx_rate: N(1), price_breaks: T(), moq: N(),
    lead_time_days: N(), freight_per_unit: N(), duty_pct: N(), other_per_unit: N(), sample_status: T("not requested"),
    sample_cost: N(), sample_notes: T(), sample_photo: T(), chosen: F, notes: T() },
  listings: { product_id: N(null), brand: T(), sku: T(), features: T(), keywords: T(), title: T(), bullet1: T(), bullet2: T(),
    bullet3: T(), bullet4: T(), bullet5: T(), description: T(), search_terms: T(), aplus: T() },
  listing_versions: { listing_id: ["s", null], saved_at: ["s", ""], label: ["s", ""], data: ["s", ""] },
  sales: { product_id: N(null), date: T(), units: N(), revenue: N(), ad_spend: N(), refunds: N(), sales_tax: N() },
  keywords: { product_id: N(null), keyword: T(), search_volume: N(), competing_products: N(), notes: T() },
  competitors: { product_id: N(null), name: T(), asin: T(), url: T(), notes: T() },
  snapshots: { competitor_id: N(null), date: T(), price: N(), reviews: N(), rating: N() },
  tasks: { product_id: N(null), title: T(), done: F, due_date: T(), position: N() },
  purchase_orders: { product_id: N(null), supplier_id: O, quantity: N(), unit_cost: N(), deposit_pct: N(30), freight_total: N(),
    order_date: T(), balance_due_date: T(), expected_arrival: T(), status: T("planned"), tracking: T(), units_received: N(),
    stock_added: ["s", 0], notes: T() },
  ads: { product_id: N(null), date: T(), campaign: T(), keyword: T(), impressions: N(), clicks: N(), spend: N(), sales: N(), orders: N() },
  overheads: { name: T(), monthly_amount: N(), notes: T() },
  reviews: { product_id: N(null), text: T() },
};
const REQUIRED = { products: "name", suppliers: "name", keywords: "keyword", competitors: "name", tasks: "title", overheads: "name" };
const CHILDREN = {   // deleting a row deletes these: [table, column]
  products: [["quotes", "product_id"], ["listings", "product_id"], ["sales", "product_id"], ["keywords", "product_id"],
    ["competitors", "product_id"], ["tasks", "product_id"], ["purchase_orders", "product_id"], ["ads", "product_id"], ["reviews", "product_id"]],
  suppliers: [["quotes", "supplier_id"]],
  competitors: [["snapshots", "competitor_id"]],
  listings: [["listing_versions", "listing_id"]],
};

class ApiError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => new Date();
const daysAgo = (n) => { const d = today(); d.setDate(d.getDate() - n); return iso(d); };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] || 0), 0);

// ------------------------------------------------------------------- store

function emptyDb() {
  const db = { tables: {}, seq: {}, settings: Object.assign({}, Core.DEFAULT_SETTINGS) };
  for (const t of Object.keys(TABLES)) { db.tables[t] = []; db.seq[t] = 0; }
  return db;
}
// Bring a stored or imported database up to the current schema.
function upgrade(db) {
  const fresh = emptyDb();
  db.tables = db.tables || {}; db.seq = db.seq || {};
  db.settings = Object.assign({}, fresh.settings, db.settings || {});
  for (const t of Object.keys(TABLES)) {
    db.tables[t] = Array.isArray(db.tables[t]) ? db.tables[t] : [];
    for (const row of db.tables[t]) for (const c of Object.keys(TABLES[t])) if (row[c] === undefined) row[c] = TABLES[t][c][1];
    db.seq[t] = Math.max(db.seq[t] || 0, ...db.tables[t].map((r) => r.id || 0));
  }
  return db;
}

let memory = null;            // used under Node, and as a fallback if the browser refuses storage
const hasIdb = typeof indexedDB !== "undefined";
function idb(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("seller-toolkit", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode), request = work(tx.objectStore("kv"));
      tx.oncomplete = () => { open.result.close(); resolve(request.result); };
      tx.onerror = tx.onabort = () => { open.result.close(); reject(tx.error); };
    };
  });
}
let DB = null, built = null;   // built: the last generated website, kept in memory for the zip
async function loadDb() {
  if (DB) return DB;
  let stored = memory;
  if (hasIdb) { try { stored = await idb("readonly", (s) => s.get("db")); } catch (e) { stored = memory; } }
  DB = upgrade(stored || emptyDb());
  return DB;
}
async function saveDb() {
  memory = DB;
  if (hasIdb) await idb("readwrite", (s) => s.put(DB, "db"));
}

// ------------------------------------------------------------------ writes

const rowsOf = (t) => DB.tables[t];
const byId = (t, id) => DB.tables[t].find((r) => r.id === Number(id));
const isFlag = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "on";

function cleanFields(table, data) {
  const out = {};
  for (const [column, [kind]] of Object.entries(TABLES[table])) {
    if (kind === "s" || !(column in data)) continue;
    const value = data[column];
    if (kind === "t") out[column] = value === null || value === undefined ? "" : String(value).trim();
    else if (kind === "o") out[column] = value === null || value === undefined || value === "" ? null : num(value);
    else if (kind === "f") out[column] = isFlag(value) ? 1 : 0;
    else out[column] = num(value);
  }
  return out;
}

function createRow(table, data) {
  const fields = cleanFields(table, data);
  const required = REQUIRED[table];
  if (required && !fields[required]) throw new ApiError(`A ${required} is required.`);
  if ((table === "sales" || table === "snapshots") && !fields.date) fields.date = iso(today());
  if ("product_id" in TABLES[table] && !fields.product_id) throw new ApiError("Choose a product.");
  if (table === "quotes" && !fields.supplier_id) throw new ApiError("Choose a supplier.");
  if (table === "snapshots" && !fields.competitor_id) throw new ApiError("Choose a competitor.");
  const row = { id: ++DB.seq[table] };
  for (const [column, [, def]] of Object.entries(TABLES[table])) row[column] = column in fields ? fields[column] : def;
  rowsOf(table).push(row);
  if (table === "quotes" && row.chosen) unchooseOthers(row);
  if (table === "purchase_orders") receiveOrder(row);
  return row.id;
}

function updateRow(table, id, data) {
  const fields = cleanFields(table, data), row = byId(table, id);
  if (!Object.keys(fields).length || !row) return;
  const required = REQUIRED[table];
  if (required && required in fields && !fields[required]) throw new ApiError(`A ${required} is required.`);
  Object.assign(row, fields);
  if (table === "quotes" && fields.chosen) unchooseOthers(row);
  if (table === "purchase_orders") receiveOrder(row);
}

function deleteRow(table, id) {
  id = Number(id);
  DB.tables[table] = rowsOf(table).filter((r) => r.id !== id);
  for (const [child, column] of CHILDREN[table] || []) {
    for (const row of rowsOf(child).filter((r) => r[column] === id)) deleteRow(child, row.id);
  }
  if (table === "suppliers") for (const order of rowsOf("purchase_orders")) if (order.supplier_id === id) order.supplier_id = null;
}

const unchooseOthers = (quote) => { for (const q of rowsOf("quotes")) if (q.id !== quote.id && q.product_id === quote.product_id) q.chosen = 0; };

// The first time an order is marked received, add its units to stock.
function receiveOrder(order) {
  if (order.status !== "received" || order.stock_added) return;
  const units = order.units_received || order.quantity || 0, product = byId("products", order.product_id);
  if (product) product.stock_on_hand = (product.stock_on_hand || 0) + units;
  order.stock_added = 1; order.units_received = units;
}

// ------------------------------------------------------------------- views

const copy = (rows) => rows.map((r) => Object.assign({}, r));

function buildState(days) {
  const settings = DB.settings;
  const products = copy(rowsOf("products")).sort((a, b) => b.id - a.id);
  const suppliers = copy(rowsOf("suppliers")).sort((a, b) => cmp(a.name, b.name));
  const quotes = copy(rowsOf("quotes")).sort((a, b) => a.id - b.id);
  const listings = copy(rowsOf("listings"));
  const supplierNames = new Map(suppliers.map((s) => [s.id, s.name])), productNames = new Map(products.map((p) => [p.id, p.name]));

  const quotesByProduct = new Map();
  for (const quote of quotes) {
    quote.landed_cost = Core.landedCost(quote);
    quote.tiers = Core.priceBreaks(quote);
    quote.supplier_name = supplierNames.has(quote.supplier_id) ? supplierNames.get(quote.supplier_id) : "?";
    if (!quotesByProduct.has(quote.product_id)) quotesByProduct.set(quote.product_id, []);
    quotesByProduct.get(quote.product_id).push(quote);
  }

  const chosen = new Map();
  for (const product of products) {
    const mine = quotesByProduct.get(product.id) || [], quote = Core.pickQuote(mine);
    chosen.set(product.id, quote);
    const eco = Core.unitEconomics(product, quote, settings);
    product.eco = eco;
    product.score = Core.opportunityScore(product, eco, settings);
    product.min_price = Core.minPriceForMargin(product, quote, settings);
    product.scenarios = Core.priceScenarios(product, quote, settings);
    const asin = String(product.asin || "").trim().toUpperCase();
    product.link = product.ref_url || (/^[A-Z0-9]{10}$/.test(asin) ? `https://www.amazon.com/dp/${asin}` : "");
    product.alibaba_url = Core.alibabaSearchUrl(product);
    product.listed_cost = Core.listedCost(product, settings);
    product.potential = Core.profitPotential(product, eco, quote, settings);
    product.filter_reasons = product.status === "dropped" ? [] : Core.filterMatches(product, settings);
    product.quote_count = mine.length;
    product.active_quote_id = quote ? quote.id : null;
  }
  Core.rankProducts(products);

  const versions = rowsOf("listing_versions").map((v) => ({ id: v.id, listing_id: v.listing_id, saved_at: v.saved_at, label: v.label })).sort((a, b) => b.id - a.id);
  for (const listing of listings) {
    listing.issues = Core.validateListing(listing);
    listing.versions = versions.filter((v) => v.listing_id === listing.id);
  }

  const keywords = copy(rowsOf("keywords"));
  for (const k of keywords) k.priority = Core.keywordPriority(k.search_volume, k.competing_products);
  keywords.sort((a, b) => (b.priority - a.priority) || (b.search_volume - a.search_volume));

  const competitors = copy(rowsOf("competitors")).sort((a, b) => cmp(a.name, b.name));
  const snapshots = copy(rowsOf("snapshots")).sort((a, b) => cmp(a.date, b.date) || (a.id - b.id));
  for (const c of competitors) c.snapshots = snapshots.filter((s) => s.competitor_id === c.id);

  const orders = copy(rowsOf("purchase_orders")).sort((a, b) => ((a.order_date === "") - (b.order_date === "")) || cmp(b.order_date, a.order_date) || (b.id - a.id));
  for (const order of orders) {
    const goods = order.quantity * order.unit_cost;
    order.goods_cost = r2(goods);
    order.deposit = r2(goods * order.deposit_pct / 100);
    order.balance = r2(goods - order.deposit + order.freight_total);
    order.total_cost = r2(goods + order.freight_total);
    order.product_name = productNames.has(order.product_id) ? productNames.get(order.product_id) : "?";
    order.supplier_name = supplierNames.get(order.supplier_id) || "";
  }

  const reviews = copy(rowsOf("reviews"));
  for (const review of reviews) review.analysis = Core.analyzeReviews(review.text);

  const overheads = copy(rowsOf("overheads")).sort((a, b) => cmp(a.name, b.name));
  return {
    settings: Object.assign({}, settings), products, suppliers, quotes, listings, keywords, competitors,
    tasks: copy(rowsOf("tasks")).sort((a, b) => (a.position - b.position) || (a.id - b.id)),
    orders, reviews, overheads,
    ads: buildAds(products, days),
    cashflow: buildCashflow(products, orders, overheads, settings),
    dashboard: buildDashboard(products, chosen, settings, days, overheads),
    site_built: !!built, today: iso(today()), web: true,
  };
}

// Sales totals per product for rows on or after a date.
function salesBy(since, keyOf) {
  const groups = new Map();
  for (const s of rowsOf("sales")) {
    if (s.date < since) continue;
    const key = keyOf(s);
    if (!groups.has(key)) groups.set(key, { product_id: s.product_id, month: s.date.slice(0, 7), units: 0, revenue: 0, ad_spend: 0, refunds: 0, sales_tax: 0 });
    const g = groups.get(key);
    for (const f of ["units", "revenue", "ad_spend", "refunds", "sales_tax"]) g[f] += s[f] || 0;
  }
  return groups;
}

function salesProfit(row, eco) {
  const units = row.units || 0, revenue = row.revenue || 0;
  const fees = revenue * eco.referral_pct / 100 + units * eco.fba_fee, cogs = units * eco.landed_cost;
  const ad = row.ad_spend || 0, refunds = row.refunds || 0;
  return { units, revenue, fees, cogs, ad, refunds, profit: revenue - fees - cogs - ad - refunds };
}

function buildDashboard(products, chosen, settings, days, overheads) {
  const since = days ? daysAgo(days) : "0000-00-00";
  const window = salesBy(since, (s) => s.product_id), recent = salesBy(daysAgo(30), (s) => s.product_id);
  const byProduct = new Map(products.map((p) => [p.id, p]));

  const perProduct = [], inventory = [];
  const totals = { units: 0, revenue: 0, amazon_fees: 0, cogs: 0, ad_spend: 0, refunds: 0, profit: 0 };
  let assumed = false, salesTax = 0;
  for (const product of products) {
    const eco = product.eco, sold = window.get(product.id);
    if (sold) {
      const x = salesProfit(sold, eco);
      salesTax += sold.sales_tax || 0;
      assumed = assumed || eco.cost_source === "assumed";
      const row = { product_id: product.id, name: product.name, units: x.units, revenue: r2(x.revenue), amazon_fees: r2(x.fees),
        cogs: r2(x.cogs), ad_spend: r2(x.ad), refunds: r2(x.refunds), profit: r2(x.profit),
        margin_pct: x.revenue ? r1(x.profit / x.revenue * 100) : 0, tacos_pct: x.revenue ? r1(x.ad / x.revenue * 100) : 0,
        break_even_acos_pct: eco.break_even_acos_pct, cost_source: eco.cost_source };
      perProduct.push(row);
      for (const key of Object.keys(totals)) totals[key] += row[key];
    }

    const velocity = (recent.has(product.id) ? recent.get(product.id).units : 0) / 30, stock = product.stock_on_hand || 0;
    if (velocity > 0 || stock > 0) {
      const quote = chosen.get(product.id) || {};
      const lead = quote.lead_time_days || 30, safety = num(settings.safety_stock_days, 14), cover = num(settings.reorder_cover_days, 60);
      const reorderPoint = Math.ceil(velocity * (lead + safety));
      const status = velocity === 0 ? "no recent sales" : stock <= 0 ? "out of stock" : stock <= reorderPoint ? "reorder now" : "ok";
      inventory.push({ product_id: product.id, name: product.name, stock, daily_velocity: r2(velocity),
        days_left: velocity ? r1(stock / velocity) : null, lead_time_days: lead, lead_source: quote.lead_time_days ? "quote" : "default",
        reorder_point: reorderPoint, suggested_order: Math.max(Math.ceil(velocity * cover), Math.trunc(quote.moq || 0)), status });
    }
  }

  // Overheads are monthly; charge them for the length of the period shown.
  const monthlyOverhead = sum(overheads, "monthly_amount");
  const firstSale = rowsOf("sales").reduce((m, s) => (m === null || s.date < m ? s.date : m), null);
  let periodDays = 0;
  if (days) periodDays = days;
  else if (firstSale) periodDays = Math.round((Date.parse(iso(today()) + "T00:00:00Z") - Date.parse(firstSale.slice(0, 10) + "T00:00:00Z")) / 86400000) + 1;
  const overhead = totals.revenue || days ? monthlyOverhead * periodDays / 30 : 0;

  perProduct.sort((a, b) => b.profit - a.profit);
  totals.product_profit = totals.profit;
  totals.overheads = overhead;
  totals.profit -= overhead;
  totals.sales_tax = salesTax;
  for (const key of Object.keys(totals)) totals[key] = r2(totals[key]);
  totals.margin_pct = totals.revenue ? r1(totals.profit / totals.revenue * 100) : 0;
  totals.tacos_pct = totals.revenue ? r1(totals.ad_spend / totals.revenue * 100) : 0;

  // Month-by-month trend, last 12 months that have sales.
  const months = new Map();
  for (const g of salesBy("", (s) => s.date.slice(0, 7) + "|" + s.product_id).values()) {
    const product = byProduct.get(g.product_id);
    if (!product) continue;
    const x = salesProfit(g, product.eco);
    if (!months.has(g.month)) months.set(g.month, { month: g.month, units: 0, revenue: 0, profit: -monthlyOverhead });
    const m = months.get(g.month);
    m.units += x.units; m.revenue += x.revenue; m.profit += x.profit;
  }
  const monthly = [...months.values()].sort((a, b) => cmp(a.month, b.month)).slice(-12)
    .map((m) => Object.assign({}, m, { revenue: r2(m.revenue), profit: r2(m.profit) }));

  return { days, totals, per_product: perProduct, inventory, monthly, monthly_overhead: r2(monthlyOverhead),
    uses_assumed_cost: assumed, sales_rows: rowsOf("sales").length };
}

// Ad performance by campaign and keyword, judged against each product's break-even.
function buildAds(products, days) {
  const since = days ? daysAgo(days) : "", byProduct = new Map(products.map((p) => [p.id, p])), groups = new Map();
  for (const a of rowsOf("ads")) {
    if (a.date !== "" && a.date < since) continue;
    const key = JSON.stringify([a.product_id, a.campaign, a.keyword]);
    if (!groups.has(key)) groups.set(key, { product_id: a.product_id, campaign: a.campaign, keyword: a.keyword, impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 });
    const g = groups.get(key);
    for (const f of ["impressions", "clicks", "spend", "sales", "orders"]) g[f] += a[f] || 0;
  }
  const out = [];
  for (const g of [...groups.values()].sort((a, b) => (a.product_id - b.product_id) || cmp(a.campaign, b.campaign) || cmp(a.keyword, b.keyword))) {
    const product = byProduct.get(g.product_id);
    if (!product) continue;
    const breakEven = product.eco.break_even_acos_pct, acos = g.sales ? g.spend / g.sales * 100 : null;
    const verdict = g.spend <= 0 ? "no spend" : acos === null ? "no sales" : acos > breakEven ? "losing money" : acos > breakEven * 0.7 ? "thin" : "profitable";
    out.push({ product_id: g.product_id, campaign: g.campaign, keyword: g.keyword, impressions: g.impressions, clicks: g.clicks,
      spend: r2(g.spend), sales: r2(g.sales), orders: g.orders, acos_pct: acos === null ? null : r1(acos),
      cpc: g.clicks ? r2(g.spend / g.clicks) : null, break_even_acos_pct: breakEven, verdict,
      net: r2(g.sales * breakEven / 100 - g.spend) });   // what the spend cost after the margin it earned back
  }
  return out.sort((a, b) => a.net - b.net);
}

// Six-month cash projection from recent sales pace, planned orders and overheads.
function buildCashflow(products, orders, overheads, settings, months = 6) {
  const now = today(), todayIso = iso(now), recent = salesBy(daysAgo(30), (s) => s.product_id);
  let dailyPayout = 0;
  for (const product of products) {
    const sold = recent.get(product.id);
    if (!sold || !sold.units) continue;
    const eco = product.eco, adShare = sold.revenue ? (sold.ad_spend || 0) / sold.revenue : 0;
    dailyPayout += sold.units / 30 * (eco.price * (1 - adShare) - eco.referral_fee - eco.fba_fee);
  }
  const growth = num(settings.sales_growth_pct) / 100;
  const delay = Math.min(Math.max(num(settings.payout_delay_days, 14), 0), 30) / 30;
  const monthlyOverhead = sum(overheads, "monthly_amount");

  const payments = {};
  let undated = 0;
  for (const order of orders) {
    if (order.status === "cancelled" || order.status === "received") continue;
    for (const [date, amount] of [[order.order_date, order.deposit], [order.balance_due_date || order.expected_arrival || order.order_date, order.balance]]) {
      if (amount <= 0) continue;
      if (!date) undated += 1;
      else if (date >= todayIso) payments[date.slice(0, 7)] = (payments[date.slice(0, 7)] || 0) + amount;
    }
  }

  let cash = num(settings.starting_cash), previous = dailyPayout * 30;
  const rows = [];
  for (let i = 0; i < months; i++) {
    const first = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const counted = i === 0 ? length - (now.getDate() - 1) : length;
    const earned = dailyPayout * counted * Math.pow(1 + growth, i);
    const inflow = earned * (1 - delay) + previous * delay;
    previous = earned;
    const key = `${first.getFullYear()}-${pad(first.getMonth() + 1)}`, po = payments[key] || 0, overhead = monthlyOverhead * counted / length;
    cash += inflow - po - overhead;
    rows.push({ month: key, inflow: r2(inflow), po_payments: r2(po), overheads: r2(overhead), net: r2(inflow - po - overhead), ending_cash: r2(cash) });
  }
  return { rows, daily_payout: r2(dailyPayout), undated_payments: undated, starting_cash: num(settings.starting_cash) };
}

// ----------------------------------------------------------------- imports

function parseDate(text) {
  text = String(text || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const make = (y, mo, d) => { const dt = new Date(y, mo - 1, d); return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? iso(dt) : null; };
  if (m) return make(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(text);
  if (m) { const y = m[3].length === 2 ? (+m[3] < 69 ? 2000 + +m[3] : 1900 + +m[3]) : +m[3]; return make(y, +m[1], +m[2]) || make(y, +m[2], +m[1]); }
  m = /^([A-Za-z]{3}) (\d{1,2}), (\d{4})$/.exec(text);
  if (m) { const mo = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(m[1].toLowerCase()) / 3 + 1; return mo >= 1 && Number.isInteger(mo) ? make(+m[3], mo, +m[2]) : null; }
  return null;
}

function importProducts(text) {
  const [parsed, fields] = Core.parseCsv(text, Core.PRODUCT_ALIASES);
  if (!fields.includes("name")) throw new ApiError("No product name column found. Expected a header such as Name, Title or Product Name.");
  const seenNames = new Set(), seenAsins = new Set();
  for (const p of rowsOf("products")) {
    for (const v of [p.name, p.description]) if (v.trim()) seenNames.add(v.trim().toLowerCase());
    if (p.asin) seenAsins.add(p.asin.trim().toLowerCase());
  }
  let added = 0, skipped = 0, duplicates = 0;
  for (const row of parsed) {
    const name = (row.name || "").trim().toLowerCase(), asin = (row.asin || "").trim().toLowerCase();
    if (!name) skipped += 1;
    else if (seenNames.has(name) || (asin && seenAsins.has(asin))) duplicates += 1;
    else {
      const full = Core.squash(row.name);
      row.name = Core.shortTitle(full, row.brand);
      row.description = full !== row.name ? full : "";
      createRow("products", row);
      seenNames.add(name); seenNames.add(row.name.toLowerCase());
      if (asin) seenAsins.add(asin);
      added += 1;
    }
  }
  return { added, skipped, duplicates, columns_used: fields };
}

function importSales(text) {
  const [parsed, fields] = Core.parseCsv(text, Core.SALES_ALIASES);
  const missing = ["date", "product", "units", "revenue"].filter((f) => !fields.includes(f));
  if (missing.length) throw new ApiError("Missing column(s): " + missing.join(", ") + ". Needed: date, product, units, revenue.");
  const lookup = new Map();
  for (const p of rowsOf("products")) {
    lookup.set(p.name.trim().toLowerCase(), p.id);
    if (p.description) lookup.set(p.description.trim().toLowerCase(), p.id);
    if (p.asin) lookup.set(p.asin.trim().toLowerCase(), p.id);
  }
  let added = 0;
  const unmatched = [];
  for (const row of parsed) {
    const productId = lookup.get((row.product || "").trim().toLowerCase());
    if (!productId) { if (row.product && !unmatched.includes(row.product)) unmatched.push(row.product); continue; }
    const date = parseDate(row.date);
    if (!date) { unmatched.push(`bad date: ${row.date}`); continue; }
    createRow("sales", Object.assign({}, row, { product_id: productId, date }));
    added += 1;
  }
  return { added, unmatched: unmatched.slice(0, 20), columns_used: fields };
}

function importKeywords(productId, text) {
  if (!byId("products", productId)) throw new ApiError("Choose a product.");
  const [parsed, fields] = Core.parseCsv(text, Core.KEYWORD_ALIASES);
  if (!fields.includes("keyword")) throw new ApiError("No keyword column found. Expected a header such as Keyword or Keyword Phrase.");
  const have = new Set(rowsOf("keywords").filter((k) => k.product_id === Number(productId)).map((k) => k.keyword.trim().toLowerCase()));
  let added = 0, duplicates = 0;
  for (const row of parsed) {
    const key = (row.keyword || "").trim().toLowerCase();
    if (!key) continue;
    if (have.has(key)) { duplicates += 1; continue; }
    createRow("keywords", Object.assign({}, row, { product_id: productId }));
    have.add(key); added += 1;
  }
  return { added, duplicates, columns_used: fields };
}

function importAds(productId, text) {
  if (!byId("products", productId)) throw new ApiError("Choose a product.");
  const [parsed, fields] = Core.parseCsv(text, Core.ADS_ALIASES);
  const missing = ["spend", "sales"].filter((f) => !fields.includes(f));
  if (missing.length) throw new ApiError("Missing column(s): " + missing.join(", ") + ". Needed at least: spend, sales.");
  for (const row of parsed) createRow("ads", Object.assign({}, row, { date: parseDate(row.date) || "", product_id: productId }));
  return { added: parsed.length, columns_used: fields };
}

// ---------------------------------------------------------- other actions

const STANDARD_TASKS = ["Validate demand and competition", "Check patents and trademarks", "Request quotes from 3 suppliers",
  "Order and review samples", "Choose supplier and negotiate terms", "Register brand name and buy UPC/GTIN",
  "Design logo and packaging", "Place first purchase order", "Arrange product inspection",
  "Book freight and prepare FBA shipment", "Take product photos", "Write and check the listing",
  "Create the listing in Seller Central", "Shipment received at Amazon", "Start ad campaigns",
  "Request first reviews", "Publish the product on the website"];

function addStandardTasks(productId) {
  const mine = rowsOf("tasks").filter((t) => t.product_id === Number(productId)), have = new Set(mine.map((t) => t.title));
  const start = Math.max(0, ...mine.map((t) => t.position));
  let added = 0;
  for (const title of STANDARD_TASKS) if (!have.has(title)) { added += 1; createRow("tasks", { product_id: productId, title, position: start + added }); }
  return { added };
}

const listingOf = (productId) => rowsOf("listings").find((l) => l.product_id === Number(productId));

function keywordsToListing(productId, count) {
  const top = rowsOf("keywords").filter((k) => k.product_id === Number(productId));
  if (!top.length) throw new ApiError("This product has no keywords yet.");
  const n = Math.max(Math.trunc(num(count) || 15), 1);
  const ranked = top.map((k) => [Core.keywordPriority(k.search_volume, k.competing_products), k]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  const text = ranked.slice(0, n).map((k) => k.keyword).join(", "), listing = listingOf(productId);
  if (listing) updateRow("listings", listing.id, { keywords: text });
  else createRow("listings", { product_id: productId, keywords: text, brand: DB.settings.brand || "" });
  return { count: Math.min(top.length, n) };
}

const LISTING_CONTENT = ["brand", "sku", "features", "keywords", "title", "bullet1", "bullet2", "bullet3", "bullet4", "bullet5", "description", "search_terms", "aplus"];

function saveVersion(productId, label) {
  const listing = listingOf(productId);
  if (!listing) throw new ApiError("Save the listing first.");
  const data = {};
  for (const k of LISTING_CONTENT) data[k] = listing[k];
  const d = today();
  rowsOf("listing_versions").push({ id: ++DB.seq.listing_versions, listing_id: listing.id,
    saved_at: `${iso(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`, label: String(label || "").trim(), data: JSON.stringify(data) });
  return { ok: true };
}

function restoreVersion(versionId) {
  const version = byId("listing_versions", versionId);
  if (!version) throw new ApiError("Version not found.", 404);
  updateRow("listings", version.listing_id, JSON.parse(version.data));
  return { ok: true };
}

function draftListing(productId) {
  const product = byId("products", productId);
  if (!product) throw new ApiError("Product not found.", 404);
  const listing = listingOf(productId);
  if (!listing) throw new ApiError("Save the listing inputs first.");
  const brand = listing.brand || DB.settings.brand || "";
  updateRow("listings", listing.id, Object.assign(Core.draftListing(brand, product.name, listing.features, listing.keywords), { brand }));
}

function outreachMessage(data) {
  const product = byId("products", data.product_id);
  if (!product) throw new ApiError("Choose a product.");
  const supplier = byId("suppliers", data.supplier_id), settings = DB.settings;
  const quantity = Math.trunc(num(data.quantity, 500)), target = num(data.target_price), fmt = (n) => n.toLocaleString("en-US");
  const who = [settings.your_name, settings.company].filter(Boolean).join(" at "), what = product.name.toLowerCase();
  const g = (n) => String(Number(n));
  const lines = [
    supplier ? `Hello ${supplier.contact || supplier.name},` : "Hello,", "",
    who ? `I am ${who} and I am sourcing a ${what} to sell under our own brand in the US.` : `I am sourcing a ${what} to sell under our own brand in the US.`,
    `Our first order would be about ${fmt(quantity)} units, with regular reorders if quality is consistent.`, "",
    "Could you please send:",
    `1. Unit price at ${fmt(quantity)}, ${fmt(quantity * 2)} and ${fmt(quantity * 5)} units` + (target ? ` (our target is $${target.toFixed(2)} per unit)` : ""),
    "2. Minimum order quantity for custom logo and custom packaging",
    "3. Production lead time after deposit, and sample lead time",
    "4. Sample cost including express shipping to the US",
    "5. Carton size, units per carton and carton weight",
    "6. Certifications and test reports you hold for this product",
    "7. Payment terms, and whether you accept Trade Assurance", "",
  ];
  if (product.length_in && product.width_in && product.height_in) {
    lines.push(`Target size is about ${g(product.length_in)} x ${g(product.width_in)} x ${g(product.height_in)} in` + (product.weight_lb ? `, ${g(product.weight_lb)} lb.` : "."), "");
  }
  lines.push("Thank you,", settings.your_name || "[Your name]");
  return lines.join("\n");
}

// Tab-separated export of every listing, using Amazon's common attribute names.
function flatFile() {
  const columns = ["item_sku", "item_name", "brand_name", "standard_price", "bullet_point1", "bullet_point2", "bullet_point3",
    "bullet_point4", "bullet_point5", "product_description", "generic_keywords", "main_image_url"];
  const clean = (v) => Core.squash(v === null || v === undefined ? "" : v);
  const cell = (v) => (/["\t\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const rows = rowsOf("listings").map((l) => [l, byId("products", l.product_id)]).filter((x) => x[1]).sort((a, b) => cmp(a[1].name, b[1].name));
  const lines = [columns.join("\t")];
  for (const [l, p] of rows) {
    lines.push([clean(l.sku) || Core.slugify(p.name).toUpperCase(), clean(l.title), clean(l.brand), (p.price || 0).toFixed(2), clean(l.bullet1),
      clean(l.bullet2), clean(l.bullet3), clean(l.bullet4), clean(l.bullet5), clean(l.description), clean(l.search_terms),
      clean(p.image_url.startsWith("data:") ? "" : p.image_url)].map(cell).join("\t"));
  }
  return lines.join("\n") + "\n";
}

function shortlistProceed() {
  let moved = 0;
  for (const p of buildState(0).products) {
    if (p.status === "idea" && p.potential.verdict === "proceed") { byId("products", p.id).status = "shortlist"; moved += 1; }
  }
  return { moved };
}

// ------------------------------------------------------------ zip and xlsx

const utf8 = (s) => new TextEncoder().encode(s);
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// A zip archive with the files stored uncompressed. files: [[name, Uint8Array | string]]
function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = typeof content === "string" ? utf8(content) : content, nameBytes = utf8(name), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);   // flag: UTF-8 names
    local.setUint16(8, 0, true); local.setUint16(10, 0, true); local.setUint16(12, 0x21, true);              // stored; date 1980-01-01
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true); header.setUint16(4, 20, true); header.setUint16(6, 20, true); header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true); header.setUint16(12, 0, true); header.setUint16(14, 0x21, true);
    header.setUint32(16, crc, true); header.setUint32(20, data.length, true); header.setUint32(24, data.length, true);
    header.setUint16(28, nameBytes.length, true); header.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(header.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = chunks.concat(central, [new Uint8Array(end.buffer)]), out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colName = (i) => { let name = ""; i += 1; while (i) { const rem = (i - 1) % 26; name = String.fromCharCode(65 + rem) + name; i = (i - 1 - rem) / 26; } return name; };
function xlsxCell(ref, value, bold) {
  const style = bold ? ' s="1"' : "";
  if (typeof value === "boolean") value = value ? 1 : 0;
  if (typeof value === "number") return `<c r="${ref}"${style}><v>${value}</v></c>`;
  if (value === null || value === undefined || value === "") return "";
  const text = [...String(value)].filter((ch) => "\t\n\r".includes(ch) || ch.codePointAt(0) >= 32).join("");
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}
// The bytes of an .xlsx file with one sheet and a bold, frozen header row.
function workbook(headers, rows, sheetName) {
  const lines = ['<row r="1">' + headers.map((h, i) => xlsxCell(colName(i) + "1", h, true)).join("") + "</row>"];
  rows.forEach((row, r) => lines.push(`<row r="${r + 2}">` + row.map((v, i) => xlsxCell(colName(i) + (r + 2), v)).join("") + "</row>"));
  const widths = headers.map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(String(h).length + 4, 12), 40)}" customWidth="1"/>`).join("");
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main", rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships", pkg = "http://schemas.openxmlformats.org/package/2006";
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zip([
    ["[Content_Types].xml", `${head}<Types xmlns="${pkg}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `${head}<Relationships xmlns="${pkg}/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${head}<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="${xml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${head}<Relationships xmlns="${pkg}/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `${head}<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ["xl/worksheets/sheet1.xml", `${head}<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${lines.join("")}</sheetData></worksheet>`],
  ]);
}

const pretty = (h) => { const s = h.replace(/_/g, " "); return s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase(); };
const titled = (s) => s.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// One table as an Excel workbook, with names in place of internal ids.
function exportTable(table) {
  if (!TABLES[table] || table === "listing_versions" || table === "reviews") throw new ApiError("Not found.", 404);
  const computed = table === "products" ? new Map(buildState(0).products.map((p) => [p.id, p])) : null;
  const nameMap = (t) => new Map(rowsOf(t).map((r) => [r.id, r.name]));
  const lookup = { product_id: ["product", nameMap("products")], supplier_id: ["supplier", nameMap("suppliers")], competitor_id: ["competitor", nameMap("competitors")] };
  const columns = Object.keys(TABLES[table]).filter((c) => c !== "stock_added");
  const extra = computed ? ["score", "profit_per_unit", "margin_pct", "landed_cost", "fba_fee"] : [];
  const rows = copy(rowsOf(table)).sort((a, b) => a.id - b.id).map((row) => {
    const line = columns.map((c) => (lookup[c] ? (lookup[c][1].has(row[c]) ? lookup[c][1].get(row[c]) : "") : row[c]));
    if (computed) { const p = computed.get(row.id); line.push(p.score.score, p.eco.profit, p.eco.margin_pct, p.eco.landed_cost, p.eco.fba_fee); }
    return line;
  });
  return workbook(columns.map((c) => (lookup[c] ? lookup[c][0] : c)).concat(extra).map(pretty), rows, titled(table));
}

function exportRanking() {
  const headers = ["Rank", "Product", "Verdict", "Reason", "Est. units / month", "Share of top seller %", "Profit / unit after ads",
    "Margin after ads %", "Est. monthly profit", "First order units", "Investment", "Payback months", "Annual ROI %", "Things to check", "Status"];
  const rows = Core.rankProducts(buildState(0).products).map((p) => { const x = p.potential; return [x.rank, p.name, x.verdict, x.why, x.est_units,
    x.share_pct, x.unit_profit_after_ads, x.margin_after_ads_pct, x.monthly_profit, x.first_order, x.investment, x.payback_months,
    x.annual_roi_pct, x.flags.join("; "), p.status]; });
  return workbook(headers, rows, "Profit ranking");
}

// --------------------------------------------------------------- storefront

const THEMES = { forest: ["#1f5f4a", "#ffffff", "#58b598", "#0f1f1a"], ocean: ["#1d5a8f", "#ffffff", "#6aaee6", "#0c1a27"],
  clay: ["#a4472a", "#ffffff", "#e58f72", "#27110a"], ink: ["#1c1b19", "#ffffff", "#f0efec", "#161614"] };
const SITE_CSS = `:root{--bg:#faf9f6;--card:#fff;--ink:#1c1b19;--muted:#66645e;--line:#e4e1d9;--accent:@@accent@@;--accent-ink:@@accent_ink@@}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#f0efec;--muted:#a9a79f;--line:#33322e;--accent:@@accent_dark@@;--accent-ink:@@accent_dark_ink@@}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
header,main,footer{max-width:1040px;margin:0 auto;padding:0 20px}
header{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between;align-items:baseline;padding-top:28px;padding-bottom:20px;border-bottom:1px solid var(--line)}
header .name{text-decoration:none;font-weight:700;font-size:1.25rem;letter-spacing:-.01em}
header nav{display:flex;gap:20px;font-size:.95rem}
header nav a{text-decoration:none;color:var(--muted)}
header nav a:hover{color:var(--ink)}
.hero{padding:56px 0 32px}
.hero h1{font-size:clamp(2rem,5vw,3rem);line-height:1.1;margin:0 0 12px;letter-spacing:-.02em;text-wrap:balance}
.hero p{color:var(--muted);max-width:52ch;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:20px;padding:16px 0 56px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;text-decoration:none;display:flex;flex-direction:column}
.card:hover{border-color:var(--accent)}
.thumb{aspect-ratio:1;background:var(--line);display:grid;place-items:center;color:var(--muted);font-size:.85rem}
.thumb img,.photo img{width:100%;height:100%;object-fit:cover;display:block}
.card div.body{padding:14px 16px 18px}
.card h2{font-size:1rem;margin:0 0 6px;line-height:1.35}
.price{font-weight:700;font-variant-numeric:tabular-nums}
.product{display:grid;grid-template-columns:1fr 1fr;gap:40px;padding:40px 0 32px}
.photo{aspect-ratio:1;background:var(--line);border-radius:12px;overflow:hidden;display:grid;place-items:center;color:var(--muted)}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.thumbs button{width:64px;height:64px;padding:0;border:2px solid var(--line);border-radius:8px;overflow:hidden;background:none;cursor:pointer}
.thumbs button[aria-current=true]{border-color:var(--accent)}
.thumbs img{width:100%;height:100%;object-fit:cover;display:block}
.product h1{font-size:1.7rem;line-height:1.2;margin:0 0 10px;letter-spacing:-.01em}
.product .price{font-size:1.4rem;margin:0 0 20px}
.product ul{padding-left:20px;margin:0 0 24px}
.product li{margin-bottom:8px}
.buy{display:inline-block;background:var(--accent);color:var(--accent-ink);padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:600}
.soon{display:inline-block;border:1px solid var(--line);color:var(--muted);padding:12px 24px;border-radius:8px}
.desc{color:var(--muted);margin-top:24px}
.more{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;padding:8px 0 40px}
.more section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
.more h2{font-size:1.05rem;margin:0 0 6px}
.more p{margin:0;color:var(--muted)}
.back{display:inline-block;margin:0 0 48px;color:var(--muted);font-size:.9rem}
.page{max-width:68ch;padding:48px 0 64px}
.page h1{font-size:2rem;letter-spacing:-.02em;margin:0 0 16px}
.page p{margin:0 0 16px}
footer{border-top:1px solid var(--line);padding-top:20px;padding-bottom:40px;color:var(--muted);font-size:.85rem}
.empty{padding:40px 0 80px;color:var(--muted)}
@media (max-width:720px){.product{grid-template-columns:1fr;gap:24px}}
`;
const GALLERY_JS = `<script>
document.querySelectorAll('.thumbs button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelector('.photo img').src = b.querySelector('img').src;
    document.querySelectorAll('.thumbs button').forEach(function (o) { o.setAttribute('aria-current', o === b); });
  });
});
</script>`;
const he = (text) => String(text === null || text === undefined ? "" : text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const safeUrl = (url) => { url = String(url || "").trim(); return /^https?:\/\//i.test(url) ? url : ""; };
const paragraphs = (text) => String(text || "").split("\n").filter((p) => p.trim()).map((p) => `<p>${he(p.trim())}</p>`).join("");
const shorten = (text, limit = 155) => { text = Core.squash(text); if (text.length <= limit) return text; const cut = text.slice(0, limit - 1), at = cut.lastIndexOf(" "); return (at > 0 ? cut.slice(0, at) : cut) + "…"; };
function productImages(product) {
  const seen = new Set(), out = [];
  for (let url of [product.image_url || ""].concat(String(product.images || "").split(/\r\n|\r|\n/))) { url = url.trim(); if (url && !seen.has(url)) { seen.add(url); out.push(url); } }
  return out;
}
function dataUrlBytes(url) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(url);
  if (!m) return null;
  const raw = atob(m[2]), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { ext: m[1].toLowerCase().replace("jpeg", "jpg"), bytes };
}

// Build the customer-facing website. Returns { files: [[path, content]], summary }.
function buildSite() {
  const settings = DB.settings, store = settings.store_name || "Store", tagline = settings.store_tagline || "";
  const description = settings.store_description || tagline, warnings = [], files = [], pictures = new Map();
  const theme = THEMES[settings.store_theme] || THEMES.forest;
  let css = SITE_CSS;
  ["accent", "accent_ink", "accent_dark", "accent_dark_ink"].forEach((name, i) => { css = css.replace(`@@${name}@@`, theme[i]); });
  files.push(["style.css", css.trim() + "\n"]);

  const about = String(settings.about_text || "").trim(), contactEmail = String(settings.contact_email || "").trim(), contactText = String(settings.contact_text || "").trim();
  const nav = [["Shop", "index.html"]];
  if (about) nav.push(["About", "about.html"]);
  if (contactEmail || contactText) nav.push(["Contact", "contact.html"]);

  // Photos added on this device are stored inside the data; write them out as image files.
  const image = (url, base) => {
    if (url.startsWith("data:")) {
      if (!pictures.has(url)) { const d = dataUrlBytes(url); if (!d) return ""; const name = `images/photo-${pictures.size + 1}.${d.ext}`; pictures.set(url, name); files.push([name, d.bytes]); }
      return base + pictures.get(url);
    }
    return safeUrl(url);
  };
  const page = (path, title, desc, body, base = "", ogImage = "", extraHead = "") => {
    const links = nav.map(([label, href]) => `<a href="${base}${href}">${he(label)}</a>`).join("");
    const og = ogImage.startsWith("http") ? `\n<meta property="og:image" content="${he(ogImage)}">` : "";
    files.push([path, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${he(title)}</title>
<meta name="description" content="${he(shorten(desc))}">
<meta property="og:title" content="${he(title)}">
<meta property="og:description" content="${he(shorten(desc))}">
<meta property="og:site_name" content="${he(store)}">${og}
<link rel="stylesheet" href="${base}style.css">${extraHead}
</head>
<body>
<header><a class="name" href="${base}index.html">${he(store)}</a><nav>${links}</nav></header>
<main>
${body}
</main>
<footer>&copy; ${he(store)}</footer>
</body>
</html>
`]);
  };

  const products = copy(rowsOf("products")).filter((p) => p.on_site).sort((a, b) => cmp(a.name, b.name));
  const cards = [], pages = ["index.html"], seen = new Set();
  for (const product of products) {
    const listing = listingOf(product.id) || {}, title = listing.title || product.name;
    let slug = Core.slugify(product.name);
    while (seen.has(slug)) slug += "-" + product.id;
    seen.add(slug);
    const price = "$" + Number(product.price || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const checkout = safeUrl(product.checkout_url), amazon = safeUrl(product.amazon_url);
    let button;
    if (checkout) button = `<a class="buy" href="${he(checkout)}">Buy now</a>`;
    else if (amazon) button = `<a class="buy" href="${he(amazon)}" rel="noopener">Buy on Amazon</a>`;
    else { button = '<span class="soon">Coming soon</span>'; warnings.push(`${product.name}: no checkout or Amazon link, so it shows 'Coming soon'.`); }
    if (!listing.title) warnings.push(`${product.name}: no listing written yet, so the page has only a name and price.`);

    const urls = productImages(product), images = urls.map((u) => image(u, "../")).filter(Boolean);
    if (!images.length) warnings.push(`${product.name}: no image.`);
    const alt = he(product.name);
    const photo = images.length ? `<img src="${he(images[0])}" alt="${alt}">` : "Photo coming soon";
    const thumbs = images.length > 1 ? '<div class="thumbs">' + images.map((src, i) => `<button type="button" aria-label="Photo ${i + 1}" aria-current="${i === 0 ? "true" : "false"}"><img src="${he(src)}" alt=""></button>`).join("") + "</div>" : "";

    const bullets = [1, 2, 3, 4, 5].filter((i) => listing["bullet" + i]).map((i) => `<li>${he(listing["bullet" + i])}</li>`).join("");
    const desc = listing.description ? `<p class="desc">${he(listing.description)}</p>` : "";
    let sections = "";
    for (const line of String(listing.aplus || "").split(/\r\n|\r|\n/)) {
      const i = line.indexOf("|"), head = i < 0 ? line : line.slice(0, i), text = i < 0 ? "" : line.slice(i + 1);
      if (head.trim() && text.trim()) sections += `<section><h2>${he(head.trim())}</h2><p>${he(text.trim())}</p></section>`;
    }
    const body = `<section class="product">
<div><div class="photo">${photo}</div>${thumbs}</div>
<div>
<h1>${he(title)}</h1>
<p class="price">${price}</p>
${bullets ? "<ul>" + bullets + "</ul>" : ""}
${button}
${desc}
</div>
</section>
${sections ? '<div class="more">' + sections + "</div>" : ""}
<a class="back" href="../index.html">&larr; All products</a>
${thumbs ? GALLERY_JS : ""}`;
    const summary = listing.description || listing.bullet1 || product.name;
    const schema = { "@context": "https://schema.org", "@type": "Product", name: title, description: shorten(summary, 300),
      offers: { "@type": "Offer", price: Number(product.price || 0).toFixed(2), priceCurrency: "USD" } };
    if (listing.brand) schema.brand = { "@type": "Brand", name: listing.brand };
    const absolute = images.filter((i) => i.startsWith("http"));
    if (absolute.length) schema.image = absolute;
    const head = '\n<script type="application/ld+json">' + JSON.stringify(schema).replace(/<\//g, "<\\/") + "</script>";
    page(`products/${slug}.html`, `${product.name} | ${store}`, summary, body, "../", absolute.length ? absolute[0] : "", head);
    pages.push(`products/${slug}.html`);

    const cardImage = urls.length ? image(urls[0], "") : "";
    cards.push(`<a class="card" href="products/${slug}.html">
<div class="thumb">${cardImage ? `<img src="${he(cardImage)}" alt="${alt}" loading="lazy">` : "No photo yet"}</div>
<div class="body"><h2>${he(product.name)}</h2><span class="price">${price}</span></div>
</a>`);
  }
  const grid = cards.length ? `<section class="grid">${cards.join("")}</section>` : '<p class="empty">No products are published yet.</p>';
  page("index.html", store, description, `<section class="hero"><h1>${he(store)}</h1><p>${he(tagline)}</p></section>\n${grid}`);
  if (about) { page("about.html", `About | ${store}`, about, `<section class="page"><h1>About ${he(store)}</h1>${paragraphs(about)}</section>`); pages.push("about.html"); }
  if (contactEmail || contactText) {
    const email = contactEmail ? `<p><a href="mailto:${he(contactEmail)}">${he(contactEmail)}</a></p>` : "";
    page("contact.html", `Contact | ${store}`, contactText || `Contact ${store}`, `<section class="page"><h1>Contact</h1>${paragraphs(contactText)}${email}</section>`);
    pages.push("contact.html");
  }
  return { files, summary: { folder: "storefront.zip (use Download as zip)", pages, products: products.length, warnings } };
}

// ------------------------------------------------------------------ backup

function makeBackup() {
  return { format: "seller-toolkit-backup", version: 1, exported_at: new Date().toISOString(), tables: DB.tables, settings: DB.settings };
}
function restoreBackup(backup) {
  if (!backup || backup.format !== "seller-toolkit-backup" || typeof backup.tables !== "object") throw new ApiError("That file is not a Seller Toolkit backup.");
  const tables = {};
  for (const t of Object.keys(TABLES)) tables[t] = Array.isArray(backup.tables[t]) ? backup.tables[t].filter((r) => r && Number.isInteger(r.id)) : [];
  DB = upgrade({ tables, seq: {}, settings: Object.assign({}, backup.settings || {}) });
  built = null;
  return { ok: true, products: DB.tables.products.length };
}

// ------------------------------------------------------------------ routes

const file = (name, type, bytes) => ({ file: { name, type, bytes: typeof bytes === "string" ? utf8(bytes) : bytes } });

function route(method, parts, query, data) {
  const path = parts.join("/");
  if (method === "GET") {
    if (path === "state") return buildState(Math.trunc(num(query.days, 30)));
    if (path === "export/flatfile") return file("amazon-listings.txt", "text/tab-separated-values", flatFile());
    if (path === "backup") return file(`seller-toolkit-backup-${iso(today())}.json`, "application/json", JSON.stringify(makeBackup()));
    if (path === "site/zip") { if (!built) throw new ApiError("Build the site first.", 404); return file("storefront.zip", "application/zip", zip(built.files)); }
    if (path === "export/ranking.xlsx") return file("profit-ranking.xlsx", XLSX_TYPE, exportRanking());
    if (parts.length === 2 && parts[0] === "export" && parts[1].endsWith(".xlsx")) return file(parts[1], XLSX_TYPE, exportTable(parts[1].slice(0, -5)));
    throw new ApiError("Not found.", 404);
  }
  if (method === "PUT" && path === "settings") {
    for (const [key, value] of Object.entries(data)) if (key in Core.DEFAULT_SETTINGS) DB.settings[key] = String(value).trim();
    return { ok: true };
  }
  if (method === "POST") {
    switch (path) {
      case "restore": return restoreBackup(data.backup);
      case "import/products": return importProducts(data.csv || "");
      case "import/sales": return importSales(data.csv || "");
      case "import/keywords": return importKeywords(data.product_id, data.csv || "");
      case "import/ads": return importAds(data.product_id, data.csv || "");
      case "ads/clear": DB.tables.ads = rowsOf("ads").filter((a) => a.product_id !== Number(data.product_id)); return { ok: true };
      case "tasks/template": return addStandardTasks(data.product_id);
      case "keywords/to-listing": return keywordsToListing(data.product_id, data.count);
      case "listings/version": return saveVersion(data.product_id, data.label);
      case "listings/restore": return restoreVersion(data.version_id);
      case "listings/draft": draftListing(data.product_id); return { ok: true };
      case "outreach": return { message: outreachMessage(data) };
      case "site/build": built = buildSite(); return built.summary;
      case "products/drop": { const ids = (data.ids || []).filter((i) => /^\d+$/.test(String(i))).map(Number); for (const id of ids) { const p = byId("products", id); if (p) p.status = "dropped"; } return { dropped: ids.length }; }
      case "products/shortlist-proceed": return shortlistProceed();
      case "upload": {   // on this device a photo is stored inside the data itself, as a data: URL
        const url = String(data.data || "");
        if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url)) throw new ApiError("Only PNG, JPG, WEBP or GIF images can be uploaded.");
        if (url.length > 3000000) throw new ApiError("That image is too large to store on this device.");
        return { url };
      }
      case "reviews": { const existing = rowsOf("reviews").find((r) => r.product_id === Number(data.product_id)); if (existing) { updateRow("reviews", existing.id, { text: data.text }); return { id: existing.id }; } return { id: createRow("reviews", data) }; }
      default:
    }
  }
  if (method === "DELETE" && parts.length === 2 && parts[0] === "listing_versions" && /^\d+$/.test(parts[1])) { deleteRow("listing_versions", parts[1]); return { ok: true }; }

  const table = parts[0];
  if (!TABLES[table] || table === "listing_versions") throw new ApiError("Not found.", 404);
  if (method === "POST" && parts.length === 1) {
    if (table === "listings") { const existing = listingOf(data.product_id); if (existing) { updateRow(table, existing.id, data); return { id: existing.id }; } }
    return { id: createRow(table, data) };
  }
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    if (method === "PUT") { updateRow(table, parts[1], data); return { ok: true }; }
    if (method === "DELETE") { deleteRow(table, parts[1]); return { ok: true }; }
  }
  throw new ApiError("Not found.", 404);
}

// The one entry point. Resolves to { status, data } or { status, file: { name, type, bytes } }.
async function request(method, path, body) {
  await loadDb();
  const [pathname, search = ""] = path.split("?"), query = {};
  for (const pair of search.split("&").filter(Boolean)) { const [k, v = ""] = pair.split("="); query[decodeURIComponent(k)] = decodeURIComponent(v); }
  const snapshot = method === "GET" ? null : JSON.stringify(DB);   // a failed write must leave nothing half-done
  try {
    const result = route(method, pathname.split("/").filter(Boolean), query, body || {});
    if (method !== "GET") await saveDb();
    return result && result.file ? { status: 200, file: result.file } : { status: 200, data: result };
  } catch (error) {
    if (snapshot) DB = JSON.parse(snapshot);
    if (error instanceof ApiError) return { status: error.status, data: { error: error.message } };
    return { status: 500, data: { error: `${error.name}: ${error.message}` } };
  }
}

const Backend = { request, zip, workbook, crc32, _reset: () => { DB = null; memory = null; built = null; } };
if (typeof module !== "undefined" && module.exports) module.exports = Backend;
else root.Backend = Backend;

})(typeof self !== "undefined" ? self : this);
