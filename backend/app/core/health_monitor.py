"""
Систем асалт мониторинг — Healthchecks.io heartbeat + Telegram мэдэгдэл.

Гол санаа: backend тодорхой давтамжтайгаар гадагш "би амьд байна" heartbeat
илгээнэ. Healthchecks.io энэ ping-ийг хүлээж авахаа болиход (PC унтарсан /
интернет тасарсан / процесс унасан) grace хугацааны дараа Telegram-аар DOWN
мэдэгдэнэ. Heartbeat сэргэхэд UP. Систем өөрөө унтарсныг мэдэгдэж чадахгүй тул
энэ гадаад "харуул" (dead-man's-switch) заавал хэрэгтэй.

Тохиргоо ([backend/.env]) хоосон (HEARTBEAT_URL == "") бол бүх функц no-op —
мониторинг идэвхгүй, юу ч илгээхгүй.
"""
import asyncio
import urllib.request
import urllib.parse
from datetime import datetime

from sqlalchemy import text

from app.core.config import settings
from app.core.db import engine

_TIMEOUT = 10                 # секунд — гадагш хандалтын timeout
_started_notified = False     # процесс тутам нэг л удаа "аслаа" илгээнэ


def _http_get(url: str) -> bool:
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def ping_healthcheck(ok: bool = True) -> bool:
    """Healthchecks.io руу ping илгээх.
    ok=False бол '/fail' endpoint рүү (Healthchecks шууд DOWN болгоно)."""
    base = (settings.heartbeat_url or "").strip()
    if not base:
        return False
    url = base if ok else base.rstrip("/") + "/fail"
    return _http_get(url)


def send_telegram(text_msg: str) -> bool:
    """Telegram bot-оор мессеж илгээх. Best-effort — алдааг залгина.
    Token/chat_id хоосон бол юу ч хийхгүй."""
    token = (settings.telegram_bot_token or "").strip()
    chat = (settings.telegram_chat_id or "").strip()
    if not token or not chat:
        return False
    try:
        api = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = urllib.parse.urlencode({
            "chat_id": chat,
            "text": text_msg,
            "disable_web_page_preview": "true",
        }).encode("utf-8")
        req = urllib.request.Request(api, data=payload, method="POST")
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def _db_ok() -> bool:
    """DB хүрч байгаа эсэх — хурдан SELECT 1."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


def _heartbeat_tick() -> bool:
    """Нэг heartbeat: DB шалгаад Healthchecks руу ping. DB OK эсэхийг буцаана.
    DB унасан бол '/fail' ping илгээж Healthchecks-ыг DOWN болгоно."""
    ok = _db_ok()
    ping_healthcheck(ok=ok)
    return ok


async def _heartbeat_loop():
    """Background loop — interval тутам heartbeat илгээнэ.
    HEARTBEAT_URL хоосон бол loop-д ороод юу ч хийхгүй буцна (идэвхгүй)."""
    global _started_notified
    # Бүрэн асалтыг хүлээнэ (dashboard warm loop-тэй адил)
    await asyncio.sleep(10)

    if not (settings.heartbeat_url or "").strip():
        print("[heartbeat] HEARTBEAT_URL хоосон — мониторинг идэвхгүй")
        return

    interval = max(15, int(settings.heartbeat_interval_sec or 60))
    print(f"[heartbeat] мониторинг идэвхтэй — {interval}с тутам ping")

    while True:
        try:
            ok = await asyncio.to_thread(_heartbeat_tick)
            # Процесс шинээр асаад DB OK болмогц нэг л удаа "аслаа" илгээнэ
            # (PC өөрөө сэргэхэд шуурхай UP мэдэгдэл өгнө)
            if ok and not _started_notified:
                _started_notified = True
                stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
                await asyncio.to_thread(
                    send_telegram, f"✅ Бүтэн-Оргил ERP аслаа ({stamp})"
                )
            print(f"[heartbeat] {'ok' if ok else 'DB FAIL — /fail ping'}")
        except Exception as e:
            print(f"[heartbeat] алдаа: {e}")
        await asyncio.sleep(interval)
