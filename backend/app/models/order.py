from sqlalchemy import Integer, String, Float, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime
from app.core.db import Base

class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft|submitted|finalized
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    warehouse_tag_id: Mapped[int] = mapped_column(Integer, index=True)
    brand: Mapped[str] = mapped_column(String(100), index=True, default="")

    lines = relationship("OrderLine", cascade="all, delete-orphan", back_populates="order")

class OrderLine(Base):
    __tablename__ = "order_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)

    order_qty_box: Mapped[float] = mapped_column(Float, default=0.0)
    order_qty_pcs: Mapped[float] = mapped_column(Float, default=0.0)
    computed_weight: Mapped[float] = mapped_column(Float, default=0.0)
    # Захиалга үүсгэх үеийн нөөц (Үлдэгдлийн тайланаас)
    stock_qty_snapshot: Mapped[float] = mapped_column(Float, default=0.0)

    order = relationship("Order", back_populates="lines")

class BrandWeightOverride(Base):
    __tablename__ = "brand_weight_overrides"
    __table_args__ = (UniqueConstraint("order_id", "brand", name="uq_order_brand"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    brand: Mapped[str] = mapped_column(String(100), index=True)
    final_weight: Mapped[float] = mapped_column(Float, default=0.0)