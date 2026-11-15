"use strict";
// Research, operations and money sections added on top of the five core ones.

Object.assign(FORMS, {
  keywords: {
    title: (r) => (r ? "Edit keyword" : "Add keyword for " + current().name), defaults: () => ({ product_id: current().id }),
    fields: () => [
      { name: "keyword", label: "Keyword phrase", required: true, full: true },
      { name: "search_volume", label: "Monthly search volume", type: "number" },
      { name: "competing_products", label: "Competing products", type: "number" },
      { name: "notes", label: "Notes", type: "textarea", full: true },
    ],
  },
  competitors: {
    title: (r) => (r ? "Edit competitor" : "Add competitor for " + current().name), defaults: () => ({ product_id: current().id }),
    fields: () => [
      { name: "name", label: "Listing or brand name", required: true, full: true },
      { name: "asin", label: "ASIN" }, { name: "url", label: "Link to the listing" },
      { name: "notes", label: "Notes: strengths, weaknesses", type: "textarea", full: true },
    ],
  },
  tasks: {
    title: (r) => (r ? "Edit task" : "Add task for " + current().name),
    defaults: () => ({ product_id: current().id, position: 1 + Math.max(0, ...S.tasks.filter((t) => t.product_id === current().id).map((t) => t.position)) }),
    fields: () => [{ name: "title", label: "Task", required: true, full: true }, { name: "due_date", label: "Due date", type: "date" }],
  },
  purchase_orders: {
    title: (r) => (r ? "Edit order for " + r.product_name : "Add purchase order"),
    defaults: () => {
      const p = current(), q = S.quotes.find((x) => x.id === p.active_quote_id);
      return { product_id: p.id, supplier_id: q ? q.supplier_id : "", quantity: q ? q.moq : "", deposit_pct: 30, order_date: S.today, status: "planned",
        unit_cost: q ? +(q.unit_cost * (q.fx_rate || 1) * (1 + q.duty_pct / 100) + q.other_per_unit).toFixed(2) : "",
        freight_total: q ? +(q.moq * q.freight_per_unit).toFixed(2) : "" };
    },
    fields: () => [
      { name: "product_id", label: "Product", type: "select", options: S.products },
      { name: "supplier_id", label: "Supplier", type: "select", options: S.suppliers, blank: "(none)" },
      { name: "quantity", label: "Units ordered", type: "number" },
      { name: "unit_cost", label: "Cost per unit incl. duty and packaging ($)", type: "number" },
      { name: "freight_total", label: "Freight for the whole order ($)", type: "number" },
      { name: "deposit_pct", label: "Deposit (% of goods, paid at order)", type: "number" },
      { name: "order_date", label: "Order date (deposit due)", type: "date" },
      { name: "balance_due_date", label: "Balance and freight due", type: "date" },
      { name: "expected_arrival", label: "Expected arrival at Amazon", type: "date" },
      { name: "status", label: "Status", type: "select", options: ORDER_STATUS },
      { name: "tracking", label: "Tracking or booking reference" },
      { name: "units_received", label: "Units received (blank = all ordered)", type: "number" },
      { name: "notes", label: "Notes", type: "textarea", full: true },
    ],
  },
});

views.keywords = () => {
  if (!S.products.length) return needProduct("Keywords");
  const p = current(), list = S.keywords.filter((k) => k.product_id === p.id);
  const rows = list.map((k) => `<tr class="click" data-edit="keywords:${k.id}"><td class="wrap"><strong>${esc(k.keyword)}</strong>${k.notes ? `<div class="muted small">${esc(k.notes)}</div>` : ""}</td>
    <td class="num">${int(k.search_volume)}</td><td class="num">${k.competing_products ? int(k.competing_products) : "–"}</td><td>${meter(k.priority)}</td></tr>`).join("");
  return `<h1>Keywords</h1>
    <p class="lede">Collect the search terms shoppers use for this product. Priority is highest for phrases with many searches and few competing products. Send the top ones to the listing to use them in the draft.</p>
    ${productBar(`<button class="btn primary" data-add="keywords">Add keyword</button><button class="btn" data-act="import-keywords">Import CSV</button>
      ${list.length ? '<button class="btn" data-act="keywords-to-listing">Send top 15 to listing</button>' : ""}${xl("keywords")}`)}
    <div class="card scroll">${rows ? `<table><thead><tr><th>Keyword</th><th class="num">Searches / month</th><th class="num">Competing products</th><th>Priority</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">No keywords yet. Add them by hand or import a keyword CSV with columns such as Keyword Phrase, Search Volume and Competing Products.</div>'}</div>`;
};

