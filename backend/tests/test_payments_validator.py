# -*- coding: utf-8 -*-
"""paymentsData validator — 2026-10-ийн бодит тохиолдлууд. Ажиллуулах:
   cd backend && .venv\\Scripts\\python.exe -m unittest tests.test_payments_validator -v"""
import unittest

from app.services.payments_validator import validate_payments_data as V


def codes(r):
    return sorted((i["code"], i["key"]) for i in r["issues"])


class ValidatorTest(unittest.TestCase):
    def test_total_amount_number(self):
        r = V({"totalAmount": 1602750}, ["other"])
        self.assertFalse(r["ok"])
        self.assertEqual(codes(r), [("UNKNOWN_TYPE", "totalAmount"), ("VALUE_NOT_OBJECT", "totalAmount")])

    def test_total_and_cart(self):
        r = V({"totalAmount": 1875150, "cartAmount": 1875150}, ["other"])
        self.assertFalse(r["ok"])
        self.assertEqual(codes(r), [("UNKNOWN_TYPE", "cartAmount"), ("UNKNOWN_TYPE", "totalAmount"),
                                    ("VALUE_NOT_OBJECT", "cartAmount"), ("VALUE_NOT_OBJECT", "totalAmount")])

    def test_other_ok(self):
        self.assertEqual(V({"other": {"amount": 2370480, "currency": "MNT"}}, ["other"]), {"ok": True, "issues": []})

    def test_empty_and_null(self):
        self.assertTrue(V({}, ["other"])["ok"])
        self.assertTrue(V(None, ["other"])["ok"])
        self.assertTrue(V("", ["other"])["ok"])

    def test_string_amount_no_currency(self):
        r = V({"other": {"amount": "2370480"}}, ["other"])
        self.assertFalse(r["ok"])
        self.assertEqual(codes(r), [("BAD_AMOUNT", "other"), ("BAD_CURRENCY", "other")])

    def test_not_object(self):
        for pd in (5, [1, 2], "abc"):
            self.assertEqual([i["code"] for i in V(pd, ["other"])["issues"]], ["NOT_OBJECT"])

    def test_json_string_input(self):
        self.assertFalse(V('{"totalAmount": 1602750}', ["other"])["ok"])

    def test_negative_nan(self):
        self.assertEqual(codes(V({"other": {"amount": -1, "currency": "MNT"}}, ["other"])), [("BAD_AMOUNT", "other")])
        self.assertEqual(codes(V({"other": {"amount": float("nan"), "currency": "MNT"}}, ["other"])), [("BAD_AMOUNT", "other")])

    def test_sum_exceeds_total_is_warning(self):
        # 2370480 > 2338080 — syncerkhet paymentsData-ийн дүнг ашигладаггүй тул зөвхөн анхааруулга
        r = V({"other": {"amount": 2370480, "currency": "MNT"}}, ["other"], deal_total=2338080)
        self.assertTrue(r["ok"])
        self.assertEqual([i["code"] for i in r["issues"]], ["SUM_EXCEEDS_TOTAL"])


if __name__ == "__main__":
    unittest.main()
