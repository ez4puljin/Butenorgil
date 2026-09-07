"""Үнэ харах KIOSK — ТУСДАА порт дээр ажилладаг бие даасан үйлчилгээ.

Яагаад тусад нь вэ: заалны таблетыг үндсэн ERP (:8000) рүү нэвтрүүлбэл
үйлчлүүлэгч эсвэл гаднын хүн бусад цэс рүү орж дотоод мэдээллийг харах
боломжтой болно. Энэ апп нь ЗӨВХӨН:

    GET /            → үнийн хуудас (нэг файл, бие даасан)
    GET /lookup?q=   → баркод/код/нэрээр хайх
    GET /vendor/...  → камерын сан (интернэтгүй ажиллана)
    GET /healthz     → амьд эсэх

ERP-ийн өгөгдлийн сан, чиглүүлэгч, нэвтрэлтийн токенд ОГТ хүрэхгүй —
`app.services.pos_price` нь зөвхөн локал POS API руу ханддаг.

Ажиллуулах:
    .venv\\Scripts\\python.exe -m uvicorn kiosk_app:app --host 0.0.0.0 --port 8100 \\
        --ssl-keyfile app/data/certs/server.key --ssl-certfile app/data/certs/server.crt

HTTPS ЗААВАЛ хэрэгтэй — хөтөч камерыг зөвхөн secure context дээр нээнэ.
"""
from __future__ import annotations

import os

from fastapi import FastAPI, Query
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse,
                               PlainTextResponse)

from app.services import pos_label, pos_price

_HERE = os.path.dirname(os.path.abspath(__file__))
_PAGE = os.path.join(_HERE, "app", "kiosk", "index.html")
_VENDOR = os.path.join(_HERE, os.pardir, "frontend", "node_modules",
                       "html5-qrcode", "html5-qrcode.min.js")

app = FastAPI(
    title="Үнэ харах (kiosk)",
    docs_url=None, redoc_url=None, openapi_url=None,   # ил тайлбар хэрэггүй
)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "ok" if pos_price.enabled() else "no-pos"


@app.get("/lookup")
def lookup(q: str = Query(..., min_length=1, max_length=80)):
    """Баркод / код / нэрээр барааны POS үнийг олно.

    Нэвтрэлтгүй — заалны таблет дундын төхөөрөмж бөгөөд энэ нь үйлчлүүлэгч
    лангуун дээр аль хэдийн харж байгаа үнийг л буцаана. Дотоод сүлжээнд л
    нээлттэй байлгана (гадагш порт бүү нээ)."""
    try:
        return pos_price.lookup(q)
    except Exception as e:      # noqa: BLE001 — kiosk хэзээ ч 500 буцаах ёсгүй
        return JSONResponse({"query": q, "found": False, "product": None,
                             "others": [], "error": str(e)[:120]})


@app.get("/bulk")
def bulk(q: str = Query(..., min_length=1, max_length=80)):
    """Бөөний ширхэг/үнэ — шошготой ижил эх сурвалжаас."""
    p = (pos_price.lookup(q) or {}).get("product")
    if not p:
        return JSONResponse({"ok": False, "quantity": "", "price": ""}, status_code=404)
    try:
        return pos_label.bulk_info(p["_id"])
    except Exception as e:      # noqa: BLE001 — kiosk хэзээ ч 500 буцаах ёсгүй
        return JSONResponse({"ok": False, "quantity": "", "price": "",
                             "error": str(e)[:120]})


@app.get("/label", response_class=HTMLResponse)
def label(q: str = Query(..., min_length=1, max_length=80),
          copies: int = Query(1, ge=1, le=20),
          preview: bool = Query(False, description="Зөвхөн харах — автоматаар хэвлэхгүй")):
    """Үнийн шошго — шинэ цонхонд нээгдэж шууд хэвлэх харилцах цонх гаргана.

    Сервер өөрөө юу ч хэвлэхгүй — хүн хэвлэгчээ сонгож баталгаажуулна."""
    r = pos_price.lookup(q)
    p = r.get("product")
    if not p:
        return HTMLResponse("<p style='font:14px sans-serif;padding:2rem'>"
                            "Бараа олдсонгүй.</p>", status_code=404)
    try:
        return HTMLResponse(pos_label.label_page(p["_id"], copies, auto_print=not preview))
    except Exception as e:      # noqa: BLE001 — kiosk хэзээ ч 500 буцаах ёсгүй
        return HTMLResponse("<p style='font:14px sans-serif;padding:2rem'>"
                            f"Шошго татахад алдаа: {str(e)[:120]}</p>", status_code=502)


@app.get("/vendor/html5-qrcode.min.js")
def vendor_js():
    """Камерын нөөц сан. Байхгүй бол хуудас native BarcodeDetector-оор ажиллана."""
    if not os.path.exists(_VENDOR):
        return PlainTextResponse("// html5-qrcode олдсонгүй", media_type="application/javascript")
    return FileResponse(_VENDOR, media_type="application/javascript")


@app.get("/")
def index():
    if not os.path.exists(_PAGE):
        return PlainTextResponse("kiosk/index.html олдсонгүй", status_code=500)
    return FileResponse(_PAGE, media_type="text/html")
