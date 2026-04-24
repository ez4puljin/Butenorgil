import axios from "axios";
import { useAuthStore } from "../store/authStore";
import { getServerUrlSync, isNativeApp } from "./serverConfig";

// Base URL сонголт:
// 1) Native app (Capacitor APK) — хэрэглэгчийн оруулсан IP/порт (ServerConfig screen)
// 2) HTTPS web — Vite proxy "/api"
// 3) HTTP web — энгийн http://{hostname}:8000
function computeDefaultBase(): string {
  if (typeof window === "undefined") return "http://localhost:8000";
  if (isNativeApp()) {
    const saved = getServerUrlSync();
    if (saved) return saved.replace(/\/$/, "");
    return "";  // Хоосон — ServerConfig гарна
  }
  if (window.location.protocol === "https:") return "/api";
  return `http://${window.location.hostname}:8000`;
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
