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
    # Шөнийн автомат sync ажиллах цаг (0-23). env: ERKHET_SYNC_HOUR
    erkhet_sync_hour: int = 3

    # ── erxes (POS) GraphQL ──────────────────────────────────────────────
    # Хоосон бол POS sync цэс идэвхгүй.
    erxes_url: str = "https://erxes.bto.mn/gateway"   # env: ERXES_URL
    erxes_email: str = ""                              # env: ERXES_EMAIL
    erxes_password: str = ""                           # env: ERXES_PASSWORD
    # Өчигдрийн бүх POS гүйлгээг автоматаар татах цаг. env: POS_SYNC_HOUR
    pos_sync_hour: int = 4
    # ── Локал (offline) POS-уудын GraphQL хаяг, таслалаар тусгаарлана ────
    # Касс эхлээд ЛОКАЛ POS-д бичигдээд дараа нь erxes рүү sync хийгддэг.
    # Энэ шатанд гацсан захиалгыг erxes талаас олж харах БОЛОМЖГҮЙ тул
    # локал POS бүрээс шууд тоо аваад тулгана. env: POS_LOCAL_URLS
    pos_local_urls: str = ("http://192.168.1.254:4030,"
                           "http://192.168.1.254:4031")
    # ── Үнийн шошго (erxes document template) ────────────────────────────
    # Шошгон дээрх бөөний ширхэг/үнэ нь erxes дотор бодогддог тул шошгыг
    # erxes-ийн бэлэн загвараас татна. Утгууд нь худалдагчийн ашигладаг
    # хэвлэх URL-ээс авсан. env: ERXES_LABEL_*
    erxes_label_template_id: str = "63e0d1c289900a8db3052d6b"
    erxes_label_branch_id: str = "EfehYyZsLHGuHMT8n"
    erxes_label_department_id: str = "gaSBcgxE9qFiKKs9g"
    erxes_label_width: int = 80          # мм — чек принтерийн өргөн

    # Тулгалт ажиллах цаг. POS ТАТСАНЫ ДАРАА байх ёстой — эс тэгвээс дөнгөж
    # татсан гүйлгээг "Эрхэт рүү ороогүй" гэж буруу тэмдэглэнэ.
    # env: POS_RECON_HOUR
    pos_recon_hour: int = 5

    # ── Өглөөний тайлан ──────────────────────────────────────────────────
    # Бүх анхаарах зүйлийг Telegram-аар илгээх цаг. env: DIGEST_HOUR
    digest_hour: int = 8

    # ── Систем асалт мониторинг (heartbeat + Telegram мэдэгдэл) ──────────
    # heartbeat_url хоосон бол мониторинг идэвхгүй (юу ч илгээхгүй).
    heartbeat_url: str = ""            # env: HEARTBEAT_URL — Healthchecks.io ping URL
    heartbeat_interval_sec: int = 60   # env: HEARTBEAT_INTERVAL_SEC — heartbeat давтамж (сек)
    telegram_bot_token: str = ""       # env: TELEGRAM_BOT_TOKEN — BotFather-аас
    telegram_chat_id: str = ""         # env: TELEGRAM_CHAT_ID — групп/чат id

    class Config:
        env_file = ".env"

settings = Settings()