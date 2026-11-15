#!/usr/bin/env python3
"""Seller Toolkit: a local web app for private label selling on Amazon.

Run:  double-click "Start Seller Toolkit.bat", or  python app.py  then open http://127.0.0.1:8765
Uses only the Python standard library. Data is stored in data.db next to this file.
"""
import base64
import csv
import datetime
import io
import json
import math
import mimetypes
import os
import re
import secrets
import sys
import threading
import urllib.request
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import db
import logic
import storefront
import xlsx

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
UPLOAD_DIR = os.path.join(ROOT, "uploads")
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8765"))


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# ------------------------------------------------------------------ views

def build_state(conn, days=30):
    settings = db.get_settings(conn)
    products = db.rows(conn, "SELECT * FROM products ORDER BY id DESC")
    suppliers = db.rows(conn, "SELECT * FROM suppliers ORDER BY name")
    quotes = db.rows(conn, "SELECT * FROM quotes ORDER BY id")
    listings = db.rows(conn, "SELECT * FROM listings")
    supplier_names = {s["id"]: s["name"] for s in suppliers}
    product_names = {p["id"]: p["name"] for p in products}

    quotes_by_product = {}
    for quote in quotes:
        quote["landed_cost"] = logic.landed_cost(quote)
        quote["tiers"] = logic.price_breaks(quote)
        quote["supplier_name"] = supplier_names.get(quote["supplier_id"], "?")
        quotes_by_product.setdefault(quote["product_id"], []).append(quote)

    chosen = {}
    for product in products:
        quote = logic.pick_quote(quotes_by_product.get(product["id"]))
        chosen[product["id"]] = quote
        eco = logic.unit_economics(product, quote, settings)
        product["eco"] = eco
        product["score"] = logic.opportunity_score(product, eco, settings)
        product["min_price"] = logic.min_price_for_margin(product, quote, settings)
        product["scenarios"] = logic.price_scenarios(product, quote, settings)
        asin = (product["asin"] or "").strip().upper()
        product["link"] = product["ref_url"] or (f"https://www.amazon.com/dp/{asin}" if re.fullmatch(r"[A-Z0-9]{10}", asin) else "")
        product["alibaba_url"] = logic.alibaba_search_url(product)
        product["listed_cost"] = logic.listed_cost(product, settings)
        product["potential"] = logic.profit_potential(product, eco, quote, settings)
        product["filter_reasons"] = [] if product["status"] == "dropped" else logic.filter_matches(product, settings)
        product["quote_count"] = len(quotes_by_product.get(product["id"], []))
        product["active_quote_id"] = quote["id"] if quote else None

    logic.rank_products(products)

    versions = db.rows(conn, "SELECT id, listing_id, saved_at, label FROM listing_versions ORDER BY id DESC")
    for listing in listings:
        listing["issues"] = logic.validate_listing(listing)
        listing["versions"] = [v for v in versions if v["listing_id"] == listing["id"]]

    keywords = db.rows(conn, "SELECT * FROM keywords")
    for keyword in keywords:
        keyword["priority"] = logic.keyword_priority(keyword["search_volume"], keyword["competing_products"])
    keywords.sort(key=lambda k: (-k["priority"], -k["search_volume"]))

    competitors = db.rows(conn, "SELECT * FROM competitors ORDER BY name")
    snapshots = db.rows(conn, "SELECT * FROM snapshots ORDER BY date, id")
    for competitor in competitors:
        competitor["snapshots"] = [s for s in snapshots if s["competitor_id"] == competitor["id"]]

    orders = db.rows(conn, "SELECT * FROM purchase_orders ORDER BY CASE WHEN order_date = '' THEN 1 ELSE 0 END, order_date DESC, id DESC")
    for order in orders:
        goods = order["quantity"] * order["unit_cost"]
        order["goods_cost"] = round(goods, 2)
        order["deposit"] = round(goods * order["deposit_pct"] / 100, 2)
        order["balance"] = round(goods - order["deposit"] + order["freight_total"], 2)
        order["total_cost"] = round(goods + order["freight_total"], 2)
        order["product_name"] = product_names.get(order["product_id"], "?")
        order["supplier_name"] = supplier_names.get(order["supplier_id"], "")

    reviews = db.rows(conn, "SELECT * FROM reviews")
    for review in reviews:
        review["analysis"] = logic.analyze_reviews(review["text"])

    overheads = db.rows(conn, "SELECT * FROM overheads ORDER BY name")
    dashboard = build_dashboard(conn, products, chosen, settings, days, overheads)
    return {
        "settings": settings,
        "products": products,
        "suppliers": suppliers,
        "quotes": quotes,
        "listings": listings,
        "keywords": keywords,
        "competitors": competitors,
        "tasks": db.rows(conn, "SELECT * FROM tasks ORDER BY position, id"),
        "orders": orders,
        "reviews": reviews,
        "overheads": overheads,
        "ads": build_ads(conn, products, days),
        "cashflow": build_cashflow(conn, products, orders, overheads, settings),
        "dashboard": dashboard,
        "site_built": os.path.isfile(os.path.join(storefront.BUILD_DIR, "index.html")),
        "today": datetime.date.today().isoformat(),
    }


