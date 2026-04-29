"""
Тооцоо хаах — Хаанбанкны хуулга Excel файлаар импортлох,
Календар харагдац, гүйлгээ засах, тохиргоо.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from typing import Optional
from pydantic import BaseModel
from datetime import datetime
from pathlib import Path
import pandas as pd
import io
import re

from app.api.deps import get_db, get_current_user
from app.models.bank_statement import BankStatement, BankTransaction, BankAccountConfig
from app.models.user import User

router = APIRouter(prefix="/bank-statements", tags=["bank-statements"])

# ── Helpers ───────────────────────────────────────────────────────────────────

_FEE_KEYWORDS = ["хураамж", "commission", "fee", "үйлчилгээний төлбөр"]


def _is_fee(desc: str) -> bool:
    d = (desc or "").lower()
    return any(k in d for k in _FEE_KEYWORDS)


def _parse_excel(content: bytes, filename: str) -> dict:
    account_number, currency = "", "MNT"
    m = re.search(r"Statement_([A-Z]+)_(\d+)", filename)
    if m:
        currency = m.group(1)
        account_number = m.group(2)

    raw = pd.read_excel(io.BytesIO(content), header=None, sheet_name=0)

    date_from = date_to = None
    try:
        date_str = str(raw.iloc[0, 2]) if raw.shape[1] > 2 else ""
        parts = re.findall(r"\d{4}[/\-]\d{2}[/\-]\d{2}", date_str)
        fmt = "%Y/%m/%d" if "/" in (parts[0] if parts else "") else "%Y-%m-%d"
        if len(parts) >= 2:
            date_from = datetime.strptime(parts[0], fmt).date()
            date_to   = datetime.strptime(parts[1], fmt).date()
        elif len(parts) == 1:
            date_from = date_to = datetime.strptime(parts[0], fmt).date()
    except Exception:
        pass

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

        # Дебит: Excel-д сөрөг тоогоор хадгалагддаг (-50, -26871200) → abs() авна
        raw_debit  = float(row.iloc[1]) if pd.notna(row.iloc[1]) else 0.0
        debit  = abs(raw_debit)
        credit = float(row.iloc[2]) if pd.notna(row.iloc[2]) else 0.0
        desc   = str(row.iloc[3]) if pd.notna(row.iloc[3]) else ""

        # Харьцсан данс: float-оор унших үед "5893180078.0" болдог → int болгож цэвэрлэнэ
        cpart = ""
        if df.shape[1] > 4 and pd.notna(row.iloc[4]):
            raw_cp = row.iloc[4]
            try:
                # Дансны дугаар — бүхэл тоо болгоно (5893180078.0 → "5893180078")
                cpart = str(int(float(str(raw_cp))))
            except (ValueError, OverflowError):
                cpart = str(raw_cp)
        if desc  == "nan": desc  = ""
        if cpart == "nan": cpart = ""

        transactions.append({
            "txn_date":         txn_date,
            "debit":            debit,
            "credit":           credit,
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
    txns = s.transactions
    main_txns = [t for t in txns if not t.is_fee]
    d = {
        "id":             s.id,
        "account_number": s.account_number,
        "currency":       s.currency,
        "date_from":      s.date_from.isoformat()   if s.date_from   else None,
        "date_to":        s.date_to.isoformat()     if s.date_to     else None,
        "filename":       s.filename,
        "uploaded_at":    s.uploaded_at.isoformat() if s.uploaded_at else None,
        "txn_count":      len(main_txns),
        "fee_count":      len(txns) - len(main_txns),
        "total_credit":   sum(t.credit for t in main_txns),
        "total_debit":    sum(t.debit  for t in main_txns),
        "filled_count":   sum(1 for t in main_txns if t.partner_name or t.action),
    }
    if include_txns:
        d["transactions"] = [_ser_txn(t) for t in txns]
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


def _ser_acct(a: BankAccountConfig) -> dict:
    return {
        "id":             a.id,
        "account_number": a.account_number,
        "partner_name":   a.partner_name,
        "bank_name":      a.bank_name,
        "is_fee_default": a.is_fee_default,
        "note":           a.note,
        "sort_order":     a.sort_order,
    }


# ── Pydantic ──────────────────────────────────────────────────────────────────

class TxnUpdate(BaseModel):
    partner_name:       Optional[str] = None
    partner_account:    Optional[str] = None
    custom_description: Optional[str] = None
    action:             Optional[str] = None


class AccountIn(BaseModel):
    account_number: str = ""
    partner_name:   str = ""
    bank_name:      str = "Хаанбанк"
    is_fee_default: bool = False
    note:           str = ""
    sort_order:     int = 0


# ── Calendar ──────────────────────────────────────────────────────────────────

@router.get("/calendar")
def get_calendar(
    year:  int = Query(...),
    month: int = Query(...),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Тухайн сард өдөр тус бүрт хэдэн хуулга оруулсныг буцаана."""
    rows = db.query(
        func.date(BankStatement.uploaded_at).label("day"),
        func.count(BankStatement.id).label("cnt"),
    ).filter(
        func.strftime("%Y", BankStatement.uploaded_at) == str(year),
        func.strftime("%m", BankStatement.uploaded_at) == f"{month:02d}",
    ).group_by(func.date(BankStatement.uploaded_at)).all()
    return {r.day: r.cnt for r in rows}


