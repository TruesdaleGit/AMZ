"use strict";
// Calculation engine for the in-browser (iPhone / web) version.
// A line-for-line port of logic.py: tests/compare_engines.js checks that both give the same numbers.
// Fee figures are ESTIMATES; set an override on the product once you have the real number.
(function (root) {

const DEFAULT_SETTINGS = {
  referral_pct: "15", returns_pct: "3", target_margin_pct: "30", assumed_cost_pct: "25",
  safety_stock_days: "14", reorder_cover_days: "60",
  store_name: "My Brand Store", store_tagline: "Thoughtfully made everyday essentials",
  brand: "MyBrand", your_name: "", company: "",
  w_demand: "25", w_competition: "25", w_price: "15", w_margin: "15", w_rating: "10", w_size: "10",
  filter_seasonal: "halloween, christmas, xmas, santa, advent calendar, easter, valentine, valentines, thanksgiving, "
    + "fourth of july, 4th of july, independence day, hanukkah, menorah, new years, new year's, "
    + "st patricks, st. patrick's, mardi gras, cinco de mayo, mother's day, mothers day, father's day, "
    + "fathers day, costume, jack-o-lantern, jack o lantern, pumpkin carving, trick or treat, snowman, "
    + "reindeer, nutcracker, ornament, stocking stuffer, christmas tree, wreath, tinsel, elf on, "
    + "easter egg, easter basket, graduation, back to school, holiday decor, holiday decoration",
  filter_gated: "ink cartridge, toner cartridge, printer ink, toner, supplement, vitamin, probiotic, protein powder, "
    + "dietary, cbd, hemp oil, medication, medicine, otc, pharmacy, medical device, contact lens, "
    + "pesticide, insecticide, weed killer, rodenticide, alcohol, wine, beer, liquor, tobacco, vape, "
    + "e-cigarette, nicotine, firearm, ammunition, ammo, gun, knife, taser, pepper spray, firework, "
    + "lithium battery, aerosol, flammable, propane, baby formula, infant formula, car seat, "
    + "gift card, dvd, blu-ray, video game, software, fine jewelry, collectible coin, "
    + "disney, marvel, pokemon, star wars, harry potter, lego, nintendo, barbie, hello kitty, nfl, nba, "
    + "mlb, nhl, nike, adidas",
  est_duty_pct: "10", est_freight_per_lb: "2", est_freight_flat: "1",
  capture_share_pct: "30", launch_ad_pct: "15", launch_fixed_cost: "1000", min_monthly_profit: "1000",
  default_first_order: "500",
  starting_cash: "0", payout_delay_days: "14", sales_growth_pct: "0",
  store_theme: "forest", store_description: "", about_text: "", contact_email: "", contact_text: "",
};

// Parse numbers that may arrive as '1,234', '$19.99', '' or null. Pass def = null to detect "missing".
function num(value, def) {
  if (def === undefined) def = 0;
  if (value === null || value === undefined) return def;
  if (typeof value === "number") return Number.isFinite(value) ? value : def;
  if (typeof value === "boolean") return value ? 1 : 0;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "." || cleaned === "-.") return def;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : def;
}
// Rounds exactly like Python's round(): correct rounding of the stored binary value, and an exact half goes to
// the even digit. This keeps the PC and phone versions equal to the cent.
function roundTo(x, places) {
  if (!Number.isFinite(x)) return x;
  const j = x * Math.pow(2, places + 1);              // exact: only the exponent changes
  if (Number.isInteger(j) && Math.abs(j % 2) === 1) {  // x is exactly halfway between two candidates
    const lower = Math.floor(j * Math.pow(5, places) / 2);
    return (lower % 2 === 0 ? lower : lower + 1) / Math.pow(10, places);
  }
  return Number(x.toFixed(places));
}
const roundHalfEven = (y) => roundTo(y, 0);
const r2 = (x) => roundTo(x, 2);
const r1 = (x) => roundTo(x, 1);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (s) => String(s || "").split(/\s+/).filter(Boolean);
const squash = (s) => words(s).join(" ");
const log10 = (x) => Math.log(x) / Math.LN10;

// ---------------------------------------------------------------- FBA fees

const STANDARD_TIERS = [[0.25, 3.68], [0.5, 3.90], [0.75, 4.15], [1.0, 4.55], [1.25, 4.99], [1.5, 5.37],
  [1.75, 5.52], [2.0, 5.77], [2.25, 5.87], [2.5, 6.05], [2.75, 6.21], [3.0, 6.62]];

// Approximate US FBA fulfilment fee per unit. Returns [fee, sizeTier].
function estimateFbaFee(weightLb, lengthIn, widthIn, heightIn) {
  const weight = Math.max(num(weightLb), 0);
  const dims = [num(lengthIn), num(widthIn), num(heightIn)].sort((a, b) => b - a);
  const [longest, median, shortest] = dims;
  const allDims = dims.every((d) => d);
  const dimWeight = allDims ? (longest * median * shortest) / 139 : 0;
  const shipWeight = Math.max(weight, dimWeight);
  if (weight === 0 && !allDims) return [0, "unknown"];
  const small = weight <= 1 && allDims && longest <= 15 && median <= 12 && shortest <= 0.75;
  const standard = shipWeight <= 20 && (!allDims || (longest <= 18 && median <= 14 && shortest <= 8));
  if (small) return [r2(Math.min(3.06 + 0.12 * Math.ceil(Math.max(weight * 16 - 2, 0) / 2), 3.65)), "small standard"];
  if (standard) {
    for (const [limit, fee] of STANDARD_TIERS) if (shipWeight <= limit) return [fee, "large standard"];
    return [r2(6.92 + 0.08 * Math.ceil((shipWeight - 3.0) * 4)), "large standard"];
  }
  return [r2(9.61 + 0.38 * Math.max(Math.ceil(shipWeight) - 1, 0)), "bulky"];
}

// ---------------------------------------------------------- unit economics

// unitCost is in the quote's currency; freight and other costs are in USD.
function landedAt(quote, unitCost) {
  const unit = unitCost * (num(quote.fx_rate, 1) || 1);
  return r2(unit + unit * num(quote.duty_pct) / 100 + num(quote.freight_per_unit) + num(quote.other_per_unit));
}
const landedCost = (quote) => (quote ? landedAt(quote, num(quote.unit_cost)) : null);

function priceBreaks(quote) {
  const tiers = [];
  for (const part of String(quote.price_breaks || "").split(/[,;\n]/)) {
    const i = part.indexOf(":");
    const qty = i < 0 ? part : part.slice(0, i), price = i < 0 ? "" : part.slice(i + 1);
    if (num(qty) > 0 && num(price) > 0) tiers.push({ quantity: Math.trunc(num(qty)), unit_cost: num(price), landed_cost: landedAt(quote, num(price)) });
  }
  return tiers.sort((a, b) => a.quantity - b.quantity);
}

// Landed cost estimated from the Alibaba price range entered on a product.
function listedCost(product, settings) {
  const prices = [num(product.cost_low, null), num(product.cost_high, null)].filter((p) => p !== null && p > 0);
  if (!prices.length) return null;
  const unit = prices.reduce((a, b) => a + b, 0) / prices.length;
  const duty = unit * num(settings.est_duty_pct, 10) / 100;
  const weight = num(product.weight_lb);
  const freight = weight ? num(settings.est_freight_per_lb, 2) * Math.max(weight, 0.25) : num(settings.est_freight_flat, 1);
  return { unit_cost: r2(unit), low: Math.min(...prices), high: Math.max(...prices), duty: r2(duty), freight: r2(freight), landed_cost: r2(unit + duty + freight) };
}

function alibabaSearchUrl(product) {
  const query = squash(String(product.name || "").replace(/[^A-Za-z0-9 ]+/g, " "));
  return query ? "https://www.alibaba.com/trade/search?SearchText=" + query.split(" ").join("+") : "";
}

// The quote marked chosen, otherwise the cheapest landed cost.
function pickQuote(quotes) {
  if (!quotes || !quotes.length) return null;
  const chosen = quotes.find((q) => q.chosen);
  if (chosen) return chosen;
  return quotes.reduce((best, q) => ((landedCost(q) || 0) < (landedCost(best) || 0) ? q : best), quotes[0]);
}

function unitEconomics(product, quote, settings, atPrice) {
  const price = atPrice === undefined ? num(product.price) : atPrice;
  let referralPct = num(product.referral_pct, null);
  if (referralPct === null) referralPct = num(settings.referral_pct, 15);
  const referral = price > 0 ? r2(Math.max(price * referralPct / 100, 0.30)) : 0;

  const override = num(product.fba_fee_override, null);
  let fba, tier, fbaSource;
  if (override !== null) { fba = override; tier = "override"; fbaSource = "override"; }
  else { [fba, tier] = estimateFbaFee(product.weight_lb, product.length_in, product.width_in, product.height_in); fbaSource = "estimate"; }

  let cost = landedCost(quote), costSource = "quote";
  const listed = cost === null ? listedCost(product, settings) : null;
  if (listed) { cost = listed.landed_cost; costSource = "alibaba"; }
  else if (cost === null) { cost = r2(price * num(settings.assumed_cost_pct, 25) / 100); costSource = "assumed"; }

  const returns = r2(price * num(settings.returns_pct, 3) / 100);
  const profit = r2(price - referral - fba - cost - returns);
  const preAd = price - referral - fba - cost;
  return {
    price: r2(price), referral_fee: referral, referral_pct: referralPct, fba_fee: r2(fba), fba_source: fbaSource,
    size_tier: tier, landed_cost: cost, cost_source: costSource, returns_allowance: returns, profit,
    margin_pct: price > 0 ? r1(profit / price * 100) : 0, roi_pct: cost > 0 ? r1(profit / cost * 100) : 0,
    break_even_acos_pct: price > 0 ? r1(preAd / price * 100) : 0,   // highest ad cost of sale that still breaks even
  };
}

// Lowest price that still hits the target net margin. null if impossible or the cost is only assumed.
function minPriceForMargin(product, quote, settings) {
  const eco = unitEconomics(product, quote, settings);
  const share = 1 - (eco.referral_pct + num(settings.returns_pct, 3) + num(settings.target_margin_pct, 30)) / 100;
  if (share <= 0 || eco.cost_source === "assumed") return null;
  return r2((eco.landed_cost + eco.fba_fee) / share);
}

// Profit per unit at a few price points. Does NOT model demand changes.
function priceScenarios(product, quote, settings) {
  const base = num(product.price);
  return [-15, -10, -5, 0, 5, 10, 15].map((delta) => {
    const price = r2(base * (1 + delta / 100));
    const eco = unitEconomics(product, quote, settings, price);
    return { change_pct: delta, price, profit: eco.profit, margin_pct: eco.margin_pct };
  });
}

// ------------------------------------------------------- opportunity score

const ramp = (value, worst, best) => (best === worst ? 0 : Math.max(0, Math.min(1, (value - worst) / (best - worst))));
const SCORE_PARTS = [["demand", "w_demand"], ["competition", "w_competition"], ["price_fit", "w_price"],
  ["margin", "w_margin"], ["rating_gap", "w_rating"], ["size", "w_size"]];

function opportunityScore(product, eco, settings) {
  settings = settings || DEFAULT_SETTINGS;
  const price = num(product.price), sales = num(product.monthly_sales), reviews = num(product.reviews);
  const rating = num(product.rating), weight = num(product.weight_lb);
  const raw = {
    price_fit: price >= 20 && price <= 70 ? 1 : price < 20 ? ramp(price, 8, 20) : ramp(price, 150, 70),
    demand: ramp(sales, 0, 400),
    competition: reviews ? ramp(log10(Math.max(reviews, 1)), log10(3000), log10(150)) : 0.5,
    rating_gap: rating ? ramp(rating, 4.7, 4.0) : 0.5,
    size: weight ? ramp(weight, 5, 1) : 0.5,
    margin: ramp(eco.margin_pct, 5, 30),
  };
  const weights = {};
  let total = 0;
  for (const [name, key] of SCORE_PARTS) { weights[name] = Math.max(num(settings[key], num(DEFAULT_SETTINGS[key])), 0); total += weights[name]; }
  total = total || 1;
  const parts = {}, shown = {};
  let score = 0;
  for (const name of Object.keys(raw)) {
    const w = weights[name] / total * 100;
    parts[name] = r1(raw[name] * w); shown[name] = r1(w); score += raw[name] * w;
  }
  return { score: roundHalfEven(score), parts, weights: shown };
}

// ----------------------------------------------------------- auto-filter

const FILTER_GROUPS = [["filter_seasonal", "Seasonal"], ["filter_gated", "Gated or hard to source"]];
// "(^|[^a-z0-9])" instead of a lookbehind, which older iPhones do not support.
const wholeWord = (term, plural) => new RegExp("(^|[^a-z0-9])" + esc(term) + (plural ? "(?:e?s)?" : "") + "(?![a-z0-9])");

function filterMatches(product, settings) {
  const text = `${product.name || ""} ${product.description || ""} ${product.category || ""}`.toLowerCase().replace(/’/g, "'");
  const reasons = [];
  for (const [key, label] of FILTER_GROUPS) {
    const source = settings[key] !== undefined && settings[key] !== null ? settings[key] : DEFAULT_SETTINGS[key];
    const terms = String(source || "").split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const hits = terms.filter((t) => wholeWord(t, true).test(text));
    if (hits.length) reasons.push({ group: label, terms: hits.slice(0, 3) });
  }
  return reasons;
}

// ------------------------------------------------------ profit potential

const VERDICT_ORDER = { proceed: 0, investigate: 1, skip: 2 };
const commas = (n) => Math.round(n).toLocaleString("en-US");

// Estimate what launching this product could earn, and whether to proceed. Every figure is an estimate.
function profitPotential(product, eco, quote, settings) {
  const price = num(product.price), sales = num(product.monthly_sales), reviews = num(product.reviews), rating = num(product.rating);
  const knownSize = num(product.weight_lb) > 0 || num(product.fba_fee_override, null) !== null;

  const ease = reviews ? ramp(log10(Math.max(reviews, 1)), log10(3000), log10(150)) : 0.5;
  const share = num(settings.capture_share_pct, 30) / 100 * (0.3 + 0.7 * ease);
  const units = sales * share;
  const ad = price * num(settings.launch_ad_pct, 15) / 100;
  const unitProfit = r2(eco.profit - ad);
  const margin = price ? r1(unitProfit / price * 100) : 0;
  const monthlyProfit = r2(units * unitProfit);

  const baseOrder = quote && num(quote.moq) ? num(quote.moq) : (num(product.cost_moq) || num(settings.default_first_order, 500));
  const firstOrder = Math.trunc(Math.max(baseOrder, Math.ceil(units * 2)));
  const investment = r2(firstOrder * eco.landed_cost + num(settings.launch_fixed_cost, 1000));
  const payback = monthlyProfit > 0 ? r1(investment / monthlyProfit) : null;
  const annualRoi = investment > 0 ? roundHalfEven(monthlyProfit * 12 / investment * 100) : 0;
  const minimum = num(settings.min_monthly_profit, 1000);

  const blockers = [], risks = [];
  if (price <= 0) blockers.push("No price");
  if (sales <= 0) blockers.push("No sales estimate");
  if (!knownSize) blockers.push("No weight, so the FBA fee is missing and profit is overstated");
  if (eco.cost_source === "assumed") risks.push("Product cost is assumed; look it up on Alibaba or get a quote");
  else if (eco.cost_source === "alibaba") risks.push("Cost is an Alibaba listing price; confirm with a supplier quote");
  if (!reviews) risks.push("No review count, so competition is unknown");
  else if (reviews > 1500) risks.push(`Strong incumbents (${commas(Math.trunc(reviews))} reviews)`);
  if (rating >= 4.6) risks.push(`Hard to improve on a ${rating.toFixed(1)} rating`);
  if (price > 0 && price < 15) risks.push("Low price leaves little room for ads");
  if (eco.size_tier === "bulky") risks.push("Bulky: higher fees and freight");
  if (price > 0 && margin > 0 && margin < 15) risks.push(`Thin margin after ads (${margin.toFixed(0)}%)`);
  if (payback !== null && payback > 6) risks.push(`Slow payback (${payback} months)`);

  let verdict, why;
  if (price > 0 && unitProfit <= 0) { verdict = "skip"; why = "Loses money on each sale after ads"; }
  else if (sales > 0 && knownSize && monthlyProfit < minimum * 0.25) { verdict = "skip"; why = `Estimated profit is far below your $${commas(minimum)} a month minimum`; }
  else if (blockers.length) { verdict = "investigate"; why = blockers[0]; }
  else if (monthlyProfit < minimum) { verdict = "investigate"; why = `Estimated profit is below your $${commas(minimum)} a month minimum`; }
  else if (margin < 15) { verdict = "investigate"; why = "Margin after ads is under 15%"; }
  else if (payback !== null && payback > 6) { verdict = "investigate"; why = "Takes more than 6 months to earn back the investment"; }
  else { verdict = "proceed"; why = "Clears your profit minimum with a workable margin and payback"; }

  return { verdict, why, est_units: roundHalfEven(units), share_pct: r1(share * 100), unit_profit_after_ads: unitProfit,
    margin_after_ads_pct: margin, monthly_profit: monthlyProfit, first_order: firstOrder, investment,
    payback_months: payback, annual_roi_pct: annualRoi, flags: blockers.concat(risks) };
}

// Order by verdict, then estimated monthly profit. Dropped products are left out.
function rankProducts(products) {
  const ranked = products.filter((p) => p.status !== "dropped");
  ranked.sort((a, b) => (VERDICT_ORDER[a.potential.verdict] - VERDICT_ORDER[b.potential.verdict]) || (b.potential.monthly_profit - a.potential.monthly_profit));
  ranked.forEach((p, i) => { p.potential.rank = i + 1; });
  return ranked;
}

// ------------------------------------------------------------- keywords

function keywordPriority(searchVolume, competingProducts) {
  const volume = ramp(log10(Math.max(num(searchVolume), 1)), 2, log10(50000));
  const competing = num(competingProducts);
  const ease = competing ? ramp(log10(Math.max(competing, 1)), 5, 2) : 0.5;
  return roundHalfEven(volume * 60 + ease * 40);
}

// -------------------------------------------------------- review analysis

const COMPLAINT_THEMES = {
  "Broke or stopped working": ["broke", "broken", "breaks", "snapped", "cracked", "stopped working", "fell apart", "tore", "ripped", "split"],
  "Cheap or flimsy feel": ["flimsy", "cheap", "thin", "poor quality", "low quality", "cheaply", "feels cheap", "not sturdy", "wobbly"],
  "Wrong size or fit": ["too small", "too big", "too large", "smaller than", "bigger than", "doesn't fit", "does not fit", "didn't fit", "not fit", "too short", "too long", "too tight", "too loose", "runs small", "runs large"],
  "Smell": ["smell", "smells", "odor", "stinks", "chemical"],
  "Does not stay in place": ["slides", "slips", "won't stay", "doesn't stay", "does not stay", "falls off", "fell off", "came off", "doesn't stick", "won't stick"],
  "Hard to clean": ["hard to clean", "difficult to clean", "stains", "stained", "mold", "mildew", "rust", "rusted"],
  "Hard to use or assemble": ["hard to", "difficult to", "confusing", "instructions", "assemble", "assembly", "complicated"],
  "Missing or wrong item": ["missing", "wrong item", "not as described", "not as pictured", "different from", "incomplete"],
  "Arrived damaged": ["arrived damaged", "damaged", "dented", "scratched", "bent", "crushed"],
  "Leaks": ["leak", "leaks", "leaked", "leaking", "spills"],
  "Does not last": ["after a week", "after a month", "few weeks", "few days", "couple of weeks", "didn't last", "does not last", "wore out", "worn out"],
  "Not worth the price": ["overpriced", "not worth", "waste of money", "too expensive", "pricey"],
  "Noise": ["noisy", "loud", "squeak", "squeaks", "rattles"],
};
const STOP = new Set(("a about after again all also am an and any are as at be because been before being but by can could did do "
  + "does doing don down each few for from get got had has have having he her here hers him his how i if in into is it its "
  + "just like me more most my no nor not now of off on once one only or other our out over own really same she so some "
  + "such than that the their them then there these they this those through to too under until up use used very was we "
  + "were what when where which while who will with would you your product item bought buy amazon ordered order got just "
  + "t s d ve ll re m").split(" "));

// One review per line; blank lines also separate reviews pasted as paragraphs.
function splitReviews(text) {
  let blocks = String(text || "").split(/\n\s*\n/);
  if (blocks.length < 3) blocks = String(text || "").split(/\r\n|\r|\n/);
  return blocks.map(squash).filter((b) => words(b).length >= 3);
}

// Count complaint themes and repeated phrases. A keyword count, not a reading of the reviews.
function analyzeReviews(text) {
  const reviews = splitReviews(text);
  const themes = [];
  for (const theme of Object.keys(COMPLAINT_THEMES)) {
    let hits = 0;
    const examples = [];
    for (const review of reviews) {
      const lower = review.toLowerCase();
      const found = COMPLAINT_THEMES[theme].find((p) => new RegExp("(^|[^a-z])" + esc(p) + "(?![a-z])").test(lower));
      if (!found) continue;
      hits += 1;
      if (examples.length < 3) {
        const at = lower.indexOf(found), start = Math.max(0, at - 60), end = Math.min(review.length, at + found.length + 80);
        examples.push((start ? "…" : "") + review.slice(start, end).trim() + (end < review.length ? "…" : ""));
      }
    }
    if (hits) themes.push({ theme, count: hits, share_pct: roundHalfEven(hits / reviews.length * 100), examples });
  }
  themes.sort((a, b) => b.count - a.count);

  const counts = new Map();
  for (const review of reviews) {
    const list = review.toLowerCase().match(/[a-z']+/g) || [];
    const seen = new Set();
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      if (STOP.has(a) || STOP.has(b) || a.length < 3 || b.length < 3) continue;
      seen.add(a + " " + b);
    }
    for (const phrase of seen) counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  const phrases = [...counts].filter(([, c]) => c >= 2)
    .sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : 0)).slice(0, 15)
    .map(([phrase, count]) => ({ phrase, count }));
  return { review_count: reviews.length, themes, phrases };
}

// --------------------------------------------------------- listing checks

const TITLE_MAX = 200, BULLET_MAX = 500, DESCRIPTION_MAX = 2000, SEARCH_TERMS_MAX_BYTES = 249;
const PROMO = ["best seller", "bestseller", "best-selling", "#1", "free shipping", "on sale", "sale", "discount", "cheap",
  "guarantee", "guaranteed", "money back", "100%", "top rated", "hot item", "limited time", "new arrival", "amazon's choice"];
const TITLE_BAD_CHARS = "!$?_{}^¬¦~<>*;";
const promoHits = (text) => { const lower = text.toLowerCase(); return PROMO.filter((p) => wholeWord(p).test(lower)); };
const byteLength = (s) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };

