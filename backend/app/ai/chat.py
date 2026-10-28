"""AI туслах (Claude) — асуулт → tool loop (≤5) → урсгалтай хариулт.

Үйл явдлууд (dict) yield хийнэ:
    {"t": "tool", "name", "label"}   — tool дуудаж эхэлж байна
    {"t": "text", "v"}               — хариултын хэсэг (streaming)
    {"t": "done", "tools", "cost"}   — дууссан
    {"t": "error", "message"}        — алдаа (Монгол)
"""
from __future__ import annotations

from datetime import datetime, timedelta

from app.ai import chat_tools, readonly_db, usage
from app.ai import client as ai
from app.ai.errors import translate

MAX_TOKENS = 1500
MAX_TOOL_LOOPS = 5
MAX_HISTORY = 6          # сүүлийн 6 мессеж (3 асуулт-хариулт)
MAX_MSG_CHARS = 4000

SYSTEM_PROMPT = """Чи бол «Бүтэн-Оргил» компанийн ERP системийн AI туслах. Ажилтнуудын асуултад ERP-ийн бодит өгөгдлөөр хариулна.

Дүрэм:
1. Тоо, нэр, огноог ЗӨВХӨН tool-ийн үр дүнгээс ав. Хэзээ ч таамаглаж, зохиож болохгүй. Өгөгдөл хэрэгтэй бол эхлээд tool дууд.
2. Tool юу ч олоогүй бол «олдсонгүй» гэж шууд хэл. Ойролцоо утга бүү зохио.
3. Хэрэглэгчийн хэлсэн тоог (хоног, сар, он) tool-ийн параметрт яг дамжуул.
4. Мөнгөн дүнг мянгатаар таслаж ₮-өөр бич (жишээ: 1,234,567₮). Тоо ширхэгийг мөн мянгатаар тасал.
5. Хариулт МОНГОЛООР, товч бөгөөд тодорхой. Олон мөртэй өгөгдлийг markdown хүснэгтээр харуул.
6. Үлдэгдэл, борлуулалтын тоо хэлэхдээ get_data_freshness-ээр шалга; файл 2 хоногоос хуучин бол хариултын төгсгөлд «⚠️ Энэ дата N хоногийн өмнөх файлаас» гэж сануул.
7. Асуулт ойлгомжгүй бол нэг товч тодруулах асуулт асуу.
8. Tool «эрх алга» гэвэл тэр мэдээллийг харах эрх байхгүй гэж хэл.
9. Чи зөвхөн уншина — юу ч өөрчилж, устгаж, илгээж чадахгүй. Ийм хүсэлт ирвэл тухайн цэснээс өөрөө хийхийг зөвлө.
10. Хэрэглэгчийн мессежийн эхэнд [Хуудас: ...] гэсэн мэдээлэл байвал тэр нь хэрэглэгчийн одоо нээсэн цэс. «Энэ захиалга», «энд» гэвэл тэр ID-г ашигла.
11. Tool-ийн нэр, JSON, техникийн дэлгэрэнгүйг хариултад бүү оруул."""

UB = timedelta(hours=8)


def _page_line(page: dict | None) -> str:
    if not page:
        return ""
    menu = str(page.get("menu") or "").strip()[:60]
    path = str(page.get("path") or "").strip()[:120]
    ids = [str(i)[:20] for i in (page.get("ids") or [])][:20]
    if not (menu or path or ids):
        return ""
    s = f"[Хуудас: {menu or '-'} ({path})"
    if ids:
        s += f"; харагдаж буй ID: {', '.join(ids)}"
    return s + "]\n"


def build_messages(question: str, history: list[dict], page: dict | None, now_utc: datetime | None = None) -> list:
    msgs: list[dict] = []
    for m in history[-MAX_HISTORY:]:
        text = str(m.get("text") or "").strip()[:MAX_MSG_CHARS]
        if not text:
            continue
        role = "assistant" if m.get("role") in ("assistant", "model") else "user"
        if msgs and msgs[-1]["role"] == role:            # дараалсан ижил role → нэгтгэнэ
            msgs[-1]["content"] += "\n\n" + text
        else:
            msgs.append({"role": role, "content": text})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    today = ((now_utc or datetime.utcnow()) + UB).strftime("%Y-%m-%d %H:%M")
    q = f"[Одоо: {today} (Улаанбаатар)]\n{_page_line(page)}{question.strip()[:MAX_MSG_CHARS]}"
    if msgs and msgs[-1]["role"] == "user":
        msgs[-1]["content"] += "\n\n" + q
    else:
        msgs.append({"role": "user", "content": q})
    return msgs


def _cost(resp) -> float:
    i, o, cr, cw = usage.tokens(resp.usage)
    return usage.cost_usd(resp.model or "", i, o, cr, cw)


def answer(user, perms: set, question: str, history: list[dict], page: dict | None, qid: str, db_factory=None):
    """Generator — үйл явдлуудыг yield хийнэ. check() нь дуудагчид (stream эхлэхээс өмнө) хийгдэнэ."""
    tools = chat_tools.definitions(perms)
    if tools:
        tools[-1] = {**tools[-1], "cache_control": {"type": "ephemeral"}}
    system = [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]
    messages = build_messages(question, history, page)
    used: list[str] = []
    cost = 0.0
    db = (db_factory or readonly_db.session)()
    try:
        for loop in range(MAX_TOOL_LOOPS + 1):
            kw = dict(max_tokens=MAX_TOKENS, system=system, messages=messages, output_config={"effort": "low"})
            if tools:
                kw["tools"] = tools
                if loop == MAX_TOOL_LOOPS:           # сүүлийн удаа — tool-гүйгээр дүгнэнэ
                    kw["tool_choice"] = {"type": "none"}
            resp = None
            for kind, v in ai.stream(user, "chat", qid, **kw):
                if kind == "text":
                    yield {"t": "text", "v": v}
                else:
                    resp = v
            cost += _cost(resp)
            calls = [b for b in resp.content if b.type == "tool_use"]
            if resp.stop_reason != "tool_use" or not calls:
                if resp.stop_reason == "max_tokens":
                    yield {"t": "text", "v": "\n\n_(Хариулт хэт урт болж таслагдлаа — асуултаа нарийсгана уу.)_"}
                elif resp.stop_reason == "refusal":
                    yield {"t": "text", "v": "Уучлаарай, энэ асуултад хариулж чадахгүй."}
                break
            messages.append({"role": "assistant", "content": resp.content})
            results = []
            for b in calls:
                used.append(b.name)
                yield {"t": "tool", "name": b.name, "label": chat_tools.label(b.name)}
                results.append({"type": "tool_result", "tool_use_id": b.id,
                                "content": chat_tools.run(db, b.name, b.input, perms)})
            messages.append({"role": "user", "content": results})
            if any(b.type == "text" for b in resp.content):     # tool-ийн өмнөх текстийг хариултаас тусгаарлана
                yield {"t": "text", "v": "\n\n"}
        yield {"t": "done", "tools": used, "cost": round(cost, 6)}
    except Exception as e:  # noqa: BLE001
        yield {"t": "error", "message": translate(e).message, "tools": used}
    finally:
        db.close()
