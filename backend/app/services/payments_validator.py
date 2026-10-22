"""Deal-ийн paymentsData-г шалгах цэвэр функц (erxes/DB-д хүрэхгүй).

syncerkhet нь paymentsData-г {төлбөрийн_төрөл: {amount, currency}} гэж уншдаг. Утга нь тоо
({"totalAmount": 1602750}) байвал төрөл нь `undefined`, дүн нь NaN болж Эрхэт баримтыг БЭЛЭН (CASH)
гэж бүртгэдэг — авлага үүсдэггүй (2026-10-12…19-нд BTO300/«Захиалга» аппаас 89 deal).

Зөвшөөрөгдсөн төрлүүд erxes-д тохиргоогоор алга (salesPipelines.paymentTypes хоосон, 2026-10-22) —
DB-д (erkhet_sync_settings kind="paytypes") хадгалж, анхдагч нь бодит өгөгдөлд байгаа ["other"].
"""
from __future__ import annotations

import json
import math

DEFAULT_ALLOWED = ("other",)

# code → (ноцтой байдал, монгол тайлбар). warn = анхааруулга (sync-ийг эвдэхгүй)
ISSUES = {
    "NOT_OBJECT": ("error", "paymentsData объект биш"),
    "VALUE_NOT_OBJECT": ("error", "Утга нь объект биш ({\"totalAmount\": N} г.м.)"),
    "BAD_AMOUNT": ("error", "amount байхгүй / тоо биш / сөрөг"),
    "UNKNOWN_TYPE": ("error", "Зөвшөөрөгдөөгүй төлбөрийн төрөл"),
    "BAD_CURRENCY": ("warn", "currency нь MNT биш"),
    "SUM_EXCEEDS_TOTAL": ("warn", "Төлбөрийн нийлбэр deal-ийн дүнгээс их"),
}


def _parse(pd):
    if isinstance(pd, str):
        s = pd.strip()
        if not s:
            return None
        try:
            return json.loads(s)
        except ValueError:
            return pd
    return pd


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and not math.isnan(v) and not math.isinf(v)


def validate_payments_data(pd, allowed_types=DEFAULT_ALLOWED, deal_total: float | None = None) -> dict:
    """→ {"ok": bool, "issues": [{"code", "key", "value", "severity"}]}. ok = error түвшний issue алга."""
    pd = _parse(pd)
    issues: list[dict] = []

    def add(code, key=None, value=None):
        issues.append({"code": code, "key": key, "value": value, "severity": ISSUES[code][0]})

    if pd is None:
        return {"ok": True, "issues": []}
    if not isinstance(pd, dict):
        add("NOT_OBJECT", value=pd)
        return {"ok": False, "issues": issues}

    allowed = set(allowed_types or ())
    total = 0.0
    for k, v in pd.items():
        if k not in allowed:
            add("UNKNOWN_TYPE", k, v)
        if not isinstance(v, dict):
            add("VALUE_NOT_OBJECT", k, v)
            continue
        amt = v.get("amount")
        if not _is_num(amt) or amt < 0:
            add("BAD_AMOUNT", k, amt)
        else:
            total += float(amt)
        if v.get("currency") != "MNT":
            add("BAD_CURRENCY", k, v.get("currency"))
    if deal_total is not None and total > float(deal_total) + 1:
        add("SUM_EXCEEDS_TOTAL", value={"payments": total, "deal": float(deal_total)})
    return {"ok": not any(i["severity"] == "error" for i in issues), "issues": issues}
