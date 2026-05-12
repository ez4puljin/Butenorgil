import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import {
  KeyRound, CheckCircle, AlertCircle, X, RefreshCw,
  Package, Download, Pencil, Trash2,
  Plus, Users, UserCheck, UserX, Search, MoreHorizontal,
  ShieldCheck, Briefcase, Settings as SettingsIcon, Shield, Filter,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type U = {
  id: number;
  username: string;
  nickname?: string;
  phone?: string;
  role: string;
  is_active: boolean;
  tag_ids: number[];
};

type RoleT = {
  id: number;
  value: string;
  label: string;
  color: string;
  base_role: string;
  permissions: string;
  is_system: boolean;
};

const BASE_ROLES = [
  { value: "admin",           label: "Админ" },
  { value: "supervisor",      label: "Хянагч" },
  { value: "manager",         label: "Менежер" },
  { value: "warehouse_clerk", label: "Агуулахын нярав" },
  { value: "accountant",      label: "Нягтлан" },
];

const COLOR_OPTIONS = [
  { value: "bg-emerald-100 text-emerald-700", label: "Ногоон" },
  { value: "bg-blue-100 text-blue-700",       label: "Цэнхэр" },
  { value: "bg-orange-100 text-orange-700",   label: "Улбар шар" },
  { value: "bg-violet-100 text-violet-700",   label: "Ягаан" },
  { value: "bg-rose-100 text-rose-700",       label: "Улаан" },
  { value: "bg-amber-100 text-amber-700",     label: "Шар" },
  { value: "bg-teal-100 text-teal-700",       label: "Оцон ногоон" },
  { value: "bg-gray-100 text-gray-600",       label: "Саарал" },
];

const PAGE_KEYS = [
  { key: "order",               label: "Захиалга" },
  { key: "receivings",          label: "Бараа тулгаж авах" },
  { key: "kpi_checklist",       label: "Өдрийн даалгавар" },
  { key: "dashboard",           label: "Хянах самбар" },
  { key: "kpi_approvals",       label: "KPI зөвшөөрөл" },
  { key: "reports",             label: "Тайлан" },
  { key: "imports",             label: "Файл оруулалт" },
  { key: "accounts_receivable", label: "Авлага тайлан" },
  { key: "suppliers",           label: "Нийлүүлэгч" },
  { key: "logistics",           label: "Логистик" },
  { key: "calendar",            label: "Календар" },
  { key: "admin_panel",         label: "Удирдлага" },
  { key: "min_stock",           label: "Доод үлдэгдэл" },
  { key: "audit_log",           label: "Үйлдлийн бүртгэл" },
  { key: "kpi_admin",           label: "KPI тохиргоо" },
  { key: "new_product",         label: "Шинэ бараа" },
  { key: "sales_report",        label: "Борлуулалтын тайлан" },
  { key: "inventory_count",     label: "Тооллогоны тайлан" },
  { key: "erkhet_auto",         label: "Erkhet автомат" },
  { key: "bank_statements",     label: "Тооцоо хаах" },
];

const parseTagIds = (raw: string): number[] =>
  raw.split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x) && x > 0);

type Msg = { type: "success" | "error"; msg: string };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const initials = (s: string) =>
  (s || "").trim().split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase();

const AVATAR_HUES = ["#0071E3", "#7C3AED", "#0EA5E9", "#10B981", "#F59E0B", "#E11D48", "#6366F1", "#F97316"];
const avatarBg = (id: number) => AVATAR_HUES[id % AVATAR_HUES.length];

function StatusMsg({ msg }: { msg: Msg | null }) {
  if (!msg) return null;
  return (
    <div className={`flex items-center gap-1.5 text-sm font-medium ${msg.type === "success" ? "text-emerald-600" : "text-red-500"}`}>
      {msg.type === "success" ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
      {msg.msg}
    </div>
  );
}

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative z-10" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

// Shared input class
const inp =
  "w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition focus:border-[#0071E3] focus:bg-white focus:shadow-[0_0_0_3px_rgba(0,113,227,0.12)] placeholder:text-gray-400";

// Stat card
function Stat({ label, value, sub, icon, tone }: { label: string; value: React.ReactNode; sub?: string; icon: React.ReactNode; tone: string }) {
  return (
    <div className="rounded-2xl bg-white border border-gray-200/70 shadow-[0_1px_0_rgba(17,24,39,0.04)] p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[12px] font-medium text-gray-500">{label}</div>
          <div className="mt-2 text-[28px] font-bold tracking-tight text-gray-900 leading-none">{value}</div>
          {sub && <div className="mt-1.5 text-[11.5px] text-gray-500">{sub}</div>}
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-xl ring-1 ring-inset ${tone}`}>{icon}</div>
      </div>
    </div>
  );
}

// Kebab menu
function RowMenu({
  user, onEdit, onReset, onToggle, onDelete,
}: { user: U; onEdit: () => void; onReset: () => void; onToggle: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="grid h-8 w-8 place-items-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
        title="Үйлдэл"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-48 rounded-xl border border-gray-200 bg-white shadow-lg overflow-hidden">
          <button onClick={() => { setOpen(false); onEdit(); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-gray-700 hover:bg-gray-50">
            <Pencil size={14}/> Засах
          </button>
          <button onClick={() => { setOpen(false); onReset(); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-gray-700 hover:bg-gray-50">
            <KeyRound size={14}/> Нууц үг шинэчлэх
          </button>
          <button onClick={() => { setOpen(false); onToggle(); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-gray-700 hover:bg-gray-50">
            {user.is_active ? <UserX size={14}/> : <UserCheck size={14}/>}
            {user.is_active ? "Хаах" : "Нээх"}
          </button>
          {user.username !== "admin" && (
            <>
              <div className="border-t border-gray-100" />
              <button onClick={() => { setOpen(false); onDelete(); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-rose-600 hover:bg-rose-50">
                <Trash2 size={14}/> Устгах
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
export default function Admin() {
  const [tab, setTab] = useState<"users" | "roles" | "system">("users");
  const [users, setUsers] = useState<U[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Roles
  const [roles, setRoles] = useState<RoleT[]>([]);
  const [showRoleCreate, setShowRoleCreate] = useState(false);
  const [roleForm, setRoleForm] = useState({ value: "", label: "", color: "bg-gray-100 text-gray-600", base_role: "manager", permissions: [] as string[] });
  const [roleCreateLoading, setRoleCreateLoading] = useState(false);
  const [roleCreateMsg, setRoleCreateMsg] = useState<Msg | null>(null);
  const [editRoleTarget, setEditRoleTarget] = useState<RoleT | null>(null);
  const [editRoleForm, setEditRoleForm] = useState({ label: "", color: "", base_role: "", permissions: [] as string[] });
  const [editRoleLoading, setEditRoleLoading] = useState(false);
  const [editRoleMsg, setEditRoleMsg] = useState<Msg | null>(null);
  const [deleteRoleTarget, setDeleteRoleTarget] = useState<RoleT | null>(null);
  const [deleteRoleLoading, setDeleteRoleLoading] = useState(false);
  const [deleteRoleMsg, setDeleteRoleMsg] = useState<Msg | null>(null);

  const roleInfo = (roleVal: string) =>
    roles.find((r) => r.value === roleVal) ?? { label: roleVal, color: "bg-gray-100 text-gray-600" };

  // User CRUD
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: "", nickname: "", password: "", phone: "", role: "manager", tagIds: "1" });
  const [createLoading, setCreateLoading] = useState(false);
  const [createMsg, setCreateMsg] = useState<Msg | null>(null);

  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [pwStatus, setPwStatus] = useState<Msg | null>(null);
  const [pwLoading, setPwLoading] = useState(false);

  const [resetTarget, setResetTarget] = useState<{ id: number; username: string } | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState<Msg | null>(null);

  const [editTarget, setEditTarget] = useState<U | null>(null);
  const [editForm, setEditForm] = useState({ role: "manager", nickname: "", phone: "", tagIds: "" });
  const [editLoading, setEditLoading] = useState(false);
  const [editMsg, setEditMsg] = useState<Msg | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<{ id: number; username: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<Msg | null>(null);

  const [toggleTarget, setToggleTarget] = useState<U | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [toggleMsg, setToggleMsg] = useState<Msg | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<{ before: number; after: number } | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Filters
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  const loadRoles = async () => {
    try { const res = await api.get("/admin/roles"); setRoles(res.data); } catch {}
  };

  const load = async () => {
    setLoading(true); setLoadError(null);
    try {
      const [usersRes] = await Promise.all([api.get("/admin/users"), loadRoles()]);
      setUsers(usersRes.data);
    } catch (e: any) {
      setLoadError(e?.response?.data?.detail ?? "Хэрэглэгчдийг ачаалахад алдаа гарлаа");
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const activeCount = users.filter((u) => u.is_active).length;
  const inactiveCount = users.length - activeCount;
  const customRoles = roles.filter((r) => !r.is_system).length;

  const filteredUsers = useMemo(() => users.filter((u) => {
    if (roleFilter !== "all" && u.role !== roleFilter) return false;
    if (statusFilter === "active" && !u.is_active) return false;
    if (statusFilter === "inactive" && u.is_active) return false;
    if (q) {
      const s = q.toLowerCase();
      return ((u.username || "") + " " + (u.nickname || "") + " " + (u.phone || "")).toLowerCase().includes(s);
    }
    return true;
  }), [users, q, roleFilter, statusFilter]);

  const roleMemberCount = (val: string) => users.filter((u) => u.role === val).length;
  const rolePermCount = (r: RoleT) => (r.permissions || "").split(",").filter(Boolean).length;

  // ── Actions ────────────────────────────────────────────────────────────────
  const openCreate = () => {
    setForm({ username: "", nickname: "", password: "", phone: "", role: "manager", tagIds: "1" });
    setCreateMsg(null); setShowCreate(true);
  };

  const create = async () => {
    setCreateMsg(null);
    if (!form.username.trim()) return setCreateMsg({ type: "error", msg: "Хэрэглэгчийн нэр оруулна уу" });
    if (form.password.length < 8)  return setCreateMsg({ type: "error", msg: "Нууц үг хамгийн багадаа 8 тэмдэгт байх ёстой" });
    setCreateLoading(true);
    try {
      await api.post("/admin/users", {
        username: form.username, nickname: form.nickname, password: form.password,
        phone: form.phone, role: form.role, tag_ids: parseTagIds(form.tagIds),
      });
      setShowCreate(false); await load();
    } catch (e: any) { setCreateMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" }); }
    finally { setCreateLoading(false); }
  };

  const confirmToggle = async () => {
    if (!toggleTarget) return;
    setToggleLoading(true); setToggleMsg(null);
    try { await api.post(`/admin/users/${toggleTarget.id}/toggle`); setToggleTarget(null); await load(); }
    catch (e: any) { setToggleMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" }); }
    finally { setToggleLoading(false); }
  };

  const openEdit = (u: U) => {
    setEditTarget(u);
    setEditForm({ role: u.role, nickname: u.nickname ?? "", phone: u.phone ?? "", tagIds: u.tag_ids.join(",") });
    setEditMsg(null);
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    setEditMsg(null); setEditLoading(true);
    try {
      const updated = await api.patch(`/admin/users/${editTarget.id}`, {
        role: editForm.role, nickname: editForm.nickname, phone: editForm.phone,
        tag_ids: parseTagIds(editForm.tagIds),
      });
      setUsers((prev) => prev.map((u) => (u.id === editTarget.id ? updated.data : u)));
      setEditTarget(null);
    } catch (e: any) { setEditMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" }); }
    finally { setEditLoading(false); }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true); setDeleteMsg(null);
    try {
      await api.delete(`/admin/users/${deleteTarget.id}`);
      setUsers((prev) => prev.filter((u) => u.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e: any) { setDeleteMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" }); }
    finally { setDeleteLoading(false); }
  };

  // Role CRUD
  const createRole = async () => {
    setRoleCreateMsg(null);
    if (!roleForm.value.trim() || !roleForm.label.trim()) return setRoleCreateMsg({ type: "error", msg: "Утга болон нэр оруулна уу" });
    setRoleCreateLoading(true);
    try {
      const res = await api.post("/admin/roles", roleForm);
      setRoles((prev) => [...prev, res.data]);
      setShowRoleCreate(false);
      setRoleForm({ value: "", label: "", color: "bg-gray-100 text-gray-600", base_role: "manager", permissions: [] });
    } catch (e: any) { setRoleCreateMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" }); }
    finally { setRoleCreateLoading(false); }
  };

  const saveEditRole = async () => {
    if (!editRoleTarget) return;
    setEditRoleMsg(null); setEditRoleLoading(true);
    try {
      const res = await api.patch(`/admin/roles/${editRoleTarget.id}`, editRoleForm);
      setRoles((prev) => prev.map((r) => (r.id === editRoleTarget.id ? res.data : r)));
      setEditRoleTarget(null);
    } catch (e: any) { setEditRoleMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" }); }
    finally { setEditRoleLoading(false); }
  };

  const confirmDeleteRole = async () => {
    if (!deleteRoleTarget) return;
    setDeleteRoleLoading(true); setDeleteRoleMsg(null);
    try {
      await api.delete(`/admin/roles/${deleteRoleTarget.id}`);
      setRoles((prev) => prev.filter((r) => r.id !== deleteRoleTarget.id));
      setDeleteRoleTarget(null);
    } catch (e: any) { setDeleteRoleMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" }); }
    finally { setDeleteRoleLoading(false); }
  };

  const changePassword = async () => {
    setPwStatus(null);
    if (!pwForm.current || !pwForm.next) return setPwStatus({ type: "error", msg: "Бүх талбарыг бөглөнө үү" });
    if (pwForm.next !== pwForm.confirm)  return setPwStatus({ type: "error", msg: "Шинэ нууц үг таарахгүй байна" });
    if (pwForm.next.length < 8)          return setPwStatus({ type: "error", msg: "Шинэ нууц үг хамгийн багадаа 8 тэмдэгт байх ёстой" });
    setPwLoading(true);
    try {
      await api.put("/admin/change-password", { current_password: pwForm.current, new_password: pwForm.next });
      setPwStatus({ type: "success", msg: "Нууц үг амжилттай солигдлоо" });
      setPwForm({ current: "", next: "", confirm: "" });
    } catch (e: any) { setPwStatus({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" }); }
    finally { setPwLoading(false); }
  };

  const resetPassword = async () => {
    if (!resetTarget) return;
    setResetMsg(null);
    if (resetPw.length < 8) return setResetMsg({ type: "error", msg: "Хамгийн багадаа 8 тэмдэгт байх ёстой" });
    setResetLoading(true);
    try {
      await api.post(`/admin/users/${resetTarget.id}/reset-password`, { new_password: resetPw });
      setResetPw(""); setResetTarget(null);
    } catch (e: any) { setResetMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" }); }
    finally { setResetLoading(false); }
  };

  const refreshProducts = async () => {
    setRefreshing(true); setRefreshResult(null); setRefreshError(null);
    try { const res = await api.post("/admin/refresh-products"); setRefreshResult({ before: res.data.before, after: res.data.after }); }
    catch (e: any) { setRefreshError(e?.response?.data?.detail ?? "Алдаа гарлаа"); }
    finally { setRefreshing(false); }
  };

  const downloadMaster = async () => {
    try {
      const token = useAuthStore.getState().token;
      const base = (api.defaults.baseURL || "").replace(/\/$/, "");
      const ts = Date.now();
      const res = await fetch(`${base}/admin/master-download?_=${ts}`, {
        method: "GET", cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        if (res.status === 404) throw new Error("Master файл байхгүй байна.");
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = await res.arrayBuffer();
      const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const blob = new Blob([buf], { type: XLSX_MIME });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "master_latest.xlsx"; a.rel = "noopener";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) { setRefreshError(`Татахад алдаа: ${e?.message || e}`); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>

      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Удирдлагын хэсэг</h1>
          <p className="mt-1 text-sm text-gray-500">Хэрэглэгч, эрх, системийн тохиргоог нэг дороос удирд.</p>
        </div>
        <div className="hidden sm:flex items-center gap-2 rounded-xl bg-white border border-gray-200/70 px-3 py-1.5 text-[12px] text-gray-600">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"/>
          <span>Систем идэвхтэй</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-5 flex items-center gap-1 border-b border-gray-200">
        {([
          { k: "users",  l: "Хэрэглэгч",     icon: <Users size={14}/> },
          { k: "roles",  l: "Албан тушаал", icon: <Briefcase size={14}/> },
          { k: "system", l: "Систем",        icon: <SettingsIcon size={14}/> },
        ] as const).map((t) => {
          const active = tab === t.k;
          return (
            <button key={t.k} onClick={() => setTab(t.k)}
              className={`relative -mb-px flex items-center gap-2 px-3.5 py-2.5 text-[13px] font-semibold transition-colors ${active ? "text-gray-900" : "text-gray-500 hover:text-gray-800"}`}>
              {t.icon}{t.l}
              {active && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-[#0071E3]"/>}
            </button>
          );
        })}
      </div>

      {/* ═══════════════════════════ USERS TAB ═══════════════════════════ */}
      {tab === "users" && (
        <div className="mt-5 space-y-5">
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Нийт хэрэглэгч" value={loading ? "—" : users.length}     sub="Бүх албан тушаал" icon={<Users size={16}/>}     tone="bg-indigo-50 text-indigo-700 ring-indigo-200" />
            <Stat label="Идэвхтэй"        value={loading ? "—" : activeCount}      sub="Системд нэвтрэх боломжтой" icon={<UserCheck size={16}/>} tone="bg-emerald-50 text-emerald-700 ring-emerald-200" />
            <Stat label="Идэвхгүй"        value={loading ? "—" : inactiveCount}    sub="Хаагдсан данс"     icon={<UserX size={16}/>}     tone="bg-rose-50 text-rose-700 ring-rose-200" />
            <Stat label="Албан тушаал"    value={loading ? "—" : roles.length}     sub={`${customRoles} тусгай үүсгэсэн`} icon={<Briefcase size={16}/>} tone="bg-sky-50 text-sky-700 ring-sky-200" />
          </div>

          {/* Toolbar + Table */}
          <div className="rounded-2xl bg-white border border-gray-200/70 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 flex-wrap">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Хэрэглэгч, утас, нэрээр хайх…"
                  className="w-full rounded-xl border border-gray-200 bg-gray-50/70 pl-9 pr-3 py-2 text-[13px] outline-none focus:border-[#0071E3] focus:bg-white focus:shadow-[0_0_0_3px_rgba(0,113,227,0.12)] transition" />
              </div>
              <div className="flex items-center gap-1 rounded-xl border border-gray-200 bg-gray-50/70 p-1">
                {([
                  { k: "all", l: "Бүгд" }, { k: "active", l: "Идэвхтэй" }, { k: "inactive", l: "Идэвхгүй" },
                ] as const).map((s) => (
                  <button key={s.k} onClick={() => setStatusFilter(s.k)}
                    className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${statusFilter === s.k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>
                    {s.l}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Filter size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
                  className="appearance-none rounded-xl border border-gray-200 bg-gray-50/70 pl-7 pr-3 py-2 text-[13px] text-gray-700 outline-none focus:border-[#0071E3] focus:bg-white">
                  <option value="all">Бүх албан тушаал</option>
                  {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[12px] text-gray-500">{filteredUsers.length} / {users.length}</span>
                <button onClick={openCreate}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] hover:bg-[#0063CC] px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-sm transition-colors">
                  <Plus size={14}/> Хэрэглэгч нэмэх
                </button>
              </div>
            </div>

            {loadError && (
              <div className="flex items-center gap-1.5 px-4 py-2 text-xs text-red-500 bg-red-50 border-b border-red-100">
                <AlertCircle size={13} /> {loadError}
                <button onClick={load} className="underline ml-2">Дахин оролдох</button>
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
                <RefreshCw size={16} className="animate-spin" /> Ачааллаж байна...
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="py-16 text-center text-sm text-gray-400">
                {users.length === 0 ? "Хэрэглэгч байхгүй байна" : "Шүүлтэд тохирох хэрэглэгч олдсонгүй"}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]" style={{ minWidth: 880 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 bg-gray-50/70 border-b border-gray-100">
                      <th className="px-5 py-2.5">Хэрэглэгч</th>
                      <th className="px-3 py-2.5">Албан тушаал</th>
                      <th className="px-3 py-2.5">Утас</th>
                      <th className="px-3 py-2.5">Агуулах</th>
                      <th className="px-3 py-2.5">Төлөв</th>
                      <th className="px-3 py-2.5 w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredUsers.map((u) => {
                      const ri = roleInfo(u.role);
                      return (
                        <tr key={u.id} className={`hover:bg-gray-50/60 transition-colors ${!u.is_active ? "opacity-60" : ""}`}>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-3">
                              <div className="grid h-9 w-9 place-items-center rounded-full text-[11.5px] font-bold text-white ring-2 ring-white shadow-sm" style={{ background: avatarBg(u.id) }}>
                                {initials(u.nickname || u.username)}
                              </div>
                              <div className="leading-tight">
                                <div className="font-semibold text-gray-900">{u.nickname || u.username}</div>
                                {u.nickname && <div className="text-[11.5px] text-gray-500 font-mono">@{u.username}</div>}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${ri.color}`}>
                              {ri.label}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-gray-600 font-mono text-[12px]">
                            {u.phone || <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap gap-1">
                              {u.tag_ids.slice(0, 3).map((w) => (
                                <span key={w} className="inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 font-mono">#{w}</span>
                              ))}
                              {u.tag_ids.length > 3 && (
                                <span className="inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-500">+{u.tag_ids.length - 3}</span>
                              )}
                              {u.tag_ids.length === 0 && <span className="text-gray-300">—</span>}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${u.is_active ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${u.is_active ? "bg-emerald-500" : "bg-gray-400"}`} />
                              {u.is_active ? "Идэвхтэй" : "Идэвхгүй"}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end">
                              <RowMenu
                                user={u}
                                onEdit={() => openEdit(u)}
                                onReset={() => { setResetTarget({ id: u.id, username: u.username }); setResetPw(""); setResetMsg(null); }}
                                onToggle={() => { setToggleTarget(u); setToggleMsg(null); }}
                                onDelete={() => { setDeleteTarget({ id: u.id, username: u.username }); setDeleteMsg(null); }}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════════════════ ROLES TAB ═══════════════════════════ */}
      {tab === "roles" && (
        <div className="mt-5 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[15px] font-semibold text-gray-900">Албан тушаал ба эрх</h3>
              <p className="text-[12.5px] text-gray-500 mt-0.5">Хэн ямар цэс, үйлдэлд хандах болохыг тохируулна</p>
            </div>
            <button
              onClick={() => { setShowRoleCreate(true); setRoleCreateMsg(null); }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gray-900 hover:bg-black px-3.5 py-2 text-[12.5px] font-semibold text-white">
              <Plus size={14}/> Шинэ албан тушаал
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {roles.map((r) => (
              <div key={r.id} className="group rounded-2xl border border-gray-200/70 bg-white p-4 hover:border-gray-300 transition-colors">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className={`grid h-9 w-9 place-items-center rounded-xl ${r.color}`}>
                      <Briefcase size={15}/>
                    </div>
                    <div className="leading-tight">
                      <div className="text-[13.5px] font-semibold text-gray-900 flex items-center gap-1.5">
                        {r.label}
                        {r.is_system && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-gray-500">Систем</span>}
                      </div>
                      <div className="text-[11px] text-gray-500 font-mono">@{r.value}</div>
                    </div>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                    <button onClick={() => { setEditRoleTarget(r); setEditRoleForm({ label: r.label, color: r.color, base_role: r.base_role, permissions: (r.permissions || "").split(",").filter(Boolean) }); setEditRoleMsg(null); }}
                      className="grid h-7 w-7 place-items-center rounded-lg text-gray-400 hover:bg-indigo-50 hover:text-indigo-600" title="Засах">
                      <Pencil size={13}/>
                    </button>
                    {!r.is_system && (
                      <button onClick={() => { setDeleteRoleTarget(r); setDeleteRoleMsg(null); }}
                        className="grid h-7 w-7 place-items-center rounded-lg text-gray-400 hover:bg-rose-50 hover:text-rose-600" title="Устгах">
                        <Trash2 size={13}/>
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-4 text-[11.5px]">
                  <div className="flex items-center gap-1.5 text-gray-500">
                    <Users size={12}/> <span className="font-semibold text-gray-900">{roleMemberCount(r.value)}</span> хэрэглэгч
                  </div>
                  <div className="flex items-center gap-1.5 text-gray-500">
                    <Shield size={12}/> <span className="font-semibold text-gray-900">{rolePermCount(r)}</span> эрх
                  </div>
                  <div className="ml-auto text-gray-400">
                    {BASE_ROLES.find((b) => b.value === r.base_role)?.label ?? r.base_role}
                  </div>
                </div>
              </div>
            ))}
            <button
              onClick={() => { setShowRoleCreate(true); setRoleCreateMsg(null); }}
              className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-gray-200 bg-white/40 py-6 text-sm text-gray-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-white transition-colors">
              <Plus size={15}/> Шинэ албан тушаал нэмэх
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════ SYSTEM TAB ═══════════════════════════ */}
      {tab === "system" && (
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Master refresh */}
          <div className="lg:col-span-2 rounded-2xl border border-gray-200/70 bg-white p-5">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 ring-1 ring-emerald-200 text-emerald-700">
                <Package size={17}/>
              </div>
              <div>
                <div className="text-[14px] font-semibold text-gray-900">Барааны жагсаалт шинэчлэх</div>
                <div className="text-[12px] text-gray-500">master_latest.xlsx файлаас DB-д бараа дахин ачаална</div>
              </div>
            </div>
            <p className="mt-3 text-[12.5px] text-gray-600">
              Захиалга үүсгэхийн өмнө master файлыг шинэчилснээр шинэ бараа, үнэ, кодын өөрчлөлт DB-д орно.
            </p>
            <div className="mt-4 flex items-center gap-2 flex-wrap">
              <button onClick={downloadMaster}
                className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50 transition-colors">
                <Download size={14}/> Файл татах
              </button>
              <button onClick={refreshProducts} disabled={refreshing}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 px-3.5 py-2 text-[12.5px] font-semibold text-white transition-all">
                <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
                {refreshing ? "Шинэчилж байна..." : "Master-аас шинэчлэх"}
              </button>
              {refreshResult && (
                <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                  <CheckCircle size={14}/> Амжилттай: {refreshResult.before} → {refreshResult.after} бараа
                </div>
              )}
              {refreshError && (
                <div className="flex items-center gap-1.5 text-sm text-red-500">
                  <AlertCircle size={14}/> {refreshError}
                </div>
              )}
            </div>
          </div>

          {/* Password change */}
          <div className="rounded-2xl border border-gray-200/70 bg-white p-5">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-sky-50 ring-1 ring-sky-200 text-sky-700">
                <KeyRound size={17}/>
              </div>
              <div>
                <div className="text-[14px] font-semibold text-gray-900">Нууц үг солих</div>
                <div className="text-[12px] text-gray-500">Өөрийн дансны</div>
              </div>
            </div>
            <div className="mt-4 space-y-2.5">
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Одоогийн нууц үг</label>
                <input type="password" className={inp} placeholder="••••••••"
                  value={pwForm.current} onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })} />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Шинэ нууц үг</label>
                <input type="password" className={inp} placeholder="Хамгийн багадаа 8 тэмдэгт"
                  value={pwForm.next} onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })} />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Давтах</label>
                <input type="password" className={inp} placeholder="••••••••"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && changePassword()} />
              </div>
            </div>
            <button onClick={changePassword} disabled={pwLoading}
              className="mt-4 w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#0071E3] hover:bg-[#0063CC] disabled:opacity-50 px-3.5 py-2.5 text-[12.5px] font-semibold text-white">
              {pwLoading && <RefreshCw size={13} className="animate-spin" />}
              {pwLoading ? "Хадгалж байна..." : "Нууц үг шинэчлэх"}
            </button>
            <div className="mt-2"><StatusMsg msg={pwStatus} /></div>
          </div>

          {/* Info card */}
          <div className="lg:col-span-3 rounded-2xl border border-gray-200/70 bg-white p-5">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 ring-1 ring-violet-200 text-violet-700">
                <ShieldCheck size={17}/>
              </div>
              <div>
                <div className="text-[14px] font-semibold text-gray-900">Системийн төлөв</div>
                <div className="text-[12px] text-gray-500">Backend холболт, ажиллаж буй процесс</div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { l: "Backend", v: "Холбогдсон",   tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
                { l: "DB",       v: "SQLite",       tone: "bg-sky-50 text-sky-700 ring-sky-200" },
                { l: "Хэрэглэгч", v: `${activeCount} идэвхтэй`, tone: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
                { l: "Албан тушаал", v: `${roles.length} тохируулсан`, tone: "bg-violet-50 text-violet-700 ring-violet-200" },
              ].map((x, i) => (
                <div key={i} className={`rounded-xl ring-1 ring-inset px-3.5 py-3 ${x.tone}`}>
                  <div className="text-[11px] font-medium opacity-80">{x.l}</div>
                  <div className="text-[14px] font-semibold mt-0.5">{x.v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════ MODALS ══════════════════════════════ */}

      {/* Create role modal */}
      <AnimatePresence>
        {showRoleCreate && (
          <ModalOverlay onClose={() => setShowRoleCreate(false)}>
            <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }} transition={{ duration: 0.18 }}
              className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-100"><Briefcase size={16} className="text-indigo-600" /></div>
                  <h2 className="text-base font-bold text-gray-900">Шинэ албан тушаал нэмэх</h2>
                </div>
                <button onClick={() => setShowRoleCreate(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X size={18} /></button>
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Системийн утга *</label>
                  <input className={inp} placeholder="жишээ: cashier" value={roleForm.value}
                    onChange={(e) => setRoleForm({ ...roleForm, value: e.target.value.toLowerCase().replace(/\s/g, "_") })} />
                  <p className="mt-1 text-xs text-gray-400">Латин үсэг, доогуур зураас. Өөрчлөх боломжгүй.</p>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Нэр (Монгол) *</label>
                  <input className={inp} placeholder="жишээ: Кассир" value={roleForm.label}
                    onChange={(e) => setRoleForm({ ...roleForm, label: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Эрхийн түвшин</label>
                  <select className={inp} value={roleForm.base_role} onChange={(e) => setRoleForm({ ...roleForm, base_role: e.target.value })}>
                    {BASE_ROLES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Өнгө</label>
                  <select className={inp} value={roleForm.color} onChange={(e) => setRoleForm({ ...roleForm, color: e.target.value })}>
                    {COLOR_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <div className="mt-2"><span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-semibold ${roleForm.color}`}>{roleForm.label || "Жишээ"}</span></div>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Харагдах цэс</label>
                  <div className="mt-1 grid grid-cols-2 gap-1.5 rounded-xl border border-gray-200 bg-gray-50 p-3">
                    {PAGE_KEYS.map((p) => (
                      <label key={p.key} className="flex cursor-pointer items-center gap-2 text-xs text-gray-700">
                        <input type="checkbox" className="h-3.5 w-3.5 rounded accent-indigo-600"
                          checked={roleForm.permissions.includes(p.key)}
                          onChange={() => setRoleForm((prev) => ({ ...prev, permissions: prev.permissions.includes(p.key) ? prev.permissions.filter((k) => k !== p.key) : [...prev.permissions, p.key] }))} />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              {roleCreateMsg && <div className="mt-3"><StatusMsg msg={roleCreateMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setShowRoleCreate(false)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50">Болих</button>
                <button onClick={createRole} disabled={roleCreateLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                  {roleCreateLoading && <RefreshCw size={13} className="animate-spin" />} Нэмэх
                </button>
              </div>
            </motion.div>
          </ModalOverlay>
        )}
      </AnimatePresence>

      {/* Edit role modal */}
      <AnimatePresence>
        {editRoleTarget && (
          <ModalOverlay onClose={() => setEditRoleTarget(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }} transition={{ duration: 0.18 }}
              className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-100"><Pencil size={15} className="text-indigo-600" /></div>
                  <div>
                    <h2 className="text-base font-bold text-gray-900">Албан тушаал засах</h2>
                    <p className="text-xs text-gray-400">@{editRoleTarget.value}</p>
                  </div>
                </div>
                <button onClick={() => setEditRoleTarget(null)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X size={18} /></button>
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Нэр (Монгол)</label>
                  <input className={inp} value={editRoleForm.label} onChange={(e) => setEditRoleForm({ ...editRoleForm, label: e.target.value })} />
                </div>
                {!editRoleTarget.is_system && (
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-gray-600">Эрхийн түвшин</label>
                    <select className={inp} value={editRoleForm.base_role} onChange={(e) => setEditRoleForm({ ...editRoleForm, base_role: e.target.value })}>
                      {BASE_ROLES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Өнгө</label>
                  <select className={inp} value={editRoleForm.color} onChange={(e) => setEditRoleForm({ ...editRoleForm, color: e.target.value })}>
                    {COLOR_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <div className="mt-2"><span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-semibold ${editRoleForm.color}`}>{editRoleForm.label}</span></div>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Харагдах цэс</label>
                  <div className="mt-1 grid grid-cols-2 gap-1.5 rounded-xl border border-gray-200 bg-gray-50 p-3">
                    {PAGE_KEYS.map((p) => (
                      <label key={p.key} className="flex cursor-pointer items-center gap-2 text-xs text-gray-700">
                        <input type="checkbox" className="h-3.5 w-3.5 rounded accent-indigo-600"
                          checked={editRoleForm.permissions.includes(p.key)}
                          onChange={() => setEditRoleForm((prev) => ({ ...prev, permissions: prev.permissions.includes(p.key) ? prev.permissions.filter((k) => k !== p.key) : [...prev.permissions, p.key] }))} />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              {editRoleMsg && <div className="mt-3"><StatusMsg msg={editRoleMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setEditRoleTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50">Болих</button>
                <button onClick={saveEditRole} disabled={editRoleLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                  {editRoleLoading && <RefreshCw size={13} className="animate-spin" />} Хадгалах
                </button>
              </div>
            </motion.div>
          </ModalOverlay>
        )}
      </AnimatePresence>

      {/* Delete role modal */}
      <AnimatePresence>
        {deleteRoleTarget && (
          <ModalOverlay onClose={() => setDeleteRoleTarget(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }} transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100"><Trash2 size={18} className="text-red-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Албан тушаал устгах</h2>
                  <p className="text-xs text-gray-400">Энэ албан тушаалтай хэрэглэгч байхгүй байх ёстой</p>
                </div>
              </div>
              <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-gray-700">
                <span className="font-bold text-red-600">{deleteRoleTarget.label}</span> албан тушаалыг устгах уу?
              </p>
              {deleteRoleMsg && <div className="mt-3"><StatusMsg msg={deleteRoleMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setDeleteRoleTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50">Болих</button>
                <button onClick={confirmDeleteRole} disabled={deleteRoleLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                  {deleteRoleLoading && <RefreshCw size={13} className="animate-spin" />} Устгах
                </button>
              </div>
            </motion.div>
          </ModalOverlay>
        )}
      </AnimatePresence>

      {/* Create user modal */}
      <AnimatePresence>
        {showCreate && (
          <ModalOverlay onClose={() => setShowCreate(false)}>
            <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }} transition={{ duration: 0.18 }}
              className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100"><Plus size={16} className="text-blue-600" /></div>
                  <h2 className="text-base font-bold text-gray-900">Шинэ хэрэглэгч</h2>
                </div>
                <button onClick={() => setShowCreate(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X size={18} /></button>
              </div>
              <div className="mt-5 space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Хэрэглэгчийн нэр *</label>
                  <input type="text" className={inp} placeholder="Латин үсэг, тоо (жишээ: Salesstaff_1)"
                    value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Nickname (жинхэнэ нэр)</label>
                  <input type="text" className={inp} placeholder="Жишээ: Болд"
                    value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Нууц үг *</label>
                  <input type="password" className={inp} placeholder="Хамгийн багадаа 8 тэмдэгт"
                    value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Утасны дугаар</label>
                  <input type="text" className={inp} placeholder="99001122"
                    value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Албан тушаал</label>
                  <select className={inp} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Агуулахын дугаарууд</label>
                  <input className={inp} placeholder="ж: 1,2,12"
                    value={form.tagIds} onChange={(e) => setForm({ ...form, tagIds: e.target.value })} />
                  <p className="mt-1 text-xs text-gray-400">Таслалаар тусгаарлана</p>
                </div>
              </div>
              {createMsg && <div className="mt-3"><StatusMsg msg={createMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50">Болих</button>
                <button onClick={create} disabled={createLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#0071E3] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#0063CC] disabled:opacity-50">
                  {createLoading && <RefreshCw size={13} className="animate-spin" />}
                  {createLoading ? "Үүсгэж байна..." : "Үүсгэх"}
                </button>
              </div>
            </motion.div>
          </ModalOverlay>
        )}
      </AnimatePresence>

      {/* Toggle confirm modal */}
      <AnimatePresence>
        {toggleTarget && (
          <ModalOverlay onClose={() => setToggleTarget(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }} transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${toggleTarget.is_active ? "bg-amber-100" : "bg-emerald-100"}`}>
                  {toggleTarget.is_active ? <UserX size={18} className="text-amber-600" /> : <UserCheck size={18} className="text-emerald-600" />}
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">{toggleTarget.is_active ? "Хэрэглэгч хаах" : "Хэрэглэгч нээх"}</h2>
                  <p className="text-xs text-gray-400">Төлөв өөрчлөгдөнө</p>
                </div>
              </div>
              <p className="mt-4 text-sm text-gray-600">
                <span className="font-semibold text-gray-900">{toggleTarget.username}</span>-г{" "}
                <span className="font-semibold">{toggleTarget.is_active ? "идэвхгүй болгох" : "идэвхжүүлэх"}</span> уу?
              </p>
              {toggleMsg && <div className="mt-3"><StatusMsg msg={toggleMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setToggleTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50">Болих</button>
                <button onClick={confirmToggle} disabled={toggleLoading}
                  className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${toggleTarget.is_active ? "bg-amber-500 hover:bg-amber-600" : "bg-emerald-600 hover:bg-emerald-700"}`}>
                  {toggleLoading && <RefreshCw size={13} className="animate-spin" />}
                  {toggleTarget.is_active ? "Хаах" : "Нээх"}
                </button>
              </div>
            </motion.div>
          </ModalOverlay>
        )}
      </AnimatePresence>

      {/* Reset password modal */}
      <AnimatePresence>
        {resetTarget && (
          <ModalOverlay onClose={() => setResetTarget(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }} transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100"><KeyRound size={15} className="text-blue-600" /></div>
                  <div>
                    <h2 className="text-base font-bold text-gray-900">Нууц үг reset</h2>
                    <p className="text-xs text-[#0071E3] font-medium">{resetTarget.username}</p>
                  </div>
                </div>
                <button onClick={() => setResetTarget(null)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X size={18} /></button>
              </div>
              <div className="mt-4">
                <label className="mb-1.5 block text-xs font-medium text-gray-600">Шинэ нууц үг</label>
                <input type="password" autoFocus className={inp} placeholder="Хамгийн багадаа 8 тэмдэгт"
                  value={resetPw} onChange={(e) => setResetPw(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && resetPassword()} />
              </div>
              {resetMsg && <div className="mt-3"><StatusMsg msg={resetMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setResetTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50">Болих</button>
                <button onClick={resetPassword} disabled={resetLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#0071E3] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#0063CC] disabled:opacity-50">
                  {resetLoading && <RefreshCw size={13} className="animate-spin" />} Хадгалах
                </button>
              </div>
            </motion.div>
          </ModalOverlay>
        )}
      </AnimatePresence>

      {/* Edit user modal */}
      <AnimatePresence>
        {editTarget && (
          <ModalOverlay onClose={() => setEditTarget(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }} transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-100"><Pencil size={15} className="text-indigo-600" /></div>
                  <div>
                    <h2 className="text-base font-bold text-gray-900">Засах</h2>
                    <p className="text-xs text-[#0071E3] font-medium">{editTarget.username}</p>
                  </div>
                </div>
                <button onClick={() => setEditTarget(null)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X size={18} /></button>
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Nickname (жинхэнэ нэр)</label>
                  <input className={inp} placeholder="Жишээ: Болд"
                    value={editForm.nickname} onChange={(e) => setEditForm({ ...editForm, nickname: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Албан тушаал</label>
                  <select className={inp} value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}>
                    {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Утасны дугаар</label>
                  <input className={inp} placeholder="99001122"
                    value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Агуулахын дугаарууд</label>
                  <input className={inp} placeholder="ж: 1,2,12"
                    value={editForm.tagIds} onChange={(e) => setEditForm({ ...editForm, tagIds: e.target.value })} />
                </div>
              </div>
              {editMsg && <div className="mt-3"><StatusMsg msg={editMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setEditTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50">Болих</button>
                <button onClick={saveEdit} disabled={editLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#0071E3] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#0063CC] disabled:opacity-50">
                  {editLoading && <RefreshCw size={13} className="animate-spin" />} Хадгалах
                </button>
              </div>
            </motion.div>
          </ModalOverlay>
        )}
      </AnimatePresence>

      {/* Delete confirm modal */}
      <AnimatePresence>
        {deleteTarget && (
          <ModalOverlay onClose={() => setDeleteTarget(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }} transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100"><Trash2 size={18} className="text-red-600" /></div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Хэрэглэгч устгах</h2>
                  <p className="text-xs text-gray-400">Энэ үйлдлийг буцаах боломжгүй</p>
                </div>
              </div>
              <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-gray-700">
                <span className="font-bold text-red-600">{deleteTarget.username}</span> хэрэглэгчийг бүрмөсөн устгах уу?
              </p>
              {deleteMsg && <div className="mt-3"><StatusMsg msg={deleteMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setDeleteTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50">Болих</button>
                <button onClick={confirmDelete} disabled={deleteLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                  {deleteLoading && <RefreshCw size={13} className="animate-spin" />} Устгах
                </button>
              </div>
            </motion.div>
          </ModalOverlay>
        )}
      </AnimatePresence>

    </motion.div>
  );
}
