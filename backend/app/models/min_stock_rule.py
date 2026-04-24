from sqlalchemy import Integer, String, Boolean, Float, DateTime, ForeignKey, Column
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime
from app.core.db import Base


class MinStockRule(Base):
    """
    Доод үлдэгдлийн дүрэм. Хоёр төрөл:
    1. Tag-based: (location_tags + price_tags) хосломол дээр min_qty_box тавина.
    2. Product-based: product_id заасан бол зөвхөн тухайн бараанд хамаарна (хамгийн specific).
    """
    __tablename__ = "min_stock_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    # Product-based rule: set бол tag-уудыг үл харгалзана
    product_id = Column(Integer, ForeignKey("products.id"), nullable=True, index=True)
    # CSV — product.warehouse_name бүх tag-ийг агуулсан байх ёстой (issubset match)
    location_tags: Mapped[str] = mapped_column(String(500), default="")
    # CSV — product.price_tag бүх tag-ийг агуулсан байх ёстой (issubset match)
    price_tags: Mapped[str] = mapped_column(String(500), default="")
    min_qty_box: Mapped[float] = mapped_column(Float, default=0.0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
