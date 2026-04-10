import { create } from "zustand";

type UserRole = "admin" | "manager" | "supervisor" | "warehouse_clerk" | "accountant";

type AuthState = {
  token: string | null;
  username: string | null;
  nickname: string | null;
  role: string | null;
  baseRole: UserRole | null;
  permissions: string[];
  tagIds: number[];
  userId: number | null;
  setAuth: (p: { token: string; username: string; nickname?: string; role: string; base_role?: string; permissions?: string[]; tagIds: number[]; userId?: number }) => void;
  logout: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem("token"),
  username: localStorage.getItem("username"),
  nickname: localStorage.getItem("nickname"),
  role: localStorage.getItem("role"),
  baseRole: (localStorage.getItem("baseRole") as UserRole | null) ?? null,
  permissions: JSON.parse(localStorage.getItem("permissions") ?? "[]"),
  tagIds: JSON.parse(localStorage.getItem("tagIds") ?? "[]"),
  userId: localStorage.getItem("userId") ? Number(localStorage.getItem("userId")) : null,
  setAuth: (p) => {
    const baseRole = (p.base_role || p.role) as UserRole;
    const permissions = p.permissions ?? [];
    localStorage.setItem("token", p.token);
    localStorage.setItem("username", p.username);
    localStorage.setItem("nickname", p.nickname ?? "");
    localStorage.setItem("role", p.role);
    localStorage.setItem("baseRole", baseRole);
    localStorage.setItem("permissions", JSON.stringify(permissions));
    localStorage.setItem("tagIds", JSON.stringify(p.tagIds));
    if (p.userId != null) localStorage.setItem("userId", String(p.userId));
    set({ token: p.token, username: p.username, nickname: p.nickname ?? "", role: p.role, baseRole, permissions, tagIds: p.tagIds, userId: p.userId ?? null });
  },
  logout: () => {
    localStorage.clear();
    set({ token: null, username: null, nickname: null, role: null, baseRole: null, permissions: [], tagIds: [], userId: null });
  },
}));
