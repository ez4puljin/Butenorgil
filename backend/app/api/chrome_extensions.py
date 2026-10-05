"""Chrome extension түгээх — админ задлагдаагүй (unpacked) extension-ий folder-ыг оруулна, нэвтэрсэн
хэрэглэгч бүр татаж chrome://extensions → Developer mode → «Load unpacked»-аар суулгана.

  GET    /extensions/list            — жагсаалт (бүх хэрэглэгч). Bare /extensions нь frontend-ийн хуудас (SPA)
  POST   /extensions/upload          — folder upload (админ): multipart `files` + `paths` (webkitRelativePath)
  GET    /extensions/{id}/download   — хавтгай zip (manifest.json үндсэнд) → задлахад шууд ачаалах folder
  GET    /extensions/{id}/files      — файлууд base64-өөр — Chrome-ийн «Folder болгож хадгалах» (File System Access)
  PATCH  /extensions/{id}            — админы тайлбар засах
  DELETE /extensions/{id}            — устгах (админ)

manifest.json-ийн нэрээр давхардлыг шалгана — ижил нэртэйг дахин оруулбал шинэ хувилбараар солигдоно.
"""
from __future__ import annotations

import base64
import io
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, require_role
from app.core.audit import audit
from app.models.chrome_extension import ChromeExtension

router = APIRouter(prefix="/extensions", tags=["chrome-extensions"])

STORE_DIR = Path("app/data/extensions")
MAX_FILES = 3000
MAX_TOTAL = 80 * 1024 * 1024            # proxy (100 МБ)-д багтана
MAX_ICON = 300 * 1024
_JUNK = {".git", ".svn", ".hg", "__macosx", ".ds_store", "thumbs.db", "desktop.ini"}
_IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
             ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon"}


class NoteIn(BaseModel):
    note: str = ""


def _parts(raw: str) -> list[str] | None:
    """webkitRelativePath → хэсгүүд. Аюултай (.., C:, хяналтын тэмдэгт) бол None."""
    parts = [p for p in (raw or "").replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." or ":" in p or any(ord(ch) < 32 for ch in p) for p in parts):
        return None
    return parts


def _is_junk(parts: list[str]) -> bool:
    return any(p.lower() in _JUNK for p in parts) or parts[-1].startswith("._")


def _resolve_msg(value, manifest: dict, files: dict[str, bytes]) -> str:
    """«__MSG_appName__» → _locales/<default_locale>/messages.json-ээс."""
    s = str(value or "").strip()
    m = re.fullmatch(r"__MSG_(\w+)__", s)
    if not m:
        return s
    raw = files.get(f"_locales/{manifest.get('default_locale') or 'en'}/messages.json")
    try:
        msgs = {k.lower(): v for k, v in json.loads(raw.decode("utf-8-sig")).items()}
        return str((msgs.get(m.group(1).lower()) or {}).get("message") or s)
    except Exception:
        return s


def _icon(manifest: dict, files: dict[str, bytes]) -> str:
    """icons (≤128 хамгийн том) → action.default_icon → data URL."""
    cands = []
    for src in (manifest.get("icons"), (manifest.get("action") or {}).get("default_icon"),
                (manifest.get("browser_action") or {}).get("default_icon")):
        if isinstance(src, dict):
            cands += [(int(k), v) for k, v in src.items() if str(k).isdigit() and isinstance(v, str)]
        elif isinstance(src, str):
            cands.append((0, src))
        if cands:
            break
    cands.sort(key=lambda kv: (kv[0] > 128, -kv[0] if kv[0] <= 128 else kv[0]))
    for _size, path in cands:
        data = files.get("/".join(_parts(path) or []))
        mime = _IMG_MIME.get(Path(path).suffix.lower())
        if data and mime and len(data) <= MAX_ICON:
            return f"data:{mime};base64,{base64.b64encode(data).decode()}"
    return ""


def _ver(v: str) -> tuple:
    """«1.10.2» → (1, 10, 2) — Chrome-ийн хувилбарын дугаарыг харьцуулахад."""
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.\-]", v or ""))


def _out(e: ChromeExtension) -> dict:
    return {
        "id": e.id, "name": e.name, "version": e.version, "description": e.description or "",
        "manifest_version": e.manifest_version or 0, "note": e.note or "", "folder_name": e.folder_name,
        "file_count": e.file_count, "size_bytes": e.size_bytes, "icon": e.icon_b64 or None,
        "uploaded_by": e.uploaded_by, "uploaded_at": e.uploaded_at.isoformat() if e.uploaded_at else None,
        "download_count": e.download_count or 0,
    }


def _get(db: Session, ext_id: int) -> tuple[ChromeExtension, Path]:
    e = db.query(ChromeExtension).filter(ChromeExtension.id == ext_id).first()
    if not e:
        raise HTTPException(404, "Extension олдсонгүй")
    p = STORE_DIR / (e.stored_filename or "")
    if not e.stored_filename or not p.exists():
        raise HTTPException(404, "Extension-ий файл дискнээс олдсонгүй — дахин оруулна уу")
    return e, p


@router.get("/list")
def list_extensions(db: Session = Depends(get_db), _=Depends(get_current_user)):
    return [_out(e) for e in db.query(ChromeExtension).order_by(ChromeExtension.name).all()]


@router.post("/upload")
async def upload_extension(request: Request, db: Session = Depends(get_db), u=Depends(require_role("admin"))):
    """Folder upload: `files` (олон) + `paths` (файл бүрийн webkitRelativePath, ижил дарааллаар) + `note`.
    manifest.json-ий хамгийн дээд байрлалыг extension-ий үндэс гэж үзнэ (эцэг folder сонгосон ч болно)."""
    form = await request.form(max_files=MAX_FILES, max_fields=MAX_FILES + 20)
    uploads = form.getlist("files")
    paths = [str(p) for p in form.getlist("paths")]
    note = str(form.get("note") or "").strip()[:2000]
    if not uploads:
        raise HTTPException(400, "Файл ирсэнгүй — extension-ий folder-ыг сонгоно уу")
    if len(uploads) != len(paths):
        raise HTTPException(400, "Файл ба замын тоо таарахгүй байна")

    entries: list[tuple[list[str], object]] = []
    skipped = 0
    for up, raw in zip(uploads, paths):
        parts = _parts(raw)
        if parts is None:
            raise HTTPException(400, f"Буруу файлын зам: {raw!r}")
        if _is_junk(parts):
            skipped += 1
            continue
        entries.append((parts, up))
    manifests = [parts for parts, _ in entries if parts[-1].lower() == "manifest.json"]
    if not manifests:
        raise HTTPException(400, "manifest.json олдсонгүй — Chrome extension-ий үндсэн folder-ыг "
                                 "(manifest.json байгаа) сонгоно уу. Build хийдэг бол dist folder-ыг сонгоно.")
    root = min(manifests, key=len)[:-1]

    files: dict[str, bytes] = {}
    outside = total = 0
    for parts, up in entries:
        if parts[:len(root)] != root or len(parts) == len(root):
            outside += 1
            continue
        data = await up.read()
        total += len(data)
        if total > MAX_TOTAL:
            raise HTTPException(413, f"Extension хэт том (>{MAX_TOTAL // 1024 // 1024} МБ) — build хийсэн folder-оо сонгоно уу")
        files["/".join(parts[len(root):])] = data

    try:
        manifest = json.loads(files["manifest.json"].decode("utf-8-sig"))
        assert isinstance(manifest, dict)
    except Exception:
        raise HTTPException(400, "manifest.json-ийг уншиж чадсангүй (JSON алдаатай)")
    name = _resolve_msg(manifest.get("name"), manifest, files)[:200]
    version = str(manifest.get("version") or "").strip()[:50]
    if not name or not version:
        raise HTTPException(400, "manifest.json-д name, version заавал байх ёстой")
    mv = manifest.get("manifest_version")
    warnings = []
    if mv != 3:
        warnings.append(f"Manifest V{mv or '?'} — Chrome-ийн шинэ хувилбарууд зөвхөн Manifest V3 extension ачаална.")
    if outside:
        warnings.append(f"manifest.json-ий folder-оос гадуурх {outside} файлыг оруулаагүй.")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel in sorted(files):
            z.writestr(rel, files[rel])

    key = name.strip().lower()
    e = db.query(ChromeExtension).filter(ChromeExtension.key == key).first()
    prev_version = e.version if e else None
    if prev_version and _ver(version) < _ver(prev_version):
        warnings.append(f"Өмнөх хувилбар {prev_version}, шинэ нь {version} — бага хувилбараар солигдлоо.")
    elif prev_version == version:
        warnings.append(f"Хувилбар өөрчлөгдөөгүй ({version}) — хэрэглэгчид Chrome-доо ↻ Reload дарж шинэчилнэ.")
    if not e:
        e = ChromeExtension(key=key, name=name)
        db.add(e)
        db.flush()
    e.name, e.version = name, version
    e.description = _resolve_msg(manifest.get("description"), manifest, files)[:2000]
    e.manifest_version = mv if isinstance(mv, int) else 0
    if note:
        e.note = note
    e.folder_name = (root[-1] if root else re.sub(r"[^\w.-]+", "-", name).strip("-") or "extension")[:200]
    e.file_count, e.size_bytes = len(files), total
    e.icon_b64 = _icon(manifest, files)
    e.stored_filename = f"{e.id}.zip"
    e.uploaded_by = getattr(u, "username", "") or ""
    e.uploaded_at = datetime.utcnow()
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STORE_DIR / f"{e.id}.zip.tmp"
    tmp.write_bytes(buf.getvalue())
    tmp.replace(STORE_DIR / e.stored_filename)
    audit(db, request, u, action="chrome_extension_upload", entity_type="chrome_extension", entity_id=e.id,
          extra={"name": name, "version": version, "previous_version": prev_version, "files": len(files),
                 "size_bytes": total, "skipped": skipped, "outside": outside})
    db.commit()
    return {"ok": True, "replaced": prev_version is not None, "previous_version": prev_version,
            "warnings": warnings, "skipped": skipped, "extension": _out(e)}


