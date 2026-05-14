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
  Settings,
  Save,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";

// ── Color palette ─────────────────────────────────────────────────────────────
// Админ шинэ label үүсгэхэд сонгох боломжтой Tailwind өнгөний гэр бүлүүд.
type ColorKey = "orange" | "blue" | "violet" | "emerald" | "indigo" | "pink" | "amber" | "gray" | "red" | "teal" | "sky" | "rose" | "lime" | "cyan" | "fuchsia";

const COLOR_MAP: Record<string, { chip: string; dot: string; bg: string; preview: string }> = {
  orange:  { chip: "bg-orange-100 text-orange-700 border-orange-200",     dot: "bg-orange-400",  bg: "bg-orange-50",  preview: "bg-orange-400"  },
  blue:    { chip: "bg-blue-100 text-blue-700 border-blue-200",           dot: "bg-blue-400",    bg: "bg-blue-50",    preview: "bg-blue-400"    },
  violet:  { chip: "bg-violet-100 text-violet-700 border-violet-200",     dot: "bg-violet-400",  bg: "bg-violet-50",  preview: "bg-violet-400"  },
  emerald: { chip: "bg-emerald-100 text-emerald-700 border-emerald-200",  dot: "bg-emerald-400", bg: "bg-emerald-50", preview: "bg-emerald-400" },
  indigo:  { chip: "bg-indigo-100 text-indigo-700 border-indigo-200",     dot: "bg-indigo-400",  bg: "bg-indigo-50",  preview: "bg-indigo-400"  },
  pink:    { chip: "bg-pink-100 text-pink-700 border-pink-200",           dot: "bg-pink-400",    bg: "bg-pink-50",    preview: "bg-pink-400"    },
  amber:   { chip: "bg-amber-100 text-amber-700 border-amber-200",        dot: "bg-amber-400",   bg: "bg-amber-50",   preview: "bg-amber-400"   },
  gray:    { chip: "bg-gray-100 text-gray-600 border-gray-200",           dot: "bg-gray-400",    bg: "bg-gray-50",    preview: "bg-gray-400"    },
  red:     { chip: "bg-red-100 text-red-700 border-red-200",              dot: "bg-red-400",     bg: "bg-red-50",     preview: "bg-red-400"     },
  teal:    { chip: "bg-teal-100 text-teal-700 border-teal-200",           dot: "bg-teal-400",    bg: "bg-teal-50",    preview: "bg-teal-400"    },
  sky:     { chip: "bg-sky-100 text-sky-700 border-sky-200",              dot: "bg-sky-400",     bg: "bg-sky-50",     preview: "bg-sky-400"     },
  rose:    { chip: "bg-rose-100 text-rose-700 border-rose-200",           dot: "bg-rose-400",    bg: "bg-rose-50",    preview: "bg-rose-400"    },
  lime:    { chip: "bg-lime-100 text-lime-700 border-lime-200",           dot: "bg-lime-400",    bg: "bg-lime-50",    preview: "bg-lime-400"    },
  cyan:    { chip: "bg-cyan-100 text-cyan-700 border-cyan-200",           dot: "bg-cyan-400",    bg: "bg-cyan-50",    preview: "bg-cyan-400"    },
  fuchsia: { chip: "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200",  dot: "bg-fuchsia-400", bg: "bg-fuchsia-50", preview: "bg-fuchsia-400" },
};

const COLOR_KEYS: ColorKey[] = ["orange","blue","violet","emerald","indigo","pink","amber","gray","red","teal","sky","rose","lime","cyan","fuchsia"];

// Icon registry — label тохируулахад сонгох боломжтой Lucide icon-ууд
const ICON_MAP: Record<string, React.ElementType> = {
  Truck, ClipboardList, Package, Banknote, BarChart2, Users, Send, MoreHorizontal,
  CalendarDays, StickyNote, Plus, Settings, Check, Save,
};
const ICON_KEYS = Object.keys(ICON_MAP);

// ── Task type config (fetched from server) ────────────────────────────────────

type LabelDef = {
  id: number;
  key: string;
  label: string;
  short: string;
  color: string;  // COLOR_MAP key
  icon: string;   // ICON_MAP key
  sort_order: number;
  is_active: boolean;
};

function taskStyle(color: string) {
  return COLOR_MAP[color] ?? COLOR_MAP.gray;
}
function taskIcon(icon: string): React.ElementType {
  return ICON_MAP[icon] ?? MoreHorizontal;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type CalEvent = {
  id: number;
  date: string;
  task_type: string;
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
  const [selType,  setSelType]  = useState<string>("unloading");
  const [notes,    setNotes]    = useState("");
  const [saving,   setSaving]   = useState(false);

  // Dynamic labels fetched from server
  const [labels, setLabels] = useState<LabelDef[]>([]);
  const [showLabelManager, setShowLabelManager] = useState(false);

  // 2026-05: Label-аар шүүх — олон сонголт боломжтой. Хоосон = бүгд.
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const toggleFilter = (key: string) => setActiveFilters(prev => {
    const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s;
  });
  const clearFilters = () => setActiveFilters(new Set());

  // Active labels (shown in UI); TASK_MAP — бүх label (event render-т fallback хэрэгтэй)
  const activeLabels = labels.filter(l => l.is_active).sort((a,b) => a.sort_order - b.sort_order);
  const TASK_MAP: Record<string, LabelDef> = Object.fromEntries(labels.map(l => [l.key, l]));

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

  // Load labels once
  const loadLabels = async () => {
    try {
      const r = await api.get("/calendar/labels");
      setLabels(r.data);
      // Default selType → first active
      const active = (r.data as LabelDef[]).filter(l => l.is_active);
      if (active.length > 0) setSelType(prev => active.some(a => a.key === prev) ? prev : active[0].key);
    } catch { setLabels([]); }
  };
  useEffect(() => { loadLabels(); }, []);

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

  // 2026-05: Label шүүлтүүрээр шүүгдсэн events. activeFilters хоосон үед бүгд.
  const filteredEvents = activeFilters.size > 0
    ? events.filter(ev => activeFilters.has(ev.task_type))
    : events;

  const byDate: Record<string, CalEvent[]> = {};
  for (const ev of filteredEvents) { (byDate[ev.date] ??= []).push(ev); }

  const todayISO = toISO(today.getFullYear(), today.getMonth()+1, today.getDate());
  const selEvents = selectedDate ? (byDate[selectedDate] ?? []) : [];

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 overflow-x-hidden lg:flex-row lg:items-start lg:gap-6">

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

        {/* Legend — task types (clickable filters) */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5 px-0.5">
          {activeLabels.map(t => {
            const s = taskStyle(t.color);
            const Icon = taskIcon(t.icon);
            const isOn  = activeFilters.has(t.key);
            const dimmed = activeFilters.size > 0 && !isOn;
            const ringColor = s.dot.replace("bg-", "ring-");
            return (
              <button key={t.key}
                onClick={() => toggleFilter(t.key)}
                title={isOn ? "Шүүлтүүрээс хасах" : "Зөвхөн энэ label-ыг харах"}
                className={[
                  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all cursor-pointer",
                  s.chip,
                  isOn ? `ring-2 ring-offset-1 ${ringColor} shadow-sm` : "",
                  dimmed ? "opacity-40 hover:opacity-70" : "hover:shadow-sm",
                ].join(" ")}
              >
                <Icon size={11}/>
                {t.label}
                {isOn && <X size={10} className="ml-0.5 -mr-0.5"/>}
              </button>
            );
          })}
          {activeFilters.size > 0 && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
              title="Бүх шүүлтүүрийг арилгах"
            >
              <X size={11}/>
              Цэвэрлэх
            </button>
          )}
          {role === "admin" && (
            <button
              onClick={() => setShowLabelManager(true)}
              className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
              title="Label засах/нэмэх"
            >
              <Settings size={11}/>
              Label засах
            </button>
          )}
        </div>
        {/* Filter status banner */}
        {activeFilters.size > 0 && (
          <div className="mb-2 flex items-center gap-2 rounded-apple bg-amber-50/60 border border-amber-100 px-3 py-1.5 text-[11px] text-amber-800">
            <span className="font-semibold">
              {activeFilters.size === 1 ? "1 label-аар шүүгдсэн" : `${activeFilters.size} label-аар шүүгдсэн`}
            </span>
            <span className="text-amber-700/80">
              · {filteredEvents.length}/{events.length} ажил харагдаж байна
            </span>
          </div>
        )}

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
                          const t = TASK_MAP[ev.task_type];
                          const dot = taskStyle(t?.color ?? "gray").dot;
                          return (
                            <span key={ev.id}
                              className={`h-2 w-2 rounded-full ${ev.is_done ? "bg-gray-200" : dot}`}/>
                          );
                        })}
                        {dayEvs.length > 4 && (
                          <span className="text-[9px] leading-none text-gray-400">+{dayEvs.length-4}</span>
                        )}
                      </div>

                      {/* Desktop: full text chips — auto-height, no truncation */}
                      <div className="hidden flex-col gap-0.5 sm:flex">
                        {pending.map(ev => {
                          const t = TASK_MAP[ev.task_type];
                          const s = taskStyle(t?.color ?? "gray");
                          const Icon = taskIcon(t?.icon ?? "MoreHorizontal");
                          const shortName = t?.short || t?.label || ev.task_type;
                          return (
                            <span key={ev.id}
                              className={`flex items-start gap-0.5 rounded border px-1 py-0.5 text-[10px] font-medium leading-snug ${s.chip}`}>
                              <Icon size={9} className="mt-[1px] shrink-0"/>
                              <span className="break-words">
                                {shortName}{ev.notes ? ` (${ev.notes})` : ""}
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

        {/* Month summary — type breakdown (filter-aware) */}
        {filteredEvents.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {activeLabels.filter(t => filteredEvents.some(e => e.task_type === t.key)).map(t => {
              const count = filteredEvents.filter(e => e.task_type === t.key).length;
              const doneC = filteredEvents.filter(e => e.task_type === t.key && e.is_done).length;
              const s = taskStyle(t.color);
              const Icon = taskIcon(t.icon);
              const isOn = activeFilters.has(t.key);
              const dimmed = activeFilters.size > 0 && !isOn;
              return (
                <button key={t.key}
                  onClick={() => toggleFilter(t.key)}
                  className={`flex items-center gap-2.5 rounded-apple border px-3 py-2.5 text-left transition-all ${s.chip} ${dimmed ? "opacity-40 hover:opacity-70" : "hover:shadow-sm"} ${isOn ? "ring-2 ring-offset-1 " + s.dot.replace("bg-","ring-") : ""}`}>
                  <Icon size={14} className="shrink-0"/>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold whitespace-nowrap">{t.label}</div>
                    <div className="text-[11px] opacity-70">{doneC}/{count} дууссан</div>
                  </div>
                </button>
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
                          const t = TASK_MAP[ev.task_type];
                          const s = taskStyle(t?.color ?? "gray");
                          const Icon = taskIcon(t?.icon ?? "MoreHorizontal");
                          return (
                            <div key={ev.id}
                              className={`flex items-start gap-2.5 py-2.5 ${ev.is_done ? "opacity-40" : ""}`}>
                              <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${s.chip}`}>
                                <Icon size={12}/>
                              </span>
                              <div className="min-w-0 flex-1">
                                <span className={`text-sm font-semibold ${ev.is_done ? "line-through text-gray-400" : "text-gray-800"}`}>
                                  {t?.label ?? ev.task_type}
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
                  const t = TASK_MAP[ev.task_type];
                  const s = taskStyle(t?.color ?? "gray");
                  const Icon = taskIcon(t?.icon ?? "MoreHorizontal");
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
                        <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-xs font-semibold ${s.chip}`}>
                          <Icon size={11}/>
                          {t?.label ?? ev.task_type}
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
                        {activeLabels.map(t => {
                          const s = taskStyle(t.color);
                          const Icon = taskIcon(t.icon);
                          return (
                            <button key={t.key} onClick={() => setSelType(t.key)}
                              className={[
                                "flex items-center gap-2 rounded-apple border px-3 py-2.5 text-left text-xs font-semibold transition-all",
                                selType === t.key
                                  ? `${s.chip} ring-2 ring-offset-1 ${s.dot.replace("bg-","ring-")}`
                                  : "border-gray-100 bg-gray-50 text-gray-600 hover:bg-gray-100",
                              ].join(" ")}>
                              <Icon size={13} className="shrink-0"/>
                              <span className="break-words leading-tight">{t.label}</span>
                            </button>
                          );
                        })}
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
                        <button onClick={() => { setShowForm(false); setNotes(""); setSelType(activeLabels[0]?.key ?? "unloading"); }}
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
                  <button onClick={() => {
                    // Шүүлтүүртэй үед шинэ event-ийн default type-ыг шүүж буй label-аар
                    if (activeFilters.size === 1) {
                      setSelType([...activeFilters][0]);
                    } else if (activeFilters.size > 1 && !activeFilters.has(selType)) {
                      setSelType([...activeFilters][0]);
                    }
                    setShowForm(true);
                  }}
                    className="flex w-full items-center justify-center gap-2 rounded-apple border border-dashed border-gray-200 py-2.5 text-sm text-gray-500 hover:border-[#0071E3] hover:text-[#0071E3] transition-colors">
                    <Plus size={15}/>
                    Ажил нэмэх
                    {activeFilters.size === 1 && (
                      <span className="text-[10px] text-gray-400">
                        ({TASK_MAP[[...activeFilters][0]]?.label})
                      </span>
                    )}
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

      {/* ════════════════ Label Manager (admin) ════════════════ */}
      {showLabelManager && role === "admin" && (
        <LabelManager
          labels={labels}
          onClose={() => setShowLabelManager(false)}
          onChanged={loadLabels}
        />
      )}
    </div>
  );
}

// ── Label Manager Modal ──────────────────────────────────────────────────────

function LabelManager({ labels, onClose, onChanged }: {
  labels: LabelDef[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<LabelDef[]>(labels);
  const [saving, setSaving] = useState(false);
  const [newForm, setNewForm] = useState<{ label: string; short: string; color: string; icon: string }>({
    label: "", short: "", color: "blue", icon: "ClipboardList",
  });

  useEffect(() => { setItems(labels); }, [labels]);

  const updateItem = async (id: number, patch: Partial<LabelDef>) => {
    setSaving(true);
    try {
      await api.patch(`/calendar/labels/${id}`, patch);
      await onChanged();
    } finally { setSaving(false); }
  };

  const deleteItem = async (id: number, used: boolean) => {
    const msg = used
      ? "Энэ label ажил дээр ашиглагдсан. Идэвхгүй болгох уу?"
      : "Устгахдаа итгэлтэй байна уу?";
    if (!confirm(msg)) return;
    setSaving(true);
    try {
      await api.delete(`/calendar/labels/${id}`);
      await onChanged();
    } finally { setSaving(false); }
  };

  const createItem = async () => {
    if (!newForm.label.trim()) return;
    setSaving(true);
    try {
      await api.post("/calendar/labels", newForm);
      setNewForm({ label: "", short: "", color: "blue", icon: "ClipboardList" });
      await onChanged();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-[#0071E3]"/>
            <h2 className="text-base font-semibold text-gray-900">Label тохиргоо</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
            <X size={16}/>
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            {items.map(lb => {
              const s = taskStyle(lb.color);
              const Icon = taskIcon(lb.icon);
              return (
                <div key={lb.id} className={`rounded-lg border p-3 ${lb.is_active ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50 opacity-70"}`}>
                  <div className="flex items-start gap-3">
                    <span className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${s.chip}`}>
                      <Icon size={14}/>
                    </span>
                    <div className="flex-1 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          value={lb.label}
                          onChange={e => setItems(prev => prev.map(x => x.id === lb.id ? { ...x, label: e.target.value } : x))}
                          onBlur={e => e.target.value !== labels.find(l => l.id === lb.id)?.label && updateItem(lb.id, { label: e.target.value })}
                          placeholder="Бүтэн нэр"
                          className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                        />
                        <input
                          value={lb.short || ""}
                          onChange={e => setItems(prev => prev.map(x => x.id === lb.id ? { ...x, short: e.target.value } : x))}
                          onBlur={e => e.target.value !== (labels.find(l => l.id === lb.id)?.short || "") && updateItem(lb.id, { short: e.target.value })}
                          placeholder="Товч нэр"
                          className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                        />
                      </div>
                      {/* Color picker */}
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-[10px] text-gray-400 mr-1">Өнгө:</span>
                        {COLOR_KEYS.map(c => (
                          <button key={c}
                            onClick={() => updateItem(lb.id, { color: c })}
                            className={`h-5 w-5 rounded-full border-2 transition-transform ${COLOR_MAP[c].preview} ${lb.color === c ? "scale-110 border-gray-800" : "border-white"}`}
                            title={c}
                          />
                        ))}
                      </div>
                      {/* Icon picker */}
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-[10px] text-gray-400 mr-1">Икон:</span>
                        {ICON_KEYS.map(ic => {
                          const I = ICON_MAP[ic];
                          return (
                            <button key={ic}
                              onClick={() => updateItem(lb.id, { icon: ic })}
                              className={`rounded p-1 transition-colors ${lb.icon === ic ? "bg-[#0071E3] text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                              title={ic}
                            >
                              <I size={12}/>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <button
                        onClick={() => updateItem(lb.id, { is_active: !lb.is_active })}
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold ${lb.is_active ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}
                      >
                        {lb.is_active ? "Идэвхтэй" : "Идэвхгүй"}
                      </button>
                      <button
                        onClick={() => deleteItem(lb.id, false)}
                        className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500"
                        title="Устгах"
                      >
                        <Trash2 size={13}/>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add new form */}
          <div className="mt-4 rounded-lg border border-dashed border-[#0071E3]/30 bg-blue-50/30 p-3">
            <div className="mb-2 text-xs font-semibold text-gray-700">Шинэ label нэмэх</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={newForm.label}
                onChange={e => setNewForm({ ...newForm, label: e.target.value })}
                placeholder="Бүтэн нэр"
                className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
              />
              <input
                value={newForm.short}
                onChange={e => setNewForm({ ...newForm, short: e.target.value })}
                placeholder="Товч нэр (заавал биш)"
                className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-gray-400 mr-1">Өнгө:</span>
              {COLOR_KEYS.map(c => (
                <button key={c}
                  onClick={() => setNewForm({ ...newForm, color: c })}
                  className={`h-5 w-5 rounded-full border-2 ${COLOR_MAP[c].preview} ${newForm.color === c ? "scale-110 border-gray-800" : "border-white"}`}
                  title={c}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-gray-400 mr-1">Икон:</span>
              {ICON_KEYS.map(ic => {
                const I = ICON_MAP[ic];
                return (
                  <button key={ic}
                    onClick={() => setNewForm({ ...newForm, icon: ic })}
                    className={`rounded p-1 ${newForm.icon === ic ? "bg-[#0071E3] text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                    title={ic}
                  >
                    <I size={12}/>
                  </button>
                );
              })}
            </div>
            <button
              onClick={createItem}
              disabled={!newForm.label.trim() || saving}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#005BB5] disabled:opacity-50"
            >
              {saving ? <Loader2 size={12} className="animate-spin"/> : <Plus size={12}/>}
              Нэмэх
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-6 py-3 text-right">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Хаах
          </button>
        </div>
      </div>
    </div>
  );
}
