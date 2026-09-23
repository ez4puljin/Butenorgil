"""
Шинэ бараа таниулах — зураг → AI → бүртгэл → Эрхэт («Бараа материалын нэр төрөл») → мастер.

  GET    /new-product/refs                     — ангилал (код, дараагийн код), брэнд, хэмжих нэгж
  POST   /new-product/analyze                  — зураг → AI (нэр, жин, баркод, ангилал) + санал
  GET    /new-product/items?status=&q=         — бүртгэлүүд (алдаа/анхааруулгатай)
  POST   /new-product/items                    — шинэ бүртгэл (зурагтай)
  PUT    /new-product/items/{id}               — засах
  DELETE /new-product/items/{id}
  GET    /new-product/items/{id}/image         — үндсэн зураг
  GET    /new-product/next-code?category=      — ангиллын дараагийн чөлөөт код
  POST   /new-product/export                   — {ids} → Эрхэтийн «Бараа материалын нэр төрөл» импорт Excel
  POST   /new-product/erkhet-import            — {ids, force} → Эрхэт рүү шууд импорт (queue-ээр хянана)
  GET    /new-product/erkhet-imports           — илгээлтийн түүх; POST .../{log}/refresh
Лавлах мэдээлэл нь «Файл оруулалт → Эрхэт бараа»-гаар орсон хамгийн сүүлийн
барааны жагсаалтаас (ангиллын код, данс, хэмжих/задрах нэгж, брэнд код) авна.
"""
from __future__ import annotations

import base64
import difflib
import importlib.util
import io
import json
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.core.config import settings
from app.models.new_product import NewProduct
from app.models.purchase_order import ErkhetImportLog
from app.models.user import User
from app.services import erkhet_import as eimp

router = APIRouter(prefix="/new-product", tags=["new-product"])

EDIT_ROLES = ("admin", "supervisor", "manager")
ERKHET_KIND = "inv"                                   # Бараа материалын нэр төрөл
ERKHET_UPLOAD_DIR = Path("app/data/uploads/Эрхэт бараа")
IMG_DIR = Path("app/data/new_products")
STATUS_LABEL = {"draft": "Ноорог", "ready": "Бэлэн", "sent": "Эрхэтэд илгээсэн", "imported": "Эрхэтэд орсон",
                "fail": "Эрхэт алдаа", "registered": "Мастерт орсон"}
# Эрхэтийн «Бараа материалын нэр төрөл» импортын багана (импортын формын загвараас)
ERKHET_INV_HEADERS = ["Ангиллын код", "Код", "Нэр", "Гадаад нэр", "Хэмжих нэгжийн код", "Жин",
                      "Өртөгийн дансны код", "Борлуулалтын дансны код", "Жижиглэнгийн үнэ", "Бөөний үнэ",
                      "Бар код", "Бүт.Үйл нэгдсэн код", "Брэнд", "Төрөл", "НӨАТ тооцохгүй бол",
                      "Татвар чөлөөлөгдөх код", "Задрах нэгж", "Задрах харьцаа"]


# ══════════════════════════════════════════════════════════════════════════
# Лавлах: Эрхэтийн барааны жагсаалт (mtime кэштэй)
# ══════════════════════════════════════════════════════════════════════════
_ref_cache: dict = {"key": None, "data": None}
_ref_lock = threading.Lock()


def _s(v) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    if s.lower() in ("nan", "none"):
        return ""
    return s[:-2] if s.endswith(".0") and s[:-2].isdigit() else s


def _split_barcodes(v) -> list[str]:
    out = []
    for p in re.split(r"[\s,;|/]+", _s(v)):
        p = p.strip()
        if p and p not in out:
            out.append(p)
    return out


def _latest_erkhet_file() -> Optional[Path]:
    if not ERKHET_UPLOAD_DIR.exists():
        return None
    files = [f for f in ERKHET_UPLOAD_DIR.glob("*.xl*") if f.is_file()]
    return max(files, key=lambda f: f.stat().st_mtime) if files else None


def refs() -> dict:
    """{products, by_code, by_barcode, categories, brands, units, source}."""
    f = _latest_erkhet_file()
    key = (str(f), f.stat().st_mtime) if f else None
    with _ref_lock:
        if _ref_cache["key"] == key and _ref_cache["data"] is not None:
            return _ref_cache["data"]
        data = _build_refs(f)
        _ref_cache.update(key=key, data=data)
        return data


def _build_refs(f: Optional[Path]) -> dict:
    empty = {"products": [], "by_code": {}, "by_barcode": {}, "categories": {}, "brands": {}, "units": [],
             "source": None}
    if f is None:
        return empty
    import pandas as pd
    try:
        df = pd.read_excel(str(f), dtype=str, engine="calamine")
    except Exception:
        df = pd.read_excel(str(f), dtype=str)
    if "Код" not in df.columns:
        return empty
    products, by_code, by_bc = [], {}, {}
    cats: dict[str, dict] = {}
    brands: dict[str, str] = {}
    units: dict[str, int] = {}
    for _, r in df.iterrows():
        code = _s(r.get("Код"))
        if not code:
            continue
        ratio = 0.0
        try:
            ratio = float(_s(r.get("Задрах харьцаа")) or 0)
        except ValueError:
            pass
        p = {
            "code": code, "name": _s(r.get("Нэр")), "category_code": _s(r.get("Ангилал код")),
            "category_name": _s(r.get("Ангилал нэр")), "barcodes": _split_barcodes(r.get("Баркод")),
            "unit_code": _s(r.get("Хэмжих нэгж код")) or "ш", "sales_account": _s(r.get("БО данс дугаар")),
            "cost_account": _s(r.get("ББӨ данс дугаар")), "box_unit_code": _s(r.get("Задрах нэгж код")),
            "pack_ratio": round(1 / ratio) if ratio > 0 else 0, "type_code": _s(r.get("Төрөл код")),
            "gs1_code": _s(r.get("Бүт.Үйл код")), "brand_code": _s(r.get("Брэнд код")), "brand_name": _s(r.get("Брэнд нэр")),
        }
        products.append(p)
        by_code[code] = p
        for b in p["barcodes"]:
            by_bc.setdefault(b, p)
        c = cats.setdefault(p["category_code"], {"code": p["category_code"], "name": p["category_name"], "count": 0, "codes": []})
        c["count"] += 1
        c["codes"].append(code)
        if p["brand_code"]:
            brands[p["brand_code"]] = p["brand_name"]
        units[p["unit_code"]] = units.get(p["unit_code"], 0) + 1
    return {"products": products, "by_code": by_code, "by_barcode": by_bc, "categories": cats, "brands": brands,
            "units": [u for u, _ in sorted(units.items(), key=lambda x: -x[1])],
            "source": {"file": f.name, "updated_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="minutes"),
                       "products": len(products)}}


def _taken_codes(db: Session, exclude_id: int = 0) -> set[str]:
    q = db.query(NewProduct.item_code).filter(NewProduct.item_code != "", NewProduct.status != "registered")
    if exclude_id:
        q = q.filter(NewProduct.id != exclude_id)
    return {c for (c,) in q.all()}


def next_code(db: Session, category_code: str, exclude_id: int = 0) -> str:
    """Ангиллын кодоор эхэлсэн (ихэнх нь 6 оронтой) кодуудын дараагийн чөлөөтийг олно —
    мастерт ч, бусад ноорогт ч давхцахгүй."""
    r = refs()
    cat = r["categories"].get(category_code)
    if not cat:
        return ""
    codes = [c for c in cat["codes"] if c.isdigit()]
    pref = [c for c in codes if c.startswith(category_code)]
    base_codes = pref or codes
    if not base_codes:
        return ""
    from collections import Counter
    width = Counter(len(c) for c in base_codes).most_common(1)[0][0]   # ихэнх ангилалд 6 оронтой
    nxt = max(int(c) for c in base_codes if len(c) == width) + 1
    taken = set(r["by_code"].keys()) | _taken_codes(db, exclude_id)
    while str(nxt).zfill(width) in taken:
        nxt += 1
    return str(nxt).zfill(width)


def template_defaults(category_code: str, brand_code: str) -> dict:
    """Ижил брэнд+ангилал (эсвэл ангилал) доторх хамгийн сүүлийн барааны дансыг, нэгжийг авна."""
    r = refs()
    prods = r["products"]
    cand = [p for p in prods if p["category_code"] == category_code and p["brand_code"] == brand_code] \
        or [p for p in prods if p["category_code"] == category_code] or prods[-50:]
    if not cand:
        return {"unit_code": "ш", "box_unit_code": "ха", "sales_account": "510101", "cost_account": "610101",
                "type_code": "", "gs1_code": ""}
    t = max(cand, key=lambda p: (len(p["code"]), p["code"]))
    return {"unit_code": t["unit_code"] or "ш", "box_unit_code": t["box_unit_code"] or "ха",
            "sales_account": t["sales_account"] or "510101", "cost_account": t["cost_account"] or "610101",
            "type_code": t["type_code"], "gs1_code": t["gs1_code"], "template_code": t["code"], "template_name": t["name"]}


# ══════════════════════════════════════════════════════════════════════════
# Шалгалт (алдаа = импортлохгүй, анхааруулга = мэдээлэл)
# ══════════════════════════════════════════════════════════════════════════
def issues(db: Session, x: NewProduct) -> list[dict]:
    r = refs()
    out: list[dict] = []
    err = lambda m: out.append({"level": "error", "msg": m})     # noqa: E731
    warn = lambda m: out.append({"level": "warn", "msg": m})    # noqa: E731
    if not x.name.strip():
        err("Нэр хоосон")
    if not x.item_code.strip():
        err("Барааны код хоосон")
    elif x.status != "registered" and x.item_code in r["by_code"]:
        p = r["by_code"][x.item_code]
        err(f"{x.item_code} код Эрхэтэд аль хэдийн байна: {p['name']}")
    if not x.category_code:
        err("Ангилал сонгоогүй")
    elif r["categories"] and x.category_code not in r["categories"]:
        warn(f"«{x.category_code}» ангиллын код Эрхэтийн жагсаалтад алга")
    if not x.brand_code:
        err("Брэнд сонгоогүй")
    if not (x.pack_ratio and x.pack_ratio > 0):
        err("Хайрцаг дахь ширхэг 0")
    if not (x.weight_kg and x.weight_kg > 0):
        warn("Жин 0 — ачааны тооцоонд хэрэгтэй")
    if not x.unit_code:
        err("Хэмжих нэгж хоосон")
    if not (x.sales_account and x.cost_account):
        err("Борлуулалт/өртгийн данс хоосон")
    if x.status != "registered":
        for b in _split_barcodes(x.barcode):
            if b in r["by_barcode"]:
                p = r["by_barcode"][b]
                err(f"Баркод {b} Эрхэтэд «{p['code']} {p['name']}» бараанд бүртгэлтэй")
            if not re.fullmatch(r"\d{8}|\d{12,14}", b):
                warn(f"Баркод {b} EAN-8/13 хэлбэрт таарахгүй")
        dup = db.query(NewProduct.id).filter(NewProduct.id != (x.id or 0), NewProduct.status != "registered",
                                             NewProduct.item_code == x.item_code, NewProduct.item_code != "").first()
        if dup:
            err(f"{x.item_code} кодыг өөр шинэ бараа (#{dup[0]}) ашиглаж байна")
        if x.name.strip() and x.brand_code:
            nm = x.name.strip().lower()
            same = [p for p in r["products"] if p["brand_code"] == x.brand_code]
            best = max(same, key=lambda p: difflib.SequenceMatcher(None, nm, p["name"].lower()).ratio(), default=None)
            if best and difflib.SequenceMatcher(None, nm, best["name"].lower()).ratio() >= 0.9:
                warn(f"Нэр нь «{best['code']} {best['name']}»-тэй маш төстэй — давхар бүртгэл биш эсэхийг шалгана уу")
    if not x.retail_price:
        warn("Жижиглэнгийн үнэ 0")
    return out


def _has_errors(db: Session, x: NewProduct) -> bool:
    return any(i["level"] == "error" for i in issues(db, x))


def _auto_status(db: Session, x: NewProduct) -> None:
    if x.status in ("draft", "ready"):
        x.status = "draft" if _has_errors(db, x) else "ready"


def sync_registered(db: Session) -> int:
    """Эрхэтийн сүүлийн жагсаалтад код нь орсон шинэ барааг «Мастерт орсон» болгоно."""
    r = refs()
    if not r["by_code"]:
        return 0
    n = 0
    for x in db.query(NewProduct).filter(NewProduct.status.in_(("ready", "sent", "imported", "fail", "draft"))).all():
        if x.item_code and x.item_code in r["by_code"] and x.status in ("sent", "imported"):
            x.status = "registered"
            n += 1
    if n:
        db.commit()
    return n


def _item_dict(db: Session, x: NewProduct, with_issues: bool = True) -> dict:
    d = {c: getattr(x, c) for c in ("id", "status", "item_code", "name", "foreign_name", "category_code", "category_name",
                                     "brand_code", "brand_name", "barcode", "unit_code", "weight_kg", "pack_ratio",
                                     "box_unit_code", "retail_price", "wholesale_price", "sales_account", "cost_account",
                                     "type_code", "gs1_code", "vat_free", "tax_exempt_code", "notes", "erkhet_log_id",
                                     "erkhet_message", "created_by")}
    d["status_label"] = STATUS_LABEL.get(x.status, x.status)
    d["has_image"] = bool(x.image_path and Path(x.image_path).exists())
    d["created_at"] = (x.created_at.isoformat() + "Z") if x.created_at else None
    d["updated_at"] = (x.updated_at.isoformat() + "Z") if x.updated_at else None
    if with_issues:
        d["issues"] = issues(db, x)
    return d


# ══════════════════════════════════════════════════════════════════════════
# Зураг: фон устгах (rembg + onnxruntime байвал) / AI
# ══════════════════════════════════════════════════════════════════════════
def _remove_bg(image_bytes: bytes) -> tuple[str, bool]:
    """(data URL, фон устгасан эсэх). rembg нь onnxruntime-гүй үед import хийхэд
    ПРОЦЕССЫГ ЗОГСООДОГ (SystemExit) тул эхлээд байгаа эсэхийг шалгана."""
    if importlib.util.find_spec("onnxruntime") and importlib.util.find_spec("rembg"):
        try:
            from rembg import remove  # type: ignore
            from PIL import Image  # type: ignore
            img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
            buf = io.BytesIO()
            remove(img).save(buf, format="PNG")
            return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(), True
        except BaseException as e:  # noqa: BLE001 — rembg SystemExit-ыг ч барина
            print(f"[new-product] rembg алдаа: {e}")
    return "data:image/jpeg;base64," + base64.b64encode(image_bytes).decode(), False


def _vision_models() -> list[str]:
    ms = [settings.gemini_vision_model or "gemini-3.5-flash",
          getattr(settings, "gemini_chat_model", "") or "gemini-3.5-flash-lite"]
    out = []
    for m in ms:
        if m and m not in out:
            out.append(m)
    return out


def _analyze_with_gemini(photos: list[bytes], brand: str, categories: list[str]) -> dict:
    if not settings.gemini_api_key:
        raise HTTPException(500, "Gemini API key тохируулагдаагүй (backend/.env → GEMINI_API_KEY).")
    try:
        from google import genai as ggenai  # type: ignore
        from PIL import Image as PILImage  # type: ignore
    except ImportError:
        raise HTTPException(500, "google-genai пакет суугаагүй.")
    # Ачаалалтай (503) үед SDK-ийн анхдагч олон дахин оролдлого ~20с иддэг — нэг удаа
    # оролдоод шууд дараагийн (нөөц) модел руу шилжинэ.
    try:
        from google.genai import types as gtypes  # type: ignore
        client = ggenai.Client(api_key=settings.gemini_api_key, http_options=gtypes.HttpOptions(
            timeout=60_000, retry_options=gtypes.HttpRetryOptions(attempts=1)))
    except Exception:
        client = ggenai.Client(api_key=settings.gemini_api_key)
    cat_list = "; ".join(categories[:120]) if categories else "мэдэгдэхгүй"
    prompt = f"""Та барааны савлагааны зургуудыг уншиж, ЗӨВХӨН JSON буцаана:
{{"name": "...", "foreign_name": "...", "weight_kg": 0.0, "barcode": "", "pack_ratio": 0, "suggested_category": "..."}}
Дүрэм:
- name: Монгол бараа нэрлэх хэв маягаар — «Брэнд/нэр + төрөл + хэмжээ», ж: «Jacobs Monarch кофе 95гр», «Coca-Cola 1.5л».
- foreign_name: савлагаан дээрх латин/орос бүтэн нэр.
- weight_kg: НЭГ ширхгийн цэвэр жин/эзэлхүүн кг-аар (гр→/1000, мл≈гр, л≈кг). Олдохгүй бол 0.
- barcode: EAN-13/EAN-8 цифрүүд (хэд байвал таслалаар). Олдохгүй бол "".
- pack_ratio: хайрцаг/багц дахь ширхэг (24ш, 12x гэх мэт) харагдвал тоо, үгүй бол 0.
- suggested_category: Доорх жагсаалтаас ЯГ нэгийг нь (кодтой нь) сонгоно: {cat_list}
Бренд (хэрэглэгч оруулсан): {brand or "тодорхойгүй"}"""
    parts: list = [prompt]
    for b in photos[:5]:
        parts.append(PILImage.open(io.BytesIO(b)).convert("RGB"))
    last_err = ""
    for model in _vision_models():
        try:
            resp = client.models.generate_content(model=model, contents=parts)
            raw = resp.text or "{}"
            m = re.search(r"\{.*\}", raw, re.S)
            data = json.loads(m.group()) if m else {}
            data["_model"] = model
            return data
        except json.JSONDecodeError:
            return {"_model": model}
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            print(f"[new-product] {model}: {last_err[:160]}")
            if "api_key" in last_err.lower() or "API_KEY_INVALID" in last_err:
                raise HTTPException(500, "Gemini API key буруу.")
            continue   # 503 (ачаалал) / 429 / бусад → дараагийн модел
    if "429" in last_err or "RESOURCE_EXHAUSTED" in last_err:
        raise HTTPException(429, "Gemini хязгаарт хүрлээ — хэсэг хүлээгээд дахин оролдоно уу.")
    raise HTTPException(503, "AI одоогоор ачаалалтай байна — хэсэг хүлээгээд дахин оролдоно уу (эсвэл гараар бөглөнө).")


def _match_category(suggested: str) -> tuple[str, str]:
    cats = refs()["categories"]
    if not cats:
        return "", suggested
    s = (suggested or "").strip()
    m = re.match(r"\s*(\d{2,4})\b", s)
    if m and m.group(1) in cats:
        c = cats[m.group(1)]
        return c["code"], c["name"]
    names = {c["name"]: code for code, c in cats.items()}
    best = difflib.get_close_matches(s, list(names.keys()), n=1, cutoff=0.3)
    if best:
        return names[best[0]], best[0]
    return "", s


def _match_brand(text: str) -> tuple[str, str]:
    brands = refs()["brands"]
    t = (text or "").strip()
    if not t:
        return "", ""
    if t in brands:
        return t, brands[t]
    by_name = {v.lower(): k for k, v in brands.items()}
    if t.lower() in by_name:
        k = by_name[t.lower()]
        return k, brands[k]
    best = difflib.get_close_matches(t.lower(), list(by_name.keys()), n=1, cutoff=0.6)
    if best:
        k = by_name[best[0]]
        return k, brands[k]
    return "", t


# ══════════════════════════════════════════════════════════════════════════
# Endpoints
# ══════════════════════════════════════════════════════════════════════════
@router.get("/refs")
def get_refs(db: Session = Depends(get_db), _u: User = Depends(get_current_user)):
    r = refs()
    cats = sorted(r["categories"].values(), key=lambda c: c["code"])
    return {
        "source": r["source"],
        "categories": [{"code": c["code"], "name": c["name"], "count": c["count"]} for c in cats],
        "brands": [{"code": k, "name": v} for k, v in sorted(r["brands"].items(), key=lambda kv: kv[1].lower())],
        "units": r["units"] or ["ш"],
        "statuses": STATUS_LABEL,
    }


@router.get("/next-code")
def get_next_code(category: str, exclude_id: int = 0, db: Session = Depends(get_db), _u: User = Depends(get_current_user)):
    return {"category": category, "code": next_code(db, category, exclude_id)}


@router.get("/defaults")
def get_defaults(category: str = "", brand: str = "", _u: User = Depends(get_current_user)):
    return template_defaults(category, brand)


@router.post("/analyze")
async def analyze_product(
    photos: List[UploadFile] = File(...),
    brand: str = Form(""),
    pack_ratio: int = Form(0),
    db: Session = Depends(get_db),
    _u: User = Depends(require_role(*EDIT_ROLES)),
):
    if not photos:
        raise HTTPException(400, "Хамгийн багадаа 1 зураг оруулна уу")
    pb = [await f.read() for f in photos]
    image, bg_removed = _remove_bg(pb[0])
    r = refs()
    cats = [f"{c['code']} {c['name']}" if not c["name"].startswith(c["code"]) else c["name"]
            for c in sorted(r["categories"].values(), key=lambda c: c["code"])]
    brand_code, brand_name = _match_brand(brand)
    ai = _analyze_with_gemini(pb, brand_name or brand, cats)
    cat_code, cat_name = _match_category(str(ai.get("suggested_category", "")))
    code = next_code(db, cat_code) if cat_code else ""
    defaults = template_defaults(cat_code, brand_code)
    barcode = ",".join(_split_barcodes(ai.get("barcode", "")))
    existing = next((r["by_barcode"][b] for b in _split_barcodes(barcode) if b in r["by_barcode"]), None)
    try:
        ai_pack = int(float(ai.get("pack_ratio") or 0))
    except (TypeError, ValueError):
        ai_pack = 0
    try:
        weight = round(float(ai.get("weight_kg") or 0), 4)
    except (TypeError, ValueError):
        weight = 0.0
    return {
        "processed_image_b64": image, "bg_removed": bg_removed,
        "name": str(ai.get("name") or ""), "foreign_name": str(ai.get("foreign_name") or ""),
        "barcode": barcode, "weight_kg": weight,
        "pack_ratio": pack_ratio or ai_pack or 0,
        "category_code": cat_code, "category_name": cat_name, "item_code": code,
        "brand_code": brand_code, "brand_name": brand_name or brand,
        **{k: defaults.get(k, "") for k in ("unit_code", "box_unit_code", "sales_account", "cost_account", "type_code", "gs1_code")},
        "template": {"code": defaults.get("template_code", ""), "name": defaults.get("template_name", "")},
        "existing": {"code": existing["code"], "name": existing["name"]} if existing else None,
        "ai_model": ai.get("_model", ""),
    }