@router.get("/by-date")
def get_by_date(
    date: str = Query(...),   # "YYYY-MM-DD"
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Тухайн өдрийн хуулгуудыг буцаана."""
    rows = db.query(BankStatement).filter(
        func.date(BankStatement.uploaded_at) == date,
    ).order_by(BankStatement.uploaded_at).all()
    return [_ser_stmt(s) for s in rows]


# ── One-time data fix: fix negative debits + .0 counterparts ─────────────────

@router.post("/fix-legacy-data")
def fix_legacy_data(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Хуучин өгөгдлийн дебит сөрөг байгааг abs() болгож,
    харьцсан данс '5893180078.0' хэлбэрийг '5893180078' болгоно."""
    txns = db.query(BankTransaction).all()
    fixed = 0
    for t in txns:
        changed = False
        if t.debit < 0:
            t.debit = abs(t.debit)
            changed = True
        if t.bank_counterpart and t.bank_counterpart.endswith(".0"):
            try:
                t.bank_counterpart = str(int(float(t.bank_counterpart)))
                changed = True
            except Exception:
                pass
        if changed:
            fixed += 1
    db.commit()
    return {"fixed": fixed}


# ── Customer search from imported customer_info_last.xlsx ────────────────────

_CUSTOMER_FILE = Path("app/data/outputs/customer_info_last.xlsx")


@router.get("/customers/search")
def search_customers(
    q: str = Query(""),
    _: User = Depends(get_current_user),
):
    """Импортлосон харилцагчдын жагсаалтаас нэр/код/бүлгээр хайна."""
    if not _CUSTOMER_FILE.exists():
        return []
    try:
        df = pd.read_excel(str(_CUSTOMER_FILE), header=0, dtype=str)
    except Exception:
        return []

    q_low = q.strip().lower()
    results = []
    for _, row in df.iterrows():
        name    = (row.get("Нэр")            or "").strip()
        code    = (row.get("Код")            or "").strip()
        group   = (row.get("Бүлэг нэр")     or "").strip()
        phone   = (row.get("Утас")           or "").strip()
        account = (row.get("Банк дахь данс") or "").strip()

        # nan → хоосон
        if name    == "nan": name    = ""
        if code    == "nan": code    = ""
        if group   == "nan": group   = ""
        if phone   == "nan": phone   = ""
        if account == "nan": account = ""

        if not name:
            continue

        if not q_low or q_low in name.lower() or q_low in code.lower() or q_low in group.lower() or q_low in phone:
            results.append({
                "code":    code,
                "name":    name,
                "group":   group,
                "phone":   phone,
                "account": account,
            })
            if len(results) >= 30:
                break

    return results


# ── Config: accounts ──────────────────────────────────────────────────────────

@router.get("/config/accounts")
def list_accounts(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = db.query(BankAccountConfig).order_by(
        BankAccountConfig.sort_order, BankAccountConfig.id
    ).all()
    return [_ser_acct(a) for a in rows]


@router.post("/config/accounts")
def create_account(
    body: AccountIn,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    # Шимтгэлийн данс нэг л байна
    if body.is_fee_default:
        db.query(BankAccountConfig).update({"is_fee_default": False})
    a = BankAccountConfig(**body.model_dump())
    db.add(a)
    db.commit()
    db.refresh(a)
    return _ser_acct(a)


@router.patch("/config/accounts/{acct_id}")
def update_account(
    acct_id: int,
    body: AccountIn,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    a = db.query(BankAccountConfig).filter(BankAccountConfig.id == acct_id).first()
    if not a:
        raise HTTPException(404, "Данс олдсонгүй")
    if body.is_fee_default:
        db.query(BankAccountConfig).filter(BankAccountConfig.id != acct_id).update({"is_fee_default": False})
    for k, v in body.model_dump().items():
        setattr(a, k, v)
    db.commit()
    return _ser_acct(a)


@router.delete("/config/accounts/{acct_id}")
def delete_account(
    acct_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    a = db.query(BankAccountConfig).filter(BankAccountConfig.id == acct_id).first()
    if not a:
        raise HTTPException(404, "Данс олдсонгүй")
    db.delete(a)
    db.commit()
    return {"ok": True}


# ── Statements CRUD ───────────────────────────────────────────────────────────

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
