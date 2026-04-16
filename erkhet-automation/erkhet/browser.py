"""Browser удирдлага — Playwright browser нээх/хаах."""

from contextlib import asynccontextmanager
from playwright.async_api import async_playwright, Browser, BrowserContext, Page
import config
from utils.logger import setup_logger

log = setup_logger()


@asynccontextmanager
async def create_browser():
    """
    Browser + context + page үүсгээд өгнө.
    with блок дотор ашиглана:

        async with create_browser() as page:
            await page.goto(...)
    """
    pw = await async_playwright().start()
    browser: Browser | None = None

    try:
        browser = await pw.chromium.launch(
            headless=config.HEADLESS,
            slow_mo=config.SLOW_MO,
        )

        # Download хавтас тохируулсан context
        context: BrowserContext = await browser.new_context(
            accept_downloads=True,
            viewport={"width": 1366, "height": 768},
            locale="mn-MN",
        )

        # Timeout тохируулах
        context.set_default_timeout(config.TIMEOUT)

        page: Page = await context.new_page()

        log.info("Browser амжилттай нээгдлээ")
        yield page

    except Exception as e:
        log.error(f"Browser алдаа: {e}")
        raise
    finally:
        if browser:
            await browser.close()
        await pw.stop()
        log.info("Browser хаагдлаа")


async def take_screenshot(page: Page, name: str) -> str:
    """Алдааны screenshot авна. Файлын замыг буцаана."""
    from datetime import datetime

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = config.SCREENSHOT_DIR / f"{name}_{timestamp}.png"
    await page.screenshot(path=str(path), full_page=True, timeout=60000)
    log.info(f"Screenshot хадгалагдлаа: {path}")
    return str(path)
