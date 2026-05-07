"""Lightweight in-process pub/sub event bus for real-time updates.

Used to push UI refresh hints to all connected browsers via SSE so that
when one device changes data, others on the LAN see it without manual
reload.

Design choices:
- Single-process (single uvicorn worker). For multi-worker setups a
  Redis-backed bus would be needed; ERP runs as one worker so this is fine.
- Topics are just strings. Subscribers can listen to "all" or to a
  specific channel like "receivings", "bank_statements", "orders".
- Each subscriber gets its own asyncio.Queue with a small bound; if a
  client falls behind we drop the oldest message rather than blocking
  publishers.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict
from typing import Any


_QUEUE_MAX = 100  # per-subscriber bound; drops oldest on overflow


class EventBus:
    def __init__(self) -> None:
        # topic -> set of queues currently listening on that topic
        self._subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)

    def subscribe(self, topics: list[str]) -> asyncio.Queue:
        """Return a fresh queue subscribed to the given topics + 'all'."""
        q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
        for t in topics:
            self._subscribers[t].add(q)
        # Always also subscribe to 'all' (so generic refreshers get everything)
        self._subscribers["all"].add(q)
        return q

    def unsubscribe(self, topics: list[str], q: asyncio.Queue) -> None:
        for t in topics:
            self._subscribers[t].discard(q)
        self._subscribers["all"].discard(q)

    def publish(self, topic: str, payload: dict[str, Any] | None = None) -> None:
        """Non-blocking publish. Called from any sync route handler."""
        msg = {
            "topic": topic,
            "ts": int(time.time() * 1000),
            "data": payload or {},
        }
        # Send to subscribers of this topic AND of 'all'
        for t in (topic, "all"):
            for q in list(self._subscribers.get(t, ())):
                try:
                    q.put_nowait(msg)
                except asyncio.QueueFull:
                    # Drop oldest, then push
                    try:
                        q.get_nowait()
                        q.put_nowait(msg)
                    except Exception:
                        pass


bus = EventBus()


def publish(topic: str, **payload: Any) -> None:
    """Convenience: publish(topic, key=value, ...)."""
    bus.publish(topic, payload)


async def event_stream(topics: list[str]):
    """Async generator that yields SSE-formatted strings for the given topics.
    Sends a heartbeat comment every 25 seconds so proxies/keep-alive don't drop the connection.
    """
    q = bus.subscribe(topics)
    try:
        # Initial 'hello' so clients know the stream is live.
        yield "event: hello\ndata: {}\n\n"
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=25.0)
                yield f"data: {json.dumps(msg)}\n\n"
            except asyncio.TimeoutError:
                # Heartbeat
                yield ": ping\n\n"
    finally:
        bus.unsubscribe(topics, q)