def _sales_profit(row, eco):
    """Profit pieces for a block of sales of one product."""
    units, revenue = row["units"] or 0, row["revenue"] or 0
    fees = revenue * eco["referral_pct"] / 100 + units * eco["fba_fee"]
    cogs = units * eco["landed_cost"]
    ad, refunds = row["ad_spend"] or 0, row["refunds"] or 0
    return units, revenue, fees, cogs, ad, refunds, revenue - fees - cogs - ad - refunds


def build_dashboard(conn, products, chosen, settings, days, overheads):
    today = datetime.date.today()
    since = (today - datetime.timedelta(days=days)).isoformat() if days else "0000-00-00"
    since_30 = (today - datetime.timedelta(days=30)).isoformat()
    window = {r["product_id"]: r for r in db.rows(conn, """
        SELECT product_id, SUM(units) units, SUM(revenue) revenue, SUM(ad_spend) ad_spend,
               SUM(refunds) refunds, SUM(sales_tax) sales_tax FROM sales WHERE date >= ? GROUP BY product_id""", (since,))}
    recent = {r["product_id"]: r["units"] or 0 for r in db.rows(conn, """
        SELECT product_id, SUM(units) units FROM sales WHERE date >= ? GROUP BY product_id""", (since_30,))}
    by_id = {p["id"]: p for p in products}

    per_product, inventory = [], []
    totals = {k: 0.0 for k in ("units", "revenue", "amazon_fees", "cogs", "ad_spend", "refunds", "profit")}
    assumed, sales_tax = False, 0.0
    for product in products:
        eco = product["eco"]
        sold = window.get(product["id"])
        if sold:
            units, revenue, fees, cogs, ad, refunds, profit = _sales_profit(sold, eco)
            sales_tax += sold["sales_tax"] or 0
            assumed = assumed or eco["cost_source"] == "assumed"
            row = {"product_id": product["id"], "name": product["name"], "units": units,
                   "revenue": round(revenue, 2), "amazon_fees": round(fees, 2), "cogs": round(cogs, 2),
                   "ad_spend": round(ad, 2), "refunds": round(refunds, 2), "profit": round(profit, 2),
                   "margin_pct": round(profit / revenue * 100, 1) if revenue else 0.0,
                   "tacos_pct": round(ad / revenue * 100, 1) if revenue else 0.0,
                   "break_even_acos_pct": eco["break_even_acos_pct"],
                   "cost_source": eco["cost_source"]}
            per_product.append(row)
            for key in totals:
                totals[key] += row[key]

        velocity = recent.get(product["id"], 0) / 30
        stock = product.get("stock_on_hand") or 0
        if velocity > 0 or stock > 0:
            quote = chosen.get(product["id"]) or {}
            lead = quote.get("lead_time_days") or 30
            safety = logic.num(settings.get("safety_stock_days"), 14)
            cover = logic.num(settings.get("reorder_cover_days"), 60)
            reorder_point = math.ceil(velocity * (lead + safety))
            days_left = round(stock / velocity, 1) if velocity else None
            order_qty = max(math.ceil(velocity * cover), int(quote.get("moq") or 0))
            if velocity == 0:
                status = "no recent sales"
            elif stock <= 0:
                status = "out of stock"
            elif stock <= reorder_point:
                status = "reorder now"
            else:
                status = "ok"
            inventory.append({"product_id": product["id"], "name": product["name"], "stock": stock,
                              "daily_velocity": round(velocity, 2), "days_left": days_left,
                              "lead_time_days": lead, "lead_source": "quote" if quote.get("lead_time_days") else "default",
                              "reorder_point": reorder_point, "suggested_order": order_qty, "status": status})

    # Overheads are monthly; charge them for the length of the period shown.
    monthly_overhead = sum(o["monthly_amount"] or 0 for o in overheads)
    first_sale = conn.execute("SELECT MIN(date) FROM sales").fetchone()[0]
    if days:
        period_days = days
    elif first_sale:
        period_days = (today - datetime.date.fromisoformat(first_sale[:10])).days + 1
    else:
        period_days = 0
    overhead = monthly_overhead * period_days / 30 if totals["revenue"] or days else 0

    per_product.sort(key=lambda r: r["profit"], reverse=True)
    totals["product_profit"] = totals["profit"]
    totals["overheads"] = overhead
    totals["profit"] -= overhead
    totals["sales_tax"] = sales_tax
    totals = {k: round(v, 2) for k, v in totals.items()}
    totals["margin_pct"] = round(totals["profit"] / totals["revenue"] * 100, 1) if totals["revenue"] else 0.0
    totals["tacos_pct"] = round(totals["ad_spend"] / totals["revenue"] * 100, 1) if totals["revenue"] else 0.0

    # Month-by-month trend, last 12 months that have sales.
    months = {}
    for r in db.rows(conn, """SELECT substr(date, 1, 7) month, product_id, SUM(units) units, SUM(revenue) revenue,
                              SUM(ad_spend) ad_spend, SUM(refunds) refunds FROM sales GROUP BY month, product_id"""):
        product = by_id.get(r["product_id"])
        if not product:
            continue
        units, revenue, *_, profit = _sales_profit(r, product["eco"])
        entry = months.setdefault(r["month"], {"month": r["month"], "units": 0, "revenue": 0.0, "profit": -monthly_overhead})
        entry["units"] += units
        entry["revenue"] += revenue
        entry["profit"] += profit
    monthly = [{**m, "revenue": round(m["revenue"], 2), "profit": round(m["profit"], 2)}
               for _, m in sorted(months.items())][-12:]

    return {"days": days, "totals": totals, "per_product": per_product, "inventory": inventory,
            "monthly": monthly, "monthly_overhead": round(monthly_overhead, 2), "uses_assumed_cost": assumed,
            "sales_rows": conn.execute("SELECT COUNT(*) FROM sales").fetchone()[0]}


def build_ads(conn, products, days):
    """Ad performance by campaign and keyword, judged against each product's break-even."""
    since = (datetime.date.today() - datetime.timedelta(days=days)).isoformat() if days else ""
    by_id = {p["id"]: p for p in products}
    out = []
    for r in db.rows(conn, """SELECT product_id, campaign, keyword, SUM(impressions) impressions, SUM(clicks) clicks,
                              SUM(spend) spend, SUM(sales) sales, SUM(orders) orders FROM ads
                              WHERE date = '' OR date >= ? GROUP BY product_id, campaign, keyword""", (since,)):
        product = by_id.get(r["product_id"])
        if not product:
            continue
        break_even = product["eco"]["break_even_acos_pct"]
        spend, sales = r["spend"] or 0, r["sales"] or 0
        acos = spend / sales * 100 if sales else None
        if spend <= 0:
            verdict = "no spend"
        elif acos is None:
            verdict = "no sales"
        elif acos > break_even:
            verdict = "losing money"
        elif acos > break_even * 0.7:
            verdict = "thin"
        else:
            verdict = "profitable"
        out.append({"product_id": r["product_id"], "campaign": r["campaign"], "keyword": r["keyword"],
                    "impressions": r["impressions"] or 0, "clicks": r["clicks"] or 0, "spend": round(spend, 2),
                    "sales": round(sales, 2), "orders": r["orders"] or 0,
                    "acos_pct": round(acos, 1) if acos is not None else None,
                    "cpc": round(spend / r["clicks"], 2) if r["clicks"] else None,
                    "break_even_acos_pct": break_even, "verdict": verdict,
                    # what the spend cost after the margin it earned back
                    "net": round(sales * break_even / 100 - spend, 2)})
    out.sort(key=lambda r: r["net"])
    return out


def _month_add(year, month, offset):
    index = year * 12 + (month - 1) + offset
    return index // 12, index % 12 + 1


def build_cashflow(conn, products, orders, overheads, settings, months=6):
    """Six-month cash projection from recent sales pace, planned orders and overheads."""
    today = datetime.date.today()
    since_30 = (today - datetime.timedelta(days=30)).isoformat()
    recent = {r["product_id"]: r for r in db.rows(conn, """
        SELECT product_id, SUM(units) units, SUM(revenue) revenue, SUM(ad_spend) ad_spend
        FROM sales WHERE date >= ? GROUP BY product_id""", (since_30,))}
    daily_payout = 0.0
    for product in products:
        sold = recent.get(product["id"])
        if not sold or not sold["units"]:
            continue
        eco = product["eco"]
        per_day = sold["units"] / 30
        ad_share = (sold["ad_spend"] or 0) / sold["revenue"] if sold["revenue"] else 0
        daily_payout += per_day * (eco["price"] * (1 - ad_share) - eco["referral_fee"] - eco["fba_fee"])

    growth = logic.num(settings.get("sales_growth_pct")) / 100
    delay = min(max(logic.num(settings.get("payout_delay_days"), 14), 0), 30) / 30
    monthly_overhead = sum(o["monthly_amount"] or 0 for o in overheads)

    payments, undated = {}, 0
    for order in orders:
        if order["status"] in ("cancelled", "received"):
            continue
        due = [(order["order_date"], order["deposit"]),
               (order["balance_due_date"] or order["expected_arrival"] or order["order_date"], order["balance"])]
        for date, amount in due:
            if amount <= 0:
                continue
            if not date:
                undated += 1
            elif date >= today.isoformat():
                payments[date[:7]] = payments.get(date[:7], 0) + amount

    cash = logic.num(settings.get("starting_cash"))
    rows, previous_earned = [], daily_payout * 30
    for i in range(months):
        year, month = _month_add(today.year, today.month, i)
        next_year, next_month = _month_add(year, month, 1)
        length = (datetime.date(next_year, next_month, 1) - datetime.date(year, month, 1)).days
        days_counted = length - (today.day - 1) if i == 0 else length
        earned = daily_payout * days_counted * (1 + growth) ** i
        inflow = earned * (1 - delay) + previous_earned * delay
        previous_earned = earned
        key = f"{year:04d}-{month:02d}"
        po = payments.get(key, 0)
        overhead = monthly_overhead * days_counted / length
        cash += inflow - po - overhead
        rows.append({"month": key, "inflow": round(inflow, 2), "po_payments": round(po, 2),
                     "overheads": round(overhead, 2), "net": round(inflow - po - overhead, 2),
                     "ending_cash": round(cash, 2)})
    return {"rows": rows, "daily_payout": round(daily_payout, 2), "undated_payments": undated,
            "starting_cash": logic.num(settings.get("starting_cash"))}


