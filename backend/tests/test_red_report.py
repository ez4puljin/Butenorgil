"""Улайлтын тайлан — сонгосон байршлыг л татах (app/services/erkhet_red_report), Эрхэтийг mock хийнэ."""
import pytest

from app.services import erkhet_client, erkhet_red_report as svc

LOCS = [{"id": "1", "code": "01", "name": "Бөөний"}, {"id": "2", "code": "11", "name": "Жижиглэн"},
        {"id": "3", "code": "12", "name": "Гэрээт"}]


def item(code, qty=-1):
    return {"location": code, "location_name": code, "code": f"p{code}", "name": "Б", "qty": qty, "amount": qty * 10.0,
            "unit_cost": 10, "begin_qty": 0, "in_qty": 0, "out_qty": 0}


class FakeClient:
    def __init__(self):
        self.asked, self.fail = [], set()

    def find_option(self, *a):
        return "40"

    def report_excel(self, path, params, timeout=None):
        loc = params["inv_location"][0]
        self.asked.append(loc)
        if loc in self.fail:
            raise RuntimeError("500")
        return loc.encode()


@pytest.fixture
def client(monkeypatch, tmp_path):
    c = FakeClient()
    monkeypatch.setattr(svc, "RESULT_FILE", tmp_path / "r.json")
    monkeypatch.setattr(svc, "locations", lambda: LOCS)
    monkeypatch.setattr(svc.time, "sleep", lambda s: None)
    monkeypatch.setattr(erkhet_client, "get_client", lambda: c)
    monkeypatch.setattr(svc, "parse", lambda data, locs: [item(next(iter(locs)))])
    monkeypatch.setitem(svc._state, "running", False)
    monkeypatch.setitem(svc._state, "error", "")
    return c


def age(code):
    res = svc.load_result()
    res["location_checked"][code] = "2020-01-01T00:00:00Z"
    svc.RESULT_FILE.write_text(svc.json.dumps(res), encoding="utf-8")


def test_only_selected_locations_are_asked(client):
    svc._run(["01", "12"])
    assert client.asked == ["1", "3"]
    v = svc.view(svc.load_result(), ["01", "12"])
    assert [x["code"] for x in v["locations"]] == ["01", "12"]
    assert (v["count"], v["by_location"]) == (2, {"01": 1, "12": 1})


def test_recent_location_is_reused_and_others_survive(client):
    svc._run(["01"])
    client.asked.clear()
    svc._run(["01", "11"])
    assert client.asked == ["2"]                                    # 01 нь 5 минутын дотор татагдсан
    svc._run(["12"])
    res = svc.load_result()
    assert sorted(res["location_checked"]) == ["01", "11", "12"]    # өөр хүний татлага дарагдахгүй
    assert [i["location"] for i in svc.view(res, ["11"])["items"]] == ["11"]


def test_stale_location_is_fetched_again(client):
    svc._run(["01"])
    age("01")
    client.asked.clear()
    svc._run(["01"])
    assert client.asked == ["1"]


def test_failed_location_drops_old_items_and_reports(client):
    svc._run(["01", "11"])
    age("11")
    client.fail = {"2"}
    svc._run(["01", "11"])
    v = svc.view(svc.load_result(), ["01", "11"])
    assert [i["location"] for i in v["items"]] == ["01"] and "11" in v["errors"]


def test_all_failed_sets_error_and_clears_running(client):
    client.fail = {"1"}
    assert svc._run(["01"])["error"]
    st = svc.status()
    assert st["running"] is False and st["error"]


def test_view_without_data_is_none():
    assert svc.view(None, ["01"]) is None
    assert svc.view({"locations": [], "items": [], "errors": {}}, ["01"]) is None
