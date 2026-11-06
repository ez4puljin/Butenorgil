"""Дарагдсан барааны тайлан — тухайн өдөр үүссэн deal-ийн tickUsed=false бараа (app/services/blocked_goods).

  GET /blocked-goods?day=YYYY-MM-DD&refresh=false  — агуулахаар нэгтгэсэн жагсаалт (10 мин кэштэй)
  GET /blocked-goods/xlsx?day=YYYY-MM-DD&locations=01,11,_other — Excel (агуулахаар + мөрөөр); _other = байршилгүй
"""
from __future__ import annotations

import io
from datetime import date, datetime, timedelta
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.api.deps import require_role
from app.models.user import User
from app.services import blocked_goods as svc

router = APIRouter(prefix="/blocked-goods", tags=["blocked-goods"])
VIEW = ("admin", "supervisor", "manager")


def _day(s: Optional[str]) -> date:
    if not s:
        return datetime.now(svc.UB).date()
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, "Огноо буруу (YYYY-MM-DD).")


def _load(day: date, refresh: bool = False) -> dict:
    try:
        return svc.get(day, refresh)
    except Exception as e:
        raise HTTPException(502, f"erxes-ээс deal татаж чадсангүй: {str(e)[:200]}")


@router.get("")
def get_report(day: Optional[str] = None, refresh: bool = False, u: User = Depends(require_role(*VIEW))):
    r = _load(_day(day), refresh)
    return {k: v for k, v in r.items() if k != "lines"}


@router.get("/xlsx")
def xlsx(day: Optional[str] = None, locations: Optional[str] = None, u: User = Depends(require_role(*VIEW))):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    r = dict(_load(_day(day)))
    if locations is not None:
        want = {x.strip() for x in locations.split(",") if x.strip()}
        r["items"] = [i for i in r["items"] if (i["location"] or "_other") in want]
        r["lines"] = [ln for ln in r["lines"] if (ln["location"] or "_other") in want]
        r["locations"] = [x for x in r["locations"] if (x["code"] or "_other") in want]
        r["count"], r["deals_blocked"] = len(r["items"]), len({ln["deal_id"] for ln in r["lines"]})
    at = datetime.fromisoformat(r["checked_at"].rstrip("Z")) + timedelta(hours=8)
    head_fill = PatternFill("solid", start_color="F3F4F6")
    wb = Workbook()
    ws = wb.active
    ws.title = "Дарагдсан бараа"
    ws.append([f"Дарагдсан барааны тайлан — {r['day']}"])
    ws["A1"].font = Font(bold=True, size=14)
    ws.append([f"{r['day']}-нд үүссэн {r['deals']} deal-ийн tickUsed=false бараа · erxes {at:%Y-%m-%d %H:%M}-ийн байдлаар"])
    ws.append([])
    ws.append(["Агуулах", "Код", "Нэр", "Тоо", "Дүн", "Захиалга"])
    for c in ws[4]:
        c.font = Font(bold=True)
        c.fill = head_fill
    cur = None
    for it in r["items"]:
        key = it["location"] or it["location_name"]
        if key != cur:
            cur = key
            loc = next((x for x in r["locations"] if x["key"] == key), {})
            ws.append([f"{it['location']} {it['location_name']}".strip() + f" — {loc.get('count', 0)} бараа"])
            ws.cell(ws.max_row, 1).font = Font(bold=True)
        ws.append([it["location"], it["code"], it["name"], it["qty"], it["amount"],
                   ", ".join(f"{d['number']} ({d['qty']:g})" for d in it["deals"])])
        for col in (4, 5):
            ws.cell(ws.max_row, col).number_format = "#,##0.##"
    ws.append([])
    ws.append([f"Нийт: {r['count']} бараа, {r['deals_blocked']} deal"])
    ws.cell(ws.max_row, 1).font = Font(bold=True)
    for col, w in zip("ABCDEF", (10, 10, 44, 9, 13, 48)):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A5"
    ws.print_title_rows = "4:4"
    ws.page_setup.orientation = "portrait"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    for row in ws.iter_rows(min_row=5):
        for c in row:
            c.alignment = Alignment(vertical="top", wrap_text=c.column == 6)

    wl = wb.create_sheet("Мөрөөр")
    wl.append(["Үүссэн", "Захиалга №", "Захиалгын нэр", "Pipeline", "Үе шат", "Агуулах", "Код", "Нэр", "Тоо",
               "Нэгж үнэ", "Дүн"])
    for c in wl[1]:
        c.font = Font(bold=True)
        c.fill = head_fill
    for ln in sorted(r["lines"], key=lambda x: (x["location"] == "", x["location"], x["location_name"], x["number"])):
        t = svc._ts(ln["created_at"])
        wl.append([(t + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M") if t else "", ln["number"], ln["deal_name"],
                   ln["pipeline"], ln["stage"], f"{ln['location']} {ln['location_name']}".strip(), ln["code"],
                   ln["name"], ln["qty"], ln["unit_price"], ln["amount"]])
        for col in (9, 10, 11):
            wl.cell(wl.max_row, col).number_format = "#,##0.##"
    for col, w in zip("ABCDEFGHIJK", (16, 16, 30, 26, 16, 24, 10, 40, 8, 11, 12)):
        wl.column_dimensions[col].width = w
    wl.freeze_panes = "A2"
    wl.auto_filter.ref = wl.dimensions

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fn = f"Дарагдсан_бараа_{r['day']}.xlsx"
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fn)}"})
