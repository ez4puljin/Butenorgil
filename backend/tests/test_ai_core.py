"""app/ai — Anthropic client-ийг mock хийж, санах ойн SQLite дээр (production DB-д бичихгүй)."""
from datetime import datetime
from types import SimpleNamespace

import anthropic
import httpx2 as httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.core.db as core_db
from app.ai import client as ai
from app.ai import usage
from app.ai.errors import AIError, translate
from app.core.config import settings
from app.models.ai_usage import AiUsageLog

USER = SimpleNamespace(id=7, username="tester")


class Env:
    """Санах ойн DB + mock Claude client + тохиргоог түр солино."""

    def __init__(self, reply=None, error=None, **cfg):
        self.reply, self.error, self.calls = reply, error, []
        self.cfg = {"anthropic_api_key": "sk-test", "ai_monthly_budget_usd": 180.0, "ai_invoice_budget_usd": 195.0,
                    "ai_daily_questions_per_user": 50, "ai_prices": "", **cfg}

    def __enter__(self):
        eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        AiUsageLog.__table__.create(eng)
        self.Session = sessionmaker(bind=eng)
        self._old_session, core_db.SessionLocal = core_db.SessionLocal, self.Session
        self._old_cfg = {k: getattr(settings, k) for k in self.cfg}
        for k, v in self.cfg.items():
            setattr(settings, k, v)
        env = self

        def create(**kw):
            env.calls.append(kw)
            if env.error:
                raise env.error
            return env.reply or reply_obj()
        self._old_client, ai._client = ai._client, SimpleNamespace(messages=SimpleNamespace(create=create))
        return self

    def __exit__(self, *a):
        core_db.SessionLocal, ai._client = self._old_session, self._old_client
        for k, v in self._old_cfg.items():
            setattr(settings, k, v)

    def rows(self):
        db = self.Session()
        try:
            return db.query(AiUsageLog).order_by(AiUsageLog.id).all()
        finally:
            db.close()


def reply_obj(i=1000, o=200, cr=0, cw=0, text="Сайн байна уу"):
    return SimpleNamespace(model="claude-haiku-5-5", content=[SimpleNamespace(type="text", text=text)],
                           usage=SimpleNamespace(input_tokens=i, output_tokens=o, cache_read_input_tokens=cr,
                                                 cache_creation_input_tokens=cw))


def api_error(cls, status, body_type="error", msg="x"):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    resp = httpx.Response(status, request=req, json={"type": "error", "error": {"type": body_type, "message": msg}})
    return cls(msg, response=resp, body={"type": "error", "error": {"type": body_type, "message": msg}})


def _raises(fn) -> AIError:
    try:
        fn()
    except AIError as e:
        return e
    raise AssertionError("AIError гарах ёстой байсан")


def test_cost_haiku_and_sonnet():
    # Haiku: 1M оролт $0.10, 1M гаралт $0.50
    assert usage.cost_usd("claude-haiku-5-5", 1_000_000, 1_000_000) == 0.6
    assert usage.cost_usd("claude-sonnet-5-5", 10_000, 2_000) == 0.04
    assert usage.cost_usd("claude-sonnet-5-5", 0, 0, cache_read=1_000_000) == 0.2
    assert usage.cost_usd("unknown-model", 1_000_000, 0) == 5.0      # үл мэдэгдэх → өндөр үнэ


def test_price_override_from_env():
    with Env(ai_prices='{"claude-haiku-5-5": {"in": 1, "out": 2}}'):
        assert usage.cost_usd("claude-haiku-5-5", 1_000_000, 1_000_000) == 3.0


def test_create_logs_usage():
    with Env(reply=reply_obj(i=2000, o=500, cr=8000, cw=100)) as env:
        r = ai.create(USER, "chat", "q1", max_tokens=100, messages=[{"role": "user", "content": "hi"}])
        assert r.content[0].text == "Сайн байна уу"
        assert env.calls[0]["model"] == "claude-haiku-5-5"
        (row,) = env.rows()
        assert (row.user_id, row.feature, row.input_tokens, row.output_tokens, row.cache_read_tokens,
                row.cache_write_tokens, row.question_id, row.ok) == (7, "chat", 2000, 500, 8000, 100, "q1", 1)
        assert abs(row.cost_usd - usage.cost_usd("claude-haiku-5-5", 2000, 500, 8000, 100)) < 1e-9


