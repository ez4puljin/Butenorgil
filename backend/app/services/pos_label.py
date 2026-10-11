"""Барааны үнийн шошго ба бөөний үнэ.

2026-10-нд erxes шинэчлэгдэж хуучин documents service ажиллахаа больсон
(`/pl:documents/print` → «Service not found», `documentsDetail` → «Permission required»),
тиймээс шошгыг ӨӨРСДӨӨ зурна. Талбарууд нь хуучин erxes-ийн «Шошго» загвартай ижил:
нэр, код, үнэ, бөөний ширхэг, бөөний үнэ, дээр нь хэвлэсэн огноо.

Бөөний ширхэг/үнэ — онлайн POS-ийн `getPriceInfo` (app.services.pos_price.price_info):
касс яг үүгээр бодно, хуучин шошготой таарсан (101007 → 2 ш @ 29,130₮;
101048 → 2 ш @ 106,300₮).

Дулааны (чек) принтерт зориулав: 80 мм, зөвхөн хар өнгө (саарлыг цэгэн болгож муу хэвлэдэг).
"""
from __future__ import annotations

import html
from datetime import datetime

from app.core.config import settings


class LabelError(RuntimeError):
    pass


def _money(v) -> str:
    try:
        return f"{float(v):,.0f}"
    except (TypeError, ValueError):
        return ""


def _qty(v) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ""
    return str(int(f)) if f.is_integer() else f"{f:g}"


_bulk_cache: dict = {}
_BULK_TTL = 300          # сек — үнэ өдөр дунд ховор өөрчлөгддөг


def bulk_info(product_id: str, unit_price=None) -> dict:
    """Барааны бөөний ширхэг/үнэ (онлайн POS-ийн pricing).

    Дэлгэц дээр үндсэн үнийг эхэлж харуулаад, үүнийг ард нь ачаална (~0.4-1 сек).
    Дахин уншуулахад шууд гарахын тулд богино хугацаанд кэшилнэ."""
    from app.services import pos_price
    now = datetime.now()
    hit = _bulk_cache.get(product_id)
    if hit and (now - hit[0]).total_seconds() < _BULK_TTL:
        return hit[1]
    info = pos_price.price_info(product_id) or {}
    out = {
        "quantity": _qty(info.get("value")) if info else "",
        "price": _money(info.get("price")) if info else "",
        "unit_price": _money(unit_price) if unit_price is not None else "",
        "ok": bool(info.get("price")),
    }
    _bulk_cache[product_id] = (now, out)
    return out


def _one(p: dict, bulk: dict, stamp: str) -> str:
    e = html.escape
    bulk_line = (f'<div class="bulk">Бөөний {e(bulk["quantity"])} ш — <b>{e(bulk["price"])}₮</b></div>'
                 if bulk.get("ok") else "")
    return (
        '<div class="lbl">'
        f'<div class="name">{e(p.get("name") or "")}</div>'
        f'<div class="code">{e(p.get("code") or "")}</div>'
        f'<div class="price">{e(_money(p.get("price")))}<span>₮</span></div>'
        f'{bulk_line}'
        f'<div class="date">{e(stamp)}</div>'
        '</div>'
    )


def label_page(product: dict, copies: int = 1, auto_print: bool = True,
               when: datetime | None = None) -> str:
    """Хэвлэхэд бэлэн бүтэн хуудас — хувь бүр тусдаа хуудсанд (шошго бүр таслагдана)."""
    if not product or not product.get("_id"):
        raise LabelError("Бараа олдсонгүй.")
    copies = max(1, min(int(copies or 1), 20))
    try:
        bulk = bulk_info(product["_id"], product.get("price"))
    except Exception:  # noqa: BLE001 — бөөний мэдээлэлгүй ч шошго хэвлэгдэнэ
        bulk = {"ok": False}
    stamp = (when or datetime.now()).strftime("%Y-%m-%d")
    width = int(settings.erxes_label_width or 80)
    body = "".join(_one(product, bulk, stamp) for _ in range(copies))
    # document.write-ээр нээсэн цонхонд load аль хэдийн болсон байж болно —
    # тиймээс readyState-ийг шалгаж хоёуланг нь барина.
    auto = ("<script>(function(){function p(){setTimeout(function(){window.print()},300)}"
            "if(document.readyState==='complete')p();else window.addEventListener('load',p)})();</script>"
            if auto_print else "")
    return (
        "<!doctype html><html lang='mn'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>Үнийн шошго</title><style>"
        f"@page{{size:{width}mm auto;margin:3mm}}"
        "*{box-sizing:border-box}"
        "body{margin:0;font-family:Arial,'Helvetica Neue',sans-serif;color:#000}"
        f".lbl{{width:{width - 6}mm;padding:1mm 0;break-after:page;page-break-after:always}}"
        ".lbl:last-child{break-after:auto;page-break-after:auto}"
        ".name{font-size:15px;font-weight:700;line-height:1.25;max-height:3.75em;overflow:hidden}"
        ".code{margin-top:1px;font:12px ui-monospace,Consolas,monospace}"
        ".price{margin-top:4px;font-size:34px;font-weight:900;line-height:1;text-align:center}"
        ".price span{margin-left:2px;font-size:20px;font-weight:700}"
        ".bulk{margin-top:4px;font-size:14px;text-align:center}"
        ".date{margin-top:4px;font-size:10px;text-align:right}"
        "@media screen{body{background:#eee;padding:8mm}"
        ".lbl{background:#fff;padding:3mm;margin:0 auto 6mm;box-shadow:0 1px 4px rgba(0,0,0,.15)}}"
        "</style></head><body>" + body + auto + "</body></html>"
    )
