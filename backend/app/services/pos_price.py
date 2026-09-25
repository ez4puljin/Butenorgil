"""Барааны үнэ хайх — заалны таблетад зориулав.

Эх сурвалж нь ЛОКАЛ POS API (192.168.1.254:4030 / :4031), erxes gateway БИШ.
Шалтгаан:
  · дотоод сүлжээнд, нэвтрэлтгүй, 100 мс-д хариулна (gateway 1-3 сек);
  · яг ЭНЭ өгөгдлөөр касс үнэ бодож байгаа тул лангууны үнэтэй заавал тохирно;
  · интернэт тасарсан ч ажиллана.

Яагаад document-print URL ашиглаагүй вэ: тэр нь шошго ХЭВЛЭХ зам бөгөөд
erxes-ийн `_id`, `branchId`, `departmentId` шаарддаг, HTML буцаадаг. Локал
POS-оос шууд асуувал хамаагүй энгийн бөгөөд найдвартай.

Баталгаажуулалт (2026-08-24, 38 борлуулалтын мөр):
  · 34 мөр `unitPrice`-тай ЯГ таарсан;
  · зөрсөн 4 мөр бүгд `discountAmount` бүхий — касс дээр тооцогдсон хямдрал,
    үнэ өөрчлөгдсөн БИШ;
  · `getPriceInfo` бүх бараан дээр None — идэвхтэй урамшуулал алга.
Тиймээс `unitPrice` = лангууны үнэ. Кассын хямдрал (уриалга/карт) үүнээс
цааш хасагдаж болно.
"""
from __future__ import annotations

import threading
import time

import requests

from app.core.config import settings
from app.services.pos_reconcile import local_urls

TIMEOUT = (5, 20)

_FIELDS = ("_id name code shortName unitPrice barcodes barcodeDescription "
           "uom description attachment { url name } category { _id name }")
_SEARCH_Q = ("query($sv:String,$pp:Int){ poscProducts(searchValue:$sv, perPage:$pp){ %s } }"
             % _FIELDS)


class PriceError(RuntimeError):
    pass


def _norm(s) -> str:
    return str(s or "").strip().lower()


def _search(url: str, q: str, per_page: int = 8) -> list[dict]:
    r = requests.post(url, json={"query": _SEARCH_Q, "variables": {"sv": q, "pp": per_page}},
                      timeout=TIMEOUT, headers={"Content-Type": "application/json"})
    j = r.json()
    if j.get("errors"):
        raise PriceError(str(j["errors"][0].get("message"))[:120])
    return (j.get("data") or {}).get("poscProducts") or []


def _exact(rows: list[dict], q: str) -> dict | None:
    """Код эсвэл баркодтой ЯГ таарсныг эрхэмлэнэ.

    searchValue нь нэрний хэсгээр ч таардаг тул скан хийсэн баркодыг
    санамсаргүй өөр бараатай холихоос сэргийлж заавал шалгана."""
    nq = _norm(q)
    for p in rows:
        if _norm(p.get("code")) == nq:
            return p
        if any(_norm(b) == nq for b in (p.get("barcodes") or [])):
            return p
    return None


def _shape(p: dict, source: str) -> dict:
    att = p.get("attachment") or {}
    cat = p.get("category") or {}
    return {
        "_id": p.get("_id"),
        "code": p.get("code") or "",
        "name": p.get("name") or "",
        "short_name": p.get("shortName") or "",
        "price": p.get("unitPrice"),
        "barcodes": p.get("barcodes") or [],
        "uom": p.get("uom") or "",
        "category": cat.get("name") or "",
        "image": att.get("url") or "",
        "description": p.get("description") or "",
        "source": source,
    }


