"""Chrome extension (задлагдаагүй / unpacked) — админ folder-оор нь оруулна, хэрэглэгчид татаж
chrome://extensions → «Load unpacked»-аар суулгана. Файлууд app/data/extensions/<id>.zip-д (хавтгай —
manifest.json zip-ийн үндсэнд) хадгалагдана."""
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, Text

from app.core.db import Base


class ChromeExtension(Base):
    __tablename__ = "chrome_extensions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # manifest-ийн нэр (жижиг үсгээр) — ижил нэртэйг дахин оруулбал шинэ хувилбараар солигдоно
    key = Column(String(200), unique=True, index=True, nullable=False)
    name = Column(String(200), nullable=False)
    version = Column(String(50), default="")
    description = Column(Text, default="")
    manifest_version = Column(Integer, default=0)
    note = Column(Text, default="")                 # админы тайлбар (юунд хэрэглэх г.м.)
    folder_name = Column(String(200), default="")   # оруулсан folder-ийн нэр — татахад ийм нэртэй folder үүснэ
    file_count = Column(Integer, default=0)
    size_bytes = Column(Integer, default=0)
    icon_b64 = Column(Text, default="")             # data:image/...;base64,… (manifest icons-оос)
    stored_filename = Column(String(300), default="")
    uploaded_by = Column(String(100), default="")
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    download_count = Column(Integer, default=0)
