from pydantic import BaseModel

class OrderLineIn(BaseModel):
    product_id: int
    order_qty_box: float


class OrderCreateIn(BaseModel):
    warehouse_tag_id: int
    brand: str


class OrderSubmitIn(BaseModel):
    order_id: int


class SupervisorOverrideIn(BaseModel):
    overrides: dict[str, float]  # brand -> final_weight
