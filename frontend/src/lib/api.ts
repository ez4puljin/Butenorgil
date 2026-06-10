import axios from "axios";
import { useAuthStore } from "../store/authStore";
import { getServerUrlSync, isNativeApp } from "./serverConfig";
import { bindBaseUrlGetter, reportNetworkError, reportSuccess, waitForOnline } from "./connection";

// Base URL сонголт:
// 1) Native app (Capacitor APK) — хэрэглэгчийн оруулсан IP/порт (ServerConfig screen)
// 2) Production deploy (frontend served from same backend) — same origin (хоосон baseURL = relative)
// 3) Vite dev server — backend нь өөр порт дээр (ихэвчлэн 8000)
function computeDefaultBase(): string {
  if (typeof window === "undefined") return "http://localhost:8000";
  if (isNativeApp()) {
    const saved = getServerUrlSync();
    if (saved) return saved.replace(/\/$/, "");
    return "";  // Хоосон — ServerConfig гарна
  }
  // Vite dev mode (port 3000) — call backend on the same host:8000.
  // Production: frontend served from backend itself, so use same origin (relative URLs).
  const port = window.location.port;
  if (port === "3000" || port === "3001" || port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return "";   // same origin — works for both http and https
}

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE ?? computeDefaultBase(),
});

/** Runtime-д baseURL-г сольж болдог (ServerConfig screen амжилттай холбогдсоны дараа). */
export function setApiBaseUrl(url: string) {
  api.defaults.baseURL = url.replace(/\/$/, "");
}

// Request: token нэмнэ
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// connection.ts-д baseURL-аа өгнө (ping /health-д ашиглана)
bindBaseUrlGetter(() => api.defaults.baseURL || "");

const _sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Response: 401 → logout; network алдаа → холболтын төлөв + автомат retry/resume
api.interceptors.response.use(
  (res) => {
    reportSuccess();
    return res;
  },
  async (err) => {
    if (err?.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = "/";
      return Promise.reject(err);
    }

    // ── Network түвшний алдаа (HTTP хариу огт ирээгүй — WiFi/router/сервер) ──
    const cfg = err?.config;
    const isNetworkErr = !err?.response && !!cfg && err?.code !== "ERR_CANCELED";
    if (!isNetworkErr) return Promise.reject(err);

    reportNetworkError();
    const method = String(cfg.method || "get").toLowerCase();
    const retries = cfg._connRetries ?? 0;

    // GET: түр зуурын тасалдалд 2 удаа богино зайтай дахина
    if (method === "get" && retries < 2 && !cfg._noConnRetry) {
      cfg._connRetries = retries + 1;
      await _sleep(1200 * (retries + 1));
      return api.request(cfg);
    }

    // PATCH/PUT: идемпотент (бүтэн/абсолют утга илгээдэг) тул холболт сэргэхийг хүлээгээд
    // АВТОМАТААР үргэлжлүүлнэ — хэрэглэгчийн хийж байсан үйлдэл алдагдахгүй.
    // (POST/DELETE-ийг давтахгүй — сервер хүрсэн байж магадгүй тул давхардана.)
    if ((method === "patch" || method === "put") && retries < 3 && !cfg._noConnRetry) {
      cfg._connRetries = retries + 1;
      const ok = await waitForOnline(120_000);   // 2 мин хүртэл хүлээнэ
      if (ok) {
        await _sleep(300 * retries);
        return api.request(cfg);
      }
    }

    return Promise.reject(err);
  },
);
