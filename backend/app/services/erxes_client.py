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


class ErxesCancelled(RuntimeError):
    """Хэрэглэгч ажиллагааг цуцалсан — АЛДАА БИШ.

    ErxesError-оос удамшуулаагүй нь санаатай: `except ErxesError` барьж
    502 буцаадаг газрууд цуцлалтыг алдаа мэт харуулахгүй байх ёстой."""


class ErxesClient:
    """Session/токеноо дахин ашиглана; хугацаа дуусахад автоматаар дахин нэвтэрнэ."""

    def __init__(self, url: str = "", email: str = "", password: str = "", timeout: int = 120):
        base = (url or settings.erxes_url or "").rstrip("/")
        self.endpoint = base if base.endswith("/graphql") else f"{base}/graphql"
        self.email = email or settings.erxes_email
        self.password = password or settings.erxes_password
        self.timeout = timeout
        self._s: requests.Session | None = None
        self._lock = threading.Lock()                 # зөвхөн нэвтрэлт/session солиход
        # erxes рүү зэрэг явах хүсэлтийн дээд хязгаар — олон хэрэглэгч зэрэг
        # дуудахад erxes-ийг дарахгүй, гэхдээ БҮГД нэг lock-д мөр дараалж гацахгүй.
        self._inflight = threading.BoundedSemaphore(4)

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
        """GraphQL хүсэлт. 'Login required' гарвал нэг удаа дахин нэвтэрнэ.

        АНХААР: сүлжээний дуудлагыг lock ДОТОР хийхгүй. Өмнө нь `with self._lock:`
        дотроос retry хийхдээ gql()-ийг дахин дуудаж, реентрант биш Lock-ийг өөрөө
        өөрөөсөө хүлээж БҮРМӨСӨН гацдаг байсан (2026-09-18: 100 thread + бүх DB
        pool холболт erxes-ийн нэг lock-д гацаж сервер бүхэлдээ зогссон)."""
        with self._lock:
            s = self._session()
        with self._inflight:
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
                with self._lock:
                    if self._s is s:          # өөр thread аль хэдийн шинэчилсэн бол дахин нэвтрэхгүй
                        self._s = None
                return self.gql(query, variables, retry=False)
            raise ErxesError(msg[:200])
        return j.get("data") or {}

    def _is_transient(self, e: Exception) -> bool:
        """erxes-ийн сервер ачаалалтай үед 504/timeout өгдөг — түр зуурын алдаа."""
        s = str(e)
        return ("504" in s or "Gateway Time-out" in s or "timed out" in s.lower()
                or "502" in s or "Bad Gateway" in s)

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
                       on_day=None, should_cancel=None) -> list[dict]:
        """Хугацаанд байгаа БҮХ захиалгыг ӨДӨР ТУС БҮРЭЭР татна.

        Яагаад өдрөөр хуваадаг вэ: erxes-ийн сервер олон хоногийн хүсэлтэд
        504 Gateway Timeout өгдөг (туршилтаар тогтоосон). Нэг өдөр ~1 секунд
        тул хуваахад найдвартай бөгөөд явцыг ч харуулах боломжтой.

        on_day(day, count) дуудагдвал явцыг мэдээлнэ.
        should_cancel() True буцаавал ErxesCancelled шиднэ — хуудас бүрийн
        завсарт шалгадаг тул хэрэглэгч хэдэн секундэд зогсоох боломжтой."""
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
                if should_cancel and should_cancel():
                    raise ErxesCancelled("Шалгалт цуцлагдлаа")
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

    def pos_order_ids(self, pos_id: str, day: str, page_size: int = 1000,
                      max_pages: int = 20, should_cancel=None) -> list[str]:
        """Тухайн ӨДРИЙН захиалгын id-ууд — зөвхөн `_id` талбар.

        Яагаад тусад нь вэ: perPage-ийг өсгөж, талбарын тоог багасгахад
        эрс хурдасдаг. 942 захиалгыг хэмжихэд —
            perPage=200,  4 талбар : 43.3 сек
            perPage=500,  1 талбар : 17.7 сек
            perPage=1000, 1 талбар :  9.0 сек
        Тулгалт/sync шалгалтад id-аас өөр юм хэрэггүй тул хамгийн хурдныг
        нь ашиглана."""
        s, e = self._day_bounds(day)
        q = ("query($posId:String,$s:Date,$e:Date,$pg:Int,$pp:Int){"
             " posOrders(posId:$posId, paidStartDate:$s, paidEndDate:$e,"
             " page:$pg, perPage:$pp){ _id } }")
        out: list[str] = []
        for page in range(1, max_pages + 1):
            if should_cancel and should_cancel():
                raise ErxesCancelled("Шалгалт цуцлагдлаа")
            data = self.gql(q, {"posId": pos_id or None, "s": s, "e": e,
                                "pg": page, "pp": page_size})
            batch = data.get("posOrders") or []
            out += [o["_id"] for o in batch if o.get("_id")]
            if len(batch) < page_size:
                break
        return out

    def pos_orders_count(self, pos_id: str = "", paid_start: str = "",
                         paid_end: str = "") -> int:
        """Хугацаанд төлөгдсөн захиалгын ТОО.

        pos_orders_all-аас олон дахин хурдан — бүх мөрийг 200-гаар хуудаслан
        татахгүй, зөвхөн тоог асууна. Тоо тулгалтад мөр биш тоо л хэрэгтэй."""
        s = self._day_bounds(paid_start)[0] if paid_start else None
        e = self._day_bounds(paid_end)[1] if paid_end else None
        q = ("query($posId:String,$s:Date,$e:Date){ posOrdersTotalCount("
             "posId:$posId, paidStartDate:$s, paidEndDate:$e) }")
        data = self.gql(q, {"posId": pos_id or None, "s": s, "e": e})
        return int(data.get("posOrdersTotalCount") or 0)

    def check_synced(self, ids: list[str], chunk: int = 100,
                     should_cancel=None) -> list[dict]:
        """Захиалгууд sync хийгдсэн эсэх. Их хэмжээний id-г багцлан асууна.

        erxes ачаалалтай үед 504 өгдөг тул алдаа гарсан багцыг ХОЁР ХУВААН
        дахин оролдоно (25 хүртэл). Ингэснээр бүтэн өдрийн ~1,800 гүйлгээг
        ч найдвартай шалгана.

        should_cancel() True буцаавал багц хооронд зогсоно."""
        out: list[dict] = []
        for i in range(0, len(ids), chunk):
            if should_cancel and should_cancel():
                raise ErxesCancelled("Шалгалт цуцлагдлаа")
            out += self._check_chunk(ids[i:i + chunk])
        return out

    def _check_chunk(self, ids: list[str], min_size: int = 25) -> list[dict]:
        if not ids:
            return []
        try:
            return self._check_synced(ids)
        except Exception as e:
            if not self._is_transient(e) or len(ids) <= min_size:
                if self._is_transient(e):
                    print(f"[erxes] {len(ids)} id шалгаж чадсангүй — алгасав")
                    return []
                raise
            mid = len(ids) // 2
            print(f"[erxes] 504 — {len(ids)} багцыг хуваан дахин оролдож байна")
            return self._check_chunk(ids[:mid], min_size) + self._check_chunk(ids[mid:], min_size)

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

    # ── Е-баримтын буцаалт / устгал ──────────────────────────────────
    # putResponses = Е-баримтын бичлэг. Буцаалтын бичлэг нь `id` ХООСОН,
    # `inactiveId` ДҮҮРЭН байдаг (эх баримтыг идэвхгүй болгосон). erxes-ийн
    # /put-responses хуудас эдгээрийг billIdRule="01"-ээр шүүдэг — бусад
    # утга (02, 03, хоосон) огт шүүлт хийхгүй тул зөвхөн энэ утга ажиллана.
    RETURN_RULE = "01"

    _PR_FIELDS = (
        "_id number contentType contentId totalAmount type status "
        "inactiveId id date createdAt modifiedAt userId "
        "user { _id username email details { fullName } }"
    )
    _PR_DECL = ("$page:Int,$perPage:Int,$search:String,$billIdRule:String,"
                "$contentType:String,$createdStartDate:Date,$createdEndDate:Date")
    _PR_PASS = ("page:$page,perPage:$perPage,search:$search,billIdRule:$billIdRule,"
                "contentType:$contentType,createdStartDate:$createdStartDate,"
                "createdEndDate:$createdEndDate")

    @staticmethod
    def _pr_bounds(start_day: str, end_day: str = "") -> tuple[str, str]:
        """'YYYY-MM-DD' → erxes-ийн хүлээж авдаг 'YYYY-MM-DD HH:MM' хязгаар.

        Төгсгөлийг ДАРААГИЙН өдрийн 00:00 болгоно — эс тэгвээс сүүлийн
        өдрийн бичлэгүүд орхигдоно (erxes-ийн UI ч яг ингэдэг)."""
        from datetime import date as _date, timedelta as _td
        try:
            s = _date.fromisoformat((start_day or "")[:10])
            e = _date.fromisoformat((end_day or start_day or "")[:10])
        except ValueError:
            raise ErxesError("Огноо буруу — 'YYYY-MM-DD' хэлбэрээр өгнө үү.")
        if e < s:
            s, e = e, s
        return f"{s.isoformat()} 00:00", f"{(e + _td(days=1)).isoformat()} 00:00"

    def put_responses(self, start_day: str, end_day: str = "",
                      bill_id_rule: str | None = None, search: str | None = None,
                      content_type: str | None = None,
                      page: int = 1, per_page: int = 200) -> list[dict]:
        """Е-баримтын бичлэгүүд.

        Огнооны шүүлт нь БИЧЛЭГ үүссэн огноогоор ажиллана — өөрөөр хэлбэл
        буцаалт хайхад ЗАХИАЛГЫН биш БУЦААСАН өдрөөр шүүгдэнэ."""
        a, b = self._pr_bounds(start_day, end_day)
        q = "query putResponses(%s){ putResponses(%s){ %s } }" % (
            self._PR_DECL, self._PR_PASS, self._PR_FIELDS)
        data = self.gql(q, {
            "page": page, "perPage": per_page, "search": search,
            "billIdRule": bill_id_rule, "contentType": content_type,
            "createdStartDate": a, "createdEndDate": b,
        })
        return data.get("putResponses") or []

    @staticmethod
    def _who(row: dict) -> str:
        """Бичлэг хийсэн хүний харагдах нэр."""
        u = row.get("user") or {}
        d = u.get("details") or {}
        return (str(d.get("fullName") or "").strip()
                or u.get("email") or u.get("username")
                or (f"userId={row['userId']}" if row.get("userId") else "—"))

    def pos_returns(self, start_day: str, end_day: str = "", enrich: bool = True,
                    max_enrich: int = 60, lookback: int = 45) -> list[dict]:
        """Тухайн хугацаанд ХИЙГДСЭН буцаалт/устгалууд — хэн хийсэн нь оруулаад.

        Буцаалтын бичлэгт дүн байдаггүй тул эх баримтыг дугаараар хайж
        дүн болон анхны кассчинг нөхнө. Дугаар POS хооронд ДАВХЦДАГ тул
        contentId-аар тааруулна — зөвхөн дугаараар тааруулбал өөр POS-ийн
        баримтын дүн орж ирнэ (туршилтаар тогтоосон).

        Эх баримт буцаалтаас ӨМНӨХ өдөр үүссэн байж болох тул хайлтын
        цонхыг lookback хоногоор ухраана."""
        from datetime import date as _date, timedelta as _td

        rows = self.put_responses(start_day, end_day, bill_id_rule=self.RETURN_RULE)
        out = [{
            "_id": r.get("_id"),
            "number": r.get("number"),
            "content_id": r.get("contentId"),
            "content_type": r.get("contentType"),
            "inactive_id": r.get("inactiveId"),
            "returned_at": r.get("createdAt"),
            "returned_by": self._who(r),
            "status": r.get("status"),
            "amount": None,
            "cashier": "",
        } for r in rows]

        if not enrich or not out:
            return out
        try:
            back = (_date.fromisoformat(start_day[:10]) - _td(days=lookback)).isoformat()
        except ValueError:
            return out
        for item in out[:max_enrich]:
            num = item.get("number")
            if not num:
                continue
            try:
                cand = self.put_responses(back, end_day or start_day,
                                          search=num, per_page=20)
            except Exception:
                continue          # нөхөх нь заавал биш — буцаалт нь өөрөө чухал
            for c in cand:
                if c.get("contentId") == item["content_id"] and c.get("id"):
                    item["amount"] = c.get("totalAmount")
                    item["cashier"] = self._who(c)
                    break
        return out


_client: ErxesClient | None = None
_client_lock = threading.Lock()


def get_client() -> ErxesClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = ErxesClient()
        return _client
