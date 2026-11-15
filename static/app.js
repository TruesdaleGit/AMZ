"use strict";

let S = null;                                   // state from the server
const ui = {
  view: "find", days: 30, product: null, outreach: "", build: null,
  outreachForm: { supplier_id: "", quantity: 500, target_price: "" },
  find: { q: "", status: "", min: 0, sort: "score", dir: -1 }, compare: new Set(),
  launch: { units: 500, fixed: 500, ad: 3, daily: 5 },
};
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
const current = () => product(ui.product) || S.products[0];
const options = (items, selected, label = (i) => i.name) =>
  items.map((i) => `<option value="${esc(i.id ?? i)}" ${String(i.id ?? i) === String(selected ?? "") ? "selected" : ""}>${esc(i.id !== undefined ? label(i) : i)}</option>`).join("");
const xl = (table) => `<a class="btn" href="/api/export/${table}.xlsx">Export to Excel</a>`;
const meter = (value) => `<span class="meter"><span>${value}</span><i><b style="width:${Math.max(0, Math.min(100, value))}%"></b></i></span>`;
const tile = (k, v, s = "") => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const needProduct = (title) => `<h1>${title}</h1><div class="card empty">Add a product idea under Find products first.</div>`;
const productBar = (extra = "") => `<div class="bar"><label style="margin:0">Product</label>
  <select data-ui="product" style="width:auto;max-width:340px">${options(S.products, current().id)}</select><span class="grow"></span>${extra}</div>`;

function toast(message, isError) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "show" + (isError ? " err" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = ""), isError ? 6000 : 3000);
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
  for (const el of form.querySelectorAll("[name]")) out[el.name] = el.type === "checkbox" ? (el.checked ? 1 : 0) : el.value;
  return out;
}

function pickFile(onFile, accept = ".csv,.tsv,.txt,text/csv") {
  const input = document.getElementById("file");
  input.value = "";
  input.accept = accept;
  input.onchange = () => { if (input.files[0]) onFile(input.files[0]); };
  input.click();
}
const pickCsv = (onText) => pickFile(async (file) => onText(await file.text()));

// Upload an image into the app's uploads folder; resolves to its URL path.
function uploadImage() {
  return new Promise((resolve) => pickFile((file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try { resolve((await api("POST", "upload", { name: file.name, data: reader.result })).url); }
      catch (error) { toast(error.message, true); }
    };
    reader.readAsDataURL(file);
  }, "image/png,image/jpeg,image/webp,image/gif"));
}

// fields: [{name, label, type, options, full, hint}]
function fieldHtml(f, value) {
  const v = value ?? f.value ?? "";
  let input;
  if (f.type === "select") input = `<select name="${f.name}">${f.blank ? `<option value="">${esc(f.blank)}</option>` : ""}${options(f.options, v)}</select>`;
  else if (f.type === "textarea") input = `<textarea name="${f.name}" rows="${f.rows || 3}" placeholder="${esc(f.hint || "")}">${esc(v)}</textarea>`;
  else if (f.type === "image") input = `<div class="pair"><input type="text" name="${f.name}" value="${esc(v)}" placeholder="https://… or upload"><button type="button" class="btn" data-upload="${f.name}">Upload</button></div>`;
  else if (f.type === "images") input = `<textarea name="${f.name}" rows="4" placeholder="One image per line">${esc(v)}</textarea><button type="button" class="btn small" data-upload="${f.name}" data-append style="margin-top:6px">Upload and add</button>`;
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

function openInfo(title, body) {
  dlg.innerHTML = `<h2>${esc(title)}</h2>${body}<div class="actions"><button type="button" class="btn" data-cancel>Close</button></div>`;
  dlg.querySelector("[data-cancel]").onclick = () => dlg.close();
  dlg.showModal();
}

dlg.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-upload]");
  if (!button) return;
  const field = dlg.querySelector(`[name="${button.dataset.upload}"]`);
  const url = await uploadImage();
  field.value = button.hasAttribute("data-append") ? (field.value.trim() ? field.value.trim() + "\n" : "") + url : url;
});

// Horizontal bars from a zero baseline. items: [{label, value, tip}]
function hbar(items, label) {
  if (!items.length) return "";
  const W = 720, rowH = 30, left = 190, right = 80, top = 6;
  const H = top + items.length * rowH + 6;
  const max = Math.max(0, ...items.map((r) => r.value)), min = Math.min(0, ...items.map((r) => r.value));
  const span = max - min || 1, plot = W - left - right;
  const x = (v) => left + ((v - min) / span) * plot;
  const zero = x(0);
  const bars = items.map((r, i) => {
    const y = top + i * rowH, end = x(r.value), w = Math.max(Math.abs(end - zero), 1), rr = Math.min(4, w);
    const path = r.value >= 0   // square at the baseline, rounded at the data end
      ? `M${zero},${y + 7}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${16 - 2 * rr}a${rr},${rr} 0 0 1 -${rr},${rr}h-${w - rr}z`
      : `M${zero},${y + 7}h-${w - rr}a${rr},${rr} 0 0 0 -${rr},${rr}v${16 - 2 * rr}a${rr},${rr} 0 0 0 ${rr},${rr}h${w - rr}z`;
    const name = r.label.length > 26 ? r.label.slice(0, 25) + "…" : r.label;
    return `<g data-tip="${esc(r.tip || r.label)}"><rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/>
      <path class="mark" d="${path}"/>
      <text x="${left - 10}" y="${y + 19}" text-anchor="end">${esc(name)}</text>
      <text class="val" x="${r.value >= 0 ? end + 6 : end - 6}" y="${y + 19}" text-anchor="${r.value >= 0 ? "start" : "end"}">${compact(r.value)}</text></g>`;
  }).join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    ${bars}<line class="zero" x1="${zero}" x2="${zero}" y1="${top}" y2="${H - 4}"/></svg></div>`;
}
const monthName = (m) => new Date(m + "-15").toLocaleString("en-US", { month: "short", year: "numeric" });

// ------------------------------------------------------------------ forms

const STATUSES = ["idea", "shortlist", "sourcing", "live", "dropped"];
const SAMPLE = ["not requested", "requested", "received", "approved", "rejected"];
const ORDER_STATUS = ["planned", "deposit paid", "in production", "shipped", "received", "cancelled"];

// One entry per table that is edited through a dialog.
const FORMS = {
  products: {
    title: (r) => (r ? r.name : "Add product idea"), defaults: () => ({ status: "idea" }),
    extra: (r) => (r ? ecoBlock(r) : ""),
    fields: () => [
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
    ],
  },
  suppliers: {
    title: (r) => (r ? "Edit supplier" : "Add supplier"),
    fields: () => [
      { name: "name", label: "Supplier name", required: true }, { name: "contact", label: "Contact person" },
      { name: "country", label: "Country" }, { name: "url", label: "Profile or website link" },
      { name: "notes", label: "Notes", type: "textarea", full: true },
    ],
  },
  quotes: {
    title: (r) => (r ? "Edit quote from " + r.supplier_name : "Add quote for " + current().name),
    defaults: () => ({ product_id: current().id, currency: "USD", fx_rate: 1 }),
    fields: () => [
      { name: "supplier_id", label: "Supplier", type: "select", options: S.suppliers },
      { name: "unit_cost", label: "Unit cost (in the quote's currency)", type: "number" },
      { name: "currency", label: "Currency", hint: "USD" },
      { name: "fx_rate", label: "US dollars per 1 unit of that currency", type: "number", hint: "1 for USD, about 0.14 for CNY" },
      { name: "moq", label: "Minimum order (units)", type: "number" },
      { name: "lead_time_days", label: "Lead time (days)", type: "number" },
      { name: "price_breaks", label: "Price breaks, as quantity: unit cost", hint: "1000: 2.90, 2000: 2.70", full: true },
      { name: "freight_per_unit", label: "Freight per unit ($)", type: "number" },
      { name: "duty_pct", label: "Duty (% of unit cost)", type: "number" },
      { name: "other_per_unit", label: "Other per unit: packaging, inspection, prep ($)", type: "number" },
      { name: "sample_status", label: "Sample", type: "select", options: SAMPLE },
      { name: "sample_cost", label: "Sample cost ($)", type: "number" },
      { name: "sample_photo", label: "Sample photo", type: "image" },
      { name: "sample_notes", label: "Sample notes: quality, fit, packaging", type: "textarea", full: true },
      { name: "notes", label: "Other notes", type: "textarea", full: true },
    ],
  },
  sales: {
    title: () => "Add sales entry", defaults: () => ({ date: S.today, product_id: current().id }),
    fields: () => [
      { name: "product_id", label: "Product", type: "select", options: S.products },
      { name: "date", label: "Date", type: "date" },
      { name: "units", label: "Units sold", type: "number" }, { name: "revenue", label: "Revenue, before sales tax ($)", type: "number" },
      { name: "ad_spend", label: "Ad spend ($)", type: "number" }, { name: "refunds", label: "Refunds ($)", type: "number" },
      { name: "sales_tax", label: "Sales tax collected ($)", type: "number" },
    ],
  },
  overheads: {
    title: (r) => (r ? "Edit overhead" : "Add monthly overhead"),
    fields: () => [
      { name: "name", label: "What it is", required: true, hint: "Storage fees, software, insurance" },
      { name: "monthly_amount", label: "Cost per month ($)", type: "number" },
      { name: "notes", label: "Notes", type: "textarea", full: true },
    ],
  },
};

function openTable(table, row) {
  const form = FORMS[table];
  const values = row || (form.defaults ? form.defaults() : {});
  const fixed = row ? {} : values;   // defaults such as product_id are sent even if not shown as a field
  openForm(form.title(row), form.fields(row), values,
    (v) => run(() => (row ? api("PUT", `${table}/${row.id}`, v) : api("POST", table, { ...fixed, ...v })), "Saved"),
    form.extra ? form.extra(row) : "",
    row ? () => run(() => api("DELETE", `${table}/${row.id}`), "Deleted") : null);
}

function ecoBlock(p) {
  const e = p.eco, parts = p.score.parts, w = p.score.weights;
  const row = (k, v, cls = "") => `<dt class="${cls}">${k}</dt><dd class="${cls}">${v}</dd>`;
  const part = (label, key) => row(label, `${parts[key]} / ${w[key]}`);
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
      ${part("Demand", "demand")}${part("Competition", "competition")}${part("Price fit", "price_fit")}
      ${part("Margin", "margin")}${part("Rating gap", "rating_gap")}${part("Size and weight", "size")}</dl></div></div>`;
}

// ------------------------------------------------------------------ views

const views = {};

const FIND_COLS = [
  ["name", "Product", (p) => p.name.toLowerCase()], ["price", "Price", (p) => p.price], ["sales", "Sales / mo", (p) => p.monthly_sales],
  ["reviews", "Reviews", (p) => p.reviews], ["rating", "Rating", (p) => p.rating], ["profit", "Profit / unit", (p) => p.eco.profit],
  ["margin", "Margin", (p) => p.eco.margin_pct], ["score", "Score", (p) => p.score.score],
];

