"""AI tool-уудад зориулсан ЗӨВХӨН УНШИХ SQLite холболт (mode=ro + query_only) — AI DB-д бичиж чадахгүй."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

DB_FILE = Path(__file__).resolve().parents[1] / "app.db"
_Session = None


def _make():
    eng = create_engine(f"sqlite:///file:{DB_FILE.as_posix()}?mode=ro&uri=true",
                        connect_args={"check_same_thread": False, "timeout": 30})

    @event.listens_for(eng, "connect")
    def _ro(conn, _):
        cur = conn.cursor()
        cur.execute("PRAGMA query_only=ON")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()
    return sessionmaker(bind=eng, autoflush=False, autocommit=False)


def session():
    global _Session
    if _Session is None:
        _Session = _make()
    return _Session()
