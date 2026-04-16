"""Messenger илгээлтийг тест — group тус бүрт 2 PDF + 1 мессеж."""

import asyncio
import sys
import argparse

import config
from send_reports import run
from utils.logger import setup_logger

log = setup_logger()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--visible", action="store_true")
    args = parser.parse_args()

    config.HEADLESS = not args.visible
    config.SLOW_MO = 300 if args.visible else 0

    asyncio.run(run())
