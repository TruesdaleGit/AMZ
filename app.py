#!/usr/bin/env python3
"""Seller Toolkit: a local web app for private label selling on Amazon.

Run:  double-click "Start Seller Toolkit.bat", or  python app.py  then open http://127.0.0.1:8765
Uses only the Python standard library. Data is stored in data.db next to this file.
"""
import csv
import datetime
import io
import json
import math
import mimetypes
import os
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

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
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

    quotes_by_product = {}
    for quote in quotes:
        quote["landed_cost"] = logic.landed_cost(quote)
        quote["supplier_name"] = supplier_names.get(quote["supplier_id"], "?")
        quotes_by_product.setdefault(quote["product_id"], []).append(quote)

    chosen = {}
    for product in products:
        quote = logic.pick_quote(quotes_by_product.get(product["id"]))
        chosen[product["id"]] = quote
        eco = logic.unit_economics(product, quote, settings)
        product["eco"] = eco
        product["score"] = logic.opportunity_score(product, eco)
        product["min_price"] = logic.min_price_for_margin(product, quote, settings)
        product["scenarios"] = logic.price_scenarios(product, quote, settings)
        product["quote_count"] = len(quotes_by_product.get(product["id"], []))
        product["active_quote_id"] = quote["id"] if quote else None

    for listing in listings:
        listing["issues"] = logic.validate_listing(listing)

    return {
        "settings": settings,
        "products": products,
        "suppliers": suppliers,
        "quotes": quotes,
        "listings": listings,
        "dashboard": build_dashboard(conn, products, chosen, settings, days),
        "site_built": os.path.isfile(os.path.join(storefront.BUILD_DIR, "index.html")),
    }


def build_dashboard(conn, products, chosen, settings, days):
    today = datetime.date.today()
    since = (today - datetime.timedelta(days=days)).isoformat() if days else "0000-00-00"
    since_30 = (today - datetime.timedelta(days=30)).isoformat()
    window = {r["product_id"]: r for r in db.rows(conn, """
        SELECT product_id, SUM(units) units, SUM(revenue) revenue, SUM(ad_spend) ad_spend,
               SUM(refunds) refunds FROM sales WHERE date >= ? GROUP BY product_id""", (since,))}
    recent = {r["product_id"]: r["units"] or 0 for r in db.rows(conn, """
        SELECT product_id, SUM(units) units FROM sales WHERE date >= ? GROUP BY product_id""", (since_30,))}

    per_product, inventory = [], []
    totals = {k: 0.0 for k in ("units", "revenue", "amazon_fees", "cogs", "ad_spend", "refunds", "profit")}
    assumed = False
    for product in products:
        eco = product["eco"]
        sold = window.get(product["id"])
        if sold:
            units, revenue = sold["units"] or 0, sold["revenue"] or 0
            fees = revenue * eco["referral_pct"] / 100 + units * eco["fba_fee"]
            cogs = units * eco["landed_cost"]
            ad, refunds = sold["ad_spend"] or 0, sold["refunds"] or 0
            profit = revenue - fees - cogs - ad - refunds
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

    per_product.sort(key=lambda r: r["profit"], reverse=True)
    totals = {k: round(v, 2) for k, v in totals.items()}
    totals["margin_pct"] = round(totals["profit"] / totals["revenue"] * 100, 1) if totals["revenue"] else 0.0
    totals["tacos_pct"] = round(totals["ad_spend"] / totals["revenue"] * 100, 1) if totals["revenue"] else 0.0
    return {"days": days, "totals": totals, "per_product": per_product, "inventory": inventory,
            "uses_assumed_cost": assumed,
            "sales_rows": conn.execute("SELECT COUNT(*) FROM sales").fetchone()[0]}


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
        elif column in ("chosen", "on_site"):
            out[column] = 1 if value in (True, 1, "1", "true", "on") else 0
        else:
            out[column] = logic.num(value)
    return out


def create_row(conn, table, data):
    fields = clean_fields(table, data)
    if table in ("products", "suppliers") and not fields.get("name"):
        raise ApiError("A name is required.")
    if table == "sales" and not fields.get("date"):
        fields["date"] = datetime.date.today().isoformat()
    if table in ("quotes", "sales", "listings") and not fields.get("product_id"):
        raise ApiError("Choose a product.")
    if table == "quotes" and not fields.get("supplier_id"):
        raise ApiError("Choose a supplier.")
    columns = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    cursor = conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({marks})", list(fields.values()))
    if table == "quotes" and fields.get("chosen"):
        _unchoose_others(conn, cursor.lastrowid)
    return cursor.lastrowid


def update_row(conn, table, row_id, data):
    fields = clean_fields(table, data)
    if not fields:
        return
    if "name" in fields and not fields["name"]:
        raise ApiError("A name is required.")
    sets = ", ".join(f"{c} = ?" for c in fields)
    conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", list(fields.values()) + [row_id])
    if table == "quotes" and fields.get("chosen"):
        _unchoose_others(conn, row_id)


def _unchoose_others(conn, quote_id):
    conn.execute("""UPDATE quotes SET chosen = 0 WHERE id != ? AND product_id =
                    (SELECT product_id FROM quotes WHERE id = ?)""", (quote_id, quote_id))


def import_products(conn, text):
    parsed, fields = logic.parse_csv(text, logic.PRODUCT_ALIASES)
    if "name" not in fields:
        raise ApiError("No product name column found. Expected a header such as Name, Title or Product Name.")
    added = skipped = 0
    for row in parsed:
        if not row.get("name"):
            skipped += 1
            continue
        create_row(conn, "products", row)
        added += 1
    return {"added": added, "skipped": skipped, "columns_used": fields}


def import_sales(conn, text):
    parsed, fields = logic.parse_csv(text, logic.SALES_ALIASES)
    missing = [f for f in ("date", "product", "units", "revenue") if f not in fields]
    if missing:
        raise ApiError("Missing column(s): " + ", ".join(missing) + ". Needed: date, product, units, revenue.")
    lookup = {}
    for product in db.rows(conn, "SELECT id, name, asin FROM products"):
        lookup[product["name"].strip().lower()] = product["id"]
        if product["asin"]:
            lookup[product["asin"].strip().lower()] = product["id"]
    added, unmatched = 0, []
    for row in parsed:
        product_id = lookup.get((row.get("product") or "").strip().lower())
        if not product_id:
            if row.get("product") and row["product"] not in unmatched:
                unmatched.append(row["product"])
            continue
        try:
            date = datetime.date.fromisoformat(row["date"][:10]).isoformat()
        except ValueError:
            try:
                date = datetime.datetime.strptime(row["date"], "%m/%d/%Y").date().isoformat()
            except ValueError:
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
    return storefront.build(products, listings, db.get_settings(conn))


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
