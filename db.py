"""SQLite storage. One file, created next to the app on first run."""
import datetime
import glob
import os
import shutil
import sqlite3

from logic import DEFAULT_SETTINGS

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("SELLER_TOOLKIT_DB") or os.path.join(APP_DIR, "data.db")
BACKUP_DIR = os.path.join(os.path.dirname(DB_PATH), "backups")
BACKUPS_TO_KEEP = 20

# table -> list of (column, SQL type and default). "id" is added automatically.
# New columns listed here are added to existing databases on start-up.
TABLES = {
    "products": [
        ("name", "TEXT NOT NULL"), ("asin", "TEXT DEFAULT ''"), ("category", "TEXT DEFAULT ''"),
        ("price", "REAL DEFAULT 0"), ("monthly_sales", "REAL DEFAULT 0"), ("reviews", "REAL DEFAULT 0"),
        ("rating", "REAL DEFAULT 0"), ("weight_lb", "REAL DEFAULT 0"), ("length_in", "REAL DEFAULT 0"),
        ("width_in", "REAL DEFAULT 0"), ("height_in", "REAL DEFAULT 0"), ("referral_pct", "REAL"),
        ("fba_fee_override", "REAL"), ("status", "TEXT DEFAULT 'idea'"), ("stock_on_hand", "REAL DEFAULT 0"),
        ("image_url", "TEXT DEFAULT ''"), ("images", "TEXT DEFAULT ''"), ("amazon_url", "TEXT DEFAULT ''"),
        ("checkout_url", "TEXT DEFAULT ''"), ("on_site", "INTEGER DEFAULT 0"), ("notes", "TEXT DEFAULT ''"),
    ],
    "suppliers": [
        ("name", "TEXT NOT NULL"), ("contact", "TEXT DEFAULT ''"), ("country", "TEXT DEFAULT ''"),
        ("url", "TEXT DEFAULT ''"), ("notes", "TEXT DEFAULT ''"),
    ],
    "quotes": [
        ("product_id", "INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE"),
        ("supplier_id", "INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE"),
        ("unit_cost", "REAL DEFAULT 0"), ("currency", "TEXT DEFAULT 'USD'"), ("fx_rate", "REAL DEFAULT 1"),
        ("price_breaks", "TEXT DEFAULT ''"), ("moq", "REAL DEFAULT 0"), ("lead_time_days", "REAL DEFAULT 0"),
        ("freight_per_unit", "REAL DEFAULT 0"), ("duty_pct", "REAL DEFAULT 0"), ("other_per_unit", "REAL DEFAULT 0"),
        ("sample_status", "TEXT DEFAULT 'not requested'"), ("sample_cost", "REAL DEFAULT 0"),
        ("sample_notes", "TEXT DEFAULT ''"), ("sample_photo", "TEXT DEFAULT ''"),
        ("chosen", "INTEGER DEFAULT 0"), ("notes", "TEXT DEFAULT ''"),
    ],
    "listings": [
        ("product_id", "INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE"),
        ("brand", "TEXT DEFAULT ''"), ("sku", "TEXT DEFAULT ''"), ("features", "TEXT DEFAULT ''"),
        ("keywords", "TEXT DEFAULT ''"), ("title", "TEXT DEFAULT ''"), ("bullet1", "TEXT DEFAULT ''"),
        ("bullet2", "TEXT DEFAULT ''"), ("bullet3", "TEXT DEFAULT ''"), ("bullet4", "TEXT DEFAULT ''"),
        ("bullet5", "TEXT DEFAULT ''"), ("description", "TEXT DEFAULT ''"), ("search_terms", "TEXT DEFAULT ''"),
        ("aplus", "TEXT DEFAULT ''"),
    ],
    "listing_versions": [
        ("listing_id", "INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE"),
        ("saved_at", "TEXT NOT NULL"), ("label", "TEXT DEFAULT ''"), ("data", "TEXT NOT NULL"),
    ],
    "sales": [
        ("product_id", "INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE"),
        ("date", "TEXT NOT NULL"), ("units", "REAL DEFAULT 0"), ("revenue", "REAL DEFAULT 0"),
        ("ad_spend", "REAL DEFAULT 0"), ("refunds", "REAL DEFAULT 0"), ("sales_tax", "REAL DEFAULT 0"),
    ],
    "keywords": [
        ("product_id", "INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE"),
        ("keyword", "TEXT NOT NULL"), ("search_volume", "REAL DEFAULT 0"),
        ("competing_products", "REAL DEFAULT 0"), ("notes", "TEXT DEFAULT ''"),
    ],
    "competitors": [
        ("product_id", "INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE"),
        ("name", "TEXT NOT NULL"), ("asin", "TEXT DEFAULT ''"), ("url", "TEXT DEFAULT ''"),
        ("notes", "TEXT DEFAULT ''"),
    ],
    "snapshots": [
        ("competitor_id", "INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE"),
        ("date", "TEXT NOT NULL"), ("price", "REAL DEFAULT 0"), ("reviews", "REAL DEFAULT 0"),
        ("rating", "REAL DEFAULT 0"),
    ],
    "tasks": [
        ("product_id", "INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE"),
        ("title", "TEXT NOT NULL"), ("done", "INTEGER DEFAULT 0"), ("due_date", "TEXT DEFAULT ''"),
        ("position", "REAL DEFAULT 0"),
    ],
    "purchase_orders": [
        ("product_id", "INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE"),
        ("supplier_id", "INTEGER REFERENCES suppliers(id) ON DELETE SET NULL"),
        ("quantity", "REAL DEFAULT 0"), ("unit_cost", "REAL DEFAULT 0"), ("deposit_pct", "REAL DEFAULT 30"),
        ("freight_total", "REAL DEFAULT 0"), ("order_date", "TEXT DEFAULT ''"),
        ("balance_due_date", "TEXT DEFAULT ''"), ("expected_arrival", "TEXT DEFAULT ''"),
        ("status", "TEXT DEFAULT 'planned'"), ("tracking", "TEXT DEFAULT ''"),
        ("units_received", "REAL DEFAULT 0"), ("stock_added", "INTEGER DEFAULT 0"), ("notes", "TEXT DEFAULT ''"),
    ],
    "ads": [
        ("product_id", "INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE"),
        ("date", "TEXT DEFAULT ''"), ("campaign", "TEXT DEFAULT ''"), ("keyword", "TEXT DEFAULT ''"),
        ("impressions", "REAL DEFAULT 0"), ("clicks", "REAL DEFAULT 0"), ("spend", "REAL DEFAULT 0"),
        ("sales", "REAL DEFAULT 0"), ("orders", "REAL DEFAULT 0"),
    ],
    "overheads": [
        ("name", "TEXT NOT NULL"), ("monthly_amount", "REAL DEFAULT 0"), ("notes", "TEXT DEFAULT ''"),
    ],
    "reviews": [
        ("product_id", "INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE"),
        ("text", "TEXT DEFAULT ''"),
    ],
}

