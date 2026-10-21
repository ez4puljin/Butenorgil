"""Барааны үнийн шошго ба бөөний үнэ.

2026-10-нд erxes шинэчлэгдэж хуучин documents service ажиллахаа больсон
(`/pl:documents/print` → «Service not found», `documentsDetail` → «Permission required»),
тиймээс шошгыг erxes-ийн хуучин «Шошго» загвараар (id 63e0d1c289900a8db3052d6b,
core:product) ӨӨРСДӨӨ зурна — HTML/inline style нь тэр загварынх яг хэвээрээ
(2026-08-29-нд `documentsDetail`-ээс уншсан агуулга), дээр нь erxes-ийн receipt CSS
(Arial, хар, 11px) ба өмнөх шигээ доод хүрээний баруун доод буланд хэвлэсэн огноо.
Хувь бүрийг өмнөх шигээ хуудас таслалгүйгээр дараалуулна.

Бөөний ширхэг/үнэ — онлайн POS-ийн `getPriceInfo` (app.services.pos_price.price_info):
касс яг үүгээр бодно, хуучин шошготой таарсан (101007 → 2 ш @ 29,130₮;
101048 → 2 ш @ 106,300₮).
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


# erxes-ийн хуучин «Шошго» загвар ({{ name }} {{ code }} {{ price }} {{ bulkQuantity }}
# {{ bulkPrice }}) — style-уудыг өөрчлөлгүй хуулсан. {date} — бидний нэмдэг байсан огноо.
_TEMPLATE = (
    '<div><div style="border: 2px solid; padding: 3px 3px;border-bottom:none">'
    '<p style="text-align: center;"><span style="font-size: 16px"><strong>{name}</strong></span></p>'
    '<p><span style="font-size: 12px"><strong>code</strong></span>: '
    '<span style="font-size: 14px"><strong>{code} </strong></span></p></div>'
    '<div style="border: 2px solid; padding: 3px 3px;">'
    '<p><span style="font-size: 18px">Үнэ :</span>&nbsp; '
    '<span style="font-size: 22px"><strong>{price} </strong></span></p>'
    '<p><span style="font-size: 16px">Бөөний ширхэг&nbsp;<strong>{bulk_qty}</strong>'
    '&nbsp;Бөөний үнэ: </span><span style="font-size: 20px"><strong>{bulk_price}</strong></span></p>'
    '<p style="margin:2px 0 0;font-size:10px;color:#000;text-align:right">{date}</p>'
    '</div></div>'
)

# erxes-ийн print-ийн нэмдэг receipt CSS (шошгонд хамаатай хэсэг)
_RECEIPT_CSS = ("html {color: #000;font-size: 11px;font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;}"
                "body {margin: 0;}")


def _one(p: dict, bulk: dict, stamp: str) -> str:
    e = html.escape
    return _TEMPLATE.format(
        name=e(p.get("name") or ""), code=e(p.get("code") or ""), price=e(_money(p.get("price"))),
        bulk_qty=e(bulk.get("quantity") or "") if bulk.get("ok") else "",
        bulk_price=e(bulk.get("price") or "") if bulk.get("ok") else "",
        date=e(stamp))


def label_inner(product: dict, when: datetime | None = None) -> str:
    """Нэг шошгоны HTML (загвар + receipt CSS) — принтер рүү шууд хэвлэхэд (label_printer)."""
    if not product or not product.get("_id"):
        raise LabelError("Бараа олдсонгүй.")
    try:
        bulk = bulk_info(product["_id"], product.get("price"))
    except Exception:  # noqa: BLE001 — бөөний мэдээлэлгүй ч шошго хэвлэгдэнэ
        bulk = {"ok": False}
    stamp = (when or datetime.now()).strftime("%Y-%m-%d")
    return f"<style>{_RECEIPT_CSS}</style>" + _one(product, bulk, stamp)


def label_page(product: dict, copies: int = 1, auto_print: bool = True,
               when: datetime | None = None) -> str:
    """Хэвлэхэд бэлэн бүтэн хуудас (өмнөх erxes шошготой ижил харагдац)."""
    if not product or not product.get("_id"):
        raise LabelError("Бараа олдсонгүй.")
    copies = max(1, min(int(copies or 1), 20))
    try:
        bulk = bulk_info(product["_id"], product.get("price"))
    except Exception:  # noqa: BLE001 — бөөний мэдээлэлгүй ч шошго хэвлэгдэнэ
        bulk = {"ok": False}
    stamp = (when or datetime.now()).strftime("%Y-%m-%d")
    width = int(settings.erxes_label_width or 80)
    inner = "<div>" + "".join(f"<div>{_one(product, bulk, stamp)}</div>" for _ in range(copies)) + "</div>"
    # document.write-ээр нээсэн цонхонд load аль хэдийн болсон байж болно —
    # тиймээс readyState-ийг шалгаж хоёуланг нь барина.
    auto = ("<script>(function(){function p(){setTimeout(function(){window.print()},300)}"
            "if(document.readyState==='complete')p();else window.addEventListener('load',p)})();</script>"
            if auto_print else "")
    return (
        "<!doctype html><html lang='mn'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>Үнийн шошго</title>"
        "<style>@page{margin:4mm}body{margin:0}"
        f"@media screen{{body{{background:#eee;padding:8mm}}body>div{{max-width:{width}mm;background:#fff}}}}"
        f"</style><style type=\"text/css\">/*receipt*/{_RECEIPT_CSS}</style>"
        "</head><body>" + inner + auto + "</body></html>"
    )
