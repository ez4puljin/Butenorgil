"""Facebook Messenger-ээр файл илгээх модуль — undetected-chromedriver.

Group тус бүрт олон файл хамт upload хийж, 1 мессеж илгээнэ.
Мессежийн текстийг .env файлын MESSENGER_MESSAGE-ээр тохируулна.
"""

import json
import time
from pathlib import Path
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import undetected_chromedriver as uc
import config
from utils.logger import setup_logger

log = setup_logger()

UC_PROFILE_DIR = str(config.COOKIES_DIR / "uc_messenger")


def _create_driver(headless: bool = False):
    """undetected Chrome driver үүсгэнэ."""
    options = uc.ChromeOptions()
    options.add_argument(f"--user-data-dir={UC_PROFILE_DIR}")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    if headless:
        options.add_argument("--headless=new")
    driver = uc.Chrome(options=options, use_subprocess=True)
    driver.set_window_size(1366, 768)
    return driver


def _has_login_form(driver) -> bool:
    try:
        driver.find_element(By.CSS_SELECTOR, 'input[type="password"]')
        return True
    except Exception:
        return False


def _has_chat_ui(driver) -> bool:
    try:
        driver.find_element(By.CSS_SELECTOR, '[role="textbox"]')
        return True
    except Exception:
        try:
            driver.find_element(By.CSS_SELECTOR, 'div[contenteditable="true"]')
            return True
        except Exception:
            return False


def _wait_for_login(driver, group_url: str) -> bool:
    """Хэрэглэгч гараар нэвтрэх хүлээнэ (10 мин)."""
    if config.HEADLESS:
        log.error(
            "Facebook нэвтрэлт шаардлагатай!\n"
            "  python test_messenger.py ажиллуулж гараар нэвтэрнэ үү."
        )
        return False

    log.info("=" * 50)
    log.info("Facebook нэвтрэлт шаардлагатай!")
    log.info("Chrome browser дээр гараар нэвтэрнэ үү.")
    log.info("Нэвтэрсний дараа автоматаар үргэлжлэнэ...")
    log.info("=" * 50)

    for _ in range(120):
        time.sleep(5)
        try:
            url = driver.current_url
            if "/t/" in url and "login" not in url:
                return True
            if _has_chat_ui(driver):
                return True
        except Exception:
            pass

    log.error("Нэвтрэлт хугацаа хэтэрлээ (10 мин)")
    return False


def _navigate_to_group(driver, group_id: str) -> bool:
    """Group chat руу очиж, chat UI ачаалагдтал хүлээнэ."""
    group_url = f"https://www.messenger.com/t/{group_id}"
    log.info(f"Messenger group руу очиж байна: {group_url}")
    driver.get(group_url)
    time.sleep(5)

    # Login шалгах
    if _has_login_form(driver):
        if not _wait_for_login(driver, group_url):
            return False
        log.info("Нэвтрэлт амжилттай!")
        if group_id not in driver.current_url:
            driver.get(group_url)
            time.sleep(5)

    # Chat UI хүлээх
    for _ in range(10):
        if _has_chat_ui(driver):
            return True
        time.sleep(3)

    log.error("Chat UI ачаалагдсангүй")
    driver.save_screenshot(str(config.SCREENSHOT_DIR / "messenger_no_chat.png"))
    return False


def _find_file_input(driver):
    """File input element олох."""
    try:
        return driver.find_element(By.CSS_SELECTOR, 'input[type="file"]')
    except Exception:
        for sel in ['[aria-label="Attach file"]', '[aria-label="Add Files"]',
                    '[aria-label="Attach"]', '[aria-label="Open more actions"]']:
            try:
                btn = driver.find_element(By.CSS_SELECTOR, sel)
                btn.click()
                time.sleep(1.5)
                return driver.find_element(By.CSS_SELECTOR, 'input[type="file"]')
            except Exception:
                continue
    return None


async def send_to_messenger(
    file_paths: list[str],
    group_id: str,
    message: str = "",
) -> bool:
    """
    Facebook Messenger group руу олон файл + 1 мессеж илгээнэ.

    Args:
        file_paths: Илгээх файлуудын замууд
        group_id: Messenger group/thread ID
        message: Илгээх текст мессеж (хоосон бол config.MESSENGER_MESSAGE)

    Returns:
        True амжилттай, False алдаатай
    """
    if not group_id:
        log.warning("Messenger group ID тохируулаагүй — илгээхгүй")
        return False

    # Файлууд шалгах
    files = []
    for fp in file_paths:
        f = Path(fp)
        if f.exists():
            files.append(f)
        else:
            log.warning(f"Файл олдсонгүй, алгасав: {fp}")

    if not files:
        log.error("Илгээх файл олдсонгүй")
        return False

    msg = message or config.MESSENGER_MESSAGE

    driver = None
    try:
        driver = _create_driver(headless=config.HEADLESS)

        if not _navigate_to_group(driver, group_id):
            driver.quit()
            return False

        log.info(f"Messenger chat ачаалагдлаа — {len(files)} файл илгээнэ")

        # === Файлууд нэг нэгээр upload + send ===
        for i, file in enumerate(files):
            file_input = _find_file_input(driver)
            if not file_input:
                labels = driver.execute_script("""
                    return Array.from(document.querySelectorAll('[aria-label]'))
                        .map(el => ({tag: el.tagName, label: el.getAttribute('aria-label')}))
                        .filter(x => x.label)
                """)
                log.error(f"File input олдсонгүй. aria-label: {json.dumps(labels, ensure_ascii=False)}")
                driver.save_screenshot(str(config.SCREENSHOT_DIR / "messenger_no_file_input.png"))
                driver.quit()
                return False

            file_input.send_keys(str(file.resolve()))
            log.info(f"Файл upload [{i+1}/{len(files)}]: {file.name}")
            time.sleep(3)

            # Send товч дарах
            sent = False
            for sel in ['[aria-label="Send"]', '[aria-label="Press enter to send"]']:
                try:
                    btn = driver.find_element(By.CSS_SELECTOR, sel)
                    btn.click()
                    sent = True
                    break
                except Exception:
                    continue
            if not sent:
                try:
                    textbox = driver.find_element(By.CSS_SELECTOR, '[role="textbox"]')
                    textbox.send_keys(Keys.RETURN)
                except Exception:
                    pass

            time.sleep(3)
            log.info(f"Файл илгээгдлээ: {file.name}")

        # === Текст мессеж илгээх (1 удаа) ===
        if msg:
            time.sleep(3)
            try:
                textbox = WebDriverWait(driver, 15).until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, '[role="textbox"]'))
                )
                textbox.click()
                time.sleep(0.5)
                textbox.send_keys(msg)
                time.sleep(0.5)
                textbox.send_keys(Keys.RETURN)
                time.sleep(2)
                log.info("Текст мессеж илгээгдлээ")
            except Exception as e:
                log.warning(f"Текст мессеж илгээх алдаа: {e}")

        file_names = ", ".join(f.name for f in files)
        log.info(f"Messenger илгээлт амжилттай: [{file_names}] → group {group_id}")
        driver.quit()
        return True

    except Exception as e:
        log.error(f"Messenger илгээх алдаа: {e}")
        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        return False
