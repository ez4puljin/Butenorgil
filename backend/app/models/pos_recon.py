"""POS тулгалтын өдрийн үр дүн — урьдчилан тооцоолж хадгална.

Яагаад хадгалдаг вэ: нэг өдрийн бүрэн шалгалт (захиалгын жагсаалт татах +
Эрхэт рүү орсон эсэхийг асуух) POS тутамд ~13 секунд болно. Календарь дээр
30 хоног × 2 POS = ~13 минут — шууд тооцоолох боломжгүй. Тиймээс шөнийн
ажил өдөр бүр тооцоод энд бичнэ, календарь эндээс шууд уншина.

Хоёр шатыг ТУСАД нь хадгална:
    1→2: offline POS → erxes   (local_count vs erxes_count, буцаалтыг хасаад)
    2→3: erxes → Эрхэт          (synced_count vs unsynced_count)
"""
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class PosReconDay(Base):
    __tablename__ = "pos_recon_days"
    __table_args__ = (UniqueConstraint("day", "pos_token", name="uq_recon_day_pos"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    day: Mapped[str] = mapped_column(String(10), index=True, default="")
    pos_token: Mapped[str] = mapped_column(String(80), index=True, default="")
    pos_name: Mapped[str] = mapped_column(String(120), default="")

    # ── 1-р шат: offline POS → erxes ──────────────────────────────
    local_count: Mapped[int] = mapped_column(Integer, default=0)     # кассын нийт
    erxes_count: Mapped[int] = mapped_column(Integer, default=0)     # erxes дээр
    returns_count: Mapped[int] = mapped_column(Integer, default=0)   # буцаалт
    unexplained: Mapped[int] = mapped_column(Integer, default=0)     # тайлбаргүй зөрүү

    # ── 2-р шат: erxes → Эрхэт ────────────────────────────────────
    synced_count: Mapped[int] = mapped_column(Integer, default=0)
    unsynced_count: Mapped[int] = mapped_column(Integer, default=0)

    # ok = бүх зүйл таарсан · warn = Эрхэт рүү дутуу · bad = тайлбаргүй зөрүү
    # эсвэл шалгаж чадаагүй
    status: Mapped[str] = mapped_column(String(10), default="ok", index=True)
    error: Mapped[str] = mapped_column(String(250), default="")
    checked_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
