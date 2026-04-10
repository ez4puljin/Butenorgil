from sqlalchemy import String, Integer, Float
from sqlalchemy.orm import Mapped, mapped_column
from app.core.db import Base

class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_code: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    brand: Mapped[str] = mapped_column(String(100), index=True, default="")
    unit_weight: Mapped[float] = mapped_column(Float, default=0.0)

    stock_qty: Mapped[float] = mapped_column(Float, default=0.0)
    sales_qty: Mapped[float] = mapped_column(Float, default=0.0)

    warehouse_tag_id: Mapped[int] = mapped_column(Integer, index=True, default=0)
    warehouse_name: Mapped[str] = mapped_column(String(200), default="")
    pack_ratio: Mapped[float] = mapped_column(Float, default=1.0)  # pcs per box
    last_purchase_price: Mapped[float] = mapped_column(Float, default=0.0)
    brand_code: Mapped[str] = mapped_column(String(50), default="")