import axios from "axios";
import { useAuthStore } from "../store/authStore";
import { getServerUrlSync, isNativeApp } from "./serverConfig";

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

// Response: 401 ирвэл logout хийж login руу шилжүүлнэ
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = "/";
    }
    return Promise.reject(err);
  },
);
