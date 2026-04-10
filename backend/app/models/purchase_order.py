from sqlalchemy import Integer, String, Float, Date, DateTime, ForeignKey, UniqueConstraint, Column
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime, date as date_type
from app.core.db import Base


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_date: Mapped[date_type] = mapped_column(Date, index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="preparing", nullable=False)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    notes: Mapped[str] = mapped_column(String(1000), default="")
    vehicle_id = Column(Integer, ForeignKey("vehicles.id"), nullable=True)

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
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)
    line_remark: Mapped[str] = mapped_column(String(500), default="")

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
