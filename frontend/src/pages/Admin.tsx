import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import {
  KeyRound, CheckCircle, AlertCircle, X, RefreshCw,
  Package, Download, Pencil, Trash2, ToggleLeft, ToggleRight,
  Plus, Users, UserCheck, UserX, ChevronDown, ShieldCheck, Briefcase,
} from "lucide-react";

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
  permissions: string;   // comma-separated page keys
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
  // Үндсэн ажлын модулиуд
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
  // Зөвхөн админ/нягтлан
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
      <div className="relative z-10" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function AccordionSection({
  title, icon, children, defaultOpen = false,
}: {
  title: string; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {icon}
          <span className="text-sm font-semibold text-gray-800">{title}</span>
        </div>
        <ChevronDown
          size={16}
          className={`text-gray-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-6 pb-6 pt-1 border-t border-gray-100">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Admin() {
  const [users, setUsers] = useState<U[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Roles state ───────────────────────────────────────────────────────────
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

  // ── Create modal ─────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: "", nickname: "", password: "", phone: "", role: "manager", tagIds: "1" });
  const [createLoading, setCreateLoading] = useState(false);
  const [createMsg, setCreateMsg] = useState<Msg | null>(null);

  // ── Admin password change ────────────────────────────────────────────────
  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [pwStatus, setPwStatus] = useState<Msg | null>(null);
  const [pwLoading, setPwLoading] = useState(false);

  // ── Reset password modal ─────────────────────────────────────────────────
  const [resetTarget, setResetTarget] = useState<{ id: number; username: string } | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState<Msg | null>(null);

  // ── Edit modal ───────────────────────────────────────────────────────────
  const [editTarget, setEditTarget] = useState<U | null>(null);
  const [editForm, setEditForm] = useState({ role: "manager", nickname: "", phone: "", tagIds: "" });
  const [editLoading, setEditLoading] = useState(false);
  const [editMsg, setEditMsg] = useState<Msg | null>(null);

  // ── Delete confirm modal ─────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; username: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<Msg | null>(null);

  // ── Toggle confirm modal ─────────────────────────────────────────────────
  const [toggleTarget, setToggleTarget] = useState<U | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [toggleMsg, setToggleMsg] = useState<Msg | null>(null);

  // ── Products refresh ─────────────────────────────────────────────────────
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<{ before: number; after: number } | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const loadRoles = async () => {
    try {
      const res = await api.get("/admin/roles");
      setRoles(res.data);
    } catch {}
  };

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [usersRes] = await Promise.all([api.get("/admin/users"), loadRoles()]);
      setUsers(usersRes.data);
    } catch (e: any) {
      setLoadError(e?.response?.data?.detail ?? "Хэрэглэгчдийг ачаалахад алдаа гарлаа");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const activeCount = users.filter((u) => u.is_active).length;
  const inactiveCount = users.length - activeCount;

  // ── Create ───────────────────────────────────────────────────────────────
  const openCreate = () => {
    setForm({ username: "", nickname: "", password: "", phone: "", role: "manager", tagIds: "1" });
    setCreateMsg(null);
    setShowCreate(true);
  };

  const create = async () => {
    setCreateMsg(null);
    if (!form.username.trim()) {
      setCreateMsg({ type: "error", msg: "Хэрэглэгчийн нэр оруулна уу" });
      return;
    }
    if (form.password.length < 8) {
      setCreateMsg({ type: "error", msg: "Нууц үг хамгийн багадаа 8 тэмдэгт байх ёстой" });
      return;
    }
    setCreateLoading(true);
    try {
      await api.post("/admin/users", {
        username: form.username,
        nickname: form.nickname,
        password: form.password,
        phone: form.phone,
        role: form.role,
        tag_ids: parseTagIds(form.tagIds),
      });
      setShowCreate(false);
      await load();
    } catch (e: any) {
      setCreateMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" });
    } finally {
      setCreateLoading(false);
    }
  };

  // ── Toggle ───────────────────────────────────────────────────────────────
  const confirmToggle = async () => {
    if (!toggleTarget) return;
    setToggleLoading(true);
    setToggleMsg(null);
    try {
      await api.post(`/admin/users/${toggleTarget.id}/toggle`);
      setToggleTarget(null);
      await load();
    } catch (e: any) {
      setToggleMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" });
    } finally {
      setToggleLoading(false);
    }
  };

  // ── Edit ─────────────────────────────────────────────────────────────────
  const openEdit = (u: U) => {
    setEditTarget(u);
    setEditForm({ role: u.role, nickname: u.nickname ?? "", phone: u.phone ?? "", tagIds: u.tag_ids.join(",") });
    setEditMsg(null);
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    setEditMsg(null);
    setEditLoading(true);
    try {
      const updated = await api.patch(`/admin/users/${editTarget.id}`, {
        role: editForm.role,
        nickname: editForm.nickname,
        phone: editForm.phone,
        tag_ids: parseTagIds(editForm.tagIds),
      });
      setUsers((prev) => prev.map((u) => (u.id === editTarget.id ? updated.data : u)));
      setEditTarget(null);
    } catch (e: any) {
      setEditMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" });
    } finally {
      setEditLoading(false);
    }
  };

  // ── Delete ───────────────────────────────────────────────────────────────
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    setDeleteMsg(null);
    try {
      await api.delete(`/admin/users/${deleteTarget.id}`);
      setUsers((prev) => prev.filter((u) => u.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e: any) {
      setDeleteMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" });
    } finally {
      setDeleteLoading(false);
    }
  };

  // ── Role CRUD ─────────────────────────────────────────────────────────────
  const createRole = async () => {
    setRoleCreateMsg(null);
    if (!roleForm.value.trim() || !roleForm.label.trim()) {
      setRoleCreateMsg({ type: "error", msg: "Утга болон нэр оруулна уу" });
      return;
    }
    setRoleCreateLoading(true);
    try {
      const res = await api.post("/admin/roles", roleForm);
      setRoles((prev) => [...prev, res.data]);
      setShowRoleCreate(false);
      setRoleForm({ value: "", label: "", color: "bg-gray-100 text-gray-600", base_role: "manager", permissions: [] });
    } catch (e: any) {
      setRoleCreateMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" });
    } finally {
      setRoleCreateLoading(false);
    }
  };

  const saveEditRole = async () => {
    if (!editRoleTarget) return;
    setEditRoleMsg(null);
    setEditRoleLoading(true);
    try {
      const res = await api.patch(`/admin/roles/${editRoleTarget.id}`, editRoleForm);
      setRoles((prev) => prev.map((r) => (r.id === editRoleTarget.id ? res.data : r)));
      setEditRoleTarget(null);
    } catch (e: any) {
      setEditRoleMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" });
    } finally {
      setEditRoleLoading(false);
    }
  };

  const confirmDeleteRole = async () => {
    if (!deleteRoleTarget) return;
    setDeleteRoleLoading(true);
    setDeleteRoleMsg(null);
    try {
      await api.delete(`/admin/roles/${deleteRoleTarget.id}`);
      setRoles((prev) => prev.filter((r) => r.id !== deleteRoleTarget.id));
      setDeleteRoleTarget(null);
    } catch (e: any) {
      setDeleteRoleMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" });
    } finally {
      setDeleteRoleLoading(false);
    }
  };

  // ── Password change ───────────────────────────────────────────────────────
  const changePassword = async () => {
    setPwStatus(null);
    if (!pwForm.current || !pwForm.next) {
      setPwStatus({ type: "error", msg: "Бүх талбарыг бөглөнө үү" });
      return;
    }
    if (pwForm.next !== pwForm.confirm) {
      setPwStatus({ type: "error", msg: "Шинэ нууц үг таарахгүй байна" });
      return;
    }
    if (pwForm.next.length < 8) {
      setPwStatus({ type: "error", msg: "Шинэ нууц үг хамгийн багадаа 8 тэмдэгт байх ёстой" });
      return;
    }
    setPwLoading(true);
    try {
      await api.put("/admin/change-password", { current_password: pwForm.current, new_password: pwForm.next });
      setPwStatus({ type: "success", msg: "Нууц үг амжилттай солигдлоо" });
      setPwForm({ current: "", next: "", confirm: "" });
    } catch (e: any) {
      setPwStatus({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" });
    } finally {
      setPwLoading(false);
    }
  };

  // ── Reset password ────────────────────────────────────────────────────────
  const resetPassword = async () => {
    if (!resetTarget) return;
    setResetMsg(null);
    if (resetPw.length < 8) {
      setResetMsg({ type: "error", msg: "Хамгийн багадаа 8 тэмдэгт байх ёстой" });
      return;
    }
    setResetLoading(true);
    try {
      await api.post(`/admin/users/${resetTarget.id}/reset-password`, { new_password: resetPw });
      setResetPw("");
      setResetTarget(null);
    } catch (e: any) {
      setResetMsg({ type: "error", msg: e?.response?.data?.detail ?? "Алдаа гарлаа" });
    } finally {
      setResetLoading(false);
    }
  };

  // ── Products refresh ──────────────────────────────────────────────────────
  const refreshProducts = async () => {
    setRefreshing(true);
    setRefreshResult(null);
    setRefreshError(null);
    try {
      const res = await api.post("/admin/refresh-products");
      setRefreshResult({ before: res.data.before, after: res.data.after });
    } catch (e: any) {
      setRefreshError(e?.response?.data?.detail ?? "Алдаа гарлаа");
    } finally {
      setRefreshing(false);
    }
  };

  const downloadMaster = async () => {
    try {
      // fetch ашиглан эргэлтгүй, кэшгүй, бүрэн бинар хэлбэрээр татна.
      // axios + responseType:blob нь заримдаа транспорт эсвэл proxy-д хэсэгчилж
      // файлыг таслан авчирч байсан тул fetch нь илүү найдвартай.
      const token = useAuthStore.getState().token;
      const base = (api.defaults.baseURL || "").replace(/\/$/, "");
      const ts = Date.now();
      const res = await fetch(`${base}/admin/master-download?_=${ts}`, {
        method: "GET",
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        if (res.status === 404) throw new Error("Master файл байхгүй байна.");
        throw new Error(`HTTP ${res.status}`);
      }
      // arrayBuffer-аар бүх bytes цуглуулна (Content-Length-тэй таарна)
      const buf = await res.arrayBuffer();
      console.log(`[master-download] ${buf.byteLength} bytes downloaded`);
      const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const blob = new Blob([buf], { type: XLSX_MIME });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "master_latest.xlsx";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) {
      setRefreshError(`Татахад алдаа: ${e?.message || e}`);
    }
  };

  // ── Shared input class ────────────────────────────────────────────────────
  const inp = "w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition focus:border-[#0071E3] focus:bg-white focus:shadow-[0_0_0_3px_rgba(0,113,227,0.12)] placeholder:text-gray-400";

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>

      {/* ── Page header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Удирдлагын хэсэг</h1>
          <p className="mt-0.5 text-sm text-gray-500">Хэрэглэгч болон системийн тохиргоо</p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-xl bg-[#0071E3] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#0063CC] active:scale-[0.98] transition-all"
        >
          <Plus size={16} />
          Хэрэглэгч нэмэх
        </button>
      </div>

      {/* ── Stats row ── */}
      <div className="mt-5 grid grid-cols-3 gap-4">
        {[
          { label: "Нийт хэрэглэгч", value: users.length, icon: <Users size={18} />, color: "text-gray-700", bg: "bg-gray-100" },
          { label: "Идэвхтэй",        value: activeCount,  icon: <UserCheck size={18} />, color: "text-emerald-700", bg: "bg-emerald-100" },
          { label: "Идэвхгүй",        value: inactiveCount,icon: <UserX size={18} />,    color: "text-rose-600",   bg: "bg-rose-100" },
        ].map((s) => (
          <div key={s.label} className="flex items-center gap-4 rounded-2xl bg-white px-5 py-4 shadow-sm border border-gray-100">
            <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${s.bg} ${s.color}`}>
              {s.icon}
            </div>
            <div>
              <div className={`text-2xl font-bold ${s.color}`}>{loading ? "—" : s.value}</div>
              <div className="text-xs text-gray-500">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── User table ── */}
      <div className="mt-5 rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
            <Users size={16} className="text-gray-400" />
            Хэрэглэгчдийн жагсаалт
          </div>
          {loadError && (
            <div className="flex items-center gap-1.5 text-xs text-red-500">
              <AlertCircle size={13} />
              {loadError}
              <button onClick={load} className="underline text-gray-500 hover:text-gray-800 ml-1">Дахин оролдох</button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
            <RefreshCw size={16} className="animate-spin" />
            Ачааллаж байна...
          </div>
        ) : users.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-400">Хэрэглэгч байхгүй байна</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 680 }}>
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-6 py-3">Хэрэглэгч</th>
                <th className="px-4 py-3">Утас</th>
                <th className="px-4 py-3">Албан тушаал</th>
                <th className="px-4 py-3">Агуулах</th>
                <th className="px-4 py-3">Төлөв</th>
                <th className="px-4 py-3 text-right">Үйлдэл</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {users.map((u) => {
                const ri = roleInfo(u.role);
                return (
                  <tr
                    key={u.id}
                    className={`transition-colors hover:bg-gray-50/70 ${!u.is_active ? "opacity-50" : ""}`}
                  >
                    {/* Хэрэглэгч */}
                    <td className="px-6 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-bold text-white shadow-sm">
                          {(u.nickname || u.username).charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-medium text-gray-900">{u.nickname || u.username}</div>
                          {u.nickname && (
                            <div className="text-xs text-gray-400">@{u.username}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    {/* Утас */}
                    <td className="px-4 py-3.5 text-gray-500">{u.phone || <span className="text-gray-300">—</span>}</td>
                    {/* Албан тушаал */}
                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-semibold ${ri.color}`}>
                        {ri.label}
                      </span>
                    </td>
                    {/* Агуулах */}
                    <td className="px-4 py-3.5 text-gray-500">
                      {u.tag_ids.length > 0
                        ? <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{u.tag_ids.join(", ")}</span>
                        : <span className="text-gray-300">—</span>
                      }
                    </td>
                    {/* Төлөв */}
                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${u.is_active ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${u.is_active ? "bg-emerald-500" : "bg-gray-400"}`} />
                        {u.is_active ? "Идэвхтэй" : "Идэвхгүй"}
                      </span>
                    </td>
                    {/* Үйлдэл */}
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-1">
                        {/* Toggle */}
                        <button
                          onClick={() => { setToggleTarget(u); setToggleMsg(null); }}
                          title={u.is_active ? "Хаах" : "Нээх"}
                          className={`rounded-lg p-1.5 transition-colors ${u.is_active ? "text-amber-500 hover:bg-amber-50" : "text-emerald-600 hover:bg-emerald-50"}`}
                        >
                          {u.is_active ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                        </button>
                        {/* Нууц үг */}
                        <button
                          onClick={() => { setResetTarget({ id: u.id, username: u.username }); setResetPw(""); setResetMsg(null); }}
                          title="Нууц үг reset"
                          className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-blue-50 hover:text-blue-600"
                        >
                          <KeyRound size={15} />
                        </button>
                        {/* Засах */}
                        <button
                          onClick={() => openEdit(u)}
                          title="Засах"
                          className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
                        >
                          <Pencil size={15} />
                        </button>
                        {/* Устгах */}
                        {u.username !== "admin" && (
                          <button
                            onClick={() => { setDeleteTarget({ id: u.id, username: u.username }); setDeleteMsg(null); }}
                            title="Устгах"
                            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
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

      {/* ── Settings accordions ── */}
      <div className="mt-4 space-y-3">

        {/* ── Roles accordion ── */}
        <AccordionSection
          title="Албан тушаалын удирдлага"
          icon={<Briefcase size={16} className="text-indigo-600" />}
          defaultOpen
        >
          <div className="mt-3 space-y-2">
            {roles.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-semibold ${r.color}`}>{r.label}</span>
                  <span className="text-xs text-gray-400">@{r.value}</span>
                  {r.is_system && <span className="rounded-md bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500">Системийн</span>}
                  <span className="text-xs text-gray-400">→ {BASE_ROLES.find((b) => b.value === r.base_role)?.label ?? r.base_role}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { setEditRoleTarget(r); setEditRoleForm({ label: r.label, color: r.color, base_role: r.base_role, permissions: (r.permissions || "").split(",").filter(Boolean) }); setEditRoleMsg(null); }}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                    title="Засах"
                  >
                    <Pencil size={14} />
                  </button>
                  {!r.is_system && (
                    <button
                      onClick={() => { setDeleteRoleTarget(r); setDeleteRoleMsg(null); }}
                      className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                      title="Устгах"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button
              onClick={() => { setShowRoleCreate(true); setRoleCreateMsg(null); }}
              className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-2.5 text-sm text-gray-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
            >
              <Plus size={15} />
              Шинэ албан тушаал нэмэх
            </button>
          </div>
        </AccordionSection>

        <AccordionSection
          title="Барааны жагсаалт шинэчлэх"
          icon={<Package size={16} className="text-emerald-600" />}
        >
          <p className="mt-2 text-sm text-gray-500">
            master_latest.xlsx файлаас бараануудыг DB-д дахин оруулна. Захиалга үүсгэхийн өмнө заавал шинэчилнэ үү.
          </p>
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <button
              onClick={downloadMaster}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <Download size={14} />
              Татаж авах
            </button>
            <button
              onClick={refreshProducts}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 transition-all"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Шинэчилж байна..." : "Master-аас шинэчлэх"}
            </button>
            {refreshResult && (
              <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                <CheckCircle size={14} />
                Амжилттай: {refreshResult.before} → {refreshResult.after} бараа
              </div>
            )}
            {refreshError && (
              <div className="flex items-center gap-1.5 text-sm text-red-500">
                <AlertCircle size={14} />
                {refreshError}
              </div>
            )}
          </div>
        </AccordionSection>

        <AccordionSection
          title="Нууц үг солих (өөрийн)"
          icon={<KeyRound size={16} className="text-[#0071E3]" />}
        >
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-500">Одоогийн нууц үг</label>
              <input type="password" className={inp} placeholder="••••••••"
                value={pwForm.current} onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-500">Шинэ нууц үг</label>
              <input type="password" className={inp} placeholder="Хамгийн багадаа 8 тэмдэгт"
                value={pwForm.next} onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-500">Давтах</label>
              <input type="password" className={inp} placeholder="••••••••"
                value={pwForm.confirm}
                onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && changePassword()} />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-4">
            <button
              onClick={changePassword}
              disabled={pwLoading}
              className="inline-flex items-center gap-2 rounded-xl bg-[#0071E3] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0063CC] disabled:opacity-50 transition-all"
            >
              {pwLoading && <RefreshCw size={13} className="animate-spin" />}
              {pwLoading ? "Хадгалж байна..." : "Нууц үг солих"}
            </button>
            <StatusMsg msg={pwStatus} />
          </div>
        </AccordionSection>
      </div>

      {/* ══════════════ MODALS ══════════════ */}

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
                <button onClick={() => setShowRoleCreate(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors"><X size={18} /></button>
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
                  <p className="mt-1 text-xs text-gray-400">Энэ албан тушаал ямар хандалтын эрхтэй байхыг тодорхойлно</p>
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
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded accent-indigo-600"
                          checked={roleForm.permissions.includes(p.key)}
                          onChange={() => setRoleForm((prev) => ({
                            ...prev,
                            permissions: prev.permissions.includes(p.key)
                              ? prev.permissions.filter((k) => k !== p.key)
                              : [...prev.permissions, p.key],
                          }))}
                        />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              {roleCreateMsg && <div className="mt-3"><StatusMsg msg={roleCreateMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setShowRoleCreate(false)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">Болих</button>
                <button onClick={createRole} disabled={roleCreateLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-all">
                  {roleCreateLoading && <RefreshCw size={13} className="animate-spin" />}
                  Нэмэх
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
                <button onClick={() => setEditRoleTarget(null)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors"><X size={18} /></button>
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
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded accent-indigo-600"
                          checked={editRoleForm.permissions.includes(p.key)}
                          onChange={() => setEditRoleForm((prev) => ({
                            ...prev,
                            permissions: prev.permissions.includes(p.key)
                              ? prev.permissions.filter((k) => k !== p.key)
                              : [...prev.permissions, p.key],
                          }))}
                        />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              {editRoleMsg && <div className="mt-3"><StatusMsg msg={editRoleMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setEditRoleTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">Болих</button>
                <button onClick={saveEditRole} disabled={editRoleLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-all">
                  {editRoleLoading && <RefreshCw size={13} className="animate-spin" />}
                  Хадгалах
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
                <button onClick={() => setDeleteRoleTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">Болих</button>
                <button onClick={confirmDeleteRole} disabled={deleteRoleLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition-all">
                  {deleteRoleLoading && <RefreshCw size={13} className="animate-spin" />}
                  Устгах
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
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100">
                    <Plus size={16} className="text-blue-600" />
                  </div>
                  <h2 className="text-base font-bold text-gray-900">Шинэ хэрэглэгч</h2>
                </div>
                <button onClick={() => setShowCreate(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
                  <X size={18} />
                </button>
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
                  <p className="mt-1 text-xs text-gray-400">Хэрэглэгч солигдоход зөвхөн энэ талбарыг өөрчилнэ</p>
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
                <button onClick={() => setShowCreate(false)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                  Болих
                </button>
                <button onClick={create} disabled={createLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#0071E3] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#0063CC] disabled:opacity-50 transition-all"
                >
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
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
            >
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${toggleTarget.is_active ? "bg-amber-100" : "bg-emerald-100"}`}>
                  {toggleTarget.is_active
                    ? <ToggleLeft size={18} className="text-amber-600" />
                    : <ToggleRight size={18} className="text-emerald-600" />}
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">
                    {toggleTarget.is_active ? "Хэрэглэгч хаах" : "Хэрэглэгч нээх"}
                  </h2>
                  <p className="text-xs text-gray-400">Төлөв өөрчлөгдөнө</p>
                </div>
              </div>
              <p className="mt-4 text-sm text-gray-600">
                <span className="font-semibold text-gray-900">{toggleTarget.username}</span>-г{" "}
                <span className="font-semibold">{toggleTarget.is_active ? "идэвхгүй болгох" : "идэвхжүүлэх"}</span> уу?
              </p>
              {toggleMsg && <div className="mt-3"><StatusMsg msg={toggleMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setToggleTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                  Болих
                </button>
                <button onClick={confirmToggle} disabled={toggleLoading}
                  className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 transition-all ${toggleTarget.is_active ? "bg-amber-500 hover:bg-amber-600" : "bg-emerald-600 hover:bg-emerald-700"}`}
                >
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
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100">
                    <KeyRound size={15} className="text-blue-600" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-gray-900">Нууц үг reset</h2>
                    <p className="text-xs text-[#0071E3] font-medium">{resetTarget.username}</p>
                  </div>
                </div>
                <button onClick={() => setResetTarget(null)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="mt-4">
                <label className="mb-1.5 block text-xs font-medium text-gray-600">Шинэ нууц үг</label>
                <input
                  type="password" autoFocus className={inp}
                  placeholder="Хамгийн багадаа 8 тэмдэгт"
                  value={resetPw}
                  onChange={(e) => setResetPw(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && resetPassword()}
                />
              </div>
              {resetMsg && <div className="mt-3"><StatusMsg msg={resetMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setResetTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                  Болих
                </button>
                <button onClick={resetPassword} disabled={resetLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#0071E3] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#0063CC] disabled:opacity-50 transition-all"
                >
                  {resetLoading && <RefreshCw size={13} className="animate-spin" />}
                  Хадгалах
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
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-100">
                    <Pencil size={15} className="text-indigo-600" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-gray-900">Засах</h2>
                    <p className="text-xs text-[#0071E3] font-medium">{editTarget.username}</p>
                  </div>
                </div>
                <button onClick={() => setEditTarget(null)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Nickname (жинхэнэ нэр)</label>
                  <input className={inp} placeholder="Жишээ: Болд"
                    value={editForm.nickname} onChange={(e) => setEditForm({ ...editForm, nickname: e.target.value })} />
                  <p className="mt-1 text-xs text-gray-400">Хэрэглэгч солигдоход зөвхөн энэ талбарыг өөрчилнэ</p>
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
                  <p className="mt-1 text-xs text-gray-400">Таслалаар тусгаарлана</p>
                </div>
              </div>
              {editMsg && <div className="mt-3"><StatusMsg msg={editMsg} /></div>}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setEditTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                  Болих
                </button>
                <button onClick={saveEdit} disabled={editLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#0071E3] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#0063CC] disabled:opacity-50 transition-all"
                >
                  {editLoading && <RefreshCw size={13} className="animate-spin" />}
                  Хадгалах
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
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100">
                  <Trash2 size={18} className="text-red-600" />
                </div>
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
                <button onClick={() => setDeleteTarget(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                  Болих
                </button>
                <button onClick={confirmDelete} disabled={deleteLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition-all"
                >
                  {deleteLoading && <RefreshCw size={13} className="animate-spin" />}
                  Устгах
                </button>
              </div>
            </motion.div>
          </ModalOverlay>
        )}
      </AnimatePresence>

    </motion.div>
  );
}