views.competitors = () => {
  if (!S.products.length) return needProduct("Competitors");
  const p = current(), list = S.competitors.filter((c) => c.product_id === p.id);
  const delta = (now, then, fmt, goodDown) => {
    const d = now - then;
    if (!d) return "";
    return ` <span class="small ${(d < 0) === !!goodDown ? "muted" : "muted"}">(${d > 0 ? "+" : "-"}${fmt(Math.abs(d))})</span>`;
  };
  const rows = list.map((c) => {
    const s = c.snapshots, last = s[s.length - 1], first = s[0];
    return `<tr class="click" data-edit="competitors:${c.id}"><td class="wrap"><strong>${esc(c.name)}</strong>
      <div class="muted small">${esc(c.asin)}${c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">open listing</a>` : ""}</div></td>
      ${last ? `<td class="num">${money(last.price)}${delta(last.price, first.price, money)}</td><td class="num">${int(last.reviews)}${delta(last.reviews, first.reviews, int)}</td>
      <td class="num">${last.rating ? last.rating.toFixed(1) : "–"}</td><td>${esc(last.date)}</td><td class="num">${s.length}</td>` : '<td colspan="5" class="muted">No checks logged yet</td>'}
      <td><button class="btn small" data-act="log-check" data-id="${c.id}">Log check</button>
        ${s.length ? `<button class="btn small" data-act="history" data-id="${c.id}">History</button>` : ""}</td></tr>`;
  }).join("");
  return `<h1>Competitors</h1>
    <p class="lede">List the listings you compete with and log their price, review count and rating whenever you check them. The change in brackets is since your first check, so you can see who is cutting prices or gaining reviews fast.</p>
    ${productBar(`<button class="btn primary" data-add="competitors">Add competitor</button>${xl("competitors")}`)}
    <div class="card scroll">${rows ? `<table><thead><tr><th>Competitor</th><th class="num">Price</th><th class="num">Reviews</th><th class="num">Rating</th><th>Last checked</th><th class="num">Checks</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">No competitors tracked for this product yet.</div>'}</div>`;
};

views.reviews = () => {
  if (!S.products.length) return needProduct("Review analysis");
  const p = current(), r = S.reviews.find((x) => x.product_id === p.id), a = r ? r.analysis : null;
  const themes = a ? a.themes.map((t) => `<tr><td><strong>${esc(t.theme)}</strong></td><td class="num">${t.count}</td><td>${meter(t.share_pct)}</td>
    <td class="wrap muted small">${t.examples.map((e) => "“" + esc(e) + "”").join("<br>")}</td></tr>`).join("") : "";
  return `<h1>Review analysis</h1>
    <p class="lede">Paste competitor reviews, ideally the 1 to 3 star ones, one review per line or separated by blank lines. The app counts common complaint themes and repeated phrases so you can see what to fix in your own version.</p>
    ${productBar()}
    <div class="card"><label>Competitor reviews for ${esc(p.name)}</label>
      <textarea id="review-text" rows="9" placeholder="Paste reviews here">${esc(r ? r.text : "")}</textarea>
      <div class="actions"><button class="btn primary" data-act="analyze-reviews">Analyse</button></div></div>
    ${a && a.review_count ? `<div class="card scroll"><h2>Complaint themes in ${a.review_count} reviews</h2>
      ${themes ? `<table><thead><tr><th>Theme</th><th class="num">Reviews</th><th>Share %</th><th>Examples</th></tr></thead><tbody>${themes}</tbody></table>` : '<p class="muted">None of the common complaint themes appear in these reviews.</p>'}
      <p class="muted small">This is a count of complaint words, not a reading of each review: a review that says "not flimsy" still counts. Read the examples before acting on a theme.</p></div>
    ${a.phrases.length ? `<div class="card"><h2>Repeated phrases</h2><div class="pills">${a.phrases.map((x) => `<span class="pill">${esc(x.phrase)} · ${x.count}</span>`).join("")}</div></div>` : ""}` : ""}`;
};

views.orders = () => {
  if (!S.products.length) return needProduct("Purchase orders");
  const open = S.orders.filter((o) => !["received", "cancelled"].includes(o.status));
  const rows = S.orders.map((o) => `<tr class="click" data-edit="purchase_orders:${o.id}"><td class="wrap"><strong>${esc(o.product_name)}</strong><div class="muted small">${esc(o.supplier_name)}${o.tracking ? " · " + esc(o.tracking) : ""}</div></td>
    <td class="num">${int(o.quantity)}</td><td class="num">${money(o.total_cost)}</td><td class="num">${money(o.deposit)}<div class="muted small">${esc(o.order_date) || "no date"}</div></td>
    <td class="num">${money(o.balance)}<div class="muted small">${esc(o.balance_due_date) || "no date"}</div></td><td>${esc(o.expected_arrival) || "–"}</td>
    <td><select data-set="purchase_orders:${o.id}:status" aria-label="Status">${options(ORDER_STATUS, o.status)}</select></td></tr>`).join("");
  return `<h1>Purchase orders</h1>
    <p class="lede">Track each order from deposit to delivery. A new order starts from the selected quote of the product chosen below. Setting an order to received adds its units to stock once, and the payment dates feed the cash flow forecast.</p>
    ${productBar(`<button class="btn primary" data-add="purchase_orders">Add purchase order</button>${xl("purchase_orders")}`)}
    <div class="tiles">${tile("Open orders", open.length, "not yet received")}${tile("Units on the way", int(open.reduce((n, o) => n + o.quantity, 0)), "across open orders")}
      ${tile("Committed", compact(open.reduce((n, o) => n + o.total_cost, 0)), "goods and freight on open orders")}</div>
    <div class="card scroll">${rows ? `<table><thead><tr><th>Order</th><th class="num">Units</th><th class="num">Total</th><th class="num">Deposit</th><th class="num">Balance + freight</th><th>Arrival</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">No purchase orders yet.</div>'}</div>`;
};

views.checklist = () => {
  if (!S.products.length) return needProduct("Launch checklist");
  const p = current(), list = S.tasks.filter((t) => t.product_id === p.id), done = list.filter((t) => t.done).length;
  const rows = list.map((t) => `<tr class="click" data-edit="tasks:${t.id}"><td><input type="checkbox" data-set="tasks:${t.id}:done" ${t.done ? "checked" : ""} aria-label="Done"></td>
    <td class="wrap ${t.done ? "muted struck" : ""}">${esc(t.title)}</td>
    <td>${t.due_date ? `<span class="pill ${!t.done && t.due_date < S.today ? "bad" : ""}">${esc(t.due_date)}</span>` : ""}</td></tr>`).join("");
  return `<h1>Launch checklist</h1>
    <p class="lede">The steps from idea to live product, per product. Start from the standard checklist and edit it to fit; click a task to rename it or set a due date.</p>
    ${productBar(`<button class="btn primary" data-add="tasks">Add task</button><button class="btn" data-act="standard-tasks">Add standard checklist</button>`)}
    <div class="card">${list.length ? `<div class="bar"><strong>${done} of ${list.length} done</strong>${meter(Math.round(done / list.length * 100))}</div>
      <div class="scroll"><table><tbody>${rows}</tbody></table></div>` : '<div class="empty">No tasks for this product yet.</div>'}</div>`;
};

views.ads = () => {
  if (!S.products.length) return needProduct("Ad campaigns");
  const p = current(), list = S.ads.filter((r) => r.product_id === p.id);
  const spend = list.reduce((n, r) => n + r.spend, 0), sales = list.reduce((n, r) => n + r.sales, 0);
  const pill = { "profitable": "good", "thin": "warn", "losing money": "bad", "no sales": "bad", "no spend": "" };
  const rows = list.map((r) => `<tr><td class="wrap"><strong>${esc(r.keyword) || "(all targets)"}</strong><div class="muted small">${esc(r.campaign)}</div></td>
    <td class="num">${int(r.impressions)}</td><td class="num">${int(r.clicks)}</td><td class="num">${r.cpc === null ? "–" : money(r.cpc)}</td>
    <td class="num">${money(r.spend)}</td><td class="num">${money(r.sales)}</td><td class="num">${r.acos_pct === null ? "–" : pct(r.acos_pct)}</td>
    <td class="num ${r.net < 0 ? "neg" : ""}">${money(r.net)}</td><td><span class="pill ${pill[r.verdict]}">${r.verdict}</span></td></tr>`).join("");
  return `<h1>Ad campaigns</h1>
    <p class="lede">Import an Amazon advertising report to see which campaigns and keywords pay for themselves. Each row is judged against this product's break-even ad cost of ${pct(p.eco.break_even_acos_pct)}: above it, every ad sale loses money. Rows are sorted with the biggest losses first.</p>
    <div class="bar"><label style="margin:0">Product</label><select data-ui="product" style="width:auto;max-width:300px">${options(S.products, p.id)}</select>
      <label style="margin:0">Period</label><select data-days style="width:auto">${[[30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 365 days"], [0, "All time"]].map(([n, name]) => `<option value="${n}" ${n === ui.days ? "selected" : ""}>${name}</option>`).join("")}</select>
      <span class="grow"></span><button class="btn primary" data-act="import-ads">Import ad report CSV</button>
      ${list.length ? '<button class="btn danger" data-act="clear-ads">Clear ad data</button>' : ""}${xl("ads")}</div>
    ${list.length ? `<div class="tiles">${tile("Ad spend", compact(spend))}${tile("Ad sales", compact(sales))}
      ${tile("ACoS", sales ? pct(spend / sales * 100) : "–", "ad spend as a share of ad sales")}${tile("Break-even ACoS", pct(p.eco.break_even_acos_pct), "from this product's margin")}
      ${tile("Losing money", list.filter((r) => ["losing money", "no sales"].includes(r.verdict)).length, "campaign and keyword rows")}</div>
    <div class="card scroll"><table><thead><tr><th>Keyword and campaign</th><th class="num">Impressions</th><th class="num">Clicks</th><th class="num">Cost / click</th>
      <th class="num">Spend</th><th class="num">Sales</th><th class="num">ACoS</th><th class="num">Net after margin</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted small">Net after margin is ad sales times the break-even rate, minus spend. This section is analysis only: the Profit page uses the ad spend on your sales entries, so importing a report here does not change profit.</p></div>`
      : '<div class="card empty">No ad data for this product in this period. Download a Sponsored Products report from Seller Central (campaign or search term report, CSV) and import it. Columns needed: Spend and Sales; Campaign Name, Targeting, Impressions, Clicks and Date are used when present.</div>'}`;
};

views.cashflow = () => {
  const c = S.cashflow, st = S.settings;
  const rows = c.rows.map((r) => `<tr><td><strong>${monthName(r.month)}</strong></td><td class="num">${money(r.inflow)}</td><td class="num">${r.po_payments ? "-" + money(r.po_payments) : "–"}</td>
    <td class="num">${r.overheads ? "-" + money(r.overheads) : "–"}</td><td class="num ${r.net < 0 ? "neg" : ""}">${money(r.net)}</td>
    <td class="num ${r.ending_cash < 0 ? "neg" : ""}"><strong>${money(r.ending_cash)}</strong></td></tr>`).join("");
  const low = c.rows.reduce((m, r) => (r.ending_cash < m.ending_cash ? r : m), c.rows[0]);
  return `<h1>Cash flow forecast</h1>
    <p class="lede">A six-month projection of your cash: Amazon payouts at your current sales pace, minus purchase order payments and monthly overheads. Use it to see whether you can afford the next order before the money from the last one arrives.</p>
    <div class="card"><form id="cash" class="fields three">
      <div><label>Cash on hand today ($)</label><input type="number" step="any" name="starting_cash" value="${esc(st.starting_cash)}"></div>
      <div><label>Days from sale to payout</label><input type="number" name="payout_delay_days" value="${esc(st.payout_delay_days)}"></div>
      <div><label>Sales growth per month (%)</label><input type="number" step="any" name="sales_growth_pct" value="${esc(st.sales_growth_pct)}"></div></form></div>
    <div class="tiles">${tile("Payouts per day", money(c.daily_payout), "at the last 30 days' pace, after fees and ads")}
      ${tile("Lowest cash point", compact(low.ending_cash), monthName(low.month))}${tile("Cash in six months", compact(c.rows[c.rows.length - 1].ending_cash), monthName(c.rows[c.rows.length - 1].month))}</div>
    ${low.ending_cash < 0 ? `<div class="note">Cash goes negative in ${monthName(low.month)}. Delay an order, reduce its size, or add funds before then.</div>` : ""}
    ${c.undated_payments ? `<div class="note">${c.undated_payments} purchase order payment${c.undated_payments === 1 ? " has" : "s have"} no date and ${c.undated_payments === 1 ? "is" : "are"} left out. Add dates under Purchase orders.</div>` : ""}
    <div class="card"><h2>Cash at the end of each month</h2>${hbar(c.rows.map((r) => ({ label: monthName(r.month), value: r.ending_cash, tip: `${monthName(r.month)}|Ending cash ${money(r.ending_cash)}|In ${money(r.inflow)} · out ${money(r.po_payments + r.overheads)}` })), "Cash at the end of each month")}</div>
    <div class="card scroll"><table><thead><tr><th>Month</th><th class="num">Amazon payouts</th><th class="num">Order payments</th><th class="num">Overheads</th><th class="num">Net</th><th class="num">Ending cash</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted small">The first row covers the rest of this month. Payouts assume your recent sales pace continues and that you do not run out of stock; product cost appears as order payments, not per sale. Past-dated order payments are treated as already paid.</p></div>`;
};

Object.assign(actions, {
  "import-keywords": () => pickCsv((csv) => run(() => api("POST", "import/keywords", { csv, product_id: current().id }),
    (r) => `Imported ${plural(r.added, "keyword")}` + (r.duplicates ? `, skipped ${plural(r.duplicates, "duplicate")}` : "") + `. Columns read: ${r.columns_used.join(", ")}`)),
  "keywords-to-listing": () => run(() => api("POST", "keywords/to-listing", { product_id: current().id, count: 15 }), (r) => `Top ${r.count} keywords sent to the listing inputs`),
  "log-check": (el) => openForm("Log a check", [{ name: "date", label: "Date", type: "date" }, { name: "price", label: "Price ($)", type: "number" },
    { name: "reviews", label: "Review count", type: "number" }, { name: "rating", label: "Star rating", type: "number" }], { date: S.today },
    (v) => run(() => api("POST", "snapshots", { ...v, competitor_id: Number(el.dataset.id) }), "Check logged")),
  "history": (el) => {
    const c = S.competitors.find((x) => x.id === Number(el.dataset.id));
    openInfo("History: " + c.name, `<div class="scroll"><table><thead><tr><th>Date</th><th class="num">Price</th><th class="num">Reviews</th><th class="num">Rating</th></tr></thead>
      <tbody>${[...c.snapshots].reverse().map((s) => `<tr><td>${esc(s.date)}</td><td class="num">${money(s.price)}</td><td class="num">${int(s.reviews)}</td><td class="num">${s.rating || "–"}</td></tr>`).join("")}</tbody></table></div>`);
  },
  "analyze-reviews": () => run(() => api("POST", "reviews", { product_id: current().id, text: document.getElementById("review-text").value }), "Reviews analysed"),
  "standard-tasks": () => run(() => api("POST", "tasks/template", { product_id: current().id }), (r) => (r.added ? `Added ${plural(r.added, "task")}` : "The standard tasks are already there")),
  "import-ads": () => pickCsv((csv) => run(() => api("POST", "import/ads", { csv, product_id: current().id }), (r) => `Imported ${plural(r.added, "row")}. Columns read: ${r.columns_used.join(", ")}`)),
  "clear-ads": () => { if (confirm("Delete all imported ad data for this product?")) run(() => api("POST", "ads/clear", { product_id: current().id }), "Ad data cleared"); },
});

load().catch((error) => { main.innerHTML = `<div class="card">Could not load: ${esc(error.message)}</div>`; });
