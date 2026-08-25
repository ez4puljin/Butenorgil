from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_name: str = "ERP Merge & Order"
    jwt_secret: str = "CHANGE_ME_SECRET"
    jwt_alg: str = "HS256"
    access_token_minutes: int = 720  # 12 цаг
    cors_origins: list[str] = ["*"]
    gemini_api_key: str = ""   # env: GEMINI_API_KEY (aistudio.google.com-д үнэгүй авна)
    # AI чатын модел — function calling дэмждэг байх ёстой. env: GEMINI_CHAT_MODEL
    # Flash-Lite: хамгийн хямд ($0.30/$2.50 vs $0.75/$3.75) бөгөөд үнэгүй
    # багц дээр 15 RPM (3.x Flash-ийн 10-аас их). Чат нь хэрэглээ ихтэй тул энд.
    gemini_chat_model: str = "gemini-3.5-flash-lite"
    # Flash-Lite заримдаа tool дуудалгүй "алдаа гарлаа" гэж хариулдаг (хэмжилтээр
    # 1/3 л зөв). Tool дуудагдаагүй үед энэ илүү найдвартай модел дээр нэг удаа
    # давтана — ихэнх хүсэлт хямдаар, шаардлагатай үед найдвартайгаар ажиллана.
    # Хоосон болговол fallback хийхгүй. env: GEMINI_CHAT_FALLBACK_MODEL
    gemini_chat_fallback_model: str = "gemini-3.5-flash"
    # Зураг таних модел (Шинэ бараа цэс) — хэрэглээ бага, чанар чухал тул
    # илүү хүчтэй Flash. env: GEMINI_VISION_MODEL
    gemini_vision_model: str = "gemini-3.5-flash"

    # ── Эрхэт (erkhet.bto.mn) HTTP клиент ────────────────────────────────
    # Хоосон бол Эрхэтээс дата татах функцууд идэвхгүй.
    erkhet_url: str = "https://erkhet.bto.mn"   # env: ERKHET_URL
    erkhet_username: str = ""                    # env: ERKHET_USERNAME
    erkhet_password: str = ""                    # env: ERKHET_PASSWORD
    erkhet_company_id: str = ""                  # env: ERKHET_COMPANY_ID (нэвтрэхэд автомат олдоно)

    # ── Систем асалт мониторинг (heartbeat + Telegram мэдэгдэл) ──────────
    # heartbeat_url хоосон бол мониторинг идэвхгүй (юу ч илгээхгүй).
    heartbeat_url: str = ""            # env: HEARTBEAT_URL — Healthchecks.io ping URL
    heartbeat_interval_sec: int = 60   # env: HEARTBEAT_INTERVAL_SEC — heartbeat давтамж (сек)
    telegram_bot_token: str = ""       # env: TELEGRAM_BOT_TOKEN — BotFather-аас
    telegram_chat_id: str = ""         # env: TELEGRAM_CHAT_ID — групп/чат id

    class Config:
        env_file = ".env"

settings = Settings()