"""Эрхэт систем рүү ШУУД импортлогддог Excel файл бэлдэх дундын хэрэгслүүд.

Асуудал: openpyxl-ийн үүсгэсэн .xlsx-ийн Огноо баганыг Эрхэтийн импорт
"огноо" гэж танихгүй алдаа өгдөг. Хэрэглэгч файлыг Excel-ээр нээж А баганыг
бүхэлд нь сонгоод Short Date формат тавиад Save хийхэд л зөв ордог байсан.

Гар зассан файлтай XML-ийн түвшинд харьцуулахад 3 ялгаа илэрсэн:
  1. Огнооны формат нь custom (numFmtId 164+) байсан — built-in 14 байх ёстой
  2. cellXfs-д `applyNumberFormat="1"` аттрибут дутуу
  3. A1 толгой + баганын түвшний (`<col style>`) формат байхгүй,
     текстүүд inlineStr хэлбэрээр (Excel нь sharedStrings бичдэг)

Тиймээс 3 давхар засвар хийнэ:
  • apply_date_format()      — built-in Short Date-ийг нүд/толгой/багананд
  • postprocess_xlsx()       — applyNumberFormat="1"-ийг нөхнө
  • excel_resave_shortdate() — серверийн Excel-ээр дахин хадгална (баталгаа)

Хамгийн энгийн хэрэглээ — файл үүсгэсний дараа:
    data = finalize_erkhet_xlsx(buf.getvalue())

Excel байхгүй / pywin32 суугаагүй бол 3 дахь алхам алгасаж, эхний 2-той
файлыг буцаана — экспорт хэзээ ч тасрахгүй.
"""
from __future__ import annotations

import io
import re
import threading
import zipfile


# Excel-ийн BUILT-IN "Short Date" формат (numFmtId 14).
# Эрхэт импорт нь зөвхөн built-in огнооны форматыг "огноо" гэж таних тул
# custom "M/D/YYYY" (numFmtId 165) биш ЗААВАЛ энэ built-in-ийг ашиглана.
# Excel нээхэд системийн Short Date-ээр (жишээ 6/30/2026) харуулна.
DATE_FMT = "mm-dd-yy"

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def apply_date_format(ws, col_letter: str, start_row: int, end_row: int) -> None:
    """Тухайн баганы заасан мөрүүдэд Short Date формат тавина.

    Мөн толгойн нүд (1-р мөр) болон баганын түвшний форматыг тавина —
    Excel-д А баганыг БҮХЭЛД нь сонгож Short Date тавихтай ижил үр дүн.
    Эрхэтийн импорт баганын төрлийг толгой/баганын style-аас таамагладаг
    тул зөвхөн дата нүднүүдийг форматлахад хүрэлцдэггүй."""
    for r in range(start_row, end_row + 1):
        ws[f"{col_letter}{r}"].number_format = DATE_FMT
    # Толгойн нүд (текст хэвээр үлдэнэ, зөвхөн формат)
    ws[f"{col_letter}1"].number_format = DATE_FMT
    # Баганын түвшний формат → sheet XML-д <col style=...> бичигдэнэ
    try:
        ws.column_dimensions[col_letter].number_format = DATE_FMT
    except Exception:
        pass


def postprocess_xlsx(data: bytes) -> bytes:
    """styles.xml-ийн cellXfs-д applyNumberFormat="1" дутууг нөхнө.

    openpyxl нь <xf numFmtId="14" .../>-д applyNumberFormat аттрибут
    бичдэггүй. Excel өөрөө уучилж огноогоор харуулдаг ч Эрхэт зэрэг хатуу
    parser форматыг үл тоож Огноо баганыг энгийн тоо гэж уншиж алдаа өгдөг.
    Хэрэглэгч файлыг Excel-ээр нээж Short Date тавиад Save хийхэд яг энэ
    аттрибут нэмэгддэг байсан — одоо үүнийг экспорт болгонд автоматаар хийнэ.
    """
    def _fix_xf(m: "re.Match") -> str:
        attrs, closing = m.group(1), m.group(2)
        if "applyNumberFormat" in attrs:
            return m.group(0)
        fmt = re.search(r'numFmtId="(\d+)"', attrs)
        if not fmt or fmt.group(1) == "0":
            return m.group(0)
        return f'<xf applyNumberFormat="1" {attrs}{closing}>'

    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            content = src.read(item.filename)
            if item.filename == "xl/styles.xml":
                xml = content.decode("utf-8")
                block_m = re.search(r"<cellXfs.*?</cellXfs>", xml, re.S)
                if block_m:
                    block = block_m.group(0)
                    fixed = re.sub(r"<xf ([^>]*?)(/?)>", _fix_xf, block)
                    xml = xml.replace(block, fixed)
                content = xml.encode("utf-8")
            dst.writestr(item, content)
    return out.getvalue()


# Excel COM нэг зэрэг нэг л resave хийнэ (Excel instance-ууд мөргөлдөхгүй)
_excel_resave_lock = threading.Lock()


def excel_resave_shortdate(data: bytes, date_col: str = "A") -> bytes:
    """Файлыг серверийн Excel-ээр нээж огнооны баганыг БҮХЭЛД нь Short Date
    болгоод дахин хадгална — хэрэглэгчийн гар засварыг яг давтана.

    Эрхэтийн импорт openpyxl-ийн үүсгэсэн файлын зарим бүтцийг (inlineStr,
    col style г.м.) уншиж чаддаггүй тул Excel-ийн өөрийнх нь бичсэн файл
    гаргах нь хамгийн баталгаатай. Excel байхгүй / алдаа гарвал анхны
    (openpyxl) файлыг буцаана — экспорт хэзээ ч тасрахгүй."""
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        print("[export] pywin32 суугаагүй — Excel resave алгасав")
        return data

    import os
    import shutil
    import tempfile

    with _excel_resave_lock:
        tmpdir = tempfile.mkdtemp(prefix="erp_xlsx_")
        path = os.path.join(tmpdir, "export.xlsx")
        try:
            with open(path, "wb") as f:
                f.write(data)
            pythoncom.CoInitialize()
            try:
                xl = win32com.client.DispatchEx("Excel.Application")
                try:
                    xl.Visible = False
                    xl.DisplayAlerts = False
                    wb = xl.Workbooks.Open(path)
                    try:
                        for ws in wb.Worksheets:
                            ws.Columns(date_col).NumberFormat = "m/d/yyyy"
                        wb.Save()
                    finally:
                        wb.Close(False)
                finally:
                    xl.Quit()
            finally:
                pythoncom.CoUninitialize()
            with open(path, "rb") as f:
                return f.read()
        except Exception as e:
            print(f"[export] Excel resave алдаа — анхны файлыг ашиглана: {e}")
            return data
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


def finalize_erkhet_xlsx(data: bytes, date_col: str = "A") -> bytes:
    """Эрхэт рүү шууд импортлогдох болгож эцэслэнэ
    (applyNumberFormat нөхөх + Excel-ээр дахин хадгалах)."""
    return excel_resave_shortdate(postprocess_xlsx(data), date_col)
