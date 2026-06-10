/**
 * Глобал холболтын төлөв хянагч.
 *
 * Зорилго (APK + LAN орчинд):
 *  1. Холболт тасрахад ЯГ ЮУ болсныг ялгаж мэдээлэх:
 *     - "wifi"   → утасны WiFi өөрөө тасарсан (navigator.onLine = false)
 *     - "server" → WiFi байгаа ч сервер хариу өгөхгүй (сервер унтарсан /
 *                  router-ийн асуудал / буруу IP)
 *  2. Тасарсан үед 3с тутам /health ping хийж, сэргэмэгц бүртгэлтэй
 *     листенерүүдэд мэдэгдэнэ (api.ts-ийн хүлээгдэж буй хүсэлтүүд
 *     автоматаар үргэлжилнэ).
 */

export type ConnState = "online" | "wifi" | "server";

type Listener = (state: ConnState) => void;

let _state: ConnState = "online";
let _listeners: Set<Listener> = new Set();
let _pingTimer: ReturnType<typeof setTimeout> | null = null;
let _restoredAt = 0;

/** api.ts-ээс baseURL авахын тулд хожуу холбоно (circular import-оос сэргийлж). */
let _getBaseUrl: () => string = () => "";
export function bindBaseUrlGetter(fn: () => string) { _getBaseUrl = fn; }

export function getConnState(): ConnState { return _state; }
/** Сүүлд хэзээ сэргэснийг буцаана (banner "сэргэлээ" харуулахад). */
export function getRestoredAt(): number { return _restoredAt; }

export function subscribe(fn: Listener): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

function _setState(s: ConnState) {
  if (s === _state) return;
  const wasOffline = _state !== "online";
  _state = s;
  if (s === "online" && wasOffline) _restoredAt = Date.now();
  _listeners.forEach((fn) => { try { fn(s); } catch { /* ignore */ } });
  if (s === "online") {
    if (_pingTimer) { clearTimeout(_pingTimer); _pingTimer = null; }
  } else {
    _schedulePing();
  }
}

function _classifyOffline(): ConnState {
  // navigator.onLine=false → утас өөрөө сүлжээгүй. Бусад тохиолдолд сервер/router.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "wifi";
  return "server";
}

/** api.ts дуудна: хүсэлт network түвшинд бүтэлгүйтэв (HTTP хариу огт ирээгүй). */
export function reportNetworkError() {
  _setState(_classifyOffline());
}

/** api.ts дуудна: ямар нэг хүсэлт амжилттай боллоо → холболт байна. */
export function reportSuccess() {
  if (_state !== "online") _setState("online");
}

function _schedulePing() {
  if (_pingTimer) return;
  _pingTimer = setTimeout(async () => {
    _pingTimer = null;
    if (_state === "online") return;
    // WiFi огт байхгүй бол ping хийгээд ч нэмэргүй — төлөвөө шинэчлээд хүлээнэ
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      _setState("wifi");
      _schedulePing();
      return;
    }
    try {
      const base = (_getBaseUrl() || "").replace(/\/$/, "");
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${base}/health`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(to);
      if (r.ok) { _setState("online"); return; }
    } catch { /* унтарсан хэвээр */ }
    _setState(_classifyOffline());
    _schedulePing();
  }, 3000);
}

// Утасны WiFi төлөв өөрчлөгдөхөд шууд мэдэрнэ
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => _setState("wifi"));
  window.addEventListener("online", () => {
    // WiFi сэргэсэн ч сервер хүрэх эсэхийг ping-ээр баталгаажуулна
    if (_state !== "online") { _setState("server"); }
  });
}

/** Холболт сэргэхийг хүлээнэ (max хугацаатай). api.ts-ийн retry queue ашиглана. */
export function waitForOnline(maxWaitMs = 120_000): Promise<boolean> {
  if (_state === "online") return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { unsub(); resolve(false); }, maxWaitMs);
    const unsub = subscribe((s) => {
      if (s === "online") { clearTimeout(timer); unsub(); resolve(true); }
    });
  });
}
