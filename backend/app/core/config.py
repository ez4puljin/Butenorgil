from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_name: str = "ERP Merge & Order"
    jwt_secret: str = "CHANGE_ME_SECRET"
    jwt_alg: str = "HS256"
    access_token_minutes: int = 720  # 12 цаг
    cors_origins: list[str] = ["*"]
    gemini_api_key: str = ""   # env: GEMINI_API_KEY (aistudio.google.com-д үнэгүй авна)

    class Config:
        env_file = ".env"

settings = Settings()