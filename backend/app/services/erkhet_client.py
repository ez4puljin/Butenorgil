"""Эрхэт (erkhet.bto.mn) — HTTP session клиент.

Эрхэт нь Django систем бөгөөд нээлттэй REST API-гүй. Гэвч нэвтрэлт нь энгийн
session cookie, тайлан нь form POST-оор үүсдэг тул browser (Playwright)-гүйгээр
шууд HTTP-ээр ажиллуулж болно.

Хэмжилт (2026-08, бодит систем):
    Playwright (erkhet-automation)  : ~199 сек / тайлан
    Энэ HTTP клиент                 : ~4 сек / тайлан
    (нэвтрэх 1.9с + формын хуудас 0.4с + тайлан 2с)

Санамж: албан ёсны API биш тул Эрхэт вэбээ өөрчлөхөд эвдэрч болзошгүй.
Формын талбарын нэрээс хамаардаг (DOM бүтцээс биш) тул Playwright-аас
арай тогтвортой.

Хэрэглээ:
    from app.services.erkhet_client import get_client
    c = get_client()
    opts = c.form_options("inventory/report/generate-remainder/")
    rows = c.report_table("inventory/report/generate-remainder/", {
        "account": "40", "get_kind": "location_account",
        "fraction": "2", "inv_location": ["1"],
    })

⚠️ Тайлангийн хамрах хүрээг ХЭТ ӨРГӨН тавьвал сервер удаан боловсруулж
timeout болно (5 байршлыг зэрэг асуухад 240с-д ч дуусаагүй). Байршил/бренд
тус бүрээр хуваан татах нь найдвартай.
"""
from __future__ import annotations

import re
import threading
import time

from typing import Iterable

import requests

from app.core.config import settings

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


class ErkhetError(RuntimeError):
    pass


# ── HTML тусламжууд ──────────────────────────────────────────────────────────

def _text(raw: str) -> str:
    """Тэг арилгаж, HTML entity (&nbsp; г.м) задалж, зай цэвэрлэнэ."""
    import html as _html
    s = _html.unescape(re.sub(r"<[^>]+>", " ", raw))
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def _rows_from_html(raw: str) -> list[list[str]]:
    """Бүх <tr>-ийг нүдээр нь задална.

    Эрхэтийн тайлангийн HTML нь эмх замбараагүй (толгойн мөр хүснэгтийн гадна,
    <th> огт байхгүй, таг хаагдаагүй) тул HTMLParser-ийн оронд regex ашиглана —
    ингэснээр таг үүрлэлтээс үл хамааран мөрүүд гарна."""
    rows: list[list[str]] = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", raw, re.S | re.I):
        cells = [_text(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)]
        if any(cells):
            rows.append(cells)
    return rows


