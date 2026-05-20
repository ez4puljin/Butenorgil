"""
Бичиг баримт API — Зөвхөн админ эрхтэй ажилтан ашиглана.

Endpoints:
  GET    /documents/groups                   — бүлгүүдийн жагсаалт + файлын тоо
  POST   /documents/groups                   — шинэ бүлэг үүсгэх
  PATCH  /documents/groups/{id}              — бүлгийн нэр засах
  DELETE /documents/groups/{id}              — бүлэг устгах (зөвхөн файлгүй)

  GET    /documents/groups/{id}/files        — бүлэг доторх файлуудын жагсаалт
  POST   /documents/groups/{id}/files        — файл upload (multipart/form-data)
  GET    /documents/files/{id}/download      — файл татаж авах
  DELETE /documents/files/{id}               — файл устгах (audit-д бичигдэнэ)
"""
import os
import uuid
import shutil
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from datetime import datetime
from typing import Optional
from pydantic import BaseModel

from app.api.deps import get_db, require_role
from app.models.document import DocumentGroup, DocumentFile
from app.models.user import User
from app.core.audit import audit

router = APIRouter(prefix="/documents", tags=["documents"])


# Файл хадгалах хавтас (main.py-аас үүсгэгдэх ёстой)
DOCS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "uploaded_documents",
)


# ── Schemas ─────────────────────────────────────────────────────────────

class GroupIn(BaseModel):
    name: str
    sort_order: Optional[int] = 0


class GroupRenameIn(BaseModel):
    name: str


# ── Helpers ─────────────────────────────────────────────────────────────

def _username(db: Session, uid: Optional[int]) -> str:
    if not uid:
        return ""
    u = db.query(User).filter(User.id == uid).first()
    return u.nickname.strip() if (u and u.nickname and u.nickname.strip()) else (u.username if u else "")


def _ser_group(g: DocumentGroup, db: Session) -> dict:
    file_count = db.query(DocumentFile).filter(DocumentFile.group_id == g.id).count()
    return {
        "id": g.id,
        "name": g.name,
        "sort_order": g.sort_order or 0,
        "file_count": file_count,
        "created_at": g.created_at.isoformat() if g.created_at else None,
        "created_by_username": _username(db, g.created_by_id),
    }


def _ser_file(f: DocumentFile, db: Session) -> dict:
    return {
        "id": f.id,
        "group_id": f.group_id,
        "display_name": f.display_name,
        "original_filename": f.original_filename,
        "mime_type": f.mime_type or "",
        "file_size": int(f.file_size or 0),
        "uploaded_at": f.uploaded_at.isoformat() if f.uploaded_at else None,
        "uploaded_by_username": _username(db, f.uploaded_by_id),
    }


def _group_dir(group_id: int) -> str:
    """Бүлгийн файлуудыг хадгалах хавтас."""
    d = os.path.join(DOCS_DIR, str(group_id))
    os.makedirs(d, exist_ok=True)
    return d


# ── Group endpoints ─────────────────────────────────────────────────────

