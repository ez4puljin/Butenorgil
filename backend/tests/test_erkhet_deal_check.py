# -*- coding: utf-8 -*-
"""Erkhet sync шалгалтын статус ангилал — 2026-10-ийн бодит тохиолдлууд. Ажиллуулах:
   cd backend && .venv\\Scripts\\python.exe -m unittest tests.test_erkhet_deal_check -v"""
import json
import unittest

from app.services.erkhet_deal_check import classify, default_category, parse_history, ub_range

CREATED = "2026-10-12T03:00:00.000Z"          # УБ 2026-10-12


def hist(order: dict, resp, error=None, at="2026-10-12T05:00:00Z"):
    payload = {"userEmail": "x@bto.mn", "apiKey": "SECRET", "apiSecret": "SECRET",
               "orderInfos": json.dumps([{"orderId": "D1", "date": "2026-10-12", "number": "2026/10/12-0112",
                                          "customerCode": "11831", **order}])}
    return parse_history({"_id": "h", "createdAt": at, "error": error,
                          "sendData": {"action": "x", "payload": json.dumps(payload)},
                          "responseData": json.dumps(resp) if resp is not None else None}, "D1")


def resp(code, amount, success=True):
    return {"ebarimt": {"payments": [{"code": code, "paidAmount": amount}], "totalAmount": amount,
                        "date": "2026-10-12"}, "success": success, "error": ""}


SYNCED = {"isSynced": True, "syncedDate": "2026-10-12T00:00:00.000Z"}


class ClassifyTest(unittest.TestCase):
    def test_bad_payments_undefined_cash(self):
        h = hist({"undefined": None, "details": [{"amount": 1602750, "discount": 0}]}, resp("CASH", 1602750))
        r = classify(category="expected", payments_data={"totalAmount": 1602750}, deal_amount=1602750,
                     created_at=CREATED, check=SYNCED, hists=[h])
        self.assertIn("BAD_PAYMENTS", r["statuses"])
        self.assertIn("CASH", r["statuses"])
        self.assertEqual(r["severity"], "error")
        self.assertEqual(r["pay_label"], "undefined")

    def test_ok_with_payments_amount_diff(self):
        h = hist({"debtAmount": 2338080}, resp("PAYMENT_CARD", 2338080))
        r = classify(category="expected", payments_data={"other": {"amount": 2370480, "currency": "MNT"}},
                     deal_amount=None, created_at=CREATED, check=SYNCED, hists=[h])
        self.assertEqual(r["statuses"][0], "OK")
        self.assertIn("PAYMENTS_DIFF", r["statuses"])       # deal/илгээсэн/Эрхэт таарсан — зөвхөн paymentsData
        self.assertEqual(r["severity"], "info")

    def test_amount_diff_core(self):
        h = hist({"debtAmount": 5384830}, resp("PAYMENT_CARD", 5651950))
        r = classify(category="expected", payments_data={}, deal_amount=5384830, created_at=CREATED,
                     check=SYNCED, hists=[h])
        self.assertIn("AMOUNT_DIFF", r["statuses"])

    def test_timeout_after_cash_keeps_cash(self):
        """2026/10/17-0019: CASH баримт → debtAmount sync timedout → Эрхэт дээр бэлэн хэвээр."""
        h1 = hist({}, resp("CASH", 42000), at="2026-10-12T06:36:00Z")
        h2 = hist({"debtAmount": 42000}, {"error": "timedout"}, at="2026-10-12T06:39:00Z")
        r = classify(category="expected", payments_data={}, deal_amount=42000, created_at=CREATED,
                     check=SYNCED, hists=[h1, h2])
        self.assertIn("CASH", r["statuses"])
        self.assertIn("SYNC_ERROR", r["statuses"])
        self.assertEqual(r["severity"], "error")

    def test_no_response(self):
        h = hist({"debtAmount": 100000}, None)
        r = classify(category="expected", payments_data={}, deal_amount=100000, created_at=CREATED,
                     check=SYNCED, hists=[h])
        self.assertIn("NO_RESPONSE", r["statuses"])
        self.assertNotIn("OK", r["statuses"])

    def test_pending_cash_is_info(self):
        h = hist({}, resp("CASH", 50000))
        r = classify(category=default_category("Бэлдэж буй захиалга"), payments_data={}, deal_amount=50000,
                     created_at=CREATED, check=SYNCED, hists=[h])
        self.assertEqual(r["statuses"], ["CASH"])
        self.assertEqual(r["severity"], "info")

    def test_cancel_in_erkhet(self):
        h = hist({"debtAmount": 50000}, resp("PAYMENT_CARD", 50000))
        r = classify(category=default_category("Захиалга хадгалах/устгах"), payments_data={}, deal_amount=50000,
                     created_at=CREATED, check=SYNCED, hists=[h])
        self.assertIn("CANCEL_IN_ERKHET", r["statuses"])

    def test_not_in_erkhet(self):
        r = classify(category="expected", payments_data={}, deal_amount=1, created_at=CREATED,
                     check={"isSynced": False}, hists=[])
        self.assertEqual(r["statuses"], ["NOT_IN_ERKHET"])
        self.assertEqual(r["severity"], "error")

    def test_last_sync_wins(self):
        """Эхлээд бэлдэх config-оор CASH, дараа нь «Баримт хэвлэх»-ээр debtAmount → OK (2026/10/20-0037)."""
        h1 = hist({}, resp("CASH", 350150), at="2026-10-12T06:00:00Z")
        h2 = hist({"debtAmount": 350150}, resp("PAYMENT_CARD", 350150), at="2026-10-12T08:00:00Z")
        r = classify(category="expected", payments_data={"other": {"amount": 350150}}, deal_amount=350150,
                     created_at=CREATED, check=SYNCED, hists=[h1, h2])
        self.assertEqual(r["statuses"], ["OK"])

    def test_date_mismatch(self):
        h = hist({"debtAmount": 1000, "date": "2026-10-14"}, resp("PAYMENT_CARD", 1000))
        r = classify(category="expected", payments_data={}, deal_amount=1000, created_at=CREATED,
                     check={"isSynced": True, "syncedDate": "2026-10-14T00:00:00.000Z"}, hists=[h],
                     start="2026-10-12", end="2026-10-13")
        self.assertIn("DATE_MISMATCH", r["statuses"])

    def test_secrets_scrubbed(self):
        h = hist({"debtAmount": 1}, resp("PAYMENT_CARD", 1))
        self.assertNotIn("SECRET", json.dumps(h))

    def test_stage_names(self):
        self.assertEqual(default_category("XТ захиалга"), "pending")       # латин X
        self.assertEqual(default_category("Баримт хэвлэх"), "expected")
        self.assertEqual(default_category("Устгах"), "cancel")

    def test_ub_range(self):
        a, b = ub_range("2026-10-15", "2026-10-15")
        self.assertEqual(a.isoformat(), "2026-10-14T16:00:00+00:00")
        self.assertEqual(b.isoformat(), "2026-10-15T16:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
