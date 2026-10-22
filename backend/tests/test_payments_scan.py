# -*- coding: utf-8 -*-
"""Erxes ↔ Erkhet дүнгийн тулгалт — 2026-10-ийн бодит тохиолдлууд. Ажиллуулах:
   cd backend && .venv\\Scripts\\python.exe -m unittest tests.test_payments_scan -v"""
import json
import unittest

from app.services.erkhet_deal_check import parse_history
from app.services.payments_scan import analyze_amounts, assess


def hist(details, resp, debt=None, undefined=False, at="2026-10-21T07:25:53Z", date="2026-10-21"):
    o = {"orderId": "D1", "date": date, "number": "2026/10/21-0055", "hasVat": True, "details": details}
    if debt is not None:
        o["debtAmount"] = debt
    if undefined:
        o["undefined"] = None
    payload = {"userEmail": "x@bto.mn", "apiKey": "S", "orderInfos": json.dumps([o])}
    return parse_history({"_id": at, "createdAt": at, "sendData": {"payload": json.dumps(payload)},
                          "responseData": json.dumps(resp) if resp is not None else None}, "D1")


def ok_resp(code, total):
    return {"success": True, "ebarimt": {"totalAmount": total, "date": "2026-10-21",
                                         "payments": [{"code": code, "paidAmount": total}]}}


def prod(code, qty, price, discount=0, tick=True):
    return {"tickUsed": tick, "quantity": qty, "unitPrice": price, "discount": discount,
            "amount": qty * price - discount, "product": {"code": code, "name": f"P{code}"}}


class AmountTest(unittest.TestCase):
    def test_0055_mismatch_and_no_response(self):
        # Erxes 2,498,320; Erkhet-ийн сүүлийн баталгаатай 2,581,720; дараагийн sync timedout
        hs = [hist([{"inventoryCode": "1", "count": 1, "amount": 2581720}], ok_resp("PAYMENT_CARD", 2581720), debt=2581720),
              hist([{"inventoryCode": "1", "count": 1, "amount": 2498320}], {"error": "timedout"}, debt=2498320,
                   at="2026-10-21T07:26:46Z")]
        r = analyze_amounts(deal_amount={"MNT": 2498320}, products=[prod("1", 1, 2498320)],
                            modified_at="2026-10-21T07:26:00Z", hists=hs)
        self.assertIn("AMOUNT_MISMATCH", r["issues"])
        self.assertIn("ERKHET_NO_RESPONSE", r["issues"])
        self.assertEqual(r["amount_diff"], 83400)          # Erkhet − Erxes
        self.assertEqual(r["erkhet_payment"], "PAYMENT_CARD")

    def test_0005_cash(self):
        hs = [hist([{"inventoryCode": "1", "count": 1, "amount": 5049000}], ok_resp("CASH", 5049000)),
              hist([], None, debt=4921800, at="2026-10-21T06:04:30Z")]
        r = analyze_amounts(deal_amount={"MNT": 4921800}, products=[prod("1", 1, 4921800)],
                            modified_at="2026-10-21T10:54:41Z", hists=hs)
        for c in ("AMOUNT_MISMATCH", "ERKHET_CASH", "ERKHET_NO_RESPONSE", "CHANGED_AFTER_SYNC"):
            self.assertIn(c, r["issues"])
        self.assertEqual(r["erkhet_payment"], "CASH")

    def test_103038_item_mismatch(self):
        # Сэрүүн Пиво 2.4л: Erxes 6×9,200, Erkhet рүү 6×8,800 явсан → 635,700 / 638,100 биш ч мөр зөрнө
        hs = [hist([{"inventoryCode": "103038", "count": 6, "amount": 52800},
                    {"inventoryCode": "2", "count": 1, "amount": 585300}], ok_resp("PAYMENT_CARD", 638100), debt=638100)]
        r = analyze_amounts(deal_amount={"MNT": 640500}, products=[prod("103038", 6, 9200), prod("2", 1, 585300)],
                            modified_at="2026-10-20T00:00:00Z", hists=hs)
        self.assertIn("AMOUNT_MISMATCH", r["issues"])
        self.assertIn("ITEM_MISMATCH", r["issues"])
        bad = [i for i in r["items"] if i["mismatch"]]
        self.assertEqual([i["code"] for i in bad], ["103038"])
        self.assertEqual(bad[0]["diff"], -2400)

    def test_code_changed_after_sync_is_not_mismatch(self):
        # 2026/10/19-0053: erxes 214002 ↔ илгээсэн 214103, 1 × 77,650
        hs = [hist([{"inventoryCode": "214103", "count": 1, "amount": 77650}], ok_resp("PAYMENT_CARD", 77650), debt=77650)]
        r = analyze_amounts(deal_amount={"MNT": 77650}, products=[prod("214002", 1, 77650)],
                            modified_at="2026-10-19T00:00:00Z", hists=hs)
        self.assertEqual(r["issues"], [])
        self.assertEqual(r["items"][0]["sent_code"], "214103")

    def test_discount_net_amount_ok(self):
        # 2026/10/19-0007: details.amount нь хямдралын ДАРААХ — Σamount 600,000 = Erkhet
        hs = [hist([{"inventoryCode": "a", "count": 60, "amount": 528000, "discount": 24000},
                    {"inventoryCode": "b", "count": 1, "amount": 72000, "discount": 0}],
                   ok_resp("PAYMENT_CARD", 600000), debt=600000)]
        r = analyze_amounts(deal_amount={"MNT": 600000}, products=[prod("a", 60, 9200, 24000), prod("b", 1, 72000)],
                            modified_at="2026-10-19T00:00:00Z", hists=hs)
        self.assertEqual(r["issues"], [])
        self.assertEqual(r["sent_amount"], 600000)

    def test_payments_sum_differs_is_not_amount_mismatch(self):
        hs = [hist([{"inventoryCode": "1", "count": 1, "amount": 2338080}], ok_resp("PAYMENT_CARD", 2338080), debt=2338080)]
        r = assess(category="expected", payments_data={"other": {"amount": 2370480, "currency": "MNT"}},
                   allowed=["other"], deal_amount={"MNT": 2338080}, products=[prod("1", 1, 2338080)],
                   modified_at="2026-10-01T00:00:00Z", hists=hs)
        self.assertNotIn("AMOUNT_MISMATCH", r["issues"])
        self.assertIn("SUM_EXCEEDS_TOTAL", r["issues"])
        self.assertEqual(r["severity"], "warn")

    def test_old_undefined_but_last_ok(self):
        hs = [hist([{"inventoryCode": "1", "count": 1, "amount": 100}], ok_resp("CASH", 100), undefined=True,
                   at="2026-10-12T01:00:00Z"),
              hist([{"inventoryCode": "1", "count": 1, "amount": 100}], ok_resp("PAYMENT_CARD", 100), debt=100)]
        r = assess(category="expected", payments_data={}, allowed=["other"], deal_amount={"MNT": 100},
                   products=[prod("1", 1, 100)], modified_at="2026-10-12T00:00:00Z", hists=hs)
        self.assertEqual(r["issues"], [])
        self.assertEqual(r["severity"], "ok")

    def test_bad_payments_pending_stage(self):
        r = assess(category="pending", payments_data={"totalAmount": 1602750}, allowed=["other"],
                   deal_amount={"MNT": 1602750}, products=[prod("1", 1, 1602750)], modified_at=None, hists=[])
        self.assertEqual(r["severity"], "error")              # paymentsData алдаа аль ч шатанд error
        self.assertIn("NO_SYNC", r["issues"])


if __name__ == "__main__":
    unittest.main()