@router.get("/groups")
def list_groups(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    rows = db.query(DocumentGroup).order_by(DocumentGroup.sort_order.asc(), DocumentGroup.id.asc()).all()
    return [_ser_group(g, db) for g in rows]


@router.post("/groups")
def create_group(
    body: GroupIn,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Бүлгийн нэр оруулна уу")
    g = DocumentGroup(
        name=name,
        sort_order=int(body.sort_order or 0),
        created_at=datetime.utcnow(),
        created_by_id=u.id,
    )
    db.add(g)
    db.commit()
    db.refresh(g)
    return _ser_group(g, db)


@router.patch("/groups/{group_id}")
def rename_group(
    group_id: int,
    body: GroupRenameIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    g = db.query(DocumentGroup).filter(DocumentGroup.id == group_id).first()
    if not g:
        raise HTTPException(404, "Бүлэг олдсонгүй")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Бүлгийн нэр хоосон байж болохгүй")
    g.name = name
    db.commit()
    db.refresh(g)
    return _ser_group(g, db)


@router.delete("/groups/{group_id}")
def delete_group(
    group_id: int,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    g = db.query(DocumentGroup).filter(DocumentGroup.id == group_id).first()
    if not g:
        raise HTTPException(404, "Бүлэг олдсонгүй")
    file_count = db.query(DocumentFile).filter(DocumentFile.group_id == group_id).count()
    if file_count > 0:
        raise HTTPException(
            400,
            f"'{g.name}' бүлэгт {file_count} файл байна. Эхлээд файлуудыг устгана уу.",
        )
    # Audit
    audit(db, request, u,
          action="document_group_delete",
          entity_type="document_group",
          entity_id=g.id,
          before={"name": g.name, "sort_order": g.sort_order or 0})
    # Хоосон хавтсыг ч устгах (clean)
    try:
        d = os.path.join(DOCS_DIR, str(group_id))
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass
    db.delete(g)
    db.commit()
    return {"ok": True}


# ── File endpoints ──────────────────────────────────────────────────────

@router.get("/groups/{group_id}/files")
def list_files(
    group_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    g = db.query(DocumentGroup).filter(DocumentGroup.id == group_id).first()
    if not g:
        raise HTTPException(404, "Бүлэг олдсонгүй")
    rows = (
        db.query(DocumentFile)
        .filter(DocumentFile.group_id == group_id)
        .order_by(DocumentFile.uploaded_at.desc(), DocumentFile.id.desc())
        .all()
    )
    return [_ser_file(f, db) for f in rows]


@router.post("/groups/{group_id}/files")
async def upload_file(
    group_id: int,
    request: Request,
    display_name: str = Form(""),
    upload: UploadFile = File(...),
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    g = db.query(DocumentGroup).filter(DocumentGroup.id == group_id).first()
    if not g:
        raise HTTPException(404, "Бүлэг олдсонгүй")

    original_filename = upload.filename or "untitled"
    name = (display_name or "").strip() or original_filename

    # Диск дээр хадгалах нэр (UUID prefix-тэй)
    ext = ""
    try:
        ext = os.path.splitext(original_filename)[1] or ""
    except Exception:
        pass
    stored_filename = f"{uuid.uuid4().hex}{ext}"
    target_dir = _group_dir(group_id)
    target_path = os.path.join(target_dir, stored_filename)

    # Stream хадгалах
    size = 0
    try:
        with open(target_path, "wb") as out:
            while True:
                chunk = await upload.read(64 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                size += len(chunk)
    except Exception as e:
        # cleanup
        try: os.remove(target_path)
        except Exception: pass
        raise HTTPException(500, f"Файл хадгалахад алдаа: {e}")
    finally:
        try: await upload.close()
        except Exception: pass

    if size <= 0:
        try: os.remove(target_path)
        except Exception: pass
        raise HTTPException(400, "Файл хоосон байна")

    f = DocumentFile(
        group_id=group_id,
        display_name=name[:255],
        stored_filename=stored_filename,
        original_filename=original_filename[:255],
        mime_type=(upload.content_type or "")[:120],
        file_size=size,
        uploaded_at=datetime.utcnow(),
        uploaded_by_id=u.id,
    )
    db.add(f)
    db.commit()
    db.refresh(f)
    return _ser_file(f, db)


@router.get("/files/{file_id}/download")
def download_file(
    file_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    f = db.query(DocumentFile).filter(DocumentFile.id == file_id).first()
    if not f:
        raise HTTPException(404, "Файл олдсонгүй")
    path = os.path.join(_group_dir(f.group_id), f.stored_filename)
    if not os.path.isfile(path):
        raise HTTPException(404, "Дискэн дээр файл байхгүй")
    return FileResponse(
        path,
        media_type=f.mime_type or "application/octet-stream",
        filename=f.original_filename or f.display_name or "download",
    )


@router.delete("/files/{file_id}")
def delete_file(
    file_id: int,
    request: Request,
    db: Session = Depends(get_db),
    u: User = Depends(require_role("admin")),
):
    f = db.query(DocumentFile).filter(DocumentFile.id == file_id).first()
    if not f:
        raise HTTPException(404, "Файл олдсонгүй")
    g = db.query(DocumentGroup).filter(DocumentGroup.id == f.group_id).first()

    # Audit log entry (Үйлдлийн бүртгэлд)
    audit(db, request, u,
          action="document_file_delete",
          entity_type="document_file",
          entity_id=f.id,
          parent_type="document_group",
          parent_id=f.group_id,
          before={
              "display_name": f.display_name,
              "original_filename": f.original_filename,
              "mime_type": f.mime_type or "",
              "file_size": int(f.file_size or 0),
              "group_name": g.name if g else "",
              "uploaded_at": f.uploaded_at.isoformat() if f.uploaded_at else None,
              "uploaded_by_id": f.uploaded_by_id,
              "uploaded_by_username": _username(db, f.uploaded_by_id),
          })

    # Disk-ээс устгах
    try:
        path = os.path.join(_group_dir(f.group_id), f.stored_filename)
        if os.path.isfile(path):
            os.remove(path)
    except Exception:
        pass  # DB row-ыг хамгийн чухал

    db.delete(f)
    db.commit()
    return {"ok": True}
