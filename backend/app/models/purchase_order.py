from sqlalchemy import Integer, String, Float, Date, DateTime, ForeignKey, UniqueConstraint, Column, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime, date as date_type
from app.core.db import Base


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_date: Mapped[date_type] = mapped_column(Date, index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="preparing", nullable=False)
    # Захиалгын байршил: "warehouse" (Агуулах) | "showroom" (Заал).
    # Нөөц баганыг аль үлдэгдлийн файлаас тооцохыг тодорхойлно.
    location: Mapped[str] = mapped_column(String(16), default="warehouse", nullable=False)
    # "Өмнөх оны энэ сард" баганад харьцуулах сар (1-12). NULL бол order_date-ийн сар.
    # Захиалга үүсгэхэд сонгоно (ирээдүйн төлөвлөж буй сарын өмнөх оны борлуулалтыг харах).
    # (vehicle_id-тэй адил Column хэлбэрээр — Mapped[int|None] нь Py3.14-д typing алдаа өгдөг)
    stat_month = Column(Integer, nullable=True)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    notes: Mapped[str] = mapped_column(String(1000), default="")
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    # Архив: жагсаалт дээр харагдахгүй, ачаалагдахгүй. Зөвхөн admin/manager-ын хүсэлтээр харагдана.
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)

    lines = relationship(
        "PurchaseOrderLine", back_populates="order", cascade="all, delete-orphan"
    )
    extra_lines = relationship(
        "OrderExtraLine", back_populates="order", cascade="all, delete-orphan"
    )


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_orders.id"), nullable=False
    )
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), nullable=False)
    order_qty_box: Mapped[float] = mapped_column(Float, default=0.0)
    order_qty_pcs: Mapped[float] = mapped_column(Float, default=0.0)
    computed_weight: Mapped[float] = mapped_column(Float, default=0.0)
    supplier_qty_box: Mapped[float] = mapped_column(Float, default=0.0)
    loaded_qty_box: Mapped[float] = mapped_column(Float, default=0.0)
    received_qty_box: Mapped[float] = mapped_column(Float, default=0.0)
    # Бүхэл хайрцгаас гадна үлдсэн задгай ширхэгийн тоо (жишээ: 4 хайрцаг + 2 ширхэг)
    received_qty_extra_pcs: Mapped[float] = mapped_column(Float, default=0.0)
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)
    line_remark: Mapped[str] = mapped_column(String(500), default="")
    # Онцгой тохиолдолд барааны бренд override хийх (жишээ нь W брендийн захиалгад Q брендийн А барааг нэмэх)
    override_brand: Mapped[str] = mapped_column(String(100), default="")

    order = relationship("PurchaseOrder", back_populates="lines")


class OrderExtraLine(Base):
    __tablename__ = "order_extra_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id"), nullable=False)
    brand: Mapped[str] = mapped_column(String(100), default="")
    name: Mapped[str] = mapped_column(String(200), default="")
    item_code: Mapped[str] = mapped_column(String(50), default="")
    warehouse_name: Mapped[str] = mapped_column(String(100), default="")
    unit_weight: Mapped[float] = mapped_column(Float, default=0.0)
    pack_ratio: Mapped[float] = mapped_column(Float, default=1.0)
    qty_box: Mapped[float] = mapped_column(Float, default=0.0)
    computed_weight: Mapped[float] = mapped_column(Float, default=0.0)

    order = relationship("PurchaseOrder", back_populates="extra_lines")


class PurchaseOrderBrandVehicle(Base):
    __tablename__ = "po_brand_vehicles"
    __table_args__ = (UniqueConstraint("purchase_order_id", "brand"),)

    id                = Column(Integer, primary_key=True, index=True)
    purchase_order_id = Column(Integer, ForeignKey("purchase_orders.id"), nullable=False)
    brand             = Column(String(100), nullable=False)
    vehicle_id        = Column(Integer, ForeignKey("vehicles.id"), nullable=True)


class PurchaseOrderBrandStatus(Base):
    """Бренд тус бүрийн тусдаа статус. PO.status = min(all brand statuses)."""
    __tablename__ = "po_brand_statuses"
    __table_args__ = (UniqueConstraint("purchase_order_id", "brand"),)

    id                = Column(Integer, primary_key=True, index=True)
    purchase_order_id = Column(Integer, ForeignKey("purchase_orders.id"), nullable=False)
    brand             = Column(String(100), nullable=False)
    status            = Column(String(20), default="preparing")


# ── Shipment (машинаар ачилт) ─────────────────────────────────────────────────

class POShipment(Base):
    """Нэг PO → олон ачилт (машин бүрт нэг). Тус бүр тусдаа status-тэй."""
    __tablename__ = "po_shipments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id"), nullable=False, index=True)
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="loading")
    notes: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    lines = relationship("POShipmentLine", back_populates="shipment", cascade="all, delete-orphan")


class POShipmentLine(Base):
    """Ачилтад ачигдсан бараа (PO line-ийн subset)."""
    __tablename__ = "po_shipment_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    shipment_id: Mapped[int] = mapped_column(ForeignKey("po_shipments.id"), nullable=False, index=True)
    po_line_id: Mapped[int] = mapped_column(ForeignKey("purchase_order_lines.id"), nullable=False, index=True)
    loaded_qty_box: Mapped[float] = mapped_column(Float, default=0.0)
    received_qty_box: Mapped[float] = mapped_column(Float, default=0.0)

    shipment = relationship("POShipment", back_populates="lines")


class POShipmentBrand(Base):
    """Брендийг машинд (ачилтад) ТӨЛӨВЛӨЖ хуваарилах — брендийн статусаас үл хамаарна.

    Бэлдэж/хянаж/илгээж байгаа брендийг ч машинд урьдчилан оноож дүүргэлтийг харна.
    Машины доор брендийн статусаар «Ачигдаагүй» (ачигдаж байна-аас өмнө) эсвэл
    «Ачигдсан» (ачигдаж байна ба түүнээс хойш) ангилалд харагдана. Бодит ачилт нь
    POShipmentLine хэвээр; нэг захиалгад нэг бренд нэг л машинд төлөвлөгдөнө.
    """
    __tablename__ = "po_shipment_brands"
    __table_args__ = (UniqueConstraint("purchase_order_id", "brand", name="uq_po_shipment_brand"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id"), nullable=False, index=True)
    shipment_id: Mapped[int] = mapped_column(ForeignKey("po_shipments.id"), nullable=False, index=True)
    brand: Mapped[str] = mapped_column(String(200), nullable=False)
    created_by: Mapped[str] = mapped_column(String(100), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ErkhetImportLog(Base):
    """Захиалгын ERP Excel-ийг Эрхэт рүү ШУУД импортолсон бүртгэл.

    Давхар орлого үүсэхээс сэргийлж (ижил захиалга+брендийг дахин импортлоход
    анхааруулна), илгээсэн файлыг ч хадгална (app/data/erkhet_imports/)."""
    __tablename__ = "erkhet_import_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)   # 0 = receivings
    receiving_session_id: Mapped[int] = mapped_column(Integer, index=True, default=0)     # Бараа тулгаж авах (нэгтгэсэн ERP)
    brand: Mapped[str] = mapped_column(String(200), default="")          # "" = бүх бренд
    qty_source: Mapped[str] = mapped_column(String(20), default="received")
    company: Mapped[str] = mapped_column(String(30), default="buten_orgil")
    title: Mapped[str] = mapped_column(String(255), default="")
    filename: Mapped[str] = mapped_column(String(255), default="")
    stored_path: Mapped[str] = mapped_column(String(500), default="")
    status: Mapped[str] = mapped_column(String(10), default="")          # ok | fail | queued | unknown
    queue_id: Mapped[int] = mapped_column(Integer, default=0)            # Эрхэтийн «Ажлын захиалга» (/queue/) мөр
    erkhet_import_id: Mapped[int] = mapped_column(Integer, default=0)
    erkhet_status: Mapped[str] = mapped_column(String(100), default="")
    doc_count: Mapped[int] = mapped_column(Integer, default=0)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str] = mapped_column(String(2000), default="")
    username: Mapped[str] = mapped_column(String(100), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
