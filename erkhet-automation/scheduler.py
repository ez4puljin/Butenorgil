"""
Өдөр бүр тайлан автоматаар татах scheduler.

Ашиглах:
    python scheduler.py          # Scheduler эхлүүлэх (foreground)
    python scheduler.py install  # Windows Task Scheduler-д бүртгэх
"""

import sys
import subprocess
from pathlib import Path

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

import config
from utils.logger import setup_logger

log = setup_logger()

BASE_DIR = Path(__file__).parent


def run_main():
    """main.py-г subprocess-оор ажиллуулна."""
    log.info("Scheduler: main.py ажиллуулж байна...")
    result = subprocess.run(
        [sys.executable, str(BASE_DIR / "main.py")],
        cwd=str(BASE_DIR),
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        log.info("Scheduler: main.py амжилттай дууслаа")
    else:
        log.error(f"Scheduler: main.py алдаатай дууслаа (code={result.returncode})")
        if result.stderr:
            log.error(f"Stderr: {result.stderr[:500]}")


def start_scheduler():
    """APScheduler эхлүүлэх — foreground-д ажиллана."""
    scheduler = BlockingScheduler()

    scheduler.add_job(
        run_main,
        trigger=CronTrigger(
            hour=config.SCHEDULE_HOUR,
            minute=config.SCHEDULE_MINUTE,
        ),
        id="erkhet_daily_report",
        name=f"Эрхэт тайлан ({config.SCHEDULE_HOUR:02d}:{config.SCHEDULE_MINUTE:02d})",
        replace_existing=True,
    )

    log.info(
        f"Scheduler эхэллээ — өдөр бүр "
        f"{config.SCHEDULE_HOUR:02d}:{config.SCHEDULE_MINUTE:02d}-д ажиллана"
    )
    log.info("Зогсоох бол: Ctrl+C")

    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        log.info("Scheduler зогслоо")


def install_windows_task():
    """Windows Task Scheduler-д бүртгэнэ."""
    python_path = sys.executable
    script_path = BASE_DIR / "main.py"
    task_name = "ErkhetDailyReport"

    cmd = (
        f'schtasks /create /tn "{task_name}" '
        f'/tr "\\"{python_path}\\" \\"{script_path}\\"" '
        f"/sc daily /st {config.SCHEDULE_HOUR:02d}:{config.SCHEDULE_MINUTE:02d} "
        f"/f"
    )

    print(f"Дараах командыг Administrator CMD дээр ажиллуулна уу:\n")
    print(f"  {cmd}\n")
    print(f"Устгах бол: schtasks /delete /tn \"{task_name}\" /f")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "install":
        install_windows_task()
    else:
        start_scheduler()
