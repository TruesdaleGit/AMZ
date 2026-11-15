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

## Sections

| Group | Section | What it does |
|---|---|---|
| Research | Find products | Add ideas or import a CSV. Each is scored 0-100; filter, sort and compare them side by side. Score weights are in Settings. |
| Research | Profit ranking | Ranks every idea by estimated monthly profit, with a Proceed, Investigate or Skip verdict, the investment needed, payback time and things to check. |
| Research | Keywords | Keep keywords with search volume and competition, ranked by priority, and send the top ones to the listing. |
| Research | Competitors | Log competing listings' price, reviews and rating over time. |
| Research | Review analysis | Paste competitor reviews to count complaint themes and repeated phrases. |
| Sourcing | Source vendors | Suppliers and quotes with currency conversion, price breaks, landed cost and sample notes and photos. |
| Sourcing | Purchase orders | Track orders from deposit to delivery. Marking one received adds its units to stock. |
| Launch | Amazon listings | Draft, check, version and export listings, with A+ sections for the website. |
| Launch | Website | Build a static storefront with photo galleries, About and Contact pages, color themes and search-engine tags. |
| Launch | Launch checklist | Per-product task list with a standard template. |
| Money | Profit | Net profit after fees, product cost, ads, refunds and overheads; monthly trend; reorder alerts; price planner; launch break-even. |
| Money | Ad campaigns | Import an Amazon ad report and see which keywords lose money against your break-even ad cost. |
| Money | Cash flow | Six-month cash projection from sales pace, order payments and overheads. |

Most tables have an **Export to Excel** button. Your data is copied to the `backups`
folder each time the app starts (the newest 20 copies are kept).

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
- **Review analysis counts words; it does not read.** Check the example quotes before
  acting on a theme.
- **The Ad campaigns section is analysis only.** Profit uses the ad spend on your sales
  entries, so importing an ad report does not change profit figures.
- **The cash flow forecast is a projection** from your last 30 days of sales. It assumes
  that pace continues and that you do not run out of stock.
- **The price planner shows profit per unit only.** It does not predict how a price
  change affects how many units sell.

## Files

- `app.py`: web server and API
- `logic.py`: fee estimates, profit maths, scoring, listing checks, CSV parsing
- `storefront.py`: static website builder
- `db.py`: database schema
- `xlsx.py`: Excel export
- `update.py`: the updater
- `static/`: the interface
- `tests/test_logic.py`: run with `python tests\test_logic.py`

Your data lives in `data.db`, `uploads/` and `backups/`. Copy those to move to another PC.