// Check a listing against Amazon's general style rules. Category style guides can be stricter.
function validateListing(listing) {
  const issues = [];
  const add = (level, field, message) => issues.push({ level, field, message });
  const title = String(listing.title || "").trim(), brand = String(listing.brand || "").trim();
  if (!title) add("error", "title", "Title is empty.");
  else {
    if (title.length > TITLE_MAX) add("error", "title", `Title is ${title.length} characters; the limit is ${TITLE_MAX}.`);
    else if (title.length > 80) add("warning", "title", `Title is ${title.length} characters; mobile search shows about 80.`);
    const bad = [...new Set(title)].filter((c) => TITLE_BAD_CHARS.includes(c)).sort();
    if (bad.length) add("error", "title", "Title contains characters Amazon rejects: " + bad.join(" "));
    const caps = (title.match(/[A-Za-z]{4,}/g) || []).filter((w) => w === w.toUpperCase() && w.toLowerCase() !== brand.toLowerCase());
    if (caps.length) add("warning", "title", "Avoid all-caps words in the title: " + caps.slice(0, 5).join(", "));
    const hits = promoHits(title);
    if (hits.length) add("error", "title", "Title contains promotional wording: " + hits.join(", "));
    const list = title.toLowerCase().match(/[a-z0-9]+/g) || [];
    const repeated = [...new Set(list.filter((w) => w.length > 3 && list.filter((x) => x === w).length > 2))].sort();
    if (repeated.length) add("warning", "title", "Words used more than twice in the title: " + repeated.join(", "));
    if (brand && !title.toLowerCase().startsWith(brand.toLowerCase())) add("warning", "title", "Titles usually start with the brand name.");
  }

  const bullets = [1, 2, 3, 4, 5].map((i) => String(listing["bullet" + i] || "").trim());
  const filled = bullets.filter(Boolean).length;
  if (filled < 5) add("warning", "bullets", `${filled} of 5 bullet points are filled in.`);
  bullets.forEach((bullet, index) => {
    const i = index + 1;
    if (!bullet) return;
    if (bullet.length > BULLET_MAX) add("error", "bullet" + i, `Bullet ${i} is ${bullet.length} characters; the limit is ${BULLET_MAX}.`);
    else if (bullet.length > 250) add("warning", "bullet" + i, `Bullet ${i} is ${bullet.length} characters; shorter bullets read better on mobile.`);
    if (bullet[0] !== bullet[0].toUpperCase() && bullet[0] === bullet[0].toLowerCase()) add("warning", "bullet" + i, `Bullet ${i} should start with a capital letter.`);
    const hits = promoHits(bullet);
    if (hits.length) add("error", "bullet" + i, `Bullet ${i} contains promotional wording: ` + hits.join(", "));
  });

  const description = String(listing.description || "").trim();
  if (!description) add("warning", "description", "Description is empty.");
  else if (description.length > DESCRIPTION_MAX) add("error", "description", `Description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}.`);

  const terms = String(listing.search_terms || "").trim();
  if (!terms) add("warning", "search_terms", "Backend search terms are empty.");
  else {
    const size = byteLength(terms);
    if (size > SEARCH_TERMS_MAX_BYTES) add("error", "search_terms", `Search terms are ${size} bytes; Amazon ignores the field above ${SEARCH_TERMS_MAX_BYTES}.`);
    if (terms.includes(",") || terms.includes(";")) add("warning", "search_terms", "Separate search terms with spaces, not commas.");
    const titleWords = new Set(title.toLowerCase().match(/[a-z0-9]+/g) || []);
    const termWords = terms.toLowerCase().match(/[a-z0-9]+/g) || [];
    const dupes = [...new Set(termWords.filter((w) => titleWords.has(w) && w.length > 2))].sort();
    if (dupes.length) add("warning", "search_terms", "Already in the title, so wasted here: " + dupes.slice(0, 8).join(", "));
    if (brand && termWords.includes(brand.toLowerCase())) add("warning", "search_terms", "Do not put brand names in search terms.");
  }
  return issues;
}

const SMALL_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);
const titleCase = (text) => words(String(text).trim()).map((w, i) => (i && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.slice(0, 1).toUpperCase() + w.slice(1))).join(" ");

// Build a first-draft listing from plain inputs. A starting point to edit.
function draftListing(brand, productName, features, keywords) {
  brand = String(brand || "").trim();
  productName = titleCase(productName || "");
  const featureLines = String(features || "").split(/\r\n|\r|\n/).map((f) => f.trim()).filter(Boolean);
  const keywordList = String(keywords || "").split(/[,\n]/).map((k) => k.trim()).filter(Boolean);

  const heads = [], bullets = [];
  for (const line of featureLines.slice(0, 5)) {
    const i = line.indexOf(":");
    let head = i < 0 ? line : line.slice(0, i), body = i < 0 ? "" : line.slice(i + 1);
    if (!body.trim()) { body = head; head = ""; }
    head = titleCase(head);
    body = body.trim();
    body = body.slice(0, 1).toUpperCase() + body.slice(1);
    if (head) heads.push(head);
    bullets.push(head ? `${head} – ${body}` : body);
  }
  while (bullets.length < 5) bullets.push("");

  let title = [brand, productName].filter(Boolean).join(" ");
  for (let extra of keywordList.slice(0, 2).concat(heads.slice(0, 2))) {
    extra = titleCase(extra);
    if (title.toLowerCase().includes(extra.toLowerCase())) continue;
    const candidate = title.includes(",") || title.includes(" – ") ? `${title}, ${extra}` : `${title} – ${extra}`;
    if (candidate.length > 150) break;
    title = candidate;
  }

  const sentences = bullets.filter(Boolean).map((b) => { const i = b.indexOf(" – "); return (i < 0 ? b : b.slice(i + 3)).replace(/\.+$/, "") + "."; });
  const description = (brand ? `${brand} ${productName}. ` : `${productName}. `) + sentences.join(" ");

  const used = new Set((title.toLowerCase().match(/[a-z0-9]+/g) || []).concat(brand.toLowerCase()));
  const terms = [];
  let size = 0;
  for (const phrase of keywordList) {
    for (const word of phrase.toLowerCase().match(/[a-z0-9]+/g) || []) {
      if (used.has(word)) continue;
      const extra = word.length + (terms.length ? 1 : 0);
      if (size + extra > SEARCH_TERMS_MAX_BYTES) break;
      terms.push(word); used.add(word); size += extra;
    }
  }
  const result = { title, description: description.slice(0, DESCRIPTION_MAX), search_terms: terms.join(" ") };
  bullets.slice(0, 5).forEach((b, i) => { result["bullet" + (i + 1)] = b.slice(0, BULLET_MAX); });
  return result;
}

// ------------------------------------------------------------- CSV import

const PRODUCT_ALIASES = {
  name: ["name", "title", "product name", "product title", "product details", "product", "item name"],
  brand: ["brand", "brand name"],
  thumb_url: ["image url", "image", "image link", "main image", "image src", "picture", "picture url", "thumbnail"],
  ref_url: ["url", "product url", "amazon url", "listing url", "link", "product link"],
  asin: ["asin"],
  category: ["category", "main category", "product category"],
  price: ["price", "price $", "price us$", "price (usd)", "avg price", "average price", "buy box price"],
  monthly_sales: ["monthly sales", "sales", "est. monthly sales", "estimated monthly sales", "asin sales", "parent level sales", "units sold", "monthly units", "est sales"],
  reviews: ["reviews", "review count", "number of reviews", "ratings", "reviews count", "# of reviews"],
  rating: ["rating", "avg rating", "average rating", "reviews rating", "stars"],
  weight_lb: ["weight", "weight lb", "weight (lb)", "weight (lbs)", "weight lbs", "item weight"],
  length_in: ["length", "length in", "length (in)"],
  width_in: ["width", "width in", "width (in)"],
  height_in: ["height", "height in", "height (in)"],
  notes: ["notes", "note"],
};
const SALES_ALIASES = {
  date: ["date", "day", "order date"],
  product: ["product", "name", "asin", "sku", "title", "product name"],
  units: ["units", "units ordered", "units sold", "quantity", "qty"],
  revenue: ["revenue", "sales", "ordered product sales", "product sales", "gross sales"],
  ad_spend: ["ad spend", "ad_spend", "spend", "ads", "ppc"],
  refunds: ["refunds", "refund", "refund amount", "returns"],
  sales_tax: ["sales tax", "tax", "tax collected", "marketplace facilitator tax"],
};
const KEYWORD_ALIASES = {
  keyword: ["keyword", "keyword phrase", "phrase", "search term", "keywords"],
  search_volume: ["search volume", "volume", "monthly search volume", "exact search volume"],
  competing_products: ["competing products", "competitors", "competing", "number of competing products"],
};
const ADS_ALIASES = {
  date: ["date", "start date", "day"],
  campaign: ["campaign", "campaign name"],
  keyword: ["keyword", "targeting", "customer search term", "search term"],
  impressions: ["impressions"],
  clicks: ["clicks"],
  spend: ["spend", "cost", "ad spend"],
  sales: ["sales", "7 day total sales", "14 day total sales", "7 day total sales ($)", "14 day total sales ($)", "total sales"],
  orders: ["orders", "7 day total orders (#)", "14 day total orders (#)", "total orders", "purchases"],
};