@router.get("/{ext_id}/download")
def download_extension(ext_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Хавтгай zip — задлахад «<folder>-<version>» folder дотор manifest.json шууд байна."""
    e, p = _get(db, ext_id)
    e.download_count = (e.download_count or 0) + 1
    db.commit()
    fname = f"{e.folder_name}-{e.version}.zip"
    ascii_name = re.sub(r"[^\w.-]+", "_", fname.encode("ascii", "ignore").decode()) or f"extension-{e.id}.zip"
    return Response(content=p.read_bytes(), media_type="application/zip", headers={
        "Content-Disposition": f"attachment; filename={ascii_name}; filename*=UTF-8''{quote(fname)}"})


@router.get("/{ext_id}/files")
def extension_files(ext_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Chrome-ийн «Folder болгож хадгалах» (showDirectoryPicker) — файл бүр base64-өөр."""
    e, p = _get(db, ext_id)
    out = []
    with zipfile.ZipFile(p) as z:
        for info in z.infolist():
            parts = _parts(info.filename)
            if info.is_dir() or parts is None:
                continue
            out.append({"path": "/".join(parts), "data": base64.b64encode(z.read(info)).decode()})
    e.download_count = (e.download_count or 0) + 1
    db.commit()
    return {"folder": e.folder_name, "name": e.name, "version": e.version, "files": out}


@router.patch("/{ext_id}")
def update_extension_note(ext_id: int, body: NoteIn, db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    e = db.query(ChromeExtension).filter(ChromeExtension.id == ext_id).first()
    if not e:
        raise HTTPException(404, "Extension олдсонгүй")
    e.note = (body.note or "").strip()[:2000]
    db.commit()
    return _out(e)


@router.delete("/{ext_id}")
def delete_extension(ext_id: int, request: Request, db: Session = Depends(get_db), u=Depends(require_role("admin"))):
    e = db.query(ChromeExtension).filter(ChromeExtension.id == ext_id).first()
    if not e:
        raise HTTPException(404, "Extension олдсонгүй")
    if e.stored_filename:
        (STORE_DIR / e.stored_filename).unlink(missing_ok=True)
    audit(db, request, u, action="chrome_extension_delete", entity_type="chrome_extension", entity_id=e.id,
          extra={"name": e.name, "version": e.version})
    db.delete(e)
    db.commit()
    return {"ok": True}
