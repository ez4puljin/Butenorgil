"""Эрхэт системд нэвтрэх (login) модуль."""

from playwright.async_api import Page
import config
from utils.logger import setup_logger
from erkhet.browser import take_screenshot

log = setup_logger()


async def login(page: Page) -> bool:
    """
    Эрхэт системд нэвтрэнэ.
    CSRF token автоматаар дамжуулагдана (form дотор hidden input).
    """
    login_url = config.ERKHET_URL.rstrip("/") + "/login/"
    log.info(f"Нэвтрэх хуудас: {login_url}")

    try:
        await page.goto(login_url, wait_until="domcontentloaded")
        log.info(f"Хуудас ачааллаа: {page.url}")

        # Аль хэдийн нэвтэрсэн эсэх (login хуудас биш бол)
        if "/login/" not in page.url:
            log.info("Аль хэдийн нэвтэрсэн байна")
            return True

        # 1. Нэвтрэх нэр (имэйл)
        await page.fill('input[name="login_with"]', config.ERKHET_USERNAME)
        log.info("Имэйл оруулагдлаа")

        # 2. Нууц үг
        await page.fill('input[name="password"]', config.ERKHET_PASSWORD)
        log.info("Нууц үг оруулагдлаа")

        # 3. Нэвтрэх товч
        await page.click('button[type="submit"]')
        log.info("Нэвтрэх товч дарагдлаа")

        # 4. Нэвтэрсэн эсэхийг шалгах — login хуудаснаас гарсан бол OK
        await page.wait_for_load_state("load")

        if "/login/" in page.url:
            # Login хуудсан дээрээ байвал — нууц үг буруу байж магадгүй
            log.error("❌ Нэвтрэх амжилтгүй — имэйл/нууц үг шалгана уу")
            await take_screenshot(page, "login_failed")
            return False

        log.info(f"✅ Амжилттай нэвтэрлээ → {page.url}")
        return True

    except Exception as e:
        log.error(f"❌ Нэвтрэхэд алдаа: {e}")
        await take_screenshot(page, "login_error")
        return False