def _header_from_html(raw: str) -> list[str]:
    """<thead> доторх нүднүүдийг гаргана.

    Эрхэт нь <thead> дотор <tr>-гүйгээр <td>-г шууд бичдэг (стандарт бус) тул
    энгийн мөрийн задлагчид олдохгүй — тусад нь хайна."""
    m = re.search(r"<thead[^>]*>(.*?)</thead>", raw, re.S | re.I)
    if not m:
        return []
    cells = [_text(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", m.group(1), re.S | re.I)]
    return cells if any(cells) else []


def _is_header(row: list[str]) -> bool:
    """Толгойн мөр эсэх — цэвэр тоо агуулаагүй, ихэнх нүд нь текст."""
    filled = [c for c in row if c]
    if not filled or len(filled) < max(2, len(row) // 2):
        return False
    return not any(re.fullmatch(r"[\d\s.,-]+", c) for c in filled)


# ── Клиент ───────────────────────────────────────────────────────────────────

class ErkhetClient:
    """Session-ээ дахин ашигладаг, хугацаа дуусахад автоматаар дахин нэвтэрдэг."""

    def __init__(self, base_url: str = "", username: str = "", password: str = "",
                 timeout: int = 180):
        self.base = (base_url or settings.erkhet_url or "").rstrip("/")
        self.user = username or settings.erkhet_username
        self.pwd = password or settings.erkhet_password
        self.timeout = timeout
        self._s: requests.Session | None = None
        self._cid = ""
        self._lock = threading.Lock()

    # ── нэвтрэлт ─────────────────────────────────────────────────────
    def _do_login(self) -> None:
        if not (self.base and self.user and self.pwd):
            raise ErkhetError(
                "Эрхэтийн тохиргоо дутуу. backend/.env-д ERKHET_URL, "
                "ERKHET_USERNAME, ERKHET_PASSWORD нэмнэ үү."
            )
        s = requests.Session()
        s.headers.update({"User-Agent": _UA})
        login_url = f"{self.base}/login/"
        s.get(login_url, timeout=30)
        # CSRF token нь формд hidden input байхгүй — cookie-оос авна
        token = s.cookies.get("csrftoken", "")
        r = s.post(
            login_url,
            data={"csrfmiddlewaretoken": token, "login_with": self.user, "password": self.pwd},
            headers={"Referer": login_url, "Origin": self.base},
            timeout=60,
        )
        if "/login" in r.url:
            raise ErkhetError("Эрхэтэд нэвтэрч чадсангүй — нэр/нууц үгээ шалгана уу.")
        m = re.search(r"^https?://[^/]+/(\d+)/", r.url)
        self._cid = m.group(1) if m else (settings.erkhet_company_id or "")
        if not self._cid:
            raise ErkhetError("Компанийн ID тодорхойлж чадсангүй.")
        self._s = s

    def _session(self) -> requests.Session:
        if self._s is None:
            self._do_login()
        return self._s  # type: ignore[return-value]

    @property
    def company_id(self) -> str:
        self._session()
        return self._cid

    def _url(self, path: str) -> str:
        return f"{self.base}/{self.company_id}/{path.lstrip('/')}"

    def _get(self, path: str, retry: bool = True) -> requests.Response:
        s = self._session()
        r = s.get(self._url(path), timeout=self.timeout)
        if retry and ("/login" in r.url or r.status_code in (401, 403)):
            self._s = None                      # session дууссан — дахин нэвтэрнэ
            return self._get(path, retry=False)
        return r

    # ── формын сонголтууд ────────────────────────────────────────────
    def form_options(self, path: str) -> dict[str, list[tuple[str, str]]]:
        """Тайлангийн формын select бүрийн (утга, шошго) жагсаалт.

        Тайлан татахын өмнө ямар данс/байршил/брендийн ID байгааг мэдэхэд."""
        with self._lock:
            html = self._get(path).text
        out: dict[str, list[tuple[str, str]]] = {}
        for m in re.finditer(r'<select[^>]*name="([^"]+)"[^>]*>(.*?)</select>', html, re.S):
            opts = [
                (v, _text(t))
                for v, t in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>(.*?)</option>',
                                       m.group(2), re.S)
                if v
            ]
            if opts:
                out[m.group(1)] = opts
        return out

    def find_option(self, path: str, field: str, prefix: str) -> str:
        """Шошго нь prefix-ээр эхэлдэг сонголтын утгыг олно
        (жишээ: field='account', prefix='150101' → '40')."""
        for v, label in self.form_options(path).get(field, []):
            if label.startswith(prefix):
                return v
        return ""

    # ── тайлан ───────────────────────────────────────────────────────
    def report_html(self, path: str, params: dict[str, str | Iterable[str]],
                    timeout: int | None = None) -> str:
        """Тайлангийн формыг POST хийж, буцаж ирсэн HTML-ийг өгнө."""
        with self._lock:
            s = self._session()
            url = self._url(path)
            # CSRF token шинэчлэхийн тулд формын хуудсыг эхлээд дуудна
            self._get(path)
            payload: list[tuple[str, str]] = [
                ("csrfmiddlewaretoken", s.cookies.get("csrftoken", "")),
            ]
            for k, v in params.items():
                if isinstance(v, (list, tuple, set)):
                    payload += [(k, str(x)) for x in v if str(x) != ""]
                elif str(v) != "":
                    payload.append((k, str(v)))
            t0 = time.time()
            r = s.post(url, data=payload,
                       headers={"Referer": url, "Origin": self.base},
                       timeout=timeout or self.timeout)
            if "/login" in r.url:
                raise ErkhetError("Session дууссан байна — дахин оролдоно уу.")
            r.raise_for_status()
            print(f"[erkhet] {path} -> {len(r.content)/1024:.0f}KB, {time.time()-t0:.1f}s")
            return r.text

    def report_table(self, path: str, params: dict[str, str | Iterable[str]]) -> list[dict]:
        """Тайланг задалж, толгойн нэрээр түлхүүрлэсэн мөрүүд болгож буцаана.

        Эрхэт нь толгойг тусдаа <table>-д (тогтмол толгой) байрлуулдаг тул
        зөвхөн эхний мөрийг толгой гэж үзэлгүй, бүх хүснэгтээс тохирох
        баганын тоотой толгойн мөрийг хайна."""
        raw = self.report_html(path, params)
        all_rows = _rows_from_html(raw)
        if not all_rows:
            return []

        # Дата мөрүүд = хамгийн түгээмэл баганын тоотой, толгой биш мөрүүд
        from collections import Counter
        ncol = Counter(len(r) for r in all_rows).most_common(1)[0][0]
        body = [r for r in all_rows if len(r) == ncol and not _is_header(r)]
        if not body:
            return []

        # Толгой — эхлээд <thead>-ээс, дараа нь мөрүүдээс хайна.
        # ncol-1 бол дата мөрд мөрийн дугаарын багана нэмэгдсэн гэсэн үг.
        head: list[str] = []
        for cand in [_header_from_html(raw)] + [r for r in all_rows if _is_header(r)]:
            if len(cand) == ncol:
                head = list(cand)
            elif len(cand) == ncol - 1:
                head = ["№"] + list(cand)
            if head:
                break
        if not head:
            head = [f"col{i}" for i in range(ncol)]
        # Хоосон толгойн нэрийг нөхнө (эхнийх нь ихэвчлэн мөрийн дугаар)
        head = [h or ("№" if i == 0 else f"col{i}") for i, h in enumerate(head)]

        out = []
        for r in body:
            if r == head:
                continue
            if len(r) < len(head):
                r = r + [""] * (len(head) - len(r))
            out.append({(head[i] or f"col{i}"): r[i] for i in range(len(head))})
        return out


    def report_excel(self, path: str, params: dict[str, str | Iterable[str]],
                     timeout: int | None = None) -> bytes:
        """Тайланг Эрхэтийн ӨӨРИЙНХ нь Excel (.xls) хэлбэрээр татна.

        Эрхэтийн "Excel файл" товч нь хүснэгтийг JSON болгож
        POST /reports/to-excel/ рүү илгээдэг. Тэр JS-ийн логикийг яг давтана —
        ингэснээр гараар татсантай ЯГ ижил бүтэцтэй файл гарна (ERP-ийн
        одоогийн задлагч өөрчлөх шаардлагагүй)."""
        import json

        raw = self.report_html(path, params, timeout=timeout)

        # JS: $('table tr').each → children('td, th') → {text, colspan, rowspan}
        rows: list[list[dict]] = []
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", raw, re.S | re.I):
            row: list[dict] = []
            for cell in re.finditer(r"<(td|th)([^>]*)>(.*?)</\1>", tr, re.S | re.I):
                attrs = cell.group(2)
                cs = re.search(r"colspan=[\"']?(\d+)", attrs, re.I)
                rs = re.search(r"rowspan=[\"']?(\d+)", attrs, re.I)
                row.append({
                    "text": _text(cell.group(3)),
                    "colspan": int(cs.group(1)) if cs else 1,
                    "rowspan": int(rs.group(1)) if rs else 1,
                })
            rows.append(row)
        if not rows:
            raise ErkhetError("Тайлан хоосон байна — параметрээ шалгана уу.")

        nm = re.search(r'name="report_name"\s+value="([^"]*)"', raw)
        report_name = nm.group(1) if nm else "Тайлан"

        with self._lock:
            s = self._session()
            url = f"{self.base}/{self._cid}/reports/to-excel/"
            r = s.post(
                url,
                data={
                    "csrfmiddlewaretoken": s.cookies.get("csrftoken", ""),
                    "data": json.dumps(rows, ensure_ascii=False),
                    "report_name": report_name,
                },
                headers={"Referer": self.base, "Origin": self.base},
                timeout=timeout or self.timeout,
            )
            r.raise_for_status()
            if b"<html" in r.content[:400].lower():
                raise ErkhetError("Excel-ийн оронд HTML ирлээ — session дууссан байж магадгүй.")
            print(f"[erkhet] excel: {len(rows)} мөр -> {len(r.content)/1024:.0f}KB")
            return r.content


    # ── Файл импорт (Файл импортлох → /import/create/) ───────────────
    # Эрхэт импортыг ШУУД биш «Ажлын захиалга» (/queue/) дараалалд оруулдаг:
    #   илгээмэгц queue-д мөр нэмэгдэнэ → хэдэн секунд/минутын дараа ажиллаж
    #   «Амжилттай ажилласан» / «Буруу өгөгдөл» / «Алдаа гарсан» болно (Үр дүн баганад
    #   шалтгаан). Амжилттай бол /import/ жагсаалтад «Амжилттай импорт» гарна.
    # Огноо нь клиентийн ИДЭВХТЭЙ ТАЙЛАНТ ҮЕД багтах ёстой («date: Идэвхтэй тайлант
    # үед хамаарахгүй байна») тул илгээхийн өмнө тайлант үеийг огнооны онд тааруулна.
    QUEUE_OK = "Амжилттай ажилласан"
    QUEUE_FAIL = ("Буруу өгөгдөл", "Алдаа гарсан")
    IMPORT_OK_STATUS = "Амжилттай импорт"

    def current_period(self) -> tuple[str, str]:
        """(идэвхтэй тайлант үе (он) эсвэл "", хадгалах URL)."""
        with self._lock:
            html = self._get("import/create/").text
        m = re.search(r'<select[^>]*class="[^"]*period-year[^"]*"[^>]*>', html)
        if not m:
            raise ErkhetError("Эрхэтийн тайлант үеийн сонголт олдсонгүй.")
        tag = m.group(0)
        cur = re.search(r'current="([^"]*)"', tag)
        url = re.search(r'save_url="([^"]+)"', tag)
        cur_v = (cur.group(1) if cur else "").strip()
        return ("" if cur_v in ("", "None") else cur_v), (url.group(1) if url else f"/{self.company_id}/periods/save/")

    def ensure_period(self, year: str) -> dict:
        """Клиентийн идэвхтэй тайлант үеийг `year` болгоно (Эрхэтийн тохиргоо цэсний
        «Тайлант үе сонгох»-той ижил: GET periods/save/?year=…)."""
        cur, save_url = self.current_period()
        if cur == str(year):
            return {"changed": False, "period": cur}
        with self._lock:
            s = self._session()
            r = s.get(self.base + save_url, params={"year": str(year), "period": ""},
                      headers={"X-Requested-With": "XMLHttpRequest", "Referer": self._url("import/create/")},
                      timeout=60)
        after, _ = self.current_period()
        if after != str(year):
            raise ErkhetError(f"Эрхэтийн тайлант үеийг {year} болгож чадсангүй (одоо: {after or 'сонгоогүй'}, HTTP {r.status_code}).")
        print(f"[erkhet] тайлант үе: {cur or '—'} → {after}")
        return {"changed": True, "period": after, "was": cur}

    def queue_rows(self) -> list[dict]:
        """«Ажлын захиалга» (/queue/) — хамгийн сүүлийн мөрүүд."""
        with self._lock:
            s = self._session()
            r = s.get(f"{self.base}/queue/", timeout=60)
            if "/login" in r.url:
                self._s = None
                s = self._session()
                r = s.get(f"{self.base}/queue/", timeout=60)
        out = []
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", r.text, re.S):
            m = re.search(r"/queue/delete/(\d+)/", tr)
            if not m:
                continue
            c = [_text(x) for x in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
            if len(c) < 11:
                continue
            out.append({"id": int(m.group(1)), "created": c[1], "company": c[2], "user": c[3], "kind": c[4],
                        "status": c[5], "started": c[7], "finished": c[8], "title": c[9], "result": c[10]})
        return out

    def find_queue_row(self, title: str, since_local: str = "", queue_id: int = 0) -> dict | None:
        """Гарчгаар (эсвэл queue id-аар) хамгийн сүүлийн мөрийг олно. since_local='YYYY-MM-DD HH:MM'."""
        rows = self.queue_rows()
        if queue_id:
            return next((r for r in rows if r["id"] == queue_id), None)
        cand = [r for r in rows if r["title"] == title.strip() and (not since_local or r["created"] >= since_local)]
        return max(cand, key=lambda r: r["id"]) if cand else None

    @classmethod
    def queue_state(cls, row: dict | None) -> str:
        """ok | fail | queued (дараалалд/ажиллаж байна) | missing"""
        if not row:
            return "missing"
        if row["status"] == cls.QUEUE_OK:
            return "ok"
        if row["status"] in cls.QUEUE_FAIL:
            return "fail"
        return "queued"

    def import_list_find(self, title: str) -> dict | None:
        """/import/ жагсаалтаас гарчиг таарсан хамгийн шинэ мөр (импортын дугаар, баримтын тоо)."""
        with self._lock:
            html = self._get("import/").text
        best = None
        for tid, body in re.findall(r'<tr[^>]*id="(\d+)"[^>]*>(.*?)</tr>', html, re.S):
            cells = [_text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", body, re.S)]
            if len(cells) >= 6 and cells[2] == title.strip():
                if best is None or int(tid) > int(best[0]):
                    best = (tid, cells)
        if not best:
            return None
        tid, cells = best
        return {"import_id": int(tid), "status": cells[4], "count": int(cells[5]) if cells[5].isdigit() else None}

    def import_file(self, title: str, kind: str, filename: str, data: bytes, year: str | int | None = None,
                    wait_sec: int = 25, timeout: int | None = None) -> dict:
        """«Файл импортлох» формоор илгээж, «Ажлын захиалга» (queue)-гаас хянана.

        Буцаах: {"state": ok|fail|queued|missing|unknown, "queue_id", "queue_status", "result",
                 "import_id", "count", "errors", "period"}.
        POST-ыг ХЭЗЭЭ Ч давтахгүй (давхар орлого үүсэхээс сэргийлнэ)."""
        title = title[:200].strip()
        period = self.ensure_period(str(year)) if year else None
        path = "import/create/"
        from datetime import datetime, timedelta
        since = (datetime.now() - timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M")
        with self._lock:
            page = self._get(path)                       # session/CSRF шинэчилнэ
            if "/login" in page.url:
                raise ErkhetError("Эрхэтэд нэвтэрч чадсангүй.")
            # Тайлант үе нь SESSION-д хадгалагддаг — яг энэ session дээр тохирсон эсэхийг
            # илгээхийн өмнө формын хуудаснаас дахин баталгаажуулна (дахин нэвтэрвэл алдагдана).
            if year:
                cm = re.search(r'<select[^>]*class="[^"]*period-year[^"]*"[^>]*current="([^"]*)"', page.text)
                if not cm or cm.group(1) != str(year):
                    raise ErkhetError(f"Эрхэтийн тайлант үе {year} болж тохироогүй байна — импорт илгээгдээгүй. Дахин оролдоно уу.")
            s = self._session()
            url = self._url(path)
            m = re.search(r'name="csrfmiddlewaretoken"[^>]*value="([^"]+)"', page.text)
            token = m.group(1) if m else s.cookies.get("csrftoken", "")
            payload = {"csrfmiddlewaretoken": token, "title": title, "kind": kind, "year": "", "month": ""}
            files = {"f": (filename, data, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
            t0 = time.time()
            try:
                r = s.post(url, data=payload, files=files,
                           headers={"Referer": url, "Origin": self.base},
                           timeout=timeout or max(self.timeout, 300))
            except requests.Timeout:
                r = None
            if r is not None:
                print(f"[erkhet] import {kind} '{title}' -> {r.status_code} {r.url} {time.time()-t0:.1f}s")
                if "/login" in r.url:
                    self._s = None
                    raise ErkhetError("Эрхэтийн session дууссан — импорт хийгдээгүй. Дахин оролдоно уу.")
        # Формын хуудас алдаатай буцсан бол (queue-д ороогүй)
        form_errors: list[str] = []
        if r is not None and not r.url.split("?")[0].rstrip("/").endswith("/import"):
            for pat in (r'<ul[^>]*class="[^"]*errorlist[^"]*"[^>]*>(.*?)</ul>',
                        r'<div[^>]*class="[^"]*alert[^"]*"[^>]*>(.*?)</div>'):
                for blk in re.findall(pat, r.text, re.S | re.I):
                    t = _text(blk)
                    if t and t not in form_errors:
                        form_errors.append(t)
        # Queue-д мөр нэмэгдсэн эсэх, дуусах хүртэл богино хугацаанд хүлээнэ
        row = None
        deadline = time.time() + wait_sec
        while True:
            try:
                row = self.find_queue_row(title, since)
            except Exception as e:                        # noqa: BLE001
                print(f"[erkhet] queue уншихад алдаа: {e}")
            st = self.queue_state(row)
            if st in ("ok", "fail") or time.time() >= deadline:
                break
            time.sleep(3)
        out = self._result_from_row(row, title)
        out["period"] = period
        if out["state"] == "missing":
            out["state"] = "fail" if form_errors else "unknown"
            out["errors"] = form_errors or ["Эрхэтийн «Ажлын захиалга»-д энэ гарчигтай мөр олдсонгүй — импорт илгээгдээгүй байж магадгүй."]
        return out

    def _result_from_row(self, row: dict | None, title: str) -> dict:
        st = self.queue_state(row)
        out = {"state": st, "queue_id": row["id"] if row else None, "queue_status": row["status"] if row else "",
               "result": row["result"] if row else "", "import_id": None, "count": None, "errors": []}
        if st == "fail":
            out["errors"] = [row["result"] or row["status"]]
        if st == "ok":
            try:
                imp = self.import_list_find(title)
                if imp:
                    out["import_id"], out["count"] = imp["import_id"], imp["count"]
            except Exception as e:                        # noqa: BLE001
                print(f"[erkhet] import жагсаалт уншихад алдаа: {e}")
        return out

    def refresh_import(self, title: str, queue_id: int = 0, since_local: str = "") -> dict:
        """Өмнө илгээсэн импортын одоогийн төлөвийг queue-ээс дахин уншина."""
        row = self.find_queue_row(title, since_local, queue_id)
        return self._result_from_row(row, title)


# ── Дундын instance (session дахин ашиглана) ─────────────────────────────────
_client: ErkhetClient | None = None
_client_lock = threading.Lock()


def get_client() -> ErkhetClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = ErkhetClient()
        return _client
