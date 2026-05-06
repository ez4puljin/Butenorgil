import { useEffect, useRef, useState, useCallback } from "react";
import {
  ChevronLeft, ChevronRight, ChevronDown, Upload, Trash2, Settings,
  CalendarDays, X, Check, AlertCircle, RefreshCw,
  Landmark, Star, StarOff, Plus, Pencil, ArrowLeft,
  Eye, EyeOff, CreditCard, Building2, Search, Download,
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
  erp_account_code: string;
  is_registered: boolean;
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
  export_type: string;   // "" | "kass" | "hariltsah"
  is_settlement: boolean;
}

interface SettlementConfigT {
  partner_name: string;
  partner_account: string;
  custom_description: string;
  action: string;
  account_code: string;
}

interface CrossAcct {
  id: number;
  code: string;
  label: string;
  sort_order: number;
}

interface FeeConfigT {
  partner_name: string;
  partner_account: string;
  custom_description: string;
  action: string;
  export_type: string;
  account_code: string;
}

interface AccountConfig {
  id: number;
  account_number: string;
  partner_name: string;
  bank_name: string;
  is_fee_default: boolean;
  erp_account_code: string;
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

// ── CrossAccountSelect — Харьцсан данс (preset + custom) ───────────────────

interface CrossPreset {
  code: string;
  label?: string;
}

function CrossAccountSelect({ value, onSave, presets }: {
  value: string;
  onSave: (v: string) => void;
  presets: CrossPreset[];
}) {
  const [open, setOpen]       = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(value);
  const containerRef          = useRef<HTMLDivElement>(null);

  useEffect(() => { setDraft(value); }, [value]);

  // Гадна талаар click хийвэл хаах
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function commit(v: string) {
    if (v !== value) onSave(v);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { commit(draft); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { commit(draft); setEditing(false); }
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        placeholder="Харьцсан данс…"
        className="w-24 rounded border border-blue-400 bg-white px-1.5 py-0.5 text-[11px] outline-none ring-2 ring-blue-200 font-mono"
      />
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button onClick={() => setOpen(!open)}
        className={`flex w-full min-w-[80px] items-center justify-between rounded px-1.5 py-0.5 text-[11px] font-mono hover:bg-blue-50 hover:text-blue-700 ${
          value ? "text-gray-800" : "text-gray-300 italic"
        }`}>
        <span className="truncate">{value || "Харьцсан данс…"}</span>
        <ChevronDown size={9} className="ml-1 shrink-0 text-gray-400" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-0.5 w-44 rounded-lg border border-gray-200 bg-white shadow-lg">
          {presets.length === 0 && (
            <div className="px-2.5 py-1.5 text-[10px] text-gray-400 italic">
              Тохиргоонд жагсаалт нэмнэ үү
            </div>
          )}
          {presets.map((p) => (
            <button key={p.code}
              onMouseDown={(e) => { e.preventDefault(); commit(p.code); setOpen(false); }}
              className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left hover:bg-blue-50 ${
                value === p.code ? "bg-blue-50 text-blue-700 font-bold" : "text-gray-700"
              }`}>
              <span className="text-[11px] font-mono">{p.code}</span>
              {p.label && <span className="text-[10px] text-gray-400 truncate ml-2">{p.label}</span>}
            </button>
          ))}
          <hr className="border-gray-100"/>
          <button
            onMouseDown={(e) => { e.preventDefault(); setEditing(true); setOpen(false); }}
            className="flex w-full items-center gap-1 px-2.5 py-1.5 text-left text-[11px] text-gray-600 hover:bg-blue-50">
            <Pencil size={10}/>Бусад…
          </button>
        </div>
      )}
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

// ── ExportTypeSelect — дебит гүйлгээний экспорт төрөл ─────────────────────

function ExportTypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const cls: Record<string, string> = {
    kass:      "bg-violet-50 text-violet-700 border-violet-200",
    hariltsah: "bg-sky-50 text-sky-700 border-sky-200",
    "":        "bg-gray-50 text-gray-400 border-gray-200",
  };
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className={`rounded border px-1.5 py-0.5 text-[11px] font-medium outline-none focus:ring-2 focus:ring-blue-200 cursor-pointer ${cls[value] ?? cls[""]}`}>
      <option value="">—</option>
      <option value="kass">Касс</option>
      <option value="hariltsah">Харилцах</option>
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

function PartnerSearch({ value, onSave, onClear }: {
  value: string;
  onSave: (name: string, account: string) => void;
  onClear?: () => void;
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

  function clear() {
    setQuery("");
    setResults([]);
    setOpen(false);
    if (onClear) onClear();
    else onSave("", "");
  }

  return (
    <div className="relative">
      <input
        value={query}
        onChange={e => handleChange(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="Хайх…"
        className="w-full min-w-[120px] rounded border border-transparent bg-transparent px-1.5 py-0.5 pr-5 text-[11px] text-gray-800 outline-none hover:border-gray-200 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 placeholder:text-gray-300"
      />

      {/* Clear button — утга байгаа үед харагдана */}
      {query && (
        <button
          onMouseDown={(e) => { e.preventDefault(); clear(); }}
          title="Цэвэрлэх"
          className="absolute right-1 top-1/2 -translate-y-1/2 grid h-4 w-4 place-items-center rounded-full text-gray-400 hover:bg-red-50 hover:text-red-500"
        >
          <X size={9}/>
        </button>
      )}

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

  // Export to Эрхэт
  const [exportOpen,  setExportOpen]  = useState(false);
  const [exportDate,  setExportDate]  = useState<string>("");
  const [exporting,   setExporting]   = useState(false);

  // Cross-account presets (Харьцсан данс жагсаалт)
  const [crossPresets, setCrossPresets] = useState<CrossAcct[]>([]);
  const [newCrossCode, setNewCrossCode] = useState("");
  const [newCrossLabel, setNewCrossLabel] = useState("");

  async function loadCrossPresets() {
    try {
      const r = await api.get("/bank-statements/config/cross-accounts");
      setCrossPresets(r.data);
    } catch { /* silent */ }
  }
  async function addCrossPreset() {
    const c = newCrossCode.trim();
    if (!c) return;
    try {
      await api.post("/bank-statements/config/cross-accounts", {
        code: c, label: newCrossLabel.trim(), sort_order: crossPresets.length,
      });
      setNewCrossCode(""); setNewCrossLabel("");
      loadCrossPresets();
    } catch { setErr("Нэмэх амжилтгүй"); }
  }
  async function updateCrossPreset(id: number, patch: Partial<CrossAcct>) {
    const target = crossPresets.find(c => c.id === id);
    if (!target) return;
    const merged = { ...target, ...patch };
    try {
      await api.patch(`/bank-statements/config/cross-accounts/${id}`, {
        code: merged.code, label: merged.label, sort_order: merged.sort_order,
      });
      loadCrossPresets();
    } catch { setErr("Хадгалах амжилтгүй"); }
  }
  async function deleteCrossPreset(id: number) {
    if (!confirm("Энэ дансыг устгах уу?")) return;
    try {
      await api.delete(`/bank-statements/config/cross-accounts/${id}`);
      loadCrossPresets();
    } catch { setErr("Устгах амжилтгүй"); }
  }

  useEffect(() => { loadCrossPresets(); }, []);

  // Settlement Config
  const [settlementCfg, setSettlementCfg] = useState<SettlementConfigT>({
    partner_name: "30000", partner_account: "", custom_description: "",
    action: "close", account_code: "120105",
  });
  const [settlementLockModal, setSettlementLockModal] = useState(false);
  const [reapplying, setReapplying] = useState(false);

  // Fee Config (шимтгэл)
  const [feeCfg, setFeeCfg] = useState<FeeConfigT>({
    partner_name: "30000", partner_account: "703012",
    custom_description: "Банкны шимтгэл", action: "close",
    export_type: "hariltsah", account_code: "",
  });
  const [feeLockModal, setFeeLockModal] = useState(false);
  const [feeReapplying, setFeeReapplying] = useState(false);

  async function loadFeeCfg() {
    try {
      const r = await api.get("/bank-statements/config/fee");
      setFeeCfg(r.data);
    } catch { /* silent */ }
  }
  async function saveFeeCfg(patch: Partial<FeeConfigT>) {
    try {
      const r = await api.patch("/bank-statements/config/fee", patch);
      setFeeCfg(r.data);
    } catch { setErr("Шимтгэл тохиргоо хадгалах амжилтгүй"); }
  }
  async function reapplyFeeCfg() {
    setFeeReapplying(true);
    try {
      const r = await api.post("/bank-statements/config/fee/reapply");
      if (openStmt) {
        const res = await api.get(`/bank-statements/${openStmt.id}`);
        setTxns(res.data.transactions ?? []);
      }
      setErr("");
      alert(`✓ ${r.data.fixed} шимтгэл мөр шинэчлэгдлээ`);
    } catch { setErr("Дахин хэрэглэх амжилтгүй"); }
    finally { setFeeReapplying(false); }
  }
  useEffect(() => { loadFeeCfg(); }, []);

  async function loadSettlementCfg() {
    try {
      const r = await api.get("/bank-statements/config/settlement");
      setSettlementCfg(r.data);
    } catch { /* silent */ }
  }
  async function saveSettlementCfg(patch: Partial<SettlementConfigT>) {
    try {
      const r = await api.patch("/bank-statements/config/settlement", patch);
      setSettlementCfg(r.data);
    } catch { setErr("Settlement тохиргоо хадгалах амжилтгүй"); }
  }
  async function reapplySettlementCfg() {
    setReapplying(true);
    try {
      const r = await api.post("/bank-statements/config/settlement/reapply");
      // Хуулга нээлттэй бол гүйлгээг дахин ачаална
      if (openStmt) {
        const res = await api.get(`/bank-statements/${openStmt.id}`);
        setTxns(res.data.transactions ?? []);
      }
      setErr("");
      alert(`✓ ${r.data.fixed} SETTLEMENT мөр шинэчлэгдлээ`);
    } catch { setErr("Дахин хэрэглэх амжилтгүй"); }
    finally { setReapplying(false); }
  }

  useEffect(() => { loadSettlementCfg(); }, []);

  // Bulk edit
  const [selectedTxns,  setSelectedTxns]  = useState<Set<number>>(new Set());
  const [bulkForm,      setBulkForm]      = useState({
    partner_name: "", partner_account: "", custom_description: "",
    action: null as string | null,       // null = өөрчлөхгүй
    export_type: null as string | null,  // null = өөрчлөхгүй
  });
  const [bulkApplying, setBulkApplying] = useState(false);

  // Settings
  const [accounts,    setAccounts]    = useState<AccountConfig[]>([]);
  const [editAcct,    setEditAcct]    = useState<AccountConfig | null>(null); // null=new, obj=edit
  const [acctFormOpen, setAcctFormOpen] = useState(false);
  const [acctForm, setAcctForm] = useState<Omit<AccountConfig, "id">>({
    account_number: "", partner_name: "", bank_name: "Хаанбанк",
    is_fee_default: false, erp_account_code: "", note: "", sort_order: 0,
  });

  // Fee export modal
  const [feeExportOpen,    setFeeExportOpen]    = useState(false);
  const [feeExportFrom,    setFeeExportFrom]    = useState("");
  const [feeExportTo,      setFeeExportTo]      = useState("");
  const [feeExportPartner, setFeeExportPartner] = useState("30000");
  const [feeExportAccount, setFeeExportAccount] = useState("703012");
  const [feeExporting,     setFeeExporting]     = useState(false);

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
      // Сонгосон огноог дамжуулна — calendar-д тэр өдөр харагдана
      if (selectedDate) fd.append("selected_date", selectedDate);
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

  // ── Export to Эрхэт ───────────────────────────────────────────────

  function openExportModal() {
    // Хуулгын date_from-оор анхдагч огноог тавина
    setExportDate(openStmt?.date_from?.slice(0, 10) ?? todayStr());
    setExportOpen(true);
  }

  async function exportErkhet() {
    if (!openStmt) return;
    setExporting(true);
    try {
      const params: Record<string, string> = {};
      if (exportDate) params.export_date = exportDate;
      const r = await api.get(`/bank-statements/${openStmt.id}/export`, {
        params,
        responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `Эрхэт_${openStmt.account_number}_${exportDate || "export"}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportOpen(false);
    } catch { setErr("Экспортлох амжилтгүй"); }
    finally { setExporting(false); }
  }

  // ── Fee export ─────────────────────────────────────────────────────

  async function exportFees() {
    setFeeExporting(true);
    try {
      const params: Record<string, string> = {
        fee_partner: feeExportPartner,
        fee_account: feeExportAccount,
      };
      if (feeExportFrom) params.date_from = feeExportFrom;
      if (feeExportTo)   params.date_to   = feeExportTo;
      const r = await api.get("/bank-statements/export/fees", {
        params,
        responseType: "blob",
      });
      const from = feeExportFrom || "all";
      const to   = feeExportTo   ? `_${feeExportTo}` : "";
      const url  = URL.createObjectURL(new Blob([r.data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `Шимтгэл_${from}${to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setFeeExportOpen(false);
    } catch (e: any) {
      // Blob response-ийн доторх алдааг текст болгож харуулна
      let detail = "Шимтгэл экспортлох амжилтгүй";
      try {
        const blob = e?.response?.data;
        if (blob instanceof Blob) {
          const txt = await blob.text();
          const j = JSON.parse(txt);
          if (j?.detail) detail = `Шимтгэл экспорт: ${j.detail}`;
        } else if (e?.response?.data?.detail) {
          detail = `Шимтгэл экспорт: ${e.response.data.detail}`;
        } else if (e?.message) {
          detail = `Шимтгэл экспорт: ${e.message}`;
        }
      } catch { /* ignore parse errors */ }
      setErr(detail);
    }
    finally { setFeeExporting(false); }
  }

  // ── Bulk edit ──────────────────────────────────────────────────────

  function toggleSelect(id: number) {
    setSelectedTxns(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAllVisible() {
    setSelectedTxns(new Set(visibleTxns.map(t => t.id)));
  }
  function clearSelection() { setSelectedTxns(new Set()); }

  async function applyBulkEdit() {
    if (selectedTxns.size === 0 || !openStmt) return;
    const patch: Record<string, string> = {};
    if (bulkForm.partner_name.trim())       patch.partner_name       = bulkForm.partner_name.trim();
    if (bulkForm.partner_account.trim())    patch.partner_account    = bulkForm.partner_account.trim();
    if (bulkForm.custom_description.trim()) patch.custom_description = bulkForm.custom_description.trim();
    if (bulkForm.action      !== null)      patch.action             = bulkForm.action;
    if (bulkForm.export_type !== null)      patch.export_type        = bulkForm.export_type;
    if (Object.keys(patch).length === 0) return;
    setBulkApplying(true);
    try {
      await Promise.all(
        [...selectedTxns].map(id =>
          api.patch(`/bank-statements/${openStmt.id}/transactions/${id}`, patch)
        )
      );
      setTxns(prev => prev.map(t => selectedTxns.has(t.id) ? { ...t, ...patch } : t));
      clearSelection();
      setBulkForm({ partner_name: "", partner_account: "", custom_description: "", action: null, export_type: null });
    } catch { setErr("Bulk засах амжилтгүй"); }
    finally { setBulkApplying(false); }
  }

  // ── Settings ───────────────────────────────────────────────────────

  async function loadAccounts() {
    try {
      const r = await api.get("/bank-statements/config/accounts");
      setAccounts(r.data);
    } catch { /* silent */ }
  }
  // Хуулга солигдоход болон fee toggle хийгдэхэд сонголтыг цэвэрлэнэ
  useEffect(() => {
    setSelectedTxns(new Set());
    setBulkForm({ partner_name: "", partner_account: "", custom_description: "", action: null, export_type: null });
  }, [openStmt?.id, showFees]);

  useEffect(() => { if (tab === "settings") loadAccounts(); }, [tab]);

  function openAcctForm(acct?: AccountConfig) {
    if (acct) {
      setEditAcct(acct);
      setAcctForm({
        account_number: acct.account_number, partner_name: acct.partner_name,
        bank_name: acct.bank_name, is_fee_default: acct.is_fee_default,
        erp_account_code: acct.erp_account_code || "",
        note: acct.note, sort_order: acct.sort_order,
      });
    } else {
      setEditAcct(null);
      setAcctForm({ account_number: "", partner_name: "", bank_name: "Хаанбанк",
        is_fee_default: false, erp_account_code: "", note: "", sort_order: 0 });
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

        {/* Hidden file input (always in DOM) */}
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple className="hidden"
          onChange={e => uploadFiles(e.target.files)} />
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
                <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-bold text-gray-900">
                      {selectedDate.slice(0, 10)}
                    </p>
                    <p className="text-[11px] text-gray-400">{dayStmts.length} хуулга</p>
                  </div>
                  {/* Fee export */}
                  <button onClick={() => {
                    setFeeExportFrom(selectedDate);
                    setFeeExportTo(selectedDate);
                    setFeeExportOpen(true);
                  }}
                    className="flex items-center gap-1 rounded-xl border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 transition-colors shrink-0">
                    <Download size={11}/>Шимтгэл
                  </button>
                  {/* Upload */}
                  <button onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="flex items-center gap-1 rounded-xl bg-[#0071E3] px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-60 shrink-0">
                    {uploading ? <><RefreshCw size={11} className="animate-spin"/>Оруулж…</> : <><Upload size={11}/>Файл</>}
                  </button>
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
                          {s.is_registered ? (
                            s.erp_account_code ? (
                              <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold font-mono text-emerald-700"
                                title={`ERP данс код: ${s.erp_account_code}`}>
                                {s.erp_account_code}
                              </span>
                            ) : (
                              <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700"
                                title="Тохиргоонд бүртгэлтэй ч ERP код хоосон">
                                ERP код ?
                              </span>
                            )
                          ) : (
                            <span className="flex items-center gap-0.5 rounded-md bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold text-rose-700"
                              title="Энэ дансыг Тохиргоо tab дотор бүртгэнэ үү">
                              <AlertCircle size={9}/>Бүртгэлгүй
                            </span>
                          )}
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
                <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-bold text-gray-900">{openStmt.account_number}</span>
                  {openStmt.is_registered ? (
                    openStmt.erp_account_code ? (
                      <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold font-mono text-emerald-700"
                        title="ERP данс код">
                        {openStmt.erp_account_code}
                      </span>
                    ) : (
                      <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">
                        ERP код ?
                      </span>
                    )
                  ) : (
                    <span className="flex items-center gap-0.5 rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                      <AlertCircle size={10}/>Бүртгэлгүй данс
                    </span>
                  )}
                  <span className="text-[11px] text-gray-400">{openStmt.date_from?.slice(0,10)} – {openStmt.date_to?.slice(0,10)}</span>
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
                {/* Export button */}
                <button onClick={openExportModal}
                  className="flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors">
                  <Download size={11}/>Эрхэт экспорт
                </button>
              </div>

              {/* ── Bulk edit bar ─────────────────────────────────── */}
              {selectedTxns.size > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-blue-100 bg-blue-50 px-3 py-1.5">
                  {/* Count badge + clear */}
                  <span className="flex items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-[11px] font-bold text-white shrink-0">
                    <Check size={9}/>{selectedTxns.size} мөр
                  </span>
                  <button onClick={clearSelection} title="Сонголтыг цуцлах"
                    className="grid h-5 w-5 place-items-center rounded text-blue-500 hover:bg-blue-100">
                    <X size={11}/>
                  </button>
                  <div className="h-4 w-px bg-blue-200 mx-0.5 shrink-0"/>

                  {/* Partner name */}
                  <input value={bulkForm.partner_name}
                    onChange={e => setBulkForm(f => ({ ...f, partner_name: e.target.value }))}
                    placeholder="Харилцагч…"
                    className="w-36 rounded border border-blue-200 bg-white px-2 py-0.5 text-[11px] outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 placeholder:text-gray-300"/>

                  {/* Partner account (Харьцсан данс) */}
                  <input value={bulkForm.partner_account}
                    onChange={e => setBulkForm(f => ({ ...f, partner_account: e.target.value }))}
                    placeholder="Харьцсан данс…"
                    className="w-32 rounded border border-blue-200 bg-white px-2 py-0.5 text-[11px] font-mono outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 placeholder:text-gray-300"/>

                  {/* Description */}
                  <input value={bulkForm.custom_description}
                    onChange={e => setBulkForm(f => ({ ...f, custom_description: e.target.value }))}
                    placeholder="Гүйлгээний утга…"
                    className="w-40 rounded border border-blue-200 bg-white px-2 py-0.5 text-[11px] outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 placeholder:text-gray-300"/>

                  {/* Action select */}
                  <select value={bulkForm.action ?? "_skip"}
                    onChange={e => setBulkForm(f => ({ ...f, action: e.target.value === "_skip" ? null : e.target.value }))}
                    className="rounded border border-blue-200 bg-white px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-blue-200 cursor-pointer text-gray-700">
                    <option value="_skip">Үйлдэл…</option>
                    <option value="">— (цэвэрлэх)</option>
                    <option value="close">Хаах</option>
                    <option value="create">Үүсгэх</option>
                  </select>

                  {/* Export type select */}
                  <select value={bulkForm.export_type ?? "_skip"}
                    onChange={e => setBulkForm(f => ({ ...f, export_type: e.target.value === "_skip" ? null : e.target.value }))}
                    className="rounded border border-blue-200 bg-white px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-blue-200 cursor-pointer text-gray-700">
                    <option value="_skip">Экспорт…</option>
                    <option value="">— (цэвэрлэх)</option>
                    <option value="kass">Касс</option>
                    <option value="hariltsah">Харилцах</option>
                  </select>

                  {/* Apply */}
                  <button onClick={applyBulkEdit} disabled={bulkApplying}
                    className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-60 shrink-0">
                    {bulkApplying
                      ? <><RefreshCw size={10} className="animate-spin"/>Хадгалж байна…</>
                      : <><Check size={10}/>Хэрэглэх</>}
                  </button>
                </div>
              )}

              {/* Table */}
              {loadingTxn ? (
                <div className="flex flex-1 items-center justify-center text-gray-400">
                  <RefreshCw size={15} className="animate-spin mr-2"/>Ачааллаж байна…
                </div>
              ) : (
                <div className="flex-1 overflow-auto">
                  <table className="w-full min-w-[1000px] border-collapse text-[12px]">
                    <thead className="sticky top-0 z-10 bg-gray-50">
                      <tr>
                        {/* Select-all checkbox */}
                        <th className="w-8 border-b border-gray-100 px-2 py-2 text-center">
                          <input type="checkbox"
                            checked={visibleTxns.length > 0 && visibleTxns.every(t => selectedTxns.has(t.id))}
                            ref={el => { if (el) el.indeterminate = selectedTxns.size > 0 && !visibleTxns.every(t => selectedTxns.has(t.id)); }}
                            onChange={e => e.target.checked ? selectAllVisible() : clearSelection()}
                            className="cursor-pointer accent-blue-600"/>
                        </th>
                        <th className="w-7 border-b border-gray-100 px-2 py-2 text-center text-[11px] font-semibold text-gray-400">#</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-gray-500 whitespace-nowrap">Огноо</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-right text-[11px] font-semibold text-green-600 whitespace-nowrap">Кредит ₮</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-right text-[11px] font-semibold text-red-500 whitespace-nowrap">Дебит ₮</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-gray-500">Банкны утга</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-gray-500 whitespace-nowrap">Банкны харьцсан данс</th>
                        <th className="border-b border-l border-gray-200 px-2 py-2 text-left text-[11px] font-semibold text-blue-600 whitespace-nowrap">Харилцагч</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-blue-600 whitespace-nowrap">Харьцсан данс</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-left text-[11px] font-semibold text-blue-600 whitespace-nowrap">Гүйлгээний утга</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-center text-[11px] font-semibold text-blue-600 whitespace-nowrap">Үйлдэл</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-center text-[11px] font-semibold text-emerald-600 whitespace-nowrap">Экспорт</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-center text-[11px] font-semibold text-emerald-600 whitespace-nowrap">Данс</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTxns.map((t, i) => {
                        const isSelected = selectedTxns.has(t.id);
                        const rowBg = isSelected
                          ? "bg-blue-50/70"
                          : t.is_fee
                            ? "bg-gray-50/40 opacity-55"
                            : t.credit > 0
                              ? "hover:bg-green-50/30"
                              : "hover:bg-red-50/20";
                        return (
                          <tr key={t.id} className={`border-b border-gray-50 transition-colors ${rowBg}`}>
                            {/* Row checkbox */}
                            <td className="px-2 py-1.5 text-center">
                              <input type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelect(t.id)}
                                className="cursor-pointer accent-blue-600"/>
                            </td>
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
                              {t.is_settlement ? (
                                <div onClick={() => setSettlementLockModal(true)}
                                  className="cursor-not-allowed rounded px-1.5 py-0.5 text-[11px] text-gray-700 hover:bg-amber-50"
                                  title="Settlement тохиргооноос засна уу">
                                  🔒 {t.partner_name || "—"}
                                </div>
                              ) : t.is_fee ? (
                                <div onClick={() => setFeeLockModal(true)}
                                  className="cursor-not-allowed rounded px-1.5 py-0.5 text-[11px] text-gray-700 hover:bg-amber-50"
                                  title="Шимтгэл тохиргооноос засна уу">
                                  🔒 {t.partner_name || "—"}
                                </div>
                              ) : (
                                <PartnerSearch
                                  value={t.partner_name}
                                  onSave={(name, account) => {
                                    const patch: Partial<Txn> = { partner_name: name };
                                    if (account && !t.partner_account) patch.partner_account = account;
                                    updateTxn(t.id, patch);
                                  }}
                                  onClear={() => updateTxn(t.id, { partner_name: "", partner_account: "" })}
                                />
                              )}
                            </td>
                            <td className="px-1 py-1.5 min-w-[110px]">
                              {(t.is_settlement || t.is_fee) ? (
                                <div onClick={() => (t.is_settlement ? setSettlementLockModal(true) : setFeeLockModal(true))}
                                  className="cursor-not-allowed rounded px-1.5 py-0.5 text-[11px] font-mono text-gray-700 hover:bg-amber-50">
                                  {t.partner_account || "—"}
                                </div>
                              ) : (
                                <CrossAccountSelect value={t.partner_account}
                                  presets={crossPresets}
                                  onSave={v => updateTxn(t.id, { partner_account: v })}/>
                              )}
                            </td>
                            <td className="px-1 py-1.5 min-w-[130px]">
                              {(t.is_settlement || t.is_fee) ? (
                                <div onClick={() => (t.is_settlement ? setSettlementLockModal(true) : setFeeLockModal(true))}
                                  className="cursor-not-allowed rounded px-1.5 py-0.5 text-[11px] text-gray-700 hover:bg-amber-50">
                                  {t.custom_description || <span className="italic text-gray-300">—</span>}
                                </div>
                              ) : (
                                <EditCell value={t.custom_description} placeholder="Гүйлгээний утга…"
                                  onSave={v => updateTxn(t.id, { custom_description: v })}/>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              {t.is_settlement ? (
                                <span onClick={() => setSettlementLockModal(true)}
                                  className="cursor-not-allowed rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700 hover:bg-amber-50">
                                  Хаах
                                </span>
                              ) : t.is_fee ? (
                                <span onClick={() => setFeeLockModal(true)}
                                  className="cursor-not-allowed rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700 hover:bg-amber-50">
                                  {t.action === "create" ? "Үүсгэх" : "Хаах"}
                                </span>
                              ) : (
                                <ActionSelect value={t.action} onChange={v => updateTxn(t.id, { action: v })}/>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              {t.is_fee ? (
                                <span onClick={() => setFeeLockModal(true)}
                                  className="cursor-not-allowed rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 hover:bg-amber-200">
                                  Шимтгэл
                                </span>
                              ) : t.debit > 0
                                ? <ExportTypeSelect value={t.export_type} onChange={v => updateTxn(t.id, { export_type: v })}/>
                                : <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[9px] font-semibold text-green-700">Авлага</span>
                              }
                            </td>
                            <td className="px-2 py-1.5 text-center whitespace-nowrap">
                              {t.credit > 0 && !t.is_fee ? (
                                <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold font-mono text-emerald-700">
                                  120105
                                </span>
                              ) : (t.debit > 0 || t.is_fee) && openStmt?.erp_account_code ? (
                                <span className="rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold font-mono text-sky-700">
                                  {openStmt.erp_account_code}
                                </span>
                              ) : (
                                <span className="text-[10px] text-gray-300">—</span>
                              )}
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
          <div className="flex-1 overflow-y-auto p-4 space-y-6">

            {/* ── Settlement хаах тохиргоо ─────────────────────────── */}
            <div className="rounded-2xl border border-amber-100 bg-amber-50/50 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-[14px] font-bold text-gray-900">
                    🔒 Settlement хаах тохиргоо
                  </h2>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    POS гүйлгээ (SETTLEMENT) илрүүлбэл доорх утгуудаар автомат бөглөгдөнө. Гүйлгээ дээр өөрчлөх боломжгүй болно.
                  </p>
                </div>
                <button onClick={reapplySettlementCfg} disabled={reapplying}
                  className="flex shrink-0 items-center gap-1 rounded-xl border border-amber-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-60">
                  {reapplying ? <><RefreshCw size={11} className="animate-spin"/>Дахин…</> : <><RefreshCw size={11}/>Бүх SETTLEMENT-д дахин хэрэглэх</>}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {/* Партнер */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Харилцагч</label>
                  <input value={settlementCfg.partner_name}
                    onChange={e => setSettlementCfg(c => ({...c, partner_name: e.target.value}))}
                    onBlur={e => saveSettlementCfg({ partner_name: e.target.value })}
                    placeholder="30000"
                    className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"/>
                </div>
                {/* Харьцсан данс */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">
                    Харьцсан данс <span className="text-[10px] font-normal text-gray-400">(хоосон бол банкны ERP код)</span>
                  </label>
                  <input value={settlementCfg.partner_account}
                    onChange={e => setSettlementCfg(c => ({...c, partner_account: e.target.value}))}
                    onBlur={e => saveSettlementCfg({ partner_account: e.target.value })}
                    placeholder="Auto: банкны ERP код"
                    className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-[13px] font-mono outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"/>
                </div>
                {/* Данс (account_code) */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Данс (Дансны код)</label>
                  <input value={settlementCfg.account_code}
                    onChange={e => setSettlementCfg(c => ({...c, account_code: e.target.value}))}
                    onBlur={e => saveSettlementCfg({ account_code: e.target.value })}
                    placeholder="120105"
                    className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-[13px] font-mono outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"/>
                </div>
                {/* Гүйлгээний утга */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">
                    Гүйлгээний утга <span className="text-[10px] font-normal text-gray-400">(араас банкны утга залгагдана)</span>
                  </label>
                  <input value={settlementCfg.custom_description}
                    onChange={e => setSettlementCfg(c => ({...c, custom_description: e.target.value}))}
                    onBlur={e => saveSettlementCfg({ custom_description: e.target.value })}
                    placeholder="Жишээ: Пос орлого"
                    className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"/>
                  <p className="mt-1 text-[10px] text-gray-400">
                    Үр дүн: <span className="font-mono">"{(settlementCfg.custom_description || "").trim() ? `${settlementCfg.custom_description.trim()} ` : ""}29/04/2026 SETTLEMENT - ORGIL BUUNII TUV"</span>
                  </p>
                </div>
                {/* Үйлдэл */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Үйлдэл</label>
                  <select value={settlementCfg.action}
                    onChange={e => { setSettlementCfg(c => ({...c, action: e.target.value})); saveSettlementCfg({ action: e.target.value }); }}
                    className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100">
                    <option value="">—</option>
                    <option value="close">Хаах</option>
                    <option value="create">Үүсгэх</option>
                  </select>
                </div>
                {/* Экспорт (info only) */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Экспорт</label>
                  <div className="rounded-lg border border-amber-200 bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-700">
                    Авлага (auto)
                  </div>
                </div>
              </div>
            </div>

            {/* ── Шимтгэл хаах тохиргоо ─────────────────────────────── */}
            <div className="rounded-2xl border border-orange-100 bg-orange-50/50 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-[14px] font-bold text-gray-900">
                    🔒 Шимтгэл хаах тохиргоо
                  </h2>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    Банкны шимтгэл (хураамж, fee) илрүүлбэл доорх утгуудаар автомат бөглөгдөнө.
                  </p>
                </div>
                <button onClick={reapplyFeeCfg} disabled={feeReapplying}
                  className="flex shrink-0 items-center gap-1 rounded-xl border border-orange-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-orange-700 hover:bg-orange-100 disabled:opacity-60">
                  {feeReapplying ? <><RefreshCw size={11} className="animate-spin"/>Дахин…</> : <><RefreshCw size={11}/>Бүх шимтгэлд дахин хэрэглэх</>}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {/* Партнер */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Харилцагч</label>
                  <input value={feeCfg.partner_name}
                    onChange={e => setFeeCfg(c => ({...c, partner_name: e.target.value}))}
                    onBlur={e => saveFeeCfg({ partner_name: e.target.value })}
                    placeholder="30000"
                    className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"/>
                </div>
                {/* Харьцсан данс */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Харьцсан данс</label>
                  <input value={feeCfg.partner_account}
                    onChange={e => setFeeCfg(c => ({...c, partner_account: e.target.value}))}
                    onBlur={e => saveFeeCfg({ partner_account: e.target.value })}
                    placeholder="703012"
                    className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-[13px] font-mono outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"/>
                </div>
                {/* Гүйлгээний утга */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Гүйлгээний утга</label>
                  <input value={feeCfg.custom_description}
                    onChange={e => setFeeCfg(c => ({...c, custom_description: e.target.value}))}
                    onBlur={e => saveFeeCfg({ custom_description: e.target.value })}
                    placeholder="Банкны шимтгэл"
                    className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"/>
                </div>
                {/* Үйлдэл */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Үйлдэл</label>
                  <select value={feeCfg.action}
                    onChange={e => { setFeeCfg(c => ({...c, action: e.target.value})); saveFeeCfg({ action: e.target.value }); }}
                    className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100">
                    <option value="">—</option>
                    <option value="close">Хаах</option>
                    <option value="create">Үүсгэх</option>
                  </select>
                </div>
                {/* Экспорт */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Экспорт</label>
                  <select value={feeCfg.export_type}
                    onChange={e => { setFeeCfg(c => ({...c, export_type: e.target.value})); saveFeeCfg({ export_type: e.target.value }); }}
                    className="w-full rounded-lg border border-orange-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100">
                    <option value="hariltsah">Харилцах</option>
                    <option value="kass">Касс</option>
                  </select>
                </div>
                {/* Данс (account_code) — info only, auto bank ERP */}
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Данс</label>
                  <div className="rounded-lg border border-orange-200 bg-sky-50 px-3 py-2 text-[13px] font-mono text-sky-700">
                    Auto: банкны ERP код
                  </div>
                </div>
              </div>
            </div>

            {/* ── Харьцсан дансны жагсаалт (preset CRUD) ───────────── */}
            <div className="rounded-2xl border border-blue-100 bg-blue-50/30 p-4">
              <div className="mb-3">
                <h2 className="text-[14px] font-bold text-gray-900">📋 Харьцсан дансны жагсаалт</h2>
                <p className="mt-0.5 text-[11px] text-gray-500">
                  Гүйлгээний "Харьцсан данс" талбарт dropdown-ээр харагдана
                </p>
              </div>

              {/* Existing list */}
              <div className="space-y-1.5 mb-3">
                {crossPresets.length === 0 && (
                  <div className="text-[11px] text-gray-400 italic py-2">Жагсаалт хоосон</div>
                )}
                {crossPresets.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-lg bg-white border border-blue-100 px-2 py-1.5">
                    <input value={p.code}
                      onChange={e => setCrossPresets(cs => cs.map(c => c.id === p.id ? { ...c, code: e.target.value } : c))}
                      onBlur={e => updateCrossPreset(p.id, { code: e.target.value })}
                      className="w-24 rounded border border-gray-200 px-2 py-1 text-[12px] font-mono outline-none focus:border-blue-400"/>
                    <input value={p.label}
                      onChange={e => setCrossPresets(cs => cs.map(c => c.id === p.id ? { ...c, label: e.target.value } : c))}
                      onBlur={e => updateCrossPreset(p.id, { label: e.target.value })}
                      placeholder="Тайлбар…"
                      className="flex-1 rounded border border-gray-200 px-2 py-1 text-[12px] outline-none focus:border-blue-400"/>
                    <button onClick={() => deleteCrossPreset(p.id)}
                      className="grid h-7 w-7 place-items-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500"
                      title="Устгах">
                      <Trash2 size={12}/>
                    </button>
                  </div>
                ))}
              </div>

              {/* Add new */}
              <div className="flex items-center gap-2 rounded-lg bg-white border border-dashed border-blue-200 px-2 py-1.5">
                <input value={newCrossCode}
                  onChange={e => setNewCrossCode(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") addCrossPreset(); }}
                  placeholder="Код"
                  className="w-24 rounded border border-gray-200 px-2 py-1 text-[12px] font-mono outline-none focus:border-blue-400"/>
                <input value={newCrossLabel}
                  onChange={e => setNewCrossLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") addCrossPreset(); }}
                  placeholder="Тайлбар (заавал биш)"
                  className="flex-1 rounded border border-gray-200 px-2 py-1 text-[12px] outline-none focus:border-blue-400"/>
                <button onClick={addCrossPreset} disabled={!newCrossCode.trim()}
                  className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                  <Plus size={11}/>Нэмэх
                </button>
              </div>
            </div>

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
                    <p className="text-[11px] text-gray-400">
                      {a.bank_name}{a.note ? ` · ${a.note}` : ""}
                      {a.erp_account_code && (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 font-mono">
                          ERP: {a.erp_account_code}
                        </span>
                      )}
                    </p>
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

      {/* ── Шимтгэл export modal ──────────────────────────────────── */}
      {feeExportOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-sm rounded-t-3xl bg-white p-6 shadow-2xl sm:rounded-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-[15px] font-bold text-gray-900">Банкны шимтгэл экспорт</h3>
                <p className="mt-0.5 text-[11px] text-gray-400">
                  Бүх хуулгын шимтгэлийг нэгтгэн Эрхэт импорт Excel болгоно
                </p>
              </div>
              <button onClick={() => setFeeExportOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-gray-100">
                <X size={16}/>
              </button>
            </div>

            <div className="space-y-3">
              {/* Date range */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Эхлэх огноо</label>
                  <input type="date" value={feeExportFrom}
                    onChange={e => setFeeExportFrom(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-[12px] outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"/>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">Дуусах огноо</label>
                  <input type="date" value={feeExportTo}
                    onChange={e => setFeeExportTo(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-[12px] outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"/>
                </div>
              </div>
              <p className="text-[10px] text-gray-400 -mt-1">Хоосон орхивол бүх хуулга хамрагдана</p>

              {/* ERP codes */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">
                    Харилцагч код
                  </label>
                  <input value={feeExportPartner}
                    onChange={e => setFeeExportPartner(e.target.value)}
                    placeholder="30000"
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-[12px] font-mono outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"/>
                  <p className="mt-0.5 text-[10px] text-gray-400">Эрхэт дахь харилцагч</p>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-gray-500">
                    Харьцсан данс
                  </label>
                  <input value={feeExportAccount}
                    onChange={e => setFeeExportAccount(e.target.value)}
                    placeholder="703012"
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-[12px] font-mono outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"/>
                  <p className="mt-0.5 text-[10px] text-gray-400">Шимтгэлийн зардлын данс</p>
                </div>
              </div>

              {/* ERP code reminder */}
              {accounts.some(a => !a.erp_account_code) && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  <span className="font-semibold">Анхааруулга:</span>{" "}
                  {accounts.filter(a => !a.erp_account_code).map(a => a.account_number || a.partner_name).join(", ")}
                  {" "}данс(ууд)-д Эрхэт код тохируулаагүй байна.{" "}
                  <button onClick={() => { setFeeExportOpen(false); setTab("settings"); }}
                    className="underline hover:text-amber-900">
                    Тохиргоо руу очих →
                  </button>
                </div>
              )}
            </div>

            <div className="mt-5 flex gap-2">
              <button onClick={() => setFeeExportOpen(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-[13px] font-semibold text-gray-600 hover:bg-gray-50">
                Болих
              </button>
              <button onClick={exportFees} disabled={feeExporting}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-amber-500 py-2.5 text-[13px] font-semibold text-white hover:bg-amber-600 disabled:opacity-60">
                {feeExporting
                  ? <><RefreshCw size={13} className="animate-spin"/>Гаргаж байна…</>
                  : <><Download size={13}/>Excel татах</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Эрхэт export modal ────────────────────────────────────── */}
      {exportOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-sm rounded-t-3xl bg-white p-6 shadow-2xl sm:rounded-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-[15px] font-bold text-gray-900">Эрхэт рүү экспортлох</h3>
                <p className="mt-0.5 text-[11px] text-gray-400">
                  {openStmt?.account_number} · {mainTxns.filter(t => t.credit > 0).length} кредит,{" "}
                  {mainTxns.filter(t => t.debit > 0 && (t.export_type === "kass" || t.export_type === "hariltsah")).length} дебит (таглагдсан)
                </p>
              </div>
              <button onClick={() => setExportOpen(false)}
                className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-gray-100">
                <X size={16}/>
              </button>
            </div>

            {/* Date picker */}
            <div className="mb-4">
              <label className="mb-1 block text-[11px] font-semibold text-gray-500">Экспортын огноо</label>
              <input
                type="date"
                value={exportDate}
                onChange={e => setExportDate(e.target.value)}
                className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-[13px] outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              />
              <p className="mt-1 text-[10px] text-gray-400">
                Excel-ийн Огноо баганад энэ огноо бичигдэнэ. Хуулгын огноотой өөр байж болно.
              </p>
            </div>

            {/* What will be exported */}
            <div className="mb-5 rounded-xl border border-gray-100 bg-gray-50 p-3 space-y-1.5 text-[11px] text-gray-600">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700 shrink-0">Авлага</span>
                <span>{mainTxns.filter(t => t.credit > 0).length} кредит гүйлгээ → <span className="font-medium">Авлага өглөгийн гүйлгээ.xlsx</span></span>
              </div>
              {mainTxns.some(t => t.debit > 0 && t.export_type === "kass") && (
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700 shrink-0">Касс</span>
                  <span>{mainTxns.filter(t => t.debit > 0 && t.export_type === "kass").length} гүйлгээ → <span className="font-medium">Кассын гүйлгээ.xlsx</span></span>
                </div>
              )}
              {mainTxns.some(t => t.debit > 0 && t.export_type === "hariltsah") && (
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700 shrink-0">Харилцах</span>
                  <span>{mainTxns.filter(t => t.debit > 0 && t.export_type === "hariltsah").length} гүйлгээ → <span className="font-medium">Харилцахын гүйлгээ.xlsx</span></span>
                </div>
              )}
              {!mainTxns.some(t => t.debit > 0 && (t.export_type === "kass" || t.export_type === "hariltsah")) && (
                <p className="text-gray-400 text-[10px]">Дебит гүйлгээнд Касс/Харилцах таг тавьж хамруулна уу</p>
              )}
            </div>

            <div className="flex gap-2">
              <button onClick={() => setExportOpen(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-[13px] font-semibold text-gray-600 hover:bg-gray-50">
                Болих
              </button>
              <button onClick={exportErkhet} disabled={exporting}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 py-2.5 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
                {exporting ? <><RefreshCw size={13} className="animate-spin"/>Экспортлож байна…</> : <><Download size={13}/>ZIP татах</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Шимтгэл lock warning modal ─────────────────────────────── */}
      {feeLockModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
            <div className="mb-3 flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-orange-100">
                <AlertCircle size={18} className="text-orange-600"/>
              </div>
              <h3 className="text-[15px] font-bold text-gray-900">Шимтгэл тохиргоо засна уу?</h3>
            </div>
            <p className="mb-4 text-[12px] text-gray-600">
              Энэ мөр банкны шимтгэл тул талбарууд автомат бөглөгдсөн ба өөрчлөх боломжгүй.
              Утгыг өөрчлөхийг хүсвэл <span className="font-semibold">Тохиргоо</span> цэснээс <span className="font-semibold">Шимтгэл хаах тохиргоо</span>-г засна уу.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setFeeLockModal(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2 text-[13px] font-semibold text-gray-600 hover:bg-gray-50">
                Болих
              </button>
              <button onClick={() => { setFeeLockModal(false); setTab("settings"); }}
                className="flex-1 rounded-xl bg-orange-600 py-2 text-[13px] font-semibold text-white hover:bg-orange-700">
                Тохиргоо засах
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Settlement lock warning modal ──────────────────────────── */}
      {settlementLockModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
            <div className="mb-3 flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-amber-100">
                <AlertCircle size={18} className="text-amber-600"/>
              </div>
              <h3 className="text-[15px] font-bold text-gray-900">Settlement тохиргоо засна уу?</h3>
            </div>
            <p className="mb-4 text-[12px] text-gray-600">
              Энэ мөр SETTLEMENT (POS) гүйлгээ тул талбарууд автомат бөглөгдсөн ба өөрчлөх боломжгүй.
              Утгыг өөрчлөхийг хүсвэл <span className="font-semibold">Тохиргоо</span> цэснээс <span className="font-semibold">Settlement хаах тохиргоо</span>-г засна уу.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setSettlementLockModal(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2 text-[13px] font-semibold text-gray-600 hover:bg-gray-50">
                Болих
              </button>
              <button onClick={() => { setSettlementLockModal(false); setTab("settings"); }}
                className="flex-1 rounded-xl bg-amber-600 py-2 text-[13px] font-semibold text-white hover:bg-amber-700">
                Тохиргоо засах
              </button>
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
              {/* ERP account code */}
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">
                  Эрхэт дансны код
                  <span className="ml-1.5 font-normal text-gray-400">(шимтгэл экспортод ашиглана)</span>
                </label>
                <input value={acctForm.erp_account_code}
                  onChange={e => setAcctForm(f => ({ ...f, erp_account_code: e.target.value }))}
                  placeholder="110104"
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
