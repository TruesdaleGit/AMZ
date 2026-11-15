"""Builds the separate customer-facing website as plain static files.

The output folder can be uploaded as-is to any static host (Netlify, Cloudflare
Pages, GitHub Pages, S3). Checkout is a link per product: paste a Stripe Payment
Link (or any checkout URL) on the product, or it falls back to the Amazon page.
"""
import html
import os
import shutil

from logic import slugify

BUILD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storefront_build")

CSS = """
:root{--bg:#faf9f6;--card:#fff;--ink:#1c1b19;--muted:#66645e;--line:#e4e1d9;--accent:#1f5f4a;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#f0efec;--muted:#a9a79f;--line:#33322e;--accent:#58b598;--accent-ink:#0f1f1a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
header,main,footer{max-width:1040px;margin:0 auto;padding:0 20px}
header{display:flex;justify-content:space-between;align-items:baseline;padding-top:28px;padding-bottom:20px;border-bottom:1px solid var(--line)}
header a{text-decoration:none;font-weight:700;font-size:1.25rem;letter-spacing:-.01em}
header span{color:var(--muted);font-size:.9rem}
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
.product{display:grid;grid-template-columns:1fr 1fr;gap:40px;padding:40px 0 56px}
.photo{aspect-ratio:1;background:var(--line);border-radius:12px;overflow:hidden;display:grid;place-items:center;color:var(--muted)}
.product h1{font-size:1.7rem;line-height:1.2;margin:0 0 10px;letter-spacing:-.01em}
.product .price{font-size:1.4rem;margin:0 0 20px}
.product ul{padding-left:20px;margin:0 0 24px}
.product li{margin-bottom:8px}
.buy{display:inline-block;background:var(--accent);color:var(--accent-ink);padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:600}
.soon{display:inline-block;border:1px solid var(--line);color:var(--muted);padding:12px 24px;border-radius:8px}
.desc{color:var(--muted);margin-top:24px}
.back{display:inline-block;margin-top:24px;color:var(--muted);font-size:.9rem}
footer{border-top:1px solid var(--line);padding-top:20px;padding-bottom:40px;color:var(--muted);font-size:.85rem}
.empty{padding:40px 0 80px;color:var(--muted)}
@media (max-width:720px){.product{grid-template-columns:1fr;gap:24px}}
"""


def _e(text):
    return html.escape(str(text or ""), quote=True)


def _safe_url(url):
    url = (url or "").strip()
    return url if url.lower().startswith(("https://", "http://")) else ""


def _page(title, store, tagline, body, root=""):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_e(title)}</title>
<meta name="description" content="{_e(tagline)}">
<link rel="stylesheet" href="{root}style.css">
</head>
<body>
<header><a href="{root}index.html">{_e(store)}</a><span>{_e(tagline)}</span></header>
<main>
{body}
</main>
<footer>&copy; {_e(store)}</footer>
</body>
</html>
"""


def _image(url, alt, placeholder):
    url = _safe_url(url)
    if url:
        return f'<img src="{_e(url)}" alt="{_e(alt)}" loading="lazy">'
    return placeholder


def build(products, listings_by_product, settings):
    """Write the site. products: rows flagged on_site. Returns a summary."""
    store = settings.get("store_name") or "Store"
    tagline = settings.get("store_tagline") or ""
    if os.path.isdir(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(os.path.join(BUILD_DIR, "products"))
    with open(os.path.join(BUILD_DIR, "style.css"), "w", encoding="utf-8") as f:
        f.write(CSS.strip() + "\n")

    cards, pages, warnings, seen = [], [], [], set()
    for product in products:
        listing = listings_by_product.get(product["id"]) or {}
        title = listing.get("title") or product["name"]
        slug = slugify(product["name"])
        while slug in seen:
            slug += "-" + str(product["id"])
        seen.add(slug)
        price = f"${float(product.get('price') or 0):,.2f}"

        checkout = _safe_url(product.get("checkout_url"))
        amazon = _safe_url(product.get("amazon_url"))
        if checkout:
            button = f'<a class="buy" href="{_e(checkout)}">Buy now</a>'
        elif amazon:
            button = f'<a class="buy" href="{_e(amazon)}" rel="noopener">Buy on Amazon</a>'
        else:
            button = '<span class="soon">Coming soon</span>'
            warnings.append(f"{product['name']}: no checkout or Amazon link, so it shows 'Coming soon'.")
        if not listing.get("title"):
            warnings.append(f"{product['name']}: no listing written yet, so the page has only a name and price.")
        if not _safe_url(product.get("image_url")):
            warnings.append(f"{product['name']}: no image URL.")

        bullets = "".join(f"<li>{_e(listing.get(f'bullet{i}'))}</li>" for i in range(1, 6) if listing.get(f"bullet{i}"))
        desc = f'<p class="desc">{_e(listing.get("description"))}</p>' if listing.get("description") else ""
        body = f"""<section class="product">
<div class="photo">{_image(product.get('image_url'), product['name'], 'Photo coming soon')}</div>
<div>
<h1>{_e(title)}</h1>
<p class="price">{price}</p>
{'<ul>' + bullets + '</ul>' if bullets else ''}
{button}
{desc}
<br><a class="back" href="../index.html">&larr; All products</a>
</div>
</section>"""
        with open(os.path.join(BUILD_DIR, "products", slug + ".html"), "w", encoding="utf-8") as f:
            f.write(_page(f"{product['name']} | {store}", store, tagline, body, root="../"))
        pages.append(f"products/{slug}.html")
        cards.append(f"""<a class="card" href="products/{slug}.html">
<div class="thumb">{_image(product.get('image_url'), product['name'], 'No photo yet')}</div>
<div class="body"><h2>{_e(product['name'])}</h2><span class="price">{price}</span></div>
</a>""")

    grid = f'<section class="grid">{"".join(cards)}</section>' if cards else \
        '<p class="empty">No products are published yet.</p>'
    index = f'<section class="hero"><h1>{_e(store)}</h1><p>{_e(tagline)}</p></section>\n{grid}'
    with open(os.path.join(BUILD_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(_page(store, store, tagline, index))
    return {"folder": BUILD_DIR, "pages": ["index.html"] + pages, "products": len(products), "warnings": warnings}
