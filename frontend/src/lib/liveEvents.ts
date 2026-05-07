/**
 * Server-Sent Events (SSE) hook for real-time multi-device sync.
 *
 * Usage:
 *   useLiveRefresh(["receivings"], () => loadSession());
 *
 * Whenever the backend calls bus.publish("receivings", ...), every browser
 * (phone, tablet, desktop) currently subscribed will fire its callback,
 * giving the user an "instant" feel without polling.
 *
 * Auto-reconnects with exponential backoff if the connection drops.
 */
import { useEffect, useRef } from "react";
import { api } from "./api";

export type LiveEvent = {
  topic: string;
  ts: number;
  data: Record<string, unknown>;
};

/** Build the SSE URL based on current api.defaults.baseURL. */
function streamUrl(topics: string[]): string {
  const base = (api.defaults.baseURL || "").replace(/\/$/, "");
  const qs = encodeURIComponent(topics.join(","));
  return `${base}/events?topics=${qs}`;
}

/**
 * Subscribe the current React component to one or more topics.
 * The callback is invoked on every matching event.
 *
 * Pass an empty topics array to disable.
 */
export function useLiveRefresh(
  topics: string[],
  onEvent: (e: LiveEvent) => void,
): void {
  // Keep the latest callback in a ref so changes don't reopen the stream.
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  // Stable key for topics to avoid reopen on every render.
  const topicsKey = [...topics].sort().join(",");

  useEffect(() => {
    if (!topicsKey) return;
    let es: EventSource | null = null;
    let backoff = 500;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      try {
        es = new EventSource(streamUrl(topicsKey.split(",")));
        es.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data) as LiveEvent;
            cbRef.current(parsed);
            backoff = 500; // reset on success
          } catch {
            // ignore malformed
          }
        };
        es.onerror = () => {
          es?.close();
          es = null;
          if (!cancelled) {
            setTimeout(connect, backoff);
            backoff = Math.min(backoff * 2, 10_000);
          }
        };
      } catch {
        if (!cancelled) setTimeout(connect, backoff);
      }
    }

    connect();
    return () => {
      cancelled = true;
      es?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicsKey]);
}
