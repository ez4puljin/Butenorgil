"""Өглөөний тайлан — системийн бүх анхаарах зүйлийг нэг Telegram мессежээр.

Яагаад хэрэгтэй вэ: өмнө нь шалгалт бүр ГАР АРГААР байсан — хүн цэс рүү орж
харах ёстой. Тиймээс үлдэгдлийн файл 5.8 хоног, Ebarimt файл 17.8 хоног
хуучирсныг хэн ч анзаараагүй. Одоо систем өөрөө өглөө бүр хэлнэ.

Хэсэг бүр тусдаа try/except-тэй — нэг нь алдвал бусад нь хэвээр гарна.
"""
from __future__ import annotations

import traceback
from datetime import date, datetime, timedelta

from app.core.db import SessionLocal

EXPIRE_DAYS = 7        # хэдэн хоногийн дотор дуусахыг сануулах


def _age_days(dt) -> float | None:
    if not dt:
        return None
    return round((datetime.utcnow() - dt).total_seconds() / 86400, 1)


def build_digest() -> str:
    """Тайлангийн текстийг бүрдүүлнэ (Telegram-д илгээхэд бэлэн)."""
    today = date.today()
    y = today - timedelta(days=1)
    lines = [f"📊 {today.isoformat()} — өглөөний тайлан", ""]
    db = SessionLocal()
    try:
        # ── 1. Шөнийн Эрхэт sync ──────────────────────────────────
        try:
            from app.services import erkhet_sync
            r = erkhet_sync.last_run
            if r.get("at") is None:
                lines.append("⚪ Эрхэт sync: хараахан ажиллаагүй")
            elif r.get("ok"):
                lines.append(f"✅ Эрхэт sync: {r.get('rows', 0):,} мөр ({r.get('day')})")
            else:
                lines.append(f"🔴 Эрхэт sync АМЖИЛТГҮЙ: {str(r.get('message'))[:70]}")
        except Exception:
            pass

        # ── 2. POS татах ──────────────────────────────────────────
        try:
            from app.services import pos_auto_sync
            p = pos_auto_sync.last_run
            if p.get("at") is None:
                lines.append("⚪ POS sync: хараахан ажиллаагүй")
            elif p.get("unsynced", 0) == 0 and p.get("ok"):
                lines.append(f"✅ POS sync: {p.get('total', 0):,} гүйлгээ бүгд татагдсан")
            elif p.get("ok"):
                lines.append(f"✅ POS sync: {p.get('synced_ok', 0)} гүйлгээ татлаа · {p.get('amount', 0):,}₮")
            else:
                lines.append(f"🔴 POS sync: {p.get('failed', 0)} алдаатай · {str(p.get('message'))[:60]}")
        except Exception:
            pass

        # ── 3. Хугацаа дуусах бараа ───────────────────────────────
        try:
            from app.models.expiration_item import ExpirationItem
            limit = today + timedelta(days=EXPIRE_DAYS)
            rows = db.query(ExpirationItem).filter(
                ExpirationItem.expiration_date <= limit,
                ExpirationItem.status != "archived",
            ).all()
            soon = [r for r in rows if r.expiration_date >= today]
            over = [r for r in rows if r.expiration_date < today]
            if soon or over:
                part = []
                if soon:
                    part.append(f"{len(soon)} бараа {EXPIRE_DAYS} хоногт дуусна")
                if over:
                    part.append(f"{len(over)} нь хугацаа хэтэрсэн")
                lines.append("⚠️ Хугацаа: " + ", ".join(part))
            else:
                lines.append("✅ Хугацаа: анхаарах бараа алга")
        except Exception:
            pass

        # ── 4. Ebarimt дутуу шивэлт ───────────────────────────────
        try:
            from app.api.ebarimt_report import get_report
            from app.models.ebarimt_file import EbarimtFile
            # Энэ сарын файл байхгүй байх нь энгийн (сар дуусаад оруулдаг) тул
            # ХАМГИЙН СҮҮЛИЙН дататай сарыг шалгана.
            latest = db.query(EbarimtFile).order_by(
                EbarimtFile.year.desc(), EbarimtFile.month.desc()).first()
            if not latest:
                lines.append("⚪ Ebarimt: файл оруулаагүй")
            else:
                rep = get_report(db, latest.year, latest.month)
                tag = f"{latest.year}-{latest.month:02d}"
                if rep.get("error"):
                    lines.append(f"⚪ Ebarimt ({tag}): {str(rep['error'])[:55]}")
                else:
                    miss = [r for r in rep.get("rows", [])
                            if r["diff_orgil"] > 0.5 or r["diff_harhorin"] > 0.5]
                    amt = sum(max(r["diff_orgil"], 0) + max(r["diff_harhorin"], 0) for r in miss)
                    stale = (today.year * 12 + today.month) - (latest.year * 12 + latest.month)
                    old_note = f" · ⏳ {stale} сар хоцорсон" if stale >= 2 else ""
                    if miss:
                        lines.append(f"⚠️ Ebarimt ({tag}): {len(miss)} харилцагч дутуу · {round(amt):,}₮{old_note}")
                    else:
                        lines.append(f"✅ Ebarimt ({tag}): дутуу алга{old_note}")
        except Exception:
            pass

        # ── 5. Банкны хуулга ──────────────────────────────────────
        try:
            from sqlalchemy import func
            from app.models.bank_statement import BankStatement
            day_expr = func.coalesce(BankStatement.date_from,
                                     func.date(BankStatement.uploaded_at))
            n = db.query(BankStatement).filter(day_expr == y.isoformat()).count()
            if n:
                lines.append(f"✅ Банкны хуулга ({y}): {n} хуулга оруулсан")
            else:
                lines.append(f"🔴 Банкны хуулга ({y}): ОРУУЛААГҮЙ")
        except Exception:
            pass

        # ── 6. Датаны шинэлэг байдал ──────────────────────────────
        try:
            from app.models.balance_file import BalanceFile
            b = db.query(BalanceFile).filter(BalanceFile.kind == "warehouse").first()
            age = _age_days(b.uploaded_at) if b else None
            if age is None:
                lines.append("🔴 Үлдэгдлийн файл: огт байхгүй")
            elif age > 2:
                lines.append(f"⚠️ Үлдэгдлийн файл {age} хоногийн өмнөх")
        except Exception:
            pass
    finally:
        db.close()

    return "\n".join(lines)


def send_daily_digest(notify: bool = True) -> str:
    """Тайланг бүрдүүлж Telegram-аар илгээнэ. Алдаа гарвал ч loop унтрахгүй."""
    try:
        text = build_digest()
    except Exception as e:
        text = f"❌ Өглөөний тайлан бүрдүүлэхэд алдаа: {str(e)[:120]}"
        traceback.print_exc()
    print("[digest]\n" + text)
    if notify:
        try:
            from app.core.health_monitor import send_telegram
            send_telegram(text)
        except Exception:
            pass
    return text
