"""
Modal form-ийн select элементүүдийг шалгах скрипт.
Бараа материал /Өртгөөр/ товч дарж modal нээгээд
бүх select-ийн id, name, option-уудыг хэвлэнэ.
"""

import asyncio
from playwright.async_api import async_playwright
from dotenv import load_dotenv
import os

load_dotenv()


async def check_modal():
    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=False, slow_mo=200)
    context = await browser.new_context(viewport={"width": 1366, "height": 768})
    page = await context.new_page()

    url = os.getenv("ERKHET_URL", "https://erkhet.bto.mn")
    username = os.getenv("ERKHET_USERNAME", "")
    password = os.getenv("ERKHET_PASSWORD", "")
    cid = os.getenv("ERKHET_COMPANY_ID", "9514593312")

    print(f"Нэвтэрч байна: {url}")
    await page.goto(f"{url}/login/", wait_until="load", timeout=30000)
    await asyncio.sleep(2)

    try:
        await page.fill('input[name="email"]', username)
        await page.fill('input[name="password"]', password)
        await page.click('button[type="submit"], input[type="submit"]')
        await asyncio.sleep(4)
        print(f"Нэвтэрлээ: {page.url}")
    except Exception as e:
        print(f"Login алдаа: {e}")

    # Reports list руу очих
    reports_url = f"{url}/{cid}/reports/list/"
    print(f"\nReports руу очиж байна: {reports_url}")
    await page.goto(reports_url, wait_until="load", timeout=30000)
    await asyncio.sleep(2)

    # Бараа материал /Өртгөөр/ товч дарах
    btn = await page.query_selector('a:has-text("Бараа материал /Өртгөөр/")')
    if not btn:
        print("❌ Товч олдсонгүй")
        await browser.close()
        return

    await btn.click()
    print("✅ Товч дарагдлаа — modal нээгдэж байна...")
    await asyncio.sleep(3)

    # Modal дотрох бүх SELECT
    selects = await page.query_selector_all(".modal.in select, .modal.show select")
    print(f"\n{'='*60}")
    print(f"Modal дотрох SELECT тоо: {len(selects)}")
    print("=" * 60)

    for sel in selects:
        name = await sel.get_attribute("name") or ""
        id_ = await sel.get_attribute("id") or ""
        multiple = await sel.get_attribute("multiple")
        options = await sel.query_selector_all("option")

        print(f"\n  name={name!r:25} id={id_!r:25} multiple={multiple is not None}")
        print(f"  Нийт option: {len(options)}")
        for opt in options[:15]:
            txt = (await opt.inner_text()).strip()
            val = await opt.get_attribute("value") or ""
            if txt:
                print(f"    value={val!r:10} text={txt!r}")
        if len(options) > 15:
            print(f"    ... {len(options)-15} option цааш бий")

    # Modal дотрох INPUT-ууд
    inputs = await page.query_selector_all(".modal.in input, .modal.show input")
    print(f"\n{'='*60}")
    print(f"Modal дотрох INPUT тоо: {len(inputs)}")
    print("=" * 60)
    for inp in inputs:
        name = await inp.get_attribute("name") or ""
        id_ = await inp.get_attribute("id") or ""
        type_ = await inp.get_attribute("type") or ""
        print(f"  name={name!r:25} id={id_!r:25} type={type_!r}")

    print("\n✅ Дууслаа — browser 5 секундын дараа хаагдана")
    await asyncio.sleep(5)
    await browser.close()
    await pw.stop()


if __name__ == "__main__":
    asyncio.run(check_modal())
