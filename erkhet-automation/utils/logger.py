"""Лог бичих модуль — файл + консол дээр бичнэ."""

import logging
from datetime import datetime
from config import LOG_DIR


def setup_logger(name: str = "erkhet") -> logging.Logger:
    """Лог тохируулна. Файл + консол дээр бичнэ."""
    logger = logging.getLogger(name)

    if logger.handlers:
        return logger

    logger.setLevel(logging.DEBUG)

    # Файлд бичих (өдөр бүр шинэ файл)
    today = datetime.now().strftime("%Y-%m-%d")
    file_handler = logging.FileHandler(
        LOG_DIR / f"{today}.log", encoding="utf-8"
    )
    file_handler.setLevel(logging.DEBUG)

    # Консол дээр харуулах
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)

    # Формат
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    file_handler.setFormatter(fmt)
    console_handler.setFormatter(fmt)

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger
