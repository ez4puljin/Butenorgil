"""Өглөөний тайлан — Dashboard-д зориулсан бүтэцтэй хэлбэр.

Telegram-аар өглөө бүр явдаг тайлантай ЯГ ИЖИЛ эх сурвалжийг ашиглана
(app.services.daily_digest.collect_digest) — ингэснээр хоёр газар логик
давхардахгүй, нэгийг нь өөрчилвөл нөгөө нь автоматаар дагана.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.deps import require_role
from app.services import daily_digest

router = APIRouter(prefix="/digest", tags=["digest"])


@router.get("")
def digest(
    refresh: bool = Query(False, description="Кэш алгасаж шинээр цуглуулах"),
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    """Тайлангийн бүх хэсэг.

    Кэштэй (5 мин) — учир нь буцаалтын хэсэг erxes рүү хандаж 5-20 секунд
    болдог, Dashboard ачаалах болгонд тэгж хүлээх нь утгагүй."""
    return daily_digest.cached_digest(refresh=refresh)
