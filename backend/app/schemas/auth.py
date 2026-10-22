from pydantic import BaseModel

class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    role_label: str = ""
    base_role: str = ""
    username: str
    nickname: str = ""
    permissions: list[str] = []
    universal_pages: list[str] = []
    mobile_pages: list[str] | None = None   # APK-д л: None = вэбтэй ижил
    tag_ids: list[int]
    user_id: int = 0