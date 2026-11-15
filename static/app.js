"use strict";

let S = null;                                   // state from the server
const ui = { view: "find", days: 30, sourceProduct: null, listProduct: null, priceProduct: null, outreach: "", outreachForm: { supplier_id: "", quantity: 500, target_price: "" } };
const main = document.getElementById("main");
const dlg = document.getElementById("dlg");

// ---------------------------------------------------------------- helpers

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => (v < 0 ? "-$" : "$") + Math.abs(Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = (v) => {
  const n = Number(v) || 0, a = Math.abs(n), sign = n < 0 ? "-" : "";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e4) return sign + "$" + (a / 1e3).toFixed(1) + "K";
  return sign + "$" + a.toLocaleString("en-US", { maximumFractionDigits: 0 });
};
const int = (v) => (Number(v) || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (v) => (Number(v) || 0).toFixed(1) + "%";
const product = (id) => S.products.find((p) => p.id === Number(id));
const options = (items, selected, label = (i) => i.name) =>
  items.map((i) => `<option value="${esc(i.id ?? i)}" ${String(i.id ?? i) === String(selected) ? "selected" : ""}>${esc(i.id !== undefined ? label(i) : i)}</option>`).join("");

function toast(message, isError) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "show" + (isError ? " err" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = ""), isError ? 6000 : 2500);
}

async function api(method, path, body) {
  const response = await fetch("/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ")");
  return data;
}

async function load() {
  S = await api("GET", "state?days=" + ui.days);
  render();
}

// Run an action, show any error, then refresh.
async function run(action, done) {
  try {
    const result = await action();
    await load();
    if (done) toast(typeof done === "function" ? done(result) : done);
  } catch (error) {
    toast(error.message, true);
  }
}

function formValues(form) {
  const out = {};
  for (const el of form.querySelectorAll("[name]")) {
    out[el.name] = el.type === "checkbox" ? (el.checked ? 1 : 0) : el.value;
  }
  return out;
}

// fields: [{name, label, type, options, full, hint, step}]
function fieldHtml(f, value) {
  const v = value ?? f.value ?? "";
  let input;
  if (f.type === "select") input = `<select name="${f.name}">${options(f.options, v)}</select>`;
  else if (f.type === "textarea") input = `<textarea name="${f.name}" rows="${f.rows || 3}" placeholder="${esc(f.hint || "")}">${esc(v)}</textarea>`;
  else input = `<input type="${f.type || "text"}" name="${f.name}" value="${esc(v)}" ${f.type === "number" ? 'step="any"' : ""} placeholder="${esc(f.hint || "")}" ${f.required ? "required" : ""}>`;
  return `<div class="${f.full ? "full" : ""}"><label>${esc(f.label)}</label>${input}</div>`;
}

