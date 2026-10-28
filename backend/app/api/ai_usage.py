"""AI зарцуулалт (admin) — өнөөдөр / энэ сар, feature-ээр, хэрэглэгчээр, өдрөөр; холболт шалгах.

  GET  /ai-usage/summary — бүх тоо (admin)
  POST /ai-usage/test    — Claude-д маш богино хүсэлт илгээж холболт/түлхүүрийг шалгана (≈$0.0001)
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.ai import client as ai
from app.ai import usage
from app.ai.errors import AIError
from app.api.deps import get_db, require_role
from app.core.config import settings
from app.models.ai_usage import AiUsageLog
from app.models.user import User

router = APIRouter(prefix="/ai-usage", tags=["ai-usage"])

_SUMS = (func.count(AiUsageLog.id), func.coalesce(func.sum(AiUsageLog.cost_usd), 0.0),
         func.coalesce(func.sum(AiUsageLog.input_tokens + AiUsageLog.cache_read_tokens + AiUsageLog.cache_write_tokens), 0),
         func.coalesce(func.sum(AiUsageLog.output_tokens), 0))


def _group(db: Session, col, since: datetime) -> list[dict]:
    rows = db.query(col, *_SUMS).filter(AiUsageLog.created_at >= since).group_by(col).all()
    return sorted([{"key": k or "—", "calls": n, "cost": round(c, 4), "in_tokens": int(i), "out_tokens": int(o)}
                   for k, n, c, i, o in rows], key=lambda r: -r["cost"])


@router.get("/summary")
def summary(db: Session = Depends(get_db), _: User = Depends(require_role("admin"))):
    now = datetime.utcnow()
    month, day = usage.month_start_utc(now), usage.day_start_utc(now)
    spent = usage.month_spend(db, now)
    ub_date = func.date(AiUsageLog.created_at, "+8 hours")
    daily = db.query(ub_date, *_SUMS).filter(AiUsageLog.created_at >= month).group_by(ub_date).order_by(ub_date).all()
    recent = db.query(AiUsageLog).order_by(AiUsageLog.id.desc()).limit(50).all()
    questions = db.query(func.count(func.distinct(AiUsageLog.question_id))).filter(
        AiUsageLog.feature == "chat", AiUsageLog.question_id != "", AiUsageLog.created_at >= day).scalar() or 0
    return {
        "configured": ai.configured(),
        "models": {"chat": settings.ai_model_chat, "invoice": settings.ai_model_invoice},
        "budget": {"chat": settings.ai_monthly_budget_usd, "invoice": settings.ai_invoice_budget_usd,
                   "daily_questions": settings.ai_daily_questions_per_user},
        "month": {"from": (month + usage.UB).date().isoformat(), "cost": round(spent, 4),
                  "chat_blocked": spent >= settings.ai_monthly_budget_usd,
                  "all_blocked": spent >= settings.ai_invoice_budget_usd},
        "today": {"cost": round(float(db.query(_SUMS[1]).filter(AiUsageLog.created_at >= day).scalar() or 0), 4),
                  "questions": int(questions)},
        "by_feature_today": _group(db, AiUsageLog.feature, day),
        "by_feature_month": _group(db, AiUsageLog.feature, month),
        "by_user_month": _group(db, AiUsageLog.username, month),
        "by_model_month": _group(db, AiUsageLog.model, month),
        "daily": [{"date": d, "calls": n, "cost": round(c, 4)} for d, n, c, _i, _o in daily],
        "errors_month": db.query(func.count(AiUsageLog.id)).filter(AiUsageLog.created_at >= month,
                                                                   AiUsageLog.ok == 0).scalar() or 0,
        "recent": [{"at": r.created_at.isoformat() + "Z", "user": r.username, "feature": r.feature, "model": r.model,
                    "in": r.input_tokens, "out": r.output_tokens, "cache_read": r.cache_read_tokens,
                    "cache_write": r.cache_write_tokens, "cost": r.cost_usd, "ok": bool(r.ok), "error": r.error}
                   for r in recent],
    }


@router.post("/test")
def test(db: Session = Depends(get_db), u: User = Depends(require_role("admin"))):
    try:
        ai.check(db, u, "test")
        resp = ai.create(u, "test", max_tokens=200, output_config={"effort": "low"},
                         messages=[{"role": "user", "content": "Монголоор нэг богино өгүүлбэрээр мэндчил."}])
    except AIError as e:
        raise HTTPException(e.status, e.message)
    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
    i, o, cr, cw = usage.tokens(resp.usage)
    return {"ok": True, "model": resp.model, "reply": text[:300], "in": i, "out": o,
            "cost": usage.cost_usd(ai.model_for("test"), i, o, cr, cw)}
