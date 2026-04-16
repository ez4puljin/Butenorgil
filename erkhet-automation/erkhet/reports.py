"""
Эрхэт-ээс тайлан татах модуль.

Гурван төрлийн тайлан:
  1. Reports/list хуудсаар дамжих тайлан (Бараа материал /Өртгөөр/ г.м.)
  2. URL-тай тайлан — шууд хуудас руу очиж, огноо оруулж, татна
  3. Формтой тайлан (Баланс, Үр дүнгийн тайлан) — reports/list хуудас
     дээр report_id, огноо оруулж, "Тайлан авах" товч дарна
"""

import asyncio
from datetime import datetime, timedelta
from playwright.async_api import Page
import config
from utils.logger import setup_logger
from erkhet.browser import take_screenshot

log = setup_logger()


def _get_date_range() -> tuple[str, str]:
    """REPORT_PERIOD тохиргоогоор огнооны хязгаар тооцоолно."""
    today = datetime.now()

    if config.REPORT_PERIOD == "today":
        d = today.strftime("%Y-%m-%d")
        return d, d
    elif config.REPORT_PERIOD == "yesterday":
        d = (today - timedelta(days=1)).strftime("%Y-%m-%d")
        return d, d
    elif config.REPORT_PERIOD == "this_month":
        start = today.replace(day=1).strftime("%Y-%m-%d")
        end = today.strftime("%Y-%m-%d")
        return start, end
    elif config.REPORT_PERIOD == "last_month":
        first = today.replace(day=1)
        last_day = first - timedelta(days=1)
        start = last_day.replace(day=1).strftime("%Y-%m-%d")
        end = last_day.strftime("%Y-%m-%d")
        return start, end
    else:
        d = (today - timedelta(days=1)).strftime("%Y-%m-%d")
        return d, d