def lookup(q: str) -> dict:
    """Баркод / код / нэрээр хайна.

    Локал POS бүрийг ээлжлэн асууна — бараа зөвхөн нэг POS дээр байж болно.
    ЯГ таарсан (код эсвэл баркод) байвал шууд түүнийг өгнө; үгүй бол
    нэрээр олдсон хувилбаруудыг санал болгоно."""
    q = (q or "").strip()
    if not q:
        return {"query": q, "found": False, "product": None, "others": [], "error": ""}

    urls = local_urls()
    if not urls:
        return {"query": q, "found": False, "product": None, "others": [],
                "error": "Локал POS хаяг тохируулаагүй (POS_LOCAL_URLS)."}

    others: list[dict] = []
    seen: set[str] = set()
    errors: list[str] = []
    for url in urls:
        host = url.split("//")[-1].split("/")[0]
        try:
            rows = _search(url, q)
        except Exception as e:      # noqa: BLE001 — нэг POS унтарсан ч нөгөөгөөс хайна
            errors.append(f"{host}: {str(e)[:60]}")
            continue
        hit = _exact(rows, q)
        if hit:
            return {"query": q, "found": True, "product": _shape(hit, host),
                    "others": [], "error": ""}
        for p in rows:
            if p.get("_id") and p["_id"] not in seen:
                seen.add(p["_id"])
                others.append(_shape(p, host))

    return {
        "query": q,
        "found": False,
        "product": others[0] if len(others) == 1 else None,
        "others": others[:8],
        "error": "; ".join(errors) if errors and not others else "",
    }


def enabled() -> bool:
    return bool(local_urls())


# ── Бүх барааны зарах үнэ (тайлан, Excel-д) ────────────────────────────────────
# Нэг нэгээр нь хайвал ~20 мянган бараанд хэт удаан — POS бүрээс хуудаслан бүгдийг
# нэг дор татаж, 10 минут кэшилнэ. Эхний POS-д байгаа үнэ давуу.
_PRICE_Q = ("query($p:Int,$pp:Int){ poscProducts(page:$p, perPage:$pp){ code unitPrice barcodes } }")
_PRICES: dict = {"at": 0.0, "by_code": {}, "by_barcode": {}, "error": ""}
_PRICES_LOCK = threading.Lock()
PRICE_TTL = 600
PRICE_PAGE = 1000


def _all_products(url: str) -> list[dict]:
    out: list[dict] = []
    for page in range(1, 200):
        r = requests.post(url, json={"query": _PRICE_Q, "variables": {"p": page, "pp": PRICE_PAGE}},
                          timeout=TIMEOUT, headers={"Content-Type": "application/json"})
        j = r.json()
        if j.get("errors"):
            raise PriceError(str(j["errors"][0].get("message"))[:120])
        rows = (j.get("data") or {}).get("poscProducts") or []
        out.extend(rows)
        if len(rows) < PRICE_PAGE:
            break
    return out


def price_map(force: bool = False) -> tuple[dict[str, float], dict[str, float], str]:
    """(код → зарах үнэ, баркод → зарах үнэ, алдаа) — локал POS-уудаас.

    POS-ийн бараа Эрхэттэй синк хийгддэг тул POS-ийн ``code`` = мастерын item_code.
    Хэд хэдэн POS байвал эхнийхийн үнэ давуу (дараагийнхаас зөвхөн дутууг нөхнө)."""
    if not force and _PRICES["at"] and time.monotonic() - _PRICES["at"] < PRICE_TTL:
        return _PRICES["by_code"], _PRICES["by_barcode"], _PRICES["error"]
    with _PRICES_LOCK:
        if not force and _PRICES["at"] and time.monotonic() - _PRICES["at"] < PRICE_TTL:
            return _PRICES["by_code"], _PRICES["by_barcode"], _PRICES["error"]
        by_code: dict[str, float] = {}
        by_barcode: dict[str, float] = {}
        errors: list[str] = []
        urls = local_urls()
        if not urls:
            errors.append("Локал POS хаяг тохируулаагүй (POS_LOCAL_URLS)")
        for url in urls:
            host = url.split("//")[-1].split("/")[0]
            try:
                rows = _all_products(url)
            except Exception as e:  # noqa: BLE001 — нэг POS унтарсан ч нөгөөгөөс авна
                errors.append(f"{host}: {str(e)[:80]}")
                continue
            for p in rows:
                price = p.get("unitPrice")
                if price is None:
                    continue
                code = _norm(p.get("code"))
                if code and code not in by_code:
                    by_code[code] = float(price)
                for b in p.get("barcodes") or []:
                    nb = _norm(b)
                    if nb and nb not in by_barcode:
                        by_barcode[nb] = float(price)
        err = "; ".join(errors) if errors and not by_code else ""
        # Бүх POS унтарсан бол кэшлэхгүй — дараагийн хүсэлт дахин оролдоно.
        _PRICES.update(at=time.monotonic() if by_code else 0.0, by_code=by_code, by_barcode=by_barcode, error=err)
        return by_code, by_barcode, err
