"""
Messenger-ээр тайлан илгээх — group тус бүрт 2 PDF + 1 мессеж.

Downloads хавтсаас хамгийн сүүлийн PDF файлуудыг олж,
group-ээр бүлэглэн Messenger руу илгээнэ.

Ашиглах:
    python send_reports.py              # Headless
    python send_reports.py --visible    # Browser харагдана
"""

import sys
import asyncio
import argparse
from collections import defaultdict

import config
from utils.messenger import send_to_messenger
from utils.logger import setup_logger

log = setup_logger()

# Тайлан → файлын нэрний pattern
FILE_PATTERNS = {
    "milko_movement":      "Милко_хөдөлгөөний",
    "milko_sale":          "Милко_борлуулалтын",
    "altanjoluu_movement": "Алтанжолоо_хөдөлгөөний",
    "altanjoluu_sale":     "Алтанжолоо_борлуулалтын",
}


def find_latest_pdf(pattern: str) -> str | None:
    """Downloads хавтсаас pattern-д тохирох хамгийн сүүлийн PDF олно."""
    pdf_files = [f for f in config.DOWNLOAD_DIR.glob("*.pdf") if pattern in f.name]
    if not pdf_files:
        return None
    latest = max(pdf_files, key=lambda f: f.stat().st_mtime)
    return str(latest)


async def run():
    """Group тус бүрт файлуудыг бүлэглэж илгээнэ."""
    log.info("=" * 50)
    log.info("Messenger тайлан илгээлт эхэллээ")
    log.info("=" * 50)

    # Group-ээр бүлэглэх: {group_id: [file_path1, file_path2]}
    groups: dict[str, list[str]] = defaultdict(list)

    for report_type, pattern in FILE_PATTERNS.items():
        group_id = config.MESSENGER_GROUPS.get(report_type, "")
        if not group_id:
            log.warning(f"Group ID тохируулаагүй: {report_type}")
            continue

        file_path = find_latest_pdf(pattern)
        if not file_path:
            log.warning(f"PDF олдсонгүй: {pattern}")
            continue

        groups[group_id].append(file_path)
        log.info(f"  {report_type} → {file_path}")

    if not groups:
        log.error("Илгээх файл олдсонгүй!")
        sys.exit(1)

    # Group тус бүрт илгээх
    success = 0
    for group_id, file_paths in groups.items():
        group_name = "Милко" if group_id == config.MESSENGER_GROUP_MILKO else "Алтанжолоо"
        log.info(f"\n{'='*50}")
        log.info(f"{group_name} group руу {len(file_paths)} файл илгээж байна...")
        log.info(f"{'='*50}")

        result = await send_to_messenger(
            file_paths=file_paths,
            group_id=group_id,
        )

        if result:
            log.info(f"✅ {group_name} — амжилттай!")
            success += 1
        else:
            log.error(f"❌ {group_name} — амжилтгүй!")

    log.info(f"\nҮр дүн: {success}/{len(groups)} group амжилттай")


def main():
    parser = argparse.ArgumentParser(description="Messenger-ээр тайлан илгээх")
    parser.add_argument("--visible", action="store_true", help="Browser харуулах")
    args = parser.parse_args()

    if args.visible:
        config.HEADLESS = False

    if not config.MESSENGER_ENABLED:
        log.error("MESSENGER_ENABLED=true .env файлд тохируулна уу")
        sys.exit(1)

    asyncio.run(run())


if __name__ == "__main__":
    main()
