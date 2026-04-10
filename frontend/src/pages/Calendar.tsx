import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  X,
  Check,
  Trash2,
  CalendarDays,
  Loader2,
  Truck,
  ClipboardList,
  Package,
  Banknote,
  BarChart2,
  Users,
  Send,
  MoreHorizontal,
  StickyNote,
  Plus,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";

// ── Task type config ───────────────────────────────────────────────────────────

type TaskKey =
  | "unloading" | "order" | "inventory" | "payment"
  | "report" | "meeting" | "shipment" | "other";

type TaskTypeDef = {
  key: TaskKey;
  label: string;
  short: string;
  icon: React.ElementType;
  chip: string;   // Tailwind classes for chip
  dot: string;    // dot color
  bg: string;     // light bg for day cell chip
};

const TASK_TYPES: TaskTypeDef[] = [
  { key: "unloading", label: "Ачилт буух",    short: "Ачилт",    icon: Truck,        chip: "bg-orange-100 text-orange-700 border-orange-200", dot: "bg-orange-400", bg: "bg-orange-50"  },
  { key: "order",     label: "Захиалга хийх", short: "Захиалга", icon: ClipboardList, chip: "bg-blue-100 text-blue-700 border-blue-200",       dot: "bg-blue-400",   bg: "bg-blue-50"    },
  { key: "inventory", label: "Тооллого хийх", short: "Тооллого", icon: Package,       chip: "bg-violet-100 text-violet-700 border-violet-200", dot: "bg-violet-400", bg: "bg-violet-50"  },
  { key: "payment",   label: "Төлбөр хийх",   short: "Төлбөр",   icon: Banknote,      chip: "bg-emerald-100 text-emerald-700 border-emerald-200", dot: "bg-emerald-400", bg: "bg-emerald-50" },
  { key: "report",    label: "Тайлан гаргах", short: "Тайлан",   icon: BarChart2,     chip: "bg-indigo-100 text-indigo-700 border-indigo-200", dot: "bg-indigo-400", bg: "bg-indigo-50"  },
  { key: "meeting",   label: "Уулзалт",       short: "Уулзалт",  icon: Users,         chip: "bg-pink-100 text-pink-700 border-pink-200",       dot: "bg-pink-400",   bg: "bg-pink-50"    },
  { key: "shipment",  label: "Ачаа явуулах",  short: "Ачаа",     icon: Send,          chip: "bg-amber-100 text-amber-700 border-amber-200",    dot: "bg-amber-400",  bg: "bg-amber-50"   },
  { key: "other",     label: "Бусад",         short: "Бусад",    icon: MoreHorizontal, chip: "bg-gray-100 text-gray-600 border-gray-200",      dot: "bg-gray-400",   bg: "bg-gray-50"    },
];

const TASK_MAP = Object.fromEntries(TASK_TYPES.map(t => [t.key, t])) as Record<TaskKey, TaskTypeDef>;

// ── Types ──────────────────────────────────────────────────────────────────────

type CalEvent = {
  id: number;
  date: string;
  task_type: TaskKey;
  notes: string;
  is_done: boolean;
  created_by_user_id: number;
  created_by_username: string;
};

// ── Calendar helpers ───────────────────────────────────────────────────────────

const MN_WEEKDAYS = ["Да", "Мя", "Лх", "Пү", "Ба", "Бя", "Ня"];
const MN_MONTHS = [
  "1-р сар","2-р сар","3-р сар","4-р сар","5-р сар","6-р сар",
  "7-р сар","8-р сар","9-р сар","10-р сар","11-р сар","12-р сар",
];