function openForm(title, fields, values, onSave, extra = "", onDelete = null) {
  dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>
    <div class="fields">${fields.map((f) => fieldHtml(f, values[f.name])).join("")}</div>${extra}
    <div class="actions">${onDelete ? '<button type="button" class="btn danger left" data-del>Delete</button>' : ""}
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button class="btn primary" value="save">Save</button></div></form>`;
  const form = dlg.querySelector("form");
  dlg.querySelector("[data-cancel]").onclick = () => dlg.close();
  if (onDelete) dlg.querySelector("[data-del]").onclick = () => { if (confirm("Delete this? It cannot be undone.")) { dlg.close(); onDelete(); } };
  form.onsubmit = (event) => { event.preventDefault(); dlg.close(); onSave(formValues(form)); };
  dlg.showModal();
}

function pickFile(onText) {
  const input = document.getElementById("file");
  input.value = "";
  input.onchange = async () => { if (input.files[0]) onText(await input.files[0].text()); };
  input.click();
}

const STATUSES = ["idea", "shortlist", "sourcing", "live", "dropped"];
const SAMPLE = ["not requested", "requested", "received", "approved", "rejected"];

const PRODUCT_FIELDS = [
  { name: "name", label: "Product name", required: true, full: true },
  { name: "asin", label: "ASIN (of a reference listing, optional)" },
  { name: "category", label: "Category" },
  { name: "price", label: "Selling price ($)", type: "number" },
  { name: "monthly_sales", label: "Est. monthly sales of top sellers (units)", type: "number" },
  { name: "reviews", label: "Avg. review count of top sellers", type: "number" },
  { name: "rating", label: "Avg. star rating of top sellers", type: "number" },
  { name: "weight_lb", label: "Weight (lb)", type: "number" },
  { name: "length_in", label: "Length (in)", type: "number" },
  { name: "width_in", label: "Width (in)", type: "number" },
  { name: "height_in", label: "Height (in)", type: "number" },
  { name: "referral_pct", label: "Referral fee % (blank = default)", type: "number" },
  { name: "fba_fee_override", label: "FBA fee per unit $ (blank = estimate)", type: "number" },
  { name: "status", label: "Status", type: "select", options: STATUSES },
  { name: "stock_on_hand", label: "Stock on hand (units)", type: "number" },
  { name: "notes", label: "Notes", type: "textarea", full: true },
];

function ecoBlock(p) {
  const e = p.eco, parts = p.score.parts;
  const row = (k, v, cls = "") => `<dt class="${cls}">${k}</dt><dd class="${cls}">${v}</dd>`;
  return `<div class="cols" style="margin-top:16px">
    <div><h2>Profit per unit</h2><dl class="kv">
      ${row("Price", money(e.price))}
      ${row(`Referral fee (${e.referral_pct}%)`, "-" + money(e.referral_fee))}
      ${row(`FBA fee (${e.fba_source === "override" ? "your figure" : "estimate, " + e.size_tier})`, "-" + money(e.fba_fee))}
      ${row(`Landed cost (${e.cost_source === "quote" ? "from quote" : "assumed"})`, "-" + money(e.landed_cost))}
      ${row("Returns allowance", "-" + money(e.returns_allowance))}
      ${row("Net profit", money(e.profit), "total")}
      ${row("Margin / ROI", pct(e.margin_pct) + " / " + pct(e.roi_pct))}
      ${row("Break-even ad cost (ACoS)", pct(e.break_even_acos_pct))}</dl></div>
    <div><h2>Score ${p.score.score} of 100</h2><dl class="kv">
      ${row("Demand", parts.demand + " / 25")}${row("Competition", parts.competition + " / 25")}
      ${row("Price fit", parts.price_fit + " / 15")}${row("Margin", parts.margin + " / 15")}
      ${row("Rating gap", parts.rating_gap + " / 10")}${row("Size and weight", parts.size + " / 10")}</dl></div></div>`;
}

// ------------------------------------------------------------------ views

const views = {};

views.find = () => {
  const rows = [...S.products].sort((a, b) => b.score.score - a.score.score).map((p) => `
    <tr class="click" data-edit-product="${p.id}">
      <td class="wrap"><strong>${esc(p.name)}</strong>${p.category ? `<div class="muted small">${esc(p.category)}</div>` : ""}</td>
      <td class="num">${money(p.price)}</td><td class="num">${int(p.monthly_sales)}</td>
      <td class="num">${int(p.reviews)}</td><td class="num">${p.rating ? p.rating.toFixed(1) : "–"}</td>
      <td class="num ${p.eco.profit < 0 ? "neg" : ""}">${money(p.eco.profit)}${p.eco.cost_source === "assumed" ? '<span class="muted" title="Uses an assumed landed cost until you add a supplier quote">*</span>' : ""}</td>
      <td class="num">${pct(p.eco.margin_pct)}</td>
      <td><span class="meter"><span>${p.score.score}</span><i><b style="width:${p.score.score}%"></b></i></span></td>
      <td><select data-status="${p.id}" aria-label="Status">${options(STATUSES, p.status)}</select></td></tr>`).join("");
  return `<h1>Find products</h1>
    <p class="lede">Add product ideas or import a CSV exported from a research tool. Each idea is scored on demand, competition, price, margin and size so you can compare them on one scale.</p>
    <div class="bar"><button class="btn primary" data-act="add-product">Add product idea</button>
      <button class="btn" data-act="import-products">Import CSV</button><span class="grow"></span>
      <span class="muted small">* profit uses an assumed landed cost of ${esc(S.settings.assumed_cost_pct)}% of price until a quote exists</span></div>
    <div class="card scroll">${rows ? `<table><thead><tr><th>Product</th><th class="num">Price</th><th class="num">Sales / mo</th>
      <th class="num">Reviews</th><th class="num">Rating</th><th class="num">Profit / unit</th><th class="num">Margin</th><th>Score</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table>` : '<div class="empty">No product ideas yet. Add one, or import a CSV with columns such as Name, Price, Monthly Sales, Reviews, Rating and Weight.</div>'}</div>`;
};

views.source = () => {
  if (!S.products.length) return `<h1>Source vendors</h1><div class="card empty">Add a product idea first.</div>`;
  if (!product(ui.sourceProduct)) ui.sourceProduct = S.products[0].id;
  const p = product(ui.sourceProduct);
  const quotes = S.quotes.filter((q) => q.product_id === p.id);
  const quoteRows = quotes.map((q) => {
    const profit = p.price - p.eco.referral_fee - p.eco.fba_fee - q.landed_cost - p.eco.returns_allowance;
    return `<tr class="click" data-edit-quote="${q.id}"><td><input type="radio" name="chosen" data-choose="${q.id}" ${p.active_quote_id === q.id ? "checked" : ""} aria-label="Use this quote"></td>
      <td>${esc(q.supplier_name)}</td><td class="num">${money(q.unit_cost)}</td><td class="num">${int(q.moq)}</td>
      <td class="num">${int(q.lead_time_days)} d</td><td class="num">${money(q.freight_per_unit)}</td><td class="num">${q.duty_pct}%</td>
      <td class="num"><strong>${money(q.landed_cost)}</strong></td>
      <td class="num ${profit < 0 ? "neg" : ""}">${money(profit)} <span class="muted">(${pct(p.price ? (profit / p.price) * 100 : 0)})</span></td>
      <td class="num">${money(q.landed_cost * q.moq)}</td>
      <td><select data-sample="${q.id}" aria-label="Sample status">${options(SAMPLE, q.sample_status)}</select></td></tr>`;
  }).join("");
  const supplierRows = S.suppliers.map((s) => `<tr class="click" data-edit-supplier="${s.id}"><td><strong>${esc(s.name)}</strong></td>
    <td>${esc(s.contact)}</td><td>${esc(s.country)}</td><td class="wrap muted">${esc(s.notes)}</td></tr>`).join("");
  return `<h1>Source vendors</h1>
    <p class="lede">Record each supplier quote and compare the full landed cost: unit price plus duty, freight and other costs per unit. The selected quote feeds the profit figures everywhere else.</p>
    <div class="bar"><label style="margin:0">Product</label><select data-pick="sourceProduct" style="width:auto;max-width:340px">${options(S.products, p.id)}</select>
      <span class="grow"></span><button class="btn primary" data-act="add-quote">Add quote</button></div>
    <div class="card scroll"><h2>Quotes for ${esc(p.name)} <span class="muted small">selling at ${money(p.price)}</span></h2>
      ${quoteRows ? `<table><thead><tr><th>Use</th><th>Supplier</th><th class="num">Unit cost</th><th class="num">MOQ</th><th class="num">Lead time</th>
      <th class="num">Freight / unit</th><th class="num">Duty</th><th class="num">Landed cost</th><th class="num">Profit / unit</th><th class="num">First order</th><th>Sample</th></tr></thead>
      <tbody>${quoteRows}</tbody></table>` : '<div class="empty">No quotes for this product yet.</div>'}</div>
    <div class="cols">
      <div class="card scroll"><div class="bar"><h2 style="margin:0">Suppliers</h2><span class="grow"></span><button class="btn small" data-act="add-supplier">Add supplier</button></div>
        ${supplierRows ? `<table><thead><tr><th>Name</th><th>Contact</th><th>Country</th><th>Notes</th></tr></thead><tbody>${supplierRows}</tbody></table>` : '<div class="empty">No suppliers yet.</div>'}</div>
      <div class="card"><h2>Draft a first message</h2>
        <form id="outreach" class="fields three">
          <div><label>Supplier</label><select name="supplier_id"><option value="">(no name)</option>${options(S.suppliers, ui.outreachForm.supplier_id)}</select></div>
          <div><label>First order (units)</label><input type="number" name="quantity" value="${esc(ui.outreachForm.quantity)}"></div>
          <div><label>Target unit price ($)</label><input type="number" step="any" name="target_price" value="${esc(ui.outreachForm.target_price)}"></div>
        </form>
        <div class="bar" style="margin:12px 0 0"><button class="btn" data-act="outreach">Write message</button>
          ${ui.outreach ? '<button class="btn" data-act="copy-outreach">Copy</button>' : ""}</div>
        ${ui.outreach ? `<pre class="msg">${esc(ui.outreach)}</pre>` : ""}</div>
    </div>`;
};

views.list = () => {
  if (!S.products.length) return `<h1>Amazon listings</h1><div class="card empty">Add a product idea first.</div>`;
  if (!product(ui.listProduct)) ui.listProduct = S.products[0].id;
  const p = product(ui.listProduct);
  const l = S.listings.find((x) => x.product_id === p.id) || { brand: S.settings.brand };
  const counted = (name, label, max, rows, bytes) => `<div class="field"><label>${label}<span class="count" data-count="${name}" data-max="${max}" ${bytes ? "data-bytes" : ""}></span></label>
    ${rows ? `<textarea name="${name}" rows="${rows}">${esc(l[name])}</textarea>` : `<input type="text" name="${name}" value="${esc(l[name])}">`}</div>`;
  const issues = l.issues || [];
  const errors = issues.filter((i) => i.level === "error").length;
  return `<h1>Amazon listings</h1>
    <p class="lede">Enter features and keywords, generate a first draft, then edit it. The checker flags anything that breaks Amazon's general length and style rules. Export produces a tab-separated file to copy into the category template from Seller Central.</p>
    <div class="bar"><label style="margin:0">Product</label><select data-pick="listProduct" style="width:auto;max-width:340px">${options(S.products, p.id)}</select>
      <span class="grow"></span><a class="btn" href="/api/export/flatfile">Export all listings</a></div>
    <form id="listing"><div class="cols">
      <div class="card"><h2>Inputs</h2>
        <div class="fields"><div><label>Brand</label><input type="text" name="brand" value="${esc(l.brand)}"></div>
          <div><label>SKU</label><input type="text" name="sku" value="${esc(l.sku)}"></div></div>
        <div class="field" style="margin-top:12px"><label>Features, one per line as "Heading: benefit"</label>
          <textarea name="features" rows="6" placeholder="Stays put: four suction cups hold the mat to any smooth floor">${esc(l.features)}</textarea></div>
        <div class="field"><label>Keywords, most important first, separated by commas</label>
          <textarea name="keywords" rows="4" placeholder="dog lick mat, slow feeder, anxiety relief">${esc(l.keywords)}</textarea></div>
        <button type="button" class="btn" data-act="draft-listing">Generate draft from inputs</button>
        <p class="muted small">Generating replaces the title, bullets, description and search terms on the right.</p>
        <h2 style="margin-top:18px">Check ${l.id ? (errors ? `<span class="pill bad">${errors} to fix</span>` : issues.length ? `<span class="pill warn">${issues.length} suggestions</span>` : '<span class="pill good">passes</span>') : ""}</h2>
        ${l.id ? (issues.length ? `<ul class="issues">${issues.map((i) => `<li><span class="pill ${i.level === "error" ? "bad" : "warn"}">${i.level === "error" ? "Fix" : "Tip"}</span><span>${esc(i.message)}</span></li>`).join("")}</ul>` : '<p class="muted">No problems found.</p>') : '<p class="muted">Save the listing to check it.</p>'}
      </div>
      <div class="card"><h2>Listing</h2>
        ${counted("title", "Title", 200)}
        ${[1, 2, 3, 4, 5].map((i) => counted("bullet" + i, "Bullet " + i, 500, 2)).join("")}
        ${counted("description", "Description", 2000, 5)}
        ${counted("search_terms", "Backend search terms (bytes)", 249, 2, true)}
        <div class="actions"><button type="button" class="btn primary" data-act="save-listing">Save and check</button></div>
      </div></div></form>`;
};

views.site = () => {
  const rows = S.products.map((p) => `<tr>
    <td><input type="checkbox" data-prod="${p.id}" data-field="on_site" ${p.on_site ? "checked" : ""} aria-label="Show on site"></td>
    <td class="wrap"><strong>${esc(p.name)}</strong><div class="muted small">${money(p.price)} · ${S.listings.some((l) => l.product_id === p.id && l.title) ? "listing written" : "no listing yet"}</div></td>
    <td><input type="url" data-prod="${p.id}" data-field="image_url" value="${esc(p.image_url)}" placeholder="https://…"></td>
    <td><input type="url" data-prod="${p.id}" data-field="checkout_url" value="${esc(p.checkout_url)}" placeholder="https://buy.stripe.com/…"></td>
    <td><input type="url" data-prod="${p.id}" data-field="amazon_url" value="${esc(p.amazon_url)}" placeholder="https://www.amazon.com/dp/…"></td></tr>`).join("");
  const built = ui.build;
  return `<h1>Website</h1>
    <p class="lede">Builds a separate storefront from your products and listings as plain files you can upload to any static host. Each Buy button goes to the checkout link you paste here, such as a Stripe Payment Link, or to the Amazon page if there is none.</p>
    <div class="card"><form id="store" class="fields">
      <div><label>Store name</label><input type="text" name="store_name" value="${esc(S.settings.store_name)}"></div>
      <div><label>Tagline</label><input type="text" name="store_tagline" value="${esc(S.settings.store_tagline)}"></div></form></div>
    <div class="card scroll">${rows ? `<table><thead><tr><th>Show</th><th>Product</th><th>Image URL</th><th>Checkout link</th><th>Amazon link</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Add a product idea first.</div>'}</div>
    <div class="bar"><button class="btn primary" data-act="build-site">Build website</button>
      ${S.site_built ? '<a class="btn" href="/store/index.html" target="_blank" rel="noopener">Open preview</a><a class="btn" href="/api/site/zip">Download as zip</a>' : ""}</div>
    ${built ? `<div class="card"><h2>Built ${built.pages.length} page${built.pages.length === 1 ? "" : "s"} for ${built.products} product${built.products === 1 ? "" : "s"}</h2>
      <p class="muted small">Folder: ${esc(built.folder)}</p>
      ${built.warnings.length ? `<ul class="issues">${built.warnings.map((w) => `<li><span class="pill warn">Check</span><span>${esc(w)}</span></li>`).join("")}</ul>` : ""}</div>` : ""}`;
};

function profitChart(rows) {
  if (!rows.length) return "";
  const data = rows.slice(0, 12);
  const W = 720, rowH = 30, left = 190, right = 80, top = 6;
  const H = top + data.length * rowH + 6;
  const max = Math.max(0, ...data.map((r) => r.profit)), min = Math.min(0, ...data.map((r) => r.profit));
  const span = max - min || 1, plot = W - left - right;
  const x = (v) => left + ((v - min) / span) * plot;
  const zero = x(0);
  const bars = data.map((r, i) => {
    const y = top + i * rowH, end = x(r.profit), w = Math.max(Math.abs(end - zero), 1);
    const bx = r.profit >= 0 ? zero : end, rr = Math.min(4, w);
    // square at the baseline, rounded at the data end
    const path = r.profit >= 0
      ? `M${bx},${y + 7}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${16 - 2 * rr}a${rr},${rr} 0 0 1 -${rr},${rr}h-${w - rr}z`
      : `M${bx + w},${y + 7}h-${w - rr}a${rr},${rr} 0 0 0 -${rr},${rr}v${16 - 2 * rr}a${rr},${rr} 0 0 0 ${rr},${rr}h${w - rr}z`;
    const name = r.name.length > 26 ? r.name.slice(0, 25) + "…" : r.name;
    const tip = `${r.name}|Profit ${money(r.profit)}|Revenue ${money(r.revenue)} · margin ${pct(r.margin_pct)}`;
    return `<g data-tip="${esc(tip)}"><rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/>
      <path class="mark" d="${path}"/>
      <text x="${left - 10}" y="${y + 19}" text-anchor="end">${esc(name)}</text>
      <text class="val" x="${r.profit >= 0 ? end + 6 : end - 6}" y="${y + 19}" text-anchor="${r.profit >= 0 ? "start" : "end"}">${compact(r.profit)}</text></g>`;
  }).join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Net profit by product">
    ${bars}<line class="zero" x1="${zero}" x2="${zero}" y1="${top}" y2="${H - 4}"/></svg></div>`;
}

views.profit = () => {
  const d = S.dashboard, t = d.totals;
  const tile = (k, v, s = "") => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const rows = d.per_product.map((r) => `<tr><td class="wrap"><strong>${esc(r.name)}</strong></td><td class="num">${int(r.units)}</td>
    <td class="num">${money(r.revenue)}</td><td class="num">${money(r.amazon_fees)}</td><td class="num">${money(r.cogs)}${r.cost_source === "assumed" ? '<span class="muted">*</span>' : ""}</td>
    <td class="num">${money(r.ad_spend)}</td><td class="num">${money(r.refunds)}</td>
    <td class="num ${r.profit < 0 ? "neg" : ""}"><strong>${money(r.profit)}</strong></td><td class="num">${pct(r.margin_pct)}</td>
    <td class="num">${pct(r.tacos_pct)} <span class="muted">/ ${pct(r.break_even_acos_pct)}</span></td></tr>`).join("");
  const stockPill = { "ok": "good", "reorder now": "warn", "out of stock": "bad", "no recent sales": "" };
  const inv = d.inventory.map((r) => `<tr><td class="wrap"><strong>${esc(r.name)}</strong></td><td class="num">${int(r.stock)}</td>
    <td class="num">${r.daily_velocity}</td><td class="num">${r.days_left === null ? "–" : r.days_left}</td>
    <td class="num">${int(r.lead_time_days)} d${r.lead_source === "default" ? '<span class="muted">*</span>' : ""}</td><td class="num">${int(r.reorder_point)}</td>
    <td class="num">${int(r.suggested_order)}</td><td><span class="pill ${stockPill[r.status]}">${r.status}</span></td></tr>`).join("");

  const live = S.products.filter((p) => p.price > 0);
  if (!product(ui.priceProduct) && live.length) ui.priceProduct = (live.find((p) => p.eco.cost_source === "quote") || live[0]).id;
  const pp = product(ui.priceProduct);
  const scen = pp ? pp.scenarios.map((s) => `<tr><td class="num">${s.change_pct > 0 ? "+" : ""}${s.change_pct}%</td><td class="num">${money(s.price)}</td>
    <td class="num ${s.profit < 0 ? "neg" : ""}">${money(s.profit)}</td><td class="num">${pct(s.margin_pct)}</td></tr>`).join("") : "";
  const label = d.days ? `last ${d.days} days` : "all time";

  return `<h1>Profit</h1>
    <p class="lede">Net profit after Amazon fees, product cost, ads and refunds, with reorder alerts and a price planner. Enter sales by hand or import a CSV with date, product, units, revenue, ad spend and refunds.</p>
    <div class="bar"><label style="margin:0">Period</label><select data-days style="width:auto">${[[30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 365 days"], [0, "All time"]].map(([v, n]) => `<option value="${v}" ${v === ui.days ? "selected" : ""}>${n}</option>`).join("")}</select>
      <span class="grow"></span><button class="btn primary" data-act="add-sale">Add sales entry</button><button class="btn" data-act="import-sales">Import sales CSV</button></div>
    ${d.uses_assumed_cost ? '<div class="note">Some products have no supplier quote, so their product cost is an assumption (marked *). Add a quote under Source vendors for real figures.</div>' : ""}
    <div class="tiles">${tile("Revenue", compact(t.revenue), label)}${tile("Net profit", compact(t.profit), pct(t.margin_pct) + " margin")}
      ${tile("Units sold", int(t.units), label)}${tile("Ad spend", compact(t.ad_spend), pct(t.tacos_pct) + " of revenue")}
      ${tile("Amazon fees", compact(t.amazon_fees), "referral + FBA")}${tile("Product cost", compact(t.cogs), "landed cost of units sold")}</div>
    ${rows ? `<div class="card"><h2>Net profit by product, ${label}</h2>${profitChart(d.per_product)}</div>
    <div class="card scroll"><table><thead><tr><th>Product</th><th class="num">Units</th><th class="num">Revenue</th><th class="num">Amazon fees</th><th class="num">Product cost</th>
      <th class="num">Ads</th><th class="num">Refunds</th><th class="num">Net profit</th><th class="num">Margin</th><th class="num">Ad share / break-even</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="card empty">${d.sales_rows ? "No sales in this period." : "No sales recorded yet."}</div>`}
    <div class="cols">
      <div class="card scroll"><h2>Inventory and reorders</h2>
        ${inv ? `<table><thead><tr><th>Product</th><th class="num">Stock</th><th class="num">Units / day</th><th class="num">Days left</th><th class="num">Lead time</th>
        <th class="num">Reorder at</th><th class="num">Order qty</th><th>Status</th></tr></thead><tbody>${inv}</tbody></table>
        <p class="muted small">Units per day uses the last 30 days. * no quote, so a 30-day lead time is assumed.</p>` : '<div class="empty">Set stock on hand on a product to see reorder alerts.</div>'}</div>
      <div class="card scroll"><h2>Price planner</h2>
        ${pp ? `<select data-pick="priceProduct" style="margin-bottom:10px">${options(live, pp.id)}</select>
        <table><thead><tr><th class="num">Change</th><th class="num">Price</th><th class="num">Profit / unit</th><th class="num">Margin</th></tr></thead><tbody>${scen}</tbody></table>
        <p class="muted small">${pp.min_price ? `Lowest price that still gives a ${esc(S.settings.target_margin_pct)}% margin: <strong>${money(pp.min_price)}</strong>. ` : pp.eco.cost_source === "assumed" ? "This product has no supplier quote, so cost is assumed as a share of price and the margin stays flat; add a quote for real figures. " : ""}Shows profit per unit only; it does not predict how a price change affects sales volume.</p>` : '<div class="empty">Add a product with a price.</div>'}</div>
    </div>`;
};

const SETTING_FIELDS = [
  { name: "referral_pct", label: "Default Amazon referral fee (%)", type: "number" },
  { name: "returns_pct", label: "Returns allowance (% of price)", type: "number" },
  { name: "target_margin_pct", label: "Target net margin (%)", type: "number" },
  { name: "assumed_cost_pct", label: "Assumed landed cost before a quote (% of price)", type: "number" },
  { name: "safety_stock_days", label: "Safety stock (days)", type: "number" },
  { name: "reorder_cover_days", label: "Days of sales each reorder should cover", type: "number" },
  { name: "brand", label: "Brand name" },
  { name: "your_name", label: "Your name (for supplier messages)" },
  { name: "company", label: "Company (for supplier messages)" },
];

views.settings = () => `<h1>Settings</h1>
  <p class="lede">These defaults drive every profit figure. FBA fees are estimated from weight and size and Amazon changes its fee tables, so enter the real fee on a product once you know it.</p>
  <div class="card"><form id="settings"><div class="fields">${SETTING_FIELDS.map((f) => fieldHtml(f, S.settings[f.name])).join("")}</div>
    <div class="actions"><button type="button" class="btn primary" data-act="save-settings">Save settings</button></div></form></div>`;

function render() {
  document.querySelectorAll(".side button").forEach((b) => b.classList.toggle("on", b.dataset.view === ui.view));
  main.innerHTML = views[ui.view]();
  updateCounts();
}

function updateCounts() {
  document.querySelectorAll("[data-count]").forEach((el) => {
    const field = document.querySelector(`#listing [name="${el.dataset.count}"]`);
    const size = el.hasAttribute("data-bytes") ? new TextEncoder().encode(field.value).length : field.value.length;
    el.textContent = size + " / " + el.dataset.max;
    el.classList.toggle("over", size > Number(el.dataset.max));
  });
}

// ---------------------------------------------------------------- actions

const QUOTE_FIELDS = () => [
  { name: "supplier_id", label: "Supplier", type: "select", options: S.suppliers },
  { name: "unit_cost", label: "Unit cost ($)", type: "number" },
  { name: "moq", label: "Minimum order (units)", type: "number" },
  { name: "lead_time_days", label: "Lead time (days)", type: "number" },
  { name: "freight_per_unit", label: "Freight per unit ($)", type: "number" },
  { name: "duty_pct", label: "Duty (% of unit cost)", type: "number" },
  { name: "other_per_unit", label: "Other per unit: packaging, inspection, prep ($)", type: "number" },
  { name: "sample_status", label: "Sample", type: "select", options: SAMPLE },
  { name: "notes", label: "Notes", type: "textarea", full: true },
];
const SUPPLIER_FIELDS = [
  { name: "name", label: "Supplier name", required: true }, { name: "contact", label: "Contact person" },
  { name: "country", label: "Country" }, { name: "url", label: "Profile or website link" },
  { name: "notes", label: "Notes", type: "textarea", full: true },
];

const saveListing = () => api("POST", "listings", { ...formValues(document.getElementById("listing")), product_id: ui.listProduct });

const actions = {
  "add-product": () => openForm("Add product idea", PRODUCT_FIELDS, { status: "idea" }, (v) => run(() => api("POST", "products", v), "Product added")),
  "import-products": () => pickFile((csv) => run(() => api("POST", "import/products", { csv }), (r) => `Imported ${r.added} product${r.added === 1 ? "" : "s"}` + (r.skipped ? `, skipped ${r.skipped} without a name` : "") + `. Columns read: ${r.columns_used.join(", ")}`)),
  "add-supplier": () => openForm("Add supplier", SUPPLIER_FIELDS, {}, (v) => run(() => api("POST", "suppliers", v), "Supplier added")),
  "add-quote": () => {
    if (!S.suppliers.length) return toast("Add a supplier first.", true);
    openForm("Add quote for " + product(ui.sourceProduct).name, QUOTE_FIELDS(), {}, (v) => run(() => api("POST", "quotes", { ...v, product_id: ui.sourceProduct }), "Quote added"));
  },
  "outreach": async () => {
    try {
      ui.outreachForm = formValues(document.getElementById("outreach"));
      const r = await api("POST", "outreach", { ...ui.outreachForm, product_id: ui.sourceProduct });
      ui.outreach = r.message;
      render();
    } catch (e) { toast(e.message, true); }
  },
  "copy-outreach": () => navigator.clipboard.writeText(ui.outreach).then(() => toast("Copied"), () => toast("Could not copy; select the text instead.", true)),
  "save-listing": () => run(saveListing, "Listing saved"),
  "draft-listing": () => {
    const form = formValues(document.getElementById("listing"));
    if (!form.features.trim()) return toast("Enter at least one feature first.", true);
    if (form.title.trim() && !confirm("Replace the current title, bullets, description and search terms with a new draft?")) return;
    run(async () => { await saveListing(); await api("POST", "listings/draft", { product_id: ui.listProduct }); }, "Draft generated");
  },
  "build-site": () => run(async () => {
    await api("PUT", "settings", formValues(document.getElementById("store")));
    ui.build = await api("POST", "site/build", {});
  }, "Website built"),
  "add-sale": () => {
    if (!S.products.length) return toast("Add a product first.", true);
    openForm("Add sales entry", [
      { name: "product_id", label: "Product", type: "select", options: S.products },
      { name: "date", label: "Date", type: "date" },
      { name: "units", label: "Units sold", type: "number" }, { name: "revenue", label: "Revenue ($)", type: "number" },
      { name: "ad_spend", label: "Ad spend ($)", type: "number" }, { name: "refunds", label: "Refunds ($)", type: "number" },
    ], { date: new Date().toISOString().slice(0, 10) }, (v) => run(() => api("POST", "sales", v), "Sales entry added"));
  },
  "import-sales": () => pickFile((csv) => run(() => api("POST", "import/sales", { csv }), (r) => `Imported ${r.added} row${r.added === 1 ? "" : "s"}` + (r.unmatched.length ? `. No matching product for: ${r.unmatched.join(", ")}` : ""))),
  "save-settings": () => run(() => api("PUT", "settings", formValues(document.getElementById("settings"))), "Settings saved"),
};

document.querySelector(".side").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) { ui.view = button.dataset.view; render(); window.scrollTo(0, 0); }
});

