"""Монголын цагийн туслах (UTC+8).

Апп бусад газар `datetime.utcnow()` хэрэглэдэг ч цаг бүртгэлд бодит
Монголын цаг ЗААВАЛ хэрэгтэй. Server OS-ийн timezone тохиргооноос
үл хамаарахын тулд UTC дээр +8 цаг нэмж тооцно.
"""
from __future__ import annotations

from datetime import datetime, date, timedelta

MN_OFFSET = timedelta(hours=8)


def mn_now() -> datetime:
    """Монголын одоогийн цаг (naive, UTC+8)."""
    return datetime.utcnow() + MN_OFFSET


def mn_today() -> date:
    """Монголын өнөөдрийн огноо."""
    return mn_now().date()
