"""Утсан дээр үзэх «зурагтай барааны жагсаалт» PDF — дундын хэрэгсэл.

  • Барааны зураг: мастерын imageUrl (erxes read-file) — `&width=` жижиг хувилбарыг татаж
    app/data/image_cache-д хадгална (дахин татахгүй; HEIC/0 байт → «зураггүй»).
  • Мастер: код → нэр, ангилал, нэгж үнэ, зураг (master_latest.xlsx, mtime-кэш).
  • build_product_list_pdf(): 360×780pt (iPhone харьцаа) хуудас — лого, гарчиг, огноо, онцлох хайрцаг,
    дарж шилжих бүлгийн жагсаалт (+ bookmark), бүлгээр мөрүүд: зураг · нэр · 1-2 мөр мэдээлэл · баруун талын утга.

Ашигладаг: «Агуулахад буусан барааны жагсаалт» (api/arrival_list.py),
           «Хөдөлгөөнгүй барааны жагсаалт» (scripts/no_movement_report.py).
"""
from __future__ import annotations

import hashlib
import io
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

COMPANY = "Бүтэн-Оргил ХХК"
MASTER_FILE = Path("app/data/outputs/master_latest.xlsx")
IMG_CACHE = Path("app/data/image_cache")
LOGO = Path(__file__).resolve().parents[1] / "assets" / "butenorgil_logo.png"
FONT_REG = "C:/Windows/Fonts/NotoSans-Regular.ttf"
FONT_BOLD = "C:/Windows/Fonts/NotoSans-Bold.ttf"
FONT_FALLBACK = ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf")
THUMB_PX = 180            # утсан дээр ~60pt × 3 (retina)
FAIL_TTL = 6 * 3600       # татаж чадаагүй зургийг (HEIC, 0 байт) 6 цаг дахин оролдохгүй


def norm_code(v) -> str:
    s = re.sub(r"\.0$", "", str(v if v is not None else "").strip())
    return re.sub(r"\s+", "", s)


def _price(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(re.sub(r"[^\d.\-]", "", str(v or "")) or 0)
    except ValueError:
        return 0.0


# ── Мастер (код → нэр, ангилал, үнэ, зураг) ─────────────────────────────────────

_MASTER: dict = {"mtime": None, "map": {}}
_MASTER_LOCK = threading.Lock()


def master_products() -> dict[str, dict]:
    if not MASTER_FILE.exists():
        return {}
    mtime = MASTER_FILE.stat().st_mtime
    if _MASTER["mtime"] == mtime:
        return _MASTER["map"]
    with _MASTER_LOCK:
        if _MASTER["mtime"] == mtime:
            return _MASTER["map"]
        from python_calamine import CalamineWorkbook
        wb = CalamineWorkbook.from_path(str(MASTER_FILE))
        sheet = "Нэгтгэл" if "Нэгтгэл" in wb.sheet_names else wb.sheet_names[0]
        rows = wb.get_sheet_by_name(sheet).to_python()
        ix = {str(c).strip(): i for i, c in enumerate(rows[0])} if rows else {}
        g = lambda r, k: r[ix[k]] if k in ix and ix[k] < len(r) else None
        out = {}
        for r in rows[1:]:
            code = norm_code(g(r, "Код"))
            if not code:
                continue
            img = str(g(r, "imageUrl") or "").strip()
            out[code] = {"name": str(g(r, "Нэр") or "").strip(), "cat": str(g(r, "Ангилал нэр") or "").strip(),
                         "price": _price(g(r, "Нэгж үнэ")), "img": img if img.startswith("http") else ""}
        _MASTER.update(mtime=mtime, map=out)
        return out


# ── Зургийн жижиг хувилбар (thumbnail) — диск кэш ──────────────────────────────

_EXEC = ThreadPoolExecutor(max_workers=12, thread_name_prefix="product-img")
_INFLIGHT: dict[str, Future] = {}
_IF_LOCK = threading.Lock()
_HTTP = None


def _http():
    global _HTTP
    if _HTTP is None:
        import requests
        s = requests.Session()
        s.mount("https://", requests.adapters.HTTPAdapter(pool_connections=16, pool_maxsize=16))
        _HTTP = s
    return _HTTP


def thumb_path(url: str) -> Path:
    return IMG_CACHE / f"{hashlib.sha1(url.encode('utf-8')).hexdigest()}.jpg"


def thumb_state(url: str) -> str:
    """ready | failed | pending"""
    p = thumb_path(url)
    if p.exists() and p.stat().st_size > 0:
        return "ready"
    f = p.with_suffix(".fail")
    if f.exists() and time.time() - f.stat().st_mtime < FAIL_TTL:
        return "failed"
    return "pending"


def _thumb_src(url: str) -> str:
    """erxes read-file: key-г зөв кодлоод (& + тэмдэгттэй нэр) жижгэрүүлэх width нэмнэ."""
    base, sep, key = url.partition("?key=")
    if not sep:
        return url
    key = key.split("&width=")[0]
    return f"{base}?key={quote(key, safe='/')}&width={THUMB_PX}"


def fetch_thumb(url: str) -> bool:
    from PIL import Image, ImageOps
    p = thumb_path(url)
    if p.exists() and p.stat().st_size > 0:
        return True
    IMG_CACHE.mkdir(parents=True, exist_ok=True)
    try:
        r = _http().get(_thumb_src(url), timeout=20)
        if r.status_code != 200 or not r.content:
            raise ValueError(f"HTTP {r.status_code}, {len(r.content)} байт")
        im = Image.open(io.BytesIO(r.content))
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.getchannel("A"))
            im = bg
        else:
            im = im.convert("RGB")
        im.thumbnail((THUMB_PX, THUMB_PX))
        tmp = p.with_suffix(".tmp")
        im.save(tmp, "JPEG", quality=72, optimize=True)
        tmp.replace(p)
        return True
    except Exception as e:                                        # HEIC, 0 байт, сүлжээ — зураггүй гэж үзнэ
        try:
            p.with_suffix(".fail").write_text(f"{url}\n{e}", encoding="utf-8")
        except OSError:
            pass
        return False