def _generate_filename() -> str:
    """Файлын нэр үүсгэнэ."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    name = config.get_report_name().replace(" ", "_").replace("/", "_")
    return f"{name}_{timestamp}"


async def _fill_date(page: Page, selector: str, date_value: str):
    """Datepicker input-д огноо оруулна."""
    try:
        el = await page.wait_for_selector(selector, timeout=5000)
        await el.click()
        await el.fill("")
        await el.fill(date_value)
        await page.click("body")
        await asyncio.sleep(0.3)
    except Exception as e:
        log.warning(f"Огноо оруулахад анхааруулга ({selector}): {e}")


async def download_report(page: Page) -> str | None:
    """
    Эрхэт-ээс тайлан татна.
    Амжилттай бол файлын замыг буцаана.
    """
    report_type = config.REPORT_TYPE

    if report_type in config.REPORT_LIST_ITEMS:
        return await _download_list_report(page)
    elif report_type in config.REPORT_EXCEL_ONLY:
        return await _download_excel_only_report(page)
    elif report_type in config.REPORT_URLS:
        return await _download_url_report(page)
    elif report_type in config.REPORT_FORM_IDS:
        return await _download_form_report(page)
    else:
        log.error(f"Тодорхойгүй тайлангийн төрөл: {report_type}")
        return None


# ================================================================
#  1. Reports/list хуудсаар дамжих тайлан
# ================================================================

async def _select_by_text(page: Page, element_id: str, search_text: str) -> str:
    """Select элементэд текстээр утга сонгоно (Chosen plugin дэмжинэ)."""
    return await page.evaluate(f"""(() => {{
        const sel = document.getElementById('{element_id}');
        if (!sel) return '{element_id} олдсонгүй';

        for (const opt of sel.options) {{ opt.selected = false; }}

        for (const opt of sel.options) {{
            if (opt.text.includes('{search_text}')) {{
                opt.selected = true;
                if (typeof $ !== 'undefined' && $(sel).data('chosen')) {{
                    $(sel).trigger('chosen:updated');
                }}
                return opt.text.trim().substring(0, 60);
            }}
        }}
        return '{search_text} олдсонгүй';
    }})()""")


async def _download_list_report(page: Page) -> str | None:
    """
    Reports/list хуудас руу очиж, тайлангийн товч дарж,
    modal form бөглөж, hidden form-р POST хийж тайлан татна.

    Эрхэт нь Chosen plugin ашигладаг тул native <select> нууцлагдсан.
    jQuery API-р утга оруулна.
    """
    report_type = config.REPORT_TYPE
    report_name = config.get_report_name()
    button_text = config.REPORT_LIST_ITEMS[report_type]

    # Тайлан бүрийн тусгай параметр (байхгүй бол глобал тохиргоо)
    params = config.REPORT_PARAMS.get(report_type, {})
    locations = params.get("locations") or [loc.strip() for loc in config.REPORT_LOCATIONS]
    account   = params.get("account")   or config.REPORT_ACCOUNT
    brand     = params.get("brand",    "")
    tr_kind   = params.get("tr_kind",  "")
    fraction  = params.get("fraction", "")

    # Хугацаа: params-д байвал тэрийг, үгүй бол глобал
    period_override = params.get("period", "")
    if period_override:
        original_period = config.REPORT_PERIOD
        config.REPORT_PERIOD = period_override
    date_from, date_to = _get_date_range()
    if period_override:
        config.REPORT_PERIOD = original_period

    base = config.ERKHET_URL.rstrip("/")
    cid = config.ERKHET_COMPANY_ID
    url = f"{base}/{cid}/reports/list/"

    log.info(f"Тайлан: {report_name}")
    log.info(f"URL: {url}")

    try:
        # 1. Reports/list хуудас руу очих
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_load_state("load")
        log.info(f"Хуудас ачааллаа: {page.url}")

        # 2. Тайлангийн товч дарах
        report_btn = await page.query_selector(f'a:has-text("{button_text}")')
        if not report_btn:
            report_btn = await page.query_selector(f'text="{button_text}"')

        if not report_btn:
            log.error(f"❌ '{button_text}' товч олдсонгүй")
            await take_screenshot(page, "report_button_not_found")
            return None

        await report_btn.click()
        log.info(f"'{button_text}' товч дарагдлаа")
        await asyncio.sleep(2)

        # 3. Огноо оруулах
        log.info(f"Огноо: {date_from} → {date_to}")

        await page.evaluate(f"""(() => {{
            const modal = document.querySelector('.modal.in, .modal.show');
            if (!modal || typeof $ === 'undefined') return;
            $(modal).find('input[name="begin_date"]').val('{date_from}');
            $(modal).find('input[name="end_date"]').val('{date_to}');
        }})()""")

        # 4. Байршил сонгох (inv_location select)
        log.info(f"Байршил: {locations}")

        loc_result = await page.evaluate(f"""(() => {{
            const sel = document.getElementById('id_inv_location');
            if (!sel) return 'inv_location олдсонгүй';
            const codes = {locations};
            const matched = [];

            for (const opt of sel.options) {{ opt.selected = false; }}

            for (const opt of sel.options) {{
                const trimmed = opt.text.trim().replace(/^\\s+/, '');
                for (const code of codes) {{
                    if (trimmed.startsWith(code + ' - ') || trimmed.startsWith(code + ' ')) {{
                        opt.selected = true;
                        matched.push(trimmed.substring(0, 25));
                    }}
                }}
            }}

            if (typeof $ !== 'undefined' && $(sel).data('chosen')) {{
                $(sel).trigger('chosen:updated');
            }}
            return matched.length > 0 ? matched.join(', ') : 'олдсонгүй';
        }})()""")
        log.info(f"Байршил сонгогдлоо: {loc_result}")

        # 5. Данс сонгох (account select)
        acct_result = await _select_by_text(page, "id_account", account)
        log.info(f"Данс сонгогдлоо: {acct_result}")

        # 6. Бренд сонгох (байвал)
        if brand:
            brand_result = await _select_by_text(page, "id_brand", brand)
            log.info(f"Бренд сонгогдлоо: {brand_result}")

        # 7. Гүйлгээний төрөл сонгох (байвал)
        if tr_kind:
            tr_result = await _select_by_text(page, "id_get_tr_kind", tr_kind)
            log.info(f"Гүйлгээний төрөл сонгогдлоо: {tr_result}")

        # 8. Бүлэглэл сонгох (байвал) — "Ажилтан" option-тэй select хайна
        if fraction:
            frac_result = await page.evaluate(f"""(() => {{
                const modal = document.querySelector('.modal.in, .modal.show');
                if (!modal) return 'modal олдсонгүй';

                // "Ажилтан" гэсэн option-тэй select-ийг хайна
                for (const sel of modal.querySelectorAll('select')) {{
                    for (const opt of sel.options) {{
                        if (opt.text.trim() === '{fraction}') {{
                            for (const o of sel.options) {{ o.selected = false; }}
                            opt.selected = true;
                            if (typeof $ !== 'undefined' && $(sel).data('chosen')) {{
                                $(sel).trigger('chosen:updated');
                            }}
                            return opt.text.trim();
                        }}
                    }}
                }}
                return '{fraction} олдсонгүй';
            }})()""")
            log.info(f"Бүлэглэл сонгогдлоо: {frac_result}")

        # Dropdown хаах
        await page.evaluate("""(() => {
            if (typeof $ !== 'undefined') {
                $('.chosen-container-active').removeClass('chosen-container-active');
                $('.chosen-with-drop').removeClass('chosen-with-drop');
            }
        })()""")
        await asyncio.sleep(0.5)

        # 6. Hidden form үүсгэж POST submit хийх
        log.info("Тайлан авах — POST submit хийж байна...")

        try:
            async with page.expect_navigation(timeout=180000, wait_until="domcontentloaded"):
                await page.evaluate(f"""(() => {{
                    const modal = document.querySelector('.modal.in, .modal.show');
                    const origForm = modal?.querySelector('form');
                    if (!origForm) return;

                    const form = document.createElement('form');
                    form.method = 'post';
                    form.action = origForm.action;
                    form.style.display = 'none';

                    // CSRF token
                    const csrf = origForm.querySelector('input[name="csrfmiddlewaretoken"]');
                    if (csrf) {{
                        const inp = document.createElement('input');
                        inp.type = 'hidden'; inp.name = 'csrfmiddlewaretoken'; inp.value = csrf.value;
                        form.appendChild(inp);
                    }}

                    // Select утгууд
                    for (const sel of origForm.querySelectorAll('select[name]')) {{
                        if (sel.multiple) {{
                            for (const opt of sel.selectedOptions) {{
                                if (opt.value && opt.value !== '') {{
                                    const inp = document.createElement('input');
                                    inp.type = 'hidden'; inp.name = sel.name; inp.value = opt.value;
                                    form.appendChild(inp);
                                }}
                            }}
                        }} else if (sel.value) {{
                            const inp = document.createElement('input');
                            inp.type = 'hidden'; inp.name = sel.name; inp.value = sel.value;
                            form.appendChild(inp);
                        }}
                    }}

                    // Input утгууд
                    for (const orig of origForm.querySelectorAll('input[name]')) {{
                        if (orig.name === 'csrfmiddlewaretoken') continue;
                        if (orig.type === 'checkbox' && !orig.checked) continue;
                        const inp = document.createElement('input');
                        inp.type = 'hidden'; inp.name = orig.name;
                        inp.value = orig.value || '';
                        form.appendChild(inp);
                    }}

                    // Огноо тохируулах
                    const bd = form.querySelector('input[name="begin_date"]');
                    if (bd) bd.value = '{date_from}';
                    const ed = form.querySelector('input[name="end_date"]');
                    if (ed) ed.value = '{date_to}';

                    document.body.appendChild(form);
                    form.submit();
                }})()""")
                log.info("POST submit хийгдлээ")
        except Exception as e:
            log.warning(f"Navigation: {e}")

        # 7. Тайлан ачаалагдахыг хүлээх (Эрхэт сервер удаан байж болно — 5 мин хүртэл)
        log.info(f"Тайлан ачаалагдаж байна: {page.url[:80]}")
        try:
            await page.wait_for_load_state("load", timeout=360000)
            log.info("Хуудас load боллоо")
        except Exception:
            log.warning("load timeout (6 мин) — үргэлжлүүлж байна")

        # Тайлан агуулга ачаалагдсан эсэхийг шалгах
        try:
            await page.wait_for_selector(
                "table, .report-content, .report-table, #content, .to-excel, a:has-text('Excel')",
                timeout=360000,
            )
            log.info("Тайлан бэлэн боллоо")
        except Exception:
            log.warning("Тайлан агуулга 6 минутад олдсонгүй — үргэлжлүүлж байна")

        await asyncio.sleep(2)

        try:
            await take_screenshot(page, f"report_{config.REPORT_TYPE}_result")
        except Exception:
            pass

        # 8. PDF эсвэл Excel татах
        if params.get("output") == "pdf":
            return await _save_as_pdf(page)
        return await _try_download(page, report_name)

    except Exception as e:
        log.error(f"❌ Тайлан татахад алдаа: {e}")
        try:
            await take_screenshot(page, "report_error")
        except Exception:
            pass
        return None


# ================================================================
#  2. Зөвхөн Excel товч дарж татах тайлан (Бараа материалын жагсаалт)
# ================================================================

async def _download_excel_only_report(page: Page) -> str | None:
    """
    URL руу очиж, .to-excel товч дарж файл татна.
    Огноо, форм байхгүй — зүгээр очиж товч дарахад л болно.
    """
    report_path = config.REPORT_URLS[config.REPORT_TYPE]
    report_name = config.get_report_name()
    base = config.ERKHET_URL.rstrip("/")
    cid = config.ERKHET_COMPANY_ID
    url = f"{base}/{cid}/{report_path}"

    log.info(f"Тайлан: {report_name}")
    log.info(f"URL: {url}")

    try:
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_load_state("load")
        log.info(f"Хуудас ачааллаа: {page.url}")

        await asyncio.sleep(2)

        # .to-excel товч хайж дарах
        excel_btn = await page.query_selector(".to-excel")
        if not excel_btn:
            log.error("❌ .to-excel товч олдсонгүй")
            await take_screenshot(page, "excel_btn_not_found")
            return None

        log.info("Excel товч олдлоо — татаж байна...")

        async with page.expect_download(timeout=60000) as dl_info:
            await excel_btn.click()

        download = await dl_info.value
        filename_base = _generate_filename()
        suggested = download.suggested_filename or f"{filename_base}.xlsx"
        save_path = config.DOWNLOAD_DIR / suggested
        await download.save_as(str(save_path))
        log.info(f"✅ Файл татагдлаа: {save_path}")
        return str(save_path)

    except Exception as e:
        log.error(f"❌ Тайлан татахад алдаа: {e}")
        try:
            await take_screenshot(page, "report_error")
        except Exception:
            pass
        return None


# ================================================================
#  3. URL-тай тайлан (Ерөнхий журнал, Борлуулалт гэх мэт)
# ================================================================

async def _download_url_report(page: Page) -> str | None:
    """URL-тай тайлан — хуудас руу очиж, огноо оруулж, татна."""
    report_path = config.REPORT_URLS[config.REPORT_TYPE]
    report_name = config.get_report_name()
    base = config.ERKHET_URL.rstrip("/")
    cid = config.ERKHET_COMPANY_ID
    url = f"{base}/{cid}/{report_path}"

    log.info(f"Тайлан: {report_name}")
    log.info(f"URL: {url}")

    try:
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_load_state("load")
        log.info(f"Хуудас ачааллаа: {page.url}")

        date_from, date_to = _get_date_range()
        log.info(f"Огноо: {date_from} → {date_to}")

        await _fill_date(page, 'input[name="begin_date"]', date_from)
        await _fill_date(page, 'input[name="end_date"]', date_to)

        submit_btn = await page.query_selector(
            'button#get_report, button[type="submit"], '
            'input[type="submit"], button:has-text("Тайлан авах"), '
            'button:has-text("Хайх"), button:has-text("Харах")'
        )

        if submit_btn:
            await submit_btn.click()
            log.info("Тайлан авах товч дарагдлаа")
            await page.wait_for_load_state("networkidle")
        else:
            log.warning("Submit товч олдсонгүй")

        await asyncio.sleep(2)
        await take_screenshot(page, f"report_{config.REPORT_TYPE}")

        return await _try_download(page, report_name)

    except Exception as e:
        log.error(f"❌ Тайлан татахад алдаа: {e}")
        await take_screenshot(page, "report_error")
        return None


# ================================================================
#  3. Формтой тайлан (Баланс, Үр дүнгийн тайлан)
# ================================================================

async def _download_form_report(page: Page) -> str | None:
    """Формтой тайлан — reports/list хуудас дээр report_id тохируулж submit."""
    report_id = config.REPORT_FORM_IDS[config.REPORT_TYPE]
    report_name = config.get_report_name()
    base = config.ERKHET_URL.rstrip("/")
    cid = config.ERKHET_COMPANY_ID
    url = f"{base}/{cid}/reports/list/"

    log.info(f"Тайлан: {report_name} (report_id={report_id})")
    log.info(f"URL: {url}")

    try:
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_load_state("load")
        log.info(f"Хуудас ачааллаа: {page.url}")

        await page.evaluate(
            f'document.getElementById("report_id").value = "{report_id}"'
        )

        date_from, date_to = _get_date_range()
        log.info(f"Огноо: {date_from} → {date_to}")

        await _fill_date(page, 'input[name="begin_date"]', date_from)
        await _fill_date(page, 'input[name="end_date"]', date_to)

        await page.click('button#get_report')
        log.info("Тайлан авах товч дарагдлаа")
        await page.wait_for_load_state("networkidle")

        await asyncio.sleep(3)
        await take_screenshot(page, f"report_{config.REPORT_TYPE}")

        return await _try_download(page, report_name)

    except Exception as e:
        log.error(f"❌ Тайлан татахад алдаа: {e}")
        await take_screenshot(page, "report_error")
        return None


# ================================================================
#  Файл татах (Excel, PDF, Print)
# ================================================================

async def _save_as_pdf(page: Page) -> str | None:
    """Хуудсыг A4 хэвтээ PDF болгон хадгална (Print → PDF-тэй адил)."""
    filename_base = _generate_filename()
    pdf_path = config.DOWNLOAD_DIR / f"{filename_base}.pdf"
    try:
        await page.pdf(
            path=str(pdf_path),
            format="A4",
            landscape=True,
            print_background=True,
        )
        log.info(f"✅ PDF хадгалагдлаа: {pdf_path}")
        return str(pdf_path)
    except Exception as e:
        log.error(f"❌ PDF хадгалахад алдаа: {e}")
        return None

async def _try_download(page: Page, report_name: str) -> str | None:
    """
    Хуудас дээрээс Excel/PDF товч хайж, файл татна.
    Олдохгүй бол хуудсыг PDF болгон хадгална.
    """
    filename_base = _generate_filename()

    download_selectors = [
        'a:has-text("Excel")',
        'a:has-text("excel")',
        'button:has-text("Excel")',
        'a:has-text("Татах")',
        'button:has-text("Татах")',
        'a:has-text("Export")',
        'a[href*="export"]',
        'a[href*="excel"]',
        'a[href*="download"]',
        'a:has-text("PDF")',
        'button:has-text("PDF")',
    ]

    for selector in download_selectors:
        try:
            el = await page.query_selector(selector)
            if el and await el.is_visible():
                log.info(f"Татах товч олдлоо: {selector}")

                async with page.expect_download(timeout=60000) as dl_info:
                    await el.click()

                download = await dl_info.value
                suggested = download.suggested_filename or f"{filename_base}.xlsx"
                save_path = config.DOWNLOAD_DIR / suggested
                await download.save_as(str(save_path))
                log.info(f"✅ Файл татагдлаа: {save_path}")
                return str(save_path)
        except Exception:
            continue

    log.warning("Татах товч олдсонгүй — хуудсыг PDF болгон хадгалж байна")
    try:
        pdf_path = config.DOWNLOAD_DIR / f"{filename_base}.pdf"
        await page.pdf(path=str(pdf_path), format="A4", landscape=True)
        log.info(f"✅ PDF хадгалагдлаа: {pdf_path}")
        return str(pdf_path)
    except Exception:
        log.warning("PDF үүсгэж чадсангүй — screenshot хадгалж байна")
        png_path = config.DOWNLOAD_DIR / f"{filename_base}.png"
        await page.screenshot(path=str(png_path), full_page=True)
        log.info(f"✅ Screenshot хадгалагдлаа: {png_path}")
        return str(png_path)
