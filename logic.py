"""Pure calculation logic: fees, unit economics, scoring, listing rules, CSV mapping.

Nothing in here touches the database or the network, so it is easy to test.
All fee figures are ESTIMATES. Amazon changes its fee tables regularly; set an
override on the product once you have the real number from Seller Central.
"""
import csv
import io
import math
import re

DEFAULT_SETTINGS = {
    "referral_pct": "15",          # Amazon referral fee, % of price
    "returns_pct": "3",            # allowance for refunds, % of price
    "target_margin_pct": "30",     # net margin you want after all costs
    "assumed_cost_pct": "25",      # landed cost guess (% of price) before any quote exists
    "safety_stock_days": "14",
    "reorder_cover_days": "60",
    "store_name": "My Brand Store",
    "store_tagline": "Thoughtfully made everyday essentials",
    "brand": "MyBrand",
    "your_name": "",
    "company": "",
}


def num(value, default=0.0):
    """Parse numbers that may arrive as '1,234', '$19.99', '' or None."""
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = re.sub(r"[^0-9.\-]", "", str(value))
    if cleaned in ("", "-", ".", "-."):
        return default
    try:
        return float(cleaned)
    except ValueError:
        return default


# ---------------------------------------------------------------- FBA fees

# (max shipping weight in lb, fee) for large standard-size items. Approximate.
_STANDARD_TIERS = [
    (0.25, 3.68), (0.5, 3.90), (0.75, 4.15), (1.0, 4.55), (1.25, 4.99),
    (1.5, 5.37), (1.75, 5.52), (2.0, 5.77), (2.25, 5.87), (2.5, 6.05),
    (2.75, 6.21), (3.0, 6.62),
]


def estimate_fba_fee(weight_lb, length_in=0, width_in=0, height_in=0):
    """Approximate US FBA fulfilment fee per unit. Returns (fee, size_tier)."""
    weight_lb = max(num(weight_lb), 0)
    dims = sorted([num(length_in), num(width_in), num(height_in)], reverse=True)
    longest, median, shortest = dims
    dim_weight = (longest * median * shortest) / 139 if all(dims) else 0
    ship_weight = max(weight_lb, dim_weight)

    if weight_lb == 0 and not all(dims):
        return 0.0, "unknown"

    small = (weight_lb <= 1 and (not all(dims) or (longest <= 15 and median <= 12 and shortest <= 0.75)) and all(dims))
    standard = ship_weight <= 20 and (not all(dims) or (longest <= 18 and median <= 14 and shortest <= 8))

    if small:
        fee = 3.06 + 0.12 * math.ceil(max(weight_lb * 16 - 2, 0) / 2)
        return round(min(fee, 3.65), 2), "small standard"
    if standard:
        for limit, fee in _STANDARD_TIERS:
            if ship_weight <= limit:
                return fee, "large standard"
        extra_quarters = math.ceil((ship_weight - 3.0) * 4)
        return round(6.92 + 0.08 * extra_quarters, 2), "large standard"
    fee = 9.61 + 0.38 * max(math.ceil(ship_weight) - 1, 0)
    return round(fee, 2), "bulky"


# ---------------------------------------------------------- unit economics

def landed_cost(quote):
    """Cost to get one unit into Amazon's warehouse, from a supplier quote."""
    if not quote:
        return None
    unit = num(quote.get("unit_cost"))
    duty = unit * num(quote.get("duty_pct")) / 100
    return round(unit + duty + num(quote.get("freight_per_unit")) + num(quote.get("other_per_unit")), 2)


def pick_quote(quotes):
    """The quote marked chosen, otherwise the cheapest landed cost."""
    if not quotes:
        return None
    chosen = [q for q in quotes if q.get("chosen")]
    if chosen:
        return chosen[0]
    return min(quotes, key=lambda q: landed_cost(q) or 0)


