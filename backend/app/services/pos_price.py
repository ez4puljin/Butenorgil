"""Барааны үнэ хайх — заалны таблет, kiosk, шошго, тайланд.

Эх сурвалж нь OFFLINE POS (касс 192.168.1.254:7000 «Бүтэн Оргил ХХК» → GraphQL API :4030) —
хэрэглэгчийн шийдвэр 2026-10-21 (өмнө нь 10-11…10-21 онлайн pos.bto.mn, erxes-pos-token-оор).
Локал API нэвтрэлтгүй, хайлт ~0.05 сек; схем нь онлайнтай ижил (poscProducts, getPriceInfo).

  · Асуух POS-ууд POS_PRICE_LOCAL_URLS (таслалаар, анхдагч http://192.168.1.254:4030/graphql) —
    дарааллаар нь ЯГ таарсныг эрхэмлэнэ. Нэрийг currentConfig-оос авч 1 цаг кэшилнэ.
  · Хайлтын хариуг 60 сек кэшилнэ (нэг барааг дахин уншуулахад агшин зуур).

`unitPrice` = лангууны үнэ (2026-08-24-нд 38 бодит борлуулалтын мөрөөр баталсан:
34 яг таарсан, зөрсөн 4 нь кассын хямдралтай). Барааны `_id` нь erxes-ийн барааны
`_id`-тай ижил тул шошго/бөөний үнэ (pos_label) шууд ажиллана. Зураг — erxes gateway-ийн read-file.
"""
from __future__ import annotations

import re
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import requests
import urllib3

from app.core.config import settings

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

TIMEOUT = (5, 20)
TOKENS_TTL = 3600          # POS-ийн токен (posList) — цагт нэг
LOOKUP_TTL = 60            # нэг хайлтын хариу
IMAGE_WIDTH = 400          # erxes read-file жижгэрүүлэлт (200-360 KB → 12-28 KB)

_FIELDS = ("_id name code shortName unitPrice barcodes barcodeDescription "
           "uom description attachment { url name } category { _id name }")
_SEARCH_Q = ("query($sv:String,$pp:Int){ poscProducts(searchValue:$sv, perPage:$pp){ %s } }"
             % _FIELDS)

_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="pos-price")


class PriceError(RuntimeError):
    pass


def _norm(s) -> str:
    return str(s or "").strip().lower()


def _urls() -> list[str]:
    return [u.strip() for u in (settings.pos_price_local_urls or "").split(",") if u.strip()]


def _site() -> str:
    """Хэрэглэгчид харуулах эх сурвалж — offline POS-ийн хаяг."""
    return "Offline POS 192.168.1.254:7000"


# ── POS-ууд (нэр, API url) ────────────────────────────────────────────────────
_TOKENS: dict = {"at": 0.0, "list": [], "error": ""}
_TOKENS_LOCK = threading.Lock()


def targets(force: bool = False) -> list[tuple[str, str]]:
    """Үнэ асуух offline POS-ууд (нэр, API url) — POS_PRICE_LOCAL_URLS-ийн дарааллаар."""
    if not force and _TOKENS["list"] and time.monotonic() - _TOKENS["at"] < TOKENS_TTL:
        return _TOKENS["list"]
    with _TOKENS_LOCK:
        if not force and _TOKENS["list"] and time.monotonic() - _TOKENS["at"] < TOKENS_TTL:
            return _TOKENS["list"]
        out, errs = [], []
        for url in _urls():
            try:
                name = ((_gql(url, "{ currentConfig { name } }", {}, timeout=(3, 10)).get("currentConfig") or {})
                        .get("name") or url)
                out.append((name, url))
            except Exception as e:  # noqa: BLE001
                errs.append(f"{url}: {str(e)[:80]}")
        if not out:
            _TOKENS["error"] = "Offline POS холбогдсонгүй — " + ("; ".join(errs) or "POS_PRICE_LOCAL_URLS хоосон")
            if _TOKENS["list"]:                     # өмнө нь олдсон бол түүгээр үргэлжилнэ
                return _TOKENS["list"]
            raise PriceError(_TOKENS["error"])
        _TOKENS.update(at=time.monotonic(), list=out, error="")
        return out


def _gql(url: str, query: str, variables: dict, timeout=TIMEOUT) -> dict:
    r = requests.post(url, json={"query": query, "variables": variables},
                      headers={"Content-Type": "application/json"}, timeout=timeout)
    try:
        j = r.json()
    except ValueError:
        raise PriceError(f"offline POS хариу буруу ({r.status_code})")
    if j.get("errors"):
        raise PriceError(str(j["errors"][0].get("message"))[:120])
    return j.get("data") or {}


def _search(token: str, q: str, per_page: int = 8) -> list[dict]:
    return _gql(token, _SEARCH_Q, {"sv": q, "pp": per_page}).get("poscProducts") or []


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


def _image(url: str) -> str:
    """erxes read-file: key-д зай, &, + байж болох тул кодлоно; жижгэрүүлсэн хувилбар."""
    if not url:
        return ""
    m = re.match(r"^(.*[?&]key=)([^&]*)(.*)$", url)
    if m:
        key = urllib.parse.unquote(m.group(2))
        url = m.group(1) + urllib.parse.quote(key, safe="/") + m.group(3)
    if "width=" not in url:
        url += ("&" if "?" in url else "?") + f"width={IMAGE_WIDTH}"
    return url


def _shape(p: dict, pos_name: str) -> dict:
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
        "image": _image(att.get("url") or ""),
        "description": p.get("description") or "",
        "source": f"{_site()} · {pos_name}",
    }


_CACHE: dict[str, tuple[float, dict]] = {}


