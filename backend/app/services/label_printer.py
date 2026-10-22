"""Үнийн шошгыг заалны XP-80C (80мм дулааны) принтер рүү ШУУД хэвлэх.

Принтер: 192.168.1.106 (DESKTOP-9IMSI4A) компьютер Windows-оор «XP-80C Zaal» нэрээр хуваалцсан
(9100 порт хаалттай, 445/SMB нээлттэй — 2026-10-21 шалгасан). Хуваалцсан принтер рүү RAW байт бичихэд
(`copy /b`-тэй адил) драйвер хөндөхгүй шууд принтерт очно.

Урсгал: pos_label-ийн HTML (erxes-ийн хуучин «Шошго» загвар — ӨӨРЧЛӨХГҮЙ, [[label-design-keep-old]])
→ headless Edge-ээр 72мм хэвлэх өргөнд (203 dpi → 576 цэг) PNG → 1-бит → ESC/POS raster (GS v 0)
→ шошго бүрийн дараа хайчилна (GS V). Тохиргоо: LABEL_PRINTER (UNC зам), LABEL_BROWSER.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from app.core.config import settings

DOTS = 576                    # XP-80C: 72мм хэвлэх өргөн × 203 dpi
CSS_W = 272                   # 72мм @ 96 dpi (CSS px)
SCALE = DOTS / CSS_W          # ≈ 2.1176 — HTML-ийн px-ийг принтерийн цэг рүү
BROWSERS = (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe")
_lock = threading.Lock()
BATCH = 15                    # нэг дэлгэцийн зурагт багтаах шошго (өндрийн хязгаар)
MAX_LABELS = 100              # нэг удаагийн хэвлэлтийн дээд хэмжээ


class PrintError(RuntimeError):
    pass


def printer_path() -> str:
    return (getattr(settings, "label_printer", "") or r"\\192.168.1.106\XP-80C Zaal").strip()


def _browser() -> str:
    cand = [getattr(settings, "label_browser", "") or ""] + list(BROWSERS)
    for b in cand:
        if b and Path(b).exists():
            return b
    raise PrintError("Шошго зурахад Edge/Chrome олдсонгүй (LABEL_BROWSER).")


def render_png(html: str) -> "Image.Image":  # noqa: F821
    """HTML → принтерийн өргөнтэй (576 цэг) зураг, хүрээгээр яг тайрсан."""
    img = _shot(html, 1400)
    box = _ink(img).getbbox()
    if not box:
        raise PrintError("Шошго хоосон зурагдлаа.")
    return img.crop((0, box[1], DOTS, box[3]))


def render_many(htmls: list[str]) -> list:
    """Олон шошгыг НЭГ хөтчийн дуудлагаар зурна (шошго бүрд Edge асаахаас ~10 дахин хурдан):
    дунд нь хоосон зай тавиад цагаан мөрөөр нь хуваана. Шошгоны дотор хүрээний хажуу шугам
    бүх мөрөнд байдаг тул бүтэн цагаан мөр зөвхөн шошго хоорондох зайд л гарна."""
    out = []
    for i in range(0, len(htmls), BATCH):
        part = htmls[i:i + BATCH]
        img = _shot("".join(f"<div style='margin-bottom:30px'>{h}</div>" for h in part), 260 * len(part) + 200)
        ink = _ink(img)
        rows, y0 = [], None
        for y in range(img.height):
            has = ink.crop((0, y, DOTS, y + 1)).getbbox() is not None
            if has and y0 is None:
                y0 = y
            elif not has and y0 is not None:
                rows.append((y0, y)); y0 = None
        if y0 is not None:
            rows.append((y0, img.height))
        if len(rows) != len(part):                          # таамаг таарсангүй — нэг нэгээр нь
            out += [render_png(h) for h in part]
        else:
            out += [img.crop((0, a, DOTS, b)) for a, b in rows]
    return out


def _ink(img):
    from PIL import ImageChops
    return ImageChops.invert(img)                           # хар зурагтай хэсэг ≠ 0


def _shot(html: str, height: int) -> "Image.Image":  # noqa: F821
    from PIL import Image
    page = ("<!doctype html><html><head><meta charset='utf-8'><style>"
            f"html,body{{margin:0;padding:0;background:#fff;width:{CSS_W}px}}</style></head><body>"
            + html + "</body></html>")
    with tempfile.TemporaryDirectory(prefix="lbl_", ignore_cleanup_errors=True) as d:
        src, out = Path(d) / "label.html", Path(d) / "label.png"
        src.write_text(page, encoding="utf-8")
        cmd = [_browser(), "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
               "--no-default-browser-check", f"--user-data-dir={Path(d) / 'prof'}",
               f"--force-device-scale-factor={SCALE:.4f}", f"--window-size={CSS_W},{height}",
               f"--screenshot={out}", src.as_uri()]
        try:
            subprocess.run(cmd, capture_output=True, timeout=60,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            raise PrintError("Шошго зурах хугацаа хэтэрлээ.")
        # 2026-10-22: Edge 155-ийн launcher 0.1с-д буцаад зургийг хүүхэд процесс ард нь бичдэг —
        # файл гарч, хэмжээ нь тогтвортой болтол хүлээнэ.
        deadline, last = time.monotonic() + 45, -1
        while time.monotonic() < deadline:
            size = out.stat().st_size if out.exists() else -1
            if size > 0 and size == last:
                break
            last = size
            time.sleep(0.3)
        else:
            raise PrintError("Шошго зурагдсангүй (headless хөтөч).")
        img = Image.open(out).convert("L")
        img.load()
    if img.width != DOTS:
        img = img.resize((DOTS, round(img.height * DOTS / img.width)))
    return img


def escpos(img, cut: bool = True) -> bytes:
    """1-бит raster (GS v 0), 255 мөрөөр хэсэглэнэ (принтерийн буфер)."""
    bw = img.point(lambda v: 0 if v < 150 else 255, "1")
    w, h = bw.size
    wb = (w + 7) // 8
    px = bw.load()
    out = bytearray(b"\x1b@")                               # эхлүүлэх
    for y0 in range(0, h, 255):
        rows = min(255, h - y0)
        out += b"\x1dv0\x00" + bytes([wb & 255, wb >> 8, rows & 255, rows >> 8])
        for y in range(y0, y0 + rows):
            for xb in range(wb):
                byte = 0
                for bit in range(8):
                    x = xb * 8 + bit
                    if x < w and px[x, y] == 0:
                        byte |= 0x80 >> bit
                out.append(byte)
    if cut:
        out += b"\x1dV\x42\x00"                            # хайчлах байрлал хүртэл л урагшилж хүрээгээр хайчилна
    return bytes(out)


def send(data: bytes, path: str | None = None) -> None:
    """RAW байт: (1) SMB — хуваалцсан принтер руу файл шиг (`copy /b`), (2) Windows spooler
    (OpenPrinter/WritePrinter). 2026-10-21: 192.168.1.106 хоёуланг нь хаасан — SMB «Access is denied»
    (энэ PC-ийн хэрэглэгчийг танихгүй), spooler 0x11b (PrintNightmare RPC хамгаалалт). Тэр PC-ийн
    хэрэглэгчийн нэр/нууц үгийг энэ серверийн Credential Manager-т хадгалбал SMB зам ажиллана."""
    p = path or printer_path()
    errs = []
    try:
        with open(p, "wb") as f:
            f.write(data)
        return
    except OSError as e:
        errs.append(f"SMB: {e.strerror or e}")
    # Spooler-ийн RPC алсын PC дээр минут гаруй гацах тохиолдол байсан (2026-10-21) — 20 сек хязгаар
    box: dict = {}

    def _spool():
        try:
            import win32print
            h = win32print.OpenPrinter(p)
            try:
                win32print.StartDocPrinter(h, 1, ("Үнийн шошго", None, "RAW"))
                try:
                    win32print.StartPagePrinter(h)
                    win32print.WritePrinter(h, data)
                    win32print.EndPagePrinter(h)
                finally:
                    win32print.EndDocPrinter(h)
                box["ok"] = True
            finally:
                win32print.ClosePrinter(h)
        except Exception as e:  # noqa: BLE001
            box["err"] = getattr(e, "winerror", None) or (e.args[0] if getattr(e, "args", None) else str(e))

    t = threading.Thread(target=_spool, daemon=True, name="label-spool")
    t.start()
    t.join(20)
    if box.get("ok"):
        return
    errs.append(f"spooler: {box.get('err', 'хугацаа хэтэрсэн')}")
    raise PrintError(f"Принтер ({p}) рүү хэвлэх эрхгүй байна ({'; '.join(errs)}). "
                     "192.168.1.106 компьютерийн хэрэглэгчийн нэвтрэлтийг серверт хадгална уу.")


def print_label(product: dict, copies: int = 1) -> dict:
    """Шошгыг принтер рүү шууд — хувь бүрийг тусад нь хайчилна."""
    from app.services import pos_label
    copies = max(1, min(int(copies or 1), 20))
    with _lock:                                             # нэг принтерт зэрэг бүү
        img = render_png(pos_label.label_inner(product))
        one = escpos(img)
        send(one * copies)
    return {"ok": True, "printer": printer_path(), "copies": copies, "height_dots": img.height}


def print_labels(items: list[tuple[dict, int]]) -> dict:
    """Олон барааны шошгыг нэг дор — шошго бүр (хувь бүр) тусдаа хайчлагдана."""
    from app.services import pos_label
    items = [(p, max(1, min(int(c or 1), 20))) for p, c in items if p]
    total = sum(c for _, c in items)
    if not items:
        raise PrintError("Хэвлэх бараа алга.")
    if total > MAX_LABELS:
        raise PrintError(f"Нэг удаад {MAX_LABELS}-аас ихгүй шошго ({total}).")
    with _lock:
        imgs = render_many([pos_label.label_inner(p) for p, _ in items])
        send(b"".join(escpos(img) * c for img, (_, c) in zip(imgs, items)))
    return {"ok": True, "printer": printer_path(), "products": len(items), "labels": total}
