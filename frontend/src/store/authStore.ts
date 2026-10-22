import { create } from "zustand";
import { isNativeApp } from "../lib/serverConfig";

type UserRole = "admin" | "manager" | "supervisor" | "warehouse_clerk" | "accountant";

type AuthState = {
  token: string | null;
  username: string | null;
  nickname: string | null;
  role: string | null;
  roleLabel: string | null;
  baseRole: UserRole | null;
  permissions: string[];
  universalPages: string[];
  tagIds: number[];
  userId: number | null;
  setAuth: (p: { token: string; username: string; nickname?: string; role: string; role_label?: string; base_role?: string; permissions?: string[]; universalPages?: string[]; mobilePages?: string[] | null; tagIds: number[]; userId?: number }) => void;
  logout: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem("token"),
  username: localStorage.getItem("username"),
  nickname: localStorage.getItem("nickname"),
  role: localStorage.getItem("role"),
  roleLabel: localStorage.getItem("roleLabel"),
  baseRole: (localStorage.getItem("baseRole") as UserRole | null) ?? null,
  permissions: JSON.parse(localStorage.getItem("permissions") ?? "[]"),
  // Default — backend /auth/me ачаалагдах хүртэл (хуучин session-д ч цэс алга болохгүй)
  universalPages: JSON.parse(localStorage.getItem("universalPages") ?? '["expiration_tracking","attendance"]'),
  tagIds: JSON.parse(localStorage.getItem("tagIds") ?? "[]"),
  userId: localStorage.getItem("userId") ? Number(localStorage.getItem("userId")) : null,
  setAuth: (p) => {
    const baseRole = (p.base_role || p.role) as UserRole;
    let permissions = p.permissions ?? [];
    let universalPages = p.universalPages ?? ["expiration_tracking", "attendance"];
    // APK: дүрд тусдаа «APK цэс» тохируулсан бол зөвхөн тэр цэснүүд (вэбийн эрхээс давахгүй)
    if (isNativeApp() && p.mobilePages) {
      const m = new Set(p.mobilePages);
      permissions = permissions.filter((k) => m.has(k));
      universalPages = universalPages.filter((k) => m.has(k));
    }
    localStorage.setItem("token", p.token);
    localStorage.setItem("username", p.username);
    localStorage.setItem("nickname", p.nickname ?? "");
    localStorage.setItem("role", p.role);
    localStorage.setItem("roleLabel", p.role_label ?? "");
    localStorage.setItem("baseRole", baseRole);
    localStorage.setItem("permissions", JSON.stringify(permissions));
    localStorage.setItem("universalPages", JSON.stringify(universalPages));
    localStorage.setItem("tagIds", JSON.stringify(p.tagIds));
    if (p.userId != null) localStorage.setItem("userId", String(p.userId));
    set({ token: p.token, username: p.username, nickname: p.nickname ?? "", role: p.role, roleLabel: p.role_label ?? "", baseRole, permissions, universalPages, tagIds: p.tagIds, userId: p.userId ?? null });
  },
  logout: () => {
    localStorage.clear();
    set({ token: null, username: null, nickname: null, role: null, roleLabel: null, baseRole: null, permissions: [], universalPages: ["expiration_tracking", "attendance"], tagIds: [], userId: null });
  },
}));
