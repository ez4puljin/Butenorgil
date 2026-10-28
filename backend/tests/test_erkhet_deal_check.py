# -*- coding: utf-8 -*-
"""Erkhet sync шалгалтын статус ангилал — 2026-10-ийн бодит тохиолдлууд. Ажиллуулах:
   cd backend && .venv\\Scripts\\python.exe -m unittest tests.test_erkhet_deal_check -v"""
import json
import unittest

from app.services.erkhet_deal_check import (classify, compare_erkhet, deal_items, debit_accounts, default_category,
                                            parse_history, ub_range)

CREATED = "2026-10-12T03:00:00.000Z"          # УБ 2026-10-12
CODES = {"p1": "102069", "p2": "102072", "p3": "102099"}
PRODS = [{"productId": "p1", "quantity": 6, "amount": 108000, "tickUsed": True},
         {"productId": "p2", "quantity": 6, "amount": 84000, "tickUsed": True},
         {"productId": "p3", "quantity": 2, "amount": 44000, "tickUsed": False}]


def line(code, qty, total, tr=13477348, kind=-29, acc="кт:311004, дт:120101"):
    return {"kind": kind, "tr_id": tr, "date": "2026-10-12", "code": code, "name": code, "qty": qty,
            "total": total, "accounts": acc}


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

    # ── Эрхэтийн бодит баримттай тулгах (compare_erkhet) ──────────────────────
    def test_sale_matches_erkhet(self):
        items = deal_items(PRODS, CODES)
        self.assertEqual(set(items), {"102069", "102072"})             # tickUsed=false хасагдсан
        erk = compare_erkhet("sale", items, 192000, [line("102069", 6, 108000), line("102072", 6, 84000)])
        self.assertEqual(erk["statuses"], [])
        r = classify(category="expected", payments_data={"other": {"amount": 236000}}, deal_amount=192000,
                     created_at=CREATED, check=SYNCED, hists=[hist({"debtAmount": 192000}, resp("PAYMENT_CARD", 192000))],
                     erk=erk)
        self.assertEqual(r["statuses"], ["OK"])                          # paymentsData хуучирсан ч асуудалгүй
        self.assertEqual(r["amounts"]["erkhet"], 192000)

    def test_sale_amount_and_item_diff(self):
        """Deal-ээс бараа хассан (tickUsed=false) ч Эрхэтэд хуучнаараа үлдсэн."""
        items = deal_items(PRODS, CODES)
        erk = compare_erkhet("sale", items, 192000, [line("102069", 6, 108000), line("102072", 6, 84000),
                                                     line("102099", 2, 44000)])
        self.assertIn("SALES_AMOUNT_DIFF", erk["statuses"])
        self.assertIn("ITEMS_DIFF", erk["statuses"])
        self.assertEqual(erk["diff"][0]["code"], "102099")
        r = classify(category="expected", payments_data={}, deal_amount=192000, created_at=CREATED, check=SYNCED,
                     hists=[], erk=erk)
        self.assertEqual(r["severity"], "error")
        self.assertNotIn("OK", r["statuses"])

    def test_sale_qty_diff_same_total(self):
        erk = compare_erkhet("sale", {"A": {"qty": 2, "amount": 100}}, 100, [line("A", 1, 100)])
        self.assertEqual(erk["statuses"], ["ITEMS_DIFF"])

    def test_sale_no_receivable(self):
        erk = compare_erkhet("sale", {"A": {"qty": 1, "amount": 100}}, 100, [line("A", 1, 100, acc="")])
        self.assertEqual(erk["statuses"], ["CASH"])
        r = classify(category="expected", payments_data={}, deal_amount=100, created_at=CREATED, check=SYNCED,
                     hists=[], erk=erk)
        self.assertEqual(r["status_sev"]["CASH"], "error")

    def test_duplicate(self):
        erk = compare_erkhet("sale", {"A": {"qty": 1, "amount": 100}}, 100,
                             [line("A", 1, 100, tr=1), line("A", 1, 100, tr=2)])
        self.assertEqual(erk["statuses"], ["DUPLICATE"])                 # сүүлийнх нь таарч байгаа
        self.assertEqual(len(erk["docs"]), 2)

    def test_move_qty_only(self):
        """Хөдөлгөөн: Эрхэт өртгөөр (үнэ 0) — зөвхөн тоо; авлага шаардахгүй; paymentsData хамаагүй."""
        items = {"923040": {"qty": 50, "amount": 250000}}
        ok = compare_erkhet("move", items, 250000, [line("923040", 50, 0, kind=-5, acc="")])
        self.assertEqual(ok["statuses"], [])
        r = classify(category="expected", payments_data={"totalAmount": 1}, deal_amount=250000, created_at=CREATED,
                     check=SYNCED, hists=[hist({}, resp("CASH", 0))], kind="move", erk=ok)
        self.assertEqual(r["statuses"], ["OK"])
        bad = compare_erkhet("move", items, 250000, [line("923040", 40, 0, kind=-5, acc="")])
        self.assertEqual(bad["statuses"], ["ITEMS_DIFF"])

    def test_wrong_kind_and_missing(self):
        erk = compare_erkhet("sale", {"A": {"qty": 1, "amount": 100}}, 100, [line("A", 1, 0, kind=-5)])
        self.assertIn("WRONG_KIND", erk["statuses"])
        r = classify(category="expected", payments_data={}, deal_amount=100, created_at=CREATED, check=SYNCED,
                     hists=[], erk=erk)
        self.assertIn("NOT_IN_ERKHET", r["statuses"])

    def test_pending_cash_info_but_amount_diff_warn(self):
        """2026/10/28-0042: бэлдэж буй deal-ээс бараа хассан — Эрхэтэд 676,390 хэвээр, deal 632,390."""
        erk = compare_erkhet("sale", {"A": {"qty": 1, "amount": 100}}, 100, [line("A", 1, 100, acc="")])
        r = classify(category="pending", payments_data={}, deal_amount=100, created_at=CREATED, check=SYNCED,
                     hists=[hist({}, resp("CASH", 100))], erk=erk)
        self.assertEqual(r["severity"], "info")
        erk = compare_erkhet("sale", {"A": {"qty": 1, "amount": 100}}, 100,
                             [line("A", 1, 100, acc=""), line("B", 20, 44000, acc="")])
        r = classify(category="pending", payments_data={}, deal_amount=100, created_at=CREATED, check=SYNCED,
                     hists=[hist({}, resp("CASH", 44100))], erk=erk)
        self.assertEqual(r["status_sev"]["SALES_AMOUNT_DIFF"], "warn")
        self.assertEqual(r["status_sev"]["CASH"], "info")

    def test_debit_accounts(self):
        self.assertEqual(debit_accounts("кт:311004, дт:120101"), {"120101"})
        self.assertEqual(debit_accounts(""), set())

    def test_ub_range(self):
        a, b = ub_range("2026-10-15", "2026-10-15")
        self.assertEqual(a.isoformat(), "2026-10-14T16:00:00+00:00")
        self.assertEqual(b.isoformat(), "2026-10-15T16:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
