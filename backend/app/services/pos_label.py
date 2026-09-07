"""Барааны үнийн шошго хэвлэх.

Шошгыг ӨӨРӨӨ зурахгүй — erxes-ийн бэлэн document template-ийг ашиглана
(`GET /gateway/pl:documents/print`). Шалтгаан:

  · Шошгон дээрх **бөөний ширхэг / бөөний үнэ** нь erxes дотор бодогддог
    (pricing plugin). Локал POS-оос гарахгүй — `subUoms` нь зөвхөн хайрцгийн
    харьцаа (1/6), `customFieldsData` хоосон, `getPriceInfo` нь None.
  · Худалдагчид яг энэ загварыг ашиглаж заншсан тул харагдац өөрчлөгдөхгүй.

Бидний нэмэлт зөвхөн хоёр зүйл:
  1. **Хэвлэсэн огноо** — erxes-ийн `isDate` параметр юу ч өөрчилдөггүй нь
     туршилтаар тогтоогдсон (isDate="" ба "true" ижил 2574 тэмдэгт), тиймээс
     огноог өөрсдөө шошго бүрийн дотор оруулна.
  2. Хуудсыг нээмэгц шууд хэвлэх боодол.

Барааны erxes `_id` нь локал POS-ийн `_id`-тай ИЖИЛ (жишээ: 101007 →
`unD7Kxsy6rYHqYAoR`) тул нэмэлт хайлт хэрэггүй.
"""
from __future__ import annotations

import json
import re
import urllib.parse
from datetime import datetime

from app.core.config import settings

PRINT_PATH = "/pl:documents/print"

# Шошго бүр `…</p></div></div></div></div>` -ээр төгсдөг (олон хувь хэвлэхэд
# энэ бүтэц яг тэр тоогоор давтагдана — туршилтаар шалгасан).
_END_RE = re.compile(r"(</p>)(\s*(?:</div>\s*){4})")


class LabelError(RuntimeError):
    pass


def _base_url() -> str:
    base = (settings.erxes_url or "").rstrip("/")
    if base.endswith("/graphql"):
        base = base[: -len("/graphql")]
    return base


def fetch_label(product_id: str, copies: int = 1) -> str:
    """erxes-ээс шошгоны HTML-ийг татна (нэвтэрсэн session-оор)."""
    from app.services.erxes_client import get_client

    if not product_id:
        raise LabelError("Барааны id хоосон байна.")
    q = urllib.parse.urlencode({
        "_id": settings.erxes_label_template_id,
        "productIds": json.dumps([{"id": product_id, "c": 1}], separators=(",", ":")),
        "copies": str(max(1, min(int(copies or 1), 20))),
        "width": str(settings.erxes_label_width),
        "branchId": settings.erxes_label_branch_id,
        "departmentId": settings.erxes_label_department_id,
        "date": datetime.now().strftime("%a %b %d %Y %H:%M:%S"),
        "isDate": "true",
    }, safe='[]{}":,')
    url = f"{_base_url()}{PRINT_PATH}?{q}"

    s = get_client()._session()
    r = s.get(url, timeout=90, verify=False)
    if r.status_code != 200:
        raise LabelError(f"erxes шошго татахад алдаа ({r.status_code}).")
    if "<" not in r.text:
        raise LabelError("erxes хүлээгдээгүй хариу буцаалаа.")
    return r.text


def inject_date(html: str, when: datetime | None = None) -> tuple[str, int]:
    """Шошго бүрийн доод хэсэгт хэвлэсэн огноо нэмнэ.

    Буцаах: (html, хэдэн шошгонд нэмсэн). 0 бол загварын бүтэц өөрчлөгдсөн
    гэсэн үг — шошго нь огноогүй ч хэвлэгдэнэ (хэвлэлт зогсоохгүй)."""
    when = when or datetime.now()
    stamp = when.strftime("%Y-%m-%d")
    # Дулааны принтер саарал өнгийг цэгэн болгож муу хэвлэдэг тул хар.
    tag = (f'<p style="margin:2px 0 0;font-size:10px;color:#000;'
           f'text-align:right">{stamp}</p>')
    html2, n = _END_RE.subn(lambda m: m.group(1) + tag + m.group(2), html)
    return html2, n


def label_page(product_id: str, copies: int = 1, auto_print: bool = True,
               when: datetime | None = None) -> str:
    """Хэвлэхэд бэлэн бүтэн хуудас."""
    inner, _ = inject_date(fetch_label(product_id, copies), when)
    # erxes нь бүтэн баримт биш, хэлтэрхий буцаадаг тул өөрсдөө боож өгнө.
    # document.write-ээр нээсэн цонхонд load аль хэдийн болсон байж болно —
    # тиймээс readyState-ийг шалгаж хоёуланг нь барина.
    auto = ("<script>(function(){function p(){setTimeout(function(){window.print()},300)}if(document.readyState==='complete')p();else window.addEventListener('load',p)})();</script>") if auto_print else ""
    return (
        "<!doctype html><html lang='mn'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>Үнийн шошго</title>"
        "<style>@page{margin:4mm}body{margin:0}"
        "@media screen{body{background:#eee;padding:8mm}}"
        "</style></head><body>" + inner + auto + "</body></html>"
    )


# ── Шошгоны утгыг буцааж унших ──────────────────────────────────────
# Дэлгэц дээр бөөний үнэ харуулахад ЯГ ТЭР эх сурвалжийг ашиглах ёстой —
# pricing-ийн логикийг дуурайвал дэлгэц дээрх тоо шошгон дээрхээс зөрч,
# худалдагч ямар нь зөвийг мэдэхгүй болно.
#
# Загварын текстээс өөрөөс нь regex үүсгэнэ ({{ x }} → нэртэй бүлэг).
# Ингэснээр загварын үг өөрчлөгдвөл дагаж ажиллана.
_TPL_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
_tpl_cache: dict = {"at": None, "rx": None}
_TPL_TTL = 3600


def _text(html: str) -> str:
    """HTML → цэвэр текст (таг хасаж, зайг нэгтгэнэ)."""
    t = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html or "", flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = t.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", t).strip()


def _template_regex():
    """Загварын агуулгаас regex үүсгэнэ (1 цаг кэштэй)."""
    now = datetime.now()
    if (_tpl_cache["rx"] is not None and _tpl_cache["at"]
            and (now - _tpl_cache["at"]).total_seconds() < _TPL_TTL):
        return _tpl_cache["rx"]

    from app.services.erxes_client import get_client
    data = get_client().gql(
        "query($id:String!){ documentsDetail(_id:$id){ content } }",
        {"id": settings.erxes_label_template_id})
    body = _text(((data or {}).get("documentsDetail") or {}).get("content") or "")
    if not body:
        raise LabelError("Шошгоны загвар уншигдсангүй.")

    marks = list(_TPL_RE.finditer(body))
    parts, pos = [], 0
    for i, m in enumerate(marks):
        parts.append(re.escape(body[pos:m.start()]).replace(r"\ ", r"\s*"))
        # Загварын ТӨГСГӨЛД байгаа хувьсагчийн ард таарах текст байхгүй тул
        # non-greedy бүлэг хоосон таардаг — сүүлийнхийг greedy болгоно.
        tail = body[m.end():].strip() if i == len(marks) - 1 else "x"
        parts.append(f"(?P<{m.group(1)}>.*)" if not tail else f"(?P<{m.group(1)}>.*?)")
        pos = m.end()
    parts.append(re.escape(body[pos:]).replace(r"\ ", r"\s*"))
    rx = re.compile("".join(parts), re.S)
    _tpl_cache.update({"at": now, "rx": rx})
    return rx


def parse_rendered(html: str) -> dict:
    """Хэвлэгдсэн шошгоноос загварын утгуудыг салгана.

    Олдохгүй бол хоосон dict — дуудагч тал үүнийг заавал тэсвэрлэнэ
    (бөөний мэдээлэл байхгүй ч үндсэн үнэ харагдана)."""
    m = _template_regex().search(_text(html))
    if not m:
        return {}
    return {k: (v or "").strip() for k, v in m.groupdict().items()}


_bulk_cache: dict = {}
_BULK_TTL = 300          # сек — үнэ өдөр дунд ховор өөрчлөгддөг


def bulk_info(product_id: str) -> dict:
    """Барааны бөөний ширхэг/үнэ — шошготой ЯГ ижил эх сурвалжаас.

    Удаан (erxes руу 0.6-1.6 сек) тул дэлгэц дээр үндсэн үнийг локал
    POS-оос шууд харуулаад, үүнийг ард нь ачаална. Дахин уншуулахад
    шууд гарахын тулд богино хугацаанд кэшилнэ."""
    now = datetime.now()
    hit = _bulk_cache.get(product_id)
    if hit and (now - hit[0]).total_seconds() < _BULK_TTL:
        return hit[1]
    vals = parse_rendered(fetch_label(product_id, copies=1))
    out = {
        "quantity": vals.get("bulkQuantity") or "",
        "price": vals.get("bulkPrice") or "",
        "unit_price": vals.get("price") or "",
        "ok": bool(vals.get("bulkPrice")),
    }
    _bulk_cache[product_id] = (now, out)
    return out
