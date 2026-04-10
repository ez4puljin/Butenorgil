from fastapi import APIRouter, Depends, HTTPException
from pathlib import Path
from pydantic import BaseModel
from typing import List, Optional
import pandas as pd
import math
import json
import urllib.request
import base64

from app.api.deps import require_role

router = APIRouter(prefix="/accounts-receivable", tags=["accounts-receivable"])

AR_DIR          = Path("app/data/uploads/Авлага өглөгө тайлан")
CI_DIR          = Path("app/data/uploads/Харилцагчдын мэдээлэл")
SMS_CONFIG_FILE = Path("app/data/sms_config.json")
SMS_SENT_FILE   = Path("app/data/sms_sent.json")


def _latest(directory: Path):
    if not directory.exists():
        return None
    files = sorted(directory.glob("*.xl*"), key=lambda f: f.stat().st_mtime, reverse=True)
    return files[0] if files else None


def _clean(val):
    if val is None:
        return None
    if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
        return None
    return val


def _skip_to_data(df: pd.DataFrame) -> pd.DataFrame:
    """
    Scan from the top; once we find a row whose col-0 cell contains 'код'
    (case-insensitive), treat that row as the header and return everything after it.
    If no such row is found within the first 20 rows, fall back to dropping
    fully-empty rows and returning as-is.
    """
    for i in range(min(20, len(df))):
        cell = str(df.iloc[i, 0]).strip().lower()
        if "код" in cell:
            result = df.iloc[i + 1:].reset_index(drop=True)
            return result
    mask = df.iloc[:, 0].notna()
    return df[mask].reset_index(drop=True)


# ── SMS sent helpers ─────────────────────────────────────────────────────────

def _load_sms_sent() -> list[str]:
    if SMS_SENT_FILE.exists():
        try:
            return json.loads(SMS_SENT_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []

def _save_sms_sent(codes: list[str]):
    SMS_SENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    SMS_SENT_FILE.write_text(json.dumps(codes, ensure_ascii=False), encoding="utf-8")


# ── SMS models ────────────────────────────────────────────────────────────────

class SmsConfigBody(BaseModel):
    gateway_url: str
    username: str
    password: str


class SmsRecipient(BaseModel):
    phone: str
    name: Optional[str] = None
    code: Optional[str] = None
    balance: Optional[float] = None


class SmsSendRequest(BaseModel):
    recipients: List[SmsRecipient]
    message_template: str
    config: SmsConfigBody


# ── SMS sent endpoints ────────────────────────────────────────────────────────

class SmsMarkRequest(BaseModel):
    codes: List[str]

@router.get("/sms-sent")
def get_sms_sent(_=Depends(require_role("admin", "supervisor", "manager"))):
    return {"codes": _load_sms_sent()}

@router.post("/sms-sent")
def mark_sms_sent(
    body: SmsMarkRequest,
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    existing = set(_load_sms_sent())
    existing.update(body.codes)
    _save_sms_sent(list(existing))
    return {"ok": True, "total": len(existing)}

@router.delete("/sms-sent")
def clear_sms_sent(_=Depends(require_role("admin", "supervisor", "manager"))):
    _save_sms_sent([])
    return {"ok": True}


# ── SMS config endpoints ──────────────────────────────────────────────────────

@router.get("/sms-config")
def get_sms_config(_=Depends(require_role("admin", "supervisor", "manager"))):
    if SMS_CONFIG_FILE.exists():
        try:
            return json.loads(SMS_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"gateway_url": "", "username": "", "password": ""}


@router.put("/sms-config")
def save_sms_config(
    body: SmsConfigBody,
    _=Depends(require_role("admin")),
):
    SMS_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    SMS_CONFIG_FILE.write_text(
        json.dumps(
            {"gateway_url": body.gateway_url, "username": body.username, "password": body.password},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return {"ok": True}


@router.post("/send-sms")
def send_sms(
    body: SmsSendRequest,
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    if not body.recipients:
        raise HTTPException(400, "Хүлээн авагч заагаагүй байна.")
    if not body.config.gateway_url.strip():
        raise HTTPException(400, "SMS Gateway URL тохируулаагүй байна. Тохиргоог хийнэ үү.")

    results = []
    for r in body.recipients:
        # Format balance for template substitution
        if r.balance is not None:
            bal_str = f"{int(r.balance):,}" if r.balance == int(r.balance) else f"{r.balance:,.2f}"
        else:
            bal_str = ""

        msg = body.message_template
        msg = msg.replace("{Харилцагч_нэр}", r.name or "")
        msg = msg.replace("{нэр}",           r.name or "")
        msg = msg.replace("{код}",           r.code or "")
        msg = msg.replace("{Эцсийн_үлдэгдэл}", bal_str)
        try:
            url = f"{body.config.gateway_url.rstrip('/')}/message"
            payload = json.dumps({
                "textMessage": {"text": msg},
                "phoneNumbers": [r.phone],
            }).encode("utf-8")
            creds = base64.b64encode(
                f"{body.config.username}:{body.config.password}".encode()
            ).decode()
            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Basic {creds}",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                results.append({"phone": r.phone, "name": r.name, "ok": True, "status": resp.status})
        except Exception as e:
            results.append({"phone": r.phone, "name": r.name, "ok": False, "error": str(e)})

    success = sum(1 for x in results if x["ok"])
    return {"results": results, "success": success, "total": len(results)}


# ── AR Dashboard stats endpoint ───────────────────────────────────────────────

@router.get("/dashboard-stats")
def ar_dashboard_stats(_=Depends(require_role("admin", "supervisor", "accountant"))):
    """Lightweight summary for the main Dashboard page."""
    ar_file = _latest(AR_DIR)
    ci_file = _latest(CI_DIR)

    if not ar_file or not ci_file:
        return {
            "available": False,
            "ar_file": ar_file.name if ar_file else None,
            "ci_file": ci_file.name if ci_file else None,
        }

    try:
        # AR: code col 0, balance col 6
        ar_raw = pd.read_excel(ar_file, header=None, dtype=str)
        ar_raw = _skip_to_data(ar_raw)
        ar_raw = ar_raw.dropna(subset=[ar_raw.columns[0]])

        ar = pd.DataFrame()
        ar["код"]      = ar_raw.iloc[:, 0].astype(str).str.strip()
        ar["үлдэгдэл"] = pd.to_numeric(ar_raw.iloc[:, 6], errors="coerce") if ar_raw.shape[1] > 6 else None
        ar = ar[ar["код"].str.len() > 0]

        # CI: code col 0, phone col 6
        ci_raw = pd.read_excel(ci_file, header=None, dtype=str)
        ci_raw = _skip_to_data(ci_raw)
        ci_raw = ci_raw.dropna(subset=[ci_raw.columns[0]])

        ci = pd.DataFrame()
        ci["код"]  = ci_raw.iloc[:, 0].astype(str).str.strip()
        ci["утас"] = ci_raw.iloc[:, 6].astype(str).str.strip() if ci_raw.shape[1] > 6 else ""

        # inner join: only real customers (codes present in CI) are kept.
        # Account/ledger codes (e.g. 120101) exist only in AR and are excluded.
        merged_df = ar.merge(ci, on="код", how="inner")
        merged_df = merged_df[merged_df["код"].str.len() > 0]

        receivable = float(merged_df.loc[merged_df["үлдэгдэл"] > 0, "үлдэгдэл"].sum())
        payable    = float(merged_df.loc[merged_df["үлдэгдэл"] < 0, "үлдэгдэл"].sum())

        has_phone = (
            merged_df["утас"].notna()
            & (merged_df["утас"] != "")
            & (merged_df["утас"] != "nan")
        )

        return {
            "available":  True,
            "ar_file":    ar_file.name,
            "ci_file":    ci_file.name,
            "total":      len(merged_df),
            "receivable": receivable,
            "payable":    payable,
            "with_phone": int(has_phone.sum()),
            "sms_sent":   len(_load_sms_sent()),
        }

    except Exception as e:
        return {"available": False, "error": str(e)}


# ── Merged data endpoint ──────────────────────────────────────────────────────

@router.get("/merged")
def merged(
    _=Depends(require_role("admin", "supervisor", "manager")),
):
    ar_file = _latest(AR_DIR)
    ci_file = _latest(CI_DIR)

    missing = []
    if not ar_file:
        missing.append("Авлага өглөгө тайлан")
    if not ci_file:
        missing.append("Харилцагчдын мэдээлэл")
    if missing:
        raise HTTPException(
            404,
            f"Дараах файлууд байхгүй байна: {', '.join(missing)}. Эхлээд импорт хийнэ үү.",
        )

    try:
        # --- Авлага өглөгө тайлан: A=code(0), B=name(1), G=balance(6) ---
        ar_raw = pd.read_excel(ar_file, header=None, dtype=str)
        ar_raw = _skip_to_data(ar_raw)
        ar_raw = ar_raw.dropna(subset=[ar_raw.columns[0]])

        ar = pd.DataFrame()
        ar["код"]      = ar_raw.iloc[:, 0].astype(str).str.strip()
        ar["нэр"]      = ar_raw.iloc[:, 1].astype(str).str.strip() if ar_raw.shape[1] > 1 else ""
        ar["үлдэгдэл"] = pd.to_numeric(ar_raw.iloc[:, 6], errors="coerce") if ar_raw.shape[1] > 6 else None

        # --- Харилцагчдын мэдээлэл: A=code(0), G=phone(6) ---
        ci_raw = pd.read_excel(ci_file, header=None, dtype=str)
        ci_raw = _skip_to_data(ci_raw)
        ci_raw = ci_raw.dropna(subset=[ci_raw.columns[0]])

        ci = pd.DataFrame()
        ci["код"]  = ci_raw.iloc[:, 0].astype(str).str.strip()
        ci["утас"] = ci_raw.iloc[:, 6].astype(str).str.strip() if ci_raw.shape[1] > 6 else ""

        # Inner join: only customer codes that exist in CI are kept.
        # Account/ledger codes (e.g. 120101) are in AR but not CI, so excluded.
        merged_df = ar.merge(ci, on="код", how="inner")
        merged_df = merged_df[merged_df["код"].str.len() > 0]

        rows = []
        for _, row in merged_df.iterrows():
            bal   = _clean(row.get("үлдэгдэл"))
            phone = _clean(row.get("утас"))
            rows.append({
                "code":    row["код"],
                "name":    row["нэр"] if row["нэр"] not in ("nan", "") else None,
                "phone":   str(phone).strip() if phone not in (None, "nan", "") else None,
                "balance": float(bal) if bal is not None else None,
            })

        return {
            "rows":    rows,
            "ar_file": ar_file.name,
            "ci_file": ci_file.name,
            "count":   len(rows),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Мэдээлэл нэгтгэхэд алдаа гарлаа: {e}")
