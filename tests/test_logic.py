import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import logic

SETTINGS = dict(logic.DEFAULT_SETTINGS)


class Fees(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(logic.estimate_fba_fee(0.6, 9, 9, 1), (4.15, "large standard"))
        self.assertEqual(logic.estimate_fba_fee(0.3, 10, 6, 0.5)[1], "small standard")
        self.assertEqual(logic.estimate_fba_fee(30, 30, 20, 12)[1], "bulky")
        self.assertEqual(logic.estimate_fba_fee(0), (0.0, "unknown"))

    def test_dimensional_weight_beats_scale_weight(self):
        light_but_big = logic.estimate_fba_fee(0.5, 17, 13, 7)[0]
        self.assertGreater(light_but_big, logic.estimate_fba_fee(0.5, 6, 4, 2)[0])


class Economics(unittest.TestCase):
    product = {"price": 25, "weight_lb": 0.6, "length_in": 9, "width_in": 9, "height_in": 1}
    quote = {"unit_cost": 4, "duty_pct": 10, "freight_per_unit": 0.8, "other_per_unit": 0.3}

    def test_landed_cost(self):
        self.assertEqual(logic.landed_cost(self.quote), 5.5)
        self.assertIsNone(logic.landed_cost(None))

    def test_profit(self):
        eco = logic.unit_economics(self.product, self.quote, SETTINGS)
        # 25 - 3.75 referral - 4.15 FBA - 5.50 landed - 0.75 returns
        self.assertEqual(eco["profit"], 10.85)
        self.assertEqual(eco["margin_pct"], 43.4)
        self.assertEqual(eco["cost_source"], "quote")

    def test_assumed_cost_without_quote(self):
        eco = logic.unit_economics(self.product, None, SETTINGS)
        self.assertEqual(eco["landed_cost"], 6.25)
        self.assertEqual(eco["cost_source"], "assumed")

    def test_override_and_blank(self):
        eco = logic.unit_economics({**self.product, "fba_fee_override": 5, "referral_pct": 8}, self.quote, SETTINGS)
        self.assertEqual((eco["fba_fee"], eco["referral_fee"]), (5, 2.0))
        eco = logic.unit_economics({**self.product, "fba_fee_override": None, "referral_pct": ""}, self.quote, SETTINGS)
        self.assertEqual((eco["fba_fee"], eco["referral_pct"]), (4.15, 15))

    def test_min_price_hits_target_margin(self):
        price = logic.min_price_for_margin(self.product, self.quote, SETTINGS)
        eco = logic.unit_economics({**self.product, "price": price}, self.quote, SETTINGS)
        self.assertAlmostEqual(eco["margin_pct"], 30, delta=0.2)
        self.assertIsNone(logic.min_price_for_margin(self.product, None, SETTINGS))

    def test_pick_quote(self):
        cheap, dear = {"unit_cost": 3}, {"unit_cost": 6, "chosen": 1}
        self.assertIs(logic.pick_quote([cheap, dear]), dear)
        self.assertIs(logic.pick_quote([cheap, {"unit_cost": 6}]), cheap)

    def test_score_orders_good_above_bad(self):
        good = {"price": 30, "monthly_sales": 500, "reviews": 150, "rating": 4.0, "weight_lb": 0.5}
        bad = {"price": 9, "monthly_sales": 40, "reviews": 9000, "rating": 4.8, "weight_lb": 8}
        score = lambda p: logic.opportunity_score(p, logic.unit_economics(p, None, SETTINGS))["score"]
        self.assertGreater(score(good), 80)
        self.assertLess(score(bad), 20)


class Listings(unittest.TestCase):
    def test_flags(self):
        issues = logic.validate_listing({"brand": "Acme", "title": "BEST seller mat! #1 sale", "search_terms": "x" * 300})
        text = " ".join(i["message"] for i in issues)
        for expected in ("promotional", "rejects", "300 bytes", "0 of 5", "start with the brand"):
            self.assertIn(expected, text)

    def test_promo_words_match_whole_words_only(self):
        issues = logic.validate_listing({"title": "Acme Wholesale Crate for Salers"})
        self.assertFalse([i for i in issues if "promotional" in i["message"]])

    def test_draft_passes_own_checks(self):
        draft = logic.draft_listing("Acme", "dog lick mat",
                                    "Stays put: four suction cups grip any smooth floor\nEasy to clean: dishwasher safe silicone\n"
                                    "Calms pets: licking lowers stress at bath time\nFood safe: BPA-free silicone\nTwo sizes: fits bowls and crates",
                                    "slow feeder, anxiety relief, peanut butter mat, dog lick mat")
        self.assertTrue(draft["title"].startswith("Acme Dog Lick Mat"))
        self.assertNotIn("lick", draft["search_terms"].split())
        errors = [i for i in logic.validate_listing({**draft, "brand": "Acme"}) if i["level"] == "error"]
        self.assertEqual(errors, [])


class Additions(unittest.TestCase):
    def test_currency_and_price_breaks(self):
        quote = {"unit_cost": 20, "fx_rate": 0.14, "duty_pct": 10, "freight_per_unit": 1, "price_breaks": "1000: 18, 500:19, junk"}
        self.assertEqual(logic.landed_cost(quote), 4.08)
        self.assertEqual([t["quantity"] for t in logic.price_breaks(quote)], [500, 1000])
        self.assertEqual(logic.landed_cost({"unit_cost": 3}), 3)  # quotes saved before currency existed

    def test_score_weights_change_ranking_and_total_100(self):
        product = {"price": 30, "monthly_sales": 400, "reviews": 3000, "rating": 4.7, "weight_lb": 5}
        eco = logic.unit_economics(product, None, SETTINGS)
        default = logic.opportunity_score(product, eco, SETTINGS)
        demand_only = logic.opportunity_score(product, eco, {**SETTINGS, "w_competition": "0", "w_rating": "0", "w_size": "0", "w_margin": "0", "w_price": "0"})
        self.assertEqual(round(sum(default["weights"].values())), 100)
        self.assertEqual(demand_only["score"], 100)
        self.assertLess(default["score"], 60)

    def test_keyword_priority_order(self):
        self.assertGreater(logic.keyword_priority(12000, 300), logic.keyword_priority(12000, 30000))
        self.assertGreater(logic.keyword_priority(12000, 300), logic.keyword_priority(300, 300))

    def test_review_themes(self):
        result = logic.analyze_reviews("Broke after a week, flimsy plastic.\nLove it, works great every day\nFlimsy plastic and it leaks everywhere")
        themes = {t["theme"]: t["count"] for t in result["themes"]}
        self.assertEqual(result["review_count"], 3)
        self.assertEqual(themes["Cheap or flimsy feel"], 2)
        self.assertEqual(themes["Leaks"], 1)
        self.assertIn({"phrase": "flimsy plastic", "count": 2}, result["phrases"])
        self.assertEqual(logic.analyze_reviews("")["review_count"], 0)

    def test_xlsx_is_a_valid_zip_with_escaped_text(self):
        import io, zipfile, xlsx
        data = xlsx.workbook(["A & B"], [["<x>", 1.5, None]])
        sheet = zipfile.ZipFile(io.BytesIO(data)).read("xl/worksheets/sheet1.xml").decode()
        self.assertIn("&lt;x&gt;", sheet)
        self.assertIn("<v>1.5</v>", sheet)


class Csv(unittest.TestCase):
    def test_header_aliases_and_number_cleanup(self):
        rows, fields = logic.parse_csv('﻿Title,Review Count,Price,Junk\n"Mat, large",1,"$1,234.50",x\n', logic.PRODUCT_ALIASES)
        self.assertEqual(fields, ["name", "price", "reviews"])
        self.assertEqual(rows[0]["name"], "Mat, large")
        self.assertEqual(logic.num(rows[0]["price"]), 1234.5)


if __name__ == "__main__":
    unittest.main()