class ItemIn(BaseModel):
    item_code: str = ""
    name: str = ""
    foreign_name: str = ""
    category_code: str = ""
    brand_code: str = ""
    barcode: str = ""
    unit_code: str = "ш"
    weight_kg: float = 0
    pack_ratio: float = 0
    box_unit_code: str = "ха"
    retail_price: float = 0
    wholesale_price: float = 0
    sales_account: str = "510101"
    cost_account: str = "610101"
    type_code: str = ""
    gs1_code: str = ""
    vat_free: bool = False
    tax_exempt_code: str = ""
    notes: str = ""
    image_b64: Optional[str] = None            # үндсэн зураг (data URL)
    photos_b64: Optional[List[str]] = None     # бусад зураг
    ai: Optional[dict] = None


def _apply(x: NewProduct, b: ItemIn) -> None:
    r = refs()
    x.item_code = re.sub(r"\s+", "", b.item_code)
    x.name = b.name.strip()[:255]
    x.foreign_name = b.foreign_name.strip()[:255]
    x.category_code = b.category_code.strip()
    x.category_name = r["categories"].get(x.category_code, {}).get("name", "") if x.category_code else ""
    x.brand_code = b.brand_code.strip()
    x.brand_name = r["brands"].get(x.brand_code, "") if x.brand_code else ""
    x.barcode = ",".join(_split_barcodes(b.barcode))
    x.unit_code = b.unit_code.strip() or "ш"
    x.weight_kg = max(float(b.weight_kg or 0), 0)
    x.pack_ratio = max(float(b.pack_ratio or 0), 0)
    x.box_unit_code = b.box_unit_code.strip()
    x.retail_price = max(float(b.retail_price or 0), 0)
    x.wholesale_price = max(float(b.wholesale_price or 0), 0)
    x.sales_account = b.sales_account.strip()
    x.cost_account = b.cost_account.strip()
    x.type_code = b.type_code.strip()
    x.gs1_code = b.gs1_code.strip()
    x.vat_free = bool(b.vat_free)
    x.tax_exempt_code = b.tax_exempt_code.strip()
    x.notes = b.notes.strip()[:1000]
    x.updated_at = datetime.utcnow()


def _save_images(x: NewProduct, b: ItemIn) -> None:
    def dec(u: str) -> tuple[bytes, str]:
        head, _, data = u.partition(",")
        ext = "png" if "png" in head else "jpg"
        return base64.b64decode(data or head), ext
    d = IMG_DIR / str(x.id)
    if b.image_b64:
        d.mkdir(parents=True, exist_ok=True)
        raw, ext = dec(b.image_b64)
        p = d / f"main.{ext}"
        p.write_bytes(raw)
        x.image_path = str(p)
    if b.photos_b64:
        d.mkdir(parents=True, exist_ok=True)
        paths = []
        for i, u in enumerate(b.photos_b64[:6]):
            raw, ext = dec(u)
            p = d / f"photo_{i}.{ext}"
            p.write_bytes(raw)
            paths.append(str(p))
        x.photos = json.dumps(paths)


def _who(u: User) -> str:
    return (getattr(u, "nickname", "") or u.username or "").strip()


@router.get("/items")
def list_items(status: str = "", q: str = "", db: Session = Depends(get_db), _u: User = Depends(get_current_user)):
    sync_registered(db)
    qry = db.query(NewProduct)
    if status:
        qry = qry.filter(NewProduct.status.in_(status.split(",")))
    rows = qry.order_by(NewProduct.id.desc()).limit(500).all()
    if q:
        t = q.strip().lower()
        rows = [x for x in rows if t in f"{x.item_code} {x.name} {x.barcode} {x.brand_name}".lower()]
    counts: dict[str, int] = {}
    for (st,) in db.query(NewProduct.status).all():
        counts[st] = counts.get(st, 0) + 1
    return {"items": [_item_dict(db, x) for x in rows], "counts": counts, "source": refs()["source"]}


@router.get("/items/{item_id}")
def get_item(item_id: int, db: Session = Depends(get_db), _u: User = Depends(get_current_user)):
    x = db.get(NewProduct, item_id)
    if not x:
        raise HTTPException(404, "Олдсонгүй")
    return _item_dict(db, x)


@router.post("/items")
def create_item(body: ItemIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    x = NewProduct(created_by=_who(u), created_at=datetime.utcnow())
    _apply(x, body)
    x.ai_json = json.dumps(body.ai or {}, ensure_ascii=False)[:20000]
    db.add(x)
    db.commit()
    db.refresh(x)
    _save_images(x, body)
    _auto_status(db, x)
    db.commit()
    audit(db, request, u, action="new_product_create", entity_type="new_product", entity_id=x.id,
          after={"code": x.item_code, "name": x.name, "barcode": x.barcode}, autocommit=True)
    return _item_dict(db, x)


@router.put("/items/{item_id}")
def update_item(item_id: int, body: ItemIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    x = db.get(NewProduct, item_id)
    if not x:
        raise HTTPException(404, "Олдсонгүй")
    if x.status in ("sent", "imported", "registered"):
        raise HTTPException(400, "Эрхэтэд илгээгдсэн/орсон барааг энд засахгүй — Эрхэт дээр засна")
    before = {"code": x.item_code, "name": x.name, "barcode": x.barcode}
    _apply(x, body)
    _save_images(x, body)
    if x.status == "fail":
        x.status = "draft"          # Эрхэт буцаасан → засаад дахин шалгаж илгээнэ
    _auto_status(db, x)
    db.commit()
    audit(db, request, u, action="new_product_update", entity_type="new_product", entity_id=x.id,
          before=before, after={"code": x.item_code, "name": x.name, "barcode": x.barcode}, autocommit=True)
    return _item_dict(db, x)


@router.delete("/items/{item_id}")
def delete_item(item_id: int, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*EDIT_ROLES))):
    x = db.get(NewProduct, item_id)
    if not x:
        raise HTTPException(404, "Олдсонгүй")
    if x.status in ("sent", "imported") and (getattr(u, "base_role", None) or u.role) != "admin":
        raise HTTPException(400, "Эрхэтэд илгээсэн барааг зөвхөн admin устгана")
    db.delete(x)
    db.commit()
    import shutil
    shutil.rmtree(IMG_DIR / str(item_id), ignore_errors=True)
    audit(db, request, u, action="new_product_delete", entity_type="new_product", entity_id=item_id,
          before={"code": x.item_code, "name": x.name}, autocommit=True)
    return {"ok": True}


@router.get("/items/{item_id}/image")
def item_image(item_id: int, db: Session = Depends(get_db)):
    """<img src>-д токенгүй ачаалагдах тул нэвтрэлт шаардахгүй (зөвхөн барааны зураг)."""
    x = db.get(NewProduct, item_id)
    if not x or not x.image_path or not Path(x.image_path).exists():
        raise HTTPException(404, "Зураг алга")
    return FileResponse(x.image_path, headers={"Cache-Control": "no-cache"})


# ── Эрхэтийн «Бараа материалын нэр төрөл» импорт Excel ────────────────────
def _build_inv_excel(items: list[NewProduct]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    ws = wb.active
    ws.title = "Import"
    ws.append(ERKHET_INV_HEADERS)
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="3258A0")
        c.alignment = Alignment(horizontal="center", wrap_text=True)
    text_cols = {1, 2, 5, 7, 8, 11, 12, 13, 14, 16, 17}     # кодын багана — текстээр (урдах 0 хадгална)
    for x in items:
        ratio = round(1 / x.pack_ratio, 12) if x.pack_ratio and x.pack_ratio > 0 else None
        row = [x.category_code, x.item_code, x.name, x.foreign_name or x.name, x.unit_code, x.weight_kg or 0,
               x.cost_account, x.sales_account, x.retail_price or 0, x.wholesale_price or None,
               x.barcode, x.gs1_code or None, x.brand_code, x.type_code or None, 1 if x.vat_free else None,
               x.tax_exempt_code or None, x.box_unit_code or None, ratio]
        ws.append(row)
        rr = ws.max_row
        for ci in text_cols:
            cell = ws.cell(row=rr, column=ci)
            if cell.value is not None:
                cell.value = str(cell.value)
                cell.number_format = "@"
    widths = [10, 10, 38, 34, 8, 8, 10, 10, 12, 12, 16, 12, 10, 8, 10, 10, 8, 14]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class IdsIn(BaseModel):
    ids: List[int]
    force: bool = False


def _pick(db: Session, ids: list[int]) -> list[NewProduct]:
    items = db.query(NewProduct).filter(NewProduct.id.in_(ids or [0])).order_by(NewProduct.item_code).all()
    if not items:
        raise HTTPException(400, "Бараа сонгоогүй байна")
    return items