# ---------------------------------------------------------------- writes

def clean_fields(table, data):
    out = {}
    for column in db.WRITABLE[table]:
        if column not in data:
            continue
        value = data[column]
        if column in db.TEXT_COLUMNS:
            out[column] = "" if value is None else str(value).strip()
        elif column in db.NULLABLE_NUMBERS:
            out[column] = None if value in (None, "") else logic.num(value)
        elif column in db.FLAGS:
            out[column] = 1 if value in (True, 1, "1", "true", "on") else 0
        else:
            out[column] = logic.num(value)
    return out


def create_row(conn, table, data):
    fields = clean_fields(table, data)
    required = db.REQUIRED.get(table)
    if required and not fields.get(required):
        raise ApiError(f"A {required} is required.")
    if table in ("sales", "snapshots") and not fields.get("date"):
        fields["date"] = datetime.date.today().isoformat()
    if "product_id" in db.WRITABLE[table] and not fields.get("product_id"):
        raise ApiError("Choose a product.")
    if table == "quotes" and not fields.get("supplier_id"):
        raise ApiError("Choose a supplier.")
    if table == "snapshots" and not fields.get("competitor_id"):
        raise ApiError("Choose a competitor.")
    columns = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    cursor = conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({marks})", list(fields.values()))
    if table == "quotes" and fields.get("chosen"):
        _unchoose_others(conn, cursor.lastrowid)
    if table == "purchase_orders":
        _receive_order(conn, cursor.lastrowid)
    return cursor.lastrowid


def update_row(conn, table, row_id, data):
    fields = clean_fields(table, data)
    if not fields:
        return
    required = db.REQUIRED.get(table)
    if required in fields and not fields[required]:
        raise ApiError(f"A {required} is required.")
    sets = ", ".join(f"{c} = ?" for c in fields)
    conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", list(fields.values()) + [row_id])
    if table == "quotes" and fields.get("chosen"):
        _unchoose_others(conn, row_id)
    if table == "purchase_orders":
        _receive_order(conn, row_id)


def _receive_order(conn, order_id):
    """The first time an order is marked received, add its units to stock."""
    order = conn.execute("SELECT * FROM purchase_orders WHERE id = ?", (order_id,)).fetchone()
    if not order or order["status"] != "received" or order["stock_added"]:
        return
    units = order["units_received"] or order["quantity"] or 0
    conn.execute("UPDATE products SET stock_on_hand = stock_on_hand + ? WHERE id = ?", (units, order["product_id"]))
    conn.execute("UPDATE purchase_orders SET stock_added = 1, units_received = ? WHERE id = ?", (units, order_id))


def _unchoose_others(conn, quote_id):
    conn.execute("""UPDATE quotes SET chosen = 0 WHERE id != ? AND product_id =
                    (SELECT product_id FROM quotes WHERE id = ?)""", (quote_id, quote_id))


def import_products(conn, text):
    parsed, fields = logic.parse_csv(text, logic.PRODUCT_ALIASES)
    if "name" not in fields:
        raise ApiError("No product name column found. Expected a header such as Name, Title or Product Name.")
    seen_names = set()
    for r in db.rows(conn, "SELECT name, description FROM products"):
        seen_names.update({r["name"].strip().lower(), r["description"].strip().lower()} - {""})
    seen_asins = {r["asin"].strip().lower() for r in db.rows(conn, "SELECT asin FROM products WHERE asin != ''")}
    added = skipped = duplicates = 0
    for row in parsed:
        name, asin = (row.get("name") or "").strip().lower(), (row.get("asin") or "").strip().lower()
        if not name:
            skipped += 1
        elif name in seen_names or (asin and asin in seen_asins):
            duplicates += 1
        else:
            full = " ".join(row["name"].split())
            row["name"] = logic.short_title(full, row.get("brand"))
            row["description"] = full if full != row["name"] else ""
            create_row(conn, "products", row)
            seen_names.update({name, row["name"].lower()})
            if asin:
                seen_asins.add(asin)
            added += 1
    return {"added": added, "skipped": skipped, "duplicates": duplicates, "columns_used": fields}


def import_keywords(conn, product_id, text):
    if not conn.execute("SELECT 1 FROM products WHERE id = ?", (product_id,)).fetchone():
        raise ApiError("Choose a product.")
    parsed, fields = logic.parse_csv(text, logic.KEYWORD_ALIASES)
    if "keyword" not in fields:
        raise ApiError("No keyword column found. Expected a header such as Keyword or Keyword Phrase.")
    have = {r["keyword"].strip().lower() for r in
            db.rows(conn, "SELECT keyword FROM keywords WHERE product_id = ?", (product_id,))}
    added = duplicates = 0
    for row in parsed:
        key = (row.get("keyword") or "").strip().lower()
        if not key:
            continue
        if key in have:
            duplicates += 1
            continue
        create_row(conn, "keywords", {**row, "product_id": product_id})
        have.add(key)
        added += 1
    return {"added": added, "duplicates": duplicates, "columns_used": fields}


