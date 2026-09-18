"""Өглөөний тайлан — системийн бүх анхаарах зүйлийг нэг дор.

Яагаад хэрэгтэй вэ: өмнө нь шалгалт бүр ГАР АРГААР байсан — хүн цэс рүү орж
харах ёстой. Тиймээс үлдэгдлийн файл 5.8 хоног, Ebarimt файл 17.8 хоног
хуучирсныг хэн ч анзаараагүй. Одоо систем өөрөө өглөө бүр хэлнэ.

Нэг эх сурвалж, хоёр дүрслэл: `collect_digest()` бүтэцтэй датаг гаргана,
түүнээс `build_digest()` Telegram-ын текстийг, Dashboard цэс нь картуудыг
үүсгэнэ. Ингэснээр хоёр газар тус тусад нь логик давхардахгүй.

Хэсэг бүр тусдаа try/except-тэй — нэг нь алдвал бусад нь хэвээр гарна.
"""
from __future__ import annotations

import threading
import traceback
from datetime import date, datetime, timedelta

from app.core.db import SessionLocal

EXPIRE_DAYS = 7        # хэдэн хоногийн дотор дуусахыг сануулах

# Төлөвийн тэмдэг — Telegram-ын текстэд ашиглана.
ICON = {"ok": "✅", "warn": "⚠️", "bad": "🔴", "none": "⚪"}


def _age_days(dt) -> float | None:
    if not dt:
        return None
    return round((datetime.utcnow() - dt).total_seconds() / 86400, 1)


def _sec(key: str, status: str, label: str, value: str = "", note: str = "",
         line: str = "", items: list[str] | None = None, link: str = "") -> dict:
    """Тайлангийн нэг хэсэг.

    line ХООСОН бол Telegram-д гарахгүй, зөвхөн Dashboard дээр харагдана —
    жишээ нь үлдэгдлийн файл шинэ үед мессежийг уртасгах хэрэггүй."""
    return {"key": key, "status": status, "label": label, "value": value,
            "note": note, "line": line, "items": items or [], "link": link}


