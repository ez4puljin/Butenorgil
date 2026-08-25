"""erxes (erxes.bto.mn) — GraphQL клиент.

Эрхэтээс ялгаатай нь erxes бол ЖИНХЭНЭ GraphQL API-тай (HTML задлах шаардлагагүй).

Илрүүлсэн гэрээ (erxes 2.17.54, тухайн instance дээр шалгасан):
    endpoint : https://erxes.bto.mn/gateway/graphql
    нэвтрэх  : mutation { login(email, password) }  -> токен (String)
    POS      : query { posList { _id name ... } }
    захиалга : query { posOrderRecords(posId, posToken, paidStartDate,
                        paidEndDate, createdStartDate, createdEndDate,
                        page, perPage, search, statuses) }
    шалгах   : mutation { toCheckSynced(ids: [String]) : [CheckResponse] }
    татах    : mutation { toSyncOrders(orderIds: [String]) }

Тэмдэглэл: introspection хаалттай (production хамгаалалт) тул талбаруудыг
validation алдаагаар илрүүлсэн. Схем өөрчлөгдвөл энд шинэчилнэ.
"""
from __future__ import annotations

import threading
from typing import Any

import requests

from app.core.config import settings

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


class ErxesError(RuntimeError):
    pass


class ErxesClient:
    """Session/токеноо дахин ашиглана; хугацаа дуусахад автоматаар дахин нэвтэрнэ."""

    def __init__(self, url: str = "", email: str = "", password: str = "", timeout: int = 120):
        base = (url or settings.erxes_url or "").rstrip("/")
        self.endpoint = base if base.endswith("/graphql") else f"{base}/graphql"
        self.email = email or settings.erxes_email
        self.password = password or settings.erxes_password
        self.timeout = timeout
        self._s: requests.Session | None = None
        self._lock = threading.Lock()

    # ── нэвтрэлт ─────────────────────────────────────────────────────
    def _do_login(self) -> None:
        if not (self.endpoint and self.email and self.password):
            raise ErxesError(
                "erxes тохиргоо дутуу. backend/.env-д ERXES_URL, ERXES_EMAIL, "
                "ERXES_PASSWORD нэмнэ үү."
            )
        s = requests.Session()
        s.headers.update({"User-Agent": _UA, "Content-Type": "application/json"})
        r = s.post(self.endpoint, json={
            "query": "mutation($e:String!,$p:String!){ login(email:$e, password:$p) }",
            "variables": {"e": self.email, "p": self.password},
        }, timeout=self.timeout, verify=False)
        try:
            j = r.json()
        except Exception:
            raise ErxesError(f"erxes хариу буруу: {r.text[:120]}")
        if j.get("errors"):
            raise ErxesError(f"erxes нэвтрэх алдаа: {j['errors'][0].get('message', '')[:150]}")
        token = (j.get("data") or {}).get("login")
        if token:
            # Токеныг header-ээр ч дамжуулна (cookie аль хэдийн session-д суусан)
            s.headers["Authorization"] = f"Bearer {token}"
            s.cookies.set("auth-token", token)
        self._s = s

    def _session(self) -> requests.Session:
        if self._s is None:
            self._do_login()
        return self._s  # type: ignore[return-value]

    # ── GraphQL ──────────────────────────────────────────────────────
    def gql(self, query: str, variables: dict | None = None, retry: bool = True) -> dict:
        """GraphQL хүсэлт. 'Login required' гарвал нэг удаа дахин нэвтэрнэ."""
        with self._lock:
            s = self._session()
            r = s.post(self.endpoint,
                       json={"query": query, "variables": variables or {}},
                       timeout=self.timeout, verify=False)
            try:
                j = r.json()
            except Exception:
                raise ErxesError(f"erxes хариу буруу ({r.status_code}): {r.text[:120]}")
            errs = j.get("errors")
            if errs:
                msg = errs[0].get("message", "")
                if retry and ("Login required" in msg or "Unauthorized" in msg):
                    self._s = None
                    return self.gql(query, variables, retry=False)
                raise ErxesError(msg[:200])
            return j.get("data") or {}

    # ── POS ──────────────────────────────────────────────────────────
    def pos_list(self) -> list[dict]:
        """Бүх POS-ийн жагсаалт (сонголтод)."""
        data = self.gql("{ posList { _id name description token } }")
        return data.get("posList") or []

    @staticmethod
    def _day_bounds(day: str) -> tuple[str, str]:
        """'YYYY-MM-DD' → тухайн өдрийн эхлэл/төгсгөл ISO datetime.

        erxes-ийн Date скаляр нь ЗӨВХӨН бүтэн ISO datetime хүлээж авдаг —
        'YYYY-MM-DD' дамжуулбал шүүлт ажиллахгүй, 0 мөр буцаана
        (туршилтаар тогтоосон)."""
        d = (day or "").strip()[:10]
        return f"{d}T00:00:00.000Z", f"{d}T23:59:59.999Z"

    def pos_orders(self, pos_id: str = "", paid_start: str = "", paid_end: str = "",
                   page: int = 1, per_page: int = 200) -> list[dict]:
        """Тухайн POS-ийн төлсөн огнооны хязгаар доторх ЗАХИАЛГУУД.

        posOrderRecords биш posOrders — эхнийх нь захиалгын МӨР (нэг захиалга
        олон мөр) буцаадаг тул тоолоход тохирохгүй."""
        s = self._day_bounds(paid_start)[0] if paid_start else None
        e = self._day_bounds(paid_end)[1] if paid_end else None
        q = """
        query($posId:String, $s:Date, $e:Date, $page:Int, $perPage:Int){
          posOrders(posId:$posId, paidStartDate:$s, paidEndDate:$e,
                    page:$page, perPage:$perPage) {
            _id number paidDate totalAmount
          }
        }"""
        data = self.gql(q, {"posId": pos_id or None, "s": s, "e": e,
                            "page": page, "perPage": per_page})
        return data.get("posOrders") or []

    def pos_orders_all(self, pos_id: str = "", paid_start: str = "", paid_end: str = "",
                       page_size: int = 200, max_pages: int = 40,
                       on_day=None) -> list[dict]:
        """Хугацаанд байгаа БҮХ захиалгыг ӨДӨР ТУС БҮРЭЭР татна.

        Яагаад өдрөөр хуваадаг вэ: erxes-ийн сервер олон хоногийн хүсэлтэд
        504 Gateway Timeout өгдөг (туршилтаар тогтоосон). Нэг өдөр ~1 секунд
        тул хуваахад найдвартай бөгөөд явцыг ч харуулах боломжтой.

        on_day(day, count) дуудагдвал явцыг мэдээлнэ."""
        from datetime import date as _date, timedelta as _td

        try:
            d0 = _date.fromisoformat((paid_start or "")[:10])
            d1 = _date.fromisoformat((paid_end or "")[:10])
        except ValueError:
            raise ErxesError("Огноо буруу — 'YYYY-MM-DD' хэлбэрээр өгнө үү.")
        if d1 < d0:
            d0, d1 = d1, d0

        out: list[dict] = []
        seen: set[str] = set()
        day = d0
        while day <= d1:
            ds = day.isoformat()
            day_rows: list[dict] = []
            for page in range(1, max_pages + 1):
                batch = self.pos_orders(pos_id, ds, ds, page=page, per_page=page_size)
                if not batch:
                    break
                day_rows += batch
                if len(batch) < page_size:
                    break
            for o in day_rows:
                oid = o.get("_id")
                if oid and oid not in seen:
                    seen.add(oid)
                    out.append(o)
            if on_day:
                try:
                    on_day(ds, len(day_rows))
                except Exception:
                    pass
            day += _td(days=1)
        return out

    def check_synced(self, ids: list[str], chunk: int = 100) -> list[dict]:
        """Захиалгууд sync хийгдсэн эсэх. Их хэмжээний id-г багцлан асууна."""
        if len(ids) > chunk:
            out: list[dict] = []
            for i in range(0, len(ids), chunk):
                out += self._check_synced(ids[i:i + chunk])
            return out
        return self._check_synced(ids)

    def _check_synced(self, ids: list[str]) -> list[dict]:
        """Захиалгууд Эрхэт рүү sync хийгдсэн эсэхийг шалгана."""
        if not ids:
            return []
        q = """
        mutation($ids:[String]){
          toCheckSynced(ids:$ids) { _id isSynced syncedDate syncedBillNumber }
        }"""
        data = self.gql(q, {"ids": ids})
        return data.get("toCheckSynced") or []

    def sync_orders(self, order_ids: list[str]) -> Any:
        """Захиалгуудыг Эрхэт рүү татаж sync хийнэ."""
        if not order_ids:
            return None
        data = self.gql("mutation($ids:[String]){ toSyncOrders(orderIds:$ids) }",
                        {"ids": order_ids})
        return data.get("toSyncOrders")


_client: ErxesClient | None = None
_client_lock = threading.Lock()


def get_client() -> ErxesClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = ErxesClient()
        return _client
