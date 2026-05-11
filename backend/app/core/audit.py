"""
Audit log helper — destructive endpoint-уудаас дуудах нэгдсэн API.

Хэрэглээ:
    from app.core.audit import audit
    audit(db, request, u,
          action="po_set_lines_apply",
          entity_type="purchase_order_line",
          entity_id=line.id,
          parent_type="purchase_order",
          parent_id=po.id,
          before={"order_qty_box": old_qty},
          after={"order_qty_box": new_qty})
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog


def _client_ip(request: Optional[Any]) -> str:
    """FastAPI Request объект эсвэл None-аас client IP-г аюулгүй гаргана."""
    if request is None:
        return ""
    try:
        # FastAPI Request.client.host
        client = getattr(request, "client", None)
        if client is not None:
            host = getattr(client, "host", None)
            if host:
                return str(host)
        # X-Forwarded-For (reverse proxy-аар орохэд)
        headers = getattr(request, "headers", None)
        if headers:
            xff = headers.get("x-forwarded-for") or headers.get("X-Forwarded-For")
            if xff:
                return str(xff).split(",")[0].strip()
    except Exception:
        pass
    return ""


def _safe_json(value: Any) -> str:
    """Object-ыг JSON болгож хадгална. Хэлбэрт орохгүй эд зүйлсийг repr-аар."""
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        try:
            return json.dumps(repr(value), ensure_ascii=False)
        except Exception:
            return ""


def audit(
    db: Session,
    request: Optional[Any],
    user: Optional[Any],
    *,
    action: str,
    entity_type: str = "",
    entity_id: int = 0,
    parent_type: str = "",
    parent_id: int = 0,
    before: Any = None,
    after: Any = None,
    extra: Any = None,
    autocommit: bool = False,
) -> None:
    """
    Audit log нэмнэ. Аль ч endpoint-аас аюулгүйгээр дуудаж болно — exception
    нь burunh request-д нөлөөлөхгүй (catch хийсэн).

    autocommit=True үед өөрөө commit хийнэ. Үгүй бол гадаад transaction-д наална.
    """
    try:
        uid = 0
        uname = ""
        urole = ""
        if user is not None:
            uid = int(getattr(user, "id", 0) or 0)
            uname = str(getattr(user, "username", "") or "")
            urole = str(getattr(user, "role", "") or "")
        row = AuditLog(
            created_at=datetime.utcnow(),
            user_id=uid,
            username=uname,
            role=urole,
            ip_address=_client_ip(request),
            action=action[:60],
            entity_type=(entity_type or "")[:60],
            entity_id=int(entity_id or 0),
            parent_type=(parent_type or "")[:60],
            parent_id=int(parent_id or 0),
            before_value=_safe_json(before) if before is not None else "",
            after_value=_safe_json(after) if after is not None else "",
            extra=_safe_json(extra) if extra is not None else "",
        )
        db.add(row)
        if autocommit:
            db.commit()
    except Exception as e:
        # Audit нь үндсэн логикийг таслахгүй
        try:
            print(f"[audit] алдаа: {type(e).__name__}: {e}")
        except Exception:
            pass


def audit_many(
    db: Session,
    request: Optional[Any],
    user: Optional[Any],
    entries: list[dict],
    *,
    autocommit: bool = False,
) -> None:
    """Олон бүртгэлийг нэг дор оруулна (set-lines зэрэгт ашиглана)."""
    for e in entries:
        audit(db, request, user, autocommit=False, **e)
    if autocommit:
        try:
            db.commit()
        except Exception:
            pass
