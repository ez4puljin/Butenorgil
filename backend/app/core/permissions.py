"""
Эрх/цэсний нэгдсэн манифест — БҮХ хуудасны permission key + Монгол нэр
ганц эх сурвалжид.

Энэ файл нь frontend (Admin тохиргооны checkbox), backend (role seed/backfill,
key validation)-ийн аль алинд ашиглагдана. Шинэ цэс нэмэхэд ЗӨВХӨН энд бичвэл
тохиргооны UI болон seed автоматаар хамаарна (drift гарахгүй).

`universal=True` бол тухайн цэс role/permission-аас үл хамааран бүх нэвтэрсэн
хэрэглэгчид харагдана (Shell.tsx UNIVERSAL_PAGES-тэй тааруулна).
"""

PERMISSION_MANIFEST = [
    {"key": "dashboard",           "label": "Хянах самбар"},
    {"key": "order",               "label": "Захиалга"},
    {"key": "receivings",          "label": "Бараа тулгаж авах"},
    {"key": "imports",             "label": "Файл оруулалт"},
    {"key": "reports",             "label": "Тайлан"},
    {"key": "accounts_receivable", "label": "Авлага тайлан"},
    {"key": "suppliers",           "label": "Нийлүүлэгч"},
    {"key": "logistics",           "label": "Логистик"},
    {"key": "calendar",            "label": "Календар"},
    {"key": "new_product",         "label": "Шинэ бараа"},
    {"key": "sales_report",        "label": "Борлуулалтын тайлан"},
    {"key": "inventory_count",     "label": "Тооллогоны тайлан"},
    {"key": "erkhet_auto",         "label": "Erkhet автомат"},
    {"key": "bank_statements",     "label": "Тооцоо хаах"},
    {"key": "expiration_tracking", "label": "Хугацааны хяналт", "universal": True},
    {"key": "attendance",          "label": "Цаг бүртгэл",      "universal": True},
    {"key": "attendance_admin",    "label": "Цаг бүртгэл (Админ)"},
    {"key": "kpi_checklist",       "label": "Өдрийн даалгавар"},
    {"key": "kpi_approvals",       "label": "KPI зөвшөөрөл"},
    {"key": "kpi_admin",           "label": "KPI тохиргоо"},
    {"key": "min_stock",           "label": "Доод үлдэгдэл"},
    {"key": "audit_log",           "label": "Үйлдлийн бүртгэл"},
    {"key": "documents",           "label": "Бичиг баримт"},
    {"key": "admin_panel",         "label": "Удирдлага"},
]

# Бүх key-ийн жагсаалт (validation, backfill-д)
ALL_PERMISSION_KEYS = [p["key"] for p in PERMISSION_MANIFEST]
ALL_PERMISSION_KEY_SET = set(ALL_PERMISSION_KEYS)

# role/permission-аас үл хамааран үргэлж харагдах ДЕФОЛТ key-нүүд (анхны утга).
# Бодит утга нь universal_pages.json-д хадгалагдаж, админ UI-аас өөрчлөгдөнө.
DEFAULT_UNIVERSAL_KEYS = [p["key"] for p in PERMISSION_MANIFEST if p.get("universal")]
UNIVERSAL_KEYS = set(DEFAULT_UNIVERSAL_KEYS)  # backward-compat


# ── Universal pages config (admin-аар өөрчлөгддөг) ───────────────────────────
import os as _os
import json as _json

_UNIVERSAL_FILE = _os.path.join(
    _os.path.dirname(_os.path.dirname(__file__)), "data", "universal_pages.json"
)


def get_universal_pages() -> list[str]:
    """Одоогийн universal цэснүүд. Файл байхгүй бол manifest-ийн default-ыг буцаана."""
    try:
        if _os.path.exists(_UNIVERSAL_FILE):
            with open(_UNIVERSAL_FILE, "r", encoding="utf-8") as f:
                data = _json.load(f)
            return [k for k in data if k in ALL_PERMISSION_KEY_SET]
    except Exception:
        pass
    return list(DEFAULT_UNIVERSAL_KEYS)


def set_universal_pages(keys: list[str]) -> list[str]:
    """Universal цэснүүдийг хадгална (manifest-аар шүүж). Шинэ жагсаалтыг буцаана."""
    valid = sorted({k for k in (keys or []) if k in ALL_PERMISSION_KEY_SET})
    _os.makedirs(_os.path.dirname(_UNIVERSAL_FILE), exist_ok=True)
    with open(_UNIVERSAL_FILE, "w", encoding="utf-8") as f:
        _json.dump(valid, f, ensure_ascii=False, indent=2)
    return valid
