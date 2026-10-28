"""AI туслах (Claude) — ERP-ийн өгөгдлөөс асуултад хариулна.

Зарчим: LLM-д SQL бичүүлэхгүй. Урьдчилан тодорхойлсон ЗӨВХӨН УНШИХ tool-ууд (app/ai/chat_tools),
read-only DB холболт, tool бүр цэсний эрхээр шүүгдэнэ. Хязгаар/зарцуулалт app/ai/client.

Endpoint:
  GET  /ai-chat/status — тохиргоо бэлэн эсэх
  POST /ai-chat/stream — {question, history[], page} → NDJSON урсгал (app/ai/chat.answer-ийн үйл явдлууд)
  GET  /ai-chat/log    — түгээмэл асуултууд
"""
from __future__ import annotations

import json
import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.ai import chat as ai_chat
from app.ai import client as ai
from app.ai.errors import AIError
from app.api.deps import get_current_user, get_db
from app.core.config import settings
from app.core.permissions import get_universal_pages
from app.models.role import Role
from app.models.user import User

router = APIRouter(prefix="/ai-chat", tags=["ai-chat"])


def user_perms(db: Session, u: User) -> set:
    """Цэсний эрх = role-ийн permissions + universal цэс (frontend-ийн can()-тэй адил)."""
    role = db.query(Role).filter(Role.value == u.role).first()
    return {p for p in ((role.permissions if role else "") or "").split(",") if p} | set(get_universal_pages())


class ChatMsg(BaseModel):
    role: str = "user"          # user | assistant
    text: str = ""


class PageCtx(BaseModel):
    menu: str = ""
    path: str = ""
    ids: list[str] = []


class AskIn(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    history: list[ChatMsg] = []
    page: PageCtx | None = None


@router.get("/status")
def status(db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    return {"enabled": ai.configured(), "model": settings.ai_model_chat,
            "allowed": "ai_chat" in user_perms(db, u),
            "daily_limit": settings.ai_daily_questions_per_user}


@router.post("/stream")
def stream(body: AskIn, db: Session = Depends(get_db), u: User = Depends(get_current_user)):
    perms = user_perms(db, u)
    if "ai_chat" not in perms:
        raise HTTPException(403, "AI туслах ашиглах эрх алга.")
    try:
        ai.check(db, u, "chat", question=True)
    except AIError as e:
        raise HTTPException(e.status, e.message)
    qid = ai.new_question_id()
    who = {"id": u.id, "username": u.username}
    question = body.question
    history = [m.model_dump() for m in body.history]
    page = body.page.model_dump() if body.page else None

    def gen():
        t0, tools, ok = time.time(), [], 1
        for ev in ai_chat.answer(_U(**who), perms, question, history, page, qid):
            if ev["t"] in ("done", "error"):
                tools, ok = ev.get("tools", []), int(ev["t"] == "done")
            yield json.dumps(ev, ensure_ascii=False) + "\n"
        _log_question(who["username"], question, tools, ok, int((time.time() - t0) * 1000))

    return StreamingResponse(gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class _U:
    """Stream дотор request-ийн DB session хаагдсан байдаг — хэрэглэгчийн id/нэрийг л авч явна."""

    def __init__(self, id: int, username: str):
        self.id, self.username = id, username


def _log_question(username: str, question: str, tools: list[str], ok: int, ms: int) -> None:
    """Асуулт + ашигласан tool-ыг бүртгэнэ (ХАРИУЛТ ХАДГАЛАХГҮЙ). Алдаа гарвал чимээгүй өнгөрнө."""
    from app.core import db as core_db
    from app.models.ai_chat_log import AiChatLog
    s = core_db.SessionLocal()
    try:
        s.add(AiChatLog(username=(username or "")[:80], question=(question or "").strip()[:500],
                        tools=",".join(sorted(set(tools)))[:300], ok=ok, ms=ms))
        s.commit()
    except Exception:  # noqa: BLE001
        s.rollback()
    finally:
        s.close()


@router.get("/log")
def chat_log(limit: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Хамгийн их асуудаг асуултууд (чатын эхлэлийн санал) + сүүлийн асуултууд."""
    from sqlalchemy import func
    from app.models.ai_chat_log import AiChatLog
    n = max(1, min(int(limit or 20), 50))
    top = db.query(AiChatLog.question, func.count(AiChatLog.id)).filter(
        AiChatLog.ok == 1, AiChatLog.question != "").group_by(AiChatLog.question).order_by(
        func.count(AiChatLog.id).desc(), AiChatLog.question).limit(n).all()
    recent = db.query(AiChatLog).order_by(AiChatLog.created_at.desc()).limit(n).all()
    return {
        "top": [{"question": q, "count": c} for q, c in top],
        "recent": [{"at": r.created_at.isoformat(timespec="minutes") if r.created_at else None,
                    "user": r.username, "question": r.question,
                    "tools": [x for x in (r.tools or "").split(",") if x], "ok": bool(r.ok), "ms": r.ms}
                   for r in recent],
    }
