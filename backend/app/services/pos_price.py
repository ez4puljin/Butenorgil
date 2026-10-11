"""Барааны үнэ хайх — заалны таблет, kiosk, тайланд.

Эх сурвалж нь ОНЛАЙН POS (pos.bto.mn) — түүний API нь erxes gateway-ийн posclient
(`{ERXES_URL}/graphql`, header `erxes-pos-token: <POS-ийн токен>`). 2026-10-аас
касс локал POS (192.168.1.254:4030/4031)-оос онлайн руу шилжсэн тул локал API унтарсан.

  · Кассчны нэвтрэлт хэрэггүй — POS-ийн токеноор л бараа/үнэ гарна (токенгүй бол хоосон).
  · Токеныг erxes-ийн `posList`-оос (ERP-ийн админ нэвтрэлтээр) аваад 1 цаг кэшилнэ;
    POS_PRICE_TOKENS өгвөл админ нэвтрэлтгүйгээр шууд ашиглана.
  · Асуух POS-ууд POS_PRICE_POS (анхдагч: Бүтэн Оргил ХХК, Заалны архи) — хоёулаа
    ижил 12,833 бараатай, үнэ нь 100% ижил (2026-10-11 шалгасан). Хархорин салбарын
    180 барааны үнэ өөр тул энд ороогүй.
  · Нэг хайлт ~0.4 сек (локал 0.1 сек байсан) — POS-уудыг зэрэг асууж, хариуг 60 сек
    кэшилнэ (нэг барааг дахин уншуулахад агшин зуур).

`unitPrice` = лангууны үнэ (2026-08-24-нд 38 бодит борлуулалтын мөрөөр баталсан:
34 яг таарсан, зөрсөн 4 нь кассын хямдралтай). Барааны `_id` нь erxes-ийн барааны
`_id`-тай ижил тул шошго/бөөний үнэ (pos_label) шууд ажиллана.
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


def _endpoint() -> str:
    base = (settings.erxes_url or "").rstrip("/")
    return base if base.endswith("/graphql") else f"{base}/graphql"


def _site() -> str:
    """Хэрэглэгчид харуулах эх сурвалж — онлайн POS-ийн хаяг."""
    return "pos.bto.mn"


# ── POS-ууд (нэр, токен) ──────────────────────────────────────────────────────
_TOKENS: dict = {"at": 0.0, "list": [], "error": ""}
_TOKENS_LOCK = threading.Lock()


def _explicit_tokens() -> list[tuple[str, str]]:
    """POS_PRICE_TOKENS="нэр=токен,нэр=токен" (эсвэл зөвхөн токенууд)."""
    out = []
    for i, raw in enumerate((settings.pos_price_tokens or "").split(",")):
        raw = raw.strip()
        if not raw:
            continue
        name, _, tok = raw.rpartition("=")
        out.append(((name or f"POS {i + 1}").strip(), tok.strip()))
    return [x for x in out if x[1]]


def targets(force: bool = False) -> list[tuple[str, str]]:
    """Үнэ асуух POS-ууд (нэр, токен) — POS_PRICE_POS-ийн дарааллаар."""
    explicit = _explicit_tokens()
    if explicit:
        return explicit
    if not force and _TOKENS["list"] and time.monotonic() - _TOKENS["at"] < TOKENS_TTL:
        return _TOKENS["list"]
    with _TOKENS_LOCK:
        if not force and _TOKENS["list"] and time.monotonic() - _TOKENS["at"] < TOKENS_TTL:
            return _TOKENS["list"]
        from app.services.erxes_client import get_client
        try:
            pl = get_client().pos_list()
        except Exception as e:  # noqa: BLE001 — өмнөх токенууд байвал түүгээр үргэлжилнэ
            _TOKENS["error"] = f"erxes POS жагсаалт: {str(e)[:100]}"
            if _TOKENS["list"]:
                return _TOKENS["list"]
            raise PriceError(_TOKENS["error"])
        by_name = {(p.get("name") or "").strip(): p.get("token") for p in pl if p.get("token")}
        names = [n.strip() for n in (settings.pos_price_pos or "").split(",") if n.strip()]
        out = [(n, by_name[n]) for n in names if by_name.get(n)]
        if not out:
            raise PriceError(f"POS олдсонгүй ({', '.join(names) or 'POS_PRICE_POS хоосон'}). "
                             f"erxes дээр: {', '.join(by_name) or '—'}")
        _TOKENS.update(at=time.monotonic(), list=out, error="")
        return out


def _gql(token: str, query: str, variables: dict, timeout=TIMEOUT) -> dict:
    r = requests.post(_endpoint(), json={"query": query, "variables": variables},
                      headers={"Content-Type": "application/json", "erxes-pos-token": token},
                      timeout=timeout, verify=False)
    try:
        j = r.json()
    except ValueError:
        raise PriceError(f"онлайн POS хариу буруу ({r.status_code})")
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
    """Бөөний үнэ — онлайн POS-ийн pricing (касс яг үүгээр бодно).

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
    return bool(settings.erxes_url and (_explicit_tokens() or (settings.erxes_email and settings.erxes_password)))


def status() -> dict:
    """UI-д: онлайн POS-той холбогдож байгаа эсэх, аль POS-уудаас асууж байгаа."""
    if not enabled():
        return {"enabled": False, "site": _site(), "pos": [], "pos_count": 0,
                "error": "erxes тохиргоо дутуу (ERXES_URL, ERXES_EMAIL, ERXES_PASSWORD эсвэл POS_PRICE_TOKENS)."}
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
    """(код → зарах үнэ, баркод → зарах үнэ, алдаа) — онлайн POS-уудаас.

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
