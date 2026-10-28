"""AI туслах (app/ai/chat) — Claude-ийн streaming-ийг mock хийж tool loop, эрх, хязгаарыг шалгана."""
from types import SimpleNamespace

import anthropic
import pytest
from sqlalchemy import text

from app.ai import chat, chat_tools, readonly_db
from app.ai import client as ai
from tests.test_ai_core import USER, Env, api_error


def block_text(t):
    return SimpleNamespace(type="text", text=t)


def block_tool(name, inp, id_="tu1"):
    return SimpleNamespace(type="tool_use", name=name, input=inp, id=id_)


def msg(blocks, stop="end_turn"):
    return SimpleNamespace(model="claude-haiku-5-5", content=blocks, stop_reason=stop,
                           usage=SimpleNamespace(input_tokens=1000, output_tokens=100,
                                                 cache_read_input_tokens=0, cache_creation_input_tokens=0))


class FakeStream:
    def __init__(self, m):
        self.m = m
        self.text_stream = [b.text for b in m.content if b.type == "text"]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.m


class ChatEnv(Env):
    """Env + messages.stream mock: replies-ийг дарааллаар буцаана (сүүлчийнх нь давтагдана)."""

    def __init__(self, replies, **cfg):
        super().__init__(**cfg)
        self.replies = replies

    def __enter__(self):
        super().__enter__()
        env = self

        def stream(**kw):
            env.calls.append(kw)
            if env.error:
                raise env.error
            return FakeStream(env.replies[min(len(env.calls) - 1, len(env.replies) - 1)])
        ai._client.messages.stream = stream
        return self


@pytest.fixture
def fake_tools(monkeypatch):
    seen = []

    def echo(db, a, perms):
        seen.append(a)
        return {"rows": [{"code": "A1", "qty": 5}]}
    tools = {"echo_tool": (echo, (), "Шалгаж байна", "test", chat_tools._obj({"q": chat_tools._S})),
             "secret_tool": (echo, ("order",), "Нууц", "test", chat_tools._obj({}))}
    monkeypatch.setattr(chat_tools, "TOOLS", tools)
    return seen


def run(env_replies, perms=frozenset(), **cfg):
    with ChatEnv(env_replies, **cfg) as env:
        evs = list(chat.answer(USER, set(perms), "Үлдэгдэл хэд вэ?", [], {"menu": "Захиалга", "path": "/order/5",
                                                                          "ids": ["5"]}, "q1",
                                db_factory=lambda: SimpleNamespace(close=lambda: None)))
        return evs, env


def test_tool_loop_streams_text_and_logs(fake_tools):
    evs, env = run([msg([block_tool("echo_tool", {"q": "x"})], "tool_use"), msg([block_text("Нийт **5** ш.")])])
    assert [e["t"] for e in evs] == ["tool", "text", "done"]
    assert evs[0]["label"] == "Шалгаж байна" and evs[1]["v"] == "Нийт **5** ш."
    assert evs[2]["tools"] == ["echo_tool"] and evs[2]["cost"] > 0
    assert fake_tools == [{"q": "x"}]
    # 2 дахь дуудлагад tool_result очсон
    tr = env.calls[1]["messages"][-1]["content"][0]
    assert tr["type"] == "tool_result" and '"A1"' in tr["content"]
    # тохиргоо: 1500 токен, системд cache, хуудасны мэдээлэл асуултад
    c = env.calls[0]
    assert c["max_tokens"] == 1500 and c["system"][0]["cache_control"]["type"] == "ephemeral"
    assert "[Хуудас: Захиалга (/order/5); харагдаж буй ID: 5]" in c["messages"][0]["content"]
    rows = env.rows()
    assert len(rows) == 2 and {r.question_id for r in rows} == {"q1"}


def test_tools_filtered_by_permission(fake_tools):
    _, env = run([msg([block_text("ok")])], perms={"ai_chat"})
    assert [t["name"] for t in env.calls[0]["tools"]] == ["echo_tool"]
    _, env = run([msg([block_text("ok")])], perms={"ai_chat", "order"})
    assert [t["name"] for t in env.calls[0]["tools"]] == ["echo_tool", "secret_tool"]
    # model эрхгүй tool дуудсан ч ажиллахгүй
    assert "эрх алга" in chat_tools.run(None, "secret_tool", {}, {"ai_chat"})


def test_max_five_tool_loops(fake_tools):
    evs, env = run([msg([block_tool("echo_tool", {})], "tool_use")])
    assert len(env.calls) == 6                                  # 5 tool loop + 1 дүгнэлт
    assert env.calls[5]["tool_choice"] == {"type": "none"}
    assert "tool_choice" not in env.calls[4]
    assert evs[-1]["t"] == "done"


def test_api_error_becomes_mongolian_event(fake_tools):
    with ChatEnv([], error=api_error(anthropic.InternalServerError, 529, "overloaded_error")) as env:
        evs = list(chat.answer(USER, set(), "x", [], None, "q", db_factory=lambda: SimpleNamespace(close=lambda: None)))
        assert evs[-1]["t"] == "error" and "ачаалалтай" in evs[-1]["message"]
        assert env.rows()[0].ok == 0


def test_history_last_six_and_alternating():
    hist = [{"role": "user" if i % 2 == 0 else "assistant", "text": f"m{i}"} for i in range(10)]
    msgs = chat.build_messages("шинэ", hist, None)
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant", "user", "assistant", "user"]
    assert msgs[0]["content"] == "m4" and msgs[-1]["content"].endswith("шинэ")
    # assistant-аар эхэлсэн түүх → хасагдана; дараалсан user → нэгтгэнэ
    msgs = chat.build_messages("q", [{"role": "assistant", "text": "a"}, {"role": "user", "text": "u"}], None)
    assert len(msgs) == 1 and msgs[0]["content"].startswith("u") and msgs[0]["content"].endswith("q")


def test_readonly_db_blocks_writes():
    s = readonly_db.session()
    try:
        assert s.execute(text("select 1")).scalar() == 1
        with pytest.raises(Exception, match="readonly|read-only|attempt to write"):
            s.execute(text("create table ai_should_not_exist (x int)"))
    finally:
        s.close()


def test_real_tool_definitions_valid():
    defs = chat_tools.definitions(set(p for t in chat_tools.TOOLS.values() for p in t[1]))
    assert len(defs) == len(chat_tools.TOOLS)
    for d in defs:
        assert d["input_schema"]["type"] == "object" and d["description"]
    assert {d["name"] for d in chat_tools.definitions(set())} == {"search_products", "get_data_freshness"}