# Columns the API may write. Everything except bookkeeping the server owns.
SERVER_OWNED = {"stock_added", "saved_at", "data"}
WRITABLE = {table: [c for c, _ in cols if c not in SERVER_OWNED]
            for table, cols in TABLES.items() if table != "listing_versions"}
# Blank means "use the default", so these are stored as NULL rather than 0.
NULLABLE_NUMBERS = {"referral_pct", "fba_fee_override", "supplier_id"}
FLAGS = {"chosen", "on_site", "done"}
TEXT_COLUMNS = {c for cols in TABLES.values() for c, kind in cols if kind.startswith("TEXT")}
REQUIRED = {"products": "name", "suppliers": "name", "keywords": "keyword", "competitors": "name",
            "tasks": "title", "overheads": "name"}


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def backup():
    """Copy the database to backups/ before anything touches it. Keeps the newest 20."""
    if not os.path.isfile(DB_PATH) or os.path.getsize(DB_PATH) == 0:
        return None
    os.makedirs(BACKUP_DIR, exist_ok=True)
    existing = sorted(glob.glob(os.path.join(BACKUP_DIR, "data-*.db")))
    if existing and open(existing[-1], "rb").read() == open(DB_PATH, "rb").read():
        return None  # nothing changed since the last backup
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = os.path.join(BACKUP_DIR, f"data-{stamp}.db")
    shutil.copy2(DB_PATH, target)
    for old in sorted(glob.glob(os.path.join(BACKUP_DIR, "data-*.db")))[:-BACKUPS_TO_KEEP]:
        os.remove(old)
    return target


def init():
    conn = connect()
    for table, columns in TABLES.items():
        body = ", ".join(f"{name} {kind}" for name, kind in columns)
        conn.execute(f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY AUTOINCREMENT, {body})")
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, kind in columns:
            if name not in have:  # database from an older version of the app
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind.replace(' NOT NULL', '').replace(' UNIQUE', '')}")
    conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))
    conn.commit()
    conn.close()


def rows(conn, sql, params=()):
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def get_settings(conn):
    return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
