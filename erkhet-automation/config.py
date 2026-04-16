"""Тохиргооны файл — .env файлаас уншина."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# ===== Эрхэт =====
ERKHET_URL = os.getenv("ERKHET_URL", "https://erkhet.bto.mn")
ERKHET_USERNAME = os.getenv("ERKHET_USERNAME", "")
ERKHET_PASSWORD = os.getenv("ERKHET_PASSWORD", "")
ERKHET_COMPANY_ID = os.getenv("ERKHET_COMPANY_ID", "9514593312")

# ===== Тайлан =====
REPORT_TYPE = os.getenv("REPORT_TYPE", "main_journal")
REPORT_PERIOD = os.getenv("REPORT_PERIOD", "yesterday")

# ===== Тайлангийн URL mapping =====
# Шууд URL-тай тайлангууд
REPORT_URLS = {
    "inventory_items":     "inventory/item/list/",
    "main_journal":        "main-journal/report/generate",
    "fund":                "fund/report/generate/",
    "debt":                "debt/report/generate",
    "sale_item":           "inventory/report/generate-sale/",
    "sale_cost":           "inventory/report/generate-sale-cost/",
    "inventory_daily":     "inventory/report/generate-sale-daily/",
    "inventory_census":    "inventory/report/generate-census/",
    "fixed_asset":         "fixedasset/report/generate/",
    "debt_finish":         "debt/report/finish-date",
    "inventory_remainder": "inventory/report/generate-remainder/",
    "inventory_price":     "inventory/report/generate-by-price/",
    "inventory_shipper":   "inventory/report/generate-shipper/",
    "inventory_profit":    "inventory/report/generate-profit/",
    "sale_cost_period":    "inventory/report/generate-sale-cost-period/",
    "subsys":              "inventory/seller/report-subsys/",
}

# Зөвхөн .to-excel товч дарж татах тайлангууд (огноо, форм байхгүй)
REPORT_EXCEL_ONLY = {
    "inventory_items",
}

# Reports/list хуудсаар дамжих тайлангууд (товчны текст)
REPORT_LIST_ITEMS = {
    "inventory_cost":    "Бараа материал /Өртгөөр/",
    "milko_movement":      "Бараа материал /Өртгөөр/",
    "milko_sale":          "Борлуулалт /Бараагаар/",
    "altanjoluu_movement": "Бараа материал /Өртгөөр/",
    "altanjoluu_sale":     "Борлуулалт /Бараагаар/",
}

# Тайлангийн нэмэлт параметрүүд (глобал default)
REPORT_LOCATIONS = os.getenv("REPORT_LOCATIONS", "01,02,10,11,12").split(",")
REPORT_ACCOUNT = os.getenv("REPORT_ACCOUNT", "150101")

# Тайлан бүрийн тусгай параметрүүд
# locations: байршлын кодууд, account: данс, brand: бренд,
# tr_kind: гүйлгээний төрөл (id_get_tr_kind), period: хугацаа
REPORT_PARAMS = {
    "inventory_cost": {
        "locations": REPORT_LOCATIONS,
        "account":   REPORT_ACCOUNT,
        "brand":     "",
        "tr_kind":   "",
        "period":    REPORT_PERIOD,
    },
    "milko_movement": {
        "locations": ["12"],
        "account":   "150101",
        "brand":     "Милко ХХК",
        "tr_kind":   "Зөвхөн дотоод хөдөлгөөн",
        "period":    "yesterday",
        "output":    "pdf",
    },
    "milko_sale": {
        "locations": ["12"],
        "account":   "510101",
        "brand":     "Милко ХХК",
        "tr_kind":   "Зөвхөн ажил үйлчилгээ борлуулалт",
        "fraction":  "Ажилтан",
        "period":    "yesterday",
        "output":    "pdf",
    },
    "altanjoluu_movement": {
        "locations": ["12"],
        "account":   "150101",
        "brand":     "Алтан жолоо ХХК",
        "tr_kind":   "Зөвхөн дотоод хөдөлгөөн",
        "period":    "yesterday",
        "output":    "pdf",
    },
    "altanjoluu_sale": {
        "locations": ["12"],
        "account":   "510101",
        "brand":     "Алтан жолоо ХХК",
        "tr_kind":   "Зөвхөн ажил үйлчилгээ борлуулалт",
        "fraction":  "Ажилтан",
        "period":    "yesterday",
        "output":    "pdf",
    },
}

# Формтой тайлангууд (report_id ашигладаг)
REPORT_FORM_IDS = {
    "balance": "1",
    "result":  "3",
}

# Тайлангийн нэр (мэдэгдэл, лог-д ашиглана)
REPORT_NAMES = {
    "inventory_items":       "Бараа материалын жагсаалт",
    "milko_movement":        "Милко хөдөлгөөний тайлан",
    "milko_sale":            "Милко борлуулалтын тайлан",
    "altanjoluu_movement":   "Алтанжолоо хөдөлгөөний тайлан",
    "altanjoluu_sale":       "Алтанжолоо борлуулалтын тайлан",
    "main_journal":          "Ерөнхий журнал",
    "fund":                "Мөнгөн хөрөнгө",
    "debt":                "Авлага өглөг",
    "inventory_cost":      "Үлдэгдлийн тайлан",
    "sale_item":           "Борлуулалт /Бараагаар/",
    "sale_cost":           "Борлуулалт /Өртгөөр/",
    "inventory_daily":     "Бараа материал /Баримтаар/",
    "inventory_census":    "Бараа материал тооллого",
    "fixed_asset":         "Үндсэн хөрөнгө",
    "debt_finish":         "Тооцоо хаагдах төлөв",
    "inventory_remainder": "Барааны хязгаарт үлдэгдэл",
    "inventory_price":     "Бараа материал /Үнээр/",
    "inventory_shipper":   "Бараа нийлүүлэлтийн тооцоо",
    "inventory_profit":    "Барааны ашгийн тайлан",
    "sale_cost_period":    "Борлуулалт /Өртгөөр/ - Үе шат",
    "subsys":              "Дэд системийн тайлан",
    "balance":             "Баланс",
    "result":              "Үр дүнгийн тайлан",
}

# ===== Файлын зам =====
BASE_DIR = Path(__file__).parent
DOWNLOAD_DIR = Path(os.getenv("DOWNLOAD_DIR", BASE_DIR / "downloads"))
SCREENSHOT_DIR = BASE_DIR / "screenshots"
LOG_DIR = BASE_DIR / "logs"

COOKIES_DIR = BASE_DIR / "cookies"

DOWNLOAD_DIR.mkdir(exist_ok=True)
SCREENSHOT_DIR.mkdir(exist_ok=True)
LOG_DIR.mkdir(exist_ok=True)
COOKIES_DIR.mkdir(exist_ok=True)

# ===== Мэдэгдэл =====
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

# ===== Facebook Messenger =====
MESSENGER_ENABLED = os.getenv("MESSENGER_ENABLED", "false").lower() == "true"
FB_EMAIL = os.getenv("FB_EMAIL", "")
FB_PASSWORD = os.getenv("FB_PASSWORD", "")
MESSENGER_GROUP_MILKO = os.getenv("MESSENGER_GROUP_MILKO", "")
MESSENGER_GROUP_ALTANJOLUU = os.getenv("MESSENGER_GROUP_ALTANJOLUU", "")
MESSENGER_MESSAGE = os.getenv(
    "MESSENGER_MESSAGE",
    "Өглөөний мэнд. Өчигдрийн мэдээний тайлан явууллаа."
    "Өдрийг сайхан өнгөрүүлээрэй. Бүтэн-Оргил Agent",
)

# Тайлан → Messenger group mapping
MESSENGER_GROUPS = {
    "milko_movement": MESSENGER_GROUP_MILKO,
    "milko_sale": MESSENGER_GROUP_MILKO,
    "altanjoluu_movement": MESSENGER_GROUP_ALTANJOLUU,
    "altanjoluu_sale": MESSENGER_GROUP_ALTANJOLUU,
}

# ===== Scheduler =====
SCHEDULE_HOUR = int(os.getenv("SCHEDULE_HOUR", "8"))
SCHEDULE_MINUTE = int(os.getenv("SCHEDULE_MINUTE", "0"))

# ===== Browser =====
HEADLESS = True
SLOW_MO = 0
TIMEOUT = 30000


def get_report_name() -> str:
    return REPORT_NAMES.get(REPORT_TYPE, REPORT_TYPE)


def validate():
    errors = []
    if not ERKHET_USERNAME:
        errors.append("ERKHET_USERNAME .env файлд оруулна уу")
    if not ERKHET_PASSWORD:
        errors.append("ERKHET_PASSWORD .env файлд оруулна уу")
    all_types = {**REPORT_URLS, **REPORT_LIST_ITEMS, **REPORT_FORM_IDS,
                 **{k: k for k in REPORT_EXCEL_ONLY}}
    if REPORT_TYPE not in all_types:
        errors.append(
            f"REPORT_TYPE='{REPORT_TYPE}' буруу. "
            f"Зөв утгууд: {', '.join(all_types.keys())}"
        )
    if errors:
        raise ValueError("Тохиргооны алдаа:\n  - " + "\n  - ".join(errors))
