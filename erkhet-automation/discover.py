"""
Selector олох туслах скрипт.

Эрхэт-ийн бодит хуудсыг нээж, login хуудас болон тайлангийн
хуудсын selector-уудыг олоход тусална.

Ашиглах:
    python discover.py
"""

import asyncio
import sys
from playwright.async_api import async_playwright
from dotenv import load_dotenv
import os

load_dotenv()


async def discover():
    url = os.getenv("ERKHET_URL", "https://app.erkhet.mn")

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=False, slow_mo=200)
    context = await browser.new_context(viewport={"width": 1366, "height": 768})
    page = await context.new_page()

    print(f"\n🌐 Эрхэт руу орж байна: {url}")

    try:
        await page.goto(url, wait_until="load", timeout=30000)
    except Exception as e:
        print(f"⚠️  Хуудас ачаалахад анхааруулга: {e}")

    # Redirect дуусахыг хүлээх
    await safe_wait(page)

    print(f"\n📍 Одоогийн URL: {page.url}")
    print("\n" + "=" * 60)
    print("📋 LOGIN ХУУДАСНЫ ЭЛЕМЕНТҮҮД")
    print("=" * 60)
    await list_elements(page)

    print("\n" + "-" * 60)
    print("👉 Одоо browser дээр гараар нэвтрээд,")
    print("   тайлангийн хуудас руу очоод Enter дарна уу...")
    await wait_for_enter()

    await safe_wait(page)

    print(f"\n📍 Одоогийн URL: {page.url}")
    print("\n" + "=" * 60)
    print("📋 ТАЙЛАНГИЙН ХУУДАСНЫ ЭЛЕМЕНТҮҮД")
    print("=" * 60)
    await list_elements(page)

    print("\n" + "-" * 60)
    print("👉 Өөр хуудас шалгах бол тэр хуудас руу очоод Enter дарна уу.")
    print("   Дуусгах бол 'q' + Enter")

    while True:
        user_input = await wait_for_enter()
        if user_input.strip().lower() == "q":
            break
        await safe_wait(page)
        print(f"\n📍 Одоогийн URL: {page.url}")
        print("=" * 60)
        await list_elements(page)

    await browser.close()
    await pw.stop()
    print("\n✅ Дууслаа.")


async def safe_wait(page):
    """Хуудас тогтворжихыг хүлээнэ."""
    try:
        await page.wait_for_load_state("networkidle", timeout=10000)
    except Exception:
        pass
    await asyncio.sleep(2)


async def wait_for_enter() -> str:
    """Async input хүлээх."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, sys.stdin.readline)


async def list_elements(page):
    """Хуудас дээрх гол элементүүдийг жагсаана."""
    try:
        # Input-ууд
        inputs = await page.query_selector_all("input")
        if inputs:
            print(f"\n  🔤 INPUT-ууд ({len(inputs)} ширхэг):")
            for inp in inputs:
                try:
                    name = await inp.get_attribute("name") or ""
                    type_ = await inp.get_attribute("type") or ""
                    placeholder = await inp.get_attribute("placeholder") or ""
                    id_ = await inp.get_attribute("id") or ""
                    class_ = await inp.get_attribute("class") or ""
                    print(
                        f"     name={name!r:20} type={type_!r:15} "
                        f"placeholder={placeholder!r:25} id={id_!r:15} "
                        f"class={class_[:40]!r}"
                    )
                except Exception:
                    pass

        # Button-ууд
        buttons = await page.query_selector_all("button, input[type='submit']")
        if buttons:
            print(f"\n  🔘 BUTTON-ууд ({len(buttons)} ширхэг):")
            for btn in buttons:
                try:
                    text = (await btn.inner_text()).strip()[:50]
                    type_ = await btn.get_attribute("type") or ""
                    class_ = await btn.get_attribute("class") or ""
                    id_ = await btn.get_attribute("id") or ""
                    print(
                        f"     text={text!r:30} type={type_!r:10} "
                        f"id={id_!r:15} class={class_[:50]!r}"
                    )
                except Exception:
                    pass

        # Link-ууд
        links = await page.query_selector_all("a[href]")
        if links:
            print(f"\n  🔗 LINK-ууд ({len(links)} ширхэг, эхний 30):")
            for link in links[:30]:
                try:
                    text = (await link.inner_text()).strip()[:40]
                    href = await link.get_attribute("href") or ""
                    if text or href:
                        print(f"     text={text!r:30} href={href[:60]!r}")
                except Exception:
                    pass

        # Select/Dropdown
        selects = await page.query_selector_all("select")
        if selects:
            print(f"\n  📋 SELECT-ууд ({len(selects)} ширхэг):")
            for sel in selects:
                try:
                    name = await sel.get_attribute("name") or ""
                    id_ = await sel.get_attribute("id") or ""
                    print(f"     name={name!r:20} id={id_!r}")
                except Exception:
                    pass

        # Iframe-ууд
        iframes = await page.query_selector_all("iframe")
        if iframes:
            print(f"\n  🖼️  IFRAME-ууд ({len(iframes)} ширхэг):")
            for iframe in iframes:
                try:
                    src = await iframe.get_attribute("src") or ""
                    name = await iframe.get_attribute("name") or ""
                    print(f"     name={name!r:20} src={src[:60]!r}")
                except Exception:
                    pass

        if not inputs and not buttons and not links:
            print("\n  ⚠️  Элемент олдсонгүй.")
            try:
                print(f"     Title: {await page.title()}")
                html = await page.content()
                print(f"     HTML урт: {len(html)} тэмдэгт")
            except Exception:
                pass

    except Exception as e:
        print(f"\n  ❌ Элемент уншихад алдаа: {e}")
        print("     Enter дарж дахин оролдоно уу.")


if __name__ == "__main__":
    asyncio.run(discover())
