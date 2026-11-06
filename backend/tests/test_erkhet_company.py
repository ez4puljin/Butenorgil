"""Эрхэтийн компани нь нэвтрэлтийн чиглүүлэлтээс биш, зөвхөн тохиргооноос — сүлжээг mock хийнэ."""
from types import SimpleNamespace

import pytest

from app.services import erkhet_client as ec

GOOD, OTHER = "9514593312", "8722884653"


class FakeSession:
    """Нэвтрэхэд OTHER компани руу чиглүүлдэг Эрхэт."""
    home_url = None
    home_status = 200

    def __init__(self):
        self.headers, self.cookies, self.urls = {}, {"csrftoken": "t"}, []

    def get(self, url, **kw):
        self.urls.append(url)
        if url.endswith("/login/"):
            return SimpleNamespace(url=url, status_code=200, text="")
        return SimpleNamespace(url=self.home_url or url, status_code=self.home_status, text="")

    def post(self, url, **kw):
        return SimpleNamespace(url=f"https://erkhet.test/{OTHER}/?sm=true", status_code=200, text="")


@pytest.fixture
def client(monkeypatch):
    FakeSession.home_url, FakeSession.home_status = None, 200
    monkeypatch.setattr(ec.requests, "Session", FakeSession)
    monkeypatch.setattr(ec.settings, "erkhet_company_id", GOOD)
    return ec.ErkhetClient(base_url="https://erkhet.test", username="u", password="p")


def test_ignores_login_redirect_company(client):
    assert client.company_id == GOOD
    assert client._url("inventory/trs/") == f"https://erkhet.test/{GOOD}/inventory/trs/"


def test_refuses_without_configured_company(client, monkeypatch):
    monkeypatch.setattr(ec.settings, "erkhet_company_id", "")
    with pytest.raises(ec.ErkhetError, match="ERKHET_COMPANY_ID"):
        client.company_id


@pytest.mark.parametrize("url,status", [(f"https://erkhet.test/{OTHER}/", 200), ("https://erkhet.test/login/", 200),
                                        (f"https://erkhet.test/{GOOD}/", 403)])
def test_refuses_when_company_not_reachable(client, url, status):
    FakeSession.home_url, FakeSession.home_status = url, status
    with pytest.raises(ec.ErkhetError, match=GOOD):
        client.company_id
    assert client._s is None                                            # session хадгалагдахгүй