def collect_digest() -> dict:
    """Тайлангийн бүх хэсгийг бүтэцтэй хэлбэрээр цуглуулна."""
    today = date.today()
    y = today - timedelta(days=1)
    secs: list[dict] = []
    db = SessionLocal()
    try:
        # ── 1. Шөнийн Эрхэт sync ──────────────────────────────────
        try:
            from app.services import erkhet_sync
            r = erkhet_sync.last_run
            if r.get("at") is None:
                secs.append(_sec("erkhet_sync", "none", "Эрхэт sync", "—",
                                 "хараахан ажиллаагүй",
                                 "⚪ Эрхэт sync: хараахан ажиллаагүй",
                                 link="/erkhet-auto"))
            elif r.get("ok"):
                rows = r.get("rows", 0)
                secs.append(_sec("erkhet_sync", "ok", "Эрхэт sync", f"{rows:,}",
                                 f"мөр · {r.get('day')}",
                                 f"✅ Эрхэт sync: {rows:,} мөр ({r.get('day')})",
                                 link="/erkhet-auto"))
            else:
                msg = str(r.get("message"))[:70]
                secs.append(_sec("erkhet_sync", "bad", "Эрхэт sync", "Амжилтгүй",
                                 msg, f"🔴 Эрхэт sync АМЖИЛТГҮЙ: {msg}",
                                 link="/erkhet-auto"))
        except Exception:
            pass

        # ── 2. POS татах ──────────────────────────────────────────
        try:
            from app.services import pos_auto_sync
            p = pos_auto_sync.last_run
            if p.get("at") is None:
                secs.append(_sec("pos_sync", "none", "POS sync", "—",
                                 "хараахан ажиллаагүй",
                                 "⚪ POS sync: хараахан ажиллаагүй",
                                 link="/pos-sync"))
            elif p.get("unsynced", 0) == 0 and p.get("ok"):
                t = p.get("total", 0)
                secs.append(_sec("pos_sync", "ok", "POS sync", f"{t:,}",
                                 "гүйлгээ бүгд татагдсан",
                                 f"✅ POS sync: {t:,} гүйлгээ бүгд татагдсан",
                                 link="/pos-sync"))
            elif p.get("ok"):
                secs.append(_sec("pos_sync", "ok", "POS sync",
                                 f"{p.get('synced_ok', 0):,}",
                                 f"татлаа · {p.get('amount', 0):,}₮",
                                 f"✅ POS sync: {p.get('synced_ok', 0)} гүйлгээ "
                                 f"татлаа · {p.get('amount', 0):,}₮",
                                 link="/pos-sync"))
            else:
                msg = str(p.get("message"))[:60]
                secs.append(_sec("pos_sync", "bad", "POS sync",
                                 f"{p.get('failed', 0)}", f"алдаатай · {msg}",
                                 f"🔴 POS sync: {p.get('failed', 0)} алдаатай · {msg}",
                                 link="/pos-sync"))
        except Exception:
            pass

        # ── 3. POS буцаалт / устгал ───────────────────────────────
        # Захиалга erxes рүү амжилттай очсон ч хэрэглэгч буцаавал
        # posOrders-оос алга болно. Тиймээс "бүгд sync хийгдсэн" гэсэн
        # мэдээлэл зөв байхад борлуулалт хасагдсан байж болно — хэн
        # буцаасныг нэрээр нь харуулна.
        try:
            from app.services.erxes_client import get_client
            rets = get_client().pos_returns(y.isoformat())
            if not rets:
                secs.append(_sec("returns", "ok", f"Буцаалт ({y})", "0",
                                 "буцаалт хийгдээгүй",
                                 f"✅ Буцаалт ({y}): алга", link="/pos-sync"))
            else:
                amt = sum(r.get("amount") or 0 for r in rets)
                by: dict[str, int] = {}
                for r in rets:
                    by[r["returned_by"]] = by.get(r["returned_by"], 0) + 1
                who = ", ".join(f"{k} ({v})" for k, v in
                                sorted(by.items(), key=lambda x: -x[1]))
                items = [f"№{r.get('number')} · {round(r.get('amount') or 0):,}₮ "
                         f"— {r['returned_by']}" for r in rets[:5]]
                if len(rets) > 5:
                    items.append(f"… нийт {len(rets)} буцаалт")
                secs.append(_sec("returns", "warn", f"Буцаалт ({y})",
                                 f"{len(rets)}", f"{round(amt):,}₮ · {who}",
                                 f"⚠️ Буцаалт ({y}): {len(rets)} ш · "
                                 f"{round(amt):,}₮ · {who}",
                                 items=items, link="/pos-sync"))
        except Exception:
            pass

        # ── 4. Локал POS ↔ erxes тулгалт ──────────────────────────
        # Касс эхлээд ЛОКАЛ POS-д бичдэг, тэндээс erxes рүү sync хийгддэг.
        # Энэ шатанд гацсан захиалгыг erxes талаас олж харах боломжгүй тул
        # локал POS бүрээс шууд тоо аваад тулгана. Зөрүүгээс буцаалтыг
        # хасаад ҮЛДСЭН тоо л жинхэнэ алдагдал.
        try:
            from app.services import pos_reconcile
            # Шөнийн ажил аль хэдийн тооцоод хадгалсан байх ёстой — эндээс
            # шууд уншина. Ажиллаагүй байвал л өөрөө тооцоод хадгална.
            rows = pos_reconcile.load_rows(db, y.isoformat())
            if not rows:
                rows = pos_reconcile.run_and_save(y.isoformat())["rows"]
            if rows:
                items = []
                for r in rows:
                    if r["error"]:
                        items.append(f"{r['pos_name']}: ⚠ {r['error'][:60]}")
                        continue
                    txt = (f"{r['pos_name']}: касс {r['local_count']:,} = "
                           f"erxes {r['erxes_count']:,} + буцаалт {r['returns_count']}")
                    if r["unexplained"]:
                        txt += f" · ДУТУУ {r['unexplained']}"
                    if r["unsynced_count"]:
                        txt += f" · Эрхэтэд ороогүй {r['unsynced_count']}"
                    items.append(txt)
                n = len(rows)
                unexp = sum(r["unexplained"] for r in rows)
                unsyn = sum(r["unsynced_count"] for r in rows)
                errs = sum(1 for r in rows if r["error"])
                if unexp or errs:
                    val = f"{unexp}" if unexp else f"{errs}"
                    note = ("тайлбаргүй зөрүү" if unexp else "POS шалгаж чадсангүй")
                    secs.append(_sec(
                        "pos_recon", "bad", f"POS тулгалт ({y})", val,
                        f"{note} · {n} POS",
                        f"🔴 POS тулгалт ({y}): {note} — {val}",
                        items=items, link="/pos-recon"))
                elif unsyn:
                    secs.append(_sec(
                        "pos_recon", "warn", f"POS тулгалт ({y})", f"{unsyn}",
                        f"Эрхэт рүү ороогүй · {n} POS",
                        f"⚠️ POS тулгалт ({y}): {unsyn} гүйлгээ Эрхэт рүү ороогүй",
                        items=items, link="/pos-recon"))
                else:
                    secs.append(_sec(
                        "pos_recon", "ok", f"POS тулгалт ({y})", f"{n}",
                        "POS · бүрэн таарсан",
                        f"✅ POS тулгалт ({y}): {n} POS бүрэн таарсан",
                        items=items, link="/pos-recon"))
        except Exception:
            pass

        # ── 5. Хугацаа дуусах бараа ───────────────────────────────
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
                note = ", ".join(part)
                secs.append(_sec("expiration", "warn", "Хугацаа",
                                 f"{len(soon) + len(over)}", note,
                                 "⚠️ Хугацаа: " + note, link="/expiration"))
            else:
                secs.append(_sec("expiration", "ok", "Хугацаа", "0",
                                 "анхаарах бараа алга",
                                 "✅ Хугацаа: анхаарах бараа алга",
                                 link="/expiration"))
        except Exception:
            pass

        # ── 6. Ebarimt дутуу шивэлт ───────────────────────────────
        try:
            from app.api.ebarimt_report import get_report
            from app.models.ebarimt_file import EbarimtFile
            # Энэ сарын файл байхгүй байх нь энгийн (сар дуусаад оруулдаг) тул
            # ХАМГИЙН СҮҮЛИЙН дататай сарыг шалгана.
            latest = db.query(EbarimtFile).order_by(
                EbarimtFile.year.desc(), EbarimtFile.month.desc()).first()
            if not latest:
                secs.append(_sec("ebarimt", "none", "Ebarimt", "—",
                                 "файл оруулаагүй", "⚪ Ebarimt: файл оруулаагүй",
                                 link="/ebarimt"))
            else:
                rep = get_report(db, latest.year, latest.month)
                tag = f"{latest.year}-{latest.month:02d}"
                if rep.get("error"):
                    msg = str(rep["error"])[:55]
                    secs.append(_sec("ebarimt", "none", f"Ebarimt ({tag})", "—",
                                     msg, f"⚪ Ebarimt ({tag}): {msg}",
                                     link="/ebarimt"))
                else:
                    miss = [r for r in rep.get("rows", [])
                            if r["diff_orgil"] > 0.5 or r["diff_harhorin"] > 0.5]
                    amt = sum(max(r["diff_orgil"], 0) + max(r["diff_harhorin"], 0)
                              for r in miss)
                    stale = ((today.year * 12 + today.month)
                             - (latest.year * 12 + latest.month))
                    old_note = f" · ⏳ {stale} сар хоцорсон" if stale >= 2 else ""
                    if miss:
                        secs.append(_sec(
                            "ebarimt", "warn", f"Ebarimt ({tag})", f"{len(miss)}",
                            f"харилцагч дутуу · {round(amt):,}₮{old_note}",
                            f"⚠️ Ebarimt ({tag}): {len(miss)} харилцагч дутуу · "
                            f"{round(amt):,}₮{old_note}", link="/ebarimt"))
                    else:
                        secs.append(_sec("ebarimt", "ok", f"Ebarimt ({tag})", "0",
                                         f"дутуу алга{old_note}",
                                         f"✅ Ebarimt ({tag}): дутуу алга{old_note}",
                                         link="/ebarimt"))
        except Exception:
            pass

        # ── 7. Банкны хуулга ──────────────────────────────────────
        try:
            from sqlalchemy import func
            from app.models.bank_statement import BankStatement
            day_expr = func.coalesce(BankStatement.date_from,
                                     func.date(BankStatement.uploaded_at))
            n = db.query(BankStatement).filter(day_expr == y.isoformat()).count()
            if n:
                secs.append(_sec("bank", "ok", f"Банкны хуулга ({y})", f"{n}",
                                 "хуулга оруулсан",
                                 f"✅ Банкны хуулга ({y}): {n} хуулга оруулсан",
                                 link="/bank-statements"))
            else:
                secs.append(_sec("bank", "bad", f"Банкны хуулга ({y})", "0",
                                 "ОРУУЛААГҮЙ",
                                 f"🔴 Банкны хуулга ({y}): ОРУУЛААГҮЙ",
                                 link="/bank-statements"))
        except Exception:
            pass

        # ── 8. Датаны шинэлэг байдал ──────────────────────────────
        # Файл шинэ үед Telegram-д мөр нэмэхгүй (line хоосон) — гэхдээ
        # Dashboard дээр ногоон картаар харагдана.
        try:
            from app.models.balance_file import BalanceFile
            b = db.query(BalanceFile).filter(BalanceFile.kind == "warehouse").first()
            age = _age_days(b.uploaded_at) if b else None
            if age is None:
                secs.append(_sec("balance_file", "bad", "Үлдэгдлийн файл", "—",
                                 "огт байхгүй", "🔴 Үлдэгдлийн файл: огт байхгүй",
                                 link="/imports/balance-file"))
            elif age > 2:
                secs.append(_sec("balance_file", "warn", "Үлдэгдлийн файл",
                                 f"{age}", "хоногийн өмнөх",
                                 f"⚠️ Үлдэгдлийн файл {age} хоногийн өмнөх",
                                 link="/imports/balance-file"))
            else:
                secs.append(_sec("balance_file", "ok", "Үлдэгдлийн файл",
                                 f"{age}", "хоногийн өмнөх — шинэ",
                                 link="/imports/balance-file"))
        except Exception:
            pass
    finally:
        db.close()

    counts = {k: sum(1 for s in secs if s["status"] == k)
              for k in ("ok", "warn", "bad", "none")}
    return {
        "date": today.isoformat(),
        "day": y.isoformat(),
        "generated_at": datetime.utcnow().isoformat(timespec="seconds"),
        "counts": counts,
        "sections": secs,
    }


def build_digest() -> str:
    """Telegram-д илгээх текст — collect_digest()-ийн мөрүүдээс угсарна."""
    d = collect_digest()
    lines = [f"📊 {d['date']} — өглөөний тайлан", ""]
    for s in d["sections"]:
        if not s.get("line"):
            continue        # зөвхөн Dashboard-д зориулсан хэсэг
        lines.append(s["line"])
        for it in s.get("items", []):
            lines.append(f"      └ {it}")
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


# ── Dashboard-д зориулсан кэш ────────────────────────────────────────
# collect_digest() нь erxes рүү хандаж буцаалт татдаг тул 5-20 секунд
# болно. Dashboard ачаалах болгонд тэгж хүлээх нь утгагүй — TTL кэштэй.
_CACHE_TTL = 300
_cache: dict = {"at": None, "data": None}
_cache_lock = threading.Lock()
# Нэг л thread цуглуулна (single-flight). Өмнө нь кэш хуучирмагц Dashboard нээсэн
# хэрэглэгч БҮР collect_digest()-ийг зэрэг ажиллуулж (тус бүр 2 DB холболт +
# erxes дуудлага) 100 холболтын pool дүүрч сервер бүхэлдээ зогсдог байсан.
_build_lock = threading.Lock()
_BUILD_WAIT_SEC = 20     # бэлэн өгөгдөлгүй үед барилт дуусахыг хүлээх дээд хугацаа


def _cached() -> tuple:
    with _cache_lock:
        at, data = _cache["at"], _cache["data"]
    fresh = (at is not None and data is not None
             and (datetime.utcnow() - at).total_seconds() < _CACHE_TTL)
    return fresh, data


def cached_digest(refresh: bool = False) -> dict:
    """Кэшлэсэн тайлан. refresh=True бол шинээр цуглуулна.

    • Шинэхэн кэш → шууд.
    • Хуучирсан ч өгөгдөл байгаа, өөр thread аль хэдийн цуглуулж байгаа → хуучин
      өгөгдлийг (stale=True) шууд буцаана — DB холболт барьж хүлээхгүй.
    • Огт өгөгдөлгүй → цуглуулалтыг дээд тал нь _BUILD_WAIT_SEC хүлээнэ, эс бол
      pending=True буцаана (frontend дараа дахин асууна)."""
    fresh, data = _cached()
    if fresh and not refresh:
        return {**data, "cached": True}
    if not _build_lock.acquire(blocking=False):
        # Өөр thread цуглуулж байна
        if data is not None and not refresh:
            return {**data, "cached": True, "stale": True}
        if not _build_lock.acquire(timeout=_BUILD_WAIT_SEC):
            fresh, data = _cached()
            if data is not None:
                return {**data, "cached": True, "stale": True}
            return {"date": datetime.utcnow().date().isoformat(), "day": "",
                    "generated_at": datetime.utcnow().isoformat(timespec="seconds"),
                    "sections": [], "counts": {"ok": 0, "warn": 0, "bad": 0, "none": 0},
                    "cached": False, "pending": True}
    try:
        # Lock авах хооронд өөр thread цуглуулж дууссан байж болно
        fresh, data = _cached()
        if fresh and not refresh:
            return {**data, "cached": True}
        d = collect_digest()
        with _cache_lock:
            _cache["at"] = datetime.utcnow()
            _cache["data"] = d
        return {**d, "cached": False}
    finally:
        _build_lock.release()
