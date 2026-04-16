"""
Эрхэт Автоматжуулалт — Гол ажиллуулах файл.

Ашиглах:
    python main.py              # Headless (browser харагдахгүй)
    python main.py --visible    # Headful (browser харагдана — debug хийхэд)
    python main.py --slow       # Удаан горим (алхам бүрийг харах)
"""

import sys
import asyncio
import argparse
from datetime import datetime

import config
from erkhet.browser import create_browser
from erkhet.auth import login
from erkhet.reports import download_report
from utils.logger import setup_logger
from utils.notify import notify_success, notify_error

log = setup_logger()


async def run():
    """Гол ажлын урсгал: login → тайлан татах → мэдэгдэл."""
    start_time = datetime.now()
    log.info("=" * 50)
    log.info(f"Эрхэт автоматжуулалт эхэллээ: {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
    log.info("=" * 50)

    # Тохиргоо шалгах
    try:
        config.validate()
    except ValueError as e:
        log.error(str(e))
        sys.exit(1)

    async with create_browser() as page:
        # 1. Нэвтрэх
        logged_in = await login(page)
        if not logged_in:
            notify_error(config.get_report_name(), "Нэвтрэхэд алдаа гарлаа")
            sys.exit(1)

        # 2. Тайлан татах
        file_path = await download_report(page)

        # 3. Үр дүн
        elapsed = (datetime.now() - start_time).total_seconds()

        if file_path:
            log.info(f"✅ Амжилттай! ({elapsed:.1f} сек)")
            notify_success(config.get_report_name(), file_path)
        else:
            log.error(f"❌ Тайлан татагдсангүй ({elapsed:.1f} сек)")
            notify_error(config.get_report_name(), "Тайлан татахад алдаа гарлаа")
            sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Эрхэт тайлан автоматаар татах")
    parser.add_argument(
        "--visible", action="store_true",
        help="Browser-ыг харуулах (debug горим)",
    )
    parser.add_argument(
        "--slow", action="store_true",
        help="Удаан горим — алхам бүрийн хооронд 500ms хүлээнэ",
    )
    args = parser.parse_args()

    if args.visible:
        config.HEADLESS = False
    if args.slow:
        config.SLOW_MO = 500

    asyncio.run(run())


if __name__ == "__main__":
    main()
