import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check, X, ChevronDown, ChevronUp, CheckCircle, AlertCircle,
  CheckSquare, History, Clock, Search, TrendingUp, TrendingDown,
  UserCheck, UserX, ArrowLeftRight,
  Warehouse, AlertTriangle, Package, Calendar as CalendarIcon, Loader2,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

interface Entry {
  id: number;
  task_name: string;
  monetary_value: number;
  approved_value: number | null;
  task_category: string;       // "daily" | "inventory"
  is_adhoc: boolean;
  is_checked: boolean;
  approval_status: string;
  approval_note: string;
  approved_at: string | null;
  approved_by_username: string;
}

interface Group {
  employee_id: number;
  employee_username: string;
  checklist_id: number;
  date: string;
  entries: Entry[];
}

interface AttendanceChecklist {
  id: number;
  employee_id: number;
  employee_username: string;
  date: string;
  status: string;
  attendance_status: string;
  attendance_note: string;
  submitted_at: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function localToday() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function localMonthStart() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-01`;
}

function formatTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("mn-MN", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${y}/${m}/${d}`;
}

// ── Shared components ─────────────────────────────────────────────────────────

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

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const s = size === "sm" ? "h-7 w-7 text-xs" : "h-8 w-8 text-xs";
  return (
    <div className={`flex ${s} items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 font-bold text-white shrink-0`}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// Helper: remove an entry from groups and drop empty groups
function removeEntry(groups: Group[], entryId: number): Group[] {
  return groups
    .map(g => ({ ...g, entries: g.entries.filter(e => e.id !== entryId) }))
    .filter(g => g.entries.length > 0);
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function KpiApprovals() {
  const [tab, setTab] = useState<"attendance" | "pending" | "inventory" | "history">("attendance");
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  function notify(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  return (
    <div className="space-y-4">
      <Toast toast={toast} />

      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">KPI зөвшөөрөл</h1>
          <p className="text-sm text-gray-500">Эхлээд ирц батлаад дараа нь ажлуудыг батлана</p>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
          <button
            onClick={() => setTab("attendance")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
              tab === "attendance" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <UserCheck size={14} />
            Ирц батлах
          </button>
          <button
            onClick={() => setTab("pending")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
              tab === "pending" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <Clock size={14} />
            Ажил батлах
          </button>
          <button
            onClick={() => setTab("inventory")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
              tab === "inventory" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <Warehouse size={14} />
            Тооллогын батлал
          </button>
          <button
            onClick={() => setTab("history")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
              tab === "history" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <History size={14} />
            Түүх
          </button>
        </div>
      </div>

      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
      >
        {tab === "attendance"
          ? <AttendanceTab notify={notify} />
          : tab === "pending"
          ? <PendingTab notify={notify} />
          : tab === "inventory"
          ? <InventoryBulkTab notify={notify} />
          : <HistoryTab notify={notify} />
        }
      </motion.div>
    </div>
  );
}

// ── Attendance Tab ────────────────────────────────────────────────────────────

function AttendanceTab({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const [checklists, setChecklists] = useState<AttendanceChecklist[]>([]);
  const [loading, setLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState<Set<number>>(new Set());
  const [rejectNote, setRejectNote] = useState<Record<number, string>>({});
  const [shiftTransfers, setShiftTransfers] = useState<any[]>([]);

  async function load() {
    setLoading(true);
    try {
      const [attendRes, shiftRes] = await Promise.all([
        api.get("/kpi/pending-attendance"),
        api.get("/kpi/shift-transfers"),
      ]);
      setChecklists(attendRes.data);
      setShiftTransfers(shiftRes.data.filter((t: any) => t.status === "pending"));
    } catch {
      notify("Ачааллахад алдаа гарлаа", false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function approveAttendance(id: number) {
    try {
      await api.patch(`/kpi/checklists/${id}/attendance`, {
        attendance_status: "approved",
        attendance_note: "",
      });
      notify("Ирц батлагдлаа ✓");
      setChecklists(prev => prev.filter(c => c.id !== id));
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  async function rejectAttendance(id: number) {
    try {
      await api.patch(`/kpi/checklists/${id}/attendance`, {
        attendance_status: "rejected",
        attendance_note: rejectNote[id] ?? "",
      });
      notify("Ирц татгалзлаа");
      setChecklists(prev => prev.filter(c => c.id !== id));
      setRejectOpen(prev => { const s = new Set(prev); s.delete(id); return s; });
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  async function respondShift(id: number, status: "approved" | "rejected") {
    try {
      await api.patch(`/kpi/shift-transfers/${id}/respond`, { status, response_note: "" });
      notify(status === "approved" ? "Ээлж шилжүүлэх батлагдлаа ✓" : "Ээлж шилжүүлэх татгалзлаа");
      setShiftTransfers(prev => prev.filter(t => t.id !== id));
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-[#0071E3]" />
        Ачааллаж байна...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Shift transfer approvals */}
      {shiftTransfers.length > 0 && (
        <div className="rounded-2xl bg-orange-50 border border-orange-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-orange-100">
            <h3 className="text-sm font-semibold text-orange-800 flex items-center gap-1.5">
              <ArrowLeftRight size={14} />
              Ээлж шилжүүлэх хүсэлт ({shiftTransfers.length})
            </h3>
          </div>
          <ul className="divide-y divide-orange-100">
            {shiftTransfers.map((t: any) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900">
                    {t.date} · <span className="text-orange-700">{t.original_employee_name}</span>
                    <span className="mx-1 text-gray-400">→</span>
                    <span className="text-emerald-700">{t.replacement_employee_name}</span>
                  </div>
                  {t.note && <div className="text-xs text-gray-500 mt-0.5">{t.note}</div>}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={() => respondShift(t.id, "approved")}
                    className="flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                  >
                    <Check size={12} /> Батлах
                  </button>
                  <button
                    onClick={() => respondShift(t.id, "rejected")}
                    className="flex items-center gap-1 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors"
                  >
                    <X size={12} /> Татгалзах
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Attendance approvals */}
      {checklists.length === 0 && shiftTransfers.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-white py-16 shadow-sm border border-gray-100">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50">
            <UserCheck size={28} className="text-emerald-500" />
          </div>
          <div className="text-center">
            <p className="font-semibold text-gray-700">Бүгд дууслаа!</p>
            <p className="mt-0.5 text-sm text-gray-400">Батлах ирц байхгүй байна</p>
          </div>
        </div>
      ) : (
        <>
          {checklists.length > 0 && (
            <div className="flex items-center gap-2 rounded-xl bg-blue-50 border border-blue-100 px-4 py-2.5">
              <div className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
              <span className="text-sm font-medium text-blue-700">
                {checklists.length} ажилтны ирц батлагдахыг хүлээж байна
              </span>
            </div>
          )}

          <div className="space-y-2">
            {checklists.map(cl => (
              <motion.div
                key={cl.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden"
              >
                <div className="flex items-center justify-between px-4 py-3.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar name={cl.employee_username} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900">{cl.employee_username}</span>
                        <span className="text-xs text-gray-400">{formatDate(cl.date)}</span>
                      </div>
                      {cl.submitted_at && (
                        <div className="text-xs text-gray-400 mt-0.5">
                          Илгээсэн: {formatTime(cl.submitted_at)}
                        </div>
                      )}
                    </div>
                  </div>

                  {!rejectOpen.has(cl.id) ? (
                    <div className="flex gap-1.5 shrink-0">
                      <button
                        onClick={() => approveAttendance(cl.id)}
                        className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600 transition-colors shadow-sm"
                      >
                        <UserCheck size={13} /> Ирц батлах
                      </button>
                      <button
                        onClick={() => setRejectOpen(prev => { const s = new Set(prev); s.add(cl.id); return s; })}
                        className="flex items-center gap-1.5 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors"
                      >
                        <UserX size={13} /> Хүчингүй
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        value={rejectNote[cl.id] ?? ""}
                        onChange={e => setRejectNote(prev => ({ ...prev, [cl.id]: e.target.value }))}
                        placeholder="Татгалзах шалтгаан..."
                        className="rounded-xl border border-red-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-red-400 w-40"
                      />
                      <button
                        onClick={() => rejectAttendance(cl.id)}
                        className="rounded-xl bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 transition-colors"
                      >
                        Хүчингүй болгох
                      </button>
                      <button
                        onClick={() => setRejectOpen(prev => { const s = new Set(prev); s.delete(cl.id); return s; })}
                        className="text-gray-400 hover:text-gray-600"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


// ── Pending Tab ───────────────────────────────────────────────────────────────

function PendingTab({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rejectNote, setRejectNote] = useState<Record<number, string>>({});
  const [rejectOpen, setRejectOpen] = useState<Set<number>>(new Set());
  const [approveOpen, setApproveOpen] = useState<Set<number>>(new Set());
  const [approveValue, setApproveValue] = useState<Record<number, string>>({});
  const [approveAllLoading, setApproveAllLoading] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    try {
      const res = await api.get("/kpi/pending-approvals");
      const filtered: Group[] = (res.data as Group[])
        .map(g => ({ ...g, entries: g.entries.filter(e => e.is_checked) }))
        .filter(g => g.entries.length > 0);
      setGroups(filtered);
      setExpanded(new Set(filtered.map(g => `${g.employee_id}-${g.date}`)));
    } catch {
      notify("Ачааллахад алдаа гарлаа", false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function openApprove(entry: Entry) {
    setApproveValue(prev => ({ ...prev, [entry.id]: String(entry.monetary_value) }));
    setApproveOpen(prev => { const s = new Set(prev); s.add(entry.id); return s; });
  }
  function closeApprove(id: number) {
    setApproveOpen(prev => { const s = new Set(prev); s.delete(id); return s; });
    setApproveValue(prev => { const n = { ...prev }; delete n[id]; return n; });
  }

  async function approve(entryId: number) {
    const val = parseFloat(approveValue[entryId] ?? "");
    try {
      await api.patch(`/kpi/entries/${entryId}/approve`, {
        approval_status: "approved", approval_note: "",
        approved_value: isNaN(val) ? null : val,
      });
      notify("Батлагдлаа ✓");
      closeApprove(entryId);
      setGroups(prev => removeEntry(prev, entryId));
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  async function reject(entryId: number) {
    try {
      await api.patch(`/kpi/entries/${entryId}/approve`, {
        approval_status: "rejected", approval_note: rejectNote[entryId] ?? "",
      });
      notify("Татгалзлаа");
      setRejectOpen(prev => { const s = new Set(prev); s.delete(entryId); return s; });
      setRejectNote(prev => { const n = { ...prev }; delete n[entryId]; return n; });
      setGroups(prev => removeEntry(prev, entryId));
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  async function approveAll(group: Group) {
    const key = `${group.employee_id}-${group.date}`;
    const checked = group.entries.filter(e => e.is_checked);
    if (!checked.length) return;
    setApproveAllLoading(prev => { const s = new Set(prev); s.add(key); return s; });
    try {
      await Promise.all(checked.map(e =>
        api.patch(`/kpi/entries/${e.id}/approve`, {
          approval_status: "approved", approval_note: "", approved_value: e.monetary_value,
        })
      ));
      notify(`${checked.length} ажил бүгд батлагдлаа ✓`);
      setGroups(prev =>
        prev
          .map(g => g.checklist_id === group.checklist_id
            ? { ...g, entries: g.entries.filter(e => !e.is_checked) } : g)
          .filter(g => g.entries.length > 0)
      );
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setApproveAllLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
    }
  }

  function toggleGroup(key: string) {
    setExpanded(prev => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return s;
    });
  }

  const totalPending = groups.reduce((s, g) => s + g.entries.filter(e => e.is_checked).length, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-[#0071E3]" />
        Ачааллаж байна...
      </div>
    );
  }

  if (!loading && groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-white py-16 shadow-sm border border-gray-100">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50">
          <CheckCircle size={28} className="text-emerald-500" />
        </div>
        <div className="text-center">
          <p className="font-semibold text-gray-700">Бүгд дууслаа!</p>
          <p className="mt-0.5 text-sm text-gray-400">Хүлээгдэж буй ажил байхгүй байна</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Pending count badge */}
      <div className="flex items-center gap-2 rounded-xl bg-amber-50 border border-amber-100 px-4 py-2.5">
        <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        <span className="text-sm font-medium text-amber-700">{totalPending} ажил зөвшөөрлийг хүлээж байна</span>
      </div>

      {groups.map(group => {
        const key = `${group.employee_id}-${group.date}`;
        const isOpen = expanded.has(key);
        const groupTotal = group.entries.reduce((s, e) => s + e.monetary_value, 0);
        const checkedCount = group.entries.filter(e => e.is_checked).length;
        const isAALoading = approveAllLoading.has(key);

        return (
          <motion.div
            key={key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <button onClick={() => toggleGroup(key)} className="flex flex-1 items-center gap-3 text-left min-w-0">
                <Avatar name={group.employee_username} />
                <div className="min-w-0">
                  <span className="font-semibold text-gray-900">{group.employee_username}</span>
                  <span className="ml-2 text-xs text-gray-400">{formatDate(group.date)}</span>
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    <Clock size={10} /> {checkedCount} ажил
                  </span>
                </div>
              </button>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-sm font-bold text-gray-800">{groupTotal.toLocaleString()}₮</span>
                {checkedCount > 0 && (
                  <button
                    onClick={() => approveAll(group)}
                    disabled={isAALoading}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50 transition-all"
                  >
                    <CheckSquare size={12} />
                    {isAALoading ? "..." : "Бүгд батлах"}
                  </button>
                )}
                <button onClick={() => toggleGroup(key)} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 transition-colors">
                  {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>
              </div>
            </div>

            {/* Entries */}
            <AnimatePresence>
              {isOpen && (
                <motion.ul
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden divide-y divide-gray-50"
                >
                  {group.entries.map(entry => (
                    <li key={entry.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-gray-900">{entry.task_name}</span>
                            {entry.task_category === "inventory" && (
                              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">Нэмэлт</span>
                            )}
                            {entry.is_adhoc && (
                              <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs text-violet-600">Нэмэлт</span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-[#0071E3]">
                            {entry.task_category === "inventory"
                              ? <>{(entry.approved_value ?? entry.monetary_value).toLocaleString()} оноо
                                  {entry.approved_value != null && entry.approved_value !== entry.monetary_value && (
                                    <span className="text-gray-400 line-through font-normal">{entry.monetary_value.toLocaleString()} оноо</span>
                                  )}
                                </>
                              : <>{entry.monetary_value} оноо
                                  {entry.approved_value != null && (
                                    <span className="text-gray-500 font-normal">→ {entry.approved_value} батлагдсан</span>
                                  )}
                                </>
                            }
                          </div>
                        </div>
                        {!approveOpen.has(entry.id) && !rejectOpen.has(entry.id) && (
                          <div className="flex shrink-0 gap-1">
                            <button
                              onClick={() => openApprove(entry)}
                              className="flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                            >
                              <Check size={13} /> Батлах
                            </button>
                            <button
                              onClick={() => setRejectOpen(prev => { const s = new Set(prev); s.add(entry.id); return s; })}
                              className="flex items-center gap-1 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors"
                            >
                              <X size={13} /> Татгалзах
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Approve panel */}
                      {approveOpen.has(entry.id) && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2">
                          {entry.task_category === "inventory" ? (
                            <>
                              <span className="text-xs font-medium text-emerald-700">Батлах оноо:</span>
                              <span className="text-xs text-emerald-600 opacity-60">0–{entry.monetary_value.toLocaleString()} оноо</span>
                            </>
                          ) : (
                            <>
                              <span className="text-xs font-medium text-emerald-700">Батлах оноо:</span>
                              <span className="text-xs text-emerald-600 opacity-60">0–{entry.monetary_value} оноо</span>
                            </>
                          )}
                          <input
                            type="number" min={0}
                            max={entry.task_category !== "inventory" ? entry.monetary_value : undefined}
                            value={approveValue[entry.id] ?? ""}
                            onChange={e => setApproveValue(prev => ({ ...prev, [entry.id]: e.target.value }))}
                            onWheel={e => e.currentTarget.blur()}
                            placeholder={entry.task_category === "inventory"
                              ? String(entry.monetary_value)
                              : String(entry.monetary_value)}
                            className="w-28 rounded-lg border border-emerald-200 bg-white px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-400"
                          />
                          {entry.task_category !== "inventory" && approveValue[entry.id] && (
                            <span className="text-xs text-emerald-600">
                              ({Math.round((parseFloat(approveValue[entry.id]) / entry.monetary_value) * 100)}%)
                            </span>
                          )}
                          <button onClick={() => approve(entry.id)}
                            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 transition-colors">
                            <Check size={12} className="inline mr-0.5" />Батлах
                          </button>
                          <button onClick={() => closeApprove(entry.id)} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
                        </div>
                      )}

                      {/* Reject panel */}
                      {rejectOpen.has(entry.id) && (
                        <div className="mt-2.5 flex gap-2 rounded-xl bg-red-50 px-3 py-2">
                          <input
                            value={rejectNote[entry.id] ?? ""}
                            onChange={e => setRejectNote(prev => ({ ...prev, [entry.id]: e.target.value }))}
                            placeholder="Татгалзах шалтгаан (заавал биш)..."
                            className="flex-1 rounded-lg border border-red-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-red-400"
                          />
                          <button onClick={() => reject(entry.id)}
                            className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 transition-colors">
                            Татгалзах
                          </button>
                          <button onClick={() => setRejectOpen(prev => { const s = new Set(prev); s.delete(entry.id); return s; })}
                            className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
                        </div>
                      )}
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}

// ── Inventory Bulk Approve Tab ────────────────────────────────────────────────

// ISO week helpers (Mon=1 … Sun=7)
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

// Compute the date of a given (year, isoWeek, isoDayOfWeek 1=Mon..7=Sun) — UTC-safe
function isoWeekToDate(year: number, week: number, day: number): Date {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay() || 7;
  const mon = new Date(simple);
  mon.setUTCDate(simple.getUTCDate() - dow + 1);
  const target = new Date(mon);
  target.setUTCDate(mon.getUTCDate() + (day - 1));
  return target;
}

function isoWeeksInMonth(year: number, month: number): { week: number; label: string }[] {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const weeks = new Map<number, { mon: Date; sun: Date }>();
  for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
    const wk = getISOWeek(new Date(d));
    if (!weeks.has(wk)) {
      const mon = isoWeekToDate(year, wk, 1);
      const sun = isoWeekToDate(year, wk, 7);
      weeks.set(wk, { mon, sun });
    }
  }
  return Array.from(weeks.entries())
    .sort(([a], [b]) => a - b)
    .map(([w, { mon, sun }]) => ({
      week: w,
      label: `${w}-р долоо хоног (${mon.getUTCMonth() + 1}/${mon.getUTCDate()}–${sun.getUTCMonth() + 1}/${sun.getUTCDate()})`,
    }));
}

const MN_MONTHS = [
  "1-р сар", "2-р сар", "3-р сар", "4-р сар", "5-р сар", "6-р сар",
  "7-р сар", "8-р сар", "9-р сар", "10-р сар", "11-р сар", "12-р сар",
];

interface InventorySummary {
  pending_count: number;
  approved_count: number;
  rejected_count: number;
  total_count: number;
  pending_value: number;
}

function InventoryBulkTab({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const today = new Date();
  const [year, setYear] = useState<number>(today.getFullYear());
  const [month, setMonth] = useState<number>(today.getMonth() + 1);
  const [scope, setScope] = useState<"month" | "week">("month");
  const [weekIso, setWeekIso] = useState<number | "">("");
  const [includeRejected, setIncludeRejected] = useState(false);

  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isSaturday = today.getDay() === 6;
  const weeks = isoWeeksInMonth(year, month);

  // Initialise week selector to first week of month when switching to week scope
  useEffect(() => {
    if (scope === "week" && weekIso === "" && weeks.length > 0) {
      setWeekIso(weeks[0].week);
    }
    if (scope === "month") setWeekIso("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, year, month]);

  async function loadSummary() {
    setLoading(true);
    try {
      const params: Record<string, any> = { year, month };
      if (scope === "week" && typeof weekIso === "number") params.week_iso = weekIso;
      const res = await api.get("/kpi/inventory/pending-summary", { params });
      setSummary(res.data);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Ачааллахад алдаа гарлаа", false);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSummary(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [year, month, scope, weekIso]);

  async function doBulkApprove() {
    setSubmitting(true);
    try {
      const body: Record<string, any> = { year, month, include_rejected: includeRejected };
      if (scope === "week" && typeof weekIso === "number") body.week_iso = weekIso;
      const res = await api.post("/kpi/inventory/bulk-approve", body);
      const n = res.data?.approved ?? 0;
      notify(`${n} тооллогын KPI batlagdlaa ✓`);
      setConfirmOpen(false);
      await loadSummary();
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setSubmitting(false);
    }
  }

  const targetCount = includeRejected
    ? (summary?.pending_count ?? 0) + (summary?.rejected_count ?? 0)
    : (summary?.pending_count ?? 0);

  const scopeLabel = scope === "week" && typeof weekIso === "number"
    ? `${year} он · ${MN_MONTHS[month - 1]} · ${weekIso}-р долоо хоног`
    : `${year} он · ${MN_MONTHS[month - 1]} (бүтэн сар)`;

  return (
    <div className="space-y-4">
      {/* Saturday warning (or info if today is Saturday) */}
      {!isSaturday ? (
        <div className="flex items-start gap-3 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3">
          <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-amber-800">Өнөөдөр Бямба биш байна</p>
            <p className="mt-0.5 text-amber-700">
              Тооллогын батлалыг Бямба гарагт хийхийг зөвлөв.
              Үргэлжлүүлэхдээ хүсэлт нь нэгэн audit-д тэмдэглэгдэнэ.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 border border-emerald-100 px-4 py-2.5">
          <CalendarIcon size={14} className="text-emerald-600" />
          <span className="text-sm font-medium text-emerald-700">Өнөөдөр Бямба — тооллогын батлал хийх зөв өдөр</span>
        </div>
      )}

      {/* Filter card */}
      <div className="rounded-2xl bg-white p-4 shadow-sm border border-gray-100 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Жил</label>
            <input
              type="number" min={2020} max={2099}
              value={year}
              onChange={e => setYear(parseInt(e.target.value || String(today.getFullYear()), 10))}
              onWheel={e => e.currentTarget.blur()}
              className="w-24 rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3] tabular-nums"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Сар</label>
            <select
              value={month}
              onChange={e => setMonth(parseInt(e.target.value, 10))}
              className="rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]"
            >
              {MN_MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Хамрах хүрээ</label>
            <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
              <button
                onClick={() => setScope("month")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  scope === "month" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                Бүтэн сар
              </button>
              <button
                onClick={() => setScope("week")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  scope === "week" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                Долоо хоног
              </button>
            </div>
          </div>
          {scope === "week" && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-500">Долоо хоног</label>
              <select
                value={weekIso === "" ? "" : weekIso}
                onChange={e => setWeekIso(e.target.value === "" ? "" : parseInt(e.target.value, 10))}
                className="rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3]"
              >
                {weeks.map(w => <option key={w.week} value={w.week}>{w.label}</option>)}
              </select>
            </div>
          )}
        </div>

        {/* Include rejected toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeRejected}
            onChange={e => setIncludeRejected(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-[#0071E3] focus:ring-[#0071E3]"
          />
          <span className="text-sm text-gray-700">Татгалзсан entries-ийг ч багтаах</span>
          <span className="text-xs text-gray-400">(анхдагч: зөвхөн pending)</span>
        </label>
      </div>

      {/* Loading state */}
      {loading && !summary && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Ачааллаж байна...
        </div>
      )}

      {/* Stats grid */}
      {summary && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Нийт",         value: summary.total_count,    sub: "entries",     icon: <Package size={16} />,     bg: "bg-blue-50",    color: "text-blue-700",    iconBg: "bg-blue-100" },
              { label: "Хүлээгдэж",    value: summary.pending_count,  sub: `${summary.pending_value.toLocaleString()} оноо`, icon: <Clock size={16} />,       bg: "bg-amber-50",   color: "text-amber-700",   iconBg: "bg-amber-100" },
              { label: "Батлагдсан",   value: summary.approved_count, sub: "entries",     icon: <CheckCircle size={16} />, bg: "bg-emerald-50", color: "text-emerald-700", iconBg: "bg-emerald-100" },
              { label: "Татгалзсан",   value: summary.rejected_count, sub: "entries",     icon: <X size={16} />,           bg: "bg-red-50",     color: "text-red-600",     iconBg: "bg-red-100" },
            ].map(s => (
              <div key={s.label} className={`flex items-center gap-3 rounded-2xl ${s.bg} border border-white/80 px-4 py-3`}>
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${s.iconBg} ${s.color}`}>
                  {s.icon}
                </div>
                <div className="min-w-0">
                  <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-xs text-gray-500 truncate">{s.label} · {s.sub}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Main CTA card */}
          <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <CalendarIcon size={14} />
                  {scopeLabel}
                </div>
                <div className="mt-1 text-2xl font-bold text-gray-900 tabular-nums">
                  {targetCount}
                  <span className="ml-2 text-sm font-medium text-gray-500">
                    entry батлагдана
                  </span>
                </div>
                {includeRejected && summary.rejected_count > 0 && (
                  <p className="mt-1 text-xs text-amber-700">
                    ⚠ Татгалзсан {summary.rejected_count} entry-ийг дахин батална
                  </p>
                )}
              </div>
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={targetCount === 0 || loading}
                className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-600 disabled:bg-gray-200 disabled:text-gray-400 transition-all shadow-sm"
              >
                <CheckSquare size={16} />
                Бүгдийг батлах
              </button>
            </div>
            {targetCount === 0 && summary.total_count > 0 && (
              <p className="mt-3 text-xs text-gray-500">
                Сонгосон хамрах хүрээнд батлах хүлээгдэж буй entry байхгүй.
              </p>
            )}
            {summary.total_count === 0 && (
              <p className="mt-3 text-xs text-gray-500">
                Сонгосон хугацаанд тооллогын KPI entry бүртгэгдээгүй байна.
              </p>
            )}
          </div>
        </>
      )}

      {/* Confirm modal */}
      <AnimatePresence>
        {confirmOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => !submitting && setConfirmOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ duration: 0.18 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-md rounded-2xl bg-white shadow-xl overflow-hidden"
            >
              {/* Modal header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100">
                    <Warehouse size={16} className="text-emerald-600" />
                  </div>
                  <h3 className="text-base font-semibold text-gray-900">Тооллогын батлал</h3>
                </div>
                {!submitting && (
                  <button onClick={() => setConfirmOpen(false)} className="text-gray-400 hover:text-gray-600">
                    <X size={16} />
                  </button>
                )}
              </div>

              {/* Modal body */}
              <div className="px-5 py-4 space-y-3">
                {!isSaturday && (
                  <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5">
                    <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800">
                      Өнөөдөр <span className="font-semibold">Бямба биш</span>. Тооллогын батлалыг Бямба гарагт хийхийг зөвлөв.
                    </p>
                  </div>
                )}

                <div className="rounded-xl bg-gray-50 p-3 text-sm">
                  <div className="flex items-center justify-between py-1">
                    <span className="text-gray-500">Хамрах хүрээ:</span>
                    <span className="font-medium text-gray-900">{scopeLabel}</span>
                  </div>
                  <div className="flex items-center justify-between py-1 border-t border-gray-200 mt-1 pt-2">
                    <span className="text-gray-500">Хүлээгдэж буй:</span>
                    <span className="font-semibold text-amber-700 tabular-nums">{summary?.pending_count ?? 0}</span>
                  </div>
                  {includeRejected && (
                    <div className="flex items-center justify-between py-1">
                      <span className="text-gray-500">Татгалзсан (дахин):</span>
                      <span className="font-semibold text-red-600 tabular-nums">{summary?.rejected_count ?? 0}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between py-1 border-t border-gray-200 mt-1 pt-2">
                    <span className="text-gray-500">Нийт батлагдана:</span>
                    <span className="font-bold text-emerald-700 tabular-nums">{targetCount} entry</span>
                  </div>
                </div>

                <p className="text-xs text-gray-500">
                  Энэхүү үйлдэл нь сонгосон хүрээ доторх бүх ажилтны тооллогын KPI оноог
                  бүрэн (max монетарын дүнгээр) баталгаажуулна. Үйлдэл буцах боломжтой
                  ч тус бүр гар аар сэргээх шаардлагатай.
                </p>
              </div>

              {/* Modal footer */}
              <div className="flex items-center justify-end gap-2 px-5 py-3 bg-gray-50 border-t border-gray-100">
                <button
                  onClick={() => setConfirmOpen(false)}
                  disabled={submitting}
                  className="rounded-xl px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                >
                  Болих
                </button>
                <button
                  onClick={doBulkApprove}
                  disabled={submitting || targetCount === 0}
                  className="flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:bg-gray-300 transition-colors"
                >
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {submitting ? "Баталж байна..." : `${targetCount} entry-г батлах`}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────────────────────

function HistoryTab({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const [dateFrom, setDateFrom] = useState(localMonthStart());
  const [dateTo, setDateTo] = useState(localToday());
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function loadHistory() {
    setLoading(true);
    setSearched(true);
    try {
      const res = await api.get("/kpi/approval-history", {
        params: { date_from: dateFrom, date_to: dateTo },
      });
      const data = res.data as Group[];
      setGroups(data);
      setExpanded(new Set(data.map(g => `${g.employee_id}-${g.date}`)));
    } catch {
      notify("Ачааллахад алдаа гарлаа", false);
    } finally {
      setLoading(false);
    }
  }

  // Auto-load on mount
  useEffect(() => { loadHistory(); }, []);

  function toggleGroup(key: string) {
    setExpanded(prev => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return s;
    });
  }

  // Stats
  const allEntries = groups.flatMap(g => g.entries);
  const approvedEntries = allEntries.filter(e => e.approval_status === "approved");
  const rejectedEntries = allEntries.filter(e => e.approval_status === "rejected");
  const totalApproved = approvedEntries.reduce((s, e) => s + (e.approved_value ?? e.monetary_value), 0);
  const totalRejected = rejectedEntries.reduce((s, e) => s + e.monetary_value, 0);

  return (
    <div className="space-y-4">
      {/* Date range filter */}
      <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-white p-4 shadow-sm border border-gray-100">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-500">Эхлэх огноо</label>
          <input
            type="date" value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3] transition-shadow"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-500">Дуусах огноо</label>
          <input
            type="date" value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0071E3] transition-shadow"
          />
        </div>
        <button
          onClick={loadHistory}
          disabled={loading}
          className="flex items-center gap-2 rounded-xl bg-[#0071E3] px-5 py-2 text-sm font-semibold text-white hover:bg-[#0063CC] disabled:opacity-50 transition-all"
        >
          <Search size={14} />
          {loading ? "Хайж байна..." : "Харах"}
        </button>
        {/* Quick range shortcuts */}
        <div className="flex gap-1.5 ml-auto">
          {[
            { label: "Энэ сар", from: localMonthStart(), to: localToday() },
            {
              label: "Өнгөрсөн сар",
              from: (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; })(),
              to: (() => { const d = new Date(); d.setDate(0); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })(),
            },
            { label: "7 хоног", from: (() => { const d = new Date(); d.setDate(d.getDate()-6); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })(), to: localToday() },
          ].map(r => (
            <button
              key={r.label}
              onClick={() => { setDateFrom(r.from); setDateTo(r.to); }}
              className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats summary */}
      {searched && !loading && groups.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Нийт хяналт",    value: allEntries.length,      sub: "ажил",      icon: <History size={16} />,    bg: "bg-blue-50",    color: "text-blue-700",    iconBg: "bg-blue-100" },
            { label: "Батлагдсан",     value: approvedEntries.length, sub: "ажил",      icon: <TrendingUp size={16} />, bg: "bg-emerald-50", color: "text-emerald-700", iconBg: "bg-emerald-100" },
            { label: "Нийт дүн",       value: totalApproved.toLocaleString() + "₮", sub: "батлагдсан", icon: <CheckCircle size={16} />, bg: "bg-emerald-50", color: "text-emerald-700", iconBg: "bg-emerald-100" },
            { label: "Татгалзсан",     value: rejectedEntries.length, sub: `${totalRejected.toLocaleString()}₮`, icon: <TrendingDown size={16} />, bg: "bg-red-50", color: "text-red-600", iconBg: "bg-red-100" },
          ].map(s => (
            <div key={s.label} className={`flex items-center gap-3 rounded-2xl ${s.bg} border border-white/80 px-4 py-3`}>
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${s.iconBg} ${s.color}`}>
                {s.icon}
              </div>
              <div>
                <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-gray-500">{s.label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-[#0071E3]" />
          Ачааллаж байна...
        </div>
      )}

      {/* Empty state */}
      {!loading && searched && groups.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-white py-14 shadow-sm border border-gray-100">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100">
            <History size={26} className="text-gray-400" />
          </div>
          <div className="text-center">
            <p className="font-semibold text-gray-600">Түүх олдсонгүй</p>
            <p className="mt-0.5 text-sm text-gray-400">Сонгосон огноонд зөвшөөрсөн ажил байхгүй байна</p>
          </div>
        </div>
      )}

      {/* History groups */}
      {!loading && groups.length > 0 && (
        <div className="space-y-3">
          {groups.map(group => {
            const key = `${group.employee_id}-${group.date}`;
            const isOpen = expanded.has(key);
            const approved = group.entries.filter(e => e.approval_status === "approved");
            const rejected = group.entries.filter(e => e.approval_status === "rejected");
            const approvedTotal = approved.reduce((s, e) => s + (e.approved_value ?? e.monetary_value), 0);

            return (
              <motion.div
                key={key}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden"
              >
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(key)}
                  className="flex w-full items-center justify-between px-4 py-3.5 text-left hover:bg-gray-50/60 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar name={group.employee_username} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-gray-900">{group.employee_username}</span>
                        <span className="text-xs text-gray-400">{formatDate(group.date)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        {approved.length > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            <Check size={10} /> {approved.length} батлагдсан
                          </span>
                        )}
                        {rejected.length > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">
                            <X size={10} /> {rejected.length} татгалзсан
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="text-sm font-bold text-emerald-600">{approvedTotal.toLocaleString()}₮</div>
                      <div className="text-xs text-gray-400">батлагдсан</div>
                    </div>
                    <div className="rounded-lg p-1 text-gray-400">
                      {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </div>
                  </div>
                </button>

                {/* Entry list */}
                <AnimatePresence>
                  {isOpen && (
                    <motion.ul
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden divide-y divide-gray-50 border-t border-gray-100"
                    >
                      {group.entries.map(entry => {
                        const isApproved = entry.approval_status === "approved";
                        const displayValue = isApproved
                          ? (entry.approved_value ?? entry.monetary_value)
                          : entry.monetary_value;
                        const valueChanged = isApproved && entry.approved_value !== null
                          && entry.approved_value !== entry.monetary_value;

                        return (
                          <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
                            {/* Status icon */}
                            <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                              isApproved ? "bg-emerald-100" : "bg-red-100"
                            }`}>
                              {isApproved
                                ? <Check size={12} className="text-emerald-600" />
                                : <X size={12} className="text-red-500" />
                              }
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-gray-900">{entry.task_name}</span>
                                {entry.is_adhoc && (
                                  <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs text-violet-600">Нэмэлт</span>
                                )}
                                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                  isApproved ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
                                }`}>
                                  {isApproved ? "Батлагдсан" : "Татгалзсан"}
                                </span>
                              </div>

                              <div className="mt-1 flex flex-wrap items-center gap-3">
                                {/* Amount */}
                                <span className={`text-xs font-bold ${isApproved ? "text-emerald-600" : "text-red-500 line-through"}`}>
                                  {displayValue.toLocaleString()} оноо
                                </span>
                                {valueChanged && (
                                  <span className="text-xs text-gray-400 line-through">{entry.monetary_value.toLocaleString()} оноо</span>
                                )}
                                {/* Time */}
                                {entry.approved_at && (
                                  <span className="flex items-center gap-1 text-xs text-gray-400">
                                    <Clock size={10} />
                                    {formatTime(entry.approved_at)}
                                  </span>
                                )}
                              </div>

                              {/* Rejection note */}
                              {!isApproved && entry.approval_note && (
                                <div className="mt-1 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-600">
                                  {entry.approval_note}
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
