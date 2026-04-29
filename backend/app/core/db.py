from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DB_PATH = "sqlite:///./app/app.db"

engine = create_engine(
    DB_PATH,
    connect_args={"check_same_thread": False, "timeout": 30},
    pool_pre_ping=True,
)

# WAL mode — backup болон бусад reader-тай зэрэг write хийх боломжтой болно
@event.listens_for(engine, "connect")
def _set_wal_mode(dbapi_conn, _):
    dbapi_conn.execute("PRAGMA journal_mode=WAL")
    dbapi_conn.execute("PRAGMA busy_timeout=30000")

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class Base(DeclarativeBase):
    pass