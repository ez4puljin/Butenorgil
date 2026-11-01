"""Дарагдсан барааны тайлан (app/services/blocked_goods) — erxes-ийг mock хийнэ."""
from datetime import date

import pytest

from app.services import blocked_goods as bg

DEPS = {"d01": {"code": "Buunii.aguulah", "title": "Мөрөн - Бөөний агуулах"},
        "d11": {"code": "Jijiglen.aguulah", "title": "Мөрөн - Жижиглэн агуулах"},
        "dX": {"code": "Non.departments", "title": "Байршилгүй бараа"}}
NAMES = {"01": "Бөөний агуулах", "11": "Жижиглэн барааны агуулах"}


def line(pid, code, qty, tick, dep="d01", amount=None):
    return {"productId": pid, "quantity": qty, "unitPrice": 1000, "amount": qty * 1000 if amount is None else amount,
            "tickUsed": tick, "departmentId": dep, "product": {"code": code, "name": f"Бараа {code}"}}


MORE = {"product": {"name": "...More"}}
DEAL = {"_id": "D1", "number": "2026/10/30-0063", "name": "Саруулбуян", "createdAt": "2026-10-30T02:00:00.000Z",
        "status": "active", "stage": {"name": "Архивлах"}}


def test_truncated_marker():
    assert bg.truncated([line("p1", "101", 1, True), MORE])
    assert not bg.truncated([line("p1", "101", 1, True)])
    assert not bg.truncated(None)


def test_deal_lines_maps_department_and_skips_used():
    prods = [line("p1", "101", 5, True), line("p2", "102", 3, False), line("p3", "103", 2, False, dep="d11"),
             line("p4", "104", 1, False, dep=""), line("p5", "105", 4, False, dep="dX"), MORE]
    out = {x["code"]: x for x in bg.deal_lines(DEAL, prods, "Мөрөн Борлуулалт", DEPS, NAMES)}
    assert set(out) == {"102", "103", "104", "105"}                    # tickUsed=true, «...More» орохгүй
    assert (out["102"]["location"], out["102"]["location_name"], out["102"]["qty"]) == ("01", "Бөөний агуулах", 3)
    assert out["103"]["location"] == "11"
    # department-гүй мөр → deal-ийн давамгай агуулах (d01: 2 мөр)
    assert (out["104"]["location"], out["104"]["dept_inferred"]) == ("01", True)
    # Эрхэтийн байршилгүй department → өөрийн нэрээр тусдаа бүлэг
    assert (out["105"]["location"], out["105"]["location_name"]) == ("", "Байршилгүй бараа")
    assert (out["102"]["number"], out["102"]["deal_name"], out["102"]["stage"]) == ("2026/10/30-0063", "Саруулбуян", "Архивлах")


def test_aggregate_sums_per_location_and_product():
    a = bg.deal_lines(DEAL, [line("p2", "102", 3, False), line("p2", "102", 2, False)], "P", DEPS, NAMES)
    b = bg.deal_lines({**DEAL, "_id": "D2", "number": "2026/10/30-0070", "name": "Өнөр"},
                      [line("p2", "102", 4, False), line("p3", "103", 1, False, dep="d11"),
                       line("p5", "105", 1, False, dep="dX")], "P", DEPS, NAMES)
    items = bg.aggregate(a + b)
    assert [(i["location"], i["code"]) for i in items] == [("01", "102"), ("11", "103"), ("", "105")]   # тодорхойгүй нь сүүлд
    it = items[0]
    assert (it["qty"], it["amount"]) == (9, 9000)
    assert it["deals"] == [{"number": "2026/10/30-0063", "name": "Саруулбуян", "qty": 5},
                           {"number": "2026/10/30-0070", "name": "Өнөр", "qty": 4}]   # нэг deal-ийн 2 мөр нийлнэ
    r = bg.build(date(2026, 10, 30), a + b, n_deals=7, errors={}, seconds=1.0)
    assert (r["count"], r["deals"], r["deals_blocked"], r["amount"]) == (3, 7, 2, 11000)
    assert [(x["key"], x["count"]) for x in r["locations"]] == [("01", 1), ("11", 1), ("Байршилгүй бараа", 1)]


@pytest.fixture
def fake_erxes(monkeypatch):
    calls = []
    deals = {
        "P1": [DEAL | {"products": [line("p1", "101", 1, True)] * 10 + [MORE]},
               DEAL | {"_id": "D9", "number": "2026/10/31-0001", "createdAt": "2026-10-30T16:00:00.000Z",
                       "products": [line("p9", "109", 1, False)]}],          # дараагийн өдөр (UB) — хасагдана
        "P2": [DEAL | {"_id": "D3", "number": "2026/10/30-0002", "products": [line("p3", "103", 2, False, dep="d11")]}],
    }

    def gql(q, v=None, tries=3):
        calls.append((q, v))
        if "departments" in q:
            return {"departments": [{"_id": k, **d} for k, d in DEPS.items()]}
        if "salesBoards" in q:
            return {"salesBoards": [{"_id": "B", "name": "Хөвсгөл",
                                     "pipelines": [{"_id": "P1", "name": "Мөрөн Борлуулалт"},
                                                   {"_id": "P2", "name": "Заал хөдөлгөөн"}]}]}
        if "dealDetail" in q:
            assert v == {"id": "D1"}
            return {"dealDetail": {"products": [line("p1", "101", 1, True)] * 10 + [line("p7", "107", 6, False)]}}
        return {"deals": deals[v["p"]] if v["s"] == 0 else []}

    monkeypatch.setattr(bg, "_gql", gql)
    monkeypatch.setattr(bg, "location_names", lambda: NAMES)
    monkeypatch.setattr(bg, "_meta", {"at": 0.0, "deps": {}, "pipes": []})
    monkeypatch.setattr(bg, "_cache", {})
    return calls


def test_fetch_day_reads_full_detail_for_truncated_deals(fake_erxes):
    r = bg.fetch_day(date(2026, 10, 30))
    assert {(i["location"], i["code"], i["qty"]) for i in r["items"]} == {("01", "107", 6), ("11", "103", 2)}
    assert r["deals"] == 2 and r["errors"] == {}                       # 10-31-ний deal тоологдохгүй
    q = next(q for q, _ in fake_erxes if "dateRangeFilters" in q)
    # Улаанбаатарын өдөр = UTC өмнөх өдрийн 16:00 → 16:00
    assert 'from: "2026-10-29T16:00:00.000Z", to: "2026-10-30T16:00:00.000Z"' in q
    assert sum("dealDetail" in q for q, _ in fake_erxes) == 1          # зөвхөн таслагдсан deal-д


def test_get_caches_per_day(fake_erxes):
    bg.get(date(2026, 10, 30))
    n = len(fake_erxes)
    bg.get(date(2026, 10, 30))
    assert len(fake_erxes) == n                                        # кэшээс
    bg._cache["2026-10-30"] = (bg._cache["2026-10-30"][0] - 60, bg._cache["2026-10-30"][1])
    bg.get(date(2026, 10, 30), refresh=True)
    assert len(fake_erxes) > n                                         # «Шинэчлэх» дахин татна
