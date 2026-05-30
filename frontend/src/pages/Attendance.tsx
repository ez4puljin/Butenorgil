import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LogIn, LogOut, Clock, RefreshCw, Check, AlertCircle, CalendarPlus, X, History,
} from "lucide-react";
import { api } from "../lib/api";
import { useLiveRefresh } from "../lib/liveEvents";
import { useAuthStore } from "../store/authStore";

type Punch = {
  id: number;
  punch_at: string | null;
  kind: "in" | "out";
  source: string;
  note: string;
};

type DaySummary = {
  date: string;
  weekday: string;
  first_in: string;
  last_out: string;
  late_minutes: number;
  early_minutes: number;
  worked_minutes: number;
  punch_count: number;
  is_work_day: boolean;
  status: "present" | "late" | "absent" | "off";
};

type Adjustment = {
  id: number;
  target_date: string | null;
  requested_in: string;
  requested_out: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  response_note: string;
};

const MN_MONTHS = ["1-р сар","2-р сар","3-р сар","4-р сар","5-р сар","6-р сар","7-р сар","8-р сар","9-р сар","10-р сар","11-р сар","12-р сар"];

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  present: { label: "Ирсэн",    cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  late:    { label: "Хоцорсон", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  absent:  { label: "Тасалсан", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  off:     { label: "Амралт",   cls: "bg-gray-50 text-gray-400 ring-gray-200" },
};

function hm(iso: string | null): string {
  if (!iso) return "—";
  // iso = "2026-05-30T09:41:..." (MN local naive) → "09:41"
  const t = iso.split("T")[1] || "";
  return t.slice(0, 5) || "—";
}
function fmtWorked(min: number): string {
  if (!min) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}ц ${m}м`;
}

export default function Attendance() {
  const { nickname, username } = useAuthStore();
  const now = new Date();

  const [today, setToday] = useState<{ punches: Punch[]; next_kind: "in" | "out"; last_kind: string | null }>({
    punches: [], next_kind: "in", last_kind: null,
  });
  const [punching, setPunching] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  // History
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [days, setDays] = useState<DaySummary[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [loadingHist, setLoadingHist] = useState(false);

  // Adjustment
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjForm, setAdjForm] = useState({ target_date: "", requested_in: "", requested_out: "", reason: "" });
  const [adjSaving, setAdjSaving] = useState(false);
  const [myAdj, setMyAdj] = useState<Adjustment[]>([]);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadToday = async () => {
    try {
      const r = await api.get("/attendance/today");
      setToday(r.data);
    } catch { /* silent */ }
  };
  const loadHistory = async () => {
    setLoadingHist(true);
    try {
      const r = await api.get("/attendance/me", { params: { year, month } });
      setDays(r.data.days ?? []);
      setTotals(r.data.totals ?? null);
    } catch { setDays([]); }
    finally { setLoadingHist(false); }
  };
  const loadMyAdj = async () => {
    try {
      const r = await api.get("/attendance/adjustments/me");
      setMyAdj(r.data ?? []);
    } catch { /* silent */ }
  };

  useEffect(() => { loadToday(); loadMyAdj(); }, []);
  useEffect(() => { loadHistory(); }, [year, month]);

  // Real-time — өөрийн punch шинэчлэгдэхэд (өөр device-ээс ч)
  useLiveRefresh(["attendance"], () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { loadToday(); loadHistory(); loadMyAdj(); }, 400);
  });

  const doPunch = async (kind: "in" | "out") => {
    setPunching(true); setErr(""); setNotice("");
    try {
      await api.post("/attendance/punch", { kind });
      setNotice(kind === "in" ? "Ирсэн цаг бүртгэгдлээ ✓" : "Явсан цаг бүртгэгдлээ ✓");
      await loadToday();
      await loadHistory();
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Бүртгэхэд алдаа гарлаа");
    } finally {
      setPunching(false);
      setTimeout(() => setNotice(""), 3000);
    }
  };

  const submitAdj = async () => {
    if (!adjForm.target_date) { setErr("Огноо сонгоно уу"); return; }
    if (!adjForm.requested_in && !adjForm.requested_out) { setErr("Ирсэн эсвэл явсан цаг оруулна уу"); return; }
    setAdjSaving(true); setErr("");
    try {
      await api.post("/attendance/adjustments", adjForm);
      setNotice("Нөхөн бүртгэлийн хүсэлт илгээгдлээ ✓");
      setAdjOpen(false);
      setAdjForm({ target_date: "", requested_in: "", requested_out: "", reason: "" });
      await loadMyAdj();
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Хүсэлт илгээхэд алдаа гарлаа");
    } finally {
      setAdjSaving(false);
      setTimeout(() => setNotice(""), 3000);
    }
  };

  const clockNow = useMemo(() => {
    // Сүүлийн punch-аас "одоо ажил дээр байгаа эсэх"
    return today.last_kind === "in";
  }, [today.last_kind]);

  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="px-4 py-3 sm:px-6 sm:py-4">
      {/* Toast */}
      <AnimatePresence>
        {(err || notice) && (
          <motion.div
            initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            className={`fixed left-3 right-3 top-3 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg sm:left-auto sm:right-5 sm:max-w-sm ${
              err ? "bg-red-600 text-white" : "bg-emerald-600 text-white"
            }`}>
            {err ? <AlertCircle size={15} /> : <Check size={15} />}
            <span className="flex-1">{err || notice}</span>
            <button onClick={() => { setErr(""); setNotice(""); }}><X size={14} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-sm">
          <Clock size={22} />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">Цаг бүртгэл</h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">{nickname || username} · Ажлын WiFi-д холбогдсон үед бүртгэнэ</p>
        </div>
      </div>

      {/* Punch buttons */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:max-w-md">
        <button
          onClick={() => doPunch("in")}
          disabled={punching}
          className={`flex flex-col items-center justify-center gap-1.5 rounded-2xl py-6 text-white shadow-sm transition-all active:scale-95 disabled:opacity-60 ${
            !clockNow ? "bg-emerald-600 hover:bg-emerald-700 ring-2 ring-emerald-300" : "bg-emerald-500/70 hover:bg-emerald-600"
          }`}>
          <LogIn size={26} />
          <span className="text-base font-bold">Ирлээ</span>
        </button>
        <button
          onClick={() => doPunch("out")}
          disabled={punching}
          className={`flex flex-col items-center justify-center gap-1.5 rounded-2xl py-6 text-white shadow-sm transition-all active:scale-95 disabled:opacity-60 ${
            clockNow ? "bg-rose-600 hover:bg-rose-700 ring-2 ring-rose-300" : "bg-rose-500/70 hover:bg-rose-600"
          }`}>
          <LogOut size={26} />
          <span className="text-base font-bold">Явлаа</span>
        </button>
      </div>

      {/* Today's punches */}
      <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:max-w-md">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-gray-700">
          <Clock size={14} className="text-blue-500" /> Өнөөдрийн бүртгэл
        </div>
        {today.punches.length === 0 ? (
          <p className="py-2 text-[12px] text-gray-400">Өнөөдөр бүртгэл алга</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {today.punches.map((p) => (
              <span key={p.id} className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-medium ring-1 ${
                p.kind === "in" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-rose-50 text-rose-700 ring-rose-200"
              }`}>
                {p.kind === "in" ? <LogIn size={12} /> : <LogOut size={12} />}
                {hm(p.punch_at)}
                {p.source === "makeup" && <span className="text-[9px] opacity-70">(нөхөн)</span>}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* My history */}
      <div className="mt-5 rounded-2xl border border-gray-100 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-gray-700">
            <History size={15} className="text-gray-400" /> Миний түүх
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[12px] outline-none focus:border-blue-400">
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[12px] outline-none focus:border-blue-400">
              {MN_MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
            </select>
            <button onClick={() => setAdjOpen(true)}
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-blue-700">
              <CalendarPlus size={13} /> Нөхөн бүртгүүлэх
            </button>
          </div>
        </div>

        {/* Totals */}
        {totals && (
          <div className="grid grid-cols-4 divide-x divide-gray-100 border-b border-gray-100 text-center">
            <Stat label="Ирсэн" value={totals.present} />
            <Stat label="Хоцорсон" value={totals.late} cls="text-amber-600" />
            <Stat label="Тасалсан" value={totals.absent} cls="text-rose-600" />
            <Stat label="Нийт хоцролт" value={`${totals.late_minutes}м`} cls="text-gray-700" />
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          {loadingHist ? (
            <div className="flex items-center justify-center py-10 text-gray-400">
              <RefreshCw size={15} className="mr-2 animate-spin" /> Ачааллаж байна…
            </div>
          ) : days.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-gray-400">Энэ сард бүртгэл алга</p>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="bg-gray-50 text-left text-[10.5px] font-bold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-3 py-2.5">Огноо</th>
                  <th className="px-3 py-2.5">Гараг</th>
                  <th className="px-3 py-2.5 text-center">Ирсэн</th>
                  <th className="px-3 py-2.5 text-center">Явсан</th>
                  <th className="px-3 py-2.5 text-right">Хоцролт</th>
                  <th className="px-3 py-2.5 text-right">Ажилласан</th>
                  <th className="px-3 py-2.5 text-center">Төлөв</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {days.slice().reverse().map((d) => {
                  const pill = STATUS_PILL[d.status] ?? STATUS_PILL.off;
                  return (
                    <tr key={d.date} className="hover:bg-gray-50/60">
                      <td className="px-3 py-2 font-mono text-gray-600">{d.date.slice(5)}</td>
                      <td className="px-3 py-2 text-gray-500">{d.weekday}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-emerald-700">{d.first_in || "—"}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-rose-700">{d.last_out || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700">{d.late_minutes ? `${d.late_minutes}м` : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmtWorked(d.worked_minutes)}</td>
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

      {/* My adjustment requests */}
      {myAdj.length > 0 && (
        <div className="mt-5 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
          <div className="mb-2 text-[13px] font-semibold text-gray-700">Нөхөн бүртгэлийн хүсэлтүүд</div>
          <div className="space-y-2">
            {myAdj.map((a) => {
              const st = a.status === "approved"
                ? { label: "Зөвшөөрсөн", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" }
                : a.status === "rejected"
                ? { label: "Татгалзсан", cls: "bg-rose-50 text-rose-700 ring-rose-200" }
                : { label: "Хүлээгдэж буй", cls: "bg-amber-50 text-amber-700 ring-amber-200" };
              return (
                <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-100 px-3 py-2 text-[12px]">
                  <span className="font-mono font-semibold text-gray-700">{a.target_date}</span>
                  <span className="text-gray-500">
                    {a.requested_in && `Ирсэн ${a.requested_in}`}
                    {a.requested_in && a.requested_out && " · "}
                    {a.requested_out && `Явсан ${a.requested_out}`}
                  </span>
                  {a.reason && <span className="text-gray-400 italic">— {a.reason}</span>}
                  <span className={`ml-auto inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ${st.cls}`}>{st.label}</span>
                  {a.response_note && <span className="w-full text-[11px] text-gray-400">Хариу: {a.response_note}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Adjustment modal */}
      <AnimatePresence>
        {adjOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
            onClick={() => setAdjOpen(false)}>
            <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-t-3xl bg-white p-6 shadow-2xl sm:rounded-2xl">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-bold text-gray-900">Нөхөн бүртгүүлэх хүсэлт</h2>
                <button onClick={() => setAdjOpen(false)} className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-gray-100"><X size={16} /></button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Огноо</label>
                  <input type="date" value={adjForm.target_date}
                    onChange={(e) => setAdjForm((f) => ({ ...f, target_date: e.target.value }))}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Ирсэн цаг</label>
                    <input type="time" value={adjForm.requested_in}
                      onChange={(e) => setAdjForm((f) => ({ ...f, requested_in: e.target.value }))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Явсан цаг</label>
                    <input type="time" value={adjForm.requested_out}
                      onChange={(e) => setAdjForm((f) => ({ ...f, requested_out: e.target.value }))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Шалтгаан</label>
                  <textarea value={adjForm.reason} rows={2}
                    onChange={(e) => setAdjForm((f) => ({ ...f, reason: e.target.value }))}
                    placeholder="Жишээ: Утас унтарсан, бүртгэж амжаагүй"
                    className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
                </div>
                <button onClick={submitAdj} disabled={adjSaving}
                  className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                  {adjSaving ? "Илгээж байна…" : "Хүсэлт илгээх"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Stat({ label, value, cls = "text-gray-900" }: { label: string; value: any; cls?: string }) {
  return (
    <div className="py-2.5">
      <div className={`text-lg font-bold tabular-nums ${cls}`}>{value}</div>
      <div className="text-[10px] text-gray-400">{label}</div>
    </div>
  );
}
