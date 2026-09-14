"""AI чат — ERP-ийн өгөгдлөөс асуултад хариулна (Gemini function calling).

Зарчим: LLM-д SQL бичүүлэхгүй. Оронд нь урьдчилан тодорхойлсон, ЗӨВХӨН УНШИХ
"tool" функцүүдийг өгнө. Gemini асуултаас хамаарч тохирох tool-уудыг сонгож
дуудаад, буцаж ирсэн бодит тоон дээр тулгуурлан монголоор хариулна.

Яагаад tool гэж:
  • Аюулгүй — дурын SQL байхгүй, зөвхөн уншина (устгах/өөрчлөх боломжгүй)
  • Тоо зөв — одоо ажиллаж байгаа бизнес логикийг (balance_stock,
    ebarimt_report г.м) дахин ашиглана, LLM тоо зохиохгүй
  • Хурдан — байгаа cache дээр тулгуурлана
  • Хянагдана — ямар tool дуудсаныг хариултын хамт буцаана

Endpoint:
  POST /ai-chat/ask   — {question, history[]} → {answer, tools_used[]}
  GET  /ai-chat/status — тохиргоо бэлэн эсэх
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.api.deps import get_db, get_current_user
from app.core.config import settings
from app.models.user import User

router = APIRouter(prefix="/ai-chat", tags=["ai-chat"])

MAX_ROWS = 40          # нэг tool-оос буцаах дээд мөр (token хэмнэнэ)
MAX_HISTORY = 12       # харилцааны түүхээс авах дээд мессеж


# ── Крилл ↔ латин хайлт ──────────────────────────────────────────────────────
# Барааны нэр ихэвчлэн латинаар хадгалагддаг ("Coca cola"), харин хэрэглэгч
# кириллээр асуудаг ("Кока кола"). Хөрвүүлсэн хувилбаруудаар мөн хайна.
_CYR2LAT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "j", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "ө": "o", "п": "p", "р": "r", "с": "s", "т": "t",
    "у": "u", "ү": "u", "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh",
    "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def _search_terms(query: str) -> list[str]:
    """Хайх үгийн боломжит хувилбарууд (эх, латин-k, латин-c)."""
    q = (query or "").strip().lower()
    if not q:
        return []
    out = {q}
    if any(ch in _CYR2LAT for ch in q):
        for k_as in ("k", "c"):
            out.add("".join(k_as if ch == "к" else _CYR2LAT.get(ch, ch) for ch in q))
    return [t for t in out if t]


def _product_filter(Product, query: str):
    """Product-ийг нэр/код/бренд/barcode-оор, крилл-латин хувилбар бүрээр хайх нөхцөл."""
    clauses = []
    for t in _search_terms(query):
        like = f"%{t}%"
        clauses += [Product.name.ilike(like), Product.item_code.ilike(like),
                    Product.brand.ilike(like), Product.barcode.ilike(like)]
    return or_(*clauses) if clauses else None


# ── Tool-ууд (db-г closure-аар барина) ───────────────────────────────────────

def _build_tools(db: Session, calls: list[str]):
    """Gemini-д өгөх tool функцүүдийг үүсгэнэ.

    Функц бүр энгийн төрлийн параметртэй, docstring-тэй байх ёстой —
    google-genai SDK эдгээрээс автоматаар schema үүсгэдэг."""

    def _log(name: str, detail: str = "") -> None:
        calls.append(f"{name}({detail})" if detail else name)

    # ── Бараа ────────────────────────────────────────────────────────
    def search_products(query: str) -> dict:
        """Барааг нэр, код, бренд, зураасан кодоор хайна.

        Args:
            query: Хайх үг — барааны нэр, item_code, бренд эсвэл barcode.
        """
        from app.models.product import Product
        _log("search_products", query)
        cond = _product_filter(Product, query)
        rows = db.query(Product).filter(cond).limit(MAX_ROWS).all() if cond is not None else []
        return {"count": len(rows), "products": [{
            "item_code": p.item_code, "name": p.name, "brand": p.brand,
            "pack_ratio": p.pack_ratio, "last_purchase_price": p.last_purchase_price,
            "location_tag": p.warehouse_name,
        } for p in rows]}

    def get_stock(query: str, location: str = "warehouse") -> dict:
        """Барааны ОДООГИЙН үлдэгдлийг үлдэгдлийн файлаас харна.

        Args:
            query: Барааны нэр, код эсвэл бренд.
            location: "warehouse" (бүх агуулах) эсвэл "showroom" (үндсэн+архи заал).
        """
        from app.models.product import Product
        from app.services.balance_stock import get_location_stock_map
        loc = "showroom" if str(location).lower().startswith("show") else "warehouse"
        _log("get_stock", f"{query}, {loc}")
        smap = get_location_stock_map(db, loc)
        if not smap:
            return {"error": "Үлдэгдлийн файл оруулаагүй байна (Файл оруулалт → Үлдэгдлийн файл)."}
        cond = _product_filter(Product, query)
        prods = db.query(Product).filter(cond).limit(MAX_ROWS).all() if cond is not None else []
        if not prods:
            return {"error": f"'{query}' нэртэй бараа олдсонгүй. Өөр нэр/кодоор хайж үзнэ үү "
                             f"(барааны нэр ихэвчлэн латинаар бичигдсэн байдаг)."}
        out = []
        for p in prods:
            qty = float(smap.get(str(p.item_code).strip(), 0.0))
            boxes = round(qty / p.pack_ratio, 1) if p.pack_ratio and p.pack_ratio > 0 else None
            out.append({"item_code": p.item_code, "name": p.name, "brand": p.brand,
                        "stock_pcs": qty, "stock_boxes": boxes})
        return {"location": loc, "count": len(out), "items": out}

    def get_product_sales(query: str, months: int = 3) -> dict:
        """Барааны сүүлийн саруудын борлуулалт (агуулах + заал).

        Args:
            query: Барааны нэр, код эсвэл бренд.
            months: Хэдэн сарын өгөгдөл авах (анхдагч 3).
        """
        from app.models.product import Product
        from app.models.product_monthly_sales import ProductMonthlySales
        _log("get_product_sales", f"{query}, {months}с")
        cond = _product_filter(Product, query)
        codes = [c for (c,) in db.query(Product.item_code).filter(cond).limit(MAX_ROWS).all()] if cond is not None else []
        if not codes:
            return {"error": f"'{query}' нэртэй бараа олдсонгүй."}
        n = max(1, min(int(months or 3), 24))
        rows = db.query(ProductMonthlySales).filter(
            ProductMonthlySales.item_code.in_(codes),
        ).order_by(ProductMonthlySales.year.desc(), ProductMonthlySales.month.desc()).limit(n * len(codes)).all()
        agg: dict[tuple, dict] = {}
        for r in rows:
            k = (r.year, r.month)
            a = agg.setdefault(k, {"year": r.year, "month": r.month, "warehouse": 0.0, "showroom": 0.0})
            a["warehouse"] += float(r.qty_warehouse or 0)
            a["showroom"] += float(r.qty_showroom or 0)
        months_out = sorted(agg.values(), key=lambda x: (-x["year"], -x["month"]))[:n]
        for m in months_out:
            m["total"] = m["warehouse"] + m["showroom"]
        total = sum(m["total"] for m in months_out)
        return {"matched_products": len(codes), "months": months_out,
                "total_pcs": total, "avg_per_month": round(total / max(1, len(months_out)), 1)}

    # ── Хугацааны хяналт ─────────────────────────────────────────────
    def get_expiring_items(days: int = 30) -> dict:
        """Хугацаа нь дуусах гэж буй барааны жагсаалт.

        Args:
            days: Хэдэн хоногийн дотор дуусахыг харах (анхдагч 30).
        """
        from app.models.expiration_item import ExpirationItem
        from app.models.product import Product
        _log("get_expiring_items", f"{days} хоног")
        d = max(1, min(int(days or 30), 365))
        limit_date = date.today() + timedelta(days=d)
        rows = db.query(ExpirationItem, Product).outerjoin(
            Product, Product.id == ExpirationItem.product_id,
        ).filter(
            ExpirationItem.expiration_date <= limit_date,
            ExpirationItem.status != "archived",
        ).order_by(ExpirationItem.expiration_date).limit(MAX_ROWS).all()
        out = []
        for r, p in rows:
            out.append({
                "product": p.name if p else "",
                "item_code": p.item_code if p else "",
                "brand": p.brand if p else "",
                "expiration_date": r.expiration_date.isoformat(),
                "days_left": (r.expiration_date - date.today()).days,
                "qty_floor": r.qty_floor, "qty_warehouse": r.qty_warehouse,
                "status": r.status,
            })
        return {"within_days": d, "count": len(out), "items": out}

    # ── Захиалга / Тулгалт ───────────────────────────────────────────
    def get_orders_summary(days: int = 14, status: str = "") -> dict:
        """Сүүлийн үеийн захиалгуудын товч мэдээлэл.

        Args:
            days: Сүүлийн хэдэн хоног (анхдагч 14).
            status: Шүүх төлөв — preparing, reviewing, ordered, done. Хоосон бол бүгд.
        """
        from app.models.purchase_order import PurchaseOrder, PurchaseOrderLine
        _log("get_orders_summary", f"{days} хоног, {status or 'бүгд'}")
        d = max(1, min(int(days or 14), 365))
        since = date.today() - timedelta(days=d)
        q = db.query(PurchaseOrder).filter(PurchaseOrder.order_date >= since,
                                           PurchaseOrder.is_archived == False)
        if status.strip():
            q = q.filter(PurchaseOrder.status == status.strip())
        orders = q.order_by(PurchaseOrder.order_date.desc()).limit(MAX_ROWS).all()
        ids = [o.id for o in orders]
        counts = dict(db.query(PurchaseOrderLine.purchase_order_id, func.count(PurchaseOrderLine.id))
                      .filter(PurchaseOrderLine.purchase_order_id.in_(ids))
                      .group_by(PurchaseOrderLine.purchase_order_id).all()) if ids else {}
        return {"count": len(orders), "orders": [{
            "id": o.id, "date": o.order_date.isoformat(), "status": o.status,
            "location": o.location, "lines": counts.get(o.id, 0), "notes": (o.notes or "")[:120],
        } for o in orders]}

    def get_receivings_summary(days: int = 14) -> dict:
        """Сүүлийн үеийн бараа тулгаж авах ажлуудын товч мэдээлэл.

        Args:
            days: Сүүлийн хэдэн хоног (анхдагч 14).
        """
        from app.models.receiving import ReceivingSession, ReceivingLine
        _log("get_receivings_summary", f"{days} хоног")
        d = max(1, min(int(days or 14), 365))
        since = date.today() - timedelta(days=d)
        rows = db.query(ReceivingSession).filter(
            ReceivingSession.date >= since,
            ReceivingSession.is_archived == False,
        ).order_by(ReceivingSession.date.desc()).limit(MAX_ROWS).all()
        ids = [s.id for s in rows]
        counts = dict(db.query(ReceivingLine.session_id, func.count(ReceivingLine.id))
                      .filter(ReceivingLine.session_id.in_(ids))
                      .group_by(ReceivingLine.session_id).all()) if ids else {}
        return {"count": len(rows), "sessions": [{
            "id": s.id, "date": s.date.isoformat(),
            "status": getattr(s, "status", ""), "lines": counts.get(s.id, 0),
        } for s in rows]}

    # ── Ebarimt ──────────────────────────────────────────────────────
    def get_ebarimt_summary(year: int, month: int, employee: str = "") -> dict:
        """Ebarimt-ын дутуу шивэлтийн товч — худалдан авалт vs шивсэн дүн.

        Args:
            year: Он (жишээ 2026).
            month: Сар 1-12.
            employee: Хариуцсан ажилтны нэрээр шүүх. Хоосон бол бүгд.
        """
        from app.api.ebarimt_report import get_report
        _log("get_ebarimt_summary", f"{year}-{month}, {employee or 'бүгд'}")
        try:
            rep = get_report(db, int(year), int(month))
        except Exception as e:
            return {"error": f"Ebarimt тайлан авахад алдаа: {e}"}
        if rep.get("error"):
            return {"error": rep["error"]}
        rows = rep.get("rows", [])
        if employee.strip():
            rows = [r for r in rows if employee.strip().lower() in (r.get("employee", "") or "").lower()]
        missing = [r for r in rows if r["diff_orgil"] > 0.5 or r["diff_harhorin"] > 0.5]
        missing.sort(key=lambda r: -(max(r["diff_orgil"], 0) + max(r["diff_harhorin"], 0)))
        return {
            "year": year, "month": month, "employee": employee or "бүгд",
            "customers": len(rows), "missing_count": len(missing),
            "total_missing": round(sum(max(r["diff_orgil"], 0) + max(r["diff_harhorin"], 0) for r in missing)),
            "top_missing": [{
                "name": r["name"], "employee": r["employee"], "phone": r["phone"],
                "missing_orgil": round(max(r["diff_orgil"], 0)),
                "missing_harhorin": round(max(r["diff_harhorin"], 0)),
            } for r in missing[:20]],
        }

    # ── Банк ─────────────────────────────────────────────────────────
    def get_bank_summary(date_from: str, date_to: str = "") -> dict:
        """Банкны хуулгын орлого/зарлагын нийлбэр, дансаар.

        Args:
            date_from: Эхлэх огноо "YYYY-MM-DD".
            date_to: Дуусах огноо "YYYY-MM-DD". Хоосон бол date_from-той ижил.
        """
        from app.models.bank_statement import BankStatement, BankTransaction
        _log("get_bank_summary", f"{date_from}..{date_to or date_from}")
        try:
            d1 = date.fromisoformat(date_from)
            d2 = date.fromisoformat(date_to) if date_to.strip() else d1
        except ValueError:
            return {"error": "Огноо буруу. 'YYYY-MM-DD' хэлбэрээр бичнэ үү."}
        day = func.coalesce(BankStatement.date_from, func.date(BankStatement.uploaded_at))
        stmts = db.query(BankStatement).filter(day >= d1.isoformat(), day <= d2.isoformat()).all()
        out = []
        for s in stmts:
            main = [t for t in s.transactions if not t.is_fee]
            out.append({
                "account": s.account_number, "date": s.date_from.isoformat() if s.date_from else None,
                "credit": round(sum(t.credit for t in main)), "debit": round(sum(t.debit for t in main)),
                "txn_count": len(main),
            })
        return {"from": d1.isoformat(), "to": d2.isoformat(), "statements": len(out),
                "total_credit": round(sum(o["credit"] for o in out)),
                "total_debit": round(sum(o["debit"] for o in out)), "accounts": out}

    # ── Дата хэр шинэ вэ ─────────────────────────────────────────────
    def get_data_freshness() -> dict:
        """Эрхэт/erxes-ээс орж ирдэг файлууд хэзээ сүүлд шинэчлэгдсэнийг харна.

        Үлдэгдэл, борлуулалт, хөдөлгөөн зэрэг өгөгдөл нь гараар оруулсан
        Excel файлаас ирдэг тул ХУУЧИРСАН байж болно. Үлдэгдэл, борлуулалтын
        тоо хэлэхийн ӨМНӨ энэ tool-ыг дуудаж, дата хуучин бол хэрэглэгчид
        хэдэн хоногийн өмнөх мэдээлэл болохыг заавал сануул."""
        from app.models.balance_file import BalanceFile
        from app.models.income_file import IncomeFile
        from app.models.movement_file import MovementFile
        from app.models.ebarimt_file import EbarimtFile
        _log("get_data_freshness")
        now = datetime.utcnow()

        def age(dt) -> dict | None:
            if not dt:
                return None
            hours = (now - dt).total_seconds() / 3600
            return {"uploaded_at": dt.isoformat(timespec="minutes"),
                    "age_hours": round(hours, 1), "age_days": round(hours / 24, 1)}

        out: dict[str, object] = {}
        names = {"warehouse": "Бүх агуулахын үлдэгдэл", "main": "Үндсэн заалны үлдэгдэл",
                 "liquor": "Архины заалны үлдэгдэл"}
        out["balance_files"] = [
            {"kind": names.get(b.kind, b.kind), "filename": b.original_filename, **(age(b.uploaded_at) or {})}
            for b in db.query(BalanceFile).all()
        ]
        inc = db.query(IncomeFile).order_by(IncomeFile.year.desc(), IncomeFile.month.desc()).first()
        out["income_file"] = ({"year": inc.year, "month": (inc.month or 0) or None,
                               "filename": inc.original_filename,
                               **(age(inc.uploaded_at) or {})} if inc else None)
        mv = db.query(MovementFile).order_by(MovementFile.year.desc()).first()
        out["movement_file"] = ({"year": mv.year, **(age(mv.uploaded_at) or {})} if mv else None)
        eb = db.query(EbarimtFile).order_by(
            EbarimtFile.year.desc(), EbarimtFile.month.desc()).first()
        out["ebarimt_file"] = ({"year": eb.year, "month": eb.month,
                                **(age(eb.uploaded_at) or {})} if eb else None)
        out["note"] = ("Эдгээр нь Эрхэт/erxes-ээс гараар оруулсан файлууд. "
                       "age_days их байвал дата хуучирсан гэсэн үг.")
        return out

    return [search_products, get_stock, get_product_sales, get_expiring_items,
            get_orders_summary, get_receivings_summary, get_ebarimt_summary,
            get_bank_summary, get_data_freshness]


SYSTEM_PROMPT = """Чи бол "Бүтэн-Оргил" компанийн ERP системийн туслах.

Дүрэм:
1. ЗААВАЛ өгөгдсөн tool-уудыг ашиглаж бодит өгөгдөл ав. Тоо ЗОХИОХГҮЙ.
   Өгөгдөл хэрэгтэй бол tool-ыг ЗААВАЛ дууд. Tool дуудалгүйгээр "алдаа гарлаа",
   "мэдээлэл татаж чадсангүй" гэж бичихийг ХОРИГЛОНО — эхлээд tool-оо дууд.
   Хэрэглэгчийн заасан тоог (хоног, сар, он) tool-ийн параметрт ЯГ дамжуул —
   "14 хоног" гэвэл days=14, анхдагч утгыг бүү ашигла.
2. Хариултаа МОНГОЛООР, товч, ойлгомжтой бич.
3. Тоог мянгатаар таслаж бич (жишээ: 1,234,567₮).
4. Олон мөр байвал хүснэгт (markdown table) хэрэглэ.
5. Хэрэв tool өгөгдөл олохгүй бол шууд "олдсонгүй" гэж хэл — таамаглахгүй.
6. Хэрэглэгчийн асуулт тодорхойгүй бол тодруулах асуулт асуу.
7. ҮЛДЭГДЭЛ, БОРЛУУЛАЛТ-ын тоо хэлэхдээ get_data_freshness-ээр дата хэр
   шинэ болохыг шалга. Хэрэв 2 хоногоос хуучин бол хариултын төгсгөлд
   "⚠️ Энэ дата N хоногийн өмнөх файлаас" гэж заавал сануул.
8. Өнөөдрийн огноо: {today}
"""


class ChatMsg(BaseModel):
    role: str = "user"          # user | model
    text: str = ""


class AskIn(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    history: list[ChatMsg] = []


@router.get("/status")
def status(_: User = Depends(get_current_user)):
    """AI чат ашиглах боломжтой эсэх (API key тохируулагдсан уу)."""
    return {
        "enabled": bool((settings.gemini_api_key or "").strip()),
        "model": getattr(settings, "gemini_chat_model", "gemini-3.5-flash-lite"),
    }


@router.post("/ask")
def ask(
    body: AskIn,
    db: Session = Depends(get_db),
    u: User = Depends(get_current_user),
):
    """Асуултад ERP-ийн өгөгдөл дээр тулгуурлан хариулна."""
    api_key = (settings.gemini_api_key or "").strip()
    if not api_key:
        raise HTTPException(500, "Gemini API key тохируулагдаагүй. backend/.env-д GEMINI_API_KEY нэмнэ үү.")

    try:
        from google import genai
        from google.genai import types
    except ImportError:
        raise HTTPException(500, "google-genai сан суугаагүй байна.")

    model = getattr(settings, "gemini_chat_model", "") or "gemini-3.5-flash-lite"
    fallback = (getattr(settings, "gemini_chat_fallback_model", "") or "").strip()

    # Харилцааны түүх + шинэ асуулт
    contents = []
    for m in body.history[-MAX_HISTORY:]:
        role = "model" if m.role == "model" else "user"
        if (m.text or "").strip():
            contents.append(types.Content(role=role, parts=[types.Part(text=m.text[:4000])]))
    contents.append(types.Content(role="user", parts=[types.Part(text=body.question)]))

    import time as _time
    _t0 = _time.time()
    client = genai.Client(api_key=api_key)
    cfg_kwargs = dict(
        system_instruction=SYSTEM_PROMPT.format(today=date.today().isoformat()),
        temperature=0.2,
    )

    def run(model_name: str) -> tuple[str, list[str]]:
        """Нэг модел дээр асуултыг ажиллуулж (хариулт, дуудсан tool) буцаана."""
        calls: list[str] = []
        resp = client.models.generate_content(
            model=model_name,
            contents=contents,
            config=types.GenerateContentConfig(tools=_build_tools(db, calls), **cfg_kwargs),
        )
        return (resp.text or "").strip(), calls

    try:
        answer, calls = run(model)
        # Flash-Lite заримдаа tool дуудалгүй "алдаа гарлаа" гэж хариулдаг.
        # Tool огт дуудагдаагүй бол илүү найдвартай модел дээр НЭГ удаа давтана.
        if not calls and fallback and fallback != model:
            try:
                answer2, calls2 = run(fallback)
                if calls2 or not answer:
                    answer, calls = answer2, calls2
            except Exception:
                pass   # fallback бүтэлгүйтвэл эхний хариултаа хэвээр ашиглана
    except Exception as e:
        _log_question(db, u, body.question, [], ok=0, ms=int((_time.time() - _t0) * 1000))
        err = str(e)
        if "quota" in err.lower() or "429" in err or "RESOURCE_EXHAUSTED" in err:
            raise HTTPException(429, "Gemini-ийн үнэгүй хязгаарт хүрлээ. Хэсэг хүлээгээд дахин оролдоно уу.")
        if "api_key" in err.lower() or "API_KEY" in err or "INVALID_ARGUMENT" in err:
            raise HTTPException(500, "Gemini API key буруу байна. backend/.env-г шалгана уу.")
        raise HTTPException(500, f"AI алдаа: {err[:250]}")

    if not answer:
        answer = "Уучлаарай, хариулт үүсгэж чадсангүй. Асуултаа өөрөөр асууж үзнэ үү."
    _log_question(db, u, body.question, calls, ok=1, ms=int((_time.time() - _t0) * 1000))
    return {"answer": answer, "tools_used": calls}


def _log_question(db: Session, user, question: str, tools: list[str],
                  ok: int = 1, ms: int = 0) -> None:
    """Асуулт + ашигласан tool-ыг бүртгэнэ (ХАРИУЛТ ХАДГАЛАХГҮЙ).
    Алдаа гарвал чимээгүй өнгөрнө — лог нь чатыг хэзээ ч зогсоохгүй."""
    try:
        from app.models.ai_chat_log import AiChatLog
        # tool нэрийг л авна (аргументгүй) — бүлэглэхэд тохиромжтой
        names = sorted({t.split("(")[0] for t in tools})
        db.add(AiChatLog(
            username=str(getattr(user, "username", "") or "")[:80],
            question=(question or "").strip()[:500],
            tools=",".join(names)[:300], ok=ok, ms=ms,
        ))
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


@router.get("/log")
def chat_log(
    limit: int = 20,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Хамгийн их асуудаг асуултууд + сүүлийн үеийн асуултууд.

    Хамгийн их асуудгийг чатын эхлэлийн санал болгох хэсэгт харуулна —
    хүмүүс бодитоор юу асуудгийг тусгана."""
    from sqlalchemy import func as _f
    from app.models.ai_chat_log import AiChatLog
    n = max(1, min(int(limit or 20), 50))
    top = db.query(
        AiChatLog.question, _f.count(AiChatLog.id).label("cnt"),
    ).filter(AiChatLog.ok == 1, AiChatLog.question != "").group_by(
        AiChatLog.question,
    ).order_by(_f.count(AiChatLog.id).desc(), AiChatLog.question).limit(n).all()
    recent = db.query(AiChatLog).order_by(AiChatLog.created_at.desc()).limit(n).all()
    return {
        "top": [{"question": q, "count": c} for q, c in top],
        "recent": [{
            "at": r.created_at.isoformat(timespec="minutes") if r.created_at else None,
            "user": r.username, "question": r.question,
            "tools": [x for x in (r.tools or "").split(",") if x],
            "ok": bool(r.ok), "ms": r.ms,
        } for r in recent],
    }
