from sqlalchemy import Integer, String, DateTime, Column, Float
from datetime import datetime
from app.core.db import Base


class SalesImportLog(Base):
    __tablename__ = "sales_import_logs"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    region     = Column(String(30), nullable=False)   # zuun_bus | baruun_bus | oronnnutag
    year       = Column(Integer, nullable=False)
    month      = Column(Integer, nullable=False)
    filename   = Column(String(300), default="")
    filepath   = Column(String(500), default="")
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    uploaded_by = Column(String(100), default="")
    status     = Column(String(10), default="ok")     # ok | error
    message    = Column(String(500), default="")


class SalesCacheRow(Base):
    __tablename__ = "sales_cache_rows"

    id             = Column(Integer, primary_key=True, autoincrement=True)
    region         = Column(String(30),  nullable=False, index=True)
    year           = Column(Integer,     nullable=False, index=True)
    month          = Column(Integer,     nullable=False, index=True)
    customer_code  = Column(String(20),  default="")
    customer_name  = Column(String(255), default="")
    warehouse_code = Column(String(10),  default="")
    warehouse_name = Column(String(255), default="")
    item_code      = Column(String(64),  default="", index=True)
    item_name      = Column(String(255), default="")
    qty            = Column(Float,       default=0.0)
    unit_price     = Column(Float,       default=0.0)
    total_amount   = Column(Float,       default=0.0)
    brand          = Column(String(100), default="", index=True)
    brand_code     = Column(String(50),  default="")
    import_log_id  = Column(Integer,     default=0, index=True)
    parsed_at      = Column(DateTime,    default=datetime.utcnow)
