"""Builds the separate customer-facing website as plain static files.

The output folder can be uploaded as-is to any static host (Netlify, Cloudflare
Pages, GitHub Pages, S3). Checkout is a link per product: paste a Stripe Payment
Link (or any checkout URL) on the product, or it falls back to the Amazon page.
"""
import html
import json
import os
import shutil

from logic import slugify

BUILD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storefront_build")

# name -> (accent light, text on accent light, accent dark, text on accent dark)
THEMES = {
    "forest": ("#1f5f4a", "#ffffff", "#58b598", "#0f1f1a"),
    "ocean": ("#1d5a8f", "#ffffff", "#6aaee6", "#0c1a27"),
    "clay": ("#a4472a", "#ffffff", "#e58f72", "#27110a"),
    "ink": ("#1c1b19", "#ffffff", "#f0efec", "#161614"),
}

CSS = """
:root{--bg:#faf9f6;--card:#fff;--ink:#1c1b19;--muted:#66645e;--line:#e4e1d9;--accent:@@accent@@;--accent-ink:@@accent_ink@@}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#f0efec;--muted:#a9a79f;--line:#33322e;--accent:@@accent_dark@@;--accent-ink:@@accent_dark_ink@@}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
header,main,footer{max-width:1040px;margin:0 auto;padding:0 20px}
header{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between;align-items:baseline;padding-top:28px;padding-bottom:20px;border-bottom:1px solid var(--line)}
header .name{text-decoration:none;font-weight:700;font-size:1.25rem;letter-spacing:-.01em}
header nav{display:flex;gap:20px;font-size:.95rem}
header nav a{text-decoration:none;color:var(--muted)}
header nav a:hover{color:var(--ink)}
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
.product{display:grid;grid-template-columns:1fr 1fr;gap:40px;padding:40px 0 32px}
.photo{aspect-ratio:1;background:var(--line);border-radius:12px;overflow:hidden;display:grid;place-items:center;color:var(--muted)}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.thumbs button{width:64px;height:64px;padding:0;border:2px solid var(--line);border-radius:8px;overflow:hidden;background:none;cursor:pointer}
.thumbs button[aria-current=true]{border-color:var(--accent)}
.thumbs img{width:100%;height:100%;object-fit:cover;display:block}
.product h1{font-size:1.7rem;line-height:1.2;margin:0 0 10px;letter-spacing:-.01em}
.product .price{font-size:1.4rem;margin:0 0 20px}
.product ul{padding-left:20px;margin:0 0 24px}
.product li{margin-bottom:8px}
.buy{display:inline-block;background:var(--accent);color:var(--accent-ink);padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:600}
.soon{display:inline-block;border:1px solid var(--line);color:var(--muted);padding:12px 24px;border-radius:8px}
.desc{color:var(--muted);margin-top:24px}
.more{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;padding:8px 0 40px}
.more section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
.more h2{font-size:1.05rem;margin:0 0 6px}
.more p{margin:0;color:var(--muted)}
.back{display:inline-block;margin:0 0 48px;color:var(--muted);font-size:.9rem}
.page{max-width:68ch;padding:48px 0 64px}
.page h1{font-size:2rem;letter-spacing:-.02em;margin:0 0 16px}
.page p{margin:0 0 16px}
footer{border-top:1px solid var(--line);padding-top:20px;padding-bottom:40px;color:var(--muted);font-size:.85rem}
.empty{padding:40px 0 80px;color:var(--muted)}
@media (max-width:720px){.product{grid-template-columns:1fr;gap:24px}}
"""

GALLERY_JS = """<script>
document.querySelectorAll('.thumbs button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelector('.photo img').src = b.querySelector('img').src;
    document.querySelectorAll('.thumbs button').forEach(function (o) { o.setAttribute('aria-current', o === b); });
  });
});
</script>"""


def _e(text):
    return html.escape(str(text or ""), quote=True)


def _safe_url(url):
    url = (url or "").strip()
    return url if url.lower().startswith(("https://", "http://")) else ""


def _paragraphs(text):
    return "".join(f"<p>{_e(p.strip())}</p>" for p in (text or "").split("\n") if p.strip())


def _shorten(text, limit=155):
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[:limit - 1].rsplit(" ", 1)[0] + "…"


def product_images(product):
    """Main image first, then the extra images, without duplicates."""
    seen, out = set(), []
    for url in [product.get("image_url") or ""] + (product.get("images") or "").splitlines():
        url = url.strip()
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


class _Site:
    def __init__(self, settings, upload_dir):
        self.store = settings.get("store_name") or "Store"
        self.tagline = settings.get("store_tagline") or ""
        self.description = settings.get("store_description") or self.tagline
        self.upload_dir = upload_dir
        self.nav = []
        self.warnings = []

    def image(self, url, root):
        """Return the src to use in a page, copying uploaded files into the site."""
        if url.startswith("/uploads/"):
            name = os.path.basename(url)
            source = os.path.join(self.upload_dir or "", name)
            if not os.path.isfile(source):
                return ""
            os.makedirs(os.path.join(BUILD_DIR, "images"), exist_ok=True)
            shutil.copy2(source, os.path.join(BUILD_DIR, "images", name))
            return f"{root}images/{name}"
        return _safe_url(url)

    def page(self, path, title, description, body, root="", image="", extra_head=""):
        nav = "".join(f'<a href="{root}{href}">{_e(label)}</a>' for label, href in self.nav)
        og_image = f'\n<meta property="og:image" content="{_e(image)}">' if image.startswith("http") else ""
        text = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_e(title)}</title>
<meta name="description" content="{_e(_shorten(description))}">
<meta property="og:title" content="{_e(title)}">
<meta property="og:description" content="{_e(_shorten(description))}">
<meta property="og:site_name" content="{_e(self.store)}">{og_image}
<link rel="stylesheet" href="{root}style.css">{extra_head}
</head>
<body>
<header><a class="name" href="{root}index.html">{_e(self.store)}</a><nav>{nav}</nav></header>
<main>
{body}
</main>
<footer>&copy; {_e(self.store)}</footer>
</body>
</html>
"""
        with open(os.path.join(BUILD_DIR, *path.split("/")), "w", encoding="utf-8") as f:
            f.write(text)


def build(products, listings_by_product, settings, upload_dir=None):
    """Write the site. products: rows flagged on_site. Returns a summary."""
    site = _Site(settings, upload_dir)
    if os.path.isdir(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(os.path.join(BUILD_DIR, "products"))
    theme = THEMES.get(settings.get("store_theme"), THEMES["forest"])
    with open(os.path.join(BUILD_DIR, "style.css"), "w", encoding="utf-8") as f:
        css = CSS
        for name, value in zip(("accent", "accent_ink", "accent_dark", "accent_dark_ink"), theme):
            css = css.replace(f"@@{name}@@", value)
        f.write(css.strip() + "\n")

    about = (settings.get("about_text") or "").strip()
    contact_email = (settings.get("contact_email") or "").strip()
    contact_text = (settings.get("contact_text") or "").strip()
    site.nav = [("Shop", "index.html")]
    if about:
        site.nav.append(("About", "about.html"))
    if contact_email or contact_text:
        site.nav.append(("Contact", "contact.html"))

    cards, pages, seen = [], ["index.html"], set()
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
            site.warnings.append(f"{product['name']}: no checkout or Amazon link, so it shows 'Coming soon'.")
        if not listing.get("title"):
            site.warnings.append(f"{product['name']}: no listing written yet, so the page has only a name and price.")

        urls = product_images(product)
        images = [src for src in (site.image(u, "../") for u in urls) if src]
        if not images:
            site.warnings.append(f"{product['name']}: no image.")
        alt = _e(product["name"])
        photo = f'<img src="{_e(images[0])}" alt="{alt}">' if images else "Photo coming soon"
        thumbs = ""
        if len(images) > 1:
            thumbs = '<div class="thumbs">' + "".join(
                f'<button type="button" aria-label="Photo {i + 1}" aria-current="{"true" if i == 0 else "false"}">'
                f'<img src="{_e(src)}" alt=""></button>' for i, src in enumerate(images)) + "</div>"

        bullets = "".join(f"<li>{_e(listing.get(f'bullet{i}'))}</li>" for i in range(1, 6) if listing.get(f"bullet{i}"))
        desc = f'<p class="desc">{_e(listing.get("description"))}</p>' if listing.get("description") else ""
        sections = ""
        for line in (listing.get("aplus") or "").splitlines():
            head, _, text = line.partition("|")
            if head.strip() and text.strip():
                sections += f"<section><h2>{_e(head.strip())}</h2><p>{_e(text.strip())}</p></section>"
        body = f"""<section class="product">
<div><div class="photo">{photo}</div>{thumbs}</div>
<div>
<h1>{_e(title)}</h1>
<p class="price">{price}</p>
{'<ul>' + bullets + '</ul>' if bullets else ''}
{button}
{desc}
</div>
</section>
{'<div class="more">' + sections + '</div>' if sections else ''}
<a class="back" href="../index.html">&larr; All products</a>
{GALLERY_JS if thumbs else ''}"""
        summary = listing.get("description") or listing.get("bullet1") or product["name"]
        schema = {"@context": "https://schema.org", "@type": "Product", "name": title,
                  "description": _shorten(summary, 300),
                  "offers": {"@type": "Offer", "price": f"{float(product.get('price') or 0):.2f}", "priceCurrency": "USD"}}
        if listing.get("brand"):
            schema["brand"] = {"@type": "Brand", "name": listing["brand"]}
        absolute = [i for i in images if i.startswith("http")]
        if absolute:
            schema["image"] = absolute
        head = '\n<script type="application/ld+json">' + json.dumps(schema).replace("</", "<\\/") + "</script>"
        site.page(f"products/{slug}.html", f"{product['name']} | {site.store}", summary, body, root="../",
                  image=absolute[0] if absolute else "", extra_head=head)
        pages.append(f"products/{slug}.html")

        card_image = site.image(urls[0], "") if urls else ""
        thumb = f'<img src="{_e(card_image)}" alt="{alt}" loading="lazy">' if card_image else "No photo yet"
        cards.append(f"""<a class="card" href="products/{slug}.html">
<div class="thumb">{thumb}</div>
<div class="body"><h2>{_e(product['name'])}</h2><span class="price">{price}</span></div>
</a>""")

    grid = f'<section class="grid">{"".join(cards)}</section>' if cards else \
        '<p class="empty">No products are published yet.</p>'
    index = f'<section class="hero"><h1>{_e(site.store)}</h1><p>{_e(site.tagline)}</p></section>\n{grid}'
    site.page("index.html", site.store, site.description, index)

    if about:
        site.page("about.html", f"About | {site.store}", about,
                  f'<section class="page"><h1>About {_e(site.store)}</h1>{_paragraphs(about)}</section>')
        pages.append("about.html")
    if contact_email or contact_text:
        email = f'<p><a href="mailto:{_e(contact_email)}">{_e(contact_email)}</a></p>' if contact_email else ""
        site.page("contact.html", f"Contact | {site.store}", contact_text or f"Contact {site.store}",
                  f'<section class="page"><h1>Contact</h1>{_paragraphs(contact_text)}{email}</section>')
        pages.append("contact.html")
    return {"folder": BUILD_DIR, "pages": pages, "products": len(products), "warnings": site.warnings}