def unit_economics(product, quote, settings, price=None):
    """Per-unit profit picture for a product at a given (or its own) price."""
    price = num(product.get("price")) if price is None else price
    referral_pct = num(product.get("referral_pct"), None)
    if referral_pct is None:
        referral_pct = num(settings.get("referral_pct"), 15)
    referral = round(max(price * referral_pct / 100, 0.30), 2) if price > 0 else 0.0

    override = num(product.get("fba_fee_override"), None)
    if override is not None:
        fba, tier, fba_source = override, "override", "override"
    else:
        fba, tier = estimate_fba_fee(product.get("weight_lb"), product.get("length_in"),
                                     product.get("width_in"), product.get("height_in"))
        fba_source = "estimate"

    cost = landed_cost(quote)
    cost_source = "quote"
    if cost is None:
        cost = round(price * num(settings.get("assumed_cost_pct"), 25) / 100, 2)
        cost_source = "assumed"

    returns = round(price * num(settings.get("returns_pct"), 3) / 100, 2)
    profit = round(price - referral - fba - cost - returns, 2)
    pre_ad = price - referral - fba - cost
    return {
        "price": round(price, 2),
        "referral_fee": referral,
        "referral_pct": referral_pct,
        "fba_fee": round(fba, 2),
        "fba_source": fba_source,
        "size_tier": tier,
        "landed_cost": cost,
        "cost_source": cost_source,
        "returns_allowance": returns,
        "profit": profit,
        "margin_pct": round(profit / price * 100, 1) if price > 0 else 0.0,
        "roi_pct": round(profit / cost * 100, 1) if cost > 0 else 0.0,
        # Highest ad cost of sale at which a sale still breaks even.
        "break_even_acos_pct": round(pre_ad / price * 100, 1) if price > 0 else 0.0,
    }


def min_price_for_margin(product, quote, settings, target_pct=None):
    """Lowest price that still hits the target net margin. None if impossible."""
    eco = unit_economics(product, quote, settings)
    target = num(settings.get("target_margin_pct"), 30) if target_pct is None else target_pct
    share = 1 - (eco["referral_pct"] + num(settings.get("returns_pct"), 3) + target) / 100
    if share <= 0:
        return None
    cost = eco["landed_cost"]
    if eco["cost_source"] == "assumed":
        return None
    return round((cost + eco["fba_fee"]) / share, 2)


def price_scenarios(product, quote, settings):
    """Profit per unit at a few price points. Does NOT model demand changes."""
    base = num(product.get("price"))
    out = []
    for delta in (-15, -10, -5, 0, 5, 10, 15):
        price = round(base * (1 + delta / 100), 2)
        eco = unit_economics(product, quote, settings, price=price)
        out.append({"change_pct": delta, "price": price, "profit": eco["profit"],
                    "margin_pct": eco["margin_pct"]})
    return out


# ------------------------------------------------------- opportunity score

def _ramp(value, worst, best):
    """0..1 as value moves from worst to best (works in either direction)."""
    if best == worst:
        return 0.0
    return max(0.0, min(1.0, (value - worst) / (best - worst)))


def opportunity_score(product, eco):
    """0-100 score with the parts that make it up, so the number is explainable."""
    price = num(product.get("price"))
    sales = num(product.get("monthly_sales"))
    reviews = num(product.get("reviews"))
    rating = num(product.get("rating"))
    weight = num(product.get("weight_lb"))

    if 20 <= price <= 70:
        price_fit = 1.0
    elif price < 20:
        price_fit = _ramp(price, 8, 20)
    else:
        price_fit = _ramp(price, 150, 70)

    demand = _ramp(sales, 0, 400)
    # Fewer reviews on the incumbents means an easier page one. Log scale.
    competition = _ramp(math.log10(max(reviews, 1)), math.log10(3000), math.log10(150)) if reviews else 0.5
    rating_gap = _ramp(rating, 4.7, 4.0) if rating else 0.5
    size = _ramp(weight, 5, 1) if weight else 0.5
    margin = _ramp(eco["margin_pct"], 5, 30)

    parts = {
        "price_fit": round(price_fit * 15, 1),
        "demand": round(demand * 25, 1),
        "competition": round(competition * 25, 1),
        "rating_gap": round(rating_gap * 10, 1),
        "size": round(size * 10, 1),
        "margin": round(margin * 15, 1),
    }
    return {"score": round(sum(parts.values())), "parts": parts}


# --------------------------------------------------------- listing checks

TITLE_MAX = 200
BULLET_MAX = 500
DESCRIPTION_MAX = 2000
SEARCH_TERMS_MAX_BYTES = 249

_PROMO = ["best seller", "bestseller", "best-selling", "#1", "free shipping", "on sale",
          "sale", "discount", "cheap", "guarantee", "guaranteed", "money back", "100%",
          "top rated", "hot item", "limited time", "new arrival", "amazon's choice"]
_TITLE_BAD_CHARS = set("!$?_{}^¬¦~<>*;")