def prefetch(urls) -> list[Future]:
    """Кэшгүй зургуудыг background-д татна (давхар татахгүй). Хүлээх future-уудыг буцаана."""
    futs = []
    with _IF_LOCK:
        for u in urls:
            if not u or thumb_state(u) != "pending":
                continue
            f = _INFLIGHT.get(u)
            if f is None or f.done():
                f = _EXEC.submit(fetch_thumb, u)
                _INFLIGHT[u] = f
                f.add_done_callback(lambda _f, _u=u: _INFLIGHT.pop(_u, None))
            futs.append(f)
    return futs


def wait_images(urls, timeout: float = 45) -> None:
    """PDF-ээс өмнө кэшгүй зургийг татаж хүлээнэ (proxy-ийн хугацаанд багтаана; үлдсэн нь дараагийн удаа)."""
    futs = prefetch(urls)
    if futs:
        wait(futs, timeout=timeout)


def image_stats(urls: list[str]) -> dict:
    st = {"ready": 0, "failed": 0, "pending": 0}
    for u in urls:
        st[thumb_state(u)] += 1
    return st


# ── PDF (iPhone хэмжээ: 360×780pt ≈ 9:19.5) ────────────────────────────────────

PW, PH = 360.0, 780.0
M = 14.0                      # хажуугийн зай
CW = PW - 2 * M
FOOT = 26.0
GREEN = (11, 93, 30)
GREEN_L = (234, 245, 236)
INK = (31, 41, 55)
GRAY = (107, 114, 128)
LINE = (229, 231, 235)
RED = (185, 28, 28)
IMG = 60.0
RIGHT_W = 84.0
COLORS = {"green": GREEN, "gray": GRAY, "ink": INK, "red": RED}


def fmt_d(d) -> str:
    return f"{d:%Y.%m.%d}"


def fit(pdf, text: str, w: float) -> str:
    """Өргөнд багтахгүй бол «…»-ээр тасална (одоогийн фонтоор хэмжинэ)."""
    if pdf.get_string_width(text) <= w:
        return text
    while text and pdf.get_string_width(text + "…") > w:
        text = text[:-1]
    return text.rstrip() + "…"


def build_product_list_pdf(*, title: str, period: str, groups: list, group_noun: str = "ангилал",
                           box: dict | None = None, note: str | None = None, warn: str | None = None,
                           empty_text: str = "Бараа алга.", footer_left: str = COMPANY,
                           footer_link: str | None = None, doc_title: str | None = None) -> bytes:
    """groups = [(label, [row, …]), …]; row = {"img", "name", "line2", "line3"?, "right", "right_sub"?,
    "right_color"?: green|gray|ink|red}. box = {"label", "big", "small"?, "link"?} — нүүрний онцлох хайрцаг.
    note (саарал) / warn (улаан) — хайрцгийн доорх тайлбар; бараа алга бол нүүрэнд empty_text."""
    from fpdf import FPDF
    from PIL import Image

    printed = datetime.now().strftime("%Y.%m.%d %H:%M")

    class PDF(FPDF):
        def footer(self):
            self.set_y(PH - FOOT + 6)
            self.set_draw_color(*LINE)
            self.line(M, PH - FOOT + 2, PW - M, PH - FOOT + 2)
            self.set_font("Main", "", 7.5)
            self.set_text_color(*GRAY)
            self.set_x(M)
            self.cell(CW - 50, 12, f"{footer_left} · {printed}", link=footer_link or "")
            self.cell(50, 12, f"{self.page_no()} / {{nb}}", align="R")

    pdf = PDF(orientation="P", unit="pt", format=(PW, PH))
    reg, bold = (FONT_REG, FONT_BOLD) if Path(FONT_REG).exists() and Path(FONT_BOLD).exists() else FONT_FALLBACK
    pdf.add_font("Main", "", reg)
    pdf.add_font("Main", "B", bold)
    pdf.set_margins(M, M, M)
    pdf.set_auto_page_break(False)
    pdf.set_title(doc_title or f"{title} {period}")
    pdf.set_author(COMPANY)
    pdf.set_creator(COMPANY)
    total = sum(len(its) for _, its in groups)

    # ── Нүүр: лого, гарчиг, огноо, онцлох хайрцаг ──
    pdf.add_page()
    y = 18.0
    if LOGO.exists():
        lw = 150.0
        with Image.open(LOGO) as li:
            lh = lw * li.height / li.width
        pdf.image(str(LOGO), x=(PW - lw) / 2, y=y, w=lw, h=lh)
        y += lh + 12
    pdf.set_text_color(*GREEN)
    pdf.set_font("Main", "B", 17)
    pdf.set_xy(M, y)
    pdf.multi_cell(CW, 21, title, align="C")
    y = pdf.get_y() + 4
    pdf.set_text_color(*INK)
    pdf.set_font("Main", "", 12)
    pdf.set_xy(M, y)
    pdf.cell(CW, 16, f"Огноо: {period}", align="C")
    y += 24

    if box:
        bh = 66.0 if box.get("small") else 50.0
        pdf.set_fill_color(*GREEN_L)
        pdf.rect(M, y, CW, bh, style="F", round_corners=True, corner_radius=8)
        pdf.set_text_color(*GRAY)
        pdf.set_font("Main", "", 9.5)
        pdf.set_xy(M, y + 7)
        pdf.cell(CW, 12, box.get("label", ""), align="C")
        pdf.set_text_color(*GREEN)
        pdf.set_font("Main", "B", 19)
        pdf.set_xy(M, y + 20)
        pdf.cell(CW, 22, box.get("big", ""), align="C")
        if box.get("small"):
            pdf.set_text_color(*INK)
            pdf.set_font("Main", "", 10.5)
            pdf.set_xy(M, y + 44)
            pdf.cell(CW, 14, fit(pdf, box["small"], CW - 8), align="C")
        if box.get("link"):
            pdf.link(M, y, CW, bh, box["link"])
        y += bh + 12
    for text, color, style in ((note, GRAY, ""), (warn, RED, "B")):
        if text:
            pdf.set_text_color(*color)
            pdf.set_font("Main", style, 9)
            pdf.set_xy(M + 6, y)
            pdf.multi_cell(CW - 12, 12, text, align="C")
            y = pdf.get_y() + 8
    if not total:
        pdf.set_text_color(*GREEN)
        pdf.set_font("Main", "B", 13)
        pdf.set_xy(M, y + 10)
        pdf.multi_cell(CW, 18, empty_text, align="C")
        return bytes(pdf.output())

    pdf.set_text_color(*GRAY)
    pdf.set_font("Main", "", 9.5)
    pdf.set_xy(M, y)
    pdf.cell(CW, 12, f"Нийт {total:,} бараа · {len(groups)} {group_noun} · {group_noun} дээр дарж шилжинэ", align="C")
    y += 20

    # ── Бүлгийн жагсаалт (дарахад тухайн хэсэг рүү үсэрнэ) ──
    links = []
    row_h = 21.0
    for label, its in groups:
        if y + row_h > PH - FOOT - 4:
            pdf.add_page()
            y = M + 4
        link = pdf.add_link()
        links.append(link)
        pdf.set_draw_color(*LINE)
        pdf.line(M, y + row_h, PW - M, y + row_h)
        pdf.set_text_color(*INK)
        pdf.set_font("Main", "", 11)
        pdf.set_xy(M + 2, y + 3)
        pdf.cell(CW - 60, 15, fit(pdf, label, CW - 64), link=link)
        pdf.set_text_color(*GREEN)
        pdf.set_font("Main", "B", 11)
        pdf.set_xy(PW - M - 58, y + 3)
        pdf.cell(56, 15, f"{len(its)}  ›", align="R", link=link)
        y += row_h

    # ── Бараанууд бүлгээр ──
    def group_header(label: str, n: int, cont: bool):
        nonlocal y
        h = 28.0
        pdf.set_fill_color(*(GREEN if not cont else GREEN_L))
        pdf.rect(M, y, CW, h, style="F", round_corners=True, corner_radius=6)
        pdf.set_text_color(*((255, 255, 255) if not cont else GREEN))
        pdf.set_font("Main", "B", 12.5)
        pdf.set_xy(M + 10, y + 6)
        pdf.cell(CW - 90, 16, fit(pdf, label + (" (үргэлжлэл)" if cont else ""), CW - 92))
        pdf.set_font("Main", "", 10)
        pdf.set_xy(PW - M - 80, y + 6)
        pdf.cell(70, 16, f"{n} бараа", align="R")
        y += h + 4

    def new_page():
        nonlocal y
        pdf.add_page()
        y = M

    tx = M + IMG + 10
    tw = CW - IMG - 10 - RIGHT_W - 4
    new_page()                                                    # нүүр + бүлгийн жагсаалтаас тусдаа
    for gi, (label, its) in enumerate(groups):
        if y > PH - FOOT - 32 - 80:                                # толгой + дор хаяж 1 бараа багтахгүй бол
            new_page()
        pdf.start_section(label)
        pdf.set_link(links[gi], y=y, page=pdf.page)
        group_header(label, len(its), False)
        for it in its:
            pdf.set_font("Main", "B", 12)
            lines = pdf.multi_cell(tw, 14.5, it.get("name") or "", dry_run=True, output="LINES")
            if len(lines) > 3:
                lines = lines[:3]
                lines[2] = lines[2].rstrip()[: max(1, len(lines[2]) - 2)] + "…"
            extra = [t for t in (it.get("line2"), it.get("line3")) if t]
            text_h = len(lines) * 14.5 + sum(4 + 13 for _ in extra)
            rh = max(IMG + 12, text_h + 16)
            if y + rh > PH - FOOT - 2:
                new_page()
                group_header(label, len(its), True)
            # зураг
            bx, by = M, y + (rh - IMG) / 2
            pdf.set_draw_color(*LINE)
            pdf.set_fill_color(248, 250, 249)
            pdf.rect(bx, by, IMG, IMG, style="DF", round_corners=True, corner_radius=6)
            path = thumb_path(it["img"]) if it.get("img") else None
            drawn = False
            if path and path.exists() and path.stat().st_size > 0:
                try:
                    with Image.open(path) as im:
                        iw, ih = im.size
                    s = (IMG - 4) / max(iw, ih)
                    w, h = iw * s, ih * s
                    pdf.image(str(path), x=bx + (IMG - w) / 2, y=by + (IMG - h) / 2, w=w, h=h)
                    drawn = True
                except Exception:
                    drawn = False
            if not drawn:
                pdf.set_text_color(170, 176, 184)
                pdf.set_font("Main", "", 7.5)
                pdf.set_xy(bx, by + IMG / 2 - 5)
                pdf.cell(IMG, 10, "зураггүй", align="C")
            # нэр + мэдээллийн мөрүүд
            ty = y + (rh - text_h) / 2
            pdf.set_text_color(*INK)
            pdf.set_font("Main", "B", 12)
            for i, ln in enumerate(lines):
                pdf.set_xy(tx, ty + i * 14.5)
                pdf.cell(tw, 14.5, ln)
            yy = ty + len(lines) * 14.5
            pdf.set_text_color(*GRAY)
            pdf.set_font("Main", "", 10)
            for t in extra:
                pdf.set_xy(tx, yy + 4)
                pdf.cell(tw, 13, fit(pdf, t, tw))
                yy += 4 + 13
            # баруун талын утга (+ доор нь тайлбар)
            sub = it.get("right_sub")
            right, size = it.get("right") or "", 13.5
            pdf.set_text_color(*COLORS.get(it.get("right_color") or "green", GREEN))
            pdf.set_font("Main", "B", size)
            while size > 9 and pdf.get_string_width(right) > RIGHT_W - 2:   # том дүн багтахгүй бол жижигрүүлнэ
                size -= 0.5
                pdf.set_font("Main", "B", size)
            pdf.set_xy(PW - M - RIGHT_W, y + rh / 2 - (15 if sub else 9))
            pdf.cell(RIGHT_W, 18, right, align="R")
            if sub:
                pdf.set_text_color(*GRAY)
                pdf.set_font("Main", "", 9)
                pdf.set_xy(PW - M - RIGHT_W, y + rh / 2 + 3)
                pdf.cell(RIGHT_W, 12, fit(pdf, sub, RIGHT_W), align="R")
            # тусгаарлагч
            pdf.set_draw_color(*LINE)
            pdf.line(tx, y + rh, PW - M, y + rh)
            y += rh
        y += 10
    return bytes(pdf.output())