function findTable() {
  const f = ui.find, q = f.q.trim().toLowerCase();
  const key = FIND_COLS.find((c) => c[0] === f.sort)[2];
  const list = S.products
    .filter((p) => (!q || (p.name + " " + p.category + " " + p.asin).toLowerCase().includes(q)) && (!f.status || p.status === f.status) && p.score.score >= f.min)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * f.dir);
  if (!S.products.length) return '<div class="empty">No product ideas yet. Add one, or import a CSV with columns such as Name, Price, Monthly Sales, Reviews, Rating and Weight.</div>';
  if (!list.length) return '<div class="empty">No products match these filters.</div>';
  const head = FIND_COLS.map(([k, label], i) => `<th class="${i ? "num" : ""}"><button class="sort" data-sort="${k}">${label}${f.sort === k ? (f.dir < 0 ? " ↓" : " ↑") : ""}</button></th>`).join("");
  const rows = list.map((p) => `<tr class="click" data-edit="products:${p.id}">
      <td><input type="checkbox" data-compare="${p.id}" ${ui.compare.has(p.id) ? "checked" : ""} aria-label="Compare ${esc(p.name)}"></td>
      <td class="wrap"><strong>${esc(p.name)}</strong>${p.category ? `<div class="muted small">${esc(p.category)}</div>` : ""}</td>
      <td class="num">${money(p.price)}</td><td class="num">${int(p.monthly_sales)}</td>
      <td class="num">${int(p.reviews)}</td><td class="num">${p.rating ? p.rating.toFixed(1) : "–"}</td>
      <td class="num ${p.eco.profit < 0 ? "neg" : ""}">${money(p.eco.profit)}${p.eco.cost_source === "assumed" ? '<span class="muted" title="Uses an assumed landed cost until you add a supplier quote">*</span>' : ""}</td>
      <td class="num">${pct(p.eco.margin_pct)}</td><td>${meter(p.score.score)}</td>
      <td><select data-set="products:${p.id}:status" aria-label="Status">${options(STATUSES, p.status)}</select></td></tr>`).join("");
  return `<table><thead><tr><th></th>${head}<th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small">${list.length} of ${S.products.length} shown. * profit uses an assumed landed cost of ${esc(S.settings.assumed_cost_pct)}% of price until a quote exists.</p>`;
}

views.find = () => {
  const f = ui.find;
  return `<h1>Find products</h1>
    <p class="lede">Add product ideas or import a CSV exported from a research tool. Each idea is scored on demand, competition, price, margin and size so you can compare them on one scale. Score weights are under Settings.</p>
    <div class="bar"><button class="btn primary" data-add="products">Add product idea</button>
      <button class="btn" data-act="import-products">Import CSV</button>
      <button class="btn" data-act="compare">Compare selected</button><span class="grow"></span>${xl("products")}</div>
    <div class="bar filters"><input type="text" data-find="q" value="${esc(f.q)}" placeholder="Search name, category or ASIN" aria-label="Search">
      <select data-find="status" aria-label="Status filter"><option value="">All statuses</option>${options(STATUSES, f.status)}</select>
      <label style="margin:0">Min score</label><input type="number" data-find="min" value="${f.min}" min="0" max="100" style="width:80px" aria-label="Minimum score"></div>
    <div class="card scroll" id="find-table">${findTable()}</div>`;
};