@router.post("/export")
def export_excel(body: IdsIn, db: Session = Depends(get_db), _u: User = Depends(require_role(*EDIT_ROLES, "accountant"))):
    items = _pick(db, body.ids)
    data = _build_inv_excel(items)
    fname = f"Шинэ_бараа_{datetime.now():%Y%m%d_%H%M}_{len(items)}ш.xlsx"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"})


def _apply_log_to_items(db: Session, log: ErkhetImportLog) -> None:
    items = db.query(NewProduct).filter(NewProduct.erkhet_log_id == log.id).all()
    st = {"ok": "imported", "fail": "fail"}.get(log.status, "sent")
    for x in items:
        if x.status != "registered":
            x.status = st
            x.erkhet_message = (log.message or log.erkhet_status or "")[:1000]
    db.commit()


@router.get("/erkhet-imports")
def list_np_imports(brand: Optional[str] = None, db: Session = Depends(get_db), _u: User = Depends(get_current_user)):
    logs = (db.query(ErkhetImportLog).filter(ErkhetImportLog.qty_source == "new_product")
            .order_by(ErkhetImportLog.id.desc()).limit(30).all())
    eimp.refresh_pending(db, logs)
    for lg in logs:
        _apply_log_to_items(db, lg)
    return [eimp.log_dict(r) for r in logs]


@router.post("/erkhet-imports/{log_id}/refresh")
def refresh_np_import(log_id: int, db: Session = Depends(get_db), _u: User = Depends(get_current_user)):
    from app.services.erkhet_client import ErkhetError
    r = db.query(ErkhetImportLog).filter(ErkhetImportLog.id == log_id, ErkhetImportLog.qty_source == "new_product").first()
    if not r:
        raise HTTPException(404, "Импортын бүртгэл олдсонгүй")
    try:
        eimp.refresh_logs(db, [r])
    except ErkhetError as e:
        raise HTTPException(502, str(e))
    _apply_log_to_items(db, r)
    return {**eimp.log_dict(r), "ok": True if r.status == "ok" else (False if r.status == "fail" else None),
            "errors": [r.message] if r.status == "fail" and r.message else []}


@router.post("/erkhet-import")
def erkhet_import(body: IdsIn, request: Request, db: Session = Depends(get_db), u: User = Depends(require_role(*eimp.IMPORT_ROLES))):
    """Сонгосон шинэ бараануудыг Эрхэтийн «Бараа материалын нэр төрөл» импорт руу шууд илгээнэ."""
    items = _pick(db, body.ids)
    bad = [x for x in items if _has_errors(db, x)]
    if bad:
        raise HTTPException(400, "Алдаатай бараа байна — засаад дахин илгээнэ үү: " +
                            ", ".join(f"{x.item_code or '#' + str(x.id)} {x.name}" for x in bad[:10]))
    done = [x for x in items if x.status in ("sent", "imported", "registered")]
    if done and not body.force:
        return JSONResponse(status_code=409, content={
            "detail": f"{len(done)} барааг Эрхэт рүү өмнө илгээсэн — дахин илгээвэл давхар бүртгэл/алдаа үүснэ.",
            "previous": [{"id": x.erkhet_log_id or x.id, "brand": x.brand_name, "title": f"{x.item_code} {x.name}",
                          "status": {"sent": "queued", "imported": "ok", "registered": "ok"}[x.status], "queue_id": None,
                          "erkhet_import_id": None, "erkhet_status": STATUS_LABEL.get(x.status, x.status),
                          "doc_count": 0, "row_count": 1, "message": x.erkhet_message, "username": x.created_by,
                          "created_at": (x.updated_at.isoformat() + "Z") if x.updated_at else None} for x in done[:5]],
        })
    data = _build_inv_excel(items)
    filename = f"Шинэ_бараа_{datetime.now():%Y%m%d_%H%M}_{len(items)}ш.xlsx"   # Эрхэтийн гарчиг = файлын нэр
    log, res = eimp.submit(db, data=data, filename=filename, nrows=len(items), year=datetime.now().year,
                           company=eimp.IMPORT_COMPANY, brand="", qty_source="new_product", username=(u.username or ""),
                           kind=ERKHET_KIND, tag="NEWPROD")
    for x in items:
        x.erkhet_log_id = log.id
    db.commit()
    _apply_log_to_items(db, log)
    audit(db, request, u, action="new_product_erkhet_import", entity_type="erkhet_import", entity_id=log.id,
          after={"codes": [x.item_code for x in items], "status": log.status, "queue_id": log.queue_id},
          extra={"message": log.message[:500]} if log.message else None, autocommit=True)
    return eimp.response(log, res, datetime.now().year)
