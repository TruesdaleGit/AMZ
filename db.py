"""SQLite storage. One file, created next to the app on first run."""
import os
import sqlite3

from logic import DEFAULT_SETTINGS

DB_PATH = os.environ.get("SELLER_TOOLKIT_DB") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    asin TEXT DEFAULT '',
    category TEXT DEFAULT '',
    price REAL DEFAULT 0,
    monthly_sales REAL DEFAULT 0,
    reviews REAL DEFAULT 0,
    rating REAL DEFAULT 0,
    weight_lb REAL DEFAULT 0,
    length_in REAL DEFAULT 0,
    width_in REAL DEFAULT 0,
    height_in REAL DEFAULT 0,
    referral_pct REAL,
    fba_fee_override REAL,
    status TEXT DEFAULT 'idea',
    stock_on_hand REAL DEFAULT 0,
    image_url TEXT DEFAULT '',
    amazon_url TEXT DEFAULT '',
    checkout_url TEXT DEFAULT '',
    on_site INTEGER DEFAULT 0,
    notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact TEXT DEFAULT '',
    country TEXT DEFAULT '',
    url TEXT DEFAULT '',
    notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    unit_cost REAL DEFAULT 0,
    moq REAL DEFAULT 0,
    lead_time_days REAL DEFAULT 0,
    freight_per_unit REAL DEFAULT 0,
    duty_pct REAL DEFAULT 0,
    other_per_unit REAL DEFAULT 0,
    sample_status TEXT DEFAULT 'not requested',
    chosen INTEGER DEFAULT 0,
    notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
    brand TEXT DEFAULT '',
    sku TEXT DEFAULT '',
    features TEXT DEFAULT '',
    keywords TEXT DEFAULT '',
    title TEXT DEFAULT '',
    bullet1 TEXT DEFAULT '',
    bullet2 TEXT DEFAULT '',
    bullet3 TEXT DEFAULT '',
    bullet4 TEXT DEFAULT '',
    bullet5 TEXT DEFAULT '',
    description TEXT DEFAULT '',
    search_terms TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    units REAL DEFAULT 0,
    revenue REAL DEFAULT 0,
    ad_spend REAL DEFAULT 0,
    refunds REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

# Columns the API is allowed to write, per table.
WRITABLE = {
    "products": ["name", "asin", "category", "price", "monthly_sales", "reviews", "rating", "weight_lb",
                 "length_in", "width_in", "height_in", "referral_pct", "fba_fee_override", "status",
                 "stock_on_hand", "image_url", "amazon_url", "checkout_url", "on_site", "notes"],
    "suppliers": ["name", "contact", "country", "url", "notes"],
    "quotes": ["product_id", "supplier_id", "unit_cost", "moq", "lead_time_days", "freight_per_unit",
               "duty_pct", "other_per_unit", "sample_status", "chosen", "notes"],
    "listings": ["product_id", "brand", "sku", "features", "keywords", "title", "bullet1", "bullet2",
                 "bullet3", "bullet4", "bullet5", "description", "search_terms"],
    "sales": ["product_id", "date", "units", "revenue", "ad_spend", "refunds"],
}
# Blank means "use the default", so these are stored as NULL rather than 0.
NULLABLE_NUMBERS = {"referral_pct", "fba_fee_override"}
TEXT_COLUMNS = {"name", "asin", "category", "status", "image_url", "amazon_url", "checkout_url", "notes",
                "contact", "country", "url", "sample_status", "brand", "sku", "features", "keywords",
                "title", "bullet1", "bullet2", "bullet3", "bullet4", "bullet5", "description",
                "search_terms", "date"}


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init():
    conn = connect()
    conn.executescript(SCHEMA)
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))
    conn.commit()
    conn.close()


def rows(conn, sql, params=()):
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def get_settings(conn):
    return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
