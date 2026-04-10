from pydantic import BaseModel
from datetime import datetime

class ImportLogOut(BaseModel):
    id: int
    created_at: datetime
    import_key: str
    username: str
    filename: str
    status: str
    message: str
