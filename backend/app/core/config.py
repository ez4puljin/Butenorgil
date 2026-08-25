from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_name: str = "ERP Merge & Order"
    jwt_secret: str = "CHANGE_ME_SECRET"
    jwt_alg: str = "HS256"
    access_token_minutes: int = 720  # 12 цаг
    cors_origins: list[str] = ["*"]
    gemini_api_key: str = ""   # env: GEMINI_API_KEY (aistudio.google.com-д үнэгүй авна)
    # AI чатын модел — function calling дэмждэг байх ёстой. env: GEMINI_CHAT_MODEL
    gemini_chat_model: str = "gemini-3.6-flash"

    # ── Систем асалт мониторинг (heartbeat + Telegram мэдэгдэл) ──────────
    # heartbeat_url хоосон бол мониторинг идэвхгүй (юу ч илгээхгүй).
    heartbeat_url: str = ""            # env: HEARTBEAT_URL — Healthchecks.io ping URL
    heartbeat_interval_sec: int = 60   # env: HEARTBEAT_INTERVAL_SEC — heartbeat давтамж (сек)
    telegram_bot_token: str = ""       # env: TELEGRAM_BOT_TOKEN — BotFather-аас
    telegram_chat_id: str = ""         # env: TELEGRAM_CHAT_ID — групп/чат id

    class Config:
        env_file = ".env"

settings = Settings()