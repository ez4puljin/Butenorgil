from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import text
from pathlib import Path
import asyncio
import sqlite3 as _sqlite3
from datetime import datetime

from app.core.config import settings
from app.core.db import Base, engine, SessionLocal
from app.api import auth_router, admin_router, imports_router, products_router, orders_router, reports_router, accounts_receivable_router, suppliers_router, logistics_router, purchase_orders_router, calendar_router, kpi_router, new_product_router, sales_report_router, inventory_count_router, erkhet_auto_router, receivings_router, bank_statements_router
from app.services.seed import ensure_admin
from app.models.sales_report import SalesImportLog, SalesCacheRow  # noqa: F401 – registers tables
from app.models.inventory_count import InventoryCount, InventoryCountFile  # noqa: F401 – registers tables
from app.models.role import Role  # noqa: F401 – registers table
from app.models.purchase_order import PurchaseOrderBrandStatus  # noqa: F401 – registers table
from app.models.kpi import KpiScheduledDay, KpiShiftTransfer, KpiAuditLog  # noqa: F401 – registers tables
from app.models.calendar_label import CalendarLabel  # noqa: F401 – registers table
from app.models.receiving import ReceivingSession, ReceivingLine, ReceivingBrandStatus  # noqa: F401 – registers tables
from app.models.min_stock_rule import MinStockRule  # noqa: F401 – registers table
from app.models.bank_statement import BankStatement, BankTransaction, BankAccountConfig, SettlementConfig, CrossAccountPreset, FeeConfig  # noqa: F401 – registers tables

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

def ensure_import_logs_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(import_logs)")).fetchall()]
        if cols and "username" not in cols:
            conn.execute(text("ALTER TABLE import_logs ADD COLUMN username VARCHAR(50) DEFAULT ''"))

def ensure_users_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(users)")).fetchall()]
        if cols and "phone" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN phone VARCHAR(30) DEFAULT ''"))
        if cols and "nickname" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN nickname VARCHAR(100) DEFAULT ''"))
        if cols and "base_role" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN base_role VARCHAR(50) DEFAULT ''"))
            # Populate base_role from role for existing users
            conn.execute(text("UPDATE users SET base_role = role WHERE base_role = '' OR base_role IS NULL"))

_ROLE_PERMISSIONS = {
    "admin":           "dashboard,imports,reports,accounts_receivable,order,suppliers,logistics,calendar,admin_panel,kpi_checklist,kpi_approvals,kpi_admin,new_product,sales_report,inventory_count,erkhet_auto,bank_statements",
    "supervisor":      "dashboard,imports,reports,accounts_receivable,order,suppliers,logistics,calendar,kpi_checklist,kpi_approvals,new_product,sales_report,inventory_count,erkhet_auto,bank_statements",
    "manager":         "dashboard,imports,reports,order,logistics,calendar,kpi_checklist,kpi_approvals,new_product,sales_report,inventory_count",
    "warehouse_clerk": "order,calendar,kpi_checklist,kpi_approvals",
    "accountant":      "dashboard,reports,accounts_receivable,order,calendar,kpi_checklist,kpi_approvals,sales_report,bank_statements",
}

def ensure_roles_schema():
    """Add permissions column to roles table if missing."""
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(roles)")).fetchall()]
        if cols and "permissions" not in cols:
            conn.execute(text("ALTER TABLE roles ADD COLUMN permissions VARCHAR(500) DEFAULT ''"))

def ensure_roles_seeded():
    """Seed the 5 system roles and ensure permissions are set."""
    from app.models.role import Role as RoleModel
    db = SessionLocal()
    try:
        if db.query(RoleModel).count() == 0:
            system_roles = [
                RoleModel(value="admin",           label="Админ",            color="bg-rose-100 text-rose-700",    base_role="admin",           permissions=_ROLE_PERMISSIONS["admin"],           is_system=True),
                RoleModel(value="supervisor",      label="Хянагч",           color="bg-blue-100 text-blue-700",    base_role="supervisor",      permissions=_ROLE_PERMISSIONS["supervisor"],      is_system=True),
                RoleModel(value="manager",         label="Менежер",          color="bg-emerald-100 text-emerald-700", base_role="manager",      permissions=_ROLE_PERMISSIONS["manager"],         is_system=True),
                RoleModel(value="warehouse_clerk", label="Агуулахын нярав",  color="bg-orange-100 text-orange-700",base_role="warehouse_clerk", permissions=_ROLE_PERMISSIONS["warehouse_clerk"], is_system=True),
                RoleModel(value="accountant",      label="Нягтлан",          color="bg-violet-100 text-violet-700",base_role="accountant",      permissions=_ROLE_PERMISSIONS["accountant"],      is_system=True),
            ]
            db.add_all(system_roles)
            db.commit()
        else:
            # Always sync system role permissions with _ROLE_PERMISSIONS
            for r in db.query(RoleModel).filter(RoleModel.is_system == True).all():
                if r.value in _ROLE_PERMISSIONS:
                    r.permissions = _ROLE_PERMISSIONS[r.value]
            db.commit()
    finally:
        db.close()

def ensure_products_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(products)")).fetchall()]
        if cols and "warehouse_name" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN warehouse_name VARCHAR(200) DEFAULT ''"))
        if cols and "price_tag" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN price_tag VARCHAR(200) DEFAULT ''"))
        if cols and "barcode" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN barcode VARCHAR(64) DEFAULT ''"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_products_barcode ON products(barcode)"))


def ensure_min_stock_rules_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(min_stock_rules)")).fetchall()]
        if cols and "product_id" not in cols:
            conn.execute(text("ALTER TABLE min_stock_rules ADD COLUMN product_id INTEGER"))

def ensure_po_lines_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(purchase_order_lines)")).fetchall()]
        if cols and "line_remark" not in cols:
            conn.execute(text("ALTER TABLE purchase_order_lines ADD COLUMN line_remark VARCHAR(500) DEFAULT ''"))
        if cols and "received_qty_extra_pcs" not in cols:
            conn.execute(text("ALTER TABLE purchase_order_lines ADD COLUMN received_qty_extra_pcs FLOAT DEFAULT 0"))
        if cols and "override_brand" not in cols:
            conn.execute(text("ALTER TABLE purchase_order_lines ADD COLUMN override_brand VARCHAR(100) DEFAULT ''"))


def ensure_receiving_lines_schema():
    """receiving_lines-д override_brand болон price_reviewed багана нэмнэ."""
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(receiving_lines)")).fetchall()]
        if cols and "override_brand" not in cols:
            conn.execute(text("ALTER TABLE receiving_lines ADD COLUMN override_brand VARCHAR(100) DEFAULT ''"))
        if cols and "price_reviewed" not in cols:
            conn.execute(text("ALTER TABLE receiving_lines ADD COLUMN price_reviewed BOOLEAN DEFAULT 0 NOT NULL"))

def ensure_price_schema():
    with engine.begin() as conn:
        cols_p = [r[1] for r in conn.execute(text("PRAGMA table_info(products)")).fetchall()]
        if cols_p and "last_purchase_price" not in cols_p:
            conn.execute(text("ALTER TABLE products ADD COLUMN last_purchase_price FLOAT DEFAULT 0"))
        cols_l = [r[1] for r in conn.execute(text("PRAGMA table_info(purchase_order_lines)")).fetchall()]
        if cols_l and "unit_price" not in cols_l:
            conn.execute(text("ALTER TABLE purchase_order_lines ADD COLUMN unit_price FLOAT DEFAULT 0"))

def ensure_extra_lines_brand():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(order_extra_lines)")).fetchall()]
        if cols and "brand" not in cols:
            conn.execute(text("ALTER TABLE order_extra_lines ADD COLUMN brand VARCHAR(100) DEFAULT ''"))

def ensure_brand_code_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(products)")).fetchall()]
        if cols and "brand_code" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN brand_code VARCHAR(50) DEFAULT ''"))

def ensure_shipment_lines_schema():
    """po_shipment_lines-д received_qty_box багана нэмнэ."""
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(po_shipment_lines)")).fetchall()]
        if cols and "received_qty_box" not in cols:
            conn.execute(text("ALTER TABLE po_shipment_lines ADD COLUMN received_qty_box FLOAT DEFAULT 0"))

def ensure_bank_account_configs_schema():
    """bank_account_configs-д erp_account_code багана нэмнэ."""
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(bank_account_configs)")).fetchall()]
        if cols and "erp_account_code" not in cols:
            conn.execute(text("ALTER TABLE bank_account_configs ADD COLUMN erp_account_code VARCHAR(20) DEFAULT ''"))

def ensure_bank_transactions_schema():
    """bank_transactions-д export_type багана нэмнэ."""
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(bank_transactions)")).fetchall()]
        if cols and "export_type" not in cols:
            conn.execute(text("ALTER TABLE bank_transactions ADD COLUMN export_type VARCHAR(20) DEFAULT ''"))

def ensure_admin_task_target_schema():
    """kpi_admin_daily_tasks-д target_employee_ids багана нэмнэ."""
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(kpi_admin_daily_tasks)")).fetchall()]
        if cols and "target_employee_ids" not in cols:
            conn.execute(text("ALTER TABLE kpi_admin_daily_tasks ADD COLUMN target_employee_ids VARCHAR(500) DEFAULT ''"))

def ensure_order_lines_schema():
    """order_lines-д stock_qty_snapshot багана нэмнэ (Үлдэгдлийн тайланаас авсан нөөц)."""
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(order_lines)")).fetchall()]
        if cols and "stock_qty_snapshot" not in cols:
            conn.execute(text(
                "ALTER TABLE order_lines ADD COLUMN stock_qty_snapshot FLOAT DEFAULT 0"
            ))

def ensure_kpi_admin_task_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(kpi_checklist_entries)")).fetchall()]
        if cols and "admin_task_id" not in cols:
            conn.execute(text(
                "ALTER TABLE kpi_checklist_entries ADD COLUMN admin_task_id INTEGER REFERENCES kpi_admin_daily_tasks(id)"
            ))

def ensure_po_archive_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(purchase_orders)")).fetchall()]
        if cols and "is_archived" not in cols:
            conn.execute(text("ALTER TABLE purchase_orders ADD COLUMN is_archived BOOLEAN DEFAULT 0 NOT NULL"))


def ensure_po_vehicle_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(purchase_orders)")).fetchall()]
        if cols and "vehicle_id" not in cols:
            conn.execute(text(
                "ALTER TABLE purchase_orders ADD COLUMN vehicle_id INTEGER REFERENCES vehicles(id)"
            ))

def ensure_po_brand_status_table():
    """po_brand_statuses хүснэгт үүсгэж, одоо байгаа PO-уудад backfill хийнэ."""
    with engine.begin() as conn:
        # Table already created by Base.metadata.create_all, but backfill if empty
        try:
            count = conn.execute(text("SELECT COUNT(*) FROM po_brand_statuses")).scalar()
        except Exception:
            return  # Table doesn't exist yet, create_all will handle it
        if count > 0:
            return  # Already backfilled

        # Backfill: for each PO, find brands with order_qty > 0
        rows = conn.execute(text("""
            SELECT DISTINCT po.id as po_id, po.status, p.brand
            FROM purchase_orders po
            JOIN purchase_order_lines pl ON pl.purchase_order_id = po.id
            JOIN products p ON p.id = pl.product_id
            WHERE pl.order_qty_box > 0
              AND p.brand IS NOT NULL AND p.brand != '' AND LOWER(p.brand) != 'nan'
        """)).fetchall()
        for r in rows:
            try:
                conn.execute(text(
                    "INSERT OR IGNORE INTO po_brand_statuses (purchase_order_id, brand, status) VALUES (:po_id, :brand, :status)"
                ), {"po_id": r[0], "brand": r[2], "status": r[1]})
            except Exception:
                pass


def ensure_inventory_count_schema():
    with engine.begin() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(inventory_counts)")).fetchall()]
        if cols and "kpi_admin_task_id" not in cols:
            conn.execute(text(
                "ALTER TABLE inventory_counts ADD COLUMN kpi_admin_task_id INTEGER REFERENCES kpi_admin_daily_tasks(id)"
            ))
        # ── Checklist багануудыг нэмэв (Sync, бүрэн бус, №14 агуулах, өмнөх үлдэгдэл, улайлт/дарагдсан) ──
        for col in (
            "check_all_synced",
            "check_no_partial",
            "check_no_wh14_sales",
            "check_balance_unchanged",
            "check_red_blocked_fixed",
        ):
            if cols and col not in cols:
                conn.execute(text(
                    f"ALTER TABLE inventory_counts ADD COLUMN {col} BOOLEAN DEFAULT 0 NOT NULL"
                ))

def ensure_kpi_groups_schema():
    with engine.begin() as conn:
        # ── kpi_checklist_entries ────────────────────────────────────────────
        cols_e = [r[1] for r in conn.execute(text("PRAGMA table_info(kpi_checklist_entries)")).fetchall()]
        if cols_e and "approved_value" not in cols_e:
            conn.execute(text("ALTER TABLE kpi_checklist_entries ADD COLUMN approved_value FLOAT"))
        if cols_e and "task_category" not in cols_e:
            conn.execute(text("ALTER TABLE kpi_checklist_entries ADD COLUMN task_category VARCHAR(20) DEFAULT 'daily'"))

        # ── kpi_task_templates ───────────────────────────────────────────────
        cols_t = [r[1] for r in conn.execute(text("PRAGMA table_info(kpi_task_templates)")).fetchall()]
        if cols_t and "group_id" not in cols_t:
            conn.execute(text(
                "ALTER TABLE kpi_task_templates ADD COLUMN group_id INTEGER REFERENCES kpi_task_groups(id)"
            ))
        if cols_t and "period" not in cols_t:
            conn.execute(text("ALTER TABLE kpi_task_templates ADD COLUMN period VARCHAR(20) DEFAULT 'daily'"))
        for col, ddl in [
            ("day_of_week",   "INTEGER"),
            ("day_of_month",  "INTEGER"),
            ("weight_points", "FLOAT DEFAULT 0"),
            ("task_category", "VARCHAR(20) DEFAULT 'daily'"),
        ]:
            if cols_t and col not in cols_t:
                conn.execute(text(f"ALTER TABLE kpi_task_templates ADD COLUMN {col} {ddl}"))

        # ── kpi_admin_daily_tasks ────────────────────────────────────────────
        cols_a = [r[1] for r in conn.execute(text("PRAGMA table_info(kpi_admin_daily_tasks)")).fetchall()]
        if cols_a and "task_category" not in cols_a:
            conn.execute(text("ALTER TABLE kpi_admin_daily_tasks ADD COLUMN task_category VARCHAR(20) DEFAULT 'daily'"))

        # ── kpi_employee_plans (шинэ хүснэгт) ───────────────────────────────
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS kpi_employee_plans (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id     INTEGER NOT NULL REFERENCES users(id),
                year            INTEGER NOT NULL,
                month           INTEGER NOT NULL,
                daily_kpi_cap   FLOAT   NOT NULL DEFAULT 0,
                monthly_max_kpi FLOAT   NOT NULL DEFAULT 0,
                created_at      DATETIME,
                updated_at      DATETIME,
                UNIQUE(employee_id, year, month)
            )
        """))

        # ── kpi_daily_checklists — attendance талбарууд ──────────────────────
        cols_cl = [r[1] for r in conn.execute(text("PRAGMA table_info(kpi_daily_checklists)")).fetchall()]
        if cols_cl and "attendance_status" not in cols_cl:
            conn.execute(text("ALTER TABLE kpi_daily_checklists ADD COLUMN attendance_status VARCHAR(20) DEFAULT 'pending'"))
        if cols_cl and "attendance_note" not in cols_cl:
            conn.execute(text("ALTER TABLE kpi_daily_checklists ADD COLUMN attendance_note VARCHAR(500) DEFAULT ''"))
        if cols_cl and "attendance_approved_by" not in cols_cl:
            conn.execute(text("ALTER TABLE kpi_daily_checklists ADD COLUMN attendance_approved_by INTEGER REFERENCES users(id)"))
        if cols_cl and "attendance_approved_at" not in cols_cl:
            conn.execute(text("ALTER TABLE kpi_daily_checklists ADD COLUMN attendance_approved_at DATETIME"))

        # ── kpi_scheduled_days (шинэ хүснэгт) ───────────────────────────────
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS kpi_scheduled_days (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id INTEGER NOT NULL REFERENCES users(id),
                date        DATE    NOT NULL,
                created_by  INTEGER REFERENCES users(id),
                created_at  DATETIME,
                UNIQUE(employee_id, date)
            )
        """))

        # ── kpi_shift_transfers (шинэ хүснэгт) ──────────────────────────────
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS kpi_shift_transfers (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                date                    DATE    NOT NULL,
                original_employee_id    INTEGER NOT NULL REFERENCES users(id),
                replacement_employee_id INTEGER NOT NULL REFERENCES users(id),
                approver_id             INTEGER NOT NULL REFERENCES users(id),
                status                  VARCHAR(20) DEFAULT 'pending',
                note                    VARCHAR(500) DEFAULT '',
                response_note           VARCHAR(500) DEFAULT '',
                responded_at            DATETIME,
                created_at              DATETIME
            )
        """))

        # ── kpi_audit_logs (шинэ хүснэгт) ───────────────────────────────────
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS kpi_audit_logs (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                admin_id           INTEGER NOT NULL REFERENCES users(id),
                action             VARCHAR(50) NOT NULL,
                target_employee_id INTEGER NOT NULL REFERENCES users(id),
                target_date        DATE    NOT NULL,
                old_value          VARCHAR(200) DEFAULT '',
                new_value          VARCHAR(200) DEFAULT '',
                reason             VARCHAR(500) NOT NULL DEFAULT '',
                created_at         DATETIME
            )
        """))


# ── DB Backup ─────────────────────────────────────────────────────────────────
_DB_PATH    = Path(__file__).resolve().parent / "app.db"
_BACKUP_DIR = Path(__file__).resolve().parent / "data" / "backups"

def perform_db_backup() -> Path:
    """DB-г SQLite online backup API-аар хуулж хадгална.
    Зөвхөн нэг Lastest_YYYYMMDD_HHMM.db файл байна — хуучин нь устгагдана.
    """
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    # Өмнөх backup файлуудыг устга
    for old in _BACKUP_DIR.glob("Lastest_*.db"):
        try:
            old.unlink()
        except Exception:
            pass
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    target = _BACKUP_DIR / f"Lastest_{ts}.db"
    src = _sqlite3.connect(str(_DB_PATH))
    dst = _sqlite3.connect(str(target))
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()
    return target

async def _hourly_backup_loop():
    """Цаг тутам DB backup хийнэ."""
    while True:
        try:
            t = perform_db_backup()
            print(f"[backup] {t.name} амжилттай хадгалагдлаа")
        except Exception as e:
            print(f"[backup] Алдаа: {e}")
        await asyncio.sleep(3600)


def _auto_refresh_stock(db):
    """
    Server эхлэх үед хамгийн сүүлийн "Үлдэгдэл тайлан" файлаас
    Product.stock_qty автоматаар шинэчлэнэ.
    Хэрэв 100+ бараа аль хэдийн stock-тай бол шинэчилсэн гэж үзнэ.
    """
    from app.models.product import Product
    # 150101 гэх мэт нэг account code байсан ч бодит бараанууд 0 байж болно.
    # Тиймээс threshold-оор шалгана.
    stock_count = db.query(Product).filter(Product.stock_qty > 0).count()
    if stock_count >= 100:
        return

    balance_dir = Path("app/data/uploads/Үлдэгдэл тайлан")
    if not balance_dir.exists():
        return
    files = sorted(balance_dir.glob("*.xl*"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        return

    try:
        from app.services.refresh_stock_from_balance import refresh_stock_from_balance_report
        result = refresh_stock_from_balance_report(db, str(files[0]))
        print(f"[startup] Stock refresh from {files[0].name}: {result}")
    except Exception as e:
        print(f"[startup] Stock refresh failed: {e}")


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)
    ensure_extra_lines_brand()
    ensure_import_logs_schema()
    ensure_users_schema()
    ensure_products_schema()
    ensure_po_lines_schema()
    ensure_receiving_lines_schema()
    ensure_price_schema()
    ensure_brand_code_schema()
    ensure_order_lines_schema()
    ensure_kpi_admin_task_schema()
    ensure_kpi_groups_schema()
    ensure_po_vehicle_schema()
    ensure_po_archive_schema()
    ensure_inventory_count_schema()
    ensure_po_brand_status_table()
    ensure_shipment_lines_schema()
    ensure_min_stock_rules_schema()
    ensure_admin_task_target_schema()
    ensure_bank_account_configs_schema()
    ensure_bank_transactions_schema()
    ensure_roles_schema()
    ensure_roles_seeded()
    ensure_calendar_labels_seeded()
    db = SessionLocal()
    try:
        ensure_admin(db)
        _auto_refresh_stock(db)
    finally:
        db.close()


@app.on_event("startup")
async def schedule_hourly_backup():
    """Background backup loop — server эхлэхэд нэг удаа backup хийж, цаг тутам давтана."""
    asyncio.create_task(_hourly_backup_loop())


def ensure_calendar_labels_seeded():
    """Calendar label default-уудыг суулгана (зөвхөн хоосон үед).

    Хэрэв 'unloading' label нь хуучин 'Ачилт буух' нэртэй бол 'Бараа буух' болгож сольно.
    """
    from app.models.calendar_label import CalendarLabel
    db = SessionLocal()
    try:
        # Хуучин label нэрийг шинэчлэх
        old = db.query(CalendarLabel).filter(
            CalendarLabel.key == "unloading",
            CalendarLabel.label == "Ачилт буух",
        ).first()
        if old:
            old.label = "Бараа буух"
            old.short = "Бараа"
            db.commit()

        existing = db.query(CalendarLabel).count()
        if existing > 0:
            return
        defaults = [
            ("unloading", "Бараа буух",    "Бараа",    "orange",  "Truck",         1),
            ("order",     "Захиалга хийх", "Захиалга", "blue",    "ClipboardList", 2),
            ("inventory", "Тооллого хийх", "Тооллого", "violet",  "Package",       3),
            ("payment",   "Төлбөр хийх",   "Төлбөр",   "emerald", "Banknote",      4),
            ("report",    "Тайлан гаргах", "Тайлан",   "indigo",  "BarChart2",     5),
            ("meeting",   "Уулзалт",       "Уулзалт",  "pink",    "Users",         6),
            ("shipment",  "Ачаа явуулах",  "Ачаа",     "amber",   "Send",          7),
            ("other",     "Бусад",         "Бусад",    "gray",    "MoreHorizontal",8),
        ]
        for key, label, short, color, icon, order in defaults:
            db.add(CalendarLabel(
                key=key, label=label, short=short, color=color,
                icon=icon, sort_order=order, is_active=True,
            ))
        db.commit()
        print(f"[startup] Seeded {len(defaults)} calendar labels")
    except Exception as e:
        db.rollback()
        print(f"[startup] Calendar labels seed failed: {e}")
    finally:
        db.close()

app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(imports_router)
app.include_router(products_router)
app.include_router(orders_router)
app.include_router(reports_router)
app.include_router(accounts_receivable_router)
app.include_router(suppliers_router)
app.include_router(logistics_router)
app.include_router(purchase_orders_router)
app.include_router(calendar_router)
app.include_router(kpi_router)
app.include_router(new_product_router)
app.include_router(sales_report_router)
app.include_router(inventory_count_router)
app.include_router(receivings_router)
app.include_router(erkhet_auto_router)
app.include_router(bank_statements_router)

@app.get("/health")
def health():
    return {"ok": True}


# ── Real-time event stream (Server-Sent Events) ─────────────────────────────
# Frontend нь EventSource ашиглан subscribe хийж бусад device-ийн өөрчлөлтийг
# мэдрэх боломжтой. Мутаций хийдэг route нь `bus.publish("topic", payload)`
# дуудаж бүх listener-уудад push хийнэ.
from app.core.event_bus import event_stream
from fastapi.responses import StreamingResponse

@app.get("/events")
async def events(topics: str = "all"):
    """SSE stream. ?topics=receivings,bank_statements (comma-separated)."""
    topic_list = [t.strip() for t in (topics or "").split(",") if t.strip()] or ["all"]
    return StreamingResponse(
        event_stream(topic_list),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # disable nginx/proxy buffering
            "Connection": "keep-alive",
        },
    )

# ── PWA Root CA сертификат татах (HTTP:8000) ──────────────────────────────────
# Планшет дээр CA суулгахын тулд: http://192.168.1.198:8000/rootca.crt
_ROOT_CA = Path("app/data/rootCA.crt")

@app.get("/rootca.crt", include_in_schema=False)
def download_rootca():
    if not _ROOT_CA.exists():
        from fastapi import HTTPException
        raise HTTPException(404, "rootCA.crt олдсонгүй")
    return FileResponse(
        str(_ROOT_CA),
        media_type="application/x-x509-ca-cert",
        filename="rootCA.crt",
    )


# ── Production: serve built frontend (frontend/dist) on the same port ────────
# Энэ нь утас/алсын device-аас хандах үед хамгийн хурдан — нэг порт, минифи бундл,
# browser cache, CORS-гүй. Хэрэв `frontend/dist` байхгүй бол хэт алгасна (dev mode).
from fastapi.staticfiles import StaticFiles
_DIST_DIR = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _DIST_DIR.exists() and (_DIST_DIR / "index.html").exists():
    # /assets/* — hashed bundles (browser-cacheable)
    if (_DIST_DIR / "assets").exists():
        app.mount("/assets", StaticFiles(directory=str(_DIST_DIR / "assets")), name="assets")

    # SPA catch-all: any unmatched GET (e.g. /dashboard, /receivings/123) returns index.html
    # so React Router can take over client-side. This MUST come AFTER all API routers.
    @app.get("/{full_path:path}", include_in_schema=False)
    async def _spa_fallback(full_path: str):
        # Real file at root (favicon.ico, manifest.json, etc.)
        if full_path:
            candidate = _DIST_DIR / full_path
            try:
                if candidate.is_file() and candidate.resolve().is_relative_to(_DIST_DIR.resolve()):
                    return FileResponse(str(candidate))
            except Exception:
                pass
        # Anything else → index.html (SPA route)
        return FileResponse(str(_DIST_DIR / "index.html"))

    print(f"[startup] Serving frontend from: {_DIST_DIR}")
else:
    print(f"[startup] Frontend dist not found at {_DIST_DIR} — running API-only mode.")
