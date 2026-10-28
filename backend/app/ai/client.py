"""Claude дуудах цорын ганц зам: хязгаар шалгах → messages.create → зарцуулалт бичих → алдаа орчуулах.

    from app.ai import client as ai
    ai.check(db, user, "chat", question=True)        # асуулт эхлэхэд нэг удаа
    resp = ai.create(user, "chat", qid, system=..., messages=..., max_tokens=1500)
"""
from __future__ import annotations

import threading
import uuid

from app.ai import usage
from app.ai.errors import NOT_CONFIGURED, AIError, translate
from app.core.config import settings

FEATURE_MODEL = {"chat": "ai_model_chat", "invoice": "ai_model_invoice", "new_product": "ai_model_invoice",
                 "test": "ai_model_chat"}
TIMEOUT = 90.0          # сек — SDK өөрөө 429/5xx/холболтыг 2 удаа давтана
_client = None
_lock = threading.Lock()


def configured() -> bool:
    return bool((settings.anthropic_api_key or "").strip())


def model_for(feature: str) -> str:
    return getattr(settings, FEATURE_MODEL.get(feature, "ai_model_chat"))


def get_client():
    global _client
    if not configured():
        raise NOT_CONFIGURED
    with _lock:
        if _client is None:
            import anthropic
            _client = anthropic.Anthropic(api_key=settings.anthropic_api_key.strip(), timeout=TIMEOUT, max_retries=2)
        return _client


def new_question_id() -> str:
    return uuid.uuid4().hex


def check(db, user, feature: str, question: bool = False) -> None:
    """Сарын төсөв (chat: AI_MONTHLY_BUDGET_USD, бусад: AI_INVOICE_BUDGET_USD) болон хэрэглэгчийн өдрийн асуултын тоог шалгана."""
    if not configured():
        raise NOT_CONFIGURED
    spent, limit = usage.month_spend(db), usage.budget_for(feature)
    if spent >= limit:
        raise AIError(f"AI сарын хязгаар дууссан (${spent:.2f} / ${limit:.0f}). Дараа сарын 1-нд сэргэнэ.",
                      429, "budget")
    if question:
        n, cap = usage.questions_today(db, int(getattr(user, "id", 0) or 0)), int(settings.ai_daily_questions_per_user)
        if n >= cap:
            raise AIError(f"Та өнөөдөр {cap} асуулт асуусан байна — өдрийн хязгаар. Маргааш дахин асууна уу.",
                          429, "daily_limit")


def create(user, feature: str, question_id: str = "", **kwargs):
    """messages.create + зарцуулалт бичих. model-ийг kwargs-д өгөөгүй бол feature-ээс."""
    model = kwargs.pop("model", None) or model_for(feature)
    try:
        resp = get_client().messages.create(model=model, **kwargs)
    except Exception as e:  # noqa: BLE001
        err = translate(e)
        if err.code != "not_configured":
            usage.log(user, feature, model, None, question_id, error=f"{err.code}: {e}"[:300])
        raise err from e
    usage.log(user, feature, model, resp.usage, question_id)
    return resp


def stream(user, feature: str, question_id: str = "", **kwargs):
    """messages.stream — ("text", str) хэсгүүдийг, төгсгөлд ("final", Message)-ийг yield хийнэ.
    Зарцуулалт create()-тэй адил бичигдэнэ."""
    model = kwargs.pop("model", None) or model_for(feature)
    try:
        with get_client().messages.stream(model=model, **kwargs) as s:
            for text in s.text_stream:
                yield "text", text
            resp = s.get_final_message()
    except Exception as e:  # noqa: BLE001
        err = translate(e)
        if err.code != "not_configured":
            usage.log(user, feature, model, None, question_id, error=f"{err.code}: {e}"[:300])
        raise err from e
    usage.log(user, feature, model, resp.usage, question_id)
    yield "final", resp