def _promo_hits(text):
    lower = text.lower()
    return [p for p in _PROMO if re.search(r"(?<![a-z0-9])" + re.escape(p) + r"(?![a-z0-9])", lower)]


def validate_listing(listing):
    """Check a listing against Amazon's general style rules.

    Returns a list of {level: error|warning, field, message}. Category style
    guides can be stricter than these general rules.
    """
    issues = []

    def add(level, field, message):
        issues.append({"level": level, "field": field, "message": message})

    title = (listing.get("title") or "").strip()
    brand = (listing.get("brand") or "").strip()
    if not title:
        add("error", "title", "Title is empty.")
    else:
        if len(title) > TITLE_MAX:
            add("error", "title", f"Title is {len(title)} characters; the limit is {TITLE_MAX}.")
        elif len(title) > 80:
            add("warning", "title", f"Title is {len(title)} characters; mobile search shows about 80.")
        bad = sorted(set(title) & _TITLE_BAD_CHARS)
        if bad:
            add("error", "title", "Title contains characters Amazon rejects: " + " ".join(bad))
        caps = [w for w in re.findall(r"[A-Za-z]{4,}", title) if w.isupper() and w.lower() != brand.lower()]
        if caps:
            add("warning", "title", "Avoid all-caps words in the title: " + ", ".join(caps[:5]))
        hits = _promo_hits(title)
        if hits:
            add("error", "title", "Title contains promotional wording: " + ", ".join(hits))
        words = re.findall(r"[a-z0-9]+", title.lower())
        repeated = sorted({w for w in words if len(w) > 3 and words.count(w) > 2})
        if repeated:
            add("warning", "title", "Words used more than twice in the title: " + ", ".join(repeated))
        if brand and not title.lower().startswith(brand.lower()):
            add("warning", "title", "Titles usually start with the brand name.")

    bullets = [(listing.get(f"bullet{i}") or "").strip() for i in range(1, 6)]
    filled = [b for b in bullets if b]
    if len(filled) < 5:
        add("warning", "bullets", f"{len(filled)} of 5 bullet points are filled in.")
    for i, bullet in enumerate(bullets, 1):
        if not bullet:
            continue
        if len(bullet) > BULLET_MAX:
            add("error", f"bullet{i}", f"Bullet {i} is {len(bullet)} characters; the limit is {BULLET_MAX}.")
        elif len(bullet) > 250:
            add("warning", f"bullet{i}", f"Bullet {i} is {len(bullet)} characters; shorter bullets read better on mobile.")
        if bullet[0].islower():
            add("warning", f"bullet{i}", f"Bullet {i} should start with a capital letter.")
        hits = _promo_hits(bullet)
        if hits:
            add("error", f"bullet{i}", f"Bullet {i} contains promotional wording: " + ", ".join(hits))

    description = (listing.get("description") or "").strip()
    if not description:
        add("warning", "description", "Description is empty.")
    elif len(description) > DESCRIPTION_MAX:
        add("error", "description", f"Description is {len(description)} characters; the limit is {DESCRIPTION_MAX}.")

    terms = (listing.get("search_terms") or "").strip()
    if not terms:
        add("warning", "search_terms", "Backend search terms are empty.")
    else:
        size = len(terms.encode("utf-8"))
        if size > SEARCH_TERMS_MAX_BYTES:
            add("error", "search_terms", f"Search terms are {size} bytes; Amazon ignores the field above {SEARCH_TERMS_MAX_BYTES}.")
        if "," in terms or ";" in terms:
            add("warning", "search_terms", "Separate search terms with spaces, not commas.")
        title_words = set(re.findall(r"[a-z0-9]+", title.lower()))
        term_words = re.findall(r"[a-z0-9]+", terms.lower())
        dupes = sorted({w for w in term_words if w in title_words and len(w) > 2})
        if dupes:
            add("warning", "search_terms", "Already in the title, so wasted here: " + ", ".join(dupes[:8]))
        if brand and brand.lower() in term_words:
            add("warning", "search_terms", "Do not put brand names in search terms.")
    return issues


def _title_case(text):
    small = {"a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"}
    words = text.strip().split()
    out = []
    for i, word in enumerate(words):
        out.append(word.lower() if (i and word.lower() in small) else word[:1].upper() + word[1:])
    return " ".join(out)


