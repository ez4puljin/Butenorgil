from pydantic import BaseModel

class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    base_role: str = ""
    username: str
    nickname: str = ""
    permissions: list[str] = []
    tag_ids: list[int]
    user_id: int = 0