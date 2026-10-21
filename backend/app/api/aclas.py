"""Aclas жин — админ тохиргоо ба агентын API (app/services/aclas_sync).

Админ (зөвхөн admin):
  GET  /aclas/overview            — тохиргоо, жингүүд, агентын төлөв, сүүлийн даалгаврууд
  GET  /aclas/segments            — erxes барааны segment-үүд
  PUT  /aclas/settings            — segment_ids, interval_min, auto_enabled, dry_run, label_id, …
  POST /aclas/scales | PUT /aclas/scales/{id} | DELETE /aclas/scales/{id}
  GET  /aclas/scales/{id}/preview — dry-run: erxes ↔ жин (юу өөрчлөгдөх), жин рүү юу ч илгээхгүй
  POST /aclas/scales/{id}/sync    — «Одоо sync хийх» (dry_run үед 400)
  POST /aclas/scales/{id}/ping | /backup
  POST /aclas/backups/{id}/restore
  GET  /aclas/jobs                — түүх
  POST /aclas/agent-token         — шинэ агентын token (нэг удаа харагдана)
Агент (X-Agent-Token):
  GET  /aclas/agent/poll · POST /aclas/agent/jobs/{id}/current · POST /aclas/agent/jobs/{id}/finish
"""
from __future__ import annotations

import ipaddress
import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_role
from app.core.audit import audit
from app.models.aclas import AclasBackup, AclasJob, AclasScale
from app.models.user import User
from app.services import aclas_sync as svc

router = APIRouter(prefix="/aclas", tags=["aclas"])
ADMIN = require_role("admin")


def _scale_out(s: AclasScale) -> dict:
    return {"id": s.id, "name": s.name, "branch": s.branch, "ip": s.ip, "label_index": s.label_index,
            "enabled": s.enabled, "plu_count": len(svc.parse_plu(s.state_raw)[1]) if s.state_raw else None,
            "state_at": s.state_at.isoformat() if s.state_at else None,
            "managed": len(json.loads(s.managed_ids or "[]")), "stale": json.loads(s.stale_ids or "[]"),
            "last_ping_at": s.last_ping_at.isoformat() if s.last_ping_at else None, "last_ping_ok": s.last_ping_ok,
            "last_sync_at": s.last_sync_at.isoformat() if s.last_sync_at else None}


def _job_out(j: AclasJob, full: bool = False) -> dict:
    plan = json.loads(j.plan or "{}")
    res = json.loads(j.result or "{}")
    out = {"id": j.id, "scale_id": j.scale_id, "kind": j.kind, "status": j.status, "error": j.error,
           "attempts": j.attempts, "created_by": j.created_by,
           "created_at": j.created_at.isoformat() if j.created_at else None,
           "finished_at": j.finished_at.isoformat() if j.finished_at else None,
           "summary": plan.get("summary") or res.get("summary"),
           # Зөвхөн sync-д баталгаажуулалт бий — бусад даалгаварт None (UI «—» харуулна)
           "verify": ({k: v for k, v in res["verify"].items() if k != "mismatch"}
                      | {"mismatch_n": len(res["verify"].get("mismatch") or [])}) if res.get("verify") else None,
           "no_change": res.get("no_change", False)}
    if full:
        out["plan"] = {k: v for k, v in plan.items() if k != "upload_b64"}
        out["result"] = {k: v for k, v in res.items() if k != "preview_b64"}
        out["preview_b64"] = res.get("preview_b64", "")
    return out


@router.get("/overview")
def overview(db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    seen = svc._kv(db, "agent_last_seen", "")
    jobs = db.query(AclasJob).order_by(AclasJob.id.desc()).limit(50).all()
    backups = db.query(AclasBackup).order_by(AclasBackup.id.desc()).limit(20).all()
    return {
        "settings": svc.get_settings(db),
        "scales": [_scale_out(s) for s in db.query(AclasScale).order_by(AclasScale.id)],
        "agent": {"last_seen": seen or None, "has_token": bool(svc._kv(db, "agent_token_hash", "")),
                  "online": bool(seen) and datetime.fromisoformat(seen) > datetime.utcnow() - timedelta(minutes=2)},
        "jobs": [_job_out(j) for j in jobs],
        "backups": [{"id": b.id, "scale_id": b.scale_id, "reason": b.reason, "plu_count": b.plu_count,
                     "has_label": bool(b.label_format), "created_at": b.created_at.isoformat()} for b in backups],
        "last_tick_at": svc._kv(db, "last_tick_at", "") or None,
    }


@router.get("/segments")
def segments(u: User = Depends(ADMIN)):
    try:
        return svc.fetch_segments()
    except Exception as e:
        raise HTTPException(502, f"erxes: {e}")


class SettingsIn(BaseModel):
    segment_ids: list[str] | None = None
    interval_min: int | None = None
    auto_enabled: bool | None = None
    dry_run: bool | None = None
    label_id: int | None = None
    default_valid_days: int | None = None
    name_max: int | None = None
    price_pos_url: str | None = None
    replace_all: bool | None = None


@router.put("/settings")
def put_settings(body: SettingsIn, request: Request, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    if "interval_min" in data and not 5 <= data["interval_min"] <= 1440:
        raise HTTPException(400, "Хуваарь 5–1440 минут.")
    if "name_max" in data and not 8 <= data["name_max"] <= 40:
        raise HTTPException(400, "Нэрийн урт 8–40.")
    out = svc.save_settings(db, data, u.username)
    audit(db, request, u, action="aclas_settings", entity_type="aclas", extra=data, autocommit=True)
    return out


class ScaleIn(BaseModel):
    name: str
    branch: str = ""
    ip: str
    label_index: int = 0
    enabled: bool = True


def _check_scale(b: ScaleIn):
    try:
        ipaddress.IPv4Address(b.ip.strip())
    except ValueError:
        raise HTTPException(400, "IP хаяг буруу.")
    if not 0 <= b.label_index <= 7:
        raise HTTPException(400, "Шошгоны дугаар 0–7.")


@router.post("/scales")
def add_scale(b: ScaleIn, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    _check_scale(b)
    s = AclasScale(name=b.name.strip()[:120], branch=b.branch.strip()[:120], ip=b.ip.strip(), label_index=b.label_index,
                   enabled=b.enabled)
    db.add(s)
    db.commit()
    return _scale_out(s)


@router.put("/scales/{sid}")
def edit_scale(sid: int, b: ScaleIn, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    _check_scale(b)
    s = _scale(db, sid)
    if s.ip != b.ip.strip():                      # өөр жин — мэдэгдэж буй төлөв хүчингүй
        s.state_raw, s.state_at, s.managed_ids, s.stale_ids = None, None, "[]", "[]"
    s.name, s.branch, s.ip, s.label_index, s.enabled = b.name.strip()[:120], b.branch.strip()[:120], b.ip.strip(), b.label_index, b.enabled
    db.commit()
    return _scale_out(s)


@router.delete("/scales/{sid}")
def del_scale(sid: int, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    s = db.get(AclasScale, sid)
    if s:
        db.delete(s)
        db.commit()
    return {"ok": True}


def _scale(db, sid) -> AclasScale:
    s = db.get(AclasScale, sid)
    if not s:
        raise HTTPException(404, "Жин олдсонгүй.")
    return s


@router.get("/scales/{sid}/preview")
def preview(sid: int, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    s = _scale(db, sid)
    st = svc.get_settings(db)
    if not st["segment_ids"]:
        raise HTTPException(400, "Segment сонгоогүй байна.")
    try:
        plan = svc.make_plan(db, s, st)
    except Exception as e:
        raise HTTPException(502, f"erxes-ээс бараа татаж чадсангүй: {e}")
    plan.pop("upload", None)
    return plan


@router.post("/scales/{sid}/sync")
def sync_now(sid: int, request: Request, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    s = _scale(db, sid)
    st = svc.get_settings(db)
    if st["dry_run"]:
        raise HTTPException(400, "Dry-run горим идэвхтэй — жин рүү илгээхгүй. Тохиргооноос унтраана уу.")
    if not st["segment_ids"]:
        raise HTTPException(400, "Segment сонгоогүй байна.")
    j, created = svc.enqueue(db, s, "sync", by=u.username)
    audit(db, request, u, action="aclas_sync", entity_type="aclas", extra={"scale": s.name, "job": j.id}, autocommit=True)
    return {"job_id": j.id, "created": created}


@router.post("/scales/{sid}/ping")
def ping(sid: int, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    j, _ = svc.enqueue(db, _scale(db, sid), "ping", by=u.username)
    return {"job_id": j.id}


@router.post("/scales/{sid}/backup")
def backup(sid: int, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    j, _ = svc.enqueue(db, _scale(db, sid), "backup", by=u.username)
    return {"job_id": j.id}


@router.get("/backups/{bid}/plu")
def backup_plu(bid: int, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    b = db.get(AclasBackup, bid)
    if not b:
        raise HTTPException(404, "Олдсонгүй.")
    return {"rows": [svc.row_view(r) for r in svc.parse_plu(b.plu_raw)[1]] if b.plu_raw else []}


@router.post("/backups/{bid}/restore")
def restore(bid: int, request: Request, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    b = db.get(AclasBackup, bid)
    if not b or not b.plu_raw:
        raise HTTPException(404, "PLU нөөц олдсонгүй.")
    s = _scale(db, b.scale_id)
    payload = {"plu_b64": svc.b64(b.plu_raw)}
    if b.label_format and b.label_map:
        payload.update(label_index=b.label_index or 0, format_b64=svc.b64(b.label_format), map_b64=svc.b64(b.label_map))
    j, _ = svc.enqueue(db, s, "restore", payload, by=u.username)
    audit(db, request, u, action="aclas_restore", entity_type="aclas", extra={"backup": bid, "job": j.id}, autocommit=True)
    return {"job_id": j.id}


@router.get("/jobs")
def jobs(limit: int = 100, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    return [_job_out(j) for j in db.query(AclasJob).order_by(AclasJob.id.desc()).limit(min(limit, 500))]


@router.get("/jobs/{jid}")
def job(jid: int, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    j = db.get(AclasJob, jid)
    if not j:
        raise HTTPException(404, "Олдсонгүй.")
    return _job_out(j, full=True)


@router.post("/agent-token")
def agent_token(request: Request, db: Session = Depends(get_db), u: User = Depends(ADMIN)):
    tok = svc.new_agent_token(db, u.username)
    audit(db, request, u, action="aclas_agent_token", entity_type="aclas", extra={}, autocommit=True)
    return {"token": tok}


# ── Агент ────────────────────────────────────────────────────────────────────

def _agent(db: Session = Depends(get_db), x_agent_token: str = Header("")) -> Session:
    if not svc.check_agent_token(db, x_agent_token):
        raise HTTPException(401, "Агентын token буруу.")
    return db


@router.get("/agent/poll")
def agent_poll(db: Session = Depends(_agent)):
    return {"job": svc.poll(db), "poll": 15}


def _running_job(db, jid) -> AclasJob:
    j = db.get(AclasJob, jid)
    if not j or j.status != "running":
        raise HTTPException(409, "Даалгавар идэвхгүй.")
    return j


class CurrentIn(BaseModel):
    plu_b64: str


@router.post("/agent/jobs/{jid}/current")
def agent_current(jid: int, b: CurrentIn, db: Session = Depends(_agent)):
    j = _running_job(db, jid)
    if j.kind != "sync":
        raise HTTPException(400, "Зөвхөн sync.")
    try:
        return svc.agent_current(db, j, svc.unb64(b.plu_b64))
    except Exception as e:
        svc._fail(db, j, f"Сервер: {e}")
        return {"abort": str(e)[:300]}


@router.post("/agent/jobs/{jid}/finish")
async def agent_finish(jid: int, request: Request, db: Session = Depends(_agent)):
    body = json.loads(await request.body() or b"{}")
    return svc.agent_finish(db, _running_job(db, jid), body)