def draft_listing(brand, product_name, features, keywords):
    """Build a first-draft listing from plain inputs. A starting point to edit.

    features: lines of "Heading: benefit sentence" (heading optional)
    keywords: comma or newline separated phrases, most important first
    """
    brand = (brand or "").strip()
    product_name = _title_case(product_name or "")
    feature_lines = [f.strip() for f in (features or "").splitlines() if f.strip()]
    keyword_list = [k.strip() for k in re.split(r"[,\n]", keywords or "") if k.strip()]

    heads, bullets = [], []
    for line in feature_lines[:5]:
        head, _, body = line.partition(":")
        if not body.strip():
            head, body = "", head
        head = _title_case(head)
        body = body.strip()
        body = body[:1].upper() + body[1:]
        if head:
            heads.append(head)
        bullets.append(f"{head} – {body}" if head else body)
    while len(bullets) < 5:
        bullets.append("")

    title = " ".join(p for p in [brand, product_name] if p)
    for extra in keyword_list[:2] + heads[:2]:
        extra = _title_case(extra)
        if extra.lower() in title.lower():
            continue
        candidate = f"{title}, {extra}" if "," in title or " – " in title else f"{title} – {extra}"
        if len(candidate) > 150:
            break
        title = candidate

    sentences = [b.split(" – ", 1)[-1].rstrip(".") + "." for b in bullets if b]
    description = (f"{brand} {product_name}. " if brand else f"{product_name}. ") + " ".join(sentences)

    used = set(re.findall(r"[a-z0-9]+", title.lower())) | {brand.lower()}
    terms, size = [], 0
    for phrase in keyword_list:
        for word in re.findall(r"[a-z0-9]+", phrase.lower()):
            if word in used:
                continue
            extra = len(word.encode("utf-8")) + (1 if terms else 0)
            if size + extra > SEARCH_TERMS_MAX_BYTES:
                break
            terms.append(word)
            used.add(word)
            size += extra

    result = {"title": title, "description": description[:DESCRIPTION_MAX], "search_terms": " ".join(terms)}
    for i, bullet in enumerate(bullets[:5], 1):
        result[f"bullet{i}"] = bullet[:BULLET_MAX]
    return result


# ------------------------------------------------------------- CSV import

PRODUCT_ALIASES = {
    "name": ["name", "title", "product name", "product title", "product details", "product", "item name", "description"],
    "asin": ["asin"],
    "category": ["category", "main category", "product category"],
    "price": ["price", "price $", "price us$", "price (usd)", "avg price", "average price", "buy box price"],
    "monthly_sales": ["monthly sales", "sales", "est. monthly sales", "estimated monthly sales",
                      "asin sales", "parent level sales", "units sold", "monthly units", "est sales"],
    "reviews": ["reviews", "review count", "number of reviews", "ratings", "reviews count", "# of reviews"],
    "rating": ["rating", "avg rating", "average rating", "reviews rating", "stars"],
    "weight_lb": ["weight", "weight lb", "weight (lb)", "weight (lbs)", "weight lbs", "item weight"],
    "length_in": ["length", "length in", "length (in)"],
    "width_in": ["width", "width in", "width (in)"],
    "height_in": ["height", "height in", "height (in)"],
    "notes": ["notes", "note"],
}

SALES_ALIASES = {
    "date": ["date", "day", "order date"],
    "product": ["product", "name", "asin", "sku", "title", "product name"],
    "units": ["units", "units ordered", "units sold", "quantity", "qty"],
    "revenue": ["revenue", "sales", "ordered product sales", "product sales", "gross sales"],
    "ad_spend": ["ad spend", "ad_spend", "spend", "ads", "ppc"],
    "refunds": ["refunds", "refund", "refund amount", "returns"],
}


def _norm_header(header):
    return re.sub(r"\s+", " ", (header or "").strip().lower().replace("_", " "))


def parse_csv(text, aliases):
    """Read CSV text into dicts keyed by our field names. Unknown columns are dropped."""
    text = text.lstrip("﻿")
    try:
        dialect = csv.Sniffer().sniff(text[:2000], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    rows = [r for r in reader if any(c.strip() for c in r)]
    if not rows:
        return [], []
    headers = [_norm_header(h) for h in rows[0]]
    mapping = {}
    for field, names in aliases.items():
        for name in names:
            if name in headers:
                mapping[field] = headers.index(name)
                break
    out = []
    for row in rows[1:]:
        out.append({field: (row[i].strip() if i < len(row) else "") for field, i in mapping.items()})
    return out, sorted(mapping)


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug[:60] or "product"
