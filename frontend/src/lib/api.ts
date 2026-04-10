import axios from "axios";
import { useAuthStore } from "../store/authStore";

// HTTPS горимд: Vite proxy /api → backend:8000 (Mixed Content зайлсхийнэ)
// HTTP горимд: шууд backend:8000
const defaultApiBase =
  typeof window !== "undefined"
    ? window.location.protocol === "https:"
      ? "/api"
      : `http://${window.location.hostname}:8000`
    : "http://localhost:8000";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE ?? defaultApiBase,
});

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
