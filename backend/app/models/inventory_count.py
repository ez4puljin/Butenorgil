from sqlalchemy import Column, Integer, String, Date, DateTime, ForeignKey, Text, Boolean
from sqlalchemy.orm import relationship
from datetime import datetime

from app.core.db import Base


class InventoryCount(Base):
    __tablename__ = "inventory_counts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    warehouse_key = Column(String(50), nullable=False, index=True)
    count_date = Column(Date, nullable=False)
    description = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    created_by = Column(String(100), default="")
    kpi_admin_task_id = Column(
        Integer, ForeignKey("kpi_admin_daily_tasks.id"), nullable=True
    )

    # ── Тооллогын урьдчилсан шалгалт (checklist) ───────────────────
    # 1) Бүх гүйлгээ татагдсан буюу Sync хийгдсэн эсэх
    check_all_synced = Column(Boolean, default=False, nullable=False)
    # 2) Бүрэн бус баримт байхгүй байх
    check_no_partial = Column(Boolean, default=False, nullable=False)
    # 3) №14 агуулахаас борлуулалт гараагүй байх
    check_no_wh14_sales = Column(Boolean, default=False, nullable=False)
    # 4) Өмнөх тооллогоны үлдэгдэл дээр өөрчлөлт ороогүй байх
    check_balance_unchanged = Column(Boolean, default=False, nullable=False)

    files = relationship(
        "InventoryCountFile",
        back_populates="inventory_count",
        cascade="all, delete-orphan",
    )


class InventoryCountFile(Base):
    __tablename__ = "inventory_count_files"

    id = Column(Integer, primary_key=True, autoincrement=True)
    inventory_count_id = Column(
        Integer, ForeignKey("inventory_counts.id", ondelete="CASCADE"), nullable=False
    )
    file_type = Column(String(10), nullable=False)  # "txt" | "excel"
    original_filename = Column(String(300), default="")
    saved_path = Column(String(500), default="")
    uploaded_at = Column(DateTime, default=datetime.utcnow)

    inventory_count = relationship("InventoryCount", back_populates="files")
