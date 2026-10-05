"""Тооллогын хуудас (Эрхэтийн «Тооллогын хуудас» Excel) — таарсан / таараагүй харьцуулалт.

Файл: Код · Нэр · Үлдэгдэл (Програм | Тооллого) · Зөрүү тоо · Зарах үнэ, эцэст нь «Нийт» мөр.
Эрхэтийн «Зөрүү тоо» = Програм − Тооллого (дутагдал эерэг гардаг). Энд Зөрүү = Тооллого − Програм:
дутагдал сөрөг (−28), илүүдэл эерэг (+7). Зөрүүний дүн = Зөрүү × Зарах үнэ.

Брэнд — барааны мастерын «Брэнд нэр». Бүлгүүд монгол цагаан толгойн дарааллаар, бүлэг дотор
анхны зөрүүний дүнгийн үнэмлэхүй хэмжээгээр (их → бага). Тоолсон тоо эсвэл програм үлдэгдлийг гараар
засвал (дахин тоолсон, програмын алдаа г.м.) Зөрүү, дүн, нийлбэр нь засварласан утгаар, анхны утга нь
*_orig талбарт хадгалагдана.
Хэвлэх PDF: A4 хэвтээ, хуудас бүрт огноо, тайлбар, хуудасны дугаар.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from pathlib import Path

NO_BRAND = "Брэндгүй"
NOT_IN_MASTER = "Мастерт бүртгэлгүй"
_LAST = (NO_BRAND, NOT_IN_MASTER)
_MN = {ch: i for i, ch in enumerate("абвгдеёжзийклмноөпрстуүфхцчшщъыьэюя")}


def mn_key(s: str) -> tuple:
    """Монгол цагаан толгойн дараалал (Ө нь О-гийн, Ү нь У-гийн дараа); латин үсэг кирилээс өмнө."""
    k = []
    for ch in (s or "").casefold():
        if ch in _MN:
            k.append((3, _MN[ch]))
        elif "a" <= ch <= "z":
            k.append((2, ord(ch)))
        elif ch.isdigit():
            k.append((1, ord(ch)))
        else:
            k.append((0, ord(ch)))
    return tuple(k)


def _code(v) -> str:
    s = str(v if v is not None else "").strip()
    if re.fullmatch(r"-?\d+\.0+", s):
        s = s.split(".")[0]
    return "" if s.lower() == "nan" else s


def _num(v) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").replace(" ", ""))
    except ValueError:
        return None


def read_count_sheet(path) -> list[dict]:
    """→ [{code, name, program, counted, diff, price}]; diff = Тооллого − Програм."""
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(path))
    rows = wb.get_sheet_by_name(wb.sheet_names[0]).to_python()
    col = {"code": 0, "name": 1, "program": 2, "counted": 3, "diff": 4, "price": 5}
    start = 0
    hdr = next((i for i, r in enumerate(rows[:30]) if any(str(c).strip().lower() == "код" for c in r)), -1)
    if hdr >= 0:                                                   # баганыг толгойн нэрээр олно
        seen = set()
        for i, t in enumerate(str(c).strip().lower() for c in rows[hdr]):
            key = ("code" if t == "код" else "name" if t == "нэр" else "diff" if "зөрүү" in t
                   else "price" if "үнэ" in t else None)
            if key and key not in seen:
                col[key] = i
                seen.add(key)
        start = hdr + 1
        sub = [str(c).strip().lower() for c in rows[hdr + 1]] if hdr + 1 < len(rows) else []
        if "програм" in sub and "тооллого" in sub:                 # «Үлдэгдэл» доорх дэд толгой
            col["program"], col["counted"] = sub.index("програм"), sub.index("тооллого")
            start = hdr + 2
    g = lambda r, k: r[col[k]] if col[k] < len(r) else None
    out = []
    for r in rows[start:]:
        code = _code(g(r, "code"))
        if not code:                                               # «Нийт» болон хоосон мөр
            continue
        program, counted, fdiff = _num(g(r, "program")), _num(g(r, "counted")), _num(g(r, "diff"))
        diff = counted - program if program is not None and counted is not None else -(fdiff or 0.0)
        out.append({"code": code, "name": str(g(r, "name") or "").strip(), "program": program,
                    "counted": counted, "diff": round(diff, 3), "price": _num(g(r, "price"))})
    return out


def totals(rows: list[dict]) -> dict:
    t = {"items": len(rows), "matched": 0, "surplus_n": 0, "shortage_n": 0, "surplus_qty": 0.0,
         "shortage_qty": 0.0, "surplus_amt": 0.0, "shortage_amt": 0.0}
    for r in rows:
        if r["diff"] > 0:
            t["surplus_n"] += 1
            t["surplus_qty"] += r["diff"]
            t["surplus_amt"] += r["amount"]
        elif r["diff"] < 0:
            t["shortage_n"] += 1
            t["shortage_qty"] += r["diff"]
            t["shortage_amt"] += r["amount"]
        else:
            t["matched"] += 1
    t["unmatched"] = t["surplus_n"] + t["shortage_n"]
    t["net_qty"] = t["surplus_qty"] + t["shortage_qty"]
    t["net_amt"] = t["surplus_amt"] + t["shortage_amt"]
    t["adjusted"] = sum(1 for r in rows if r.get("adjusted"))
    t["net_qty_orig"] = round(sum(r.get("diff_orig", r["diff"]) for r in rows), 3)
    t["net_amt_orig"] = round(sum(r.get("amount_orig", r["amount"]) for r in rows), 2)
    for k in ("surplus_qty", "shortage_qty", "net_qty"):
        t[k] = round(t[k], 3)
    for k in ("surplus_amt", "shortage_amt", "net_amt"):
        t[k] = round(t[k], 2)
    return t


def build_compare(rows: list[dict], notes: dict[str, dict]) -> dict:
    """Брэнд, үнэ, зөрүүний дүн, тайлбар, тоолсон тооны залруулгыг нэмж брэндээр бүлэглэнэ.
    notes = {code: {"note", "by", "at", "counted"?, "counted_by"?, "counted_at"?, "program"?, …}}.
    Зарах үнэ файлд байхгүй бол мастерын нэгж үнэ."""
    from app.services.mobile_pdf import master_products
    master = master_products()
    groups: dict[str, list] = {}
    for r in rows:
        m = master.get(r["code"])
        r["brand"] = (m["brand"] or NO_BRAND) if m else NOT_IN_MASTER
        if not r["price"] and m and m.get("price"):
            r["price"] = m["price"]
        r["price"] = r["price"] or 0.0
        n = notes.get(r["code"]) or {}
        r["counted_orig"], r["program_orig"], r["diff_orig"] = r["counted"], r["program"], r["diff"]
        r["counted_adjusted"] = n.get("counted") is not None
        r["program_adjusted"] = n.get("program") is not None
        r["adjusted"] = r["counted_adjusted"] or r["program_adjusted"]
        if r["counted_adjusted"]:
            r["counted"] = n["counted"]
        if r["program_adjusted"]:
            r["program"] = n["program"]
        if r["adjusted"]:
            r["diff"] = round((r["counted"] or 0.0) - (r["program"] or 0.0), 3)
        r["amount"] = round(r["diff"] * r["price"], 2)
        r["amount_orig"] = round(r["diff_orig"] * r["price"], 2)
        r["note"], r["note_by"], r["note_at"] = n.get("note", ""), n.get("by", ""), n.get("at")
        r["counted_by"], r["counted_at"] = n.get("counted_by", ""), n.get("counted_at")
        r["program_by"], r["program_at"] = n.get("program_by", ""), n.get("program_at")
        groups.setdefault(r["brand"], []).append(r)
    order = sorted(groups, key=lambda b: (_LAST.index(b) + 1 if b in _LAST else 0, mn_key(b)))
    out_rows, out_groups = [], []
    for b in order:
        its = sorted(groups[b], key=lambda r: (-abs(r["amount_orig"]), -abs(r["diff_orig"]), mn_key(r["name"]), r["code"]))
        out_rows += its
        out_groups.append({"brand": b, **totals(its)})
    return {"rows": out_rows, "groups": out_groups, "totals": totals(rows)}


# ── Хэвлэх PDF (A4 хэвтээ) ─────────────────────────────────────────────────────

def fq(v: float | None, sign: bool = False) -> str:
    """Тоо ширхэг: бүхэл бол бүхлээр, үгүй бол ≤3 оронтой бутархай."""
    if v is None:
        return ""
    s = f"{v:,.0f}" if abs(v - round(v)) < 1e-9 else f"{v:,.3f}".rstrip("0").rstrip(".")
    return f"+{s}" if sign and v > 0 else s


def fa(v: float | None, sign: bool = False) -> str:
    if v is None:
        return ""
    s = f"{round(v):,}"
    return f"+{s}" if sign and v > 0 else s


def compare_pdf(*, warehouse: str, count_date: date, description: str, file_name: str, data: dict,
                scope: str | None = None) -> bytes:
    """Зөрүүтэй (эсвэл тоог нь зассан) бүх бараа, бүх багана, брэндээр бүлэглэсэн; хуудас бүрт огноо,
    тайлбар, дугаар. scope — нэг брэндээр хязгаарласан бол түүний нэр (data нь аль хэдийн шүүгдсэн)."""
    from fpdf import FPDF
    from fpdf.enums import TableHeadingsDisplay
    from fpdf.fonts import FontFace
    from app.services.mobile_pdf import FONT_BOLD, FONT_FALLBACK, FONT_REG, fit

    INK, GRAY, LINE = (31, 41, 55), (107, 114, 128), (209, 213, 219)
    RED, GREEN, HEAD = (185, 28, 28), (21, 128, 61), (31, 78, 120)
    GROUP_BG, TOTAL_BG = (232, 240, 233), (219, 234, 254)
    printed = datetime.now().strftime("%Y.%m.%d %H:%M")
    title = f"Тооллогын зөрүү — {warehouse}" + (f" · {scope}" if scope else "")
    when = f"Тооллого: {count_date:%Y.%m.%d}"
    desc = (description or "").strip() or "—"

    class PDF(FPDF):
        def header(self):                                          # хуудас бүрт: гарчиг, огноо, тайлбар
            self.set_font("Main", "B", 12)
            self.set_text_color(*INK)
            self.set_xy(self.l_margin, 18)
            self.cell(self.epw - 170, 16, fit(self, title, self.epw - 174))
            self.cell(170, 16, when, align="R")
            self.set_font("Main", "", 9)
            self.set_text_color(*GRAY)
            self.set_xy(self.l_margin, 35)
            self.cell(self.epw * 0.68, 12, fit(self, f"Тайлбар: {desc}", self.epw * 0.68 - 6))
            self.set_font("Main", "", 7.5)
            self.cell(self.epw * 0.32, 12, fit(self, f"Файл: {file_name}", self.epw * 0.32), align="R")
            self.set_draw_color(*LINE)
            self.line(self.l_margin, 51, self.w - self.r_margin, 51)
            self.set_y(57)

        def footer(self):                                          # хуудасны дугаар
            self.set_draw_color(*LINE)
            self.line(self.l_margin, self.h - 24, self.w - self.r_margin, self.h - 24)
            self.set_y(self.h - 21)
            self.set_font("Main", "", 7.5)
            self.set_text_color(*GRAY)
            self.cell(self.epw - 160, 12, fit(self, f"{when} · {desc} · Хэвлэсэн: {printed}", self.epw - 170))
            self.set_font("Main", "B", 8.5)
            self.set_text_color(*INK)
            self.cell(160, 12, f"Хуудас {self.page_no()} / {{nb}}", align="R")

    pdf = PDF(orientation="L", unit="pt", format="A4")
    reg, bold = (FONT_REG, FONT_BOLD) if Path(FONT_REG).exists() and Path(FONT_BOLD).exists() else FONT_FALLBACK
    pdf.add_font("Main", "", reg)
    pdf.add_font("Main", "B", bold)
    pdf.set_margins(24, 57, 24)
    pdf.set_auto_page_break(True, margin=30)
    pdf.set_title(f"{title} {count_date:%Y.%m.%d}")
    pdf.set_author("Бүтэн-Оргил ХХК")
    pdf.add_page()

    t = data["totals"]
    pdf.set_font("Main", "", 9.5)
    pdf.set_text_color(*INK)
    pdf.multi_cell(pdf.epw, 13, (
        f"Нийт {t['items']:,} бараа · таарсан {t['matched']:,} · таараагүй {t['unmatched']:,} — "
        f"илүүдэл {t['surplus_n']:,} ({fq(t['surplus_qty'], True)} ш, {fa(t['surplus_amt'], True)}₮), "
        f"дутагдал {t['shortage_n']:,} ({fq(t['shortage_qty'])} ш, {fa(t['shortage_amt'])}₮). "
        f"{'Нийт' if scope else 'Бүх барааны нийт'} зөрүү: {fq(t['net_qty'], True)} ш, {fa(t['net_amt'], True)}₮"
        + (f" · тоог нь зассан {t['adjusted']:,} бараа (анхны нийт зөрүү {fq(t['net_qty_orig'], True)} ш, "
           f"{fa(t['net_amt_orig'], True)}₮)" if t["adjusted"] else "")))
    pdf.ln(4)

    widths = (22, 50, 200, 52, 52, 50, 58, 74)
    widths += (pdf.epw - sum(widths),)
    heads = ("№", "Код", "Нэр", "Програм", "Тооллого", "Зөрүү", "Зарах үнэ", "Зөрүүний дүн", "Тайлбар")
    aligns = ("CENTER", "LEFT", "LEFT", "RIGHT", "RIGHT", "RIGHT", "RIGHT", "RIGHT", "LEFT")
    head_style = FontFace(emphasis="BOLD", color=(255, 255, 255), fill_color=HEAD)
    sign_color = lambda v: RED if v < 0 else GREEN if v > 0 else None
    signed = lambda v: FontFace(color=sign_color(v))
    sub_style = lambda v=0, bold=True: FontFace(emphasis="BOLD" if bold else None, fill_color=GROUP_BG,
                                                color=sign_color(v))

    by_brand: dict[str, list] = {}
    for r in data["rows"]:
        if r["diff"] or r.get("adjusted"):                         # зассан бараа 0 болсон ч хэвлэгдэнэ
            by_brand.setdefault(r["brand"], []).append(r)
    groups = [g for g in data["groups"] if g["brand"] in by_brand]
    if not groups:
        pdf.set_font("Main", "B", 12)
        pdf.set_text_color(*GREEN)
        pdf.cell(pdf.epw, 30, "Зөрүүтэй бараа алга — бүх бараа таарсан.", align="C")
        return bytes(pdf.output())

    no = 0
    pdf.set_draw_color(*LINE)
    pdf.set_line_width(0.4)
    for g in groups:
        if pdf.y > pdf.page_break_trigger - 70:                    # брэндийн гарчиг ганцаараа хуудасны ёроолд үлдэхгүй
            pdf.add_page()
        pdf.set_font("Main", "B", 10.5)
        pdf.set_text_color(*INK)
        pdf.cell(pdf.epw * 0.42, 16, fit(pdf, g["brand"], pdf.epw * 0.42 - 4))
        pdf.set_font("Main", "", 8.5)
        pdf.set_text_color(*GRAY)
        pdf.cell(pdf.epw * 0.58, 16, (
            f"{g['unmatched']} зөрүүтэй / {g['items']} бараа · илүүдэл {fq(g['surplus_qty'], True)} ш "
            f"({fa(g['surplus_amt'], True)}₮) · дутагдал {fq(g['shortage_qty'])} ш ({fa(g['shortage_amt'])}₮)"),
            align="R", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Main", "", 8)
        pdf.set_text_color(*INK)
        with pdf.table(col_widths=widths, text_align=aligns, headings_style=head_style, line_height=10.5,
                       padding=(2, 3), repeat_headings=TableHeadingsDisplay.ON_TOP_OF_EVERY_PAGE) as table:
            table.row(heads)
            for r in by_brand[g["brand"]]:
                no += 1
                row = table.row()
                row.cell(str(no))
                row.cell(r["code"])
                row.cell(r["name"])
                orig = lambda v, o, sign=False: f"{fq(v, sign)}\n(анх {fq(o, sign)})"   # засварласан + анхны утга
                row.cell(orig(r["program"], r["program_orig"]) if r.get("program_adjusted") else fq(r["program"]))
                row.cell(orig(r["counted"], r["counted_orig"]) if r.get("counted_adjusted") else fq(r["counted"]))
                row.cell(orig(r["diff"], r["diff_orig"], True) if r.get("adjusted") else fq(r["diff"], True),
                         style=signed(r["diff"]))
                row.cell(fa(r["price"]))
                row.cell(fa(r["amount"], True), style=signed(r["amount"]))
                row.cell(r["note"] or "")
            sub = table.row()                                      # брэндийн дүн: цэвэр зөрүү тоо ба дүн
            sub.cell(f"{g['brand']} — дүн", colspan=5, align="RIGHT", style=sub_style())
            sub.cell(fq(g["net_qty"], True), style=sub_style(g["net_qty"]))
            sub.cell("", style=sub_style(bold=False))
            sub.cell(fa(g["net_amt"], True), style=sub_style(g["net_amt"]))
            sub.cell("", style=sub_style(bold=False))
        pdf.ln(8)

    if pdf.y > pdf.page_break_trigger - 40:
        pdf.add_page()
    pdf.set_fill_color(*TOTAL_BG)
    pdf.set_text_color(*INK)
    pdf.set_font("Main", "B", 10)
    pdf.cell(pdf.epw * 0.5, 22, f"  НИЙТ ЗӨРҮҮ — {scope}" if scope else "  БҮХ БАРААНЫ НИЙТ ЗӨРҮҮ", fill=True)
    pdf.set_font("Main", "", 9)
    pdf.cell(pdf.epw * 0.5, 22, (
        f"илүүдэл {fq(t['surplus_qty'], True)} ш ({fa(t['surplus_amt'], True)}₮) · дутагдал {fq(t['shortage_qty'])} ш "
        f"({fa(t['shortage_amt'])}₮) · нийт {fq(t['net_qty'], True)} ш, {fa(t['net_amt'], True)}₮  "),
        align="R", fill=True)
    return bytes(pdf.output())
