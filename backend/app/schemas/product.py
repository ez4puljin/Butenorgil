from pydantic import BaseModel

class ProductOut(BaseModel):
    id: int
    item_code: str
    name: str
    brand: str
    unit_weight: float
    stock_qty: float
    sales_qty: float
    warehouse_tag_id: int
    pack_ratio: float