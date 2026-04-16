"""Мэдэгдэл илгээх модуль — Telegram bot."""

import requests
from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
from utils.logger import setup_logger

log = setup_logger()


def send_telegram(message: str) -> bool:
    """Telegram-аар мэдэгдэл илгээнэ. Token/Chat ID байхгүй бол алгасна."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        log.debug("Telegram тохиргоо хийгдээгүй — мэдэгдэл илгээхгүй")
        return False

    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        resp = requests.post(
            url,
            json={"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "HTML"},
            timeout=10,
        )
        if resp.status_code == 200:
            log.info("Telegram мэдэгдэл илгээгдлээ")
            return True
        else:
            log.warning(f"Telegram алдаа: {resp.status_code} — {resp.text}")
            return False
    except Exception as e:
        log.warning(f"Telegram илгээхэд алдаа: {e}")
        return False


def notify_success(report_name: str, file_path: str):
    """Амжилттай татсан тухай мэдэгдэл."""
    msg = (
        f"✅ <b>Тайлан амжилттай татагдлаа</b>\n"
        f"📄 {report_name}\n"
        f"📁 {file_path}"
    )
    send_telegram(msg)


def notify_error(report_name: str, error: str):
    """Алдаа гарсан тухай мэдэгдэл."""
    msg = (
        f"❌ <b>Тайлан татахад алдаа гарлаа</b>\n"
        f"📄 {report_name}\n"
        f"⚠️ {error}"
    )
    send_telegram(msg)
