import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckSquare, Square, Send, Plus, X, CheckCircle, AlertCircle,
  ChevronLeft, ChevronRight, ArrowLeftRight, UserCheck, Clock,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";

// ── Types ──────────────────────────────────────────────────────────────────

interface Entry {
  id: number;
  task_name: string;
  monetary_value: number;
  approved_value: number | null;
  approver_username: string;
  is_adhoc: boolean;
  admin_task_id: number | null;
  is_checked: boolean;
  approval_status: string;
  approval_note: string;
  task_category: string;
  period?: string | null;
  day_of_week?: number | null;
  day_of_month?: number | null;
}

interface Checklist {
  id: number;
  date: string;
  status: string;
  attendance_status: string;
  attendance_note: string;
  entries: Entry[];
}

interface UserOption {
  id: number;
  username: string;
  nickname?: string;
}

interface ShiftTransfer {
  id: number;
  date: string;
  original_employee_name: string;
  replacement_employee_name: string;
  approver_name: string;
  status: string;
  note: string;
  response_note: string;
  created_at: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  pending:  "bg-amber-50 text-amber-700",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-red-50 text-red-700",
};
const STATUS_LABEL: Record<string, string> = {
  pending:  "Хүлээгдэж буй",
  approved: "Батлагдсан",
  rejected: "Татгалзсан",
};
const ATTENDANCE_COLOR: Record<string, string> = {
  pending:  "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};
const ATTENDANCE_LABEL: Record<string, string> = {
  pending:  "Ирц хүлээгдэж буй",
  approved: "Ирц батлагдсан",
  rejected: "Ирц хүчингүй",
};

const MON_DAYS_FULL = ["Да", "Мя", "Лх", "Пү", "Ба", "Бя", "Ня"];
const WEEK_DAYS = ["Ня", "Да", "Мя", "Лх", "Пү", "Ба", "Бя"];
const MON_DAYS  = ["Да", "Мя", "Лх", "Пү", "Ба", "Бя", "Ня"];
const MONTH_NAMES = [
  "1-р сар", "2-р сар", "3-р сар", "4-р сар", "5-р сар", "6-р сар",
  "7-р сар", "8-р сар", "9-р сар", "10-р сар", "11-р сар", "12-р сар",
];

// ── Helpers ────────────────────────────────────────────────────────────────

function localToday(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// First day of month: 0=Sun → remap to Mon=0 index
function firstDayOfWeek(year: number, month: number): number {
  const d = new Date(year, month - 1, 1).getDay();
  return d === 0 ? 6 : d - 1; // Mon=0 … Sun=6
}

function periodLabel(
  period: string | null | undefined,
  checklistDate: string,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null,
): string | null {
  if (!period || period === "daily") return null;
  const d = parseDate(checklistDate);
  const fmt = (dt: Date) =>
    `${WEEK_DAYS[dt.getDay()]} ${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  if (period === "weekly") {
    const dow = d.getDay();
    const toMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(d); monday.setDate(d.getDate() + toMonday);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return dayOfWeek != null
      ? `${fmt(monday)} → ${fmt(sunday)} · ${MON_DAYS[dayOfWeek]}`
      : `${fmt(monday)} → ${fmt(sunday)}`;
  }
  if (period === "monthly") {
    const base = `${d.getMonth() + 1}-р сар`;
    return dayOfMonth != null ? `${base} · ${dayOfMonth}-нд` : base;
  }
  return null;
}

// ── Toast ──────────────────────────────────────────────────────────────────

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

// ── Main Component ─────────────────────────────────────────────────────────

const inp = "w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 outline-none transition focus:border-[#0071E3] focus:bg-white focus:shadow-[0_0_0_3px_rgba(0,113,227,0.12)] placeholder:text-gray-400";

export default function KpiChecklist() {
  const { role } = useAuthStore();

  // Calendar navigation
  const todayStr = localToday();
  const todayD = parseDate(todayStr);
  const [calYear, setCalYear]   = useState(todayD.getFullYear());
  const [calMonth, setCalMonth] = useState(todayD.getMonth() + 1);
  const [selectedDate, setSelectedDate] = useState(todayStr);

  // Scheduled days for current month
  const [scheduledDates, setScheduledDates] = useState<string[]>([]);

  // Checklists cache: date → Checklist (or null if no checklist)
  const [checklistCache, setChecklistCache] = useState<Record<string, Checklist | null>>({});
  const [loadingChecklist, setLoadingChecklist] = useState(false);

  // Shift transfer
  const [shiftTransfers, setShiftTransfers] = useState<ShiftTransfer[]>([]);
  const [showShift, setShowShift]       = useState(false);
  const [shiftDate, setShiftDate]       = useState(todayStr);
  const [shiftReplacement, setShiftReplacement] = useState("");
  const [shiftApprover, setShiftApprover]       = useState("");
  const [shiftNote, setShiftNote]               = useState("");
  const [submittingShift, setSubmittingShift]   = useState(false);

  // Adhoc modal
  const [showAdhoc, setShowAdhoc]     = useState(false);
  const [adhocName, setAdhocName]     = useState("");
  const [adhocAmount, setAdhocAmount] = useState("");
  const [adhocApprover, setAdhocApprover] = useState("");

  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitting, setSubmitting]   = useState(false);

  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  function notify(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3200);
  }

  // ── Load scheduled days for calendar month ─────────────────────────────

  // Load my schedule using dedicated endpoint
  const loadMySchedule = useCallback(async () => {
    try {
      const res = await api.get("/kpi/my-schedule", {
        params: { year: calYear, month: calMonth },
      });
      setScheduledDates(res.data);
    } catch {
      setScheduledDates([]);
    }
  }, [calYear, calMonth]);

  const loadShiftTransfers = useCallback(async () => {
    try {
      const res = await api.get("/kpi/shift-transfers");
      setShiftTransfers(res.data);
    } catch {}
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const res = await api.get("/kpi/employees");
      setUserOptions(res.data);
    } catch {}
  }, []);

  useEffect(() => { loadMySchedule(); }, [calYear, calMonth]);
  useEffect(() => { loadShiftTransfers(); loadUsers(); }, []);

  // ── Load checklist for selected date ──────────────────────────────────

  const loadChecklist = useCallback(async (d: string) => {
    if (checklistCache[d] !== undefined) return; // already cached
    setLoadingChecklist(true);
    try {
      const res = await api.get("/kpi/my-checklist", { params: { date: d } });
      setChecklistCache(prev => ({ ...prev, [d]: res.data }));
    } catch {
      setChecklistCache(prev => ({ ...prev, [d]: null }));
    } finally {
      setLoadingChecklist(false);
    }
  }, [checklistCache]);

  useEffect(() => {
    loadChecklist(selectedDate);
  }, [selectedDate]);

  const checklist = checklistCache[selectedDate] ?? null;

  function refreshChecklist(updated: Checklist) {
    setChecklistCache(prev => ({ ...prev, [selectedDate]: updated }));
  }

  // ── Calendar helpers ───────────────────────────────────────────────────

  function prevMonth() {
    if (calMonth === 1) { setCalYear(y => y - 1); setCalMonth(12); }
    else setCalMonth(m => m - 1);
  }
  function nextMonth() {
    if (calMonth === 12) { setCalYear(y => y + 1); setCalMonth(1); }
    else setCalMonth(m => m + 1);
  }

  const scheduledSet = new Set(scheduledDates);
  const today = localToday();
  const totalDays = daysInMonth(calYear, calMonth);
  const firstOffset = firstDayOfWeek(calYear, calMonth);

  // Status badge for each scheduled day based on cached checklists
  function dayStatus(dateStr: string): "submitted" | "draft" | "absent" | null {
    if (!scheduledSet.has(dateStr)) return null;
    const cl = checklistCache[dateStr];
    if (cl === undefined) return null; // not loaded
    if (cl === null) {
      // Scheduled but no checklist submitted → absent (only for past days)
      return dateStr < today ? "absent" : null;
    }
    return cl.status === "submitted" ? "submitted" : "draft";
  }

  // Prefetch first few days in view
  useEffect(() => {
    // Pre-load checklists for scheduled dates in current month view
    scheduledDates.forEach(d => {
      if (checklistCache[d] === undefined) {
        loadChecklist(d);
      }
    });
  }, [scheduledDates]);

  // ── Actions ────────────────────────────────────────────────────────────

  async function toggleCheck(entry: Entry) {
    if (checklist?.status === "submitted") return;
    try {
      const res = await api.patch(`/kpi/entries/${entry.id}/check`, { is_checked: !entry.is_checked });
      refreshChecklist({
        ...checklist!,
        entries: checklist!.entries.map(e => e.id === entry.id ? { ...e, ...res.data } : e),
      });
    } catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }

  async function submit() {
    if (!checklist) return;
    setSubmitting(true);
    setShowSubmitConfirm(false);
    try {
      const res = await api.post(`/kpi/checklists/${checklist.id}/submit`);
      refreshChecklist(res.data);
      notify("Амжилттай илгээлээ");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setSubmitting(false);
    }
  }

  async function addAdhoc() {
    if (!checklist || !adhocName || !adhocAmount || !adhocApprover) return;
    try {
      const res = await api.post(`/kpi/checklists/${checklist.id}/adhoc`, {
        task_name: adhocName,
        monetary_value: parseFloat(adhocAmount),
        approver_id: parseInt(adhocApprover),
      });
      refreshChecklist({ ...checklist, entries: [...checklist.entries, res.data] });
      setShowAdhoc(false);
      setAdhocName(""); setAdhocAmount(""); setAdhocApprover("");
      notify("Нэмэлт ажил нэмэгдлээ");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  async function sendShiftTransfer() {
    if (!shiftDate || !shiftReplacement || !shiftApprover) return;
    setSubmittingShift(true);
    try {
      await api.post("/kpi/shift-transfers", {
        date: shiftDate,
        replacement_employee_id: parseInt(shiftReplacement),
        approver_id: parseInt(shiftApprover),
        note: shiftNote,
      });
      notify("Ээлж шилжүүлэх хүсэлт илгээгдлээ");
      setShowShift(false);
      setShiftNote(""); setShiftReplacement(""); setShiftApprover("");
      loadShiftTransfers();
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setSubmittingShift(false);
    }
  }

  // ── Derived values ─────────────────────────────────────────────────────

  const checkedCount    = checklist?.entries.filter(e => e.is_checked).length ?? 0;
  const totalCount      = checklist?.entries.length ?? 0;
  const totalChecked    = checklist?.entries.filter(e => e.is_checked).reduce((s, e) => s + e.monetary_value, 0) ?? 0;
  const isSubmitted     = checklist?.status === "submitted";
  const isScheduled     = scheduledSet.has(selectedDate);
  const isToday         = selectedDate === today;
  const isPast          = selectedDate < today;
  const attendanceStatus = checklist?.attendance_status ?? "pending";

  // Pending shift transfers that need my response
  const pendingShiftsForMe = shiftTransfers.filter(t => t.status === "pending");

  return (
    <div className="space-y-4">
      <Toast toast={toast} />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Өдрийн даалгавар</h1>
          <p className="text-sm text-gray-500">Хуваарьт өдрөө сонгоод ажлаа тэмдэглэнэ үү</p>
        </div>
        <div className="flex items-center gap-2">
          {pendingShiftsForMe.length > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-orange-100 px-3 py-1 text-xs font-medium text-orange-700">
              <ArrowLeftRight size={12} />
              {pendingShiftsForMe.length} ээлж хүсэлт
            </span>
          )}
          <button
            onClick={() => { setShiftDate(selectedDate); setShowShift(true); }}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors shadow-sm"
          >
            <ArrowLeftRight size={14} />
            Ээлж шилжүүлэх
          </button>
        </div>
      </div>

      {/* Calendar */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white shadow-sm border border-gray-100 p-4"
      >
        {/* Month nav */}
        <div className="flex items-center justify-between mb-3">
          <button onClick={prevMonth} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
            <ChevronLeft size={18} />
          </button>
          <span className="text-sm font-semibold text-gray-800">
            {calYear} · {MONTH_NAMES[calMonth - 1]}
          </span>
          <button onClick={nextMonth} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
            <ChevronRight size={18} />
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {MON_DAYS_FULL.map(d => (
            <div key={d} className="text-center text-[11px] font-medium text-gray-400 py-1">{d}</div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7 gap-y-1">
          {/* offset empty cells */}
          {Array.from({ length: firstOffset }).map((_, i) => <div key={`e-${i}`} />)}

          {Array.from({ length: totalDays }, (_, i) => i + 1).map(day => {
            const dateStr = isoDate(calYear, calMonth, day);
            const scheduled = scheduledSet.has(dateStr);
            const isSelected = dateStr === selectedDate;
            const isTodayCell = dateStr === today;
            const ds = dayStatus(dateStr);
            const isPastDay = dateStr < today;

            return (
              <button
                key={day}
                onClick={() => {
                  setSelectedDate(dateStr);
                  // navigate calendar to selected month if different
                }}
                className={`
                  relative mx-auto flex h-9 w-9 flex-col items-center justify-center rounded-xl text-sm transition-all
                  ${isSelected
                    ? "bg-[#0071E3] text-white font-bold shadow-md"
                    : scheduled
                      ? "bg-blue-50 text-blue-700 font-medium hover:bg-blue-100"
                      : "text-gray-400 hover:bg-gray-50"
                  }
                  ${isTodayCell && !isSelected ? "ring-2 ring-[#0071E3] ring-offset-1" : ""}
                `}
              >
                {day}
                {/* Status dot */}
                {scheduled && !isSelected && (
                  <span
                    className={`absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full
                      ${ds === "submitted" ? "bg-emerald-500"
                        : ds === "draft"     ? "bg-amber-400"
                        : ds === "absent"    ? "bg-red-400"
                        : "bg-blue-300"
                      }`}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-gray-400 border-t border-gray-100 pt-3">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-300 inline-block" /> Хуваарьт</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" /> Илгээсэн</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400 inline-block" /> Ноорог</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-400 inline-block" /> Тасалсан</span>
        </div>
      </motion.div>

      {/* Selected date info */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-700">
          {parseDate(selectedDate).toLocaleDateString("mn-MN", { year: "numeric", month: "long", day: "numeric" })}
        </span>
        {isToday && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700 font-medium">Өнөөдөр</span>}
        {isScheduled
          ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600">Хуваарьт өдөр</span>
          : <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Хуваарьгүй өдөр</span>
        }
      </div>

      {/* No schedule for day */}
      {!isScheduled && !isToday && (
        <div className="rounded-2xl bg-gray-50 border border-gray-100 p-6 text-center text-sm text-gray-400">
          Энэ өдөр таны ажлын хуваарьт байхгүй байна.
        </div>
      )}

      {/* Checklist area */}
      {(isScheduled || isToday) && (
        <>
          {/* Attendance status */}
          {checklist && isSubmitted && (
            <div className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm ${ATTENDANCE_COLOR[attendanceStatus]}`}>
              <UserCheck size={15} />
              <span className="font-medium">{ATTENDANCE_LABEL[attendanceStatus]}</span>
              {checklist.attendance_note && (
                <span className="ml-1 text-xs opacity-80">— {checklist.attendance_note}</span>
              )}
            </div>
          )}

          {/* Status bar */}
          {checklist && (
            <div className="flex flex-wrap gap-3">
              <div className="rounded-xl bg-white px-4 py-2.5 shadow-sm border border-gray-100 text-sm">
                <span className="text-gray-500">Статус: </span>
                <span className={`font-medium ${isSubmitted ? "text-blue-600" : "text-amber-600"}`}>
                  {isSubmitted ? "Илгээсэн" : "Ноорог"}
                </span>
              </div>
              <div className="rounded-xl bg-white px-4 py-2.5 shadow-sm border border-gray-100 text-sm">
                <span className="text-gray-500">Биелүүлсэн: </span>
                <span className="font-semibold text-gray-900">{checkedCount}/{totalCount}</span>
              </div>
              {totalChecked > 0 && (
                <div className="rounded-xl bg-white px-4 py-2.5 shadow-sm border border-gray-100 text-sm">
                  <span className="text-gray-500">Тэмдэглэсэн: </span>
                  <span className="font-semibold text-gray-900">{totalChecked.toLocaleString()}</span>
                </div>
              )}
            </div>
          )}

          {/* Progress bar */}
          {checklist && totalCount > 0 && (
            <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-[#0071E3] transition-all duration-500"
                style={{ width: `${Math.round((checkedCount / totalCount) * 100)}%` }}
              />
            </div>
          )}

          {/* Task list */}
          <motion.div
            key={selectedDate}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden"
          >
            {loadingChecklist ? (
              <div className="p-6 text-center text-sm text-gray-400">Ачааллаж байна...</div>
            ) : !checklist || checklist.entries.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">
                {isPast && isScheduled ? (
                  <>Энэ өдрийн checklist байхгүй — ирсэн бол Admin-тай холбоо барина уу.</>
                ) : (
                  <>Өнөөдрийн ажлын жагсаалт хоосон байна.<br />Admin тань ажил хуваарилаагүй байж болно.</>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {checklist.entries.map(entry => (
                  <li
                    key={entry.id}
                    className={`flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-gray-50/60 ${
                      !entry.is_checked && !isSubmitted ? "opacity-70" : ""
                    }`}
                  >
                    <button
                      onClick={() => toggleCheck(entry)}
                      disabled={isSubmitted}
                      className="mt-0.5 shrink-0 text-[#0071E3] disabled:text-gray-300 transition-colors"
                    >
                      {entry.is_checked ? <CheckSquare size={20} /> : <Square size={20} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-sm font-medium ${entry.is_checked ? "text-gray-900" : "text-gray-500"}`}>
                          {entry.task_name}
                        </span>
                        {entry.task_category === "inventory" && (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-600 font-medium">Нэмэлт</span>
                        )}
                        {entry.is_adhoc && (
                          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs text-violet-600">Нэмэлт</span>
                        )}
                        {entry.admin_task_id != null && (
                          <span className="rounded-full bg-orange-50 px-2 py-0.5 text-xs text-orange-600">KPI</span>
                        )}
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[entry.approval_status]}`}>
                          {STATUS_LABEL[entry.approval_status]}
                        </span>
                        {(() => {
                          const lbl = periodLabel(entry.period, selectedDate, entry.day_of_week, entry.day_of_month);
                          return lbl ? (
                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">{lbl}</span>
                          ) : null;
                        })()}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span className={`font-medium ${entry.approval_status === "approved" ? "text-emerald-600" : entry.task_category === "inventory" ? "text-amber-600" : "text-[#0071E3]"}`}>
                          {(entry.approved_value ?? entry.monetary_value).toLocaleString()} оноо
                        </span>
                        <span>Зөвшөөрөгч: {entry.approver_username}</span>
                      </div>
                      {entry.approval_note && (
                        <div className="mt-1 text-xs text-red-500">{entry.approval_note}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>

          {/* Action buttons */}
          {checklist && (
            <div className="flex flex-wrap gap-2">
              {!isSubmitted && (
                <button
                  onClick={() => setShowSubmitConfirm(true)}
                  disabled={submitting}
                  className="flex items-center gap-2 rounded-xl bg-[#0071E3] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-600 disabled:opacity-50 transition-all"
                >
                  <Send size={15} />
                  {submitting ? "Илгээж байна..." : "Илгээх"}
                </button>
              )}
              {!isSubmitted && (role === "admin" || role === "supervisor") && (
                <button
                  onClick={() => setShowAdhoc(true)}
                  className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-700 shadow-sm hover:bg-gray-50 transition-colors"
                >
                  <Plus size={15} />
                  Нэмэлт KPI
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* Pending shift transfers */}
      {shiftTransfers.filter(t => t.status === "pending").length > 0 && (
        <div className="rounded-2xl bg-orange-50 border border-orange-100 p-4">
          <h3 className="text-sm font-semibold text-orange-800 mb-2 flex items-center gap-1.5">
            <Clock size={14} />
            Хүлээгдэж буй ээлж шилжүүлэх хүсэлт
          </h3>
          <ul className="space-y-2">
            {shiftTransfers.filter(t => t.status === "pending").map(t => (
              <li key={t.id} className="text-xs text-orange-700 flex items-center gap-2">
                <ArrowLeftRight size={12} />
                <span>{t.date} — {t.original_employee_name} → {t.replacement_employee_name}</span>
                <span className="text-orange-400">({t.approver_name} батална)</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Submit Confirm Modal ── */}
      <AnimatePresence>
        {showSubmitConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100">
                  <Send size={18} className="text-blue-600" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Илгээхдээ итгэлтэй байна уу?</h2>
                  <p className="text-xs text-gray-400">Илгээсний дараа өөрчлөх боломжгүй</p>
                </div>
              </div>
              <div className="rounded-xl bg-blue-50 px-4 py-3 text-sm text-gray-700 mb-5">
                <span className="font-semibold text-blue-700">{checkedCount}/{totalCount}</span> ажил тэмдэглэгдсэн
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowSubmitConfirm(false)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                  Болих
                </button>
                <button onClick={submit} className="flex items-center gap-2 rounded-xl bg-[#0071E3] px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-600 transition-all">
                  <Send size={14} />
                  Илгээх
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Adhoc Modal ── */}
      <AnimatePresence>
        {showAdhoc && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4">
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-t-2xl bg-white p-6 sm:rounded-2xl shadow-2xl"
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900">Нэмэлт KPI ажил нэмэх</h2>
                <button onClick={() => setShowAdhoc(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Ажлын нэр</label>
                  <input value={adhocName} onChange={e => setAdhocName(e.target.value)} className={inp} placeholder="Ажлын нэр..." />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Мөнгөн дүн (₮)</label>
                  <input type="number" value={adhocAmount} onChange={e => setAdhocAmount(e.target.value)} className={inp} placeholder="0" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Зөвшөөрөгч</label>
                  <select value={adhocApprover} onChange={e => setAdhocApprover(e.target.value)} className={inp}>
                    <option value="">Сонгох...</option>
                    {userOptions.map(u => (
                      <option key={u.id} value={u.id}>{u.nickname || u.username}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={addAdhoc}
                  disabled={!adhocName || !adhocAmount || !adhocApprover}
                  className="w-full rounded-xl bg-[#0071E3] py-2.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-40 transition-all"
                >
                  Нэмэх
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Shift Transfer Modal ── */}
      <AnimatePresence>
        {showShift && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4">
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-t-2xl bg-white p-6 sm:rounded-2xl shadow-2xl"
            >
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-100">
                    <ArrowLeftRight size={16} className="text-orange-600" />
                  </div>
                  <h2 className="font-semibold text-gray-900">Ээлж шилжүүлэх</h2>
                </div>
                <button onClick={() => setShowShift(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Өдөр</label>
                  <input
                    type="date"
                    value={shiftDate}
                    onChange={e => setShiftDate(e.target.value)}
                    className={inp}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Орлох ажилтан</label>
                  <select value={shiftReplacement} onChange={e => setShiftReplacement(e.target.value)} className={inp}>
                    <option value="">Сонгох...</option>
                    {userOptions.map(u => (
                      <option key={u.id} value={u.id}>{u.nickname || u.username}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Батлах хүн</label>
                  <select value={shiftApprover} onChange={e => setShiftApprover(e.target.value)} className={inp}>
                    <option value="">Сонгох...</option>
                    {userOptions.map(u => (
                      <option key={u.id} value={u.id}>{u.nickname || u.username}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-600">Тайлбар</label>
                  <textarea
                    value={shiftNote}
                    onChange={e => setShiftNote(e.target.value)}
                    rows={2}
                    className={inp}
                    placeholder="Яагаад шилжүүлж байгаа..."
                  />
                </div>
                <button
                  onClick={sendShiftTransfer}
                  disabled={submittingShift || !shiftDate || !shiftReplacement || !shiftApprover}
                  className="w-full rounded-xl bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-40 transition-all"
                >
                  {submittingShift ? "Илгээж байна..." : "Хүсэлт илгээх"}
                </button>
              </div>

              {/* Recent shift transfers */}
              {shiftTransfers.length > 0 && (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <p className="text-xs font-medium text-gray-500 mb-2">Сүүлийн хүсэлтүүд</p>
                  <ul className="space-y-1.5">
                    {shiftTransfers.slice(0, 5).map(t => (
                      <li key={t.id} className="flex items-center gap-2 text-xs">
                        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                          t.status === "approved" ? "bg-emerald-100 text-emerald-700"
                          : t.status === "rejected" ? "bg-red-100 text-red-700"
                          : "bg-amber-100 text-amber-700"
                        }`}>{t.status === "approved" ? "Батлагдсан" : t.status === "rejected" ? "Татгалзсан" : "Хүлээгдэж буй"}</span>
                        <span className="text-gray-600">{t.date} · {t.replacement_employee_name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
