from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DB_PATH = "sqlite:///./app/app.db"

engine = create_engine(
    DB_PATH,
    connect_args={"check_same_thread": False, "timeout": 30},
    pool_pre_ping=True,
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