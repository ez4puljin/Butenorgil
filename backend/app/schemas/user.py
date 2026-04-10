from pydantic import BaseModel

class UserCreate(BaseModel):
    username: str
    password: str
    nickname: str = ""
    phone: str = ""
    role: str = "manager"
    tag_ids: list[int] = []

class UserOut(BaseModel):
    id: int
    username: str
    nickname: str = ""
    phone: str
    role: str
    is_active: bool
    tag_ids: list[int]
