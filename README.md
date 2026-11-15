# Seller Toolkit

A local web app for private label selling on Amazon. It runs on your own computer,
stores everything in one file (`data.db`), and needs nothing installed except Python.

## Run it (Windows)

Requires Python 3.9 or newer from https://www.python.org/downloads/ (tick
**Add Python to PATH** during setup). No packages to install.

Double-click `Start Seller Toolkit.bat`. A small window opens and the app appears in
your browser at http://127.0.0.1:8765. Keep that window open while you use the app;
close it to stop.

From Command Prompt instead: `python app.py`. To use another port:
`set PORT=8800` and then `python app.py`.

## Update it

Double-click `Update Seller Toolkit.bat`. It downloads the latest version from
https://github.com/TruesdaleGit/AMZ and replaces the program files. Your data
(`data.db`) is never touched. Close and restart the app afterwards.

To try it with example data, import `sample_data/products.csv` under **Find products**
and `sample_data/sales.csv` under **Profit**.

## The five sections

| Section | What it does |
|---|---|
| 1. Find products | Add product ideas or import a CSV. Each is scored 0-100 on demand, competition, price, margin and size. Click a row for the score breakdown and profit per unit. |
| 2. Source vendors | Record suppliers and quotes, compare landed cost (unit cost + duty + freight + other), pick the quote to use, and draft a first message to a supplier. |
| 3. Amazon listings | Enter features and keywords, generate a draft title, bullets, description and search terms, and check them against Amazon's general length and style rules. Export a tab-separated file. |
| 4. Website | Build a separate storefront as static files. Preview it at `/store/`, download it as a zip, and upload it to any static host. |
| 5. Profit | Net profit after Amazon fees, product cost, ads and refunds; reorder alerts; a price planner. Enter sales by hand or import a CSV. |

## What it does not do

- **No live Amazon data.** Sales, review and price figures come from you or from a CSV
  exported from a research tool. The importer recognises common column names
  (Name/Title, Price, Monthly Sales, Reviews/Review Count, Rating, Weight) and ignores the rest.
- **No direct upload to Amazon.** The listing export uses Amazon's common attribute
  names; copy the columns into the category template you download from Seller Central.
  Pushing listings automatically needs Selling Partner API access on your seller account.
- **No built-in checkout.** Each storefront Buy button links to a checkout URL you
  paste in (for example a Stripe Payment Link), or to the Amazon page.
- **Fees are estimates.** FBA fees are approximated from weight and size for US
  standard and bulky items, and the referral fee defaults to 15%. Amazon changes these;
  enter the real numbers per product once you have them.
- **The listing draft is template-based**, a starting point to edit, not finished copy.
- **The price planner shows profit per unit only.** It does not predict how a price
  change affects how many units sell.

## Files

- `app.py`: web server and API
- `logic.py`: fee estimates, profit maths, scoring, listing checks, CSV parsing
- `storefront.py`: static website builder
- `db.py`: database schema
- `update.py`: the updater
- `static/`: the interface
- `tests/test_logic.py`: run with `python tests\test_logic.py`

Back up your data by copying `data.db`.
