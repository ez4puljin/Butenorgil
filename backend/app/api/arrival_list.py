"""Агуулахад буусан барааны жагсаалт — утсан дээр үзэхэд зориулсан PDF.

Сонгосон огнооны хооронд 01, 02, 11, 12 байршилд (Бөөний, Ус ундаа архи пиво, Жижиглэн,
Гэрээт компаний агуулах) орлого авсан бараанууд — Эрхэтийн орлогын файлаас (Файл оруулалт →
Орлогын файл). Код, нэр, ангилал, нэгж үнэ, зургийг барааны мастер Excel-ээс авна.

  GET /reports/arrivals?date_from=&date_to=&locations=01,02,11,12   — урьдчилсан тоо + зургийн бэлэн байдал
  GET /reports/arrivals/pdf?...                                    — PDF (iPhone 9:19.5 хуудас, ангиллаар)

Зураг: мастерын imageUrl (erxes read-file) — `&width=` параметрээр жижиг хувилбарыг татаж
app/data/image_cache-д хадгална (дахин татахгүй). warm loop сүүлийн 14 хоногийн орлогын
зургийг урьдчилан татна — PDF хурдан гарна.
"""
from __future__ import annotations

import hashlib
import io
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.api.deps import require_role

router = APIRouter(prefix="/reports", tags=["arrivals"])
ROLES = ("admin", "supervisor", "manager")

DEFAULT_LOCATIONS = ("01", "02", "11", "12")
ORDER_PHONE = "85813818"
ORDER_CONTACT = "Орон нутгийн ХТ - Долгор"
COMPANY = "Бүтэн-Оргил ХХК"
TITLE = "Агуулахад буусан барааны жагсаалт"

INCOME_DIR = Path("app/data/uploads/income")
MASTER_FILE = Path("app/data/outputs/master_latest.xlsx")
IMG_CACHE = Path("app/data/image_cache")
LOGO = Path(__file__).resolve().parents[1] / "assets" / "butenorgil_logo.png"
FONT_REG = "C:/Windows/Fonts/NotoSans-Regular.ttf"
FONT_BOLD = "C:/Windows/Fonts/NotoSans-Bold.ttf"
FONT_FALLBACK = ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf")

THUMB_PX = 180            # утсан дээр ~60pt × 3 (retina)
FAIL_TTL = 6 * 3600       # татаж чадаагүй зургийг (HEIC, 0 байт) 6 цаг дахин оролдохгүй


def _norm_code(v) -> str:
    s = re.sub(r"\.0$", "", str(v if v is not None else "").strip())
    return re.sub(r"\s+", "", s)


def _to_date(v) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, (int, float)) and v > 20000:                 # Excel serial
        return date(1899, 12, 30) + timedelta(days=int(v))
    s = str(v or "").strip()[:10]
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def _loc_code(v) -> str:
    s = _norm_code(v)
    return s.zfill(2) if s.isdigit() and len(s) < 2 else s


# ── Орлогын мөрүүд (байршлын кодтой) — файл бүрийн mtime-кэш ─────────────────────

_INC: dict[str, tuple[float, list]] = {}
_INC_LOCK = threading.Lock()


def _parse_income(path: Path) -> list[tuple]:
    """→ [(date, code, name, loc_code, loc_name, qty)]"""
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(path))
    rows = wb.get_sheet_by_name(wb.sheet_names[0]).to_python()
    hi = next((i for i, r in enumerate(rows[:25]) if any(str(c).strip() == "Байршил нэр" for c in r)), -1)
    if hi < 0:
        return []
    ix = {str(c).strip(): i for i, c in enumerate(rows[hi])}
    need = ("Огноо", "Бараа материал код", "Байршил нэр")
    if any(k not in ix for k in need):
        return []
    g = lambda r, k: r[ix[k]] if k in ix and ix[k] < len(r) else None
    out = []
    for r in rows[hi + 1:]:
        d = _to_date(g(r, "Огноо"))
        code = _norm_code(g(r, "Бараа материал код"))
        if not d or not code or code.lower() == "nan":
            continue
        try:
            qty = float(g(r, "Тоо хэмжээ") or 0)
        except (TypeError, ValueError):
            qty = 0.0
        out.append((d, code, str(g(r, "Бараа материал нэр") or "").strip(), _loc_code(g(r, "Байршил код")),
                    str(g(r, "Байршил нэр") or "").strip(), qty))
    return out


def _income_rows(d1: date, d2: date) -> list[tuple]:
    """[d1, d2]-тэй давхцах орлогын файлуудын мөрүүд (сарын файлтай онд бүтэн оны файлыг алгасна)."""
    from app.core.db import SessionLocal
    from app.models.income_file import IncomeFile
    db = SessionLocal()
    try:
        files = db.query(IncomeFile).all()
        monthly_years = {f.year for f in files if (f.month or 0) > 0}
        picked = []
        for f in files:
            m = f.month or 0
            if not f.stored_filename or (m == 0 and f.year in monthly_years):
                continue
            if m:
                start = date(f.year, m, 1)
                end = (date(f.year + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
            else:
                start, end = date(f.year, 1, 1), date(f.year, 12, 31)
            if start <= d2 and end >= d1:
                picked.append(f.stored_filename)
    finally:
        db.close()
    out: list = []
    for fname in sorted(picked):
        path = INCOME_DIR / fname
        if not path.exists():
            continue
        mtime = path.stat().st_mtime
        hit = _INC.get(str(path))
        if not hit or hit[0] != mtime:
            with _INC_LOCK:
                hit = _INC.get(str(path))
                if not hit or hit[0] != mtime:
                    try:
                        hit = (mtime, _parse_income(path))
                    except Exception as e:                       # эвдэрсэн файл бусдыг саатуулахгүй
                        print(f"[arrivals] {fname} уншиж чадсангүй: {e}")
                        hit = (mtime, [])
                    _INC[str(path)] = hit
        out.extend(r for r in hit[1] if d1 <= r[0] <= d2)
    return out


# ── Мастер (код → нэр, ангилал, үнэ, зураг) ─────────────────────────────────────

_MASTER: dict = {"mtime": None, "map": {}}
_MASTER_LOCK = threading.Lock()


def _price(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(re.sub(r"[^\d.\-]", "", str(v or "")) or 0)
    except ValueError:
        return 0.0


def _master() -> dict[str, dict]:
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
            code = _norm_code(g(r, "Код"))
            if not code:
                continue
            img = str(g(r, "imageUrl") or "").strip()
            out[code] = {"name": str(g(r, "Нэр") or "").strip(), "cat": str(g(r, "Ангилал нэр") or "").strip(),
                         "price": _price(g(r, "Нэгж үнэ")), "img": img if img.startswith("http") else ""}
        _MASTER.update(mtime=mtime, map=out)
        return out


NOT_IN_MASTER = "__not_in_master__"      # дотоод тэмдэглэгээ — PDF-д «Бусад» гэж гарна
OTHER_LABEL = "Бусад"


def _cat_key(cat: str) -> tuple[int, str]:
    """«905 Хятад бараа» → (905, «Хятад бараа»). «923 +Тамхи», «926 925 - Хатаасан мах» шиг
    давхар код/тэмдгийг цэвэрлэнэ. Мастерт бүртгэлгүй нь «Бусад» — хамгийн сүүлд."""
    if cat == NOT_IN_MASTER:
        return (10 ** 6, OTHER_LABEL)
    raw = (cat or "").strip()
    m = re.match(r"^(\d+)", raw)
    code = int(m.group(1)) if m else 99999
    label = re.sub(r"^(\d+\s*[-.–]?\s*)+", "", raw).lstrip("+-–. ").strip()
    return (code, label or raw or "Ангилалгүй")


def _collect(d1: date, d2: date, locations: tuple[str, ...]) -> dict:
    """Сонгосон хугацаа, байршлын орлого → бараа (давхардалгүй) ангиллаар бүлэглэсэн."""
    rows = _income_rows(d1, d2)
    master = _master()
    locs: dict[str, dict] = {}
    items: dict[str, dict] = {}
    for d, code, name, lc, ln, qty in rows:
        li = locs.setdefault(lc, {"code": lc, "name": ln, "rows": 0})
        li["rows"] += 1
        if lc not in locations or qty <= 0:
            continue
        it = items.get(code)
        if it is None:
            m = master.get(code)
            items[code] = it = {
                "code": code, "name": (m or {}).get("name") or name, "cat": (m or {}).get("cat") or NOT_IN_MASTER,
                "price": (m or {}).get("price") or 0.0, "img": (m or {}).get("img") or "",
                "in_master": m is not None, "last": d,
            }
        elif d > it["last"]:
            it["last"] = d
    # Нэр ижил ангиллыг (жишээ 504 Саван, 508 Саван) нэг бүлэг болгоно
    groups: dict[str, list] = {}
    order: dict[str, int] = {}
    for it in items.values():
        code, label = _cat_key(it["cat"])
        groups.setdefault(label, []).append(it)
        order[label] = min(order.get(label, code), code)
    labels = sorted(groups, key=lambda lb: (order[lb], lb))
    for lb in labels:
        groups[lb].sort(key=lambda x: (x["name"].lower(), x["code"]))
    return {"groups": [(lb, lb, groups[lb]) for lb in labels],
            "count": len(items), "locations": sorted(locs.values(), key=lambda x: x["code"]),
            "data_until": max((r[0] for r in rows), default=None)}


# ── Зургийн жижиг хувилбар (thumbnail) — диск кэш ──────────────────────────────

_EXEC = ThreadPoolExecutor(max_workers=12, thread_name_prefix="arrival-img")
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


def _thumb_path(url: str) -> Path:
    return IMG_CACHE / f"{hashlib.sha1(url.encode('utf-8')).hexdigest()}.jpg"


def _thumb_state(url: str) -> str:
    """ready | failed | pending"""
    p = _thumb_path(url)
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


def _fetch_thumb(url: str) -> bool:
    from PIL import Image, ImageOps
    p = _thumb_path(url)
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


def _prefetch(urls) -> list[Future]:
    """Кэшгүй зургуудыг background-д татна (давхар татахгүй). Хүлээх future-уудыг буцаана."""
    futs = []
    with _IF_LOCK:
        for u in urls:
            if not u or _thumb_state(u) != "pending":
                continue
            f = _INFLIGHT.get(u)
            if f is None or f.done():
                f = _EXEC.submit(_fetch_thumb, u)
                _INFLIGHT[u] = f
                f.add_done_callback(lambda _f, _u=u: _INFLIGHT.pop(_u, None))
            futs.append(f)
    return futs


def _image_stats(urls: list[str]) -> dict:
    st = {"ready": 0, "failed": 0, "pending": 0}
    for u in urls:
        st[_thumb_state(u)] += 1
    return st


def warm_arrival_images() -> None:
    """main-ийн warm loop-оос — сүүлийн 14 хоногийн орлогын зургийг урьдчилан татна (хүлээхгүй)."""
    try:
        today = date.today()
        data = _collect(today - timedelta(days=14), today, DEFAULT_LOCATIONS)
        _prefetch([it["img"] for _, _, its in data["groups"] for it in its if it["img"]])
    except Exception as e:
        print(f"[arrivals] warm алдаа: {e}")


# ── API ──────────────────────────────────────────────────────────────────────

def _params(date_from: str, date_to: str, locations: str) -> tuple[date, date, tuple[str, ...]]:
    d1, d2 = _to_date(date_from), _to_date(date_to)
    if not d1 or not d2:
        raise HTTPException(400, "Огноо буруу байна.")
    if d1 > d2:
        raise HTTPException(400, "Эхлэх огноо дуусах огнооноос хойш байна.")
    if (d2 - d1).days > 370:
        raise HTTPException(400, "Нэг жилээс урт хугацаа сонгох боломжгүй.")
    locs = tuple(dict.fromkeys(_loc_code(x) for x in (locations or "").split(",") if x.strip())) or DEFAULT_LOCATIONS
    return d1, d2, locs


@router.get("/arrivals")
def arrivals_preview(date_from: str = Query(...), date_to: str = Query(...),
                     locations: str = Query(",".join(DEFAULT_LOCATIONS), max_length=100),
                     _=Depends(require_role(*ROLES))):
    d1, d2, locs = _params(date_from, date_to, locations)
    data = _collect(d1, d2, locs)
    urls = [it["img"] for _, _, its in data["groups"] for it in its if it["img"]]
    _prefetch(urls)                                               # PDF-ээс өмнө зургийг бэлдэж эхэлнэ
    return {
        "date_from": d1.isoformat(), "date_to": d2.isoformat(), "locations": list(locs),
        "available_locations": data["locations"], "count": data["count"],
        "categories": [{"name": label, "count": len(its)} for _, label, its in data["groups"]],
        "no_image_url": sum(1 for _, _, its in data["groups"] for it in its if not it["img"]),
        "not_in_master": sum(1 for _, _, its in data["groups"] for it in its if not it["in_master"]),
        "no_price": sum(1 for _, _, its in data["groups"] for it in its if not it["price"]),
        "images": {"total": len(urls), **_image_stats(urls)},
        "data_until": data["data_until"].isoformat() if data["data_until"] else None,
        "order_phone": ORDER_PHONE, "order_contact": ORDER_CONTACT,
    }


@router.get("/arrivals/pdf")
def arrivals_pdf(date_from: str = Query(...), date_to: str = Query(...),
                 locations: str = Query(",".join(DEFAULT_LOCATIONS), max_length=100),
                 _=Depends(require_role(*ROLES))):
    d1, d2, locs = _params(date_from, date_to, locations)
    data = _collect(d1, d2, locs)
    if not data["count"]:
        raise HTTPException(404, "Сонгосон хугацаанд эдгээр байршилд орлого авсан бараа алга.")
    urls = [it["img"] for _, _, its in data["groups"] for it in its if it["img"]]
    futs = _prefetch(urls)
    if futs:
        wait(futs, timeout=45)                                    # proxy-ийн хугацаанд багтаана; үлдсэн нь дараагийн удаа
    pdf = _build_pdf(d1, d2, data)
    fname = f"Агуулахад_буусан_бараа_{d1:%Y-%m-%d}_{d2:%Y-%m-%d}.pdf"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename=arrivals_{d1:%Y%m%d}_{d2:%Y%m%d}.pdf; "
                                                    f"filename*=UTF-8''{quote(fname)}"})


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
IMG = 60.0
PRICE_W = 84.0


def _fmt_price(p: float) -> str:
    return f"{int(round(p)):,}₮" if p and p > 0 else "—"


def _fmt_d(d: date) -> str:
    return f"{d:%Y.%m.%d}"


def _fit(pdf, text: str, w: float) -> str:
    """Өргөнд багтахгүй бол «…»-ээр тасална (одоогийн фонтоор хэмжинэ)."""
    if pdf.get_string_width(text) <= w:
        return text
    while text and pdf.get_string_width(text + "…") > w:
        text = text[:-1]
    return text.rstrip() + "…"


def _build_pdf(d1: date, d2: date, data: dict) -> bytes:
    from fpdf import FPDF
    from PIL import Image

    period = _fmt_d(d1) if d1 == d2 else f"{_fmt_d(d1)} – {_fmt_d(d2)}"
    printed = datetime.now().strftime("%Y.%m.%d %H:%M")

    class PDF(FPDF):
        def footer(self):
            self.set_y(PH - FOOT + 6)
            self.set_draw_color(*LINE)
            self.line(M, PH - FOOT + 2, PW - M, PH - FOOT + 2)
            self.set_font("Main", "", 7.5)
            self.set_text_color(*GRAY)
            left = f"{COMPANY} · Захиалга: {ORDER_PHONE} · {printed}"
            self.set_x(M)
            self.cell(CW - 50, 12, left, link=f"tel:{ORDER_PHONE}")
            self.cell(50, 12, f"{self.page_no()} / {{nb}}", align="R")

    pdf = PDF(orientation="P", unit="pt", format=(PW, PH))
    reg, bold = (FONT_REG, FONT_BOLD) if Path(FONT_REG).exists() and Path(FONT_BOLD).exists() else FONT_FALLBACK
    pdf.add_font("Main", "", reg)
    pdf.add_font("Main", "B", bold)
    pdf.set_margins(M, M, M)
    pdf.set_auto_page_break(False)
    pdf.set_title(f"{TITLE} {period}")
    pdf.set_author(COMPANY)
    pdf.set_creator(COMPANY)

    groups = data["groups"]
    total = data["count"]

    # ── Нүүр: лого, гарчиг, огноо, захиалгын утас ──
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
    pdf.multi_cell(CW, 21, TITLE, align="C")
    y = pdf.get_y() + 4
    pdf.set_text_color(*INK)
    pdf.set_font("Main", "", 12)
    pdf.set_xy(M, y)
    pdf.cell(CW, 16, f"Огноо: {period}", align="C")
    y += 24

    # Захиалгын утас — дарж залгана (tel:)
    bh = 66.0
    pdf.set_fill_color(*GREEN_L)
    pdf.rect(M, y, CW, bh, style="F", round_corners=True, corner_radius=8)
    pdf.set_text_color(*GRAY)
    pdf.set_font("Main", "", 9.5)
    pdf.set_xy(M, y + 7)
    pdf.cell(CW, 12, "Захиалгын утас", align="C")
    pdf.set_text_color(*GREEN)
    pdf.set_font("Main", "B", 19)
    pdf.set_xy(M, y + 20)
    pdf.cell(CW, 22, ORDER_PHONE, align="C")
    pdf.set_text_color(*INK)
    pdf.set_font("Main", "", 10.5)
    pdf.set_xy(M, y + 44)
    pdf.cell(CW, 14, f"({ORDER_CONTACT})", align="C")
    pdf.link(M, y, CW, bh, f"tel:{ORDER_PHONE}")
    y += bh + 12

    pdf.set_text_color(*GRAY)
    pdf.set_font("Main", "", 9.5)
    pdf.set_xy(M, y)
    pdf.cell(CW, 12, f"Нийт {total:,} бараа · {len(groups)} ангилал · ангилал дээр дарж шилжинэ", align="C")
    y += 20

    # ── Ангиллын жагсаалт (дарахад тухайн хэсэг рүү үсэрнэ) ──
    links = {}
    row_h = 21.0
    for cat, label, its in groups:
        if y + row_h > PH - FOOT - 4:
            pdf.add_page()
            y = M + 4
        link = pdf.add_link()
        links[cat] = link
        pdf.set_draw_color(*LINE)
        pdf.line(M, y + row_h, PW - M, y + row_h)
        pdf.set_text_color(*INK)
        pdf.set_font("Main", "", 11)
        pdf.set_xy(M + 2, y + 3)
        pdf.cell(CW - 60, 15, _fit(pdf, label, CW - 64), link=link)
        pdf.set_text_color(*GREEN)
        pdf.set_font("Main", "B", 11)
        pdf.set_xy(PW - M - 58, y + 3)
        pdf.cell(56, 15, f"{len(its)}  ›", align="R", link=link)
        y += row_h

    # ── Бараанууд ангиллаар ──
    def cat_header(label: str, n: int, cont: bool):
        nonlocal y
        h = 28.0
        pdf.set_fill_color(*(GREEN if not cont else GREEN_L))
        pdf.rect(M, y, CW, h, style="F", round_corners=True, corner_radius=6)
        pdf.set_text_color(*((255, 255, 255) if not cont else GREEN))
        pdf.set_font("Main", "B", 12.5)
        pdf.set_xy(M + 10, y + 6)
        pdf.cell(CW - 90, 16, _fit(pdf, label + (" (үргэлжлэл)" if cont else ""), CW - 92))
        pdf.set_font("Main", "", 10)
        pdf.set_xy(PW - M - 80, y + 6)
        pdf.cell(70, 16, f"{n} бараа", align="R")
        y += h + 4

    def new_page():
        nonlocal y
        pdf.add_page()
        y = M

    tx = M + IMG + 10
    tw = CW - IMG - 10 - PRICE_W - 4
    new_page()                                                    # нүүр + ангиллын жагсаалтаас тусдаа
    for cat, label, its in groups:
        if y > PH - FOOT - 32 - 80:                                # толгой + дор хаяж 1 бараа багтахгүй бол
            new_page()
        pdf.start_section(label)
        pdf.set_link(links[cat], y=y, page=pdf.page)
        cat_header(label, len(its), False)
        for it in its:
            pdf.set_font("Main", "B", 12)
            lines = pdf.multi_cell(tw, 14.5, it["name"] or it["code"], dry_run=True, output="LINES")
            if len(lines) > 3:
                lines = lines[:3]
                lines[2] = lines[2].rstrip()[: max(1, len(lines[2]) - 2)] + "…"
            rh = max(IMG + 12, 8 + len(lines) * 14.5 + 4 + 13 + 8)
            if y + rh > PH - FOOT - 2:
                new_page()
                cat_header(label, len(its), True)
            # зураг
            bx, by = M, y + (rh - IMG) / 2
            pdf.set_draw_color(*LINE)
            pdf.set_fill_color(248, 250, 249)
            pdf.rect(bx, by, IMG, IMG, style="DF", round_corners=True, corner_radius=6)
            path = _thumb_path(it["img"]) if it["img"] else None
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
            # нэр, код
            text_h = len(lines) * 14.5 + 4 + 13
            ty = y + (rh - text_h) / 2
            pdf.set_text_color(*INK)
            pdf.set_font("Main", "B", 12)
            for i, ln in enumerate(lines):
                pdf.set_xy(tx, ty + i * 14.5)
                pdf.cell(tw, 14.5, ln)
            pdf.set_text_color(*GRAY)
            pdf.set_font("Main", "", 10)
            pdf.set_xy(tx, ty + len(lines) * 14.5 + 4)
            pdf.cell(tw, 13, f"Код: {it['code']}")
            # үнэ
            pdf.set_text_color(*(GREEN if it["price"] else GRAY))
            pdf.set_font("Main", "B", 13.5)
            pdf.set_xy(PW - M - PRICE_W, y + rh / 2 - 9)
            pdf.cell(PRICE_W, 18, _fmt_price(it["price"]), align="R")
            # тусгаарлагч
            pdf.set_draw_color(*LINE)
            pdf.line(tx, y + rh, PW - M, y + rh)
            y += rh
        y += 10
    return bytes(pdf.output())