function toISO(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}
function daysInMonth(y: number, m: number) { return new Date(y, m, 0).getDate(); }
function weekdayOf(y: number, m: number, d: number) {
  return (new Date(y, m - 1, d).getDay() + 6) % 7; // Mon=0
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const today = new Date();
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selType,  setSelType]  = useState<TaskKey>("unloading");
  const [notes,    setNotes]    = useState("");
  const [saving,   setSaving]   = useState(false);

  const notesRef = useRef<HTMLTextAreaElement>(null);
  const userId = useAuthStore(s => s.userId);
  const role   = useAuthStore(s => s.role);

  // ── Load ────────────────────────────────────────────────────────────────────

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/calendar/events", { params: { year, month } });
      setEvents(r.data);
    } catch { setEvents([]); }
    finally  { setLoading(false); }
  };

  useEffect(() => { load(); }, [year, month]);

  // ── Nav ─────────────────────────────────────────────────────────────────────

  const prev = () => { if (month===1) { setYear(y=>y-1); setMonth(12); } else setMonth(m=>m-1); setSelectedDate(null); };
  const next = () => { if (month===12){ setYear(y=>y+1); setMonth(1);  } else setMonth(m=>m+1); setSelectedDate(null); };
  const goToday = () => {
    setYear(today.getFullYear()); setMonth(today.getMonth()+1);
    setSelectedDate(toISO(today.getFullYear(), today.getMonth()+1, today.getDate()));
  };

  // ── CRUD ────────────────────────────────────────────────────────────────────

  const addEvent = async () => {
    if (!selectedDate) return;
    setSaving(true);
    try {
      const r = await api.post("/calendar/events", { date: selectedDate, task_type: selType, notes });
      setEvents(ev => [...ev, r.data]);
      setNotes(""); setShowForm(false);
    } finally { setSaving(false); }
  };

  const toggleDone = async (ev: CalEvent) => {
    const r = await api.patch(`/calendar/events/${ev.id}`, { is_done: !ev.is_done });
    setEvents(evs => evs.map(e => e.id===ev.id ? r.data : e));
  };

  const remove = async (id: number) => {
    await api.delete(`/calendar/events/${id}`);
    setEvents(evs => evs.filter(e => e.id!==id));
  };

  // ── Grid data ────────────────────────────────────────────────────────────────

  const totalDays = daysInMonth(year, month);
  const startWd   = weekdayOf(year, month, 1);
  const cells: (number|null)[] = [...Array(startWd).fill(null), ...Array.from({length:totalDays},(_,i)=>i+1)];
  while (cells.length % 7 !== 0) cells.push(null);

  const byDate: Record<string, CalEvent[]> = {};
  for (const ev of events) { (byDate[ev.date] ??= []).push(ev); }

  const todayISO = toISO(today.getFullYear(), today.getMonth()+1, today.getDate());
  const selEvents = selectedDate ? (byDate[selectedDate] ?? []) : [];

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">

      {/* ════════════════ Calendar panel ════════════════ */}
      <div className="min-w-0 flex-1">

        {/* Page header */}
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900 sm:text-2xl">Календар</h1>
            <p className="text-xs text-gray-400">Өдөр дарж ажлын төлөвлөгөө нэмнэ</p>
          </div>
          <button onClick={goToday}
            className="rounded-apple border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50">
            Өнөөдөр
          </button>
        </div>

        {/* Month nav */}
        <div className="mb-2 flex items-center gap-2 rounded-apple bg-white px-4 py-3 shadow-sm">
          <button onClick={prev} className="rounded-apple p-1.5 text-gray-500 hover:bg-gray-100"><ChevronLeft size={18}/></button>
          <div className="flex-1 text-center text-base font-semibold text-gray-900">
            {year} оны {MN_MONTHS[month-1]}
          </div>
          <button onClick={next} className="rounded-apple p-1.5 text-gray-500 hover:bg-gray-100"><ChevronRight size={18}/></button>
          {loading && <Loader2 size={13} className="animate-spin text-gray-300"/>}
        </div>

        {/* Legend — task types */}
        <div className="mb-2 flex flex-wrap gap-1.5 px-0.5">
          {TASK_TYPES.map(t => (
            <span key={t.key}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${t.chip}`}>
              <t.icon size={11}/>
              {t.label}
            </span>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="overflow-hidden rounded-apple bg-white shadow-sm">
          {/* Weekday headers */}
          <div className="grid grid-cols-7 border-b border-gray-100">
            {MN_WEEKDAYS.map(d => (
              <div key={d} className="py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-400">{d}</div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7">
            {cells.map((day, i) => {
              const iso      = day ? toISO(year, month, day) : null;
              const dayEvs   = iso ? (byDate[iso] ?? []) : [];
              const isToday  = iso === todayISO;
              const isSel    = iso === selectedDate;
              const isSun    = i % 7 === 6;
              const pending  = dayEvs.filter(e => !e.is_done);
              const done     = dayEvs.filter(e => e.is_done);

              return (
                <div key={i}
                  onClick={() => { if (iso) { setSelectedDate(iso); setShowForm(false); }}}
                  className={[
                    // Mobile: compact dot-only cells. Desktop: auto-height chip cells.
                    "relative flex flex-col gap-0.5 p-1 transition-colors",
                    "min-h-[48px] sm:min-h-[28px] sm:p-1.5",
                    i % 7 !== 6 ? "border-r border-gray-100" : "",
                    Math.floor(i/7) > 0 ? "border-t border-gray-100" : "",
                    day ? "cursor-pointer" : "",
                    isSel ? "bg-blue-50/70" : isToday ? "bg-blue-50/30" : "",
                    day && !isSel ? "hover:bg-gray-50" : "",
                  ].join(" ")}
                >
                  {day && (
                    <>
                      {/* Day number */}
                      <div className="flex items-start justify-end">
                        <span className={[
                          "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold sm:h-7 sm:w-7 sm:text-sm",
                          isToday ? "bg-[#0071E3] text-white" : isSun ? "text-red-400" : "text-gray-700",
                        ].join(" ")}>
                          {day}
                        </span>
                      </div>

                      {/* Mobile: dots only (schedule list below grid is the readable view) */}
                      <div className="flex flex-wrap gap-0.5 sm:hidden">
                        {dayEvs.slice(0, 4).map(ev => {
                          const t = TASK_MAP[ev.task_type] ?? TASK_MAP.other;
                          return (
                            <span key={ev.id}
                              className={`h-2 w-2 rounded-full ${ev.is_done ? "bg-gray-200" : t.dot}`}/>
                          );
                        })}
                        {dayEvs.length > 4 && (
                          <span className="text-[9px] leading-none text-gray-400">+{dayEvs.length-4}</span>
                        )}
                      </div>

                      {/* Desktop: full text chips — auto-height, no truncation */}
                      <div className="hidden flex-col gap-0.5 sm:flex">
                        {pending.map(ev => {
                          const t = TASK_MAP[ev.task_type] ?? TASK_MAP.other;
                          return (
                            <span key={ev.id}
                              className={`flex items-start gap-0.5 rounded border px-1 py-0.5 text-[10px] font-medium leading-snug ${t.chip}`}>
                              <t.icon size={9} className="mt-[1px] shrink-0"/>
                              <span className="break-words">
                                {t.short}{ev.notes ? ` (${ev.notes})` : ""}
                              </span>
                            </span>
                          );
                        })}
                        {done.length > 0 && (
                          <span className="pl-0.5 text-[9px] text-gray-300 line-through">
                            {done.length > 1 ? `${done.length} дууссан` : "дууссан"}
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Month summary — type breakdown */}
        {events.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {TASK_TYPES.filter(t => events.some(e => e.task_type === t.key)).map(t => {
              const count = events.filter(e => e.task_type === t.key).length;
              const doneC = events.filter(e => e.task_type === t.key && e.is_done).length;
              return (
                <div key={t.key} className={`flex items-center gap-2.5 rounded-apple border px-3 py-2.5 ${t.chip}`}>
                  <t.icon size={14} className="shrink-0"/>
                  <div>
                    <div className="text-xs font-semibold">{t.label}</div>
                    <div className="text-[11px] opacity-70">{doneC}/{count} дууссан</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Mobile schedule list (hidden on sm+) ──────────────────────────── */}
        {events.length > 0 && (
          <div className="mt-4 sm:hidden">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {MN_MONTHS[month-1]} — бүх ажил
            </h2>
            <div className="space-y-2">
              {Object.entries(byDate)
                .sort(([a],[b]) => a.localeCompare(b))
                .map(([date, dayEvs]) => {
                  const [y, m, d] = date.split("-").map(Number);
                  const wd = MN_WEEKDAYS[weekdayOf(y, m, d)];
                  const isT = date === todayISO;
                  return (
                    <div key={date}
                      onClick={() => { setSelectedDate(date); setShowForm(false); window.scrollTo({top:0, behavior:"smooth"}); }}
                      className="overflow-hidden rounded-apple bg-white shadow-sm">
                      {/* Date row */}
                      <div className={`flex items-center gap-2 px-3 py-2 ${isT ? "bg-blue-50" : "bg-gray-50"}`}>
                        <span className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${isT ? "bg-[#0071E3] text-white" : "bg-white text-gray-700 shadow-sm"}`}>
                          {d}
                        </span>
                        <span className={`text-sm font-semibold ${isT ? "text-[#0071E3]" : "text-gray-700"}`}>
                          {m}-р сарын {d} ({wd})
                          {isT && <span className="ml-1.5 text-xs font-normal text-blue-400">өнөөдөр</span>}
                        </span>
                      </div>
                      {/* Events */}
                      <div className="divide-y divide-gray-50 px-3">
                        {dayEvs.map(ev => {
                          const t = TASK_MAP[ev.task_type] ?? TASK_MAP.other;
                          return (
                            <div key={ev.id}
                              className={`flex items-start gap-2.5 py-2.5 ${ev.is_done ? "opacity-40" : ""}`}>
                              <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${t.chip}`}>
                                <t.icon size={12}/>
                              </span>
                              <div className="min-w-0 flex-1">
                                <span className={`text-sm font-semibold ${ev.is_done ? "line-through text-gray-400" : "text-gray-800"}`}>
                                  {t.label}
                                </span>
                                {ev.notes && (
                                  <p className={`mt-0.5 text-xs ${ev.is_done ? "text-gray-300 line-through" : "text-gray-500"}`}>
                                    {ev.notes}
                                  </p>
                                )}
                                <p className="mt-0.5 text-[10px] text-gray-400">{ev.created_by_username}</p>
                              </div>
                              {ev.is_done && (
                                <span className="mt-1 shrink-0">
                                  <Check size={14} className="text-emerald-500"/>
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>

      {/* ════════════════ Day panel ════════════════ */}
      <AnimatePresence>
        {selectedDate && (
          <motion.div key={selectedDate}
            initial={{ opacity:0, x:20 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0, x:20 }}
            transition={{ duration:0.15 }}
            className="w-full shrink-0 lg:w-72 xl:w-80"
          >
            <div className="overflow-hidden rounded-apple bg-white shadow-sm">

              {/* Panel header */}
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <div className="flex items-center gap-2">
                  <CalendarDays size={15} className="text-[#0071E3]"/>
                  <span className="text-sm font-semibold text-gray-900">
                    {(() => {
                      const [y,m,d] = selectedDate.split("-").map(Number);
                      return `${m}-р сарын ${d} (${MN_WEEKDAYS[weekdayOf(y,m,d)]})`;
                    })()}
                  </span>
                  {selectedDate === todayISO && (
                    <span className="rounded-full bg-[#0071E3] px-2 py-0.5 text-[10px] font-bold text-white">Өнөөдөр</span>
                  )}
                </div>
                <button onClick={() => { setSelectedDate(null); setShowForm(false); }}
                  className="rounded-apple p-1 text-gray-400 hover:bg-gray-100">
                  <X size={15}/>
                </button>
              </div>

              {/* Event list */}
              <div className="max-h-[40vh] overflow-y-auto divide-y divide-gray-50 lg:max-h-[55vh]">
                {selEvents.length === 0 && !showForm && (
                  <div className="flex flex-col items-center gap-2 py-8 text-sm text-gray-400">
                    <CalendarDays size={24} className="text-gray-200"/>
                    <span>Ажил байхгүй</span>
                  </div>
                )}

                {selEvents.map(ev => {
                  const t = TASK_MAP[ev.task_type] ?? TASK_MAP.other;
                  const canEdit = ev.created_by_user_id === userId || role==="admin" || role==="supervisor";
                  return (
                    <div key={ev.id}
                      className={`flex items-start gap-3 px-4 py-3 transition-opacity ${ev.is_done?"opacity-40":""}`}>

                      {/* Done checkbox */}
                      <button onClick={() => toggleDone(ev)}
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                          ev.is_done ? "border-emerald-500 bg-emerald-500 text-white" : "border-gray-300 hover:border-emerald-400"
                        }`}>
                        {ev.is_done && <Check size={10} strokeWidth={3}/>}
                      </button>

                      {/* Content */}
                      <div className="min-w-0 flex-1">
                        <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-semibold ${t.chip}`}>
                          <t.icon size={11}/>
                          {t.label}
                        </span>
                        {ev.notes && (
                          <p className={`mt-1 flex items-start gap-1 text-xs text-gray-500 ${ev.is_done?"line-through":""}`}>
                            <StickyNote size={10} className="mt-0.5 shrink-0 text-gray-300"/>
                            {ev.notes}
                          </p>
                        )}
                        <p className="mt-1 text-[10px] text-gray-400">{ev.created_by_username}</p>
                      </div>

                      {/* Delete */}
                      {canEdit && (
                        <button onClick={() => remove(ev.id)}
                          className="mt-0.5 shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500">
                          <Trash2 size={13}/>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* ── Add form ── */}
              <AnimatePresence>
                {showForm && (
                  <motion.div
                    initial={{ height:0, opacity:0 }} animate={{ height:"auto", opacity:1 }}
                    exit={{ height:0, opacity:0 }} className="overflow-hidden border-t border-gray-100">
                    <div className="space-y-3 p-4">

                      {/* Task type grid */}
                      <div className="grid grid-cols-2 gap-1.5">
                        {TASK_TYPES.map(t => (
                          <button key={t.key} onClick={() => setSelType(t.key)}
                            className={[
                              "flex items-center gap-2 rounded-apple border px-3 py-2.5 text-left text-xs font-semibold transition-all",
                              selType === t.key
                                ? `${t.chip} ring-2 ring-offset-1 ${t.dot.replace("bg-","ring-")}`
                                : "border-gray-100 bg-gray-50 text-gray-600 hover:bg-gray-100",
                            ].join(" ")}>
                            <t.icon size={13} className="shrink-0"/>
                            {t.label}
                          </button>
                        ))}
                      </div>

                      {/* Notes */}
                      <textarea ref={notesRef} value={notes} onChange={e=>setNotes(e.target.value)}
                        placeholder="Тэмдэглэл (заавал биш)..."
                        rows={2}
                        className="w-full resize-none rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                      />

                      {/* Actions */}
                      <div className="flex gap-2">
                        <button onClick={addEvent} disabled={saving}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-apple bg-[#0071E3] py-2 text-sm font-semibold text-white hover:bg-[#005BB5] disabled:opacity-50">
                          {saving ? <Loader2 size={14} className="animate-spin"/> : <Plus size={14}/>}
                          Нэмэх
                        </button>
                        <button onClick={() => { setShowForm(false); setNotes(""); setSelType("unloading"); }}
                          className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-50">
                          Болих
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Add button */}
              {!showForm && (
                <div className="border-t border-gray-100 p-3">
                  <button onClick={() => setShowForm(true)}
                    className="flex w-full items-center justify-center gap-2 rounded-apple border border-dashed border-gray-200 py-2.5 text-sm text-gray-500 hover:border-[#0071E3] hover:text-[#0071E3] transition-colors">
                    <Plus size={15}/>
                    Ажил нэмэх
                  </button>
                </div>
              )}
            </div>

            {/* Summary strip */}
            {selEvents.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 px-1">
                {selEvents.filter(e=>!e.is_done).length > 0 && (
                  <span className="text-xs text-amber-600 font-medium">
                    {selEvents.filter(e=>!e.is_done).length} үлдсэн
                  </span>
                )}
                {selEvents.filter(e=>e.is_done).length > 0 && (
                  <span className="text-xs text-emerald-600 font-medium">
                    {selEvents.filter(e=>e.is_done).length} дууссан
                  </span>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
