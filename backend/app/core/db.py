from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DB_PATH = "sqlite:///./app/app.db"

engine = create_engine(
    DB_PATH,
    connect_args={"check_same_thread": False, "timeout": 30},
    pool_pre_ping=True,
    # Олон хэрэглэгч (7+ утас) зэрэг ажиллахад pool дутагдаж хүсэлтүүд
    # хоорондоо хүлээлцэн "гацдаг" байсан — default нь 5+10=15 байсан.
    # SQLite файлын холболт хөнгөн тул өндөр тавьж болно (WAL тул аюулгүй).
    pool_size=30,
    max_overflow=70,
    pool_timeout=30,
)

# WAL mode — backup болон бусад reader-тай зэрэг write хийх боломжтой болно.
# Олон хэрэглэгч (утас) WiFi-аар зэрэг ажиллахад зориулсан тааруулга:
#   • journal_mode=WAL   — reader-ууд writer-ийг блоклохгүй (зэрэг унших+бичих)
#   • busy_timeout=30s   — lock чөлөөлөгдөхийг хүлээнэ ("database is locked" шидэхгүй)
#   • synchronous=NORMAL — WAL дээр аюулгүй; fsync дуудлага цөөрч бичилт хурдасна
#                          (LAN орчинд тохиромжтой, өгөгдөл алдагдахгүй)
@event.listens_for(engine, "connect")
def _set_wal_mode(dbapi_conn, _):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA busy_timeout=30000")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class Base(DeclarativeBase):
    pass