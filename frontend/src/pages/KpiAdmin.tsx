import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Pencil, Trash2, X, ChevronDown, ChevronUp, Check, CheckCircle, AlertCircle,
  Calendar, Shield, ChevronLeft, ChevronRight, UserCheck, UserX,
  Settings2, BarChart3, ListPlus, CalendarDays, TrendingUp, Layers,
} from "lucide-react";
import { api } from "../lib/api";
import KpiAdminConfig from "./KpiAdminConfig";

// ── Types ──────────────────────────────────────────────────────────────────

interface TaskGroup {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
}

interface Template {
  id: number;
  name: string;
  description: string;
  monetary_value: number;
  weight_points: number;          // daily task scoring weight
  task_category: string;          // "daily" | "inventory"
  group_id: number | null;
  group_name: string | null;
  period: string;   // "daily" | "weekly" | "monthly"
  day_of_week: number | null;   // 0=Mon…6=Sun
  day_of_month: number | null;  // 1–31
  is_active: boolean;
}

interface EmployeePlan {
  id?: number;
  employee_id: number;
  employee_username?: string;
  year: number;
  month: number;
  daily_kpi_cap: number;
  monthly_max_kpi: number;
  monthly_inventory_budget?: number;   // 2026-05: Тооллогын төсөв (хоосон бол implicit fallback)
  inventory_shortage?: number;         // 2026-05: Тооллогын дутагдал (manual)
}

const MON_DAYS      = ["Да", "Мя", "Лх", "Пү", "Ба", "Бя", "Ня"]; // 0=Mon short
const MON_DAYS_FULL = ["Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням"];

interface RoleOption { value: string; label: string; }

interface Config {
  id: number;
  employee_id: number;
  employee_username: string;
  template_id: number;
  template_name: string;
  template_monetary_value: number;
  approver_id: number;
  approver_username: string;
  is_active: boolean;
  sort_order: number;
}

interface UserOption {
  id: number;
  username: string;
  nickname?: string;
  role: string;
}

function dispName(u: UserOption) {
  return u.nickname?.trim() || u.username;
}

interface AdminTask {
  id: number;
  task_name: string;
  monetary_value: number;
  task_category: string;   // "daily" | "inventory"
  date: string;
  approver_id: number;
  approver_username: string;
  is_active: boolean;
}

interface SalaryRow {
  employee_id: number;
  employee_username: string;
  daily_score_pct: number;        // 0–100
  daily_payout: number;
  inventory_payout: number;
  total_kpi: number;
  daily_kpi_cap: number;
  monthly_max_kpi: number;
  plan_exists: boolean;
  // 2026-05: Тооллогын шинэ багана
  monthly_inventory_budget: number;
  inventory_shortage: number;
  final_payout: number;
  // 2026-05: Шинэ оноо багана
  daily_pts_max: number;
  daily_pts_got: number;
  inv_pts_max: number;
  inv_pts_got: number;
  // Дэлгэрэнгүй оноо (legacy)
  total_possible_pts: number;
  total_approved_pts: number;
  total_rejected_pts: number;
  total_pending_pts: number;
  // Ажлын өдрүүд
  scheduled_days: number;
  worked_days: number;
  // Тооллого дэлгэрэнгүй
  inventory_total_pts: number;
  inventory_approved_pts: number;
  inventory_budget: number;
  // Нэмэлт ажил (шууд ₮)
  extra_payout: number;
  // Ээлж нөхсөн нэмэгдэл
  shift_cover_days: number;
  shift_bonus: number;
  // Хасалт
  daily_deducted: number;
  // legacy
  total_approved: number;
  total_pending: number;
  total_rejected: number;
  entries_approved: number;
}

interface DetailChecklist {
  id: number;
  date: string;
  status: string;
  entries: {
    id: number;
    task_name: string;
    monetary_value: number;
    task_category: string;
    is_checked: boolean;
    approval_status: string;
    approval_note: string;
    approver_username: string;
    is_adhoc: boolean;
  }[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  pending:  "bg-amber-50 text-amber-700",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-red-50 text-red-700",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Хүлээгдэж буй", approved: "Батлагдсан", rejected: "Татгалзсан",
};

const TAB_LABELS: Record<"config" | "plan" | "report" | "extra" | "schedule", string> = {
  config:   "Тохиргоо",
  plan:     "Сарын КПИ",
  report:   "Цалингийн тайлан",
  extra:    "Нэмэлт ажил",
  schedule: "Хуваарь",
};

function localToday() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
}

function Toast({ toast }: { toast: { msg: string; ok: boolean } | null }) {
  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: -16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16, scale: 0.96 }}
          transition={{ duration: 0.18 }}
          className={`fixed top-4 right-4 z-[100] flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${
            toast.ok ? "bg-emerald-500 text-white" : "bg-red-500 text-white"
          }`}
        >
          {toast.ok ? <CheckCircle size={15} /> : <AlertCircle size={15} />}
          {toast.msg}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ConfirmModal({ open, title, desc, onConfirm, onClose, loading }: {
  open: boolean;
  title: string;
  desc: string;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
}) {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.18 }}
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h2 className="text-base font-bold text-gray-900">{title}</h2>
                <p className="text-xs text-gray-400">{desc}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={onClose}
                className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Болих
              </button>
              <button
                onClick={onConfirm}
                disabled={loading}
                className="rounded-xl bg-red-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition-all"
              >
                {loading ? "..." : "Устгах"}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// ── Tab config with icons ───────────────────────────────────────────────────

const TAB_CONFIG = [
  { key: "config"   as const, label: "Тохиргоо",       icon: Settings2,    desc: "Загвар & Хуваарилалт" },
  { key: "plan"     as const, label: "Сарын КПИ",      icon: TrendingUp,   desc: "Cap тохируулах" },
  { key: "report"   as const, label: "Тайлан",          icon: BarChart3,    desc: "Цалингийн тайлан" },
  { key: "extra"    as const, label: "Нэмэлт",          icon: ListPlus,     desc: "Өдрийн нэмэлт ажил" },
  { key: "schedule" as const, label: "Хуваарь",         icon: CalendarDays, desc: "Ирц & Хуваарь" },
] as const;

// ── Main Component ─────────────────────────────────────────────────────────

export default function KpiAdmin() {
  const [tab, setTab] = useState<"config" | "plan" | "report" | "extra" | "schedule">("config");
  const currentTab = TAB_CONFIG.find(t => t.key === tab)!;

  return (
    <div className="space-y-0">
      {/* ── Page header ── */}
      <div className="mb-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0071E3]/10">
            <currentTab.icon size={20} className="text-[#0071E3]" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">KPI удирдлага</h1>
            <p className="text-xs text-gray-400 mt-0.5">{currentTab.desc}</p>
          </div>
        </div>
      </div>

      {/* ── Tab bar — bottom-border style ── */}
      <div className="border-b border-gray-200 mb-5">
        <div className="flex gap-0 overflow-x-auto no-scrollbar">
          {TAB_CONFIG.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`
                  relative flex items-center gap-1.5 whitespace-nowrap px-4 py-2.5 text-sm font-medium
                  border-b-2 transition-all duration-150
                  ${active
                    ? "border-[#0071E3] text-[#0071E3]"
                    : "border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300"
                  }
                `}
              >
                <Icon size={14} className={active ? "text-[#0071E3]" : "text-gray-400"} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Tab content ── */}
      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
      >
        {tab === "config"   ? <KpiAdminConfig />
          : tab === "plan"   ? <PlanTab />
          : tab === "report" ? <ReportTab />
          : tab === "extra"  ? <ExtraDailyTaskPanel />
          : <ScheduleTab />}
      </motion.div>
    </div>
  );
}

// ── Config Tab ─────────────────────────────────────────────────────────────

function ConfigTab() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [configs, setConfigs] = useState<Config[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<string>("");
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Template modal
  const [tplModal, setTplModal] = useState(false);
  const [editTpl, setEditTpl] = useState<Template | null>(null);
  const [tplName, setTplName] = useState("");
  const [tplDesc, setTplDesc] = useState("");
  const [tplAmount, setTplAmount] = useState("");          // inventory: ₮; daily: unused
  const [tplPoints, setTplPoints] = useState("");          // daily: оноо
  const [tplCategory, setTplCategory] = useState("daily"); // "daily" | "inventory"
  const [tplActive, setTplActive] = useState(true);
  const [tplGroup, setTplGroup] = useState<string>("");
  const [tplPeriod, setTplPeriod] = useState("daily");
  const [tplDayOfWeek, setTplDayOfWeek] = useState<string>("");
  const [tplDayOfMonth, setTplDayOfMonth] = useState<string>("");
  const [tplSaving, setTplSaving] = useState(false);

  // Group inline add
  const [grpInput, setGrpInput] = useState("");
  const [grpSaving, setGrpSaving] = useState(false);
  const [editGrp, setEditGrp] = useState<TaskGroup | null>(null);
  const [editGrpName, setEditGrpName] = useState("");

  // Confirm dialogs
  const [confirmGrp, setConfirmGrp] = useState<TaskGroup | null>(null);
  const [confirmCfg, setConfirmCfg] = useState<Config | null>(null);

  // Config modal
  const [cfgModal, setCfgModal] = useState(false);
  const [cfgTemplate, setCfgTemplate] = useState("");
  const [cfgApprover, setCfgApprover] = useState("");

  // Edit config modal
  const [editCfgModal, setEditCfgModal] = useState(false);
  const [editCfg, setEditCfg] = useState<Config | null>(null);
  const [editApprover, setEditApprover] = useState("");

  // ── Role bulk mode ──
  const [configMode, setConfigMode] = useState<"single" | "role">("single");
  const [selectedRole, setSelectedRole] = useState<string>("");
  const [bulkApprover, setBulkApprover] = useState<string>("");
  const [roleConfigs, setRoleConfigs] = useState<Config[]>([]);
  const [bulkAdding, setBulkAdding] = useState<number | null>(null);
  const [confirmBulkDel, setConfirmBulkDel] = useState<{ templateId: number; name: string } | null>(null);
  const [roles, setRoles] = useState<RoleOption[]>([]);

  function notify(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  async function loadTemplates() {
    try {
      const res = await api.get("/kpi/templates");
      setTemplates(res.data);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Загвар ачааллахад алдаа гарлаа", false);
    }
  }
  async function loadGroups() {
    try {
      const res = await api.get("/kpi/groups");
      setGroups(res.data);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Бүлэг ачааллахад алдаа гарлаа", false);
    }
  }
  async function loadUsers() {
    try {
      const res = await api.get("/admin/users");
      setUsers(res.data);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Хэрэглэгч ачааллахад алдаа гарлаа", false);
    }
  }
  async function loadConfigs(empId: string) {
    if (!empId) return;
    const res = await api.get("/kpi/configs", { params: { employee_id: empId } });
    setConfigs(res.data);
  }
  async function loadRoles() {
    try { const res = await api.get("/admin/roles"); setRoles(res.data); } catch {}
  }

  useEffect(() => { loadTemplates(); loadGroups(); loadUsers(); loadRoles(); }, []);
  useEffect(() => { loadConfigs(selectedEmployee); }, [selectedEmployee]);
  useEffect(() => { if (selectedRole) loadRoleConfigs(selectedRole); else setRoleConfigs([]); }, [selectedRole, users]);

  // Group CRUD
  async function addGroup() {
    if (!grpInput.trim()) return;
    setGrpSaving(true);
    try {
      await api.post("/kpi/groups", { name: grpInput.trim(), sort_order: groups.length });
      setGrpInput("");
      await loadGroups();
      notify("Бүлэг нэмэгдлээ");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setGrpSaving(false);
    }
  }
  async function saveGroupName(g: TaskGroup) {
    if (!editGrpName.trim()) return;
    try {
      await api.put(`/kpi/groups/${g.id}`, { name: editGrpName.trim(), sort_order: g.sort_order, is_active: g.is_active });
      setEditGrp(null); setEditGrpName("");
      await loadGroups();
      notify("Засварлагдлаа");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }
  async function deleteGroup(id: number) {
    try {
      await api.delete(`/kpi/groups/${id}`);
      await loadGroups();
      notify("Устгагдлаа");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setConfirmGrp(null);
    }
  }

  // Template CRUD
  function openCreateTpl() {
    setEditTpl(null); setTplName(""); setTplDesc(""); setTplAmount(""); setTplPoints("");
    setTplCategory("daily"); setTplActive(true); setTplGroup(""); setTplPeriod("daily");
    setTplDayOfWeek(""); setTplDayOfMonth("");
    setTplModal(true);
  }
  function openEditTpl(t: Template) {
    setEditTpl(t); setTplName(t.name); setTplDesc(t.description);
    setTplCategory(t.task_category || "daily");
    setTplPoints(String(t.weight_points ?? 0));
    setTplAmount(String(t.monetary_value));
    setTplActive(t.is_active); setTplPeriod(t.period || "daily");
    setTplGroup(t.group_id != null ? String(t.group_id) : "");
    setTplDayOfWeek(t.day_of_week != null ? String(t.day_of_week) : "");
    setTplDayOfMonth(t.day_of_month != null ? String(t.day_of_month) : "");
    setTplModal(true);
  }
  async function saveTpl() {
    const isDaily = tplCategory === "daily";
    const payload = {
      name: tplName, description: tplDesc,
      monetary_value: isDaily ? 0 : parseFloat(tplAmount || "0"),
      weight_points: isDaily ? parseFloat(tplPoints || "0") : 0,
      task_category: tplCategory,
      group_id: tplGroup ? parseInt(tplGroup) : null,
      period: tplPeriod,
      day_of_week: (tplPeriod === "weekly" && tplDayOfWeek !== "") ? parseInt(tplDayOfWeek) : null,
      day_of_month: (tplPeriod === "monthly" && tplDayOfMonth !== "") ? parseInt(tplDayOfMonth) : null,
      is_active: tplActive,
    };
    setTplSaving(true);
    try {
      if (editTpl) {
        await api.put(`/kpi/templates/${editTpl.id}`, payload);
      } else {
        await api.post("/kpi/templates", payload);
      }
      await loadTemplates();
      setTplModal(false);
      notify(editTpl ? "Засварлагдлаа" : "Үүсгэгдлээ");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setTplSaving(false);
    }
  }

  // Config CRUD
  async function addConfig() {
    if (!selectedEmployee || !cfgTemplate || !cfgApprover) return;
    try {
      await api.post("/kpi/configs", {
        employee_id: parseInt(selectedEmployee),
        template_id: parseInt(cfgTemplate),
        approver_id: parseInt(cfgApprover),
      });
      await loadConfigs(selectedEmployee);
      setCfgModal(false); setCfgTemplate(""); setCfgApprover("");
      notify("Ажил хуваарилагдлаа");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }
  async function deleteConfig(id: number) {
    try {
      await api.delete(`/kpi/configs/${id}`);
      await loadConfigs(selectedEmployee);
      notify("Устгагдлаа");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setConfirmCfg(null);
    }
  }
  // Load all configs for every user belonging to selectedRole
  async function loadRoleConfigs(role: string) {
    const targets = users.filter(u => u.role === role);
    if (!targets.length) { setRoleConfigs([]); return; }
    const results = await Promise.all(
      targets.map(u =>
        api.get("/kpi/configs", { params: { employee_id: u.id } })
          .then(r => r.data as Config[])
          .catch(() => [] as Config[])
      )
    );
    setRoleConfigs(results.flat());
  }

  // Bulk add: POST configs for every user in selectedRole
  async function bulkAddTemplate(templateId: number, templateName: string) {
    if (!selectedRole || !bulkApprover) {
      notify("Зөвшөөрөгч сонгоно уу", false); return;
    }
    setBulkAdding(templateId);
    const targets = users.filter(u => u.role === selectedRole);
    await Promise.all(
      targets.map(u =>
        api.post("/kpi/configs", {
          employee_id: u.id,
          template_id: templateId,
          approver_id: parseInt(bulkApprover),
        }).catch(() => {})
      )
    );
    await loadRoleConfigs(selectedRole);
    notify(`"${templateName}" — ${targets.length} ажилтанд нэмэгдлээ`);
    setBulkAdding(null);
  }

  // Bulk delete: remove all configs with given templateId for users in selectedRole
  async function bulkDeleteTemplate(templateId: number) {
    const toDelete = roleConfigs.filter(c => c.template_id === templateId);
    await Promise.all(toDelete.map(c => api.delete(`/kpi/configs/${c.id}`).catch(() => {})));
    await loadRoleConfigs(selectedRole);
    notify("Бүгдээс хасагдлаа");
    setConfirmBulkDel(null);
  }

  function openEditCfg(c: Config) {
    setEditCfg(c); setEditApprover(String(c.approver_id)); setEditCfgModal(true);
  }
  async function saveEditCfg() {
    if (!editCfg) return;
    try {
      await api.put(`/kpi/configs/${editCfg.id}`, { approver_id: parseInt(editApprover) });
      await loadConfigs(selectedEmployee);
      setEditCfgModal(false);
      notify("Зөвшөөрөгч шинэчлэгдлээ");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  const employeeUsers = users.filter(u => u.role !== "admin");

  // Unique roles for bulk mode
  const distinctRoles = [...new Set(employeeUsers.map(u => u.role))];
  // Templates already assigned in bulk mode (unique template_ids in roleConfigs)
  const roleConfigTplIds = new Set(roleConfigs.map(c => c.template_id));

  // Group templates for display
  const grouped = groups.map(g => ({
    group: g,
    items: templates.filter(t => t.group_id === g.id),
  }));
  const ungrouped = templates.filter(t => t.group_id == null);

  return (
    <div className="space-y-5">
      <Toast toast={toast} />

      {/* Confirm modals */}
      <ConfirmModal open={confirmGrp !== null} title="Бүлэг устгах уу?"
        desc={confirmGrp ? `"${confirmGrp.name}" бүлгийг устгана` : ""}
        onConfirm={() => confirmGrp && deleteGroup(confirmGrp.id)}
        onClose={() => setConfirmGrp(null)} />
      <ConfirmModal open={confirmCfg !== null} title="Хуваарилалт устгах уу?"
        desc={confirmCfg ? `"${confirmCfg.template_name}" ажлын хуваарилалтыг устгана` : ""}
        onConfirm={() => confirmCfg && deleteConfig(confirmCfg.id)}
        onClose={() => setConfirmCfg(null)} />
      <ConfirmModal open={confirmBulkDel !== null}
        title={`"${confirmBulkDel?.name}" — бүгдээс хасах уу?`}
        desc={`"${roles.find(r => r.value === selectedRole)?.label ?? selectedRole}" тушаалтай бүх ажилтнаас хасагдана`}
        onConfirm={() => confirmBulkDel && bulkDeleteTemplate(confirmBulkDel.templateId)}
        onClose={() => setConfirmBulkDel(null)} />

      {/* ── Groups panel ── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-3">
          <Layers size={15} className="text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-800">Ажлын бүлэг</h2>
          <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
            {groups.length}
          </span>
        </div>
        <div className="p-4 space-y-3">
          {/* Group pills */}
          {groups.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {groups.map(g => (
                <div key={g.id}
                  className={`group flex items-center gap-1 rounded-full border px-3 py-1 transition-colors ${
                    editGrp?.id === g.id
                      ? "border-blue-300 bg-blue-50"
                      : "border-gray-200 bg-gray-50 hover:border-gray-300"
                  }`}
                >
                  {editGrp?.id === g.id ? (
                    <>
                      <input autoFocus value={editGrpName}
                        onChange={e => setEditGrpName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") saveGroupName(g);
                          if (e.key === "Escape") { setEditGrp(null); setEditGrpName(""); }
                        }}
                        className="w-28 bg-transparent text-xs text-blue-700 focus:outline-none"
                      />
                      <button onClick={() => saveGroupName(g)} className="text-emerald-500 hover:text-emerald-700 ml-1">
                        <Check size={12} />
                      </button>
                      <button onClick={() => { setEditGrp(null); setEditGrpName(""); }} className="text-gray-400 hover:text-gray-600">
                        <X size={12} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs font-medium text-gray-700">{g.name}</span>
                      <button
                        onClick={() => { setEditGrp(g); setEditGrpName(g.name); }}
                        className="ml-1.5 text-gray-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={() => setConfirmGrp(g)}
                        className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <X size={11} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* Add new group */}
          <div className="flex gap-2">
            <input value={grpInput} onChange={e => setGrpInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addGroup()}
              placeholder="Шинэ бүлгийн нэр... (Enter дарж нэмэх)"
              className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all"
            />
            <button onClick={addGroup} disabled={!grpInput.trim() || grpSaving}
              className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white hover:bg-blue-600 disabled:opacity-40 transition-all"
            >
              <Plus size={13} /> Нэмэх
            </button>
          </div>
        </div>
      </div>

      {/* ── Two-column grid ── */}
      <div className="grid gap-5 lg:grid-cols-2">

        {/* ── Template panel ── */}
        <div className="flex flex-col rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-3">
            <Settings2 size={15} className="text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-800">Ажлын загвар</h2>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
              {templates.filter(t => t.is_active).length}/{templates.length}
            </span>
            <button onClick={openCreateTpl}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 transition-colors"
            >
              <Plus size={13} /> Нэмэх
            </button>
          </div>

          {templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
                <Settings2 size={22} className="text-gray-400" />
              </div>
              <p className="text-sm font-medium text-gray-600">Загвар байхгүй</p>
              <p className="text-xs text-gray-400">Дээрх "Нэмэх" товч дарж эхний загвараа үүсгэнэ үү</p>
            </div>
          ) : (
            <div className="max-h-[560px] overflow-y-auto">
              {[
                ...grouped.filter(g => g.items.length > 0).map(({ group, items }) => ({ label: group.name, items })),
                ...(ungrouped.length > 0 ? [{ label: grouped.filter(g => g.items.length > 0).length > 0 ? "Бүлэггүй" : null, items: ungrouped }] : [])
              ].map(({ label, items }, gi) => (
                <div key={gi}>
                  {label && (
                    <div className="sticky top-0 z-10 bg-gray-50/95 backdrop-blur-sm px-5 py-1.5 border-b border-gray-100">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{label}</span>
                    </div>
                  )}
                  <ul>
                    {items.map(t => {
                      const isDaily = (t.task_category || "daily") === "daily";
                      return (
                        <li key={t.id}
                          className={`group flex items-stretch border-b border-gray-50 transition-colors hover:bg-gray-50/60 ${!t.is_active ? "opacity-40" : ""}`}
                        >
                          {/* Category left bar */}
                          <div className={`w-[3px] shrink-0 ${isDaily ? "bg-blue-400" : "bg-amber-400"}`} />
                          <div className="flex flex-1 items-center gap-3 px-4 py-2.5">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 leading-snug line-clamp-1">{t.name}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                {/* Value badge */}
                                {isDaily ? (
                                  <span className="flex items-center gap-0.5 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-600">
                                    {t.weight_points ?? 0} оноо
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-0.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-600">
                                    {t.monetary_value.toLocaleString()}₮
                                  </span>
                                )}
                                {/* Category badge */}
                                {!isDaily && (
                                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">НЭМЭЛТ АЖИЛ</span>
                                )}
                                {/* Period badge */}
                                {t.period !== "daily" && (
                                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                    t.period === "weekly"
                                      ? "bg-violet-50 text-violet-600"
                                      : "bg-amber-50 text-amber-600"
                                  }`}>
                                    {t.period === "weekly"
                                      ? (t.day_of_week != null ? MON_DAYS_FULL[t.day_of_week] : "7 хоног бүр")
                                      : (t.day_of_month != null ? `${t.day_of_month}-нд` : "Сар бүр")}
                                  </span>
                                )}
                                {!t.is_active && (
                                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400">Идэвхгүй</span>
                                )}
                              </div>
                            </div>
                            {/* Edit button — always visible */}
                            <button onClick={() => openEditTpl(t)}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-300 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                            >
                              <Pencil size={13} />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Config panel ── */}
        <div className="flex flex-col rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          {/* Header */}
          <div className="border-b border-gray-100 px-5 py-3">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-800">Ажлын хуваарилалт</h2>
              {/* Mode toggle — pill style */}
              <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
                <button onClick={() => setConfigMode("single")}
                  className={`rounded-lg px-3 py-1 text-xs font-semibold transition-all ${
                    configMode === "single" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  Нэг ажилтан
                </button>
                <button onClick={() => setConfigMode("role")}
                  className={`rounded-lg px-3 py-1 text-xs font-semibold transition-all ${
                    configMode === "role" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  Тушаалаар
                </button>
              </div>
            </div>

            {configMode === "single" ? (
              <div className="flex gap-2">
                <select value={selectedEmployee} onChange={e => setSelectedEmployee(e.target.value)}
                  className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all"
                >
                  <option value="">— Ажилтан сонгох —</option>
                  {employeeUsers.map(u => (
                    <option key={u.id} value={u.id}>
                      {dispName(u)} · {roles.find(r => r.value === u.role)?.label ?? u.role}
                    </option>
                  ))}
                </select>
                {selectedEmployee && (
                  <button onClick={() => setCfgModal(true)}
                    className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[#0071E3] px-3 py-2 text-xs font-semibold text-white hover:bg-blue-600 transition-colors"
                  >
                    <Plus size={13} /> Нэмэх
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <select value={selectedRole} onChange={e => setSelectedRole(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all"
                >
                  <option value="">— Тушаал сонгох —</option>
                  {distinctRoles.map(r => {
                    const lbl = roles.find(rl => rl.value === r)?.label ?? r;
                    const cnt = users.filter(u => u.role === r).length;
                    return <option key={r} value={r}>{lbl} ({cnt} ажилтан)</option>;
                  })}
                </select>
                {selectedRole && (
                  <select value={bulkApprover} onChange={e => setBulkApprover(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all"
                  >
                    <option value="">— Зөвшөөрөгч сонгох —</option>
                    {users.map(u => (
                      <option key={u.id} value={u.id}>{dispName(u)} ({roles.find(r => r.value === u.role)?.label ?? u.role})</option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto max-h-[500px]">
            {configMode === "single" ? (
              !selectedEmployee ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100">
                    <UserCheck size={18} className="text-gray-400" />
                  </div>
                  <p className="text-sm text-gray-500">Дээрээс ажилтан сонгоно уу</p>
                </div>
              ) : configs.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50">
                    <Plus size={18} className="text-blue-400" />
                  </div>
                  <p className="text-sm font-medium text-gray-600">Ажил хуваарилаагүй байна</p>
                  <button onClick={() => setCfgModal(true)}
                    className="mt-1 rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white hover:bg-blue-600 transition-colors"
                  >
                    Эхний ажил нэмэх
                  </button>
                </div>
              ) : (
                <ul>
                  {configs.map(c => (
                    <li key={c.id}
                      className="group flex items-center gap-3 border-b border-gray-50 px-5 py-3 hover:bg-gray-50/60 transition-colors last:border-0"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{c.template_name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">Зөвшөөрөгч: <span className="font-medium text-gray-600">{c.approver_username}</span></p>
                      </div>
                      <div className="flex shrink-0 gap-0.5">
                        <button onClick={() => openEditCfg(c)}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-300 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                        >
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => setConfirmCfg(c)}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              !selectedRole ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100">
                    <Layers size={18} className="text-gray-400" />
                  </div>
                  <p className="text-sm text-gray-500">Дээрээс тушаал сонгоно уу</p>
                </div>
              ) : !bulkApprover ? (
                <div className="mx-4 my-3 rounded-xl bg-amber-50 border border-amber-100 px-4 py-3 text-xs text-amber-700">
                  ⚠️ Зөвшөөрөгч сонгоод загвар нэмж эхэлнэ үү
                </div>
              ) : (
                <div>
                  {[
                    ...grouped.filter(g => g.items.length > 0).map(({ group, items }) => ({ label: group.name, items })),
                    ...(ungrouped.length > 0 ? [{ label: "Бүлэггүй", items: ungrouped }] : [])
                  ].map(({ label, items }, gi) => (
                    <div key={gi}>
                      <div className="bg-gray-50 px-5 py-1.5 border-b border-gray-100">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{label}</span>
                      </div>
                      <ul>
                        {items.filter(t => t.is_active).map(t => {
                          const hasAll = roleConfigTplIds.has(t.id);
                          const usersInRole = users.filter(u => u.role === selectedRole).length;
                          const assignedCount = roleConfigs.filter(c => c.template_id === t.id).length;
                          const isPartial = assignedCount > 0 && assignedCount < usersInRole;
                          return (
                            <li key={t.id}
                              className="flex items-center gap-3 border-b border-gray-50 px-5 py-3 hover:bg-gray-50/60 transition-colors last:border-0"
                            >
                              {/* Status indicator */}
                              <div className={`h-2 w-2 shrink-0 rounded-full ${
                                hasAll ? "bg-emerald-400" : isPartial ? "bg-amber-400" : "bg-gray-200"
                              }`} />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">{t.name}</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                  {hasAll
                                    ? <span className="text-emerald-600 font-medium">Бүгдэд ({usersInRole}) нэмэгдсэн ✓</span>
                                    : isPartial
                                    ? <span className="text-amber-600">{assignedCount}/{usersInRole} ажилтанд</span>
                                    : "Нэмэгдээгүй"}
                                </p>
                              </div>
                              {hasAll ? (
                                <button onClick={() => setConfirmBulkDel({ templateId: t.id, name: t.name })}
                                  className="flex shrink-0 items-center gap-1 rounded-lg bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-500 hover:bg-red-100 transition-colors"
                                >
                                  <X size={11} /> Хасах
                                </button>
                              ) : (
                                <button onClick={() => bulkAddTemplate(t.id, t.name)}
                                  disabled={bulkAdding === t.id}
                                  className={`flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold disabled:opacity-40 transition-colors ${
                                    isPartial
                                      ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                                      : "bg-blue-50 text-[#0071E3] hover:bg-blue-100"
                                  }`}
                                >
                                  {bulkAdding === t.id
                                    ? <span className="flex items-center gap-1"><span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" /> Нэмж байна</span>
                                    : isPartial
                                    ? <><Plus size={11} /> +{usersInRole - assignedCount} хүнд</>
                                    : <><Plus size={11} /> Бүгдэд нэмэх</>}
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      </div>

      {/* Template modal */}
      {tplModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4">
          <div className="w-full max-w-md rounded-t-2xl bg-white sm:rounded-2xl overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">{editTpl ? "Загвар засварлах" : "Шинэ загвар нэмэх"}</h2>
                <p className="text-xs text-gray-400 mt-0.5">Ажилтнуудад хуваарилах ажлын загвар</p>
              </div>
              <button onClick={() => setTplModal(false)} className="rounded-xl p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"><X size={16} /></button>
            </div>
            {/* Modal body */}
            <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* Task category selector */}
              <div className="flex rounded-xl border border-gray-200 overflow-hidden">
                {(["daily", "inventory"] as const).map(cat => (
                  <button key={cat} type="button"
                    onClick={() => setTplCategory(cat)}
                    className={`flex-1 py-2 text-xs font-semibold transition-colors ${tplCategory === cat
                      ? cat === "daily" ? "bg-[#0071E3] text-white" : "bg-amber-500 text-white"
                      : "bg-white text-gray-500 hover:bg-gray-50"}`}>
                    {cat === "daily" ? "📋 Өдөр тутмын ажил" : "📦 Нэмэлт ажил"}
                  </button>
                ))}
              </div>
              {/* Category description */}
              <p className="text-xs text-gray-400 -mt-2">
                {tplCategory === "daily"
                  ? "Оноогоор дүгнэгдэнэ. Сарын KPI cap-аас score × % авна."
                  : "Оноогоор дүгнэгдэнэ. Тооллого зэрэг нэмэлт ажлын оноо."}
              </p>
              {/* Name */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Ажлын нэр <span className="text-red-400">*</span></label>
                <textarea value={tplName} onChange={e => setTplName(e.target.value)} rows={2}
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3] resize-none leading-relaxed"
                  placeholder="Ажлын нэр оруулна уу..." />
              </div>
              {/* Group + Period row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Бүлэг</label>
                  <select value={tplGroup} onChange={e => setTplGroup(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]">
                    <option value="">— Бүлэггүй —</option>
                    {groups.filter(g => g.is_active).map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Давтамж</label>
                  <select value={tplPeriod} onChange={e => { setTplPeriod(e.target.value); setTplDayOfWeek(""); setTplDayOfMonth(""); }}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]">
                    <option value="daily">Өдөр бүр</option>
                    <option value="weekly">7 хоног бүр</option>
                    <option value="monthly">Сар бүр</option>
                  </select>
                </div>
              </div>
              {/* Day selector — conditional */}
              {tplPeriod === "weekly" && (
                <div className="rounded-xl border border-violet-100 bg-violet-50/50 p-3">
                  <label className="mb-1.5 block text-xs font-semibold text-violet-700">Аль гаригт хийгдэх вэ?</label>
                  <select value={tplDayOfWeek} onChange={e => setTplDayOfWeek(e.target.value)}
                    className="w-full rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400">
                    <option value="">Аль ч өдөр (долоо хоногт нэг удаа)</option>
                    {MON_DAYS_FULL.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </div>
              )}
              {tplPeriod === "monthly" && (
                <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-3">
                  <label className="mb-1.5 block text-xs font-semibold text-amber-700">Сарын хэддэнд хийгдэх вэ?</label>
                  <select value={tplDayOfMonth} onChange={e => setTplDayOfMonth(e.target.value)}
                    className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400">
                    <option value="">Аль ч өдөр (сард нэг удаа)</option>
                    {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                      <option key={d} value={d}>{d}-нд</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Weight points (daily) OR Monetary value (inventory) */}
              {tplCategory === "daily" ? (
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">
                    Оноо (жин) <span className="text-red-400">*</span>
                  </label>
                  <input type="number" value={tplPoints} onChange={e => setTplPoints(e.target.value)}
                    onWheel={e => e.currentTarget.blur()}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]"
                    placeholder="жишээ нь 10" />
                  <p className="mt-1 text-xs text-gray-400">Энэ ажил бусдаас хичнээн чухал вэ? Их оноо = их жин</p>
                </div>
              ) : (
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-amber-700 uppercase tracking-wide">
                    Мөнгөн дүн (₮) <span className="text-red-400">*</span>
                  </label>
                  <div className="relative">
                    <input type="number" value={tplAmount} onChange={e => setTplAmount(e.target.value)}
                      onWheel={e => e.currentTarget.blur()}
                      className="w-full rounded-xl border border-amber-200 px-3 py-2.5 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                      placeholder="0" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-amber-400 pointer-events-none">₮</span>
                  </div>
                  {tplAmount && !isNaN(parseFloat(tplAmount)) && (
                    <p className="mt-1 text-xs text-amber-600">{parseFloat(tplAmount).toLocaleString()} төгрөг хүртэл авна</p>
                  )}
                </div>
              )}
              {/* Active toggle */}
              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                <span className="text-sm text-gray-700">Идэвхтэй</span>
                <input type="checkbox" checked={tplActive} onChange={e => setTplActive(e.target.checked)} className="h-4 w-4 accent-[#0071E3]" />
              </label>
            </div>
            {/* Footer */}
            <div className="flex items-center gap-3 px-6 py-4 border-t border-gray-100 bg-gray-50/50">
              <button onClick={() => setTplModal(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
                Болих
              </button>
              <button onClick={saveTpl}
                disabled={!tplName.trim() || (tplCategory === "daily" ? !tplPoints : !tplAmount) || tplSaving}
                className="flex-1 rounded-xl bg-[#0071E3] py-2.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-40 transition-colors">
                {tplSaving ? "Хадгалж байна..." : "Хадгалах"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add config modal */}
      {cfgModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4">
          <div className="w-full max-w-sm rounded-t-2xl bg-white sm:rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="font-semibold text-gray-900">Ажил хуваарилах</h2>
                <p className="text-xs text-gray-400 mt-0.5">{users.find(u => String(u.id) === selectedEmployee) ? `${dispName(users.find(u => String(u.id) === selectedEmployee)!)} — ажил нэмэх` : ""}</p>
              </div>
              <button onClick={() => setCfgModal(false)} className="rounded-xl p-2 text-gray-400 hover:bg-gray-100 transition-colors"><X size={16} /></button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Ажлын загвар</label>
                <select value={cfgTemplate} onChange={e => setCfgTemplate(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]">
                  <option value="">Сонгох...</option>
                  {groups.filter(g => g.is_active).map(g => {
                    const items = templates.filter(t => t.group_id === g.id && t.is_active);
                    if (!items.length) return null;
                    return (
                      <optgroup key={g.id} label={g.name}>
                        {items.map(t => {
                          const isDaily = (t.task_category || "daily") === "daily";
                          const val = isDaily ? `${t.weight_points ?? 0} оноо` : `${t.monetary_value.toLocaleString()}₮`;
                          return <option key={t.id} value={t.id}>{t.name} — {val}</option>;
                        })}
                      </optgroup>
                    );
                  })}
                  {templates.filter(t => t.group_id == null && t.is_active).length > 0 && (
                    <optgroup label="Бүлэггүй">
                      {templates.filter(t => t.group_id == null && t.is_active).map(t => {
                        const isDaily = (t.task_category || "daily") === "daily";
                        const val = isDaily ? `${t.weight_points ?? 0} оноо` : `${t.monetary_value.toLocaleString()}₮`;
                        return <option key={t.id} value={t.id}>{t.name} — {val}</option>;
                      })}
                    </optgroup>
                  )}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Зөвшөөрөгч</label>
                <select value={cfgApprover} onChange={e => setCfgApprover(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]">
                  <option value="">Сонгох...</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{dispName(u)} ({roles.find(r => r.value === u.role)?.label ?? u.role})</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-3 px-5 py-4 border-t border-gray-100 bg-gray-50/50">
              <button onClick={() => setCfgModal(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
                Болих
              </button>
              <button onClick={addConfig} disabled={!cfgTemplate || !cfgApprover}
                className="flex-1 rounded-xl bg-[#0071E3] py-2.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-40 transition-colors">
                Хуваарилах
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit config approver modal */}
      {editCfgModal && editCfg && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4">
          <div className="w-full max-w-sm rounded-t-2xl bg-white sm:rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="font-semibold text-gray-900">Зөвшөөрөгч солих</h2>
                <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[220px]">{editCfg.template_name}</p>
              </div>
              <button onClick={() => setEditCfgModal(false)} className="rounded-xl p-2 text-gray-400 hover:bg-gray-100 transition-colors"><X size={16} /></button>
            </div>
            <div className="px-5 py-4">
              <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Шинэ зөвшөөрөгч</label>
              <select value={editApprover} onChange={e => setEditApprover(e.target.value)}
                className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]">
                {users.map(u => (
                  <option key={u.id} value={u.id}>{dispName(u)} ({roles.find(r => r.value === u.role)?.label ?? u.role})</option>
                ))}
              </select>
            </div>
            <div className="flex gap-3 px-5 py-4 border-t border-gray-100 bg-gray-50/50">
              <button onClick={() => setEditCfgModal(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
                Болих
              </button>
              <button onClick={saveEditCfg}
                className="flex-1 rounded-xl bg-[#0071E3] py-2.5 text-sm font-semibold text-white hover:bg-blue-600 transition-colors">
                Хадгалах
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Extra Daily Task Panel ──────────────────────────────────────────────────

function ExtraDailyTaskPanel() {
  const [taskDate, setTaskDate] = useState(localToday());
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editTask, setEditTask] = useState<AdminTask | null>(null);
  const [fName, setFName] = useState("");
  const [fAmount, setFAmount] = useState("0");
  const [fCategory, setFCategory] = useState("daily");   // "daily" | "extra"
  const [fDate, setFDate] = useState(localToday());
  const [fApprover, setFApprover] = useState("");
  const [fActive, setFActive] = useState(true);
  const [fTargetAll, setFTargetAll] = useState(true);
  const [fTargetIds, setFTargetIds] = useState<number[]>([]);

  // Confirm delete task
  const [confirmTask, setConfirmTask] = useState<AdminTask | null>(null);

  function notify(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  async function loadTasks() {
    try {
      const res = await api.get("/kpi/admin-tasks", { params: { date: taskDate } });
      setTasks(res.data);
    } catch {
      notify("Ачааллахад алдаа гарлаа", false);
    }
  }

  async function loadUsers() {
    try {
      const res = await api.get("/admin/users");
      setUsers(res.data);
    } catch {}
  }

  useEffect(() => { loadUsers(); }, []);
  useEffect(() => { loadTasks(); }, [taskDate]);

  function openCreate() {
    setEditTask(null);
    setFName(""); setFAmount("0"); setFCategory("daily"); setFDate(taskDate); setFApprover(""); setFActive(true);
    setFTargetAll(true); setFTargetIds([]);
    setShowModal(true);
  }

  function openEdit(t: AdminTask) {
    setEditTask(t);
    setFName(t.task_name); setFAmount(String(t.monetary_value));
    setFCategory(t.task_category || "daily");
    setFDate(t.date); setFApprover(String(t.approver_id)); setFActive(t.is_active);
    const tids = (t as any).target_employee_ids ?? [];
    setFTargetAll(tids.length === 0);
    setFTargetIds(tids);
    setShowModal(true);
  }

  async function saveTask() {
    if (!fName.trim() || !fApprover || !fDate) return;
    const payload = {
      task_name: fName.trim(),
      monetary_value: parseFloat(fAmount) || 0,
      task_category: fCategory,
      date: fDate,
      approver_id: parseInt(fApprover),
      is_active: fActive,
      target_employee_ids: fTargetAll ? [] : fTargetIds,
    };
    try {
      if (editTask) {
        await api.put(`/kpi/admin-tasks/${editTask.id}`, payload);
        notify("Шинэчлэгдлээ");
      } else {
        await api.post("/kpi/admin-tasks", payload);
        notify("Нэмэгдлээ");
      }
      setShowModal(false);
      await loadTasks();
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  async function deleteTask(id: number) {
    try {
      const res = await api.delete(`/kpi/admin-tasks/${id}`);
      if (res.data?.deactivated) {
        notify("Идэвхгүй болгогдлоо (бусад хэрэглэгчид аль хэдийн ашиглаж байна)");
      } else {
        notify("Устгагдлаа");
      }
      await loadTasks();
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setConfirmTask(null);
    }
  }

  return (
    <div className="space-y-4">
      <Toast toast={toast} />

      <ConfirmModal
        open={confirmTask !== null}
        title="Ажил устгах уу?"
        desc={confirmTask ? `"${confirmTask.task_name}" ажлыг устгана` : ""}
        onConfirm={() => confirmTask && deleteTask(confirmTask.id)}
        onClose={() => setConfirmTask(null)}
      />

      {/* Main card */}
      <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-5 py-3.5">
          <ListPlus size={15} className="text-gray-400 shrink-0" />
          <h2 className="text-sm font-semibold text-gray-800">Нэмэлт өдрийн ажил</h2>
          <input
            type="date"
            value={taskDate}
            onChange={e => setTaskDate(e.target.value)}
            className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all"
          />
          <div className="ml-auto flex items-center gap-2">
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">{tasks.length}</span>
            <button
              onClick={openCreate}
              className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-600 transition-colors"
            >
              <Plus size={13} /> Нэмэх
            </button>
          </div>
        </div>

        {/* Info bar */}
        <div className="flex items-start gap-2 bg-orange-50/60 border-b border-orange-100/60 px-5 py-2.5">
          <span className="mt-0.5 text-orange-400 shrink-0">⚡</span>
          <p className="text-xs text-orange-700">
            Энэ огноонд нэмсэн ажлууд тухайн өдрийн чеклистийг нээсэн <strong>бүх хэрэглэгчид</strong> автоматаар нэмэгдэнэ.
          </p>
        </div>

        {/* Task list */}
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
              <ListPlus size={22} className="text-gray-400" />
            </div>
            <p className="text-sm font-medium text-gray-500">Энэ огноонд нэмэлт ажил байхгүй</p>
            <button onClick={openCreate}
              className="mt-1 rounded-xl bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white hover:bg-blue-600 transition-colors">
              Нэмэлт ажил нэмэх
            </button>
          </div>
        ) : (
          <ul>
            {tasks.map(t => {
              const isInv = (t.task_category || "daily") !== "daily";
              return (
                <li key={t.id}
                  className={`group flex items-stretch border-b border-gray-50 last:border-0 transition-colors hover:bg-gray-50/60 ${!t.is_active ? "opacity-50" : ""}`}
                >
                  {/* Category left bar */}
                  <div className={`w-[3px] shrink-0 ${isInv ? "bg-amber-400" : "bg-orange-400"}`} />
                  <div className="flex flex-1 items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium text-gray-900 line-clamp-1">{t.task_name}</span>
                        {isInv && (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">НЭМЭЛТ АЖИЛ</span>
                        )}
                        {!t.is_active && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400">Идэвхгүй</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-gray-400">
                        <span>{t.date}</span>
                        <span>·</span>
                        <span>Зөвшөөрөгч: <span className="font-medium text-gray-600">{t.approver_username}</span></span>
                        {t.monetary_value > 0 && (
                          <>
                            <span>·</span>
                            <span className={`font-semibold ${isInv ? "text-amber-600" : "text-orange-600"}`}>
                              {t.monetary_value.toLocaleString()}₮
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-0.5">
                      <button onClick={() => openEdit(t)}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-300 hover:bg-gray-100 hover:text-gray-600 transition-colors">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => setConfirmTask(t)}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4">
          <div className="w-full max-w-sm rounded-t-2xl bg-white sm:rounded-2xl overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900">{editTask ? "Ажил засварлах" : "Шинэ нэмэлт ажил"}</h2>
                <p className="text-xs text-gray-400 mt-0.5">Бүх ажилтны чеклистэд нэмэгдэнэ</p>
              </div>
              <button onClick={() => setShowModal(false)} className="rounded-xl p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Modal body */}
            <div className="space-y-4 px-5 py-4 max-h-[70vh] overflow-y-auto">
              {/* Category toggle */}
              <div className="flex rounded-xl border border-gray-200 overflow-hidden">
                {(["daily", "extra"] as const).map(cat => (
                  <button key={cat} type="button" onClick={() => setFCategory(cat)}
                    className={`flex-1 py-2 text-xs font-semibold transition-colors ${fCategory === cat
                      ? cat === "daily" ? "bg-[#0071E3] text-white" : "bg-amber-500 text-white"
                      : "bg-white text-gray-500 hover:bg-gray-50"}`}>
                    {cat === "daily" ? "📋 Өдөр тутмын ажил" : "📦 Нэмэлт ажил"}
                  </button>
                ))}
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Ажлын нэр <span className="text-red-400">*</span></label>
                <input value={fName} onChange={e => setFName(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:border-[#0071E3] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all"
                  placeholder="Ажлын нэр оруулна уу..." />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Огноо <span className="text-red-400">*</span></label>
                  <input type="date" value={fDate} onChange={e => setFDate(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:border-[#0071E3] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all" />
                </div>
                <div>
                  {fCategory === "daily" ? (
                    <>
                      <label className="mb-1.5 block text-xs font-semibold text-blue-600 uppercase tracking-wide">Оноо (жин)</label>
                      <div className="relative">
                        <input type="number" min={0} value={fAmount} onChange={e => setFAmount(e.target.value)}
                          onWheel={e => e.currentTarget.blur()}
                          className="w-full rounded-xl border border-blue-200 bg-blue-50/40 px-3 py-2.5 pr-12 text-sm focus:border-[#0071E3] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all"
                          placeholder="жишээ нь 10" />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-blue-400 pointer-events-none">оноо</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <label className="mb-1.5 block text-xs font-semibold text-amber-600 uppercase tracking-wide">Мөнгөн дүн ₮ <span className="text-red-400">*</span></label>
                      <div className="relative">
                        <input type="number" min={0} value={fAmount} onChange={e => setFAmount(e.target.value)}
                          onWheel={e => e.currentTarget.blur()}
                          className="w-full rounded-xl border border-amber-200 bg-amber-50/40 px-3 py-2.5 pr-7 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 transition-all"
                          placeholder="0" />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-amber-400 pointer-events-none">₮</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600 uppercase tracking-wide">Зөвшөөрөгч <span className="text-red-400">*</span></label>
                <select value={fApprover} onChange={e => setFApprover(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all">
                  <option value="">Сонгох...</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{dispName(u)} ({u.role})</option>
                  ))}
                </select>
              </div>

              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                <span className="text-sm text-gray-700">Идэвхтэй</span>
                <input type="checkbox" checked={fActive} onChange={e => setFActive(e.target.checked)} className="h-4 w-4 accent-[#0071E3]" />
              </label>

              {/* Ажилтан сонгох */}
              <div className="rounded-xl border border-gray-100 bg-gray-50 overflow-hidden">
                <label className="flex cursor-pointer items-center justify-between px-4 py-3 border-b border-gray-100">
                  <span className="text-sm font-medium text-gray-700">Бүх ажилтанд</span>
                  <input type="checkbox" checked={fTargetAll} onChange={e => { setFTargetAll(e.target.checked); if (e.target.checked) setFTargetIds([]); }}
                    className="h-4 w-4 accent-[#0071E3]" />
                </label>
                {!fTargetAll && (
                  <div className="max-h-40 overflow-y-auto divide-y divide-gray-50">
                    {users.filter(u => u.is_active !== false).map(u => (
                      <label key={u.id} className="flex cursor-pointer items-center justify-between px-4 py-2 hover:bg-white/60 transition-colors">
                        <span className="text-xs text-gray-600">{dispName(u)} <span className="text-gray-400">({u.role})</span></span>
                        <input type="checkbox"
                          checked={fTargetIds.includes(u.id)}
                          onChange={e => {
                            setFTargetIds(prev => e.target.checked ? [...prev, u.id] : prev.filter(x => x !== u.id));
                          }}
                          className="h-3.5 w-3.5 accent-[#0071E3]" />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex gap-3 border-t border-gray-100 bg-gray-50/50 px-5 py-4">
              <button onClick={() => setShowModal(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
                Болих
              </button>
              <button onClick={saveTask} disabled={!fName.trim() || !fApprover || !fDate}
                className="flex-1 rounded-xl bg-[#0071E3] py-2.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-40 transition-colors">
                Хадгалах
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Plan Tab (Сарын KPI Cap) ────────────────────────────────────────────────

const MONTH_NAMES = ["1-р сар","2-р сар","3-р сар","4-р сар","5-р сар","6-р сар",
                     "7-р сар","8-р сар","9-р сар","10-р сар","11-р сар","12-р сар"];

function PlanTab() {
  const now = new Date();
  const [planYear, setPlanYear]   = useState(now.getFullYear());
  const [planMonth, setPlanMonth] = useState(now.getMonth() + 1);
  const [users, setUsers]         = useState<UserOption[]>([]);
  const [roles, setRoles]         = useState<RoleOption[]>([]);
  const [filterRole, setFilterRole] = useState("");
  const [plans, setPlans]         = useState<Record<number, EmployeePlan>>({});  // keyed by employee_id
  const [saving, setSaving]       = useState(false);
  const [toast, setToast]         = useState<{ msg: string; ok: boolean } | null>(null);

  function notify(msg: string, ok = true) {
    setToast({ msg, ok }); setTimeout(() => setToast(null), 3000);
  }

  async function loadData() {
    try {
      const [uRes, pRes, rRes] = await Promise.all([
        api.get("/admin/users"),
        api.get("/kpi/employee-plans", { params: { year: planYear, month: planMonth } }),
        api.get("/admin/roles"),
      ]);
      setUsers(uRes.data);
      setRoles(rRes.data);
      const planMap: Record<number, EmployeePlan> = {};
      // Initialize all users with 0 caps
      for (const u of uRes.data) {
        planMap[u.id] = { employee_id: u.id, year: planYear, month: planMonth, daily_kpi_cap: 0, monthly_max_kpi: 0, monthly_inventory_budget: 0 };
      }
      // Override with saved plans
      for (const p of pRes.data) {
        planMap[p.employee_id] = p;
      }
      setPlans(planMap);
    } catch {
      notify("Ачааллахад алдаа гарлаа", false);
    }
  }

  useEffect(() => { loadData(); }, [planYear, planMonth]);

  function updatePlan(empId: number, field: "daily_kpi_cap" | "monthly_max_kpi" | "monthly_inventory_budget", val: string) {
    setPlans(prev => {
      const cur = prev[empId];
      const num = parseFloat(val) || 0;
      const next = { ...cur, [field]: num };
      // 2026-05: Өдрийн cap эсвэл тооллогын төсөв өөрчлөгдөхөд Нийт max-г
      // автоматаар = (cap + төсөв) болгож тохируулна. Хэрэглэгч Нийт max-ыг
      // гар аар засаж болно (override) — гэхдээ дараа нь cap/төсөв шинэчлэхэд
      // дахин auto-compute хийгдэнэ.
      if (field === "daily_kpi_cap" || field === "monthly_inventory_budget") {
        const dailyCap  = field === "daily_kpi_cap"            ? num : (cur.daily_kpi_cap || 0);
        const invBudget = field === "monthly_inventory_budget" ? num : (cur.monthly_inventory_budget || 0);
        next.monthly_max_kpi = dailyCap + invBudget;
      }
      return { ...prev, [empId]: next };
    });
  }

  async function saveAll() {
    setSaving(true);
    try {
      // 2026-05: Нийт max нь ВСЕГДА = KPI даалгавар + Тооллогын төсөв
      // (read-only display болсон тул сервер рүү илгээх дүн нь нийлбэр)
      const payload = Object.values(plans).map(p => {
        const autoMax = (p.daily_kpi_cap || 0) + (p.monthly_inventory_budget || 0);
        return {
          employee_id: p.employee_id, year: planYear, month: planMonth,
          daily_kpi_cap: p.daily_kpi_cap || 0,
          monthly_max_kpi: autoMax,
          monthly_inventory_budget: p.monthly_inventory_budget ?? 0,
        };
      });
      await api.post("/kpi/employee-plans/bulk", payload);
      notify("Хадгалагдлаа ✓");
    } catch {
      notify("Хадгалахад алдаа гарлаа", false);
    } finally {
      setSaving(false);
    }
  }

  const configuredCount = Object.values(plans).filter(p => (p.daily_kpi_cap || 0) > 0 || (p.monthly_inventory_budget || 0) > 0).length;

  return (
    <div className="space-y-4">
      <Toast toast={toast} />

      {/* Header card — sticky */}
      <div className="sticky top-0 z-20 rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            {/* Month selectors */}
            <div className="flex items-center gap-1.5">
              <select value={planYear} onChange={e => setPlanYear(Number(e.target.value))}
                className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all">
                {[now.getFullYear()-1, now.getFullYear(), now.getFullYear()+1].map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <span className="text-gray-300">/</span>
              <select value={planMonth} onChange={e => setPlanMonth(Number(e.target.value))}
                className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all">
                {MONTH_NAMES.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
              </select>
            </div>
            {/* Role filter */}
            <select
              value={filterRole}
              onChange={e => setFilterRole(e.target.value)}
              className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all"
            >
              <option value="">Бүх тушаал</option>
              {roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            {/* Status pill */}
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
              configuredCount === users.length && users.length > 0
                ? "bg-emerald-50 text-emerald-700"
                : configuredCount > 0
                ? "bg-amber-50 text-amber-700"
                : "bg-gray-100 text-gray-500"
            }`}>
              {configuredCount}/{users.length} ажилтан тохируулагдсан
            </span>
          </div>
          <button onClick={saveAll} disabled={saving}
            className="flex items-center gap-2 rounded-xl bg-[#0071E3] px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50 transition-all shadow-sm">
            {saving
              ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Хадгалж байна...</>
              : <><Check size={14} /> Хадгалах</>}
          </button>
        </div>

        {/* Info banner */}
        <div className="flex items-start gap-3 bg-blue-50/60 px-5 py-3 border-b border-blue-100/60">
          <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-200 text-blue-700 text-[9px] font-bold">i</div>
          <p className="text-xs text-blue-700 leading-relaxed">
            <strong>KPI даалгавар</strong> — өдөр тутмын ажлын мөнгөн дээд хэмжээ.
            &nbsp;<strong>Тооллогын төсөв</strong> — max оноотойгоор тооллогоос авах мөнгөн дүн.
            &nbsp;<strong>Нийт max</strong> = <span className="font-mono">KPI даалгавар + Тооллогын төсөв</span> (автомат тооцоолно).
          </p>
        </div>
      </div>

      {/* Employee table */}
      <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_auto_140px_140px_140px] items-center border-b border-gray-100 bg-gray-50/80 px-5 py-2.5 gap-3">
          <span className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Ажилтан</span>
          <span className="w-24 text-[11px] font-bold uppercase tracking-widest text-gray-400">Тушаал</span>
          <span className="text-[11px] font-bold uppercase tracking-widest text-gray-400 text-right">KPI даалгавар ₮</span>
          <span className="text-[11px] font-bold uppercase tracking-widest text-amber-500 text-right">Тооллогын төсөв ₮</span>
          <span className="text-[11px] font-bold uppercase tracking-widest text-emerald-600 text-right">Нийт max ₮</span>
        </div>
        <div className="divide-y divide-gray-50">
          {users.filter(u => !filterRole || u.role === filterRole).map(u => {
            const p = plans[u.id] ?? { daily_kpi_cap: 0, monthly_max_kpi: 0, monthly_inventory_budget: 0 };
            const invBudget = p.monthly_inventory_budget ?? 0;
            // 2026-05: Нийт max нь ҮРГЭЛЖ авто-нийлбэр (read-only)
            const autoMax = (p.daily_kpi_cap || 0) + invBudget;
            const hasData = p.daily_kpi_cap > 0 || invBudget > 0;
            const isInconsistent = false; // өмнө: cap > max байх. Одоо max = cap + inv тул хэзээ ч үгүй.
            return (
              <div key={u.id}
                className={`grid grid-cols-[1fr_auto_140px_140px_140px] items-center gap-3 px-5 py-3 transition-colors ${
                  isInconsistent ? "bg-red-50/40" : hasData ? "hover:bg-blue-50/20" : "hover:bg-gray-50/60"
                }`}
              >
                {/* Name */}
                <div className="flex items-center gap-2 min-w-0">
                  {/* Status dot */}
                  <div className={`h-2 w-2 shrink-0 rounded-full ${
                    isInconsistent ? "bg-red-400" : hasData ? "bg-emerald-400" : "bg-gray-200"
                  }`} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 leading-tight truncate">{dispName(u)}</p>
                  </div>
                </div>
                {/* Role badge */}
                <span className="w-24 truncate rounded-full bg-gray-100 px-2 py-0.5 text-center text-[10px] font-medium text-gray-500">
                  {roles.find(r => r.value === u.role)?.label ?? u.role}
                </span>
                {/* KPI даалгавар (Өдрийн cap) input */}
                <div className="flex justify-end">
                  <div className="relative w-32">
                    <input type="number" min={0}
                      value={p.daily_kpi_cap || ""}
                      onChange={e => updatePlan(u.id, "daily_kpi_cap", e.target.value)}
                      onWheel={e => e.currentTarget.blur()}
                      className={`w-full rounded-xl border py-2 pl-3 pr-7 text-right text-sm font-medium focus:outline-none focus:ring-2 transition-all ${
                        p.daily_kpi_cap > 0
                          ? "border-blue-200 bg-blue-50/60 text-blue-800 focus:ring-blue-300/50 focus:border-blue-400"
                          : "border-gray-200 bg-gray-50 text-gray-600 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
                      }`}
                      placeholder="0" />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">₮</span>
                  </div>
                </div>
                {/* Inventory budget input */}
                <div className="flex justify-end">
                  <div className="relative w-32">
                    <input type="number" min={0}
                      value={invBudget || ""}
                      onChange={e => updatePlan(u.id, "monthly_inventory_budget", e.target.value)}
                      onWheel={e => e.currentTarget.blur()}
                      className={`w-full rounded-xl border py-2 pl-3 pr-7 text-right text-sm font-medium focus:outline-none focus:ring-2 transition-all ${
                        invBudget > 0
                          ? "border-amber-200 bg-amber-50/60 text-amber-800 focus:ring-amber-300/50 focus:border-amber-400"
                          : "border-gray-200 bg-gray-50 text-gray-600 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
                      }`}
                      placeholder="0" />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">₮</span>
                  </div>
                </div>
                {/* Нийт max (read-only, авто тооцоолсон нийлбэр) */}
                <div className="flex justify-end" title={`${(p.daily_kpi_cap || 0).toLocaleString()}₮ + ${invBudget.toLocaleString()}₮ = ${autoMax.toLocaleString()}₮`}>
                  <div className={`relative w-32 rounded-xl border py-2 pl-3 pr-10 text-right text-sm font-bold tabular-nums cursor-not-allowed select-none ${
                    autoMax > 0
                      ? "border-emerald-200 bg-emerald-50/60 text-emerald-800"
                      : "border-gray-200 bg-gray-50 text-gray-400"
                  }`}>
                    {autoMax > 0 ? autoMax.toLocaleString() : "0"}
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 pointer-events-none">
                      {autoMax > 0 && (
                        <span className="rounded bg-emerald-200/70 px-1 py-px text-[8px] font-bold text-emerald-700">авто</span>
                      )}
                      <span className="text-xs text-gray-400">₮</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {/* Table footer summary */}
        {users.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-2.5">
            <span className="text-xs text-gray-400">
              {users.length} ажилтан · {configuredCount} тохируулагдсан
            </span>
            <div className="flex gap-4 text-xs font-semibold">
              <span className="text-blue-600">
                KPI даалгавар: {Object.values(plans).reduce((s, p) => s + (p.daily_kpi_cap || 0), 0).toLocaleString()}₮
              </span>
              <span className="text-amber-600">
                Тооллогын төсөв: {Object.values(plans).reduce((s, p) => s + (p.monthly_inventory_budget || 0), 0).toLocaleString()}₮
              </span>
              <span className="text-emerald-700">
                Нийт max: {Object.values(plans).reduce((s, p) => s + ((p.daily_kpi_cap || 0) + (p.monthly_inventory_budget || 0)), 0).toLocaleString()}₮
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Report Tab ─────────────────────────────────────────────────────────────

function ReportTab() {
  const now = new Date();
  const [reportYear, setReportYear]   = useState(now.getFullYear());
  const [reportMonth, setReportMonth] = useState(now.getMonth() + 1);
  const [rows, setRows]               = useState<SalaryRow[]>([]);
  const [users, setUsers]             = useState<UserOption[]>([]);
  const [roles, setRoles]             = useState<RoleOption[]>([]);
  const [loading, setLoading]         = useState(false);
  const [detail, setDetail]           = useState<{ id: number; data: { checklists: DetailChecklist[]; kpi_summary: SalaryRow } } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedDetail, setExpandedDetail] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  // 2026-05: Тооллогын дутагдал inline input state (per row)
  const [shortageInput, setShortageInput] = useState<Record<number, string>>({});
  const [savingShortage, setSavingShortage] = useState<Set<number>>(new Set());

  function notify(msg: string, ok = true) {
    setToast({ msg, ok }); setTimeout(() => setToast(null), 3000);
  }

  useEffect(() => {
    Promise.all([api.get("/admin/users"), api.get("/admin/roles")])
      .then(([u, r]) => { setUsers(u.data); setRoles(r.data); })
      .catch(() => {});
  }, []);

  async function loadReport() {
    setLoading(true);
    try {
      const res = await api.get("/kpi/salary-report", { params: { year: reportYear, month: reportMonth } });
      setRows(res.data);
      // hydrate shortage inputs
      const inputs: Record<number, string> = {};
      (res.data as SalaryRow[]).forEach(r => { inputs[r.employee_id] = String(r.inventory_shortage || 0); });
      setShortageInput(inputs);
      setDetail(null);
    } catch {
      notify("Ачааллахад алдаа гарлаа", false);
    } finally {
      setLoading(false);
    }
  }

  async function saveShortage(row: SalaryRow, newVal: number) {
    const current = row.inventory_shortage || 0;
    if (newVal === current) return; // no change
    setSavingShortage(prev => { const s = new Set(prev); s.add(row.employee_id); return s; });
    try {
      await api.post("/kpi/employee-plans", {
        employee_id: row.employee_id,
        year: reportYear, month: reportMonth,
        daily_kpi_cap: row.daily_kpi_cap,
        monthly_max_kpi: row.monthly_max_kpi,
        inventory_shortage: newVal,
      });
      // Update row locally for instant final_payout recalc
      setRows(prev => prev.map(r =>
        r.employee_id === row.employee_id
          ? { ...r, inventory_shortage: newVal, final_payout: Math.round(r.total_kpi - newVal) }
          : r
      ));
      notify("Хадгалагдлаа ✓");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Хадгалахад алдаа гарлаа", false);
      // Revert input on error
      setShortageInput(prev => ({ ...prev, [row.employee_id]: String(current) }));
    } finally {
      setSavingShortage(prev => { const s = new Set(prev); s.delete(row.employee_id); return s; });
    }
  }

  async function loadDetail(employeeId: number) {
    if (detail?.id === employeeId) { setDetail(null); return; }
    setDetailLoading(true);
    try {
      const res = await api.get("/kpi/salary-report/detail", {
        params: { employee_id: employeeId, year: reportYear, month: reportMonth }
      });
      setDetail({ id: employeeId, data: res.data });
      setExpandedDetail(new Set(res.data.checklists.map((c: DetailChecklist) => c.id)));
    } catch {
      notify("Дэлгэрэнгүй ачааллахад алдаа гарлаа", false);
    } finally {
      setDetailLoading(false);
    }
  }

  const grandTotal    = rows.reduce((s, r) => s + r.total_kpi, 0);
  const grandMaxTotal = rows.reduce((s, r) => s + (r.monthly_max_kpi || 0), 0);
  const grandDeducted = rows.reduce((s, r) => s + (r.daily_deducted || 0), 0);
  const grandShortage = rows.reduce((s, r) => s + (r.inventory_shortage || 0), 0);
  const grandFinal    = rows.reduce((s, r) => s + (r.final_payout || (r.total_kpi - (r.inventory_shortage || 0))), 0);
  const capFillPct    = grandMaxTotal > 0 ? Math.min(grandTotal / grandMaxTotal * 100, 100) : 0;

  return (
    <div className="space-y-4">
      <Toast toast={toast} />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white px-4 py-3.5 shadow-sm border border-gray-100">
        <select value={reportYear} onChange={e => setReportYear(Number(e.target.value))}
          className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all">
          {[now.getFullYear()-1, now.getFullYear(), now.getFullYear()+1].map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <select value={reportMonth} onChange={e => setReportMonth(Number(e.target.value))}
          className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 transition-all">
          {MONTH_NAMES.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
        </select>
        <button onClick={loadReport} disabled={loading}
          className="flex items-center gap-2 rounded-xl bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50 transition-all">
          {loading
            ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" /> Ачааллаж...</>
            : "Харах"}
        </button>
      </div>

      {rows.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-white py-16 shadow-sm border border-gray-100">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
            <BarChart3 size={22} className="text-gray-400" />
          </div>
          <p className="text-sm font-medium text-gray-500">Сар сонгоод "Харах" дарна уу</p>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Grand total card */}
          <div className="rounded-2xl overflow-hidden shadow-sm">
            <div className="bg-[#0071E3] px-5 py-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-xs text-white/70 font-medium mb-1">{reportYear} оны {MONTH_NAMES[reportMonth-1]} · Эцсийн олгох (KPI − тооллогын дутагдал)</div>
                  <div className="text-3xl font-bold text-white">{grandFinal.toLocaleString()}₮</div>
                  {grandShortage > 0 && (
                    <div className="mt-1 text-xs text-white/70">
                      KPI: {grandTotal.toLocaleString()}₮ − дутагдал: {grandShortage.toLocaleString()}₮
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-xs text-white/60 mb-0.5">Max budget</div>
                  <div className="text-lg font-semibold text-white/90">{grandMaxTotal.toLocaleString()}₮</div>
                </div>
              </div>
              {/* Budget fill bar */}
              {grandMaxTotal > 0 && (
                <div className="mt-3">
                  <div className="h-1.5 w-full rounded-full bg-white/20 overflow-hidden">
                    <div className="h-full rounded-full bg-white transition-all" style={{ width: `${capFillPct}%` }} />
                  </div>
                  <div className="mt-1 text-[11px] text-white/60">{capFillPct.toFixed(1)}% бюджет ашиглагдсан · {rows.length} ажилтан</div>
                </div>
              )}
            </div>
            {/* Mini stats row */}
            <div className="grid grid-cols-5 divide-x divide-gray-100 bg-white">
              <div className="px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Өдрийн</div>
                <div className="text-sm font-bold text-blue-600">{rows.reduce((s,r)=>s+r.daily_payout,0).toLocaleString()}₮</div>
              </div>
              <div className="px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Тооллого</div>
                <div className="text-sm font-bold text-amber-600">{rows.reduce((s,r)=>s+r.inventory_payout,0).toLocaleString()}₮</div>
              </div>
              <div className="px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-red-400">Тоол. дутагдал</div>
                <div className="text-sm font-bold text-red-500">-{grandShortage.toLocaleString()}₮</div>
              </div>
              <div className="px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-red-400">Өдрийн хасалт</div>
                <div className="text-sm font-bold text-red-500">-{grandDeducted.toLocaleString()}₮</div>
              </div>
              <div className="px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Дундаж</div>
                <div className="text-sm font-bold text-emerald-600">
                  {rows.length > 0 ? (rows.reduce((s,r)=>s+r.daily_score_pct,0)/rows.length).toFixed(1) : 0}%
                </div>
              </div>
            </div>
          </div>

          {/* ── Employee table ───────────────────────────────────────────── */}
          <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_72px_88px_72px_88px_100px_110px_30px] gap-1 items-center px-4 py-2.5 bg-gray-50 border-b border-gray-100 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              <span>Ажилтан</span>
              <span className="text-center">Өдрийн оноо</span>
              <span className="text-right text-blue-500">Өдрийн ₮</span>
              <span className="text-center text-amber-500">Тооллогын оноо</span>
              <span className="text-right text-amber-500">Тооллогын ₮</span>
              <span className="text-right text-red-400">Тоол. дутагдал ₮</span>
              <span className="text-right">Эцсийн ₮</span>
              <span />
            </div>

            {/* Table rows */}
            <div className="divide-y divide-gray-50">
              {rows.map(row => {
                const isCapped = row.monthly_max_kpi > 0 && row.total_kpi >= row.monthly_max_kpi;
                // 2026-05: Шинэ багана — daily/inventory оноог тусгаар харуулна
                const dailyPtsMax = row.daily_pts_max ?? row.total_possible_pts ?? 0;
                const dailyPtsGot = row.daily_pts_got ?? row.total_approved_pts ?? 0;
                const invPtsMax   = row.inv_pts_max ?? row.inventory_total_pts ?? 0;
                const invPtsGot   = row.inv_pts_got ?? row.inventory_approved_pts ?? 0;
                const shortage    = row.inventory_shortage || 0;
                const finalPay    = row.final_payout ?? (row.total_kpi - shortage);

                return (
                  <div key={row.employee_id}>
                    <div role="button" tabIndex={0}
                      onClick={() => loadDetail(row.employee_id)}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); loadDetail(row.employee_id); } }}
                      className="grid grid-cols-[1fr_72px_88px_72px_88px_100px_110px_30px] gap-1 items-center w-full px-4 py-3 hover:bg-gray-50/60 transition-colors text-left cursor-pointer">

                      {/* Ажилтан */}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-gray-900 text-sm truncate">{row.employee_username}</span>
                          {(() => {
                            const u = users.find(u => u.id === row.employee_id);
                            const roleLabel = u ? (roles.find(r => r.value === u.role)?.label ?? u.role) : null;
                            return roleLabel ? (
                              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">{roleLabel}</span>
                            ) : null;
                          })()}
                          {!row.plan_exists && (
                            <span className="rounded-full bg-amber-50 border border-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600">Төлөвлөгөөгүй</span>
                          )}
                          {isCapped && (
                            <span className="rounded-full bg-orange-50 border border-orange-100 px-1.5 py-0.5 text-[9px] font-semibold text-orange-600">Cap</span>
                          )}
                        </div>
                        {/* Worked days + daily score bar */}
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-[10px] text-gray-400 whitespace-nowrap">
                            <b className="text-gray-700">{row.worked_days || 0}</b>/{row.scheduled_days || 0} өдөр
                          </span>
                          <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden max-w-[100px]">
                            <div className="h-full rounded-full bg-[#0071E3] transition-all"
                              style={{ width: `${Math.min(row.daily_score_pct, 100)}%` }} />
                          </div>
                          <span className="text-[11px] font-semibold text-[#0071E3]">{row.daily_score_pct}%</span>
                        </div>
                      </div>

                      {/* Өдрийн оноо: got/max */}
                      <div className="text-center">
                        <span className="text-sm font-bold text-blue-600 tabular-nums">{dailyPtsGot}</span>
                        <span className="text-[10px] text-gray-400 tabular-nums">/{dailyPtsMax}</span>
                      </div>

                      {/* Өдрийн ₮ */}
                      <div className="text-right">
                        {row.daily_payout > 0 ? (
                          <span className="text-sm font-bold text-blue-700 tabular-nums">{row.daily_payout.toLocaleString()}₮</span>
                        ) : (
                          <span className="text-[10px] text-gray-300">—</span>
                        )}
                        {(row.daily_deducted || 0) > 0 && (
                          <div className="text-[10px] text-red-500 tabular-nums">-{row.daily_deducted.toLocaleString()}₮</div>
                        )}
                      </div>

                      {/* Тооллогын оноо: got/max */}
                      <div className="text-center">
                        {invPtsMax > 0 ? (
                          <>
                            <span className="text-sm font-bold text-amber-600 tabular-nums">{invPtsGot}</span>
                            <span className="text-[10px] text-gray-400 tabular-nums">/{invPtsMax}</span>
                          </>
                        ) : (
                          <span className="text-[10px] text-gray-300">—</span>
                        )}
                      </div>

                      {/* Тооллогын ₮ */}
                      <div className="text-right">
                        {row.inventory_payout > 0 ? (
                          <span className="text-sm font-bold text-amber-700 tabular-nums">{row.inventory_payout.toLocaleString()}₮</span>
                        ) : (
                          <span className="text-[10px] text-gray-300">—</span>
                        )}
                        {row.monthly_inventory_budget > 0 && (
                          <div className="text-[10px] text-gray-400 tabular-nums">/ {row.monthly_inventory_budget.toLocaleString()}₮</div>
                        )}
                      </div>

                      {/* Тооллогын дутагдал (manual input) */}
                      <div
                        className="flex justify-end"
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => e.stopPropagation()}
                      >
                        <div className="relative w-full">
                          <input
                            type="number" min={0}
                            value={shortageInput[row.employee_id] ?? ""}
                            onChange={e => setShortageInput(prev => ({ ...prev, [row.employee_id]: e.target.value }))}
                            onBlur={e => saveShortage(row, parseFloat(e.target.value) || 0)}
                            onWheel={e => e.currentTarget.blur()}
                            placeholder="0"
                            disabled={savingShortage.has(row.employee_id)}
                            className={`w-full rounded-lg border py-1.5 pl-2 pr-5 text-right text-xs font-medium tabular-nums focus:outline-none focus:ring-1 transition-all disabled:opacity-50 ${
                              shortage > 0
                                ? "border-red-200 bg-red-50/60 text-red-700 focus:ring-red-300 focus:border-red-400"
                                : "border-gray-200 bg-gray-50 text-gray-600 focus:ring-[#0071E3]/30 focus:border-[#0071E3]"
                            }`}
                          />
                          <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 pointer-events-none">₮</span>
                        </div>
                      </div>

                      {/* Эцсийн ₮ */}
                      <div className="text-right">
                        <div className={`text-base font-bold tabular-nums ${
                          shortage > 0 ? "text-emerald-700" : "text-gray-900"
                        }`}>
                          {finalPay.toLocaleString()}₮
                        </div>
                        {shortage > 0 && (
                          <div className="text-[10px] text-gray-400 tabular-nums">
                            {row.total_kpi.toLocaleString()} − {shortage.toLocaleString()}
                          </div>
                        )}
                        {row.monthly_max_kpi > 0 && shortage === 0 && (
                          <div className="text-[10px] text-gray-400 tabular-nums">/ {row.monthly_max_kpi.toLocaleString()}₮</div>
                        )}
                      </div>

                      {/* Arrow */}
                      <div className="flex justify-center">
                        {detail?.id === row.employee_id
                          ? <ChevronUp size={15} className="text-gray-400" />
                          : <ChevronDown size={15} className="text-gray-400" />}
                      </div>
                    </div>

                    {/* ── KPI Formula Card (shown above detail) ────────────── */}
                    {detail?.id === row.employee_id && !detailLoading && (
                      <div className="mx-4 mb-3 mt-1 rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 p-4">
                        <div className="text-[11px] font-semibold text-blue-600 uppercase tracking-wide mb-2">KPI тооцоолол</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {/* Daily calculation */}
                          <div className="space-y-1.5">
                            <div className="text-xs text-gray-500">Өдрийн ажил</div>
                            <div className="flex items-center gap-1.5 font-mono text-sm">
                              <span className="text-gray-600">{row.daily_kpi_cap.toLocaleString()}₮</span>
                              <span className="text-gray-400">/</span>
                              <span className="text-gray-600">{dailyPtsMax}</span>
                              <span className="text-gray-400">*</span>
                              <span className="font-bold text-emerald-600">{dailyPtsGot}</span>
                              <span className="text-gray-400">=</span>
                              <span className="font-bold text-blue-700">{row.daily_payout.toLocaleString()}₮</span>
                            </div>
                            {(row.daily_deducted || 0) > 0 && (
                              <div className="flex items-center gap-1.5 text-xs">
                                <span className="text-gray-500">Хасалт:</span>
                                <span className="font-bold text-red-500">{row.daily_kpi_cap.toLocaleString()}₮ - {row.daily_payout.toLocaleString()}₮ = -{row.daily_deducted.toLocaleString()}₮</span>
                              </div>
                            )}
                            {/* Inventory formula */}
                            {invPtsMax > 0 && (
                              <>
                                <div className="text-xs text-gray-500 pt-1 mt-1 border-t border-blue-100/60">Тооллогын ажил</div>
                                <div className="flex items-center gap-1.5 font-mono text-sm">
                                  <span className="text-gray-600">{(row.monthly_inventory_budget || 0).toLocaleString()}₮</span>
                                  <span className="text-gray-400">/</span>
                                  <span className="text-gray-600">{invPtsMax}</span>
                                  <span className="text-gray-400">*</span>
                                  <span className="font-bold text-amber-600">{invPtsGot}</span>
                                  <span className="text-gray-400">=</span>
                                  <span className="font-bold text-amber-700">{row.inventory_payout.toLocaleString()}₮</span>
                                </div>
                              </>
                            )}
                          </div>
                          {/* Inventory + total */}
                          <div className="space-y-1.5">
                            {(row.extra_payout || 0) > 0 && (
                              <>
                                <div className="text-xs text-gray-500">Нэмэлт ажил (шууд ₮)</div>
                                <div className="text-sm font-bold text-violet-600">+{row.extra_payout.toLocaleString()}₮</div>
                              </>
                            )}
                            <div className="text-xs text-gray-500">Нийт KPI</div>
                            <div className="text-base font-semibold text-gray-700">{row.total_kpi.toLocaleString()}₮</div>
                            {shortage > 0 && (
                              <>
                                <div className="flex items-center gap-1.5 text-xs">
                                  <span className="text-red-500">− Тооллогын дутагдал:</span>
                                  <span className="font-bold text-red-600">{shortage.toLocaleString()}₮</span>
                                </div>
                              </>
                            )}
                            <div className="text-xs text-gray-500 pt-1 border-t border-blue-100/60">Эцсийн олгох</div>
                            <div className="text-lg font-bold text-emerald-700">{finalPay.toLocaleString()}₮</div>
                          </div>
                        </div>
                        {/* Ээлж нөхсөн нэмэгдэл */}
                        {(row.shift_cover_days || 0) > 0 && (
                          <div className="mt-2 pt-2 border-t border-orange-100/80">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="text-orange-600 font-semibold">Ээлж нөхсөн: {row.shift_cover_days} өдөр</span>
                              <span className="text-gray-400">=</span>
                              <span className="font-mono text-gray-600">{row.daily_kpi_cap.toLocaleString()}₮ / {row.scheduled_days} * {row.shift_cover_days}</span>
                              <span className="text-gray-400">=</span>
                              <span className="font-bold text-orange-600">+{row.shift_bonus.toLocaleString()}₮</span>
                            </div>
                          </div>
                        )}
                        {/* Ажлын өдрийн нарийвчлал */}
                        <div className="mt-3 pt-2.5 border-t border-blue-100/80 flex flex-wrap gap-4 text-xs">
                          <span className="text-gray-500">Хуваарийн өдөр: <b className="text-gray-800">{row.scheduled_days || 0}</b></span>
                          <span className="text-gray-500">Ажилласан өдөр: <b className="text-gray-800">{row.worked_days || 0}</b></span>
                          <span className="text-gray-500">Ирээгүй: <b className="text-red-500">{Math.max(0, (row.scheduled_days || 0) - (row.worked_days || 0))}</b></span>
                        </div>
                      </div>
                    )}

                    {/* ── Detail panel ──────────────────────────────────────── */}
                    {detail?.id === row.employee_id && (
                      <div className="border-t border-gray-100">
                        {detailLoading ? (
                          <div className="flex items-center justify-center gap-2 p-5 text-xs text-gray-400">
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-200 border-t-gray-500" />
                            Ачааллаж байна...
                          </div>
                        ) : detail.data.checklists.length === 0 ? (
                          <div className="p-5 text-center text-xs text-gray-400">Энэ сарын мэдээлэл байхгүй</div>
                        ) : (
                          detail.data.checklists.map(cl => {
                            const isExp = expandedDetail.has(cl.id);
                            const clApprovedPts = cl.entries
                              .filter(e => e.approval_status === "approved" && e.task_category === "daily")
                              .reduce((s, e) => s + (e.monetary_value || 0), 0);
                            const clApprovedInv = cl.entries
                              .filter(e => e.approval_status === "approved" && e.task_category === "inventory")
                              .reduce((s, e) => s + (e.monetary_value || 0), 0);
                            return (
                              <div key={cl.id} className="border-b border-gray-50 last:border-0">
                                <button
                                  onClick={() => setExpandedDetail(prev => {
                                    const s = new Set(prev); s.has(cl.id) ? s.delete(cl.id) : s.add(cl.id); return s;
                                  })}
                                  className="flex w-full items-center justify-between bg-gray-50/70 px-4 py-2.5 hover:bg-gray-100/60 transition-colors">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-gray-700">{cl.date}</span>
                                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cl.status === "submitted" ? "bg-blue-50 text-blue-600" : "bg-amber-50 text-amber-600"}`}>
                                      {cl.status === "submitted" ? "Илгээсэн" : "Ноорог"}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {clApprovedPts > 0 && (
                                      <span className="text-xs text-[#0071E3] font-semibold">{clApprovedPts} оноо</span>
                                    )}
                                    {clApprovedInv > 0 && (
                                      <span className="text-xs text-amber-600 font-semibold">{clApprovedInv.toLocaleString()}₮</span>
                                    )}
                                    {isExp ? <ChevronUp size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
                                  </div>
                                </button>
                                {isExp && (
                                  <ul className="divide-y divide-gray-50">
                                    {cl.entries.map(e => {
                                      const isInv = e.task_category === "inventory";
                                      return (
                                        <li key={e.id} className="flex items-stretch border-b border-gray-50 last:border-0">
                                          <div className={`w-[3px] shrink-0 ${isInv ? "bg-amber-300" : "bg-blue-300"}`} />
                                          <div className="flex flex-1 items-center justify-between gap-3 px-4 py-2.5">
                                            <div className="flex-1 min-w-0">
                                              <div className="flex items-center gap-1.5">
                                                <span className="text-sm text-gray-800 line-clamp-1">{e.task_name}</span>
                                                {isInv && (
                                                  <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">Нэмэлт</span>
                                                )}
                                                {e.is_adhoc && (
                                                  <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600">Нэмэлт</span>
                                                )}
                                              </div>
                                              <div className="flex items-center gap-2 mt-0.5">
                                                <span className="text-[10px] text-gray-400">{e.approver_username}</span>
                                                {e.approval_note && (
                                                  <span className="text-[10px] text-red-400">{e.approval_note}</span>
                                                )}
                                              </div>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                              <span className="text-sm font-semibold text-gray-900">
                                                {`${e.monetary_value} оноо`}
                                              </span>
                                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLOR[e.approval_status]}`}>
                                                {STATUS_LABEL[e.approval_status]}
                                              </span>
                                            </div>
                                          </div>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}


// ── Schedule Tab ────────────────────────────────────────────────────────────
// Admin-ийн хуваарь удирдах, ирц override хийх, audit log харах

const MONTH_NAMES_SCH = [
  "1-р сар", "2-р сар", "3-р сар", "4-р сар", "5-р сар", "6-р сар",
  "7-р сар", "8-р сар", "9-р сар", "10-р сар", "11-р сар", "12-р сар",
];
const CAL_DAYS = ["Да", "Мя", "Лх", "Пү", "Ба", "Бя", "Ня"];

function daysInMonthSch(y: number, m: number) { return new Date(y, m, 0).getDate(); }
function firstDayOffset(y: number, m: number) {
  const d = new Date(y, m - 1, 1).getDay();
  return d === 0 ? 6 : d - 1;
}
function isoDateSch(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}

interface ScheduleEmployee {
  employee_id: number;
  employee_name: string;
  dates: string[];
}

interface AuditLog {
  id: number;
  admin_name: string;
  action: string;
  target_employee_name: string;
  target_date: string;
  old_value: string;
  new_value: string;
  reason: string;
  created_at: string;
}

interface AttendanceChecklistAdmin {
  id: number;
  employee_id: number;
  employee_username: string;
  date: string;
  attendance_status: string;
  attendance_note: string;
  submitted_at: string | null;
}

function ScheduleTab() {
  const today = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`; })();
  const todayD = new Date();
  const [calYear, setCalYear]   = useState(todayD.getFullYear());
  const [calMonth, setCalMonth] = useState(todayD.getMonth() + 1);

  const [subTab, setSubTab] = useState<"schedule" | "attendance" | "audit">("schedule");

  // Schedule data
  const [scheduleData, setScheduleData] = useState<ScheduleEmployee[]>([]);
  const [selectedEmpId, setSelectedEmpId] = useState<number | null>(null);
  const [editingDates, setEditingDates] = useState<Set<string>>(new Set());
  const [savingSchedule, setSavingSchedule] = useState(false);

  // Employees
  const [employees, setEmployees] = useState<UserOption[]>([]);

  // Attendance override
  const [pendingAttendance, setPendingAttendance] = useState<AttendanceChecklistAdmin[]>([]);
  const [overrideOpen, setOverrideOpen] = useState<number | null>(null);
  const [overrideStatus, setOverrideStatus] = useState("approved");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideSaving, setOverrideSaving] = useState(false);

  // Audit logs
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditEmpFilter, setAuditEmpFilter] = useState("");

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  function notify(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3200);
  }

  function prevMonth() {
    if (calMonth === 1) { setCalYear(y => y - 1); setCalMonth(12); }
    else setCalMonth(m => m - 1);
  }
  function nextMonth() {
    if (calMonth === 12) { setCalYear(y => y + 1); setCalMonth(1); }
    else setCalMonth(m => m + 1);
  }

  async function loadAll() {
    try {
      const [empRes, schRes, attRes, auditRes] = await Promise.all([
        api.get("/admin/users"),
        api.get("/kpi/schedule/all", { params: { year: calYear, month: calMonth } }),
        api.get("/kpi/pending-attendance"),
        api.get("/kpi/audit-logs"),
      ]);
      setEmployees(empRes.data);
      setScheduleData(schRes.data);
      setPendingAttendance(attRes.data);
      setAuditLogs(auditRes.data);
    } catch {
      notify("Ачааллахад алдаа гарлаа", false);
    }
  }

  useEffect(() => { loadAll(); }, [calYear, calMonth]);

  // Start editing an employee's schedule
  function startEdit(emp: ScheduleEmployee | null, empId: number) {
    setSelectedEmpId(empId);
    const dates = emp ? emp.dates : [];
    setEditingDates(new Set(dates));
  }

  function toggleDay(dateStr: string) {
    setEditingDates(prev => {
      const s = new Set(prev);
      s.has(dateStr) ? s.delete(dateStr) : s.add(dateStr);
      return s;
    });
  }

  async function saveSchedule() {
    if (selectedEmpId == null) return;
    setSavingSchedule(true);
    try {
      await api.post("/kpi/schedule/bulk", {
        employee_id: selectedEmpId,
        dates: Array.from(editingDates),
      });
      notify("Хуваарь хадгалагдлаа ✓");
      setSelectedEmpId(null);
      setEditingDates(new Set());
      // Refresh schedule
      const res = await api.get("/kpi/schedule/all", { params: { year: calYear, month: calMonth } });
      setScheduleData(res.data);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setSavingSchedule(false);
    }
  }

  async function adminOverrideAttendance(clId: number) {
    if (!overrideReason.trim()) {
      notify("Тайлбар заавал оруулна", false);
      return;
    }
    setOverrideSaving(true);
    try {
      await api.patch(`/kpi/checklists/${clId}/attendance/admin-override`, {
        attendance_status: overrideStatus,
        reason: overrideReason.trim(),
      });
      notify("Ирц өөрчлөгдлөө ✓");
      setOverrideOpen(null);
      setOverrideReason("");
      // Refresh
      const [attRes, auditRes] = await Promise.all([
        api.get("/kpi/pending-attendance"),
        api.get("/kpi/audit-logs"),
      ]);
      setPendingAttendance(attRes.data);
      setAuditLogs(auditRes.data);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setOverrideSaving(false);
    }
  }

  const totalDays = daysInMonthSch(calYear, calMonth);
  const firstOffset = firstDayOffset(calYear, calMonth);

  // For the editing calendar, scheduled set is `editingDates` if editing else derived from scheduleData
  const currentEmpData = selectedEmpId != null
    ? scheduleData.find(s => s.employee_id === selectedEmpId) ?? null
    : null;
  const displayDates = selectedEmpId != null ? editingDates : null;

  return (
    <div className="space-y-4">
      <Toast toast={toast} />

      {/* Sub-tab switcher */}
      <div className="flex gap-1 rounded-xl bg-gray-100 p-1 w-fit">
        {([
          { key: "schedule",   label: "Хуваарь",       icon: <Calendar size={13} /> },
          { key: "attendance", label: "Ирц override",   icon: <UserCheck size={13} /> },
          { key: "audit",      label: "Audit log",      icon: <Shield size={13} /> },
        ] as const).map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setSubTab(key)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
              subTab === key ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      {/* ── SCHEDULE SUB-TAB ── */}
      {subTab === "schedule" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Employee list */}
          <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <span className="font-semibold text-sm text-gray-800">Ажилтан сонгох</span>
            </div>
            <ul className="divide-y divide-gray-100">
              {employees.map(emp => {
                const empSch = scheduleData.find(s => s.employee_id === emp.id);
                const dayCount = empSch?.dates.length ?? 0;
                const isEditing = selectedEmpId === emp.id;
                return (
                  <li key={emp.id}
                    onClick={() => startEdit(empSch ?? null, emp.id)}
                    className={`flex items-center justify-between px-4 py-3 cursor-pointer transition-colors ${
                      isEditing ? "bg-blue-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <div>
                      <div className="text-sm font-medium text-gray-900">{dispName(emp)}</div>
                      <div className="text-xs text-gray-400">{dayCount} өдөр товлогдсон</div>
                    </div>
                    {isEditing && (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">Засаж байна</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Calendar editor */}
          <div className="rounded-2xl bg-white shadow-sm border border-gray-100 p-4">
            <div className="flex items-center justify-between mb-3">
              <button onClick={prevMonth} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
                <ChevronLeft size={18} />
              </button>
              <span className="text-sm font-semibold text-gray-800">{calYear} · {MONTH_NAMES_SCH[calMonth - 1]}</span>
              <button onClick={nextMonth} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
                <ChevronRight size={18} />
              </button>
            </div>

            {selectedEmpId == null ? (
              <div className="py-10 text-center text-sm text-gray-400">
                Зүүн талаас ажилтан сонгоно уу
              </div>
            ) : (
              <>
                <p className="text-xs text-blue-600 font-medium mb-3">
                  {employees.find(e => e.id === selectedEmpId) ? dispName(employees.find(e => e.id === selectedEmpId)!) : ""} — хуваарь засварлаж байна
                </p>

                {/* Day headers */}
                <div className="grid grid-cols-7 mb-1">
                  {CAL_DAYS.map(d => (
                    <div key={d} className="text-center text-[11px] font-medium text-gray-400 py-1">{d}</div>
                  ))}
                </div>

                {/* Day cells */}
                <div className="grid grid-cols-7 gap-y-1">
                  {Array.from({ length: firstOffset }).map((_, i) => <div key={`e-${i}`} />)}
                  {Array.from({ length: totalDays }, (_, i) => i + 1).map(day => {
                    const dateStr = isoDateSch(calYear, calMonth, day);
                    const isSelected = displayDates?.has(dateStr) ?? false;
                    const isToday = dateStr === today;
                    return (
                      <button
                        key={day}
                        onClick={() => toggleDay(dateStr)}
                        className={`
                          mx-auto flex h-9 w-9 items-center justify-center rounded-xl text-sm transition-all font-medium
                          ${isSelected
                            ? "bg-[#0071E3] text-white shadow-md"
                            : "text-gray-600 hover:bg-blue-50"
                          }
                          ${isToday && !isSelected ? "ring-2 ring-[#0071E3] ring-offset-1" : ""}
                        `}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>

                {/* Save */}
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-gray-400">{editingDates.size} өдөр сонгогдсон</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setSelectedEmpId(null); setEditingDates(new Set()); }}
                      className="rounded-xl border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      Болих
                    </button>
                    <button
                      onClick={saveSchedule}
                      disabled={savingSchedule}
                      className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50 transition-all"
                    >
                      <Check size={14} />
                      {savingSchedule ? "Хадгалж байна..." : "Хадгалах"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── ATTENDANCE OVERRIDE SUB-TAB ── */}
      {subTab === "attendance" && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            Admin хэн ч хэдийг ч ирцийг засаж болно. <span className="font-semibold text-red-600">Тайлбар заавал оруулна.</span> Аливаа өөрчлөлт Audit log-д бүртгэгдэнэ.
          </p>

          {pendingAttendance.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-white py-14 shadow-sm border border-gray-100">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50">
                <UserCheck size={24} className="text-emerald-500" />
              </div>
              <p className="text-sm text-gray-500">Батлагдаагүй ирц байхгүй байна</p>
            </div>
          ) : (
            pendingAttendance.map(cl => (
              <div key={cl.id} className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">{cl.employee_username}</span>
                      <span className="text-xs text-gray-400">{cl.date}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        cl.attendance_status === "approved" ? "bg-emerald-50 text-emerald-700"
                        : cl.attendance_status === "rejected" ? "bg-red-50 text-red-700"
                        : "bg-amber-50 text-amber-700"
                      }`}>
                        {cl.attendance_status === "approved" ? "Ирц батлагдсан"
                          : cl.attendance_status === "rejected" ? "Ирц хүчингүй"
                          : "Ирц хүлээгдэж буй"}
                      </span>
                    </div>
                    {cl.attendance_note && (
                      <div className="text-xs text-gray-400 mt-0.5">{cl.attendance_note}</div>
                    )}
                  </div>
                  <button
                    onClick={() => { setOverrideOpen(overrideOpen === cl.id ? null : cl.id); setOverrideReason(""); setOverrideStatus("approved"); }}
                    className="flex items-center gap-1.5 rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 transition-colors"
                  >
                    <Pencil size={12} /> Admin засах
                  </button>
                </div>

                {overrideOpen === cl.id && (
                  <div className="border-t border-gray-100 px-4 py-3 bg-gray-50 space-y-3">
                    <div className="flex items-center gap-3">
                      <label className="text-xs font-medium text-gray-600 whitespace-nowrap">Шинэ статус:</label>
                      <select
                        value={overrideStatus}
                        onChange={e => setOverrideStatus(e.target.value)}
                        className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]"
                      >
                        <option value="approved">Ирц батлагдсан</option>
                        <option value="rejected">Ирц хүчингүй</option>
                        <option value="pending">Хүлээгдэж буй</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-red-600">
                        Тайлбар (заавал) *
                      </label>
                      <input
                        value={overrideReason}
                        onChange={e => setOverrideReason(e.target.value)}
                        placeholder="Засварын шалтгаан оруулна уу..."
                        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]"
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setOverrideOpen(null)}
                        className="rounded-xl border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
                      >
                        Болих
                      </button>
                      <button
                        onClick={() => adminOverrideAttendance(cl.id)}
                        disabled={overrideSaving || !overrideReason.trim()}
                        className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50 transition-all"
                      >
                        <Shield size={14} />
                        {overrideSaving ? "Хадгалж байна..." : "Хадгалах"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* ── AUDIT LOG SUB-TAB ── */}
      {subTab === "audit" && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <select
              value={auditEmpFilter}
              onChange={e => setAuditEmpFilter(e.target.value)}
              className="rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]"
            >
              <option value="">Бүх ажилтан</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>{dispName(e)}</option>
              ))}
            </select>
          </div>

          {auditLogs.length === 0 ? (
            <div className="rounded-2xl bg-white border border-gray-100 py-12 text-center text-sm text-gray-400 shadow-sm">
              Audit log хоосон байна
            </div>
          ) : (
            <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
              <ul className="divide-y divide-gray-100">
                {auditLogs
                  .filter(l => !auditEmpFilter || String(l.target_employee_name).includes(
                    employees.find(e => String(e.id) === auditEmpFilter)?.nickname?.trim() ||
                    employees.find(e => String(e.id) === auditEmpFilter)?.username || ""
                  ))
                  .map(log => (
                    <li key={log.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50">
                          <Shield size={13} className="text-blue-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-semibold text-gray-900">{log.admin_name}</span>
                            <span className="text-gray-400">→</span>
                            <span className="font-medium text-gray-700">{log.target_employee_name}</span>
                            <span className="text-xs text-gray-400">{log.target_date}</span>
                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">{log.action}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                            {log.old_value && <span className="line-through text-red-400">{log.old_value}</span>}
                            {log.old_value && log.new_value && <span>→</span>}
                            {log.new_value && <span className="text-emerald-600 font-medium">{log.new_value}</span>}
                          </div>
                          <div className="mt-1 text-xs text-blue-700 bg-blue-50 rounded px-2 py-1">
                            💬 {log.reason}
                          </div>
                        </div>
                        <span className="shrink-0 text-xs text-gray-400">
                          {log.created_at ? new Date(log.created_at).toLocaleString("mn-MN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                        </span>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