def lookup(q: str) -> dict:
    """Баркод / код / нэрээр хайна.

    POS-уудыг ЗЭРЭГ асуугаад POS_PRICE_POS-ийн дарааллаар ЯГ таарсныг (код эсвэл
    баркод) өгнө; үгүй бол нэрээр олдсон хувилбаруудыг санал болгоно."""
    q = (q or "").strip()
    if not q:
        return {"query": q, "found": False, "product": None, "others": [], "error": ""}
    key = _norm(q)
    hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] < LOOKUP_TTL:
        return {**hit[1], "query": q}

    try:
        tg = targets()
    except Exception as e:  # noqa: BLE001
        return {"query": q, "found": False, "product": None, "others": [], "error": str(e)[:160]}

    futures = [(name, _pool.submit(_search, tok, q)) for name, tok in tg]
    others: list[dict] = []
    seen: set[str] = set()
    errors: list[str] = []
    result = None
    for name, fut in futures:
        try:
            rows = fut.result(timeout=30)
        except Exception as e:  # noqa: BLE001 — нэг POS алдаатай ч нөгөөгөөс хайна
            errors.append(f"{name}: {str(e)[:60]}")
            continue
        found = _exact(rows, q)
        if found:
            result = {"query": q, "found": True, "product": _shape(found, name), "others": [], "error": ""}
            break
        for p in rows:
            if p.get("_id") and p["_id"] not in seen:
                seen.add(p["_id"])
                others.append(_shape(p, name))
    if result is None:
        result = {
            "query": q,
            "found": False,
            "product": others[0] if len(others) == 1 else None,
            "others": others[:8],
            "error": "; ".join(errors) if errors and not others else "",
        }
    if not errors or result["found"]:
        _CACHE[key] = (time.monotonic(), result)
        if len(_CACHE) > 2000:                               # хэт томрохоос сэргийлнэ
            for k in sorted(_CACHE, key=lambda k: _CACHE[k][0])[:1000]:
                _CACHE.pop(k, None)
    return result


_PI_Q = "query($id:String!){ getPriceInfo(productId:$id) }"


def price_info(product_id: str) -> dict | None:
    """Бөөний үнэ — offline POS-ийн pricing (касс яг үүгээр бодно).

    `getPriceInfo` нь JSON текст буцаана: {"<id>": {"value": 2, "price": 29130}} — 2 ба
    түүнээс дээш ширхэгт нэгж үнэ 29,130₮. Нэг удаад зөвхөн нэг бараа хүлээн авна."""
    if not product_id:
        return None
    import json
    errors = []
    for name, tok in targets():
        try:
            raw = _gql(tok, _PI_Q, {"id": product_id}).get("getPriceInfo")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {str(e)[:60]}")
            continue
        try:
            info = (json.loads(raw) if isinstance(raw, str) else raw or {}).get(product_id)
        except (ValueError, AttributeError):
            info = None
        return info if isinstance(info, dict) and info.get("price") else None
    raise PriceError("; ".join(errors) or "POS тохируулаагүй")


def enabled() -> bool:
    return bool(_urls())


def status() -> dict:
    """UI-д: offline POS-той холбогдож байгаа эсэх, аль POS-уудаас асууж байгаа."""
    if not enabled():
        return {"enabled": False, "site": _site(), "pos": [], "pos_count": 0,
                "error": "POS_PRICE_LOCAL_URLS тохируулаагүй (offline POS-ийн API)."}
    try:
        names = [n for n, _ in targets()]
        return {"enabled": True, "site": _site(), "pos": names, "pos_count": len(names), "error": ""}
    except Exception as e:  # noqa: BLE001
        return {"enabled": True, "site": _site(), "pos": [], "pos_count": 0, "error": str(e)[:160]}


# ── Бүх барааны зарах үнэ (тайлан, Excel-д) ────────────────────────────────────
# Нэг нэгээр нь хайвал хэт удаан — POS бүрээс 5000-аар хуудаслан бүгдийг (12.8 мянга,
# ~3 сек) татаж, 10 минут кэшилнэ. Эхний POS-д байгаа үнэ давуу.
_PRICE_Q = ("query($p:Int,$pp:Int){ poscProducts(page:$p, perPage:$pp){ code unitPrice barcodes } }")
_PRICES: dict = {"at": 0.0, "by_code": {}, "by_barcode": {}, "error": ""}
_PRICES_LOCK = threading.Lock()
PRICE_TTL = 600
PRICE_PAGE = 5000


def _all_products(token: str) -> list[dict]:
    out: list[dict] = []
    for page in range(1, 100):
        rows = _gql(token, _PRICE_Q, {"p": page, "pp": PRICE_PAGE}, timeout=(5, 120)).get("poscProducts") or []
        out.extend(rows)
        if len(rows) < PRICE_PAGE:
            break
    return out


def price_map(force: bool = False) -> tuple[dict[str, float], dict[str, float], str]:
    """(код → зарах үнэ, баркод → зарах үнэ, алдаа) — offline POS-уудаас.

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
        try:
            tg = targets()
        except Exception as e:  # noqa: BLE001
            tg, errors = [], [str(e)[:120]]
        for name, tok in tg:
            try:
                rows = _all_products(tok)
            except Exception as e:  # noqa: BLE001 — нэг POS алдаатай ч нөгөөгөөс авна
                errors.append(f"{name}: {str(e)[:80]}")
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
        # Бүх POS алдаатай бол кэшлэхгүй — дараагийн хүсэлт дахин оролдоно.
        _PRICES.update(at=time.monotonic() if by_code else 0.0, by_code=by_code, by_barcode=by_barcode, error=err)
        return by_code, by_barcode, err