const normHeader = (h) => String(h || "").trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");

// Split delimited text into rows of cells, honouring double quotes.
function splitCsv(text, delimiter) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Read CSV text into objects keyed by our field names. Unknown columns are dropped. Returns [rows, fieldsUsed].
function parseCsv(text, aliases) {
  text = String(text || "").replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  let delimiter = ",", best = 0;
  for (const d of [",", ";", "\t"]) { const n = firstLine.split(d).length - 1; if (n > best) { best = n; delimiter = d; } }
  const rows = splitCsv(text, delimiter).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return [[], []];
  const headers = rows[0].map(normHeader);
  const mapping = {};
  for (const field of Object.keys(aliases)) {
    for (const name of aliases[field]) { const at = headers.indexOf(name); if (at >= 0) { mapping[field] = at; break; } }
  }
  const out = rows.slice(1).map((row) => {
    const item = {};
    for (const field of Object.keys(mapping)) item[field] = mapping[field] < row.length ? row[mapping[field]].trim() : "";
    return item;
  });
  return [out, Object.keys(mapping).sort()];
}

const TITLE_BREAK = /\s[-–—|\/]\s|[,;:(\[{|–—]/;
const TRAILING = new Set(["with", "for", "and", "&", "of", "in", "the", "to", "by", "a", "an", "on", "+", "w/"]);
const SHORT_TITLE_MAX = 45;
const splitOnce = (text, limit) => {   // like Python's re.split(pattern, text, limit)
  const parts = [];
  let rest = text;
  while (parts.length < limit) { const m = TITLE_BREAK.exec(rest); if (!m) break; parts.push(rest.slice(0, m.index)); rest = rest.slice(m.index + m[0].length); }
  parts.push(rest);
  return parts;
};

// A short product name from a long Amazon title: its first phrase, cut to about 45 characters.
function shortTitle(title, brand) {
  title = squash(title); brand = squash(brand);
  let text = title;
  if (brand && text.toLowerCase().startsWith(brand.toLowerCase() + " ") && words(text).length > words(brand).length + 1) text = text.slice(brand.length).trim();
  if (text.length <= SHORT_TITLE_MAX && !TITLE_BREAK.test(text)) return text;
  let first = splitOnce(text, 1)[0].trim();
  if (words(first).length < 2) first = splitOnce(text, 2).slice(0, 2).map((p) => p.trim()).join(" ").trim();
  const at = first.toLowerCase().indexOf(" for ");   // "... for Dogs & Cats" says who it is for, not what it is
  if (first.length > SHORT_TITLE_MAX && at > 0 && words(first.slice(0, at)).length >= 2) first = first.slice(0, at);
  const list = words(first);
  while (list.length > 2 && list.join(" ").length > SHORT_TITLE_MAX) list.pop();
  while (list.length > 1 && TRAILING.has(list[list.length - 1].toLowerCase())) list.pop();
  return list.join(" ").replace(/^[ \-,]+|[ \-,]+$/g, "") || title.slice(0, SHORT_TITLE_MAX);
}

const slugify = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "product";

const Core = {
  DEFAULT_SETTINGS, num, r1, r2, squash, words, estimateFbaFee, landedCost, priceBreaks, listedCost, alibabaSearchUrl,
  pickQuote, unitEconomics, minPriceForMargin, priceScenarios, opportunityScore, filterMatches, profitPotential,
  rankProducts, keywordPriority, analyzeReviews, validateListing, draftListing, parseCsv, shortTitle, slugify,
  PRODUCT_ALIASES, SALES_ALIASES, KEYWORD_ALIASES, ADS_ALIASES, SHORT_TITLE_MAX,
};
if (typeof module !== "undefined" && module.exports) module.exports = Core;
else root.Core = Core;

})(typeof self !== "undefined" ? self : this);