main.addEventListener("click", (event) => {
  const t = event.target;
  const act = t.closest("[data-act]");
  if (act) return actions[act.dataset.act]();
  if (t.closest("select, input, button, a")) return;
  const quoteRow = t.closest("[data-edit-quote]");
  if (quoteRow) {
    const q = S.quotes.find((x) => x.id === Number(quoteRow.dataset.editQuote));
    return openForm("Edit quote from " + q.supplier_name, QUOTE_FIELDS(), q, (v) => run(() => api("PUT", "quotes/" + q.id, v), "Quote saved"), "",
      () => run(() => api("DELETE", "quotes/" + q.id), "Quote deleted"));
  }
  const row = t.closest("[data-edit-product]");
  if (row) {
    const p = product(row.dataset.editProduct);
    return openForm(p.name, PRODUCT_FIELDS, p, (v) => run(() => api("PUT", "products/" + p.id, v), "Product saved"), ecoBlock(p),
      () => run(() => api("DELETE", "products/" + p.id), "Product deleted"));
  }
  const sup = t.closest("[data-edit-supplier]");
  if (sup) {
    const s = S.suppliers.find((x) => x.id === Number(sup.dataset.editSupplier));
    openForm("Edit supplier", SUPPLIER_FIELDS, s, (v) => run(() => api("PUT", "suppliers/" + s.id, v), "Supplier saved"), "",
      () => run(() => api("DELETE", "suppliers/" + s.id), "Supplier and its quotes deleted"));
  }
});

