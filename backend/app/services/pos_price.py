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