function compareDialog() {
  const list = [...ui.compare].map(product).filter(Boolean).slice(0, 4);
  if (list.length < 2) return toast("Tick two to four products to compare.", true);
  const rows = [
    ["Score", (p) => p.score.score, 1], ["Price", (p) => money(p.price)], ["Sales / month", (p) => int(p.monthly_sales), 1, (p) => p.monthly_sales],
    ["Reviews of top sellers", (p) => int(p.reviews), -1, (p) => p.reviews], ["Rating of top sellers", (p) => p.rating || "–"],
    ["Landed cost", (p) => money(p.eco.landed_cost) + (p.eco.cost_source === "assumed" ? "*" : ""), -1, (p) => p.eco.landed_cost],
    ["FBA fee", (p) => money(p.eco.fba_fee), -1, (p) => p.eco.fba_fee], ["Profit / unit", (p) => money(p.eco.profit), 1, (p) => p.eco.profit],
    ["Margin", (p) => pct(p.eco.margin_pct), 1, (p) => p.eco.margin_pct], ["ROI", (p) => pct(p.eco.roi_pct), 1, (p) => p.eco.roi_pct],
    ["Break-even ACoS", (p) => pct(p.eco.break_even_acos_pct), 1, (p) => p.eco.break_even_acos_pct],
    ["Weight (lb)", (p) => p.weight_lb || "–"], ["Status", (p) => p.status],
  ];
  const body = rows.map(([label, show, better, raw]) => {
    const values = list.map(raw || show), best = better ? (better > 0 ? Math.max(...values) : Math.min(...values)) : null;
    return `<tr><th>${label}</th>${list.map((p, i) => `<td class="num">${better && values[i] === best && new Set(values).size > 1 ? `<strong>${show(p)}</strong>` : show(p)}</td>`).join("")}</tr>`;
  }).join("");
  openInfo("Compare products", `<div class="scroll"><table><thead><tr><th></th>${list.map((p) => `<th class="num wrap">${esc(p.name)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="muted small">Bold marks the best value in each row. * assumed landed cost.</p>`);
}

views.source = () => {
  if (!S.products.length) return needProduct("Source vendors");
  const p = current();
  const quotes = S.quotes.filter((q) => q.product_id === p.id);
  const quoteRows = quotes.map((q) => {
    const profit = p.price - p.eco.referral_fee - p.eco.fba_fee - q.landed_cost - p.eco.returns_allowance;
    const cost = q.currency && q.currency.toUpperCase() !== "USD" ? `${q.unit_cost} ${esc(q.currency)}` : money(q.unit_cost);
    const tiers = q.tiers.map((t) => `${int(t.quantity)}+: ${money(t.landed_cost)}`).join(" · ");
    return `<tr class="click" data-edit="quotes:${q.id}"><td><input type="radio" name="chosen" data-set="quotes:${q.id}:chosen" ${p.active_quote_id === q.id ? "checked" : ""} aria-label="Use this quote"></td>
      <td>${esc(q.supplier_name)}${tiers ? `<div class="muted small">Landed at ${tiers}</div>` : ""}</td><td class="num">${cost}</td><td class="num">${int(q.moq)}</td>
      <td class="num">${int(q.lead_time_days)} d</td><td class="num">${money(q.freight_per_unit)}</td><td class="num">${q.duty_pct}%</td>
      <td class="num"><strong>${money(q.landed_cost)}</strong></td>
      <td class="num ${profit < 0 ? "neg" : ""}">${money(profit)} <span class="muted">(${pct(p.price ? (profit / p.price) * 100 : 0)})</span></td>
      <td class="num">${money(q.landed_cost * q.moq)}</td>
      <td><select data-set="quotes:${q.id}:sample_status" aria-label="Sample status">${options(SAMPLE, q.sample_status)}</select>
        ${q.sample_photo ? `<a class="small" href="${esc(q.sample_photo)}" target="_blank" rel="noopener">photo</a>` : ""}</td></tr>`;
  }).join("");
  const supplierRows = S.suppliers.map((s) => `<tr class="click" data-edit="suppliers:${s.id}"><td><strong>${esc(s.name)}</strong></td>
    <td>${esc(s.contact)}</td><td>${esc(s.country)}</td><td class="wrap muted">${esc(s.notes)}</td></tr>`).join("");
  const o = ui.outreachForm;
  return `<h1>Source vendors</h1>
    <p class="lede">Record each supplier quote and compare the full landed cost: unit price converted to dollars, plus duty, freight and other costs per unit. The selected quote feeds the profit figures everywhere else. Click a quote to edit price breaks, currency and sample notes.</p>
    ${productBar(`<button class="btn primary" data-act="add-quote">Add quote</button>${xl("quotes")}`)}
    <div class="card scroll"><h2>Quotes for ${esc(p.name)} <span class="muted small">selling at ${money(p.price)}</span></h2>
      ${quoteRows ? `<table><thead><tr><th>Use</th><th>Supplier</th><th class="num">Unit cost</th><th class="num">MOQ</th><th class="num">Lead time</th>
      <th class="num">Freight / unit</th><th class="num">Duty</th><th class="num">Landed cost</th><th class="num">Profit / unit</th><th class="num">First order</th><th>Sample</th></tr></thead>
      <tbody>${quoteRows}</tbody></table>` : '<div class="empty">No quotes for this product yet.</div>'}</div>
    <div class="cols">
      <div class="card scroll"><div class="bar"><h2 style="margin:0">Suppliers</h2><span class="grow"></span><button class="btn small" data-add="suppliers">Add supplier</button></div>
        ${supplierRows ? `<table><thead><tr><th>Name</th><th>Contact</th><th>Country</th><th>Notes</th></tr></thead><tbody>${supplierRows}</tbody></table>` : '<div class="empty">No suppliers yet.</div>'}</div>
      <div class="card"><h2>Draft a first message</h2>
        <form id="outreach" class="fields three">
          <div><label>Supplier</label><select name="supplier_id"><option value="">(no name)</option>${options(S.suppliers, o.supplier_id)}</select></div>
          <div><label>First order (units)</label><input type="number" name="quantity" value="${esc(o.quantity)}"></div>
          <div><label>Target unit price ($)</label><input type="number" step="any" name="target_price" value="${esc(o.target_price)}"></div>
        </form>
        <div class="bar" style="margin:12px 0 0"><button class="btn" data-act="outreach">Write message</button>
          ${ui.outreach ? '<button class="btn" data-act="copy-outreach">Copy</button>' : ""}</div>
        ${ui.outreach ? `<pre class="msg">${esc(ui.outreach)}</pre>` : ""}</div>
    </div>`;
};

views.list = () => {
  if (!S.products.length) return needProduct("Amazon listings");
  const p = current();
  const l = S.listings.find((x) => x.product_id === p.id) || { brand: S.settings.brand };
  const counted = (name, label, max, rows, bytes) => `<div class="field"><label>${label}<span class="count" data-count="${name}" data-max="${max}" ${bytes ? "data-bytes" : ""}></span></label>
    ${rows ? `<textarea name="${name}" rows="${rows}">${esc(l[name])}</textarea>` : `<input type="text" name="${name}" value="${esc(l[name])}">`}</div>`;
  const issues = l.issues || [];
  const errors = issues.filter((i) => i.level === "error").length;
  const keywordCount = S.keywords.filter((k) => k.product_id === p.id).length;
  const versions = (l.versions || []).map((v) => `<tr><td>${esc(v.saved_at)}</td><td class="wrap">${esc(v.label) || '<span class="muted">no label</span>'}</td>
    <td><button type="button" class="btn small" data-act="restore-version" data-id="${v.id}">Restore</button>
    <button type="button" class="btn small danger" data-act="delete-version" data-id="${v.id}">Delete</button></td></tr>`).join("");
  return `<h1>Amazon listings</h1>
    <p class="lede">Enter features and keywords, generate a first draft, then edit it. The checker flags anything that breaks Amazon's general length and style rules. Export produces a tab-separated file to copy into the category template from Seller Central.</p>
    ${productBar(`<a class="btn" href="/api/export/flatfile">Export flat file</a>${xl("listings")}`)}
    <form id="listing"><div class="cols">
      <div><div class="card"><h2>Inputs</h2>
        <div class="fields"><div><label>Brand</label><input type="text" name="brand" value="${esc(l.brand)}"></div>
          <div><label>SKU</label><input type="text" name="sku" value="${esc(l.sku)}"></div></div>
        <div class="field" style="margin-top:12px"><label>Features, one per line as "Heading: benefit"</label>
          <textarea name="features" rows="6" placeholder="Stays put: four suction cups hold the mat to any smooth floor">${esc(l.features)}</textarea></div>
        <div class="field"><label>Keywords, most important first, separated by commas</label>
          <textarea name="keywords" rows="4" placeholder="dog lick mat, slow feeder, anxiety relief">${esc(l.keywords)}</textarea></div>
        <div class="bar"><button type="button" class="btn" data-act="draft-listing">Generate draft from inputs</button>
          ${keywordCount ? `<button type="button" class="btn" data-act="use-keywords">Use top keywords (${keywordCount} researched)</button>` : ""}</div>
        <p class="muted small">Generating replaces the title, bullets, description and search terms on the right.</p>
        <h2 style="margin-top:18px">Check ${l.id ? (errors ? `<span class="pill bad">${errors} to fix</span>` : issues.length ? `<span class="pill warn">${issues.length} suggestions</span>` : '<span class="pill good">passes</span>') : ""}</h2>
        ${l.id ? (issues.length ? `<ul class="issues">${issues.map((i) => `<li><span class="pill ${i.level === "error" ? "bad" : "warn"}">${i.level === "error" ? "Fix" : "Tip"}</span><span>${esc(i.message)}</span></li>`).join("")}</ul>` : '<p class="muted">No problems found.</p>') : '<p class="muted">Save the listing to check it.</p>'}
      </div>
      <div class="card"><h2>Saved versions</h2>
        <div class="pair"><input type="text" id="version-label" placeholder="Label, such as: before keyword update" aria-label="Version label">
          <button type="button" class="btn" data-act="save-version">Save version</button></div>
        ${versions ? `<div class="scroll" style="margin-top:10px"><table><tbody>${versions}</tbody></table></div>` : '<p class="muted small" style="margin:10px 0 0">Save a version before big edits so you can go back.</p>'}
      </div></div>
      <div class="card"><h2>Listing</h2>
        ${counted("title", "Title", 200)}
        ${[1, 2, 3, 4, 5].map((i) => counted("bullet" + i, "Bullet " + i, 500, 2)).join("")}
        ${counted("description", "Description", 2000, 5)}
        ${counted("search_terms", "Backend search terms (bytes)", 249, 2, true)}
        <div class="field"><label>A+ content sections, one per line as "Heading | text"</label>
          <textarea name="aplus" rows="4" placeholder="Made to last | Food-grade silicone that survives the dishwasher">${esc(l.aplus)}</textarea>
          <p class="muted small" style="margin:4px 0 0">Shown as feature blocks on your website. On Amazon, A+ content needs Brand Registry and is entered in Seller Central.</p></div>
        <div class="actions"><button type="button" class="btn primary" data-act="save-listing">Save and check</button></div>
      </div></div></form>`;
};

views.site = () => {
  const st = S.settings;
  const rows = S.products.map((p) => {
    const photos = [p.image_url, ...(p.images || "").split("\n")].filter((u) => u && u.trim()).length;
    return `<tr><td><input type="checkbox" data-set="products:${p.id}:on_site" ${p.on_site ? "checked" : ""} aria-label="Show on site"></td>
    <td class="wrap"><strong>${esc(p.name)}</strong><div class="muted small">${money(p.price)} · ${S.listings.some((l) => l.product_id === p.id && l.title) ? "listing written" : "no listing yet"}</div></td>
    <td><button class="btn small" data-act="photos" data-id="${p.id}">${photos ? photos + " photo" + (photos > 1 ? "s" : "") : "Add photos"}</button></td>
    <td><input type="url" data-set="products:${p.id}:checkout_url" value="${esc(p.checkout_url)}" placeholder="https://buy.stripe.com/…"></td>
    <td><input type="url" data-set="products:${p.id}:amazon_url" value="${esc(p.amazon_url)}" placeholder="https://www.amazon.com/dp/…"></td></tr>`;
  }).join("");
  const built = ui.build;
  return `<h1>Website</h1>
    <p class="lede">Builds a separate storefront from your products and listings as plain files you can upload to any static host. Each Buy button goes to the checkout link you paste here, such as a Stripe Payment Link, or to the Amazon page if there is none.</p>
    <div class="card"><form id="store" class="fields">
      <div><label>Store name</label><input type="text" name="store_name" value="${esc(st.store_name)}"></div>
      <div><label>Tagline</label><input type="text" name="store_tagline" value="${esc(st.store_tagline)}"></div>
      <div><label>Color theme</label><select name="store_theme">${options(["forest", "ocean", "clay", "ink"], st.store_theme)}</select></div>
      <div><label>Contact email (adds a Contact page)</label><input type="text" name="contact_email" value="${esc(st.contact_email)}"></div>
      <div class="full"><label>Search engine description (about 150 characters)</label><input type="text" name="store_description" value="${esc(st.store_description)}"></div>
      <div class="full"><label>About page text (leave empty for no About page)</label><textarea name="about_text" rows="3">${esc(st.about_text)}</textarea></div>
      <div class="full"><label>Contact page text</label><textarea name="contact_text" rows="2">${esc(st.contact_text)}</textarea></div></form></div>
    <div class="card scroll">${rows ? `<table><thead><tr><th>Show</th><th>Product</th><th>Photos</th><th>Checkout link</th><th>Amazon link</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Add a product idea first.</div>'}</div>
    <div class="bar"><button class="btn primary" data-act="build-site">Build website</button>
      ${S.site_built ? '<a class="btn" href="/store/index.html" target="_blank" rel="noopener">Open preview</a><a class="btn" href="/api/site/zip">Download as zip</a>' : ""}</div>
    ${built ? `<div class="card"><h2>Built ${built.pages.length} page${built.pages.length === 1 ? "" : "s"} for ${built.products} product${built.products === 1 ? "" : "s"}</h2>
      <p class="muted small">Folder: ${esc(built.folder)}</p>
      ${built.warnings.length ? `<ul class="issues">${built.warnings.map((w) => `<li><span class="pill warn">Check</span><span>${esc(w)}</span></li>`).join("")}</ul>` : ""}</div>` : ""}`;
};

function launchResult() {
  const p = current(), e = p.eco, v = ui.launch;
  const inventory = v.units * e.landed_cost, upfront = inventory + v.fixed;
  const perSale = e.price - e.referral_fee - e.fba_fee - e.returns_allowance - v.ad;   // cash back per sale, before product cost
  if (perSale <= 0) return `<p class="neg">Each sale returns ${money(perSale)} after fees and ads, so this launch cannot break even. Lower the ad cost or raise the price.</p>`;
  const units = Math.ceil(upfront / perSale), days = v.daily > 0 ? Math.ceil(units / v.daily) : null;
  const end = v.units * perSale - upfront;
  return `<dl class="kv"><dt>Inventory (${int(v.units)} × ${money(e.landed_cost)}${e.cost_source === "assumed" ? ", assumed" : ""})</dt><dd>${money(inventory)}</dd>
    <dt>Total upfront</dt><dd>${money(upfront)}</dd><dt>Cash back per sale after fees and ads</dt><dd>${money(perSale)}</dd>
    <dt class="total">Units to break even</dt><dd class="total">${int(units)}${units > v.units ? " (more than the first order)" : ""}</dd>
    <dt>Time to break even</dt><dd>${days === null ? "–" : days + " days"}</dd>
    <dt>Profit when the first order sells out</dt><dd class="${end < 0 ? "neg" : ""}">${money(end)}</dd></dl>`;
}

views.profit = () => {
  const d = S.dashboard, t = d.totals;
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
  const over = S.overheads.map((o) => `<tr class="click" data-edit="overheads:${o.id}"><td><strong>${esc(o.name)}</strong></td><td class="num">${money(o.monthly_amount)}</td><td class="wrap muted">${esc(o.notes)}</td></tr>`).join("");

  const pp = S.products.length ? current() : null;
  const scen = pp ? pp.scenarios.map((s) => `<tr><td class="num">${s.change_pct > 0 ? "+" : ""}${s.change_pct}%</td><td class="num">${money(s.price)}</td>
    <td class="num ${s.profit < 0 ? "neg" : ""}">${money(s.profit)}</td><td class="num">${pct(s.margin_pct)}</td></tr>`).join("") : "";
  const label = d.days ? `last ${d.days} days` : "all time";
  const months = d.monthly.map((m) => ({ label: monthName(m.month), value: m.profit, tip: `${monthName(m.month)}|Net profit ${money(m.profit)}|Revenue ${money(m.revenue)} · ${int(m.units)} units` }));
  const v = ui.launch;

  return `<h1>Profit</h1>
    <p class="lede">Net profit after Amazon fees, product cost, ads, refunds and monthly overheads, with reorder alerts, a price planner and a launch break-even calculator. Enter sales by hand or import a CSV with date, product, units, revenue, ad spend and refunds.</p>
    <div class="bar"><label style="margin:0">Period</label><select data-days style="width:auto">${[[30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 365 days"], [0, "All time"]].map(([n, name]) => `<option value="${n}" ${n === ui.days ? "selected" : ""}>${name}</option>`).join("")}</select>
      <span class="grow"></span><button class="btn primary" data-add="sales">Add sales entry</button><button class="btn" data-act="import-sales">Import sales CSV</button>${xl("sales")}</div>
    ${d.uses_assumed_cost ? '<div class="note">Some products have no supplier quote, so their product cost is an assumption (marked *). Add a quote under Source vendors for real figures.</div>' : ""}
    <div class="tiles">${tile("Revenue", compact(t.revenue), label)}${tile("Net profit", compact(t.profit), pct(t.margin_pct) + " margin, after overheads")}
      ${tile("Units sold", int(t.units), label)}${tile("Ad spend", compact(t.ad_spend), pct(t.tacos_pct) + " of revenue")}
      ${tile("Amazon fees", compact(t.amazon_fees), "referral + FBA")}${tile("Product cost", compact(t.cogs), "landed cost of units sold")}
      ${tile("Overheads", compact(t.overheads), money(d.monthly_overhead) + " per month")}
      ${t.sales_tax ? tile("Sales tax collected", compact(t.sales_tax), "owed to the state, not revenue") : ""}</div>
    ${rows ? `<div class="card"><h2>Net profit by product, ${label}</h2>${hbar(d.per_product.map((r) => ({ label: r.name, value: r.profit, tip: `${r.name}|Profit ${money(r.profit)}|Revenue ${money(r.revenue)} · margin ${pct(r.margin_pct)}` })), "Net profit by product")}</div>
    <div class="card scroll"><table><thead><tr><th>Product</th><th class="num">Units</th><th class="num">Revenue</th><th class="num">Amazon fees</th><th class="num">Product cost</th>
      <th class="num">Ads</th><th class="num">Refunds</th><th class="num">Net profit</th><th class="num">Margin</th><th class="num">Ad share / break-even</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted small">Per-product profit is before overheads.</p></div>`
      : `<div class="card empty">${d.sales_rows ? "No sales in this period." : "No sales recorded yet."}</div>`}
    <div class="card"><h2>Net profit by month, after overheads</h2>${months.length ? hbar(months, "Net profit by month") : '<div class="empty">No sales recorded yet.</div>'}</div>
    <div class="card scroll"><div class="bar"><h2 style="margin:0">Monthly overheads</h2><span class="grow"></span><button class="btn small" data-add="overheads">Add overhead</button></div>
        ${over ? `<table><thead><tr><th>Item</th><th class="num">Per month</th><th>Notes</th></tr></thead><tbody>${over}</tbody></table>` : '<div class="empty">Add recurring costs such as storage fees, software and insurance.</div>'}</div>
    <div class="card scroll"><h2>Inventory and reorders</h2>
      ${inv ? `<table><thead><tr><th>Product</th><th class="num">Stock</th><th class="num">Units / day</th><th class="num">Days left</th><th class="num">Lead time</th>
      <th class="num">Reorder at</th><th class="num">Order qty</th><th>Status</th></tr></thead><tbody>${inv}</tbody></table>
      <p class="muted small">Units per day uses the last 30 days. * no quote, so a 30-day lead time is assumed. Marking a purchase order received adds its units to stock.</p>` : '<div class="empty">Set stock on hand on a product to see reorder alerts.</div>'}</div>
    ${pp ? `${productBar()}<div class="cols">
      <div class="card scroll"><h2>Price planner</h2>
        <table><thead><tr><th class="num">Change</th><th class="num">Price</th><th class="num">Profit / unit</th><th class="num">Margin</th></tr></thead><tbody>${scen}</tbody></table>
        <p class="muted small">${pp.min_price ? `Lowest price that still gives a ${esc(S.settings.target_margin_pct)}% margin: <strong>${money(pp.min_price)}</strong>. ` : pp.eco.cost_source === "assumed" ? "This product has no supplier quote, so cost is assumed as a share of price and the margin stays flat; add a quote for real figures. " : ""}Shows profit per unit only; it does not predict how a price change affects sales volume.</p></div>
      <div class="card"><h2>Launch break-even</h2>
        <form id="launch" class="fields">
          <div><label>First order (units)</label><input type="number" name="units" value="${v.units}"></div>
          <div><label>Other upfront costs: photos, samples, fees ($)</label><input type="number" name="fixed" value="${v.fixed}"></div>
          <div><label>Ad cost per sale ($)</label><input type="number" step="any" name="ad" value="${v.ad}"></div>
          <div><label>Expected sales per day</label><input type="number" step="any" name="daily" value="${v.daily}"></div></form>
        <div id="launch-result" style="margin-top:14px">${launchResult()}</div></div>
    </div>` : ""}`;
};

const SETTING_GROUPS = [
  ["Profit defaults", [
    { name: "referral_pct", label: "Default Amazon referral fee (%)", type: "number" },
    { name: "returns_pct", label: "Returns allowance (% of price)", type: "number" },
    { name: "target_margin_pct", label: "Target net margin (%)", type: "number" },
    { name: "assumed_cost_pct", label: "Assumed landed cost before a quote (% of price)", type: "number" },
    { name: "safety_stock_days", label: "Safety stock (days)", type: "number" },
    { name: "reorder_cover_days", label: "Days of sales each reorder should cover", type: "number" }]],
  ["Score weights (relative; they are scaled to total 100)", [
    { name: "w_demand", label: "Demand", type: "number" }, { name: "w_competition", label: "Competition", type: "number" },
    { name: "w_price", label: "Price fit", type: "number" }, { name: "w_margin", label: "Margin", type: "number" },
    { name: "w_rating", label: "Rating gap", type: "number" }, { name: "w_size", label: "Size and weight", type: "number" }]],
  ["Cash flow forecast", [
    { name: "starting_cash", label: "Cash on hand today ($)", type: "number" },
    { name: "payout_delay_days", label: "Days between a sale and Amazon's payout", type: "number" },
    { name: "sales_growth_pct", label: "Expected sales growth per month (%)", type: "number" }]],
  ["You", [
    { name: "brand", label: "Brand name" }, { name: "your_name", label: "Your name (for supplier messages)" },
    { name: "company", label: "Company (for supplier messages)" }]],
];

views.settings = () => `<h1>Settings</h1>
  <p class="lede">These defaults drive every profit figure. FBA fees are estimated from weight and size and Amazon changes its fee tables, so enter the real fee on a product once you know it. Your data is backed up to the backups folder each time the app starts.</p>
  <form id="settings">${SETTING_GROUPS.map(([title, fields]) => `<div class="card"><h2>${title}</h2><div class="fields">${fields.map((f) => fieldHtml(f, S.settings[f.name])).join("")}</div></div>`).join("")}
    <div class="actions"><button type="button" class="btn primary" data-act="save-settings">Save settings</button></div></form>`;

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

const saveListing = () => api("POST", "listings", { ...formValues(document.getElementById("listing")), product_id: current().id });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const actions = {
  "import-products": () => pickCsv((csv) => run(() => api("POST", "import/products", { csv }), (r) => `Imported ${plural(r.added, "product")}`
    + (r.duplicates ? `, skipped ${plural(r.duplicates, "duplicate")}` : "") + (r.skipped ? `, skipped ${r.skipped} without a name` : "") + `. Columns read: ${r.columns_used.join(", ")}`)),
  "compare": compareDialog,
  "add-quote": () => (S.suppliers.length ? openTable("quotes") : toast("Add a supplier first.", true)),
  "outreach": async () => {
    try {
      ui.outreachForm = formValues(document.getElementById("outreach"));
      ui.outreach = (await api("POST", "outreach", { ...ui.outreachForm, product_id: current().id })).message;
      render();
    } catch (e) { toast(e.message, true); }
  },
  "copy-outreach": () => navigator.clipboard.writeText(ui.outreach).then(() => toast("Copied"), () => toast("Could not copy; select the text instead.", true)),
  "save-listing": () => run(saveListing, "Listing saved"),
  "draft-listing": () => {
    const form = formValues(document.getElementById("listing"));
    if (!form.features.trim()) return toast("Enter at least one feature first.", true);
    if (form.title.trim() && !confirm("Replace the current title, bullets, description and search terms with a new draft?")) return;
    run(async () => { await saveListing(); await api("POST", "listings/draft", { product_id: current().id }); }, "Draft generated");
  },
  "use-keywords": () => run(async () => { await saveListing(); return api("POST", "keywords/to-listing", { product_id: current().id, count: 15 }); }, (r) => `Keywords replaced with your top ${r.count}`),
  "save-version": () => { const label = document.getElementById("version-label").value; run(async () => { await saveListing(); await api("POST", "listings/version", { product_id: current().id, label }); }, "Version saved"); },
  "restore-version": (el) => { if (confirm("Replace the current listing with this saved version?")) run(() => api("POST", "listings/restore", { version_id: Number(el.dataset.id) }), "Version restored"); },
  "delete-version": (el) => run(() => api("DELETE", "listing_versions/" + el.dataset.id), "Version deleted"),
  "photos": (el) => {
    const p = product(el.dataset.id);
    openForm("Photos for " + p.name, [{ name: "image_url", label: "Main photo", type: "image", full: true }, { name: "images", label: "More photos", type: "images", full: true }], p,
      (v) => run(() => api("PUT", "products/" + p.id, v), "Photos saved"));
  },
  "build-site": () => run(async () => { ui.build = await api("POST", "site/build", {}); }, "Website built"),
  "import-sales": () => pickCsv((csv) => run(() => api("POST", "import/sales", { csv }), (r) => `Imported ${plural(r.added, "row")}` + (r.unmatched.length ? `. No matching product for: ${r.unmatched.join(", ")}` : ""))),
  "save-settings": () => run(() => api("PUT", "settings", formValues(document.getElementById("settings"))), "Settings saved"),
};

document.querySelector(".side").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) { ui.view = button.dataset.view; render(); window.scrollTo(0, 0); }
});

const rowOf = (table, id) => ({ quotes: S.quotes, products: S.products, suppliers: S.suppliers, overheads: S.overheads,
  keywords: S.keywords, competitors: S.competitors, tasks: S.tasks, purchase_orders: S.orders }[table].find((r) => r.id === Number(id)));

main.addEventListener("click", (event) => {
  const t = event.target;
  const act = t.closest("[data-act]");
  if (act) return actions[act.dataset.act](act);
  const add = t.closest("[data-add]");
  if (add) return openTable(add.dataset.add);
  const sort = t.closest("[data-sort]");
  if (sort) {
    const f = ui.find;
    if (f.sort === sort.dataset.sort) f.dir = -f.dir; else { f.sort = sort.dataset.sort; f.dir = sort.dataset.sort === "name" ? 1 : -1; }
    return (document.getElementById("find-table").innerHTML = findTable());
  }
  if (t.closest("select, input, button, a, textarea")) return;
  const row = t.closest("[data-edit]");
  if (row) { const [table, id] = row.dataset.edit.split(":"); openTable(table, rowOf(table, id)); }
});

main.addEventListener("change", (event) => {
  const t = event.target, d = t.dataset;
  if (d.compare) { t.checked ? ui.compare.add(Number(d.compare)) : ui.compare.delete(Number(d.compare)); return; }
  if (d.set) {
    const [table, id, field] = d.set.split(":");
    const value = t.type === "checkbox" || t.type === "radio" ? (t.checked ? 1 : 0) : t.value;
    return run(() => api("PUT", `${table}/${id}`, { [field]: value }));
  }
  if (t.closest("#store") || t.closest("#cash")) return run(() => api("PUT", "settings", { [t.name]: t.value }));
  if (d.ui) { ui[d.ui] = Number(t.value); if (d.ui === "product") ui.outreach = ""; return render(); }
  if ("days" in d) { ui.days = Number(t.value); return load().catch((e) => toast(e.message, true)); }
});

main.addEventListener("input", (event) => {
  const t = event.target;
  if (t.closest("#listing")) updateCounts();
  if (t.closest("#outreach")) ui.outreachForm = formValues(document.getElementById("outreach"));
  if (t.closest("#launch")) {
    for (const [k, v] of Object.entries(formValues(document.getElementById("launch")))) ui.launch[k] = Number(v) || 0;
    document.getElementById("launch-result").innerHTML = launchResult();
  }
  if (t.dataset.find) {
    ui.find[t.dataset.find] = t.dataset.find === "min" ? Number(t.value) || 0 : t.value;
    document.getElementById("find-table").innerHTML = findTable();
  }
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
