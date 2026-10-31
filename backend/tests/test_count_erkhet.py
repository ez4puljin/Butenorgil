"""Тооллого → Эрхэтийн орлого/зарлага импорт (app/services/count_erkhet) — Эрхэт, Excel-ийг mock хийнэ."""
from datetime import date

import pytest
from python_calamine import CalamineWorkbook

from app.services import conversion, count_erkhet as ce, erkhet_xlsx


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
    assert (out["B"]["price"], out["B"]["price_src"], out["B"]["kind"], out["B"]["qty"]) == (3620, "warehouse", "expense", 2)
    assert (out["C"]["price"], out["C"]["price_src"]) == (2100, "erkhet")
    assert (out["D"]["price"], out["D"]["price_src"], out["D"]["review"]) == (7100, "sell", True)
    sell = {r["code"]: r for r in ce.priced_rows(None, rows, costs, "sell", lpp=lpp, wh=wh)}
    assert all(r["price_src"] == "sell" and not r["review"] for r in sell.values())
    assert sell["A"]["price"] == 3500


def test_preview_counts_and_skips_unpriced():
    rows = ce.priced_rows(None, [cmp("A", 3, 1000), cmp("B", 2, 0), cmp("C", -1.5, 400)], {"A": 900}, "cost", lpp={}, wh={})
    pv = ce.preview(rows)
    assert (pv["income"]["rows"], pv["income"]["pieces"], pv["income"]["amount"]) == (1, 3, 2700)
    assert [r["code"] for r in pv["income"]["skipped"]] == ["B"]        # үнэгүй — орлогод оруулахгүй
    assert (pv["expense"]["rows"], pv["expense"]["pieces"], pv["expense"]["amount"]) == (1, 1.5, 600)
    assert pv["expense"]["by_src"]["sell"] == 1 and len(pv["expense"]["review"]) == 1


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


def test_expense_file_is_inv_so_layout():
    rows = ce.priced_rows(None, [cmp("201", -120, 900), cmp("202", -29, 4250), cmp("203", 5, 100)],
                          {"201": 830.15}, "cost", lpp={}, wh={"202": 2932.26})
    data, fname, stats = ce.build_xlsx(rows, kind="expense", day=date(2026, 10, 31), loc_code="03", count_id=7, **SET)
    assert fname.endswith("_03_zarlaga.xlsx") and stats["rows"] == 2 and stats["pieces"] == 149
    sh = _sheet(data)
    assert list(sh) == ["Import"]                                        # огноо B — Тайлбар хуудасгүй
    imp = sh["Import"]
    assert imp[0] == conversion.SO_HEADERS and len(imp[0]) == 12
    assert imp[1][0] == "" and imp[1][1] == date(2026, 10, 31) and "тооллогын дутагдал" in imp[1][2]
    assert imp[1][3:] == ["60018", "313011", "", "201", "150101", "03", 120, 830.15, 99618]
    assert imp[2][1] == "" and imp[2][6:] == ["202", "150101", "03", 29, 2932.26, 85035.54]


def test_build_refuses_empty_kind():
    rows = ce.priced_rows(None, [cmp("1", -1, 500)], {}, "cost", lpp={}, wh={})
    with pytest.raises(ValueError, match="Илүүдэл"):
        ce.build_xlsx(rows, kind="income", day=date(2026, 10, 31), loc_code="03", count_id=1, **SET)