main.addEventListener("change", (event) => {
  const t = event.target, d = t.dataset;
  if (d.status) return run(() => api("PUT", "products/" + d.status, { status: t.value }));
  if (d.sample) return run(() => api("PUT", "quotes/" + d.sample, { sample_status: t.value }));
  if (d.choose) return run(() => api("PUT", "quotes/" + d.choose, { chosen: 1 }), "Quote selected");
  if (d.prod) return run(() => api("PUT", "products/" + d.prod, { [d.field]: t.type === "checkbox" ? (t.checked ? 1 : 0) : t.value }));
  if (t.closest("#store")) return run(() => api("PUT", "settings", { [t.name]: t.value }));
  if (d.pick) { ui[d.pick] = Number(t.value); if (d.pick === "sourceProduct") ui.outreach = ""; return render(); }
  if ("days" in d) { ui.days = Number(t.value); return load().catch((e) => toast(e.message, true)); }
});

main.addEventListener("input", (event) => {
  if (event.target.closest("#listing")) updateCounts();
  if (event.target.closest("#outreach")) ui.outreachForm = formValues(document.getElementById("outreach"));
});

// chart tooltip
const tip = document.getElementById("tip");
main.addEventListener("mousemove", (event) => {
  const g = event.target.closest("[data-tip]");
  if (!g) { tip.hidden = true; return; }
  const [title, ...lines] = g.dataset.tip.split("|");
  tip.innerHTML = `<b>${esc(title)}</b>${lines.map(esc).join("<br>")}`;
  tip.hidden = false;
  tip.style.left = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = event.clientY + 14 + "px";
});
main.addEventListener("mouseleave", () => (tip.hidden = true));

load().catch((error) => { main.innerHTML = `<div class="card">Could not load: ${esc(error.message)}</div>`; });
