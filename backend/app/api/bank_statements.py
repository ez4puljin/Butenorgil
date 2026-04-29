"""
Тооцоо хаах — Хаанбанкны хуулга Excel файлаар импортлох,
гүйлгээ бүрт харилцагч/данс/тайлбар оруулах API.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from typing import Optional
from pydantic import BaseModel
from datetime import datetime
import pandas as pd
import io
import re

from app.api.deps import get_db, get_current_user
from app.models.bank_statement import BankStatement, BankTransaction
from app.models.user import User

router = APIRouter(prefix="/bank-statements", tags=["bank-statements"])

# ── Helpers ───────────────────────────────────────────────────────────────────

_FEE_KEYWORDS = ["хураамж", "commission", "fee", "үйлчилгээний төлбөр"]


def _is_fee(desc: str) -> bool:
    d = (desc or "").lower()
    return any(k in d for k in _FEE_KEYWORDS)


def _parse_excel(content: bytes, filename: str) -> dict:
    """Хаанбанкны Excel хуулгыг задлан dict буцаана."""
    account_number, currency = "", "MNT"
    m = re.search(r"Statement_([A-Z]+)_(\d+)", filename)
    if m:
        currency = m.group(1)
        account_number = m.group(2)

    # Raw read — meta row (0), header row (1)
    raw = pd.read_excel(io.BytesIO(content), header=None, sheet_name=0)

    date_from = date_to = None
    try:
        date_str = str(raw.iloc[0, 2]) if raw.shape[1] > 2 else ""
        parts = re.findall(r"\d{4}[/\-]\d{2}[/\-]\d{2}", date_str)
        fmt = "%Y/%m/%d" if "/" in (parts[0] if parts else "") else "%Y-%m-%d"
        if len(parts) >= 2:
            date_from = datetime.strptime(parts[0], fmt).date()
            date_to = datetime.strptime(parts[1], fmt).date()
        elif len(parts) == 1:
            date_from = date_to = datetime.strptime(parts[0], fmt).date()
    except Exception:
        pass

    # Data rows: header=row1, drop last totals row
    df = pd.read_excel(io.BytesIO(content), header=1, sheet_name=0)
    if len(df) > 0:
        last_val = str(df.iloc[-1, 0])
        if last_val.startswith("Нийт") or pd.isna(df.iloc[-1, 0]):
            df = df.iloc[:-1]

    transactions = []
    for _, row in df.iterrows():
        txn_date = None
        try:
            raw_date = row.iloc[0]
            if pd.notna(raw_date):
                txn_date = pd.to_datetime(raw_date).to_pydatetime()
        except Exception:
            pass

        debit  = float(row.iloc[1]) if pd.notna(row.iloc[1]) else 0.0
        credit = float(row.iloc[2]) if pd.notna(row.iloc[2]) else 0.0
        desc   = str(row.iloc[3]) if pd.notna(row.iloc[3]) else ""
        cpart  = str(row.iloc[4]) if df.shape[1] > 4 and pd.notna(row.iloc[4]) else ""
        if desc  == "nan": desc  = ""
        if cpart == "nan": cpart = ""

        transactions.append({
            "txn_date":        txn_date,
            "debit":           debit,
            "credit":          credit,
            "bank_description": desc,
            "bank_counterpart": cpart,
            "is_fee":           _is_fee(desc),
        })

    return {
        "account_number": account_number,
        "currency":       currency,
        "date_from":      date_from,
        "date_to":        date_to,
        "filename":       filename,
        "transactions":   transactions,
    }


def _ser_stmt(s: BankStatement, include_txns: bool = False) -> dict:
    d = {
        "id":             s.id,
        "account_number": s.account_number,
        "currency":       s.currency,
        "date_from":      s.date_from.isoformat()  if s.date_from  else None,
        "date_to":        s.date_to.isoformat()    if s.date_to    else None,
        "filename":       s.filename,
        "uploaded_at":    s.uploaded_at.isoformat() if s.uploaded_at else None,
        "txn_count":      len(s.transactions),
        "total_credit":   sum(t.credit for t in s.transactions),
        "total_debit":    sum(t.debit  for t in s.transactions),
        "filled_count":   sum(1 for t in s.transactions if t.partner_name or t.action),
    }
    if include_txns:
        d["transactions"] = [_ser_txn(t) for t in s.transactions]
    return d


def _ser_txn(t: BankTransaction) -> dict:
    return {
        "id":                 t.id,
        "txn_date":           t.txn_date.isoformat() if t.txn_date else None,
        "debit":              t.debit,
        "credit":             t.credit,
        "bank_description":   t.bank_description,
        "bank_counterpart":   t.bank_counterpart,
        "is_fee":             t.is_fee,
        "partner_name":       t.partner_name,
        "partner_account":    t.partner_account,
        "custom_description": t.custom_description,
        "action":             t.action,
    }


# ── Pydantic ──────────────────────────────────────────────────────────────────

class TxnUpdate(BaseModel):
    partner_name:       Optional[str] = None
    partner_account:    Optional[str] = None
    custom_description: Optional[str] = None
    action:             Optional[str] = None   # "" | "close" | "create"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_statement(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    content  = await file.read()
    filename = file.filename or "statement.xlsx"
    try:
        parsed = _parse_excel(content, filename)
    except Exception as e:
        raise HTTPException(400, f"Excel уншихад алдаа: {e}")

    stmt = BankStatement(
        account_number=parsed["account_number"],
        currency=parsed["currency"],
        date_from=parsed["date_from"],
        date_to=parsed["date_to"],
        filename=parsed["filename"],
        uploaded_by_id=current_user.id,
    )
    db.add(stmt)
    db.flush()

    for t in parsed["transactions"]:
        db.add(BankTransaction(statement_id=stmt.id, **t))

    db.commit()
    db.refresh(stmt)
    return _ser_stmt(stmt)


@router.get("/")
def list_statements(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = db.query(BankStatement).order_by(BankStatement.uploaded_at.desc()).all()
    return [_ser_stmt(s) for s in rows]


@router.get("/{stmt_id}")
def get_statement(
    stmt_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    s = db.query(BankStatement).filter(BankStatement.id == stmt_id).first()
    if not s:
        raise HTTPException(404, "Хуулга олдсонгүй")
    return _ser_stmt(s, include_txns=True)


@router.patch("/{stmt_id}/transactions/{txn_id}")
def update_transaction(
    stmt_id: int,
    txn_id: int,
    body: TxnUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    t = db.query(BankTransaction).filter(
        BankTransaction.id == txn_id,
        BankTransaction.statement_id == stmt_id,
    ).first()
    if not t:
        raise HTTPException(404, "Гүйлгээ олдсонгүй")

    if body.partner_name       is not None: t.partner_name       = body.partner_name
    if body.partner_account    is not None: t.partner_account    = body.partner_account
    if body.custom_description is not None: t.custom_description = body.custom_description
    if body.action             is not None: t.action             = body.action

    db.commit()
    return _ser_txn(t)


@router.delete("/{stmt_id}")
def delete_statement(
    stmt_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    s = db.query(BankStatement).filter(BankStatement.id == stmt_id).first()
    if not s:
        raise HTTPException(404, "Хуулга олдсонгүй")
    db.delete(s)
    db.commit()
    return {"ok": True}
