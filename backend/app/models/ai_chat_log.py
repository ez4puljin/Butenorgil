"""AI туслахаас юу асуудгийн бүртгэл.

ЗӨВХӨН асуулт + ашигласан tool-ыг хадгална — ХАРИУЛТ ХАДГАЛАХГҮЙ.
Ингэснээр нууцлалын эрсдэл бага (хариултад харилцагчийн нэр, дүн ордог),
харин "хүмүүс юу асуудаг вэ?" гэдэг нь тодорхой болно.

Зорилго: хамгийн их асуудаг зүйлд зориулж жинхэнэ цэс/тайлан барих.
Жишээ: өдөр бүр "X барааны нөөц хэд вэ?" гэж асуудаг бол — AI биш,
сканнердаж хардаг хуудас хэрэгтэй гэсэн дохио.
"""
from sqlalchemy import Integer, String, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime

from app.core.db import Base


class AiChatLog(Base):
    __tablename__ = "ai_chat_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    username: Mapped[str] = mapped_column(String(80), default="", index=True)
    question: Mapped[str] = mapped_column(String(500), default="")
    tools: Mapped[str] = mapped_column(String(300), default="")   # таслалаар тусгаарласан
    ok: Mapped[int] = mapped_column(Integer, default=1)           # 1=амжилттай, 0=алдаа
    ms: Mapped[int] = mapped_column(Integer, default=0)           # хариулах хугацаа