def test_invoice_uses_sonnet_model_from_settings():
    with Env(ai_model_invoice="claude-sonnet-5-5") as env:
        ai.create(USER, "invoice", max_tokens=10, messages=[])
        assert env.calls[0]["model"] == "claude-sonnet-5-5"


def test_not_configured():
    with Env(anthropic_api_key="") as env:
        db = env.Session()
        assert _raises(lambda: ai.check(db, USER, "chat")).code == "not_configured"
        assert env.rows() == []


def _spend(env, usd, feature="chat"):
    db = env.Session()
    db.add(AiUsageLog(user_id=1, feature=feature, model="m", cost_usd=usd))
    db.commit()
    db.close()


def test_monthly_budget_chat_180_invoice_195():
    with Env() as env:
        db = env.Session()
        _spend(env, 179.0)
        ai.check(db, USER, "chat")                      # 179 < 180 — зөвшөөрнө
        _spend(env, 1.5)                                # 180.5
        assert _raises(lambda: ai.check(db, USER, "chat")).code == "budget"
        ai.check(db, USER, "invoice")                   # падаан 195 хүртэл
        _spend(env, 15.0, "invoice")                    # 195.5
        assert _raises(lambda: ai.check(db, USER, "invoice")).code == "budget"


def test_last_month_spend_not_counted():
    with Env() as env:
        db = env.Session()
        db.add(AiUsageLog(user_id=1, feature="chat", model="m", cost_usd=500.0, created_at=datetime(2020, 1, 5)))
        db.commit()
        ai.check(db, USER, "chat")


def test_daily_question_limit_counts_questions_not_calls():
    with Env(ai_daily_questions_per_user=2) as env:
        db = env.Session()
        for q in ("a", "a", "a", "b"):                   # 2 асуулт, 4 дуудлага (tool loop)
            ai.create(USER, "chat", q, max_tokens=10, messages=[])
        assert _raises(lambda: ai.check(db, USER, "chat", question=True)).code == "daily_limit"
        ai.check(db, SimpleNamespace(id=8, username="other"), "chat", question=True)   # өөр хэрэглэгч


def test_api_errors_become_mongolian_and_are_logged():
    cases = [
        (api_error(anthropic.AuthenticationError, 401, "authentication_error"), "auth"),
        (api_error(anthropic.BadRequestError, 400, "invalid_request_error",
                   "Your credit balance is too low to access the Anthropic API."), "billing"),
        (api_error(anthropic.InternalServerError, 529, "overloaded_error"), "overloaded"),
        (api_error(anthropic.RateLimitError, 429, "rate_limit_error"), "rate_limit"),
        (api_error(anthropic.NotFoundError, 404, "not_found_error"), "model"),
        (anthropic.APITimeoutError(request=httpx.Request("POST", "https://api.anthropic.com")), "timeout"),
        (anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com")), "connection"),
    ]
    for err, code in cases:
        with Env(error=err) as env:
            e = _raises(lambda: ai.create(USER, "chat", "q", max_tokens=10, messages=[]))
            assert e.code == code, (code, e.code)
            assert any("Ѐ" <= ch <= "ӿ" for ch in e.message)   # кирилл мессеж
            (row,) = env.rows()
            assert row.ok == 0 and row.cost_usd == 0 and row.error.startswith(code)


def test_translate_passthrough():
    e = AIError("x", 400, "y")
    assert translate(e) is e


def test_day_start_is_ulaanbaatar_midnight():
    # UTC 2026-10-27 17:00 = УБ 10-28 01:00 → өдөр УБ 10-28 00:00 = UTC 10-27 16:00
    assert usage.day_start_utc(datetime(2026, 10, 27, 17, 0)) == datetime(2026, 10, 27, 16, 0)
    assert usage.month_start_utc(datetime(2026, 10, 27, 17, 0)) == datetime(2026, 10, 1)
