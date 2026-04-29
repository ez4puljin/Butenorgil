import { useEffect, useRef, useState, useCallback } from "react";
import {
  ChevronLeft, ChevronRight, Upload, Trash2, Settings,
  CalendarDays, X, Check, AlertCircle, RefreshCw,
  Landmark, Star, StarOff, Plus, Pencil, ArrowLeft,
  Eye, EyeOff, CreditCard, Building2, Search,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ──────────────────────────────────────────────────────────────────

interface Statement {
  id: number;
  account_number: string;
  currency: string;
  date_from: string | null;
  date_to: string | null;
  filename: string;
  uploaded_at: string;
  txn_count: number;
  fee_count: number;
  total_credit: number;
  total_debit: number;
  filled_count: number;
}

interface Txn {
  id: number;
  txn_date: string | null;
  debit: number;
  credit: number;
  bank_description: string;
  bank_counterpart: string;
  is_fee: boolean;
  partner_name: string;
  partner_account: string;
  custom_description: string;
  action: string;
}

interface AccountConfig {
  id: number;
  account_number: string;
  partner_name: string;
  bank_name: string;
  is_fee_default: boolean;
  note: string;
  sort_order: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const MN_MONTHS = ["1-р сар","2-р сар","3-р сар","4-р сар","5-р сар","6-р сар",
                   "7-р сар","8-р сар","9-р сар","10-р сар","11-р сар","12-р сар"];
const MN_WEEKDAYS = ["Да","Мя","Лх","Пү","Ба","Бя","Ня"];

function fmtMnt(n: number) {
  if (!n) return "—";
  return n.toLocaleString("mn-MN");
}
function fmtDate(s: string | null) {
  if (!s) return "—";
  return s.replace("T", " ").slice(0, 16);
}
function pad2(n: number) { return String(n).padStart(2, "0"); }
function toDateStr(y: number, m: number, d: number) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function daysInMonth(y: number, m: number) {
  return new Date(y, m, 0).getDate();
}
function firstDayOfWeek(y: number, m: number) {
  // 0=Mon...6=Sun
  return (new Date(y, m - 1, 1).getDay() + 6) % 7;
}
function todayStr() {
  const t = new Date();
  return toDateStr(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

// ── EditCell ────────────────────────────────────────────────────────────────

function EditCell({ value, placeholder, onSave }: {
  value: string; placeholder: string; onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  function commit() {
    setEditing(false);
    if (draft !== value) onSave(draft);
  }
  if (editing) {
    return (
      <input ref={ref} value={draft} placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        className="w-full rounded border border-blue-400 bg-white px-1.5 py-0.5 text-[11px] outline-none ring-2 ring-blue-200"
      />
    );
  }
  return (
    <div onClick={() => setEditing(true)} title="Засах"
      className={`cursor-pointer min-h-[22px] rounded px-1.5 py-0.5 text-[11px] hover:bg-blue-50 hover:text-blue-700 ${
        value ? "text-gray-800" : "text-gray-300 italic"
      }`}>
      {value || placeholder}
    </div>
  );
}

// ── ActionSelect ────────────────────────────────────────────────────────────

function ActionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const cls: Record<string, string> = {
    close:  "bg-red-50 text-red-700 border-red-200",
    create: "bg-green-50 text-green-700 border-green-200",
    "":     "bg-gray-50 text-gray-400 border-gray-200",
  };
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className={`rounded border px-1.5 py-0.5 text-[11px] font-medium outline-none focus:ring-2 focus:ring-blue-200 cursor-pointer ${cls[value] ?? cls[""]}`}>
      <option value="">—</option>
      <option value="close">Хаах</option>
      <option value="create">Үүсгэх</option>
    </select>
  );
}

// ── PartnerSearch — харилцагч хайх autocomplete ────────────────────────────

interface Customer {
  code: string;
  name: string;
  group: string;
  phone: string;
  account: string;
}

function PartnerSearch({ value, onSave }: {
  value: string;
  onSave: (name: string, account: string) => void;
}) {
  const [query,   setQuery]   = useState(value);
  const [results, setResults] = useState<Customer[]>([]);
  const [open,    setOpen]    = useState(false);
  const focused = useRef(false);

  useEffect(() => { setQuery(value); }, [value]);

  // Шууд хайлт — debounce байхгүй, cache дээр тулгуурладаг
  async function search(q: string) {
    try {
      const r = await api.get("/bank-statements/customers/search", { params: { q } });
      setResults(r.data);
      if (focused.current) setOpen(r.data.length > 0);
    } catch { /* silent */ }
  }

  function handleChange(v: string) {
    setQuery(v);
    search(v);
  }

  function handleFocus() {
    focused.current = true;
    // Хоосон бол анхны 40 харилцагчийг харуулна
    if (results.length > 0) { setOpen(true); return; }
    search(query);
  }

  function select(c: Customer) {
    setQuery(c.name);
    setOpen(false);
    onSave(c.name, c.account || "");
  }

  function handleBlur() {
    focused.current = false;
    // onMouseDown-ы дараа blur ирдэг тул 150ms хүлээнэ
    setTimeout(() => {
      setOpen(false);
      if (query.trim() !== value.trim()) onSave(query.trim(), "");
    }, 150);
  }

  return (
    <div className="relative">
      <input
        value={query}
        onChange={e => handleChange(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="Хайх…"
        className="w-full min-w-[120px] rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[11px] text-gray-800 outline-none hover:border-gray-200 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 placeholder:text-gray-300"
      />

      {open && results.length > 0 && (
        <div className="absolute left-0 top-full z-[60] mt-0.5 max-h-60 w-72 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl">
          {results.map((c, i) => (
            <button
              key={c.code || i}
              onMouseDown={() => select(c)}
              className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-blue-50 first:rounded-t-xl last:rounded-b-xl"
            >
              <span className="text-[12px] font-medium text-gray-900 leading-snug">{c.name}</span>
              <span className="text-[10px] text-gray-400 leading-tight">
                {[c.code, c.group, c.phone].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


// ── Main ───────────────────────────────────────────────────────────────────

export default function BankStatementPage() {
  const today = todayStr();
  const now = new Date();

  // Tabs
  const [tab, setTab] = useState<"calendar" | "settings">("calendar");

  // Calendar nav
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [calData, setCalData] = useState<Record<string, number>>({});

  // Selected day → statements
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayStmts,     setDayStmts]     = useState<Statement[]>([]);
  const [loadingDay,   setLoadingDay]   = useState(false);

  // Open statement → transactions
  const [openStmt,   setOpenStmt]   = useState<Statement | null>(null);
  const [txns,       setTxns]       = useState<Txn[]>([]);
  const [loadingTxn, setLoadingTxn] = useState(false);
  const [showFees,   setShowFees]   = useState(false);

  // Upload
  const fileRef  = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Settings
  const [accounts,    setAccounts]    = useState<AccountConfig[]>([]);
  const [editAcct,    setEditAcct]    = useState<AccountConfig | null>(null); // null=new, obj=edit
  const [acctFormOpen, setAcctFormOpen] = useState(false);
  const [acctForm, setAcctForm] = useState<Omit<AccountConfig, "id">>({
    account_number: "", partner_name: "", bank_name: "Хаанбанк",
    is_fee_default: false, note: "", sort_order: 0,
  });

  const [err, setErr] = useState("");

  // ── Load calendar ──────────────────────────────────────────────────

  async function loadCalendar(y = year, m = month) {
    try {
      const r = await api.get("/bank-statements/calendar", { params: { year: y, month: m } });
      setCalData(r.data);
    } catch { /* silent */ }
  }

  useEffect(() => { loadCalendar(year, month); }, [year, month]);

  // Хуучин өгөгдлийн нэг удаагийн засвар (сөрөг дебит + .0 данс)
  useEffect(() => {
    api.post("/bank-statements/fix-legacy-data").catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigate months ────────────────────────────────────────────────

  function prevMonth() {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
    setSelectedDate(null); setDayStmts([]); setOpenStmt(null);
  }
  function nextMonth() {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
    setSelectedDate(null); setDayStmts([]); setOpenStmt(null);
  }

  // ── Select day ─────────────────────────────────────────────────────

  async function selectDay(dateStr: string) {
    setSelectedDate(dateStr);
    setOpenStmt(null);
    setDayStmts([]);
    setLoadingDay(true);
    try {
      const r = await api.get("/bank-statements/by-date", { params: { date: dateStr } });
      setDayStmts(r.data);
    } catch { setErr("Хуулга ачааллах амжилтгүй"); }
    finally { setLoadingDay(false); }
  }

  // ── Open statement ─────────────────────────────────────────────────

  async function openStatement(stmt: Statement) {
    setOpenStmt(stmt);
    setTxns([]);
    setLoadingTxn(true);
    try {
      const r = await api.get(`/bank-statements/${stmt.id}`);
      setTxns(r.data.transactions ?? []);
    } catch { setErr("Гүйлгээ ачааллах амжилтгүй"); }
    finally { setLoadingTxn(false); }
  }

  // ── Upload ─────────────────────────────────────────────────────────

  async function uploadFiles(files: FileList | null) {
    if (!files || !files.length) return;
    setUploading(true); setErr("");
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        await api.post("/bank-statements/upload", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      } catch (e: any) {
        setErr(`${f.name}: ${e?.response?.data?.detail ?? "алдаа"}`);
      }
    }
    await loadCalendar(year, month);
    if (selectedDate) selectDay(selectedDate);
    setUploading(false);
  }

  // ── Update transaction ─────────────────────────────────────────────

  async function updateTxn(txnId: number, patch: Partial<Txn>) {
    if (!openStmt) return;
    try {
      const r = await api.patch(`/bank-statements/${openStmt.id}/transactions/${txnId}`, patch);
      setTxns(prev => prev.map(t => t.id === txnId ? { ...t, ...r.data } : t));
    } catch { setErr("Хадгалах амжилтгүй"); }
  }

  // ── Delete statement ───────────────────────────────────────────────

  async function deleteStmt(id: number) {
    if (!confirm("Энэ хуулгыг устгах уу?")) return;
    try {
      await api.delete(`/bank-statements/${id}`);
      if (openStmt?.id === id) setOpenStmt(null);
      setDayStmts(prev => prev.filter(s => s.id !== id));
      loadCalendar(year, month);
    } catch { setErr("Устгах амжилтгүй"); }
  }

  // ── Settings ───────────────────────────────────────────────────────

  async function loadAccounts() {
    try {
      const r = await api.get("/bank-statements/config/accounts");
      setAccounts(r.data);
    } catch { /* silent */ }
  }
  useEffect(() => { if (tab === "settings") loadAccounts(); }, [tab]);

  function openAcctForm(acct?: AccountConfig) {
    if (acct) {
      setEditAcct(acct);
      setAcctForm({ account_number: acct.account_number, partner_name: acct.partner_name,
        bank_name: acct.bank_name, is_fee_default: acct.is_fee_default, note: acct.note, sort_order: acct.sort_order });
    } else {
      setEditAcct(null);
      setAcctForm({ account_number: "", partner_name: "", bank_name: "Хаанбанк", is_fee_default: false, note: "", sort_order: 0 });
    }
    setAcctFormOpen(true);
  }

  async function saveAcct() {
    try {
      if (editAcct) {
        await api.patch(`/bank-statements/config/accounts/${editAcct.id}`, acctForm);
      } else {
        await api.post("/bank-statements/config/accounts", acctForm);
      }
      setAcctFormOpen(false);
      loadAccounts();
    } catch { setErr("Хадгалах амжилтгүй"); }
  }

  async function deleteAcct(id: number) {
    if (!confirm("Устгах уу?")) return;
    try {
      await api.delete(`/bank-statements/config/accounts/${id}`);
      loadAccounts();
    } catch { setErr("Устгах амжилтгүй"); }
  }

  // ── Derived ────────────────────────────────────────────────────────

  const visibleTxns = showFees ? txns.filter(t => t.is_fee) : txns.filter(t => !t.is_fee);
  const mainTxns    = txns.filter(t => !t.is_fee);
  const totalCredit = mainTxns.reduce((s, t) => s + t.credit, 0);
  const totalDebit  = mainTxns.reduce((s, t) => s + t.debit,  0);
  const filledCount = mainTxns.filter(t => t.partner_name || t.action).length;

  // Calendar grid
  const firstDow  = firstDayOfWeek(year, month);
  const daysCount = daysInMonth(year, month);
  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysCount }, (_, i) => i + 1),
  ];

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-5rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-white shadow-sm lg:h-[calc(100vh-2.5rem)]">

      {/* ── Top tabs ──────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1 border-b border-gray-100 px-4 pt-3 pb-0">
        <Landmark size={15} className="mr-1 text-blue-500 shrink-0" />
        <span className="mr-3 text-sm font-bold text-gray-900">Тооцоо хаах</span>
        {(["calendar", "settings"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 rounded-t-xl border-b-2 px-4 py-2 text-[12px] font-semibold transition-colors ${
              tab === t
                ? "border-[#0071E3] text-[#0071E3]"
                : "border-transparent text-gray-400 hover:text-gray-700"
            }`}>
            {t === "calendar" ? <><CalendarDays size={13}/>Календар</> : <><Settings size={13}/>Тохиргоо</>}
          </button>
        ))}

        {/* Upload button */}
        {tab === "calendar" && (
          <div className="ml-auto pb-1.5">
            <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple className="hidden"
              onChange={e => uploadFiles(e.target.files)} />
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-60">
              {uploading ? <><RefreshCw size={11} className="animate-spin"/>Оруулж байна…</> : <><Upload size={11}/>Файл оруулах</>}
            </button>
          </div>
        )}
      </div>

      {/* Error banner */}
      {err && (
        <div className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          <AlertCircle size={13} className="shrink-0"/>
          {err}
          <button onClick={() => setErr("")} className="ml-auto"><X size={12}/></button>
        </div>
      )}

      {/* ══ CALENDAR TAB ════════════════════════════════════════════ */}
      {tab === "calendar" && (
        <div className="flex min-h-0 flex-1 overflow-hidden">

          {/* ── Calendar widget (left) ───────────────────────────── */}
          <div className="flex w-[260px] shrink-0 flex-col border-r border-gray-100 p-4">
            {/* Month nav */}
            <div className="mb-3 flex items-center justify-between">
              <button onClick={prevMonth}
                className="grid h-7 w-7 place-items-center rounded-lg text-gray-400 hover:bg-gray-100">
                <ChevronLeft size={15}/>
              </button>
              <span className="text-[13px] font-bold text-gray-800">
                {year} · {MN_MONTHS[month - 1]}
              </span>
              <button onClick={nextMonth}
                className="grid h-7 w-7 place-items-center rounded-lg text-gray-400 hover:bg-gray-100">
                <ChevronRight size={15}/>
              </button>
            </div>

            {/* Weekday headers */}
            <div className="mb-1 grid grid-cols-7 text-center">
              {MN_WEEKDAYS.map(d => (
                <div key={d} className="text-[10px] font-semibold text-gray-400">{d}</div>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7 gap-y-0.5">
              {cells.map((day, idx) => {
                if (!day) return <div key={`e${idx}`} />;
                const ds = toDateStr(year, month, day);
                const cnt = calData[ds] ?? 0;
                const isToday    = ds === today;
                const isSelected = ds === selectedDate;
                return (
                  <button key={ds} onClick={() => selectDay(ds)}
                    className={`relative flex h-8 w-full flex-col items-center justify-center rounded-lg text-[12px] font-medium transition-colors ${
                      isSelected ? "bg-[#0071E3] text-white"
                      : isToday  ? "bg-blue-50 text-[#0071E3]"
                      : cnt > 0  ? "hover:bg-blue-50 text-gray-800"
                      : "text-gray-400 hover:bg-gray-50"
                    }`}>
                    {day}
                    {cnt > 0 && (
                      <span className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 flex h-3.5 min-w-[14px] items-center justify-center rounded-full px-0.5 text-[8px] font-bold ${
                        isSelected ? "bg-white/30 text-white" : "bg-[#0071E3] text-white"
                      }`}>{cnt}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Legend */}
            <div className="mt-auto pt-4 text-[10px] text-gray-400 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#0071E3] text-[8px] font-bold text-white">2</span>
                хуулгын тоо
              </div>
              {Object.keys(calData).length > 0 && (
                <p className="text-[10px] text-gray-300">
                  {Object.values(calData).reduce((a, b) => a + b, 0)} хуулга оруулсан
                </p>
              )}
            </div>
          </div>

          {/* ── Day detail / Statement list (middle) ─────────────── */}
          <div className={`flex flex-col overflow-hidden transition-all duration-200 ${
            openStmt ? "w-[240px] shrink-0 border-r border-gray-100" : "flex-1"
          }`}>
            {!selectedDate ? (
              /* No day selected */
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-gray-400">
                <CalendarDays size={32} className="opacity-30"/>
                <p className="text-[13px]">Өдрөө сонгоно уу</p>
              </div>
            ) : (
              <>
                {/* Day header */}
                <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 px-4 py-3">
                  <div className="flex-1">
                    <p className="text-[13px] font-bold text-gray-900">
                      {selectedDate.slice(0, 10)}
                    </p>
                    <p className="text-[11px] text-gray-400">{dayStmts.length} хуулга</p>
                  </div>
                </div>

                {/* Statement cards */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {loadingDay && (
                    <div className="flex items-center justify-center py-8 text-gray-400">
                      <RefreshCw size={14} className="animate-spin mr-2"/>Ачааллаж байна…
                    </div>
                  )}
                  {!loadingDay && dayStmts.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-8 text-gray-400">
                      <p className="text-[12px]">Хуулга байхгүй</p>
                    </div>
                  )}
                  {dayStmts.map(s => {
                    const pct = s.txn_count > 0 ? Math.round((s.filled_count / s.txn_count) * 100) : 0;
                    const isOpen = openStmt?.id === s.id;
                    return (
                      <div key={s.id}
                        onClick={() => openStatement(s)}
                        className={`group relative cursor-pointer rounded-xl border p-3 transition-all ${
                          isOpen
                            ? "border-[#0071E3] bg-blue-50"
                            : "border-gray-100 hover:border-blue-200 hover:bg-gray-50"
                        }`}>
                        {/* Delete */}
                        <button
                          onClick={e => { e.stopPropagation(); deleteStmt(s.id); }}
                          className="absolute right-2 top-2 hidden rounded p-1 group-hover:flex text-gray-400 hover:bg-red-50 hover:text-red-500">
                          <Trash2 size={11}/>
                        </button>

                        <div className="flex items-center gap-1.5 mb-1">
                          <CreditCard size={12} className={isOpen ? "text-[#0071E3]" : "text-gray-400"}/>
                          <span className={`text-[12px] font-bold ${isOpen ? "text-[#0071E3]" : "text-gray-800"}`}>
                            {s.account_number}
                          </span>
                          <span className="ml-auto text-[10px] text-gray-400 font-mono">{s.currency}</span>
                        </div>
                        <div className="flex gap-3 text-[11px] mb-2">
                          <span className="text-green-600 font-medium">↓{fmtMnt(s.total_credit)}</span>
                          {s.total_debit > 0 && <span className="text-red-500 font-medium">↑{fmtMnt(s.total_debit)}</span>}
                          <span className="ml-auto text-gray-400">{s.txn_count}ш</span>
                        </div>
                        {/* Progress */}
                        <div className="h-1 rounded-full bg-gray-100">
                          <div className={`h-1 rounded-full ${isOpen ? "bg-[#0071E3]" : "bg-gray-300"}`}
                            style={{ width: `${pct}%` }}/>
                        </div>
                        <p className="mt-0.5 text-[10px] text-gray-400">{s.filled_count}/{s.txn_count} бөглөсөн</p>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* ── Transaction table (right, appears when stmt open) ─── */}
          {openStmt && (
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {/* Stmt header */}
              <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 px-4 py-2.5">
                <button onClick={() => setOpenStmt(null)}
                  className="grid h-7 w-7 place-items-center rounded-lg text-gray-400 hover:bg-gray-100">
                  <ArrowLeft size={14}/>
                </button>
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-bold text-gray-900">{openStmt.account_number}</span>
                  <span className="ml-2 text-[11px] text-gray-400">{openStmt.date_from?.slice(0,10)} – {openStmt.date_to?.slice(0,10)}</span>
                </div>
                {/* Stats */}
                <div className="hidden sm:flex items-center gap-4 text-[12px]">
                  <div className="text-center">
                    <div className="font-bold text-green-600">{fmtMnt(totalCredit)}</div>
                    <div className="text-gray-400 text-[10px]">Кредит</div>
                  </div>
                  <div className="text-center">
                    <div className="font-bold text-red-600">{fmtMnt(totalDebit)}</div>
                    <div className="text-gray-400 text-[10px]">Дебит</div>
                  </div>
                  <div className="text-center">
                    <div className="font-bold text-gray-700">{filledCount}/{mainTxns.length}</div>
                    <div className="text-gray-400 text-[10px]">Бөглөсөн</div>
                  </div>
                </div>
                {/* Fee toggle */}
                <button onClick={() => setShowFees(v => !v)}
                  className={`flex items-center gap-1 rounded-xl border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                    showFees ? "border-amber-200 bg-amber-50 text-amber-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"
                  }`}>
                  {showFees ? <><Eye size={11}/>Зөвхөн шимтгэл харуулах</> : <><EyeOff size={11}/>Шимтгэл нуусан</>}
                </button>
              </div>

              {/* Table */}
              {loadingTxn ? (
                <div className="flex flex-1 items-center justify-center text-gray-400">
                  <RefreshCw size={15} className="animate-spin mr-2"/>Ачааллаж байна…
                </div>
              ) : (
                <div className="flex-1 overflow-auto">
                  <table className="w-full min-w-[860px] border-collapse text-[12px]">
                    <thead className="sticky top-0 z-10 bg-gray-50">
                      <tr>
                        <th className="w-7 border-b border-gray-100 px-2 py-2 text-center text-[11px] font-semibold text-gray-400">#</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-gray-500 whitespace-nowrap">Огноо</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-right text-[11px] font-semibold text-green-600 whitespace-nowrap">Кредит ₮</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-right text-[11px] font-semibold text-red-500 whitespace-nowrap">Дебит ₮</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-gray-500">Банкны утга</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-gray-500 whitespace-nowrap">Харьцсан данс</th>
                        <th className="border-b border-l border-gray-200 px-2 py-2 text-left text-[11px] font-semibold text-blue-600 whitespace-nowrap">Харилцагч</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-blue-600 whitespace-nowrap">Данс</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-blue-600">Тайлбар</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-center text-[11px] font-semibold text-blue-600">Үйлдэл</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTxns.map((t, i) => {
                        const rowBg = t.is_fee
                          ? "bg-gray-50/40 opacity-55"
                          : t.credit > 0
                            ? "hover:bg-green-50/30"
                            : "hover:bg-red-50/20";
                        return (
                          <tr key={t.id} className={`border-b border-gray-50 transition-colors ${rowBg}`}>
                            <td className="px-2 py-1.5 text-center text-[10px] text-gray-300">{i + 1}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap text-[11px] text-gray-500">{fmtDate(t.txn_date)}</td>
                            <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                              {t.credit > 0 ? <span className="text-green-600">{t.credit.toLocaleString("mn-MN")}</span> : "—"}
                            </td>
                            <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                              {t.debit > 0 ? <span className="text-red-500">{t.debit.toLocaleString("mn-MN")}</span> : "—"}
                            </td>
                            <td className="px-2 py-1.5 min-w-[200px]">
                              <div className="text-gray-600 break-words">{t.bank_description || "—"}</div>
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap font-mono text-[11px] text-gray-500">{t.bank_counterpart || "—"}</td>
                            <td className="border-l border-gray-200 px-1 py-1.5 min-w-[140px]">
                              <PartnerSearch
                                value={t.partner_name}
                                onSave={(name, account) => {
                                  const patch: Partial<Txn> = { partner_name: name };
                                  if (account && !t.partner_account) patch.partner_account = account;
                                  updateTxn(t.id, patch);
                                }}
                              />
                            </td>
                            <td className="px-1 py-1.5 min-w-[90px]">
                              <EditCell value={t.partner_account} placeholder="Данс…"
                                onSave={v => updateTxn(t.id, { partner_account: v })}/>
                            </td>
                            <td className="px-1 py-1.5 min-w-[130px]">
                              <EditCell value={t.custom_description} placeholder="Тайлбар…"
                                onSave={v => updateTxn(t.id, { custom_description: v })}/>
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <ActionSelect value={t.action} onChange={v => updateTxn(t.id, { action: v })}/>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {visibleTxns.length === 0 && (
                    <div className="flex flex-col items-center py-12 text-gray-400">
                      <Check size={28} className="mb-2 text-green-400"/>
                      <p className="text-[12px]">Гүйлгээ байхгүй</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══ SETTINGS TAB ════════════════════════════════════════════ */}
      {tab === "settings" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4">

            {/* Header */}
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-[14px] font-bold text-gray-900">Хадгалсан данс / харилцагч</h2>
                <p className="text-[11px] text-gray-400">Гүйлгээ бүрт хурдан бөглөхэд ашиглана</p>
              </div>
              <button onClick={() => openAcctForm()}
                className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-3 py-2 text-[12px] font-semibold text-white shadow-sm">
                <Plus size={13}/> Нэмэх
              </button>
            </div>

            {/* Account list */}
            <div className="space-y-2">
              {accounts.length === 0 && (
                <div className="rounded-2xl border-2 border-dashed border-gray-200 py-10 text-center text-[12px] text-gray-400">
                  Данс нэмэгдээгүй байна
                </div>
              )}
              {accounts.map(a => (
                <div key={a.id}
                  className={`flex items-start gap-3 rounded-2xl border p-4 ${
                    a.is_fee_default ? "border-amber-200 bg-amber-50/50" : "border-gray-100 bg-white"
                  }`}>
                  <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    a.is_fee_default ? "bg-amber-100" : "bg-blue-50"
                  }`}>
                    <Building2 size={16} className={a.is_fee_default ? "text-amber-600" : "text-blue-500"}/>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-bold text-gray-900">{a.partner_name || "—"}</span>
                      {a.is_fee_default && (
                        <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                          <Star size={9} className="fill-amber-500 text-amber-500"/> Шимтгэл хаах данс
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] text-gray-500 font-mono">{a.account_number || "—"}</p>
                    <p className="text-[11px] text-gray-400">{a.bank_name}{a.note ? ` · ${a.note}` : ""}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => openAcctForm(a)}
                      className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-blue-50 hover:text-blue-600">
                      <Pencil size={13}/>
                    </button>
                    <button onClick={() => deleteAcct(a.id)}
                      className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500">
                      <Trash2 size={13}/>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Account form modal ─────────────────────────────────────── */}
      {acctFormOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-md rounded-t-3xl bg-white p-6 shadow-2xl sm:rounded-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[15px] font-bold text-gray-900">
                {editAcct ? "Данс засах" : "Данс нэмэх"}
              </h3>
              <button onClick={() => setAcctFormOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-gray-100">
                <X size={16}/>
              </button>
            </div>

            <div className="space-y-3">
              {/* Partner name */}
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">Харилцагчийн нэр</label>
                <input value={acctForm.partner_name}
                  onChange={e => setAcctForm(f => ({ ...f, partner_name: e.target.value }))}
                  placeholder="ХХК нэр..."
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-[13px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>
              </div>
              {/* Account number */}
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">Дансны дугаар</label>
                <input value={acctForm.account_number}
                  onChange={e => setAcctForm(f => ({ ...f, account_number: e.target.value }))}
                  placeholder="5890526699"
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-[13px] font-mono outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>
              </div>
              {/* Bank name */}
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">Банкны нэр</label>
                <input value={acctForm.bank_name}
                  onChange={e => setAcctForm(f => ({ ...f, bank_name: e.target.value }))}
                  placeholder="Хаанбанк"
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-[13px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>
              </div>
              {/* Note */}
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">Тэмдэглэл</label>
                <input value={acctForm.note}
                  onChange={e => setAcctForm(f => ({ ...f, note: e.target.value }))}
                  placeholder="Нэмэлт тайлбар…"
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-[13px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>
              </div>
              {/* Fee default toggle */}
              <button
                onClick={() => setAcctForm(f => ({ ...f, is_fee_default: !f.is_fee_default }))}
                className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-[13px] font-medium transition-colors ${
                  acctForm.is_fee_default
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}>
                {acctForm.is_fee_default
                  ? <Star size={15} className="fill-amber-500 text-amber-500 shrink-0"/>
                  : <StarOff size={15} className="shrink-0 text-gray-400"/>}
                <div className="text-left">
                  <div>Шимтгэл хаах данс</div>
                  <div className="text-[11px] font-normal text-gray-400">Зөвхөн нэг данс шимтгэлийн анхдагч байж болно</div>
                </div>
              </button>
            </div>

            <div className="mt-5 flex gap-2">
              <button onClick={() => setAcctFormOpen(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-[13px] font-semibold text-gray-600 hover:bg-gray-50">
                Болих
              </button>
              <button onClick={saveAcct}
                className="flex-1 rounded-xl bg-[#0071E3] py-2.5 text-[13px] font-semibold text-white hover:bg-blue-600">
                Хадгалах
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