def import_ads(conn, product_id, text):
    if not conn.execute("SELECT 1 FROM products WHERE id = ?", (product_id,)).fetchone():
        raise ApiError("Choose a product.")
    parsed, fields = logic.parse_csv(text, logic.ADS_ALIASES)
    missing = [f for f in ("spend", "sales") if f not in fields]
    if missing:
        raise ApiError("Missing column(s): " + ", ".join(missing) + ". Needed at least: spend, sales.")
    added = 0
    for row in parsed:
        row["date"] = _parse_date(row.get("date") or "") or ""
        create_row(conn, "ads", {**row, "product_id": product_id})
        added += 1
    return {"added": added, "columns_used": fields}


def _parse_date(text):
    text = (text or "").strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%b %d, %Y", "%d/%m/%Y"):
        try:
            return datetime.datetime.strptime(text[:10] if fmt == "%Y-%m-%d" else text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


STANDARD_TASKS = [
    "Validate demand and competition", "Check patents and trademarks", "Request quotes from 3 suppliers",
    "Order and review samples", "Choose supplier and negotiate terms", "Register brand name and buy UPC/GTIN",
    "Design logo and packaging", "Place first purchase order", "Arrange product inspection",
    "Book freight and prepare FBA shipment", "Take product photos", "Write and check the listing",
    "Create the listing in Seller Central", "Shipment received at Amazon", "Start ad campaigns",
    "Request first reviews", "Publish the product on the website",
]


def add_standard_tasks(conn, product_id):
    have = {r["title"] for r in db.rows(conn, "SELECT title FROM tasks WHERE product_id = ?", (product_id,))}
    start = conn.execute("SELECT COALESCE(MAX(position), 0) FROM tasks WHERE product_id = ?", (product_id,)).fetchone()[0]
    added = 0
    for title in STANDARD_TASKS:
        if title not in have:
            added += 1
            create_row(conn, "tasks", {"product_id": product_id, "title": title, "position": start + added})
    return {"added": added}


def keywords_to_listing(conn, product_id, count):
    top = db.rows(conn, "SELECT keyword, search_volume, competing_products FROM keywords WHERE product_id = ?", (product_id,))
    if not top:
        raise ApiError("This product has no keywords yet.")
    top.sort(key=lambda k: -logic.keyword_priority(k["search_volume"], k["competing_products"]))
    text = ", ".join(k["keyword"] for k in top[:max(int(count or 15), 1)])
    listing = conn.execute("SELECT id FROM listings WHERE product_id = ?", (product_id,)).fetchone()
    if listing:
        update_row(conn, "listings", listing["id"], {"keywords": text})
    else:
        create_row(conn, "listings", {"product_id": product_id, "keywords": text,
                                      "brand": db.get_settings(conn).get("brand", "")})
    return {"count": min(len(top), max(int(count or 15), 1))}


LISTING_CONTENT = ["brand", "sku", "features", "keywords", "title", "bullet1", "bullet2", "bullet3", "bullet4",
                   "bullet5", "description", "search_terms", "aplus"]


def save_version(conn, product_id, label):
    listing = conn.execute("SELECT * FROM listings WHERE product_id = ?", (product_id,)).fetchone()
    if not listing:
        raise ApiError("Save the listing first.")
    data = json.dumps({k: listing[k] for k in LISTING_CONTENT})
    conn.execute("INSERT INTO listing_versions (listing_id, saved_at, label, data) VALUES (?, ?, ?, ?)",
                 (listing["id"], datetime.datetime.now().strftime("%Y-%m-%d %H:%M"), (label or "").strip(), data))
    return {"ok": True}


def restore_version(conn, version_id):
    version = conn.execute("SELECT * FROM listing_versions WHERE id = ?", (version_id,)).fetchone()
    if not version:
        raise ApiError("Version not found.", 404)
    update_row(conn, "listings", version["listing_id"], json.loads(version["data"]))
    return {"ok": True}


def save_upload(data):
    """Store an uploaded image in uploads/ and return its URL path."""
    extension = os.path.splitext(str(data.get("name") or ""))[1].lower()
    if extension not in IMAGE_TYPES:
        raise ApiError("Only PNG, JPG, WEBP or GIF images can be uploaded.")
    payload = str(data.get("data") or "")
    if "," in payload[:100]:  # data URL prefix
        payload = payload.split(",", 1)[1]
    try:
        content = base64.b64decode(payload, validate=True)
    except ValueError:
        raise ApiError("The upload could not be read.")
    if not content or len(content) > 8_000_000:
        raise ApiError("Images must be under 8 MB.")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    name = secrets.token_hex(8) + extension
    with open(os.path.join(UPLOAD_DIR, name), "wb") as f:
        f.write(content)
    return {"url": "/uploads/" + name}


EXPORT_SKIP = {"listing_versions", "reviews"}


def export_ranking(conn):
    ranked = logic.rank_products(build_state(conn, 0)["products"])
    headers = ["Rank", "Product", "Verdict", "Reason", "Est. units / month", "Share of top seller %", "Profit / unit after ads",
               "Margin after ads %", "Est. monthly profit", "First order units", "Investment", "Payback months",
               "Annual ROI %", "Things to check", "Status"]
    rows = []
    for p in ranked:
        x = p["potential"]
        rows.append([x["rank"], p["name"], x["verdict"], x["why"], x["est_units"], x["share_pct"], x["unit_profit_after_ads"],
                     x["margin_after_ads_pct"], x["monthly_profit"], x["first_order"], x["investment"], x["payback_months"],
                     x["annual_roi_pct"], "; ".join(x["flags"]), p["status"]])
    return xlsx.workbook(headers, rows, "Profit ranking")


def shortlist_proceed(conn):
    """Move every idea-stage product with a Proceed verdict to the shortlist."""
    moved = 0
    for p in build_state(conn, 0)["products"]:
        if p["status"] == "idea" and p["potential"]["verdict"] == "proceed":
            conn.execute("UPDATE products SET status = 'shortlist' WHERE id = ?", (p["id"],))
            moved += 1
    return {"moved": moved}


def export_table(conn, table):
    """One table as an Excel workbook, with names in place of internal ids."""
    if table not in db.TABLES or table in EXPORT_SKIP:
        raise ApiError("Not found.", 404)
    products = {p["id"]: p for p in build_state(conn, 0)["products"]} if table == "products" else {}
    names = {r["id"]: r["name"] for r in db.rows(conn, "SELECT id, name FROM products")}
    suppliers = {r["id"]: r["name"] for r in db.rows(conn, "SELECT id, name FROM suppliers")}
    competitors = {r["id"]: r["name"] for r in db.rows(conn, "SELECT id, name FROM competitors")}
    lookup = {"product_id": ("product", names), "supplier_id": ("supplier", suppliers),
              "competitor_id": ("competitor", competitors)}
    columns = [c for c, _ in db.TABLES[table] if c != "stock_added"]
    headers = [lookup[c][0] if c in lookup else c for c in columns]
    extra = ["score", "profit_per_unit", "margin_pct", "landed_cost", "fba_fee"] if table == "products" else []
    out = []
    for row in db.rows(conn, f"SELECT * FROM {table} ORDER BY id"):
        line = [lookup[c][1].get(row[c], "") if c in lookup else row[c] for c in columns]
        if extra:
            p = products[row["id"]]
            line += [p["score"]["score"], p["eco"]["profit"], p["eco"]["margin_pct"], p["eco"]["landed_cost"], p["eco"]["fba_fee"]]
        out.append(line)
    pretty = [h.replace("_", " ").capitalize() for h in headers + extra]
    return xlsx.workbook(pretty, out, table.replace("_", " ").title())


def import_sales(conn, text):
    parsed, fields = logic.parse_csv(text, logic.SALES_ALIASES)
    missing = [f for f in ("date", "product", "units", "revenue") if f not in fields]
    if missing:
        raise ApiError("Missing column(s): " + ", ".join(missing) + ". Needed: date, product, units, revenue.")
    lookup = {}
    for product in db.rows(conn, "SELECT id, name, asin, description FROM products"):
        lookup[product["name"].strip().lower()] = product["id"]
        if product["description"]:
            lookup[product["description"].strip().lower()] = product["id"]
        if product["asin"]:
            lookup[product["asin"].strip().lower()] = product["id"]
    added, unmatched = 0, []
    for row in parsed:
        product_id = lookup.get((row.get("product") or "").strip().lower())
        if not product_id:
            if row.get("product") and row["product"] not in unmatched:
                unmatched.append(row["product"])
            continue
        date = _parse_date(row["date"])
        if not date:
            unmatched.append(f"bad date: {row['date']}")
            continue
        create_row(conn, "sales", {**row, "product_id": product_id, "date": date})
        added += 1
    return {"added": added, "unmatched": unmatched[:20], "columns_used": fields}


def draft_listing(conn, product_id):
    product = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if not product:
        raise ApiError("Product not found.", 404)
    listing = conn.execute("SELECT * FROM listings WHERE product_id = ?", (product_id,)).fetchone()
    if not listing:
        raise ApiError("Save the listing inputs first.")
    settings = db.get_settings(conn)
    brand = listing["brand"] or settings.get("brand", "")
    draft = logic.draft_listing(brand, product["name"], listing["features"], listing["keywords"])
    update_row(conn, "listings", listing["id"], {**draft, "brand": brand})


def flat_file(conn):
    """Tab-separated export of every listing, using Amazon's common attribute names."""
    columns = ["item_sku", "item_name", "brand_name", "standard_price", "bullet_point1", "bullet_point2",
               "bullet_point3", "bullet_point4", "bullet_point5", "product_description",
               "generic_keywords", "main_image_url"]
    out = io.StringIO()
    writer = csv.writer(out, delimiter="\t", lineterminator="\n")
    writer.writerow(columns)
    for r in db.rows(conn, """SELECT l.*, p.price, p.image_url, p.name FROM listings l
                              JOIN products p ON p.id = l.product_id ORDER BY p.name"""):
        clean = lambda v: " ".join(str(v or "").split())
        writer.writerow([clean(r["sku"]) or logic.slugify(r["name"]).upper(), clean(r["title"]), clean(r["brand"]),
                         f"{r['price'] or 0:.2f}", clean(r["bullet1"]), clean(r["bullet2"]), clean(r["bullet3"]),
                         clean(r["bullet4"]), clean(r["bullet5"]), clean(r["description"]),
                         clean(r["search_terms"]), clean(r["image_url"])])
    return out.getvalue()


def outreach_message(conn, data):
    product = conn.execute("SELECT * FROM products WHERE id = ?", (data.get("product_id"),)).fetchone()
    if not product:
        raise ApiError("Choose a product.")
    supplier = conn.execute("SELECT * FROM suppliers WHERE id = ?", (data.get("supplier_id"),)).fetchone()
    settings = db.get_settings(conn)
    quantity = int(logic.num(data.get("quantity"), 500))
    target = logic.num(data.get("target_price"))
    greeting = f"Hello {supplier['contact'] or supplier['name']}," if supplier else "Hello,"
    who = " at ".join(p for p in [settings.get("your_name"), settings.get("company")] if p)
    lines = [
        greeting, "",
        f"I am {who} and I am sourcing a {product['name'].lower()} to sell under our own brand in the US."
        if who else f"I am sourcing a {product['name'].lower()} to sell under our own brand in the US.",
        f"Our first order would be about {quantity:,} units, with regular reorders if quality is consistent.", "",
        "Could you please send:",
        f"1. Unit price at {quantity:,}, {quantity * 2:,} and {quantity * 5:,} units"
        + (f" (our target is ${target:.2f} per unit)" if target else ""),
        "2. Minimum order quantity for custom logo and custom packaging",
        "3. Production lead time after deposit, and sample lead time",
        "4. Sample cost including express shipping to the US",
        "5. Carton size, units per carton and carton weight",
        "6. Certifications and test reports you hold for this product",
        "7. Payment terms, and whether you accept Trade Assurance", "",
    ]
    dims = [product["length_in"], product["width_in"], product["height_in"]]
    if all(dims):
        lines += [f"Target size is about {dims[0]:g} x {dims[1]:g} x {dims[2]:g} in"
                  + (f", {product['weight_lb']:g} lb." if product["weight_lb"] else "."), ""]
    lines += ["Thank you,", settings.get("your_name") or "[Your name]"]
    return "\n".join(lines)


def build_site(conn):
    products = db.rows(conn, "SELECT * FROM products WHERE on_site = 1 ORDER BY name")
    listings = {l["product_id"]: l for l in db.rows(conn, "SELECT * FROM listings")}
    return storefront.build(products, listings, db.get_settings(conn), UPLOAD_DIR)


def site_zip():
    if not os.path.isfile(os.path.join(storefront.BUILD_DIR, "index.html")):
        raise ApiError("Build the site first.", 404)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for folder, _, files in os.walk(storefront.BUILD_DIR):
            for name in files:
                path = os.path.join(folder, name)
                archive.write(path, os.path.relpath(path, storefront.BUILD_DIR))
    return buffer.getvalue()


# ----------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    server_version = "SellerToolkit/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, status, body, content_type="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _local_only(self):
        """Refuse requests addressed to any other hostname (blocks DNS rebinding)."""
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            self._send(403, {"error": "This app only answers on localhost."})
            return False
        return True

    def _body(self):
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            raise ApiError("Expected JSON.", 415)
        length = int(self.headers.get("Content-Length") or 0)
        if length > 20_000_000:
            raise ApiError("Upload is too large.", 413)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise ApiError("Invalid JSON.")

    def _file(self, base, relative):
        path = os.path.realpath(os.path.join(base, relative))
        if not path.startswith(os.path.realpath(base) + os.sep) or not os.path.isfile(path):
            return self._send(404, "Not found", "text/plain")
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith(("javascript", "json")):
            ctype += "; charset=utf-8"
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype)

    def _handle(self, method):
        if not self._local_only():
            return
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        try:
            if parts[:1] == ["api"]:
                conn = db.connect()
                try:
                    result = self._api(method, parts[1:], parse_qs(url.query), conn)
                    conn.commit()
                finally:
                    conn.close()
                if result is not None:
                    self._send(200, result)
            elif method != "GET":
                self._send(405, {"error": "Method not allowed."})
            elif not parts:
                self._file(STATIC_DIR, "index.html")
            elif parts[0] == "static":
                self._file(STATIC_DIR, "/".join(parts[1:]))
            elif parts[0] == "uploads":
                self._file(UPLOAD_DIR, "/".join(parts[1:]))
            elif parts[0] == "store":
                self._file(storefront.BUILD_DIR, "/".join(parts[1:]) or "index.html")
            else:
                self._send(404, "Not found", "text/plain")
        except ApiError as error:
            self._send(error.status, {"error": str(error)})
        except Exception as error:  # keep the server alive and tell the user what broke
            self._send(500, {"error": f"{type(error).__name__}: {error}"})

    def _api(self, method, parts, query, conn):
        route = "/".join(parts)
        if method == "GET" and route == "state":
            days = int(logic.num(query.get("days", ["30"])[0], 30))
            return build_state(conn, days)
        if method == "GET" and route == "export/flatfile":
            self._send(200, flat_file(conn), "text/tab-separated-values; charset=utf-8",
                       {"Content-Disposition": 'attachment; filename="amazon-listings.txt"'})
            return None
        if method == "GET" and route == "site/zip":
            self._send(200, site_zip(), "application/zip",
                       {"Content-Disposition": 'attachment; filename="storefront.zip"'})
            return None
        if method == "GET" and route == "export/ranking.xlsx":
            self._send(200, export_ranking(conn), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                       {"Content-Disposition": 'attachment; filename="profit-ranking.xlsx"'})
            return None
        if method == "GET" and len(parts) == 2 and parts[0] == "export" and parts[1].endswith(".xlsx"):
            table = parts[1][:-5]
            self._send(200, export_table(conn, table),
                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                       {"Content-Disposition": f'attachment; filename="{table}.xlsx"'})
            return None
        if method == "GET":
            raise ApiError("Not found.", 404)

        data = self._body() if method in ("POST", "PUT") else {}
        if method == "PUT" and route == "settings":
            for key, value in data.items():
                if key in logic.DEFAULT_SETTINGS:
                    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value).strip()))
            return {"ok": True}
        if method == "POST" and route == "import/products":
            return import_products(conn, data.get("csv") or "")
        if method == "POST" and route == "import/sales":
            return import_sales(conn, data.get("csv") or "")
        if method == "POST" and route == "products/drop":
            ids = [int(i) for i in data.get("ids") or [] if str(i).isdigit()]
            for product_id in ids:
                conn.execute("UPDATE products SET status = 'dropped' WHERE id = ?", (product_id,))
            return {"dropped": len(ids)}
        if method == "POST" and route == "products/shortlist-proceed":
            return shortlist_proceed(conn)
        if method == "POST" and route == "import/keywords":
            return import_keywords(conn, data.get("product_id"), data.get("csv") or "")
        if method == "POST" and route == "import/ads":
            return import_ads(conn, data.get("product_id"), data.get("csv") or "")
        if method == "POST" and route == "ads/clear":
            conn.execute("DELETE FROM ads WHERE product_id = ?", (data.get("product_id"),))
            return {"ok": True}
        if method == "POST" and route == "tasks/template":
            return add_standard_tasks(conn, data.get("product_id"))
        if method == "POST" and route == "keywords/to-listing":
            return keywords_to_listing(conn, data.get("product_id"), data.get("count"))
        if method == "POST" and route == "listings/version":
            return save_version(conn, data.get("product_id"), data.get("label"))
        if method == "POST" and route == "listings/restore":
            return restore_version(conn, data.get("version_id"))
        if method == "DELETE" and len(parts) == 2 and parts[0] == "listing_versions" and parts[1].isdigit():
            conn.execute("DELETE FROM listing_versions WHERE id = ?", (int(parts[1]),))
            return {"ok": True}
        if method == "POST" and route == "upload":
            return save_upload(data)
        if method == "POST" and route == "reviews":
            existing = conn.execute("SELECT id FROM reviews WHERE product_id = ?", (data.get("product_id"),)).fetchone()
            if existing:
                update_row(conn, "reviews", existing["id"], {"text": data.get("text")})
                return {"id": existing["id"]}
            return {"id": create_row(conn, "reviews", data)}
        if method == "POST" and route == "listings/draft":
            draft_listing(conn, data.get("product_id"))
            return {"ok": True}
        if method == "POST" and route == "outreach":
            return {"message": outreach_message(conn, data)}
        if method == "POST" and route == "site/build":
            return build_site(conn)

        table = parts[0] if parts else ""
        if table not in db.WRITABLE:
            raise ApiError("Not found.", 404)
        if method == "POST" and len(parts) == 1:
            if table == "listings":  # one listing per product: create or update
                existing = conn.execute("SELECT id FROM listings WHERE product_id = ?",
                                        (data.get("product_id"),)).fetchone()
                if existing:
                    update_row(conn, table, existing["id"], data)
                    return {"id": existing["id"]}
            return {"id": create_row(conn, table, data)}
        if len(parts) == 2 and parts[1].isdigit():
            if method == "PUT":
                update_row(conn, table, int(parts[1]), data)
                return {"ok": True}
            if method == "DELETE":
                conn.execute(f"DELETE FROM {table} WHERE id = ?", (int(parts[1]),))
                return {"ok": True}
        raise ApiError("Not found.", 404)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")


def main():
    url = f"http://{HOST}:{PORT}"
    open_browser = os.environ.get("NO_BROWSER") != "1"
    saved = db.backup()
    if saved:
        print(f"Backed up your data to {saved}")
    db.init()
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as error:
        if already_running(url):
            print(f"Seller Toolkit is already running at {url}")
            if open_browser:
                webbrowser.open(url)
            return
        sys.exit(f"Could not start on port {PORT}: {error}\nTry another port:  set PORT=8800  then  python app.py")
    print(f"Seller Toolkit is running at {url}")
    print("Keep this window open while you use the app. Close it (or press Ctrl+C) to stop.")
    if open_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


def already_running(url):
    """True if the port is taken by another copy of this app."""
    try:
        with urllib.request.urlopen(url + "/static/app.js", timeout=2) as response:
            return response.headers.get("Server", "").startswith("SellerToolkit")
    except Exception:
        return False


if __name__ == "__main__":
    main()
