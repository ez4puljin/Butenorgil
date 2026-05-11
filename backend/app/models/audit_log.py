"""
AuditLog — destructive үйлдлийг бүртгэх ерөнхий хэрэгсэл.

Үндсэн зорилго: хэн (user_id + username + ip), хэзээ, ямар record-ыг,
ямар утгаас ямар утга руу өөрчилсөн бэ — гэдгийг тогтооход.

Урьд бичигдсэн өгөгдөл устсан тохиолдолд хариуцлагатай хүнийг тогтоох,
эсхүл шинжилгээ хийх боломжтой болгоно.
"""
from sqlalchemy import Integer, String, DateTime, Text, Index
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime
from app.core.db import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )

    # WHO
    user_id: Mapped[int] = mapped_column(Integer, default=0, index=True)
    username: Mapped[str] = mapped_column(String(80), default="", index=True)
    role: Mapped[str] = mapped_column(String(40), default="")
    ip_address: Mapped[str] = mapped_column(String(64), default="")

    # WHAT
    action: Mapped[str] = mapped_column(
        String(60), default="", index=True
    )  # e.g. "po_set_lines", "po_delete", "receiving_unmatch_brand"
    entity_type: Mapped[str] = mapped_column(
        String(60), default=""
    )  # e.g. "purchase_order_line", "receiving_session"
    entity_id: Mapped[int] = mapped_column(Integer, default=0, index=True)

    # CONTEXT — relate to parent (e.g. PO #46 -> entity_id is line id, parent_id is PO id)
    parent_type: Mapped[str] = mapped_column(String(60), default="")
    parent_id: Mapped[int] = mapped_column(Integer, default=0, index=True)

    # VALUES — store JSON-encoded snapshots
    before_value: Mapped[str] = mapped_column(Text, default="")
    after_value: Mapped[str] = mapped_column(Text, default="")
    extra: Mapped[str] = mapped_column(Text, default="")  # хүсвэл нэмэлт мэдээлэл

    __table_args__ = (
        Index("ix_audit_logs_parent", "parent_type", "parent_id"),
        Index("ix_audit_logs_action_created", "action", "created_at"),
    )
