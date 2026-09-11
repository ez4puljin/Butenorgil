# reports_prev_inventory.py
"""Өмнөх тооллогын тохируулга шалгах тайлан.

Хоёр файлыг тулгана:
  · after   — Эрхэтийн "Барааматериалын тайлан (өртгөөр)", тохируулгын ДАРААХ
              үлдэгдэл. A=код, B=нэр, I=эцсийн тоо, J=эцсийн дүн, K=нэгж өртөг.
  · counted — Эрхэтийн "Тооллогын хуудас". A=код, B=нэр, C=програмын үлдэгдэл,
              D=тоолсон, E=зөрүү, F=зарах үнэ.

Гол асуулт: тооллого хийсний дараа програмын үлдэгдэл тоолсонтойгоо таарсан уу?

Гаралтын хуудсууд ЭРЭМБЭЛЭГДСЭН байдлаар:
  Дүгнэлт            — нэг харцаар: юу асуудалтай, юу хийх вэ
  1. Анхаарах        — үлдэгдэлтэй мөртлөө ТООЛЛОГОД ОРООГҮЙ бараа (гол асуудал)
  2. Тоо зөрүүтэй    — тоологдсон ч тохируулгын дараа тоо таараагүй бараа
  3. Тайланд ороогүй — тоологдсон ч үлдэгдлийн тайланд алга байгаа бараа
  4. Ороогүй (үлдэгдэл 0) — тоологдоогүй ч үлдэгдэлгүй тул хор хөнөөлгүй
  5. Бүлгийн нийлбэр — тайлангийн нийлбэр мөрүүд (бараа биш, тооцооноос хассан)

Өмнөх хувилбарын гол дутагдал: бүх зүйл нэг "Бүртгэл дутуу-илүү" хуудсанд
хамт орж, 5 жинхэнэ асуудал 36 мөрийн дунд булагдаж, харин "Тоо зөрүүтэй"
хуудас хоосон гарахад хэрэглэгч систем ажиллаагүй гэж ойлгодог байв.
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

try:
    import xlrd  # .xls
except Exception:  # pragma: no cover
    xlrd = None


# ── Өнгө ба хэв маяг ────────────────────────────────────────────────────
C_DANGER = "C0392B"   # улаан — анхаарах
C_WARN = "E67E22"     # улбар шар — зөрүү
C_INFO = "2E86C1"     # цэнхэр — мэдээлэл
C_OK = "1E8449"       # ногоон — асуудалгүй
C_MUTED = "7F8C8D"    # саарал — чимээ шуугиан

THIN = Side(style="thin", color="D5D8DC")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

QTY_FMT = "#,##0.###"
MNT_FMT = "#,##0"


def norm_code(v: Any) -> str:
    if v is None:
        return ""
    s = str(v).strip().replace(" ", " ")
    s = re.sub(r"\s+", "", s).upper()
    if re.fullmatch(r"-?\d+\.0", s):  # 50205.0 -> 50205
        s = s[:-2]
    return s


def to_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s == "":
        return None
    s = s.replace(",", "").replace(" ", "")
    try:
        return float(s)
    except Exception:
        return None


def _is_blank(v: Any) -> bool:
    """Нүд ҮНЭХЭЭР хоосон эсэх. 0 нь хоосон БИШ."""
    return v is None or (isinstance(v, str) and v.strip() == "")


def read_rows(path: str, col_map_0based: Dict[str, int]) -> Dict[str, Dict[str, Any]]:
    """{КОД: {талбар: утга, ...}} буцаана.

    `col_map_0based` дахь түлхүүр бүрд тухайн баганын утгыг тоо болгож оруулна
    ("name"-ээс бусад нь). Мөн `_blank_<талбар>` гэсэн туслах тугийг тавина —
    "0" ба "огт хоосон" хоёрыг ялгах шаардлагатай (бүлгийн нийлбэр мөрийг
    нэгж өртөг нь ХООСОН эсэхээр таньдаг).
    """
    ext = Path(path).suffix.lower()
    out: Dict[str, Dict[str, Any]] = {}

    if ext in (".xlsx", ".xlsm"):
        wb = load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        for r in range(1, ws.max_row + 1):
            raw_code = ws.cell(r, col_map_0based["code"] + 1).value
            code = norm_code(raw_code)
            if not code or code.lower() in ("код", "code"):
                continue
            rec: Dict[str, Any] = {}
            for key, idx in col_map_0based.items():
                if key == "code":
                    continue
                v = ws.cell(r, idx + 1).value
                rec["_blank_" + key] = _is_blank(v)
                rec[key] = (v or "") if key == "name" else to_float(v)
            out[code] = rec
        wb.close()
        return out

    if ext == ".xls":
        if xlrd is None:
            raise RuntimeError("xls унших xlrd суусангүй. requirements.txt дээр xlrd нэмнэ үү.")
        book = xlrd.open_workbook(path)
        sh = book.sheet_by_index(0)
        for r in range(sh.nrows):
            ccol = col_map_0based["code"]
            raw_code = sh.cell_value(r, ccol) if ccol < sh.ncols else ""
            code = norm_code(raw_code)
            if not code or code.lower() in ("код", "code"):
                continue
            rec: Dict[str, Any] = {}
            for key, idx in col_map_0based.items():
                if key == "code":
                    continue
                if idx >= sh.ncols:
                    rec["_blank_" + key] = True
                    rec[key] = "" if key == "name" else None
                    continue
                v = sh.cell_value(r, idx)
                blank = (sh.cell_type(r, idx) == xlrd.XL_CELL_EMPTY) or _is_blank(v)
                rec["_blank_" + key] = blank
                rec[key] = (v or "") if key == "name" else to_float(v)
            out[code] = rec
        return out

    raise ValueError(f"Дэмжихгүй файл: {ext}")


# Хуучин нэрийг хадгална (гадуур дуудаж байвал эвдрэхгүй).
def read_cols_any(path: str, col_map_0based: Dict[str, int]) -> Dict[str, Dict[str, Any]]:
    return read_rows(path, col_map_0based)


# ── Excel бичих туслахууд ───────────────────────────────────────────────
def _header(ws, titles: List[str], color: str) -> None:
    ws.append(titles)
    fill = PatternFill("solid", start_color=color)
    for c in range(1, len(titles) + 1):
        cell = ws.cell(1, c)
        cell.font = Font(bold=True, color="FFFFFF", size=11)
        cell.fill = fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[1].height = 30
    ws.freeze_panes = "A2"


def _autosize(ws, widths: List[int]) -> None:
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def _empty_note(ws, ncols: int, text: str) -> None:
    """Хоосон хуудсыг "юу ч гараагүй" гэдгийг ТОДОРХОЙ хэлж дуусгана.

    Хоосон хуудас нь "систем ажиллаагүй" мэт харагддаг тул заавал бичнэ."""
    ws.append([text] + [""] * (ncols - 1))
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ncols)
    c = ws.cell(2, 1)
    c.font = Font(bold=True, color=C_OK, size=12)
    c.alignment = Alignment(horizontal="center", vertical="center")
    c.fill = PatternFill("solid", start_color="EAFAF1")
    ws.row_dimensions[2].height = 28


def _style_rows(ws, first_row: int, ncols: int, num_cols: Dict[int, str]) -> None:
    for r in range(first_row, ws.max_row + 1):
        for c in range(1, ncols + 1):
            cell = ws.cell(r, c)
            cell.border = BORDER
            if c in num_cols:
                cell.number_format = num_cols[c]
                cell.alignment = Alignment(horizontal="right")
        if r % 2 == 0:
            for c in range(1, ncols + 1):
                if ws.cell(r, c).fill.start_color.rgb in (None, "00000000"):
                    ws.cell(r, c).fill = PatternFill("solid", start_color="FBFCFC")


def build_prev_inventory_check_report(after_path: str, counted_path: str, out_xlsx_path: str) -> None:
    after = read_rows(after_path, {"code": 0, "name": 1, "qty": 8, "amount": 9, "cost": 10})
    counted = read_rows(counted_path, {"code": 0, "name": 1, "prog": 2, "qty": 3, "diff": 4, "price": 5})

    if not after and not counted:
        raise ValueError("Хоёр файл хоёулаа хоосон уншигдлаа. (Sheet/багана буруу эсэхийг шалгана уу.)")

    # ── Бүлгийн нийлбэр мөрийг ялгах ────────────────────────────────────
    # Эрхэтийн тайлангийн эхэнд бүлгийн НИЙЛБЭР мөрүүд ордог ("Бэлэн
    # бүтээгдэхүүн, бараа", "Ус ундаа архи пиво" гэх мэт). Тэдгээр нь бараа
    # БИШ тул тулгалтад орвол "тооллогод ороогүй" гэсэн худал сэрэмжлүүлэг
    # үүсгэнэ. Таних шинж: "Нэгж өртөг" (K) багана нь ХООСОН — бодит барааны
    # хувьд 0 байсан ч утга бичигдсэн байдаг.
    #
    # ХОЁР ХАМГААЛАЛТ (эдгээргүй бол бүх бараа чимээгүй алга болно):
    #   1. "Нэгж өртөг" багана ОГТ байхгүй экспортод бүх мөрийн нүд хоосон
    #      байх тул бүгд "бүлэг" гэж ангилагдана. Тиймээс багана үнэхээр
    #      байгаа эсэхийг (ядаж нэг мөрд утга байгаа эсэхээр) эхэлж шалгана.
    #   2. Хэрэв мөрүүдийн 20%-иас олон нь хоосон бол энэ шинж тэмдэг тухайн
    #      файлд хамаарахгүй гэж үзээд ХЭНИЙГ Ч хасахгүй — бараа алдахаас
    #      илүү нийлбэр мөр үлдсэн нь дээр.
    blank_cost = [c for c, r in after.items() if r.get("_blank_cost")]
    has_cost_col = len(blank_cost) < len(after)
    signal_ok = has_cost_col and len(blank_cost) <= max(5, 0.20 * len(after))
    group_codes = blank_cost if signal_ok else []
    product_after = {c: r for c, r in after.items() if c not in set(group_codes)}

    # Өөрийгөө шалгах: бүлгийн мөрийн тоо нь бараануудын нийлбэртэй тэнцэх ёстой.
    prod_sum = sum((r.get("qty") or 0) for r in product_after.values())
    group_ok = all(abs((after[c].get("qty") or 0) - prod_sum) < 0.001 for c in group_codes) if group_codes else True

    # ── Ангилал ─────────────────────────────────────────────────────────
    alarm: List[List[Any]] = []      # үлдэгдэлтэй ба тооллогод ороогүй
    quiet: List[List[Any]] = []      # үлдэгдэл 0 ба тооллогод ороогүй
    mismatch: List[List[Any]] = []   # хоёуланд байгаа ч тоо таараагүй
    missing_after: List[List[Any]] = []  # тоологдсон ч тайланд алга
    adjusted = 0                     # тооллогоор зөрүү гарч, тохируулагдсан

    for code in sorted(set(product_after) | set(counted)):
        a = product_after.get(code)
        c = counted.get(code)
        name = (c or {}).get("name") or (a or {}).get("name") or ""
        a_qty = (a or {}).get("qty")
        c_qty = (c or {}).get("qty")

        if a and not c:
            bal = a_qty or 0
            amount = a.get("amount") or 0
            cost = a.get("cost") or 0
            if bal != 0:
                alarm.append([code, name, bal, cost, amount,
                              "Үлдэгдэлтэй хэрнээ тооллогод ОРООГҮЙ — тоолж бүртгэх, "
                              "эсвэл 0 болгож хасах шаардлагатай"])
            else:
                quiet.append([code, name, bal, "Тооллогод ороогүй ч үлдэгдэл 0 — арга хэмжээ шаардлагагүй"])
            continue

        if c and not a:
            missing_after.append([code, name, c_qty, (c.get("prog") if c else None),
                                  "Тооллогод байна, тохируулгын дараах тайланд АЛГА — "
                                  "бараа устсан эсвэл өөр код руу шилжсэн байж болно"])
            continue

        # Хоёуланд байна
        if (c.get("diff") or 0) != 0 or ((c.get("prog") is not None) and c.get("prog") != c_qty):
            adjusted += 1

        if a_qty is None or c_qty is None:
            mismatch.append([code, name, c_qty, a_qty, None, (c or {}).get("price"),
                             "Тоо хэмжээ уншигдсангүй (нүд хоосон эсвэл формат буруу)"])
        elif float(a_qty) != float(c_qty):
            diff = float(a_qty) - float(c_qty)
            mismatch.append([code, name, c_qty, a_qty, diff, (c or {}).get("price"),
                             f"Тооллого {c_qty:g}ш, тохируулгын дараах {a_qty:g}ш "
                             f"(зөрүү {diff:+g}) — тохируулга бүрэн хийгдээгүй"])

    alarm.sort(key=lambda r: -(r[4] or 0))          # үнийн дүнгээр буурахаар
    mismatch.sort(key=lambda r: -abs(r[4] or 0))
    quiet.sort(key=lambda r: r[0])

    alarm_qty = sum(r[2] or 0 for r in alarm)
    alarm_mnt = sum(r[4] or 0 for r in alarm)

    # ── Excel ───────────────────────────────────────────────────────────
    wb = Workbook()

    # ═══ Дүгнэлт ═══
    ws = wb.active
    ws.title = "Дүгнэлт"
    ws.column_dimensions["A"].width = 4
    ws.column_dimensions["B"].width = 46
    ws.column_dimensions["C"].width = 18
    ws.column_dimensions["D"].width = 62

    def put(row: int, b: Any, c: Any = "", d: Any = "", bold=False, color=None,
            size=11, fill=None, num=None):
        ws.cell(row, 2, b).font = Font(bold=bold, color=color or "000000", size=size)
        if c != "":
            cell = ws.cell(row, 3, c)
            cell.font = Font(bold=True, color=color or "000000", size=size)
            cell.alignment = Alignment(horizontal="right")
            if num:
                cell.number_format = num
        if d != "":
            ws.cell(row, 4, d).font = Font(color=C_MUTED, size=10)
        if fill:
            for col in (2, 3, 4):
                ws.cell(row, col).fill = PatternFill("solid", start_color=fill)

    ws.merge_cells("B2:D2")
    t = ws.cell(2, 2, "ӨМНӨХ ТООЛЛОГЫН ТОХИРУУЛГА ШАЛГАСАН ДҮГНЭЛТ")
    t.font = Font(bold=True, size=16, color="FFFFFF")
    t.alignment = Alignment(horizontal="center", vertical="center")
    for col in (2, 3, 4):
        ws.cell(2, col).fill = PatternFill("solid", start_color=C_INFO)
    ws.row_dimensions[2].height = 30

    put(3, "Үүсгэсэн", datetime.now().strftime("%Y-%m-%d %H:%M"))
    put(4, "Тохируулгын дараах тайлан", Path(after_path).name)
    put(5, "Тооллогын хуудас", Path(counted_path).name)

    # Гол дүгнэлт
    if alarm:
        put(7, "⚠  АНХААРАХ ШААРДЛАГАТАЙ", f"{len(alarm)} бараа",
            "Үлдэгдэлтэй мөртлөө тооллогод огт ороогүй → «1. Анхаарах» хуудсыг үзнэ үү",
            bold=True, color="FFFFFF", size=13, fill=C_DANGER)
        put(8, "Тэдгээрийн нийт үлдэгдэл", alarm_qty, "ширхэг", bold=True, color=C_DANGER, num=QTY_FMT)
        put(9, "Тэдгээрийн нийт өртөг", alarm_mnt, "төгрөг", bold=True, color=C_DANGER, num=MNT_FMT)
    else:
        put(7, "✓  Үлдэгдэлтэй мөртлөө тооллогод ороогүй бараа алга", "",
            "Бүх үлдэгдэлтэй бараа тооллогод хамрагдсан",
            bold=True, color="FFFFFF", size=13, fill=C_OK)

    r = 11
    ws.cell(r, 2, "ДЭЛГЭРЭНГҮЙ").font = Font(bold=True, size=12)
    r += 1
    rows_info = [
        ("1. Анхаарах", len(alarm),
         "Үлдэгдэлтэй ба тооллогод ОРООГҮЙ — засах шаардлагатай", C_DANGER if alarm else C_OK),
        ("2. Тоо зөрүүтэй", len(mismatch),
         "Тоологдсон ч тохируулгын дараа тоо таараагүй", C_WARN if mismatch else C_OK),
        ("3. Тайланд ороогүй", len(missing_after),
         "Тооллогод байна, үлдэгдлийн тайланд алга", C_WARN if missing_after else C_OK),
        ("4. Ороогүй (үлдэгдэл 0)", len(quiet),
         "Тооллогод ороогүй ч үлдэгдэл 0 — арга хэмжээ шаардлагагүй", C_MUTED),
        ("5. Бүлгийн нийлбэр", len(group_codes),
         "Тайлангийн нийлбэр мөр — бараа биш тул тооцооноос хассан", C_MUTED),
    ]
    for label, n, desc, color in rows_info:
        put(r, label, n, desc, bold=True, color=color, num="#,##0")
        r += 1

    r += 1
    ws.cell(r, 2, "ТУЛГАЛТЫН ТОО").font = Font(bold=True, size=12)
    r += 1
    put(r, "Тохируулгын дараах тайлан дахь бараа", len(product_after), "", num="#,##0"); r += 1
    put(r, "Тооллогын хуудас дахь бараа", len(counted), "", num="#,##0"); r += 1
    put(r, "Хоёуланд байгаа бараа", len(set(product_after) & set(counted)), "", num="#,##0"); r += 1
    put(r, "Тооллогоор зөрүү гарч тохируулагдсан", adjusted,
        "Эдгээрийн үлдэгдэл тооллогын тоотой таарсан эсэхийг «2. Тоо зөрүүтэй» шалгасан",
        num="#,##0"); r += 1

    if group_codes:
        r += 1
        ok_txt = ("✓ Нийлбэр таарсан (бараануудын нийт = нийлбэр мөрийн утга)"
                  if group_ok else "⚠ Нийлбэр таараагүй — тайлангийн бүтэц өөрчлөгдсөн байж болзошгүй")
        put(r, "Хассан нийлбэр мөр", ", ".join(group_codes), ok_txt,
            color=C_OK if group_ok else C_WARN)
        r += 1

    r += 2
    ws.cell(r, 2, "ЮУ ХИЙХ ВЭ").font = Font(bold=True, size=12)
    r += 1
    steps = [
        "1) «1. Анхаарах» хуудсыг нээж, тэнд байгаа бараа бүрийг агуулахаас шалгана.",
        "2) Бодитоор байгаа бол дахин тоолж бүртгэнэ; байхгүй бол Эрхэт дээр 0 болгож хасна.",
        "3) «2. Тоо зөрүүтэй» хоосон бол тохируулга бүрэн хийгдсэн гэсэн үг — асуудалгүй.",
        "4) «4. Ороогүй (үлдэгдэл 0)» хуудсыг үзэх шаардлагагүй — зөвхөн бүртгэлийн бүрэн байдалд.",
    ]
    for s in steps:
        ws.cell(r, 2, s).font = Font(size=10)
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=4)
        r += 1

    # ═══ 1. Анхаарах ═══
    ws1 = wb.create_sheet("1. Анхаарах")
    _header(ws1, ["Код", "Нэр", "Үлдэгдэл (ш)", "Нэгж өртөг (₮)", "Нийт өртөг (₮)", "Юу хийх вэ"], C_DANGER)
    for row in alarm:
        ws1.append(row)
    if not alarm:
        _empty_note(ws1, 6, "✓  Үлдэгдэлтэй мөртлөө тооллогод ороогүй бараа олдсонгүй")
    else:
        _style_rows(ws1, 2, 6, {3: QTY_FMT, 4: MNT_FMT, 5: MNT_FMT})
        for rr in range(2, ws1.max_row + 1):
            ws1.cell(rr, 1).font = Font(bold=True, color=C_DANGER)
    _autosize(ws1, [14, 46, 14, 16, 16, 64])

    # ═══ 2. Тоо зөрүүтэй ═══
    ws2 = wb.create_sheet("2. Тоо зөрүүтэй")
    _header(ws2, ["Код", "Нэр", "Тоолсон (ш)", "Тохируулгын дараах (ш)",
                  "Зөрүү (ш)", "Зарах үнэ (₮)", "Тайлбар"], C_WARN)
    for row in mismatch:
        ws2.append(row)
    if not mismatch:
        both_n = len(set(product_after) & set(counted))
        _empty_note(ws2, 7,
                    f"✓  Зөрүү олдсонгүй — тоологдсон {both_n:,} бараа бүгд "
                    f"тохируулгын дараа тоолсонтойгоо таарсан".replace(",", " "))
    else:
        _style_rows(ws2, 2, 7, {3: QTY_FMT, 4: QTY_FMT, 5: QTY_FMT, 6: MNT_FMT})
    _autosize(ws2, [14, 46, 14, 20, 12, 14, 60])

    # ═══ 3. Тайланд ороогүй ═══
    ws3 = wb.create_sheet("3. Тайланд ороогүй")
    _header(ws3, ["Код", "Нэр", "Тоолсон (ш)", "Програмын үлдэгдэл (ш)", "Тайлбар"], C_WARN)
    for row in missing_after:
        ws3.append(row)
    if not missing_after:
        _empty_note(ws3, 5, "✓  Тооллогын бүх бараа тохируулгын дараах тайланд бий")
    else:
        _style_rows(ws3, 2, 5, {3: QTY_FMT, 4: QTY_FMT})
    _autosize(ws3, [14, 46, 14, 22, 60])

    # ═══ 4. Ороогүй (үлдэгдэл 0) ═══
    ws4 = wb.create_sheet("4. Ороогүй (үлдэгдэл 0)")
    _header(ws4, ["Код", "Нэр", "Үлдэгдэл (ш)", "Тайлбар"], C_MUTED)
    for row in quiet:
        ws4.append(row)
    if not quiet:
        _empty_note(ws4, 4, "✓  Ийм бараа алга")
    else:
        _style_rows(ws4, 2, 4, {3: QTY_FMT})
    _autosize(ws4, [14, 46, 14, 62])

    # ═══ 5. Бүлгийн нийлбэр ═══
    ws5 = wb.create_sheet("5. Бүлгийн нийлбэр")
    _header(ws5, ["Код", "Нэр", "Тайлангийн тоо (ш)", "Бараануудын нийлбэр (ш)", "Тайлбар"], C_MUTED)
    for c in group_codes:
        q = after[c].get("qty")
        ws5.append([c, after[c].get("name") or "", q, prod_sum,
                    "Тайлангийн нийлбэр мөр — бараа биш тул тулгалтаас хассан"
                    + ("" if abs((q or 0) - prod_sum) < 0.001 else " (АНХААР: нийлбэр таараагүй)")])
    if not group_codes:
        _empty_note(ws5, 5, "Нийлбэр мөр олдсонгүй — тайлан зөвхөн бараанаас бүрдэж байна")
    else:
        _style_rows(ws5, 2, 5, {3: QTY_FMT, 4: QTY_FMT})
    _autosize(ws5, [14, 46, 20, 24, 62])

    wb.save(out_xlsx_path)
