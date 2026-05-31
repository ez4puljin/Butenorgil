import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  CalendarClock, Download, RefreshCw, Check, X, AlertCircle, Users, Clock, Settings2,
} from "lucide-react";
import { api } from "../lib/api";
import { useLiveRefresh } from "../lib/liveEvents";

type DayHours = Record<string, [string, string]>;  // {"0":["08:00","15:00"], ...}
type SchedData = { work_days: string; work_start: string; work_end: string; grace_minutes: number; day_hours?: DayHours };
type RoleSched = { value: string; label: string; employee_count: number; schedule: SchedData | null };

type Row = {
  employee_id: number;
  employee_name: string;
  date: string;
  weekday: string;
  first_in: string;
  last_out: string;
  late_minutes: number;
  early_minutes: number;
  worked_minutes: number;
  status: "present" | "late" | "absent" | "off";
};

type Adjustment = {
  id: number;
  employee_id: number;
  employee_name: string;
  target_date: string | null;
  requested_in: string;
  requested_out: string;
  reason: string;
  status: string;
  response_note: string;
};

type SchedRow = {
  id: number;
  name: string;
  role: string;
  role_label?: string;
  schedule: null | SchedData;
};

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  present: { label: "Ирсэн",    cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  late:    { label: "Хоцорсон", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  absent:  { label: "Тасалсан", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  off:     { label: "Амралт",   cls: "bg-gray-50 text-gray-400 ring-gray-200" },
};

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
function monthStartStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-01`;
}
function fmtWorked(min: number): string {
  if (!min) return "—";
  return `${Math.floor(min / 60)}ц ${min % 60}м`;
}

export default function AttendanceAdmin() {
  const [tab, setTab] = useState<"summary" | "requests" | "schedules">("summary");
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  // Summary
  const [dateFrom, setDateFrom] = useState(monthStartStr());
  const [dateTo, setDateTo] = useState(todayStr());
  const [empFilter, setEmpFilter] = useState<number | "">("");
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [employees, setEmployees] = useState<{ id: number; name: string }[]>([]);
  const [loadingSum, setLoadingSum] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Requests
  const [pending, setPending] = useState<Adjustment[]>([]);
  const [rejectId, setRejectId] = useState<number | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  // Schedules
  const [defaultSched, setDefaultSched] = useState<any>(null);
  const [schedRows, setSchedRows] = useState<SchedRow[]>([]);
  const [roleScheds, setRoleScheds] = useState<RoleSched[]>([]);

  const sumTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSummary = async () => {
    setLoadingSum(true); setErr("");
    try {
      const r = await api.get("/attendance/admin/summary", {
        params: { date_from: dateFrom, date_to: dateTo, employee_id: empFilter || undefined },
      });
      setRows(r.data.rows ?? []);
      setTotals(r.data.totals ?? null);
      setEmployees(r.data.employees ?? []);
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Ачаалахад алдаа гарлаа");
      setRows([]);
    } finally { setLoadingSum(false); }
  };
  const loadPending = async () => {
    try {
      const r = await api.get("/attendance/adjustments", { params: { status: "pending" } });
      setPending(r.data ?? []);
    } catch { /* silent */ }
  };
  const loadSchedules = async () => {
    try {
      const r = await api.get("/attendance/schedules");
      setDefaultSched(r.data.default);
      setSchedRows(r.data.employees ?? []);
      setRoleScheds(r.data.roles ?? []);
    } catch { /* silent */ }
  };

  const saveRoleSchedule = async (roleValue: string, s: SchedData) => {
    try {
      await api.put(`/attendance/schedules/role/${roleValue}`, s);
      flash("Тушаалын хуваарь хадгалагдлаа ✓");
      await loadSchedules();
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Хадгалахад алдаа гарлаа");
    }
  };
  const clearRoleSchedule = async (roleValue: string) => {
    try {
      await api.delete(`/attendance/schedules/role/${roleValue}`);
      flash("Тушаалын хуваарь устгагдлаа");
      await loadSchedules();
    } catch { setErr("Алдаа гарлаа"); }
  };

  useEffect(() => { loadSummary(); loadPending(); }, []);
  useEffect(() => { if (tab === "schedules") loadSchedules(); }, [tab]);

  // Real-time — хэн нэг punch/хүсэлт өгөхөд шинэчилнэ
  useLiveRefresh(["attendance"], () => {
    if (sumTimer.current) clearTimeout(sumTimer.current);
    sumTimer.current = setTimeout(() => {
      if (tab === "summary") loadSummary();
      loadPending();
    }, 600);
  });

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(""), 3000); };

  const exportExcel = async () => {
    setExporting(true);
    try {
      const r = await api.get("/attendance/admin/export", {
        params: { date_from: dateFrom, date_to: dateTo, employee_id: empFilter || undefined },
        responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([r.data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `Цаг_бүртгэл_${dateFrom}_${dateTo}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setErr("Excel татахад алдаа гарлаа");
    } finally { setExporting(false); }
  };

  const respond = async (id: number, status: "approved" | "rejected", note = "") => {
    try {
      await api.patch(`/attendance/adjustments/${id}/respond`, { status, response_note: note });
      flash(status === "approved" ? "Зөвшөөрөгдлөө ✓" : "Татгалзлаа");
      setRejectId(null); setRejectNote("");
      await loadPending();
      if (tab === "summary") loadSummary();
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Алдаа гарлаа");
    }
  };

  const saveSchedule = async (employeeId: number, s: { work_days: string; work_start: string; work_end: string; grace_minutes: number }) => {
    try {
      await api.put(`/attendance/schedules/${employeeId}`, s);
      flash("Хуваарь хадгалагдлаа ✓");
      await loadSchedules();
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Хадгалахад алдаа гарлаа");
    }
  };
  const clearSchedule = async (employeeId: number) => {
    try {
      await api.delete(`/attendance/schedules/${employeeId}`);
      flash("Default-руу буцаалаа");
      await loadSchedules();
    } catch { setErr("Алдаа гарлаа"); }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="px-4 py-3 sm:px-6 sm:py-4">
      {/* Toast */}
      {(err || notice) && (
        <div className={`fixed left-3 right-3 top-3 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg sm:left-auto sm:right-5 sm:max-w-sm ${
          err ? "bg-red-600 text-white" : "bg-emerald-600 text-white"
        }`}>
          {err ? <AlertCircle size={15} /> : <Check size={15} />}
          <span className="flex-1">{err || notice}</span>
          <button onClick={() => { setErr(""); setNotice(""); }}><X size={14} /></button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-sm">
          <CalendarClock size={22} />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">Цаг бүртгэл — Админ</h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">Бүх ажилтны ирц, нөхөн бүртгэл, ажлын хуваарь</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-4 flex gap-1 rounded-xl bg-gray-100 p-1 sm:max-w-lg">
        {([["summary", "Бүх ажилтан", Users], ["requests", "Хүсэлт", Clock], ["schedules", "Хуваарь", Settings2]] as const).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors ${
              tab === key ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-900"
            }`}>
            <Icon size={14} />{label}
            {key === "requests" && pending.length > 0 && (
              <span className="ml-0.5 rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{pending.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── SUMMARY TAB ── */}
      {tab === "summary" && (
        <div className="mt-4">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-gray-500">Эхлэх</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className="mt-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] outline-none focus:border-blue-400" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-gray-500">Дуусах</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className="mt-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] outline-none focus:border-blue-400" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-gray-500">Ажилтан</label>
              <select value={empFilter} onChange={(e) => setEmpFilter(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-blue-400">
                <option value="">Бүгд</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <button onClick={loadSummary} disabled={loadingSum}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
              {loadingSum ? <RefreshCw size={13} className="animate-spin" /> : "Харах"}
            </button>
            <button onClick={exportExcel} disabled={exporting || rows.length === 0}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
              <Download size={14} />{exporting ? "Татаж байна…" : "Excel татах"}
            </button>
          </div>

          {/* Stat tiles */}
          {totals && (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Нийт ажилтан" value={totals.employee_count} color="bg-blue-50 text-blue-700" />
              <Tile label="Ирсэн (өдөр·хүн)" value={totals.present} color="bg-emerald-50 text-emerald-700" />
              <Tile label="Хоцорсон" value={totals.late} color="bg-amber-50 text-amber-700" />
              <Tile label="Тасалсан" value={totals.absent} color="bg-rose-50 text-rose-700" />
            </div>
          )}

          {/* Table */}
          <div className="mt-3 overflow-x-auto rounded-2xl border border-gray-100 bg-white shadow-sm">
            {loadingSum ? (
              <div className="flex items-center justify-center py-12 text-gray-400"><RefreshCw size={16} className="mr-2 animate-spin" />Ачааллаж байна…</div>
            ) : rows.length === 0 ? (
              <p className="py-12 text-center text-[13px] text-gray-400">Мэдээлэл алга</p>
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-gray-50 text-left text-[10.5px] font-bold uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="px-3 py-2.5">Огноо</th>
                    <th className="px-3 py-2.5">Гараг</th>
                    <th className="px-3 py-2.5">Ажилтан</th>
                    <th className="px-3 py-2.5 text-center">Ирсэн</th>
                    <th className="px-3 py-2.5 text-center">Явсан</th>
                    <th className="px-3 py-2.5 text-right">Хоцролт</th>
                    <th className="px-3 py-2.5 text-right">Эрт явсан</th>
                    <th className="px-3 py-2.5 text-right">Ажилласан</th>
                    <th className="px-3 py-2.5 text-center">Төлөв</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((r, i) => {
                    const pill = STATUS_PILL[r.status] ?? STATUS_PILL.off;
                    return (
                      <tr key={`${r.employee_id}-${r.date}-${i}`} className="hover:bg-gray-50/60">
                        <td className="px-3 py-2 font-mono text-gray-600">{r.date.slice(5)}</td>
                        <td className="px-3 py-2 text-gray-500">{r.weekday}</td>
                        <td className="px-3 py-2 font-medium text-gray-800">{r.employee_name}</td>
                        <td className="px-3 py-2 text-center tabular-nums text-emerald-700">{r.first_in || "—"}</td>
                        <td className="px-3 py-2 text-center tabular-nums text-rose-700">{r.last_out || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-700">{r.late_minutes ? `${r.late_minutes}м` : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-orange-600">{r.early_minutes ? `${r.early_minutes}м` : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmtWorked(r.worked_minutes)}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ${pill.cls}`}>{pill.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── REQUESTS TAB ── */}
      {tab === "requests" && (
        <div className="mt-4 space-y-2">
          {pending.length === 0 ? (
            <div className="grid place-items-center rounded-2xl border border-gray-100 bg-white py-12 text-gray-400">
              <Check size={24} className="mb-2 text-emerald-400" />
              <p className="text-[13px]">Хүлээгдэж буй хүсэлт алга</p>
            </div>
          ) : pending.map((a) => (
            <div key={a.id} className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900">{a.employee_name}</span>
                <span className="font-mono text-[13px] text-gray-600">{a.target_date}</span>
                <span className="text-[13px] text-gray-500">
                  {a.requested_in && `Ирсэн ${a.requested_in}`}
                  {a.requested_in && a.requested_out && " · "}
                  {a.requested_out && `Явсан ${a.requested_out}`}
                </span>
              </div>
              {a.reason && <p className="mt-1 text-[12px] text-gray-500 italic">Шалтгаан: {a.reason}</p>}

              {rejectId === a.id ? (
                <div className="mt-3 flex items-center gap-2">
                  <input value={rejectNote} onChange={(e) => setRejectNote(e.target.value)}
                    placeholder="Татгалзах шалтгаан (заавал биш)"
                    className="flex-1 rounded-lg border border-rose-200 px-3 py-1.5 text-[13px] outline-none focus:border-rose-400" />
                  <button onClick={() => respond(a.id, "rejected", rejectNote)}
                    className="rounded-lg bg-rose-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-rose-700">Татгалзах</button>
                  <button onClick={() => { setRejectId(null); setRejectNote(""); }}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50">Болих</button>
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
                  <button onClick={() => respond(a.id, "approved")}
                    className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-emerald-700">
                    <Check size={14} /> Зөвшөөрөх
                  </button>
                  <button onClick={() => setRejectId(a.id)}
                    className="flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-1.5 text-[13px] font-semibold text-rose-700 hover:bg-rose-100">
                    <X size={14} /> Татгалзах
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── SCHEDULES TAB ── */}
      {tab === "schedules" && (
        <div className="mt-4 space-y-4">
          {defaultSched && (
            <ScheduleCard
              title="Глобал default (хуваарьгүй бүх ажилтанд)"
              sched={defaultSched}
              onSave={(s) => saveSchedule(0, s)}
            />
          )}

          {/* ── Тушаалаар хуваарь — адилхан тушаалтай бүх ажилтанд хамаарна ── */}
          <div className="rounded-2xl border border-gray-100 bg-white shadow-sm">
            <div className="border-b border-gray-100 px-4 py-3">
              <div className="text-[13px] font-semibold text-gray-700">Тушаалаар хуваарь</div>
              <div className="mt-0.5 text-[11px] text-gray-500">Адилхан тушаалтай бүх ажилтан ижил цагийн хуваарьтай болно</div>
            </div>
            <div className="divide-y divide-gray-50">
              {roleScheds.map((r) => (
                <RoleScheduleRow key={r.value} role={r} defaultSched={defaultSched}
                  onSave={(s) => saveRoleSchedule(r.value, s)} onClear={() => clearRoleSchedule(r.value)} />
              ))}
            </div>
          </div>

          {/* ── Ажилтны хувийн хуваарь (онцгой тохиолдолд override) ── */}
          <div className="rounded-2xl border border-gray-100 bg-white shadow-sm">
            <div className="border-b border-gray-100 px-4 py-3">
              <div className="text-[13px] font-semibold text-gray-700">Ажилтны хувийн хуваарь</div>
              <div className="mt-0.5 text-[11px] text-gray-500">Зөвхөн онцгой ажилтанд — тушаалынхаас давуу. Тушаалыг энд засахгүй.</div>
            </div>
            <div className="divide-y divide-gray-50">
              {schedRows.map((e) => (
                <EmployeeScheduleRow key={e.id} emp={e} defaultSched={defaultSched}
                  onSave={(s) => saveSchedule(e.id, s)} onClear={() => clearSchedule(e.id)} />
              ))}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function Tile({ label, value, color }: { label: string; value: any; color: string }) {
  return (
    <div className={`rounded-xl px-3 py-2.5 ${color}`}>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="text-[10.5px] font-medium opacity-80">{label}</div>
    </div>
  );
}

const WEEKDAYS_FULL = ["Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням"];

function ScheduleEditor({ init, onSave }: {
  init: SchedData;
  onSave: (s: SchedData) => void;
}) {
  const defStart = init.work_start || "09:00";
  const defEnd = init.work_end || "18:00";
  const initDays = new Set((init.work_days || "").split(",").filter((x) => x.trim() !== "").map(Number));
  const initDh: DayHours = init.day_hours || {};

  // Гариг бүрийн төлөв: идэвхтэй эсэх + эхлэх/дуусах цаг
  const [rows, setRows] = useState(() =>
    WEEKDAYS_FULL.map((_, i) => {
      const ovr = initDh[String(i)];
      return {
        on: initDays.has(i),
        start: ovr ? ovr[0] : defStart,
        end: ovr ? ovr[1] : defEnd,
      };
    })
  );
  const [grace, setGrace] = useState(init.grace_minutes ?? 10);

  const setRow = (i: number, patch: Partial<{ on: boolean; start: string; end: string }>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = () => {
    const workDays: number[] = [];
    const dayHours: DayHours = {};
    rows.forEach((r, i) => {
      if (r.on) {
        workDays.push(i);
        dayHours[String(i)] = [r.start, r.end];
      }
    });
    // work_start/work_end-д эхний ажлын өдрийн цагийг default болгож хадгална
    const firstOn = rows.find((r) => r.on);
    onSave({
      work_days: workDays.join(","),
      work_start: firstOn ? firstOn.start : defStart,
      work_end: firstOn ? firstOn.end : defEnd,
      grace_minutes: grace,
      day_hours: dayHours,
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${r.on ? "bg-blue-50/60" : "bg-gray-50"}`}>
            <label className="flex w-24 cursor-pointer items-center gap-1.5">
              <input type="checkbox" className="h-3.5 w-3.5 rounded accent-blue-600"
                checked={r.on} onChange={(e) => setRow(i, { on: e.target.checked })} />
              <span className={`text-[12px] font-medium ${r.on ? "text-gray-800" : "text-gray-400"}`}>{WEEKDAYS_FULL[i]}</span>
            </label>
            {r.on ? (
              <div className="flex items-center gap-1.5 text-[12px]">
                <input type="time" value={r.start} onChange={(e) => setRow(i, { start: e.target.value })}
                  className="rounded-md border border-gray-200 px-2 py-1 outline-none focus:border-blue-400" />
                <span className="text-gray-400">–</span>
                <input type="time" value={r.end} onChange={(e) => setRow(i, { end: e.target.value })}
                  className="rounded-md border border-gray-200 px-2 py-1 outline-none focus:border-blue-400" />
              </div>
            ) : (
              <span className="text-[11px] text-gray-400">Амралт</span>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5 text-[12px]">
        <span className="text-gray-500">Хоцролтын тэвчээр</span>
        <input type="number" min={0} value={grace} onChange={(e) => setGrace(Number(e.target.value))}
          className="w-16 rounded-md border border-gray-200 px-2 py-1 text-right outline-none focus:border-blue-400" />
        <span className="text-gray-400">минут</span>
      </div>
      <button onClick={save}
        className="rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700">Хадгалах</button>
    </div>
  );
}

function ScheduleCard({ title, sched, onSave }: {
  title: string; sched: any; onSave: (s: any) => void;
}) {
  return (
    <div className="rounded-2xl border border-blue-100 bg-blue-50/40 p-4">
      <div className="mb-3 text-[13px] font-semibold text-gray-800">{title}</div>
      <ScheduleEditor init={sched} onSave={onSave} />
    </div>
  );
}

function RoleScheduleRow({ role, defaultSched, onSave, onClear }: {
  role: RoleSched; defaultSched: any;
  onSave: (s: SchedData) => void; onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasCustom = !!role.schedule;
  const init = role.schedule || defaultSched || { work_days: "0,1,2,3,4,5", work_start: "09:00", work_end: "18:00", grace_minutes: 10 };
  return (
    <div className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-gray-800">{role.label}</span>
        <span className="text-[11px] text-gray-400">{role.employee_count} ажилтан</span>
        {hasCustom ? (
          <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">Хуваарьтай</span>
        ) : (
          <span className="text-[11px] text-gray-300">(default ашиглана)</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {hasCustom && (
            <button onClick={onClear} className="rounded-md px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-rose-600">Default-руу</button>
          )}
          <button onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-gray-200 px-2.5 py-1 text-[12px] font-medium text-gray-600 hover:bg-gray-50">
            {open ? "Хаах" : "Хуваарь тохируулах"}
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-3 rounded-xl bg-gray-50 p-3">
          <ScheduleEditor init={init} onSave={(s) => { onSave(s); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

function EmployeeScheduleRow({ emp, defaultSched, onSave, onClear }: {
  emp: SchedRow; defaultSched: any;
  onSave: (s: any) => void; onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasCustom = !!emp.schedule;
  const init = emp.schedule || defaultSched || { work_days: "0,1,2,3,4,5", work_start: "09:00", work_end: "18:00", grace_minutes: 10 };
  return (
    <div className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-gray-800">{emp.name}</span>
        {/* Тушаал — зөвхөн харуулна (монгол нэр), энд засахгүй */}
        <span className="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">{emp.role_label || emp.role}</span>
        {hasCustom ? (
          <span className="rounded-md bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 ring-1 ring-blue-200">Хувийн хуваарь</span>
        ) : (
          <span className="text-[11px] text-gray-300">(тушаалынхаар)</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {hasCustom && (
            <button onClick={onClear} className="rounded-md px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-rose-600">Тушаалынхаар</button>
          )}
          <button onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-gray-200 px-2.5 py-1 text-[12px] font-medium text-gray-600 hover:bg-gray-50">
            {open ? "Хаах" : "Хувийн хуваарь"}
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-3 rounded-xl bg-gray-50 p-3">
          <ScheduleEditor init={init} onSave={(s) => { onSave(s); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}
