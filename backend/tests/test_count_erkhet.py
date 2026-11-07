"""Тооллого → Эрхэтийн орлого/зарлага импорт (app/services/count_erkhet) — Эрхэт, Excel-ийг mock хийнэ."""
from datetime import date

import pytest
from python_calamine import CalamineWorkbook

from app.services import conversion, count_erkhet as ce, erkhet_client, erkhet_xlsx


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setattr(ce, "locations", lambda: [{"code": c, "name": n, "id": ""} for c, n in ce.FALLBACK_LOCATIONS])
    monkeypatch.setattr(erkhet_xlsx, "excel_resave_shortdate", lambda data, date_col="A": data)


def cmp(code, diff, price, name=""):
    return {"code": code, "name": name or f"Бараа {code}", "brand": "", "diff": diff, "price": price}


def test_parse_cost_rows_skips_headers_and_fixes_bad_cost():
    def row(*v):
        return {f"col{i}": x for i, x in enumerate(v)}
    rows = [
        row("150101", "Бэлэн бүтээгдэхүүн, бараа", "", "", "", "", "", "", "", "", ""),
        row("03", "Заал", "", "", "", "", "", "", "", "", ""),
        row("101001", "Дарс", "-2.00", "-0.00", "0", "0", "0", "0", "-2.00", "-0.00", "0.00"),   # өртөггүй
        row("105101", "Энерги", "31", "14,700.00", "0", "0", "0", "0", "31", "14,700.00", "474.19"),
        row("106131", "Милкис", "0", "0", "300", "435,000", "0", "0", "300", "435,000.00", "0"),   # дүн ÷ тоо
        row("td_1", "Сөрөг", "1", "-5", "0", "0", "0", "0", "1", "-5", "-5"),
    ]
    assert ce.parse_cost_rows(rows) == {"105101": 474.19, "106131": 1450.0}


def test_priced_rows_picks_first_sane_source():
    rows = [cmp("A", 5, 3500), cmp("B", -2, 4540), cmp("C", 1, 2500), cmp("D", -4, 7100), cmp("E", 0, 1000)]
    costs = {"A": 934237.72, "B": 2.03, "C": 2100}                 # A, B гажуудсан байршлын өртөг
    wh = {"A": 3150, "B": 3620}
    lpp = {"D": 0.0}
    out = {r["code"]: r for r in ce.priced_rows(None, rows, costs, "cost", lpp=lpp, wh=wh)}
    assert set(out) == {"A", "B", "C", "D"}                         # зөрүүгүй E орохгүй
    assert (out["A"]["price"], out["A"]["price_src"], out["A"]["kind"]) == (3150, "warehouse", "income")
    assert (out["C"]["price"], out["C"]["price_src"]) == (2100, "erkhet")
    # дутагдал (байнгын борлуулалт) — өртөг байсан ч зарах үнээр, шалгах биш
    assert (out["B"]["price"], out["B"]["price_src"], out["B"]["kind"], out["B"]["qty"], out["B"]["review"]) == \
        (4540, "sell", "expense", 2, False)
    assert (out["D"]["price"], out["D"]["price_src"], out["D"]["review"]) == (7100, "sell", False)
    sell = {r["code"]: r for r in ce.priced_rows(None, rows, costs, "sell", lpp=lpp, wh=wh)}
    assert all(r["price_src"] == "sell" and not r["review"] for r in sell.values())
    assert sell["A"]["price"] == 3500


def test_income_without_sane_cost_is_review():
    out = ce.priced_rows(None, [cmp("X", 4, 7100)], {"X": 526274.67}, "cost", lpp={"X": 0.0}, wh={})
    assert (out[0]["price"], out[0]["price_src"], out[0]["review"]) == (7100, "sell", True)


def test_preview_counts_and_skips_unpriced():
    rows = ce.priced_rows(None, [cmp("A", 3, 1000), cmp("B", 2, 0), cmp("C", -1.5, 400)], {"A": 900}, "cost", lpp={}, wh={})
    pv = ce.preview(rows)
    assert (pv["income"]["rows"], pv["income"]["pieces"], pv["income"]["amount"]) == (1, 3, 2700)
    assert [r["code"] for r in pv["income"]["skipped"]] == ["B"]        # үнэгүй — орлогод оруулахгүй
    assert (pv["expense"]["rows"], pv["expense"]["pieces"], pv["expense"]["amount"]) == (1, 1.5, 600)
    assert pv["expense"]["by_src"]["sell"] == 1 and pv["expense"]["review"] == []


def _sheet(data):
    import os
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".xlsx")
    os.write(fd, data)
    os.close(fd)
    wb = CalamineWorkbook.from_path(path)
    out = {n: wb.get_sheet_by_name(n).to_python() for n in wb.sheet_names}
    os.unlink(path)
    return out


SET = {"customer": "60018", "related_account": "313011", "account": "150101"}


def test_income_file_layout():
    rows = ce.priced_rows(None, [cmp("101", 42, 9000), cmp("102", 97, 1500), cmp("103", -3, 100)],
                          {"101": 8600, "102": 1319.39}, "cost", lpp={}, wh={})
    data, fname, stats = ce.build_xlsx(rows, kind="income", day=date(2026, 10, 31), loc_code="03", count_id=7, **SET)
    assert fname == "20261031_toollogo7_03_orlogo.xlsx"
    assert stats == {"rows": 2, "skipped": 0, "pieces": 139, "amount": round(42 * 8600 + 97 * 1319.39, 2)}
    sh = _sheet(data)
    assert list(sh) == ["Import", "Тайлбар"]
    imp = sh["Import"]
    assert imp[0] == conversion.INCOME_HEADERS and len(imp[0]) == 23
    first, second = imp[1], imp[2]
    assert first[0] == date(2026, 10, 31) and "тооллогын илүүдэл" in first[2] and "03 Заал" in first[2]
    assert (first[3], first[4], first[13], first[14], first[15], first[16], first[17], first[19]) == \
        ("60018", "313011", "150101", "101", "03", 42, 8600, 361200)
    assert second[0] == "" and second[3] == "" and second[4] == ""      # баримт-блок: толгой талбар зөвхөн эхний мөрөнд
    assert (second[14], second[16]) == ("102", 97)
    assert len(imp) == 3                                                 # дутагдал орлогод орохгүй


SAMPLE_CSALE = ["Баримтын дугаар", "Огноо", "Гүйлгээний утга", "Харилцагч", "Харьцсан данс",
                "Харьцсан ялгаатай харилцагч", "Борлуулагч", "Баримт-НӨАТ-тэй эсэх", "НӨАТ автоматаар тооцох эсэх",
                "НӨАТ-н дүн", "НӨАТ-н үзүүлэлт", "НХАТ-тай эсэх", "НХАТ автоматаар бодох эсэх", "НХАТ ийн дүн",
                "Бараа материал*", "Барааны данс*", "Барааны байршил*", "Тоо хэмжээ*", "Нэгж үнэ*", "Нийт дүн*",
                "Мөр-НӨАТ тооцох эсэх*", "Мөр-НХАТ тооцох эсэх*", "НХАТ үзүүлэлт*", "Хөнгөлөгдсөн дүн*", "Хариуцагч РД"]


def test_expense_file_is_csale_layout():
    """Хэрэглэгчийн өгсөн Эрхэтийн толгой (import_sample.xls = inv_csale, 25 багана), зарах үнээр, НӨАТ-гүй."""
    rows = ce.priced_rows(None, [cmp("201", -120, 900), cmp("202", -29, 4250), cmp("203", 5, 100)],
                          {"201": 830.15}, "cost", lpp={}, wh={"202": 2932.26})
    data, fname, stats = ce.build_xlsx(rows, kind="expense", day=date(2026, 10, 31), loc_code="03", count_id=7, **SET)
    assert fname.endswith("_03_zarlaga.xlsx")
    assert stats == {"rows": 2, "skipped": 0, "pieces": 149, "amount": 120 * 900 + 29 * 4250}
    sh = _sheet(data)
    assert list(sh) == ["Import"]                                        # огноо B — Тайлбар хуудасгүй
    imp = sh["Import"]
    assert imp[0] == ce.CSALE_HEADERS == SAMPLE_CSALE
    first, second = imp[1], imp[2]
    assert first[0] == "" and first[1] == date(2026, 10, 31) and "тооллогын дутагдал" in first[2]
    assert first[3:7] == ["60018", "313011", "", ""]
    assert first[7:14] == [0, 0, 0, "", 0, 0, 0]                         # НӨАТ-гүй, НХАТ-гүй баримт
    assert first[14:] == ["201", "150101", "03", 120, 900, 108000, 0, 0, 0, 108000, ""]
    assert second[:14] == [""] * 14                                      # баримтын талбар зөвхөн эхний мөрөнд
    assert second[14:24] == ["202", "150101", "03", 29, 4250, 123250, 0, 0, 0, 123250]   # *-тэй — мөр бүрт
    assert len(imp) == 3                                                 # илүүдэл зарлагад орохгүй


def test_build_refuses_empty_kind():
    rows = ce.priced_rows(None, [cmp("1", -1, 500)], {}, "cost", lpp={}, wh={})
    with pytest.raises(ValueError, match="Илүүдэл"):
        ce.build_xlsx(rows, kind="income", day=date(2026, 10, 31), loc_code="03", count_id=1, **SET)


def test_clean_report_html_strips_scripts_and_csrf():
    raw = ('<html><head><title>T</title><script src="/static/js/jquery.js"></script></head><body>'
           '<div id="nav_buttons" class="no-print"><form><input type="hidden" name="csrfmiddlewaretoken" value="SECRET"/>'
           '<button onClick="window.print()">Хэвлэх</button></form></div><div class="loader" id="a"><img/></div>'
           '<div id="report_container"><table><tr><td>106070</td></tr></table></div><script>alert(1)</script></body></html>')
    out = ce.clean_report_html(raw, "https://erkhet.test")
    assert "SECRET" not in out and "<script" not in out and "nav_buttons" not in out and "loader" not in out
    assert '<base href="https://erkhet.test/"' in out and "106070" in out


def test_item_report_sends_detail_flags_for_exact_item(monkeypatch):
    sent = {}

    class C:
        base = "https://erkhet.test"

        def find_inventory_id(self, code, name=""):
            return "18870" if code == "106070" else ""

        def report_html(self, path, params):
            sent.update(params)
            return "<html><head></head><body>ok</body></html>"

    monkeypatch.setitem(ce._item_report, "client", C())
    monkeypatch.setitem(ce._item_report, "ids", {})
    monkeypatch.setattr(ce, "locations", lambda: [{"code": "02", "name": "Ус", "id": "2"}])
    out = ce.item_report_html("106070", "02", date(2026, 11, 1), date(2026, 11, 6))
    assert "ok" in out
    assert (sent["inv_location"], sent["inventory"], sent["is_long"], sent["has_ptr_date"]) == (["2"], ["18870"], "on", "on")
    assert (sent["begin_date"], sent["end_date"], sent["get_kind"]) == ("11/01/2026", "11/06/2026", "account_location")
    with pytest.raises(ValueError, match="999"):
        ce.item_report_html("999", "02", date(2026, 11, 1), date(2026, 11, 6))
    with pytest.raises(ValueError, match="77"):
        ce.item_report_html("106070", "77", date(2026, 11, 1), date(2026, 11, 6))


def test_find_inventory_id_falls_back_to_exact_name(monkeypatch):
    c = erkhet_client.ErkhetClient(base_url="https://erkhet.test", username="u", password="p")
    opts = {"103408": [],
            "Essa пиво лаазтай 0.5гр": [("37097", "103096 - Алтанторх рус ХХК - Essa пиво лаазтай 0.5гр @460566")],
            "Essa": [("1", "103006 - А - Essa"), ("2", "103007 - Б - Essa")],
            "106070": [("18870", "106070 - ТОТАЛ - Түмний алим 2л @865"), ("9", "1060701 - ТОТАЛ - Өөр")]}
    monkeypatch.setattr(c, "_inventory_options", lambda search, form_path: opts.get(search, []))
    assert c.find_inventory_id("106070") == "18870"
    assert c.find_inventory_id("103408", "Essa пиво лаазтай 0.5гр") == "37097"      # код солигдсон
    assert c.find_inventory_id("103408", "Essa") == ""                              # нэр олон бараатай — таамаглахгүй
    assert c.find_inventory_id("103408") == ""
