"""Claude API дуудлага бүрийн зарцуулалт (app/ai/usage.py бичнэ).

Мөр бүр = НЭГ API дуудлага (response.usage). Чатын нэг асуулт tool-той бол хэд хэдэн дуудлага
болдог тул question_id-аар бүлэглэж «өдөрт хэдэн асуулт» тоолно.
"""
from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class AiUsageLog(Base):
    __tablename__ = "ai_usage_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)  # UTC
    user_id: Mapped[int] = mapped_column(Integer, default=0, index=True)
    username: Mapped[str] = mapped_column(String(80), default="")
    feature: Mapped[str] = mapped_column(String(20), default="chat", index=True)   # chat / invoice / new_product / test
    model: Mapped[str] = mapped_column(String(60), default="")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    question_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    ok: Mapped[int] = mapped_column(Integer, default=1)          # 0 = API алдаа (токен 0)
    error: Mapped[str] = mapped_column(String(300), default="")
