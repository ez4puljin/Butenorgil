"""Зарцуулалт: токен → USD, ai_usage_log бичих, сар/өдрийн нийлбэр, хязгаар шалгах."""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from app.core.config import settings

# $ / 1 сая токен (2026-10 Anthropic-ийн үнэ). Cache бичилт = 1.25× оролт (5 мин), унших ≈ 0.1×.
# .env-ийн AI_PRICES-аар дарж бичнэ. Үл мэдэгдэх загварыг өндөр (Opus) үнээр тооцно — дутуу биш илүү.
DEFAULT_PRICES = {
    "claude-haiku-5-5": {"in": 0.10, "out": 0.50, "cache_read": 0.01, "cache_write": 0.125},
    "claude-sonnet-5-5": {"in": 2.00, "out": 10.00, "cache_read": 0.20, "cache_write": 2.50},
}
FALLBACK_PRICE = {"in": 5.00, "out": 25.00, "cache_read": 0.50, "cache_write": 6.25}
UB = timedelta(hours=8)
BUDGET_FEATURES = {"chat": "ai_monthly_budget_usd"}   # бусад (invoice, new_product, test) → ai_invoice_budget_usd


def prices() -> dict:
    p = dict(DEFAULT_PRICES)
    try:
        p.update(json.loads(settings.ai_prices or "{}"))
    except Exception:
        pass
    return p


def cost_usd(model: str, inp: int, out: int, cache_read: int = 0, cache_write: int = 0) -> float:
    pr = prices().get(model, FALLBACK_PRICE)
    return round((inp * pr["in"] + out * pr["out"] + cache_read * pr.get("cache_read", pr["in"] * 0.1)
                  + cache_write * pr.get("cache_write", pr["in"] * 1.25)) / 1_000_000, 6)


def tokens(usage) -> tuple[int, int, int, int]:
    """response.usage → (input, output, cache_read, cache_write). input_tokens нь cache-ээс ГАДУУРХ хэсэг."""
    g = lambda k: int(getattr(usage, k, 0) or 0)  # noqa: E731
    return g("input_tokens"), g("output_tokens"), g("cache_read_input_tokens"), g("cache_creation_input_tokens")


def log(user, feature: str, model: str, usage=None, question_id: str = "", error: str = "") -> float:
    """Нэг дуудлагыг бичнэ (өөрийн session-оор — дуудагчийн транзакцад нөлөөлөхгүй). → зардал USD."""
    from app.core.db import SessionLocal
    from app.models.ai_usage import AiUsageLog
    i, o, cr, cw = tokens(usage) if usage is not None else (0, 0, 0, 0)
    c = cost_usd(model, i, o, cr, cw)
    db = SessionLocal()
    try:
        db.add(AiUsageLog(user_id=int(getattr(user, "id", 0) or 0), username=str(getattr(user, "username", "") or "")[:80],
                          feature=feature, model=model, input_tokens=i, output_tokens=o, cache_read_tokens=cr,
                          cache_write_tokens=cw, cost_usd=c, question_id=question_id, ok=0 if error else 1,
                          error=error[:300]))
        db.commit()
    except Exception as e:  # noqa: BLE001 — бүртгэл алдаа чатыг зогсоохгүй
        db.rollback()
        print(f"[ai] usage log: {e}")
    finally:
        db.close()
    return c


def month_start_utc(now: datetime | None = None) -> datetime:
    """Anthropic-ийн тооцооны сар — UTC-ийн хуанлийн сар."""
    now = now or datetime.utcnow()
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def day_start_utc(now: datetime | None = None) -> datetime:
    """УБ-ын өнөөдрийн 00:00 (UTC-ээр) — өдрийн асуултын тоонд."""
    ub = (now or datetime.utcnow()) + UB
    return ub.replace(hour=0, minute=0, second=0, microsecond=0) - UB


def month_spend(db, now: datetime | None = None) -> float:
    from sqlalchemy import func
    from app.models.ai_usage import AiUsageLog
    v = db.query(func.coalesce(func.sum(AiUsageLog.cost_usd), 0.0)).filter(
        AiUsageLog.created_at >= month_start_utc(now)).scalar()
    return float(v or 0)


def budget_for(feature: str) -> float:
    return float(getattr(settings, BUDGET_FEATURES.get(feature, "ai_invoice_budget_usd")))


def questions_today(db, user_id: int, now: datetime | None = None) -> int:
    from sqlalchemy import func
    from app.models.ai_usage import AiUsageLog
    return int(db.query(func.count(func.distinct(AiUsageLog.question_id))).filter(
        AiUsageLog.feature == "chat", AiUsageLog.user_id == user_id, AiUsageLog.question_id != "",
        AiUsageLog.created_at >= day_start_utc(now)).scalar() or 0)
