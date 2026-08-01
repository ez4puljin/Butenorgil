import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Upload, RefreshCw, AlertCircle, X, Check,
  ReceiptText, FileSpreadsheet, Download, Trash2, Search, Users, Phone,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ──────────────────────────────────────────────────────────────────

interface FileInfo {
  filename: string;
  size_bytes: number;
  row_count: number;
  uploaded_at: string | null;
  uploaded_by: string;
}

interface ReportRow {
  employee: string;
  code: string;
  name: string;
  registry: string;
  phone: string;
  tailbar: string;
  purchase_orgil: number;
  vat_orgil: number;
  diff_orgil: number;
  cnt_orgil: number;
  purchase_harhorin: number;
  vat_harhorin: number;
  diff_harhorin: number;
  cnt_harhorin: number;
  note: string;
}

interface ReportData {
  rows: ReportRow[];
  employees: { name: string; customers: number }[];
  files: Record<string, FileInfo | null>;
  missing: string[];
  error: string | null;
  year: number;
  month: number;
}

// Файлын слотууд — хуучин Tailan.xlsm-ийн эх үүсвэрүүд
const FILE_SLOTS: { kind: string; label: string; hint: string }[] = [
  { kind: "data",     label: "Data",                     hint: "Харилцагчдын мэдээлэл (Код, Нэр, Регистр, Нөат=ажилтан)" },
  { kind: "orgil",    label: "Оргил худалдан авалт",     hint: "Эрхэтээс татсан Оргилын өглөгийн тайлан (.xls)" },
  { kind: "harhorin", label: "Хархорин худалдан авалт",  hint: "Эрхэтээс татсан Хархорины өглөгийн тайлан (.xls)" },
  { kind: "ebarimt",  label: "Ebarimt (Оргил)",          hint: "Оргил руу шивсэн Ebarimt-аас татсан файл" },
  { kind: "ebarimt2", label: "Ebarimt (Хархорин)",       hint: "Хархорин руу шивсэн Ebarimt-аас татсан файл" },
];

const MN_MONTHS = ["1-р сар","2-р сар","3-р сар","4-р сар","5-р сар","6-р сар",
                   "7-р сар","8-р сар","9-р сар","10-р сар","11-р сар","12-р сар"];

function fmtMnt(n: number) {
  if (!n) return "—";
  return Math.round(n).toLocaleString("mn-MN");
}
function fmtDT(s: string | null) {
  if (!s) return "";
  return s.replace("T", " ").slice(0, 16);
}

// Гараар бичих тайлбарын нүд — дарж засна, Enter/blur-ээр хадгална
function NoteCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  function commit() {
    setEditing(false);
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  }
  if (editing) {
    return (
      <input ref={ref} value={draft} placeholder="Тайлбар…"
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        className="w-full rounded border border-blue-400 bg-white px-1.5 py-0.5 text-[11px] outline-none ring-2 ring-blue-200"/>
    );
  }
  return (
    <div onClick={() => setEditing(true)} title={value || "Тайлбар бичих"}
      className={`cursor-pointer min-h-[22px] rounded px-1.5 py-0.5 text-[11px] hover:bg-blue-50 hover:text-blue-700 ${
        value ? "text-gray-800" : "text-gray-300 italic"
      }`}>
      {value || "Тайлбар…"}
    </div>
  );
}

// Баганын толгойн жижиг шүүлтийн input
function ColFilterInput({ value, onChange, placeholder = "Шүүх…" }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div className="relative">
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className={`w-full rounded-md border px-1.5 py-0.5 text-[10px] font-normal outline-none placeholder:text-gray-300 ${
          value ? "border-blue-300 bg-blue-50/50 text-blue-800" : "border-gray-200 bg-white text-gray-700"
        } focus:border-blue-400 focus:ring-1 focus:ring-blue-200`}/>
      {value && (
        <button onClick={() => onChange("")} tabIndex={-1}
          className="absolute right-1 top-1/2 -translate-y-1/2 grid h-3 w-3 place-items-center rounded-full text-gray-400 hover:text-red-500">
          <X size={8}/>
        </button>
      )}
    </div>
  );
}

// Тоон баганын шүүлт (Бүгд / >0 / =0)
function NumFilterSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className={`w-full cursor-pointer rounded-md border px-1 py-0.5 text-[10px] font-normal outline-none ${
        value ? "border-blue-300 bg-blue-50/50 text-blue-800" : "border-gray-200 bg-white text-gray-500"
      }`}>
      <option value="">Бүгд</option>
      <option value="pos">&gt; 0</option>
      <option value="zero">= 0</option>
    </select>
  );
}

// Зөрүүний баганын шүүлт (Бүгд / Дутуу / Бүрэн / Илүү)
function DiffFilterSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className={`w-full cursor-pointer rounded-md border px-1 py-0.5 text-[10px] font-normal outline-none ${
        value ? "border-blue-300 bg-blue-50/50 text-blue-800" : "border-gray-200 bg-white text-gray-500"
      }`}>
      <option value="">Бүгд</option>
      <option value="missing">Дутуу</option>
      <option value="ok">Бүрэн ✓</option>
      <option value="over">Илүү</option>
    </select>
  );
}

// Баганын шүүлтүүдийн анхны утга
const EMPTY_COL_FILTERS = {
  employee: "", code: "", name: "", registry: "", phone: "", note: "",
  po: "", vo: "", do_: "", ph: "", vh: "", dh: "",
};

export default function EbarimtReportPage() {
  const now = new Date();
  const [year, setYear]   = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [report, setReport]   = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState("");

  // Шүүлтүүд
  const [selectedEmp, setSelectedEmp] = useState<string>("all");
  const [search, setSearch]           = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [colFilters, setColFilters]   = useState({ ...EMPTY_COL_FILTERS });
  const setCF = (k: keyof typeof EMPTY_COL_FILTERS) => (v: string) =>
    setColFilters(f => ({ ...f, [k]: v }));

  // Upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadKindRef = useRef<string>("");
  const [uploadingKind, setUploadingKind] = useState<string>("");
  const [showFiles, setShowFiles] = useState(false);

  async function loadReport(y = year, m = month) {
    setLoading(true);
    try {
      const r = await api.get("/ebarimt/report", { params: { year: y, month: m } });
      setReport(r.data);
      setErr("");
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Тайлан ачааллах амжилтгүй");
    } finally { setLoading(false); }
  }

  useEffect(() => { loadReport(year, month); }, [year, month]); // eslint-disable-line react-hooks/exhaustive-deps

  // Сар солигдоход шүүлтийг цэвэрлэнэ (ажилтны сонголт хадгална — өдөр тутмын хэрэглээ)
  useEffect(() => { setSearch(""); setColFilters({ ...EMPTY_COL_FILTERS }); }, [year, month]);

  // Тайлбар хадгалах — DB-д (Data файл дахин оруулахад алга болохгүй)
  async function saveNote(code: string, note: string) {
    try {
      const r = await api.put("/ebarimt/note", { year, month, code, note });
      setReport(prev => prev ? {
        ...prev,
        rows: prev.rows.map(x => x.code === code ? { ...x, note: r.data.note ?? note } : x),
      } : prev);
    } catch { setErr("Тайлбар хадгалах амжилтгүй"); }
  }

  function prevMonth() {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  }

  function pickFile(kind: string) {
    uploadKindRef.current = kind;
    fileInputRef.current?.click();
  }

  async function onFileChosen(files: FileList | null) {
    const kind = uploadKindRef.current;
    if (!files || !files.length || !kind) return;
    setUploadingKind(kind);
    try {
      const fd = new FormData();
      fd.append("year", String(year));
      fd.append("month", String(month));
      fd.append("kind", kind);
      fd.append("file", files[0]);
      await api.post("/ebarimt/import", fd, { headers: { "Content-Type": "multipart/form-data" } });
      await loadReport();
      setErr("");
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Файл оруулах амжилтгүй");
    } finally {
      setUploadingKind("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function deleteSlot(kind: string) {
    if (!confirm("Энэ файлыг устгах уу?")) return;
    try {
      await api.delete(`/ebarimt/${year}/${month}/${kind}`);
      await loadReport();
    } catch { setErr("Устгах амжилтгүй"); }
  }

  async function downloadSlot(kind: string, filename: string) {
    try {
      const r = await api.get("/ebarimt/download", {
        params: { year, month, kind }, responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement("a");
      a.href = url; a.download = filename || `${kind}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch { setErr("Татах амжилтгүй"); }
  }

  // ── Derived ────────────────────────────────────────────────────────

  const rows = report?.rows ?? [];
  const q = search.trim().toLowerCase();
  // Тоон баганын шүүлт: "" бүгд, "pos" >0, "zero" =0
  const numOk  = (v: number, f: string) => !f || (f === "pos" ? v > 0.5 : Math.abs(v) <= 0.5);
  // Зөрүүний шүүлт: "missing" дутуу, "ok" бүрэн, "over" илүү шивсэн
  const diffOk = (v: number, f: string) =>
    !f || (f === "missing" ? v > 0.5 : f === "ok" ? Math.abs(v) <= 0.5 : v < -0.5);
  const txtOk  = (v: string, f: string) => !f || (v || "").toLowerCase().includes(f.toLowerCase());
  const cf = colFilters;
  const filtered = rows.filter(r => {
    if (selectedEmp !== "all" && r.employee !== selectedEmp) return false;
    if (onlyMissing && !(r.diff_orgil > 0.5 || r.diff_harhorin > 0.5)) return false;
    if (q && !(`${r.name} ${r.code} ${r.registry} ${r.phone} ${r.note}`.toLowerCase().includes(q))) return false;
    // Багана тус бүрийн шүүлтүүд
    if (!txtOk(r.employee, cf.employee)) return false;
    if (!txtOk(r.code, cf.code)) return false;
    if (!txtOk(`${r.name} ${r.tailbar}`, cf.name)) return false;
    if (!txtOk(r.registry, cf.registry)) return false;
    if (!txtOk(r.phone, cf.phone)) return false;
    if (!txtOk(r.note, cf.note)) return false;
    if (!numOk(r.purchase_orgil, cf.po)) return false;
    if (!numOk(r.vat_orgil, cf.vo)) return false;
    if (!diffOk(r.diff_orgil, cf.do_)) return false;
    if (!numOk(r.purchase_harhorin, cf.ph)) return false;
    if (!numOk(r.vat_harhorin, cf.vh)) return false;
    if (!diffOk(r.diff_harhorin, cf.dh)) return false;
    return true;
  });
  const hasColFilters = Object.values(colFilters).some(v => v !== "");

  const tot = filtered.reduce((a, r) => ({
    po: a.po + r.purchase_orgil, vo: a.vo + r.vat_orgil,
    ph: a.ph + r.purchase_harhorin, vh: a.vh + r.vat_harhorin,
  }), { po: 0, vo: 0, ph: 0, vh: 0 });

  const missingCount = rows.filter(r => r.diff_orgil > 0.5 || r.diff_harhorin > 0.5).length;
  const uploadedCount = report ? FILE_SLOTS.filter(s => report.files?.[s.kind]).length : 0;

  function diffCell(v: number) {
    if (v > 0.5)  return <span className="font-bold text-rose-600">{fmtMnt(v)}</span>;
    if (v < -0.5) return <span className="text-sky-600">+{fmtMnt(-v)}</span>;
    return <span className="text-emerald-600">✓</span>;
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-2xl bg-white shadow-sm lg:h-[calc(100vh-2.5rem)]">

      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-gray-100 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-500/30">
            <ReceiptText size={16}/>
          </div>
          <div className="min-w-0">
            <h1 className="text-[15px] font-bold tracking-tight text-gray-900 leading-tight">Ebarimt</h1>
            <p className="text-[11px] text-gray-500 leading-tight">Худалдан авалт vs Ebarimt шивэлтийн хяналт</p>
          </div>
        </div>

        {/* Month nav */}
        <div className="flex items-center gap-1 rounded-2xl bg-gray-50 p-1 ring-1 ring-gray-100">
          <button onClick={prevMonth}
            className="grid h-8 w-8 place-items-center rounded-xl text-gray-400 hover:bg-white hover:text-gray-700 transition-colors">
            <ChevronLeft size={15}/>
          </button>
          <div className="px-2 text-center min-w-[86px]">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 leading-none">{year}</div>
            <div className="text-[13px] font-bold text-gray-900 leading-tight">{MN_MONTHS[month - 1]}</div>
          </div>
          <button onClick={nextMonth}
            className="grid h-8 w-8 place-items-center rounded-xl text-gray-400 hover:bg-white hover:text-gray-700 transition-colors">
            <ChevronRight size={15}/>
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Files toggle */}
          <button onClick={() => setShowFiles(v => !v)}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-semibold transition-colors ${
              showFiles
                ? "bg-[#0071E3] text-white shadow-sm shadow-blue-500/25"
                : uploadedCount < FILE_SLOTS.length
                  ? "border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
                  : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}>
            <FileSpreadsheet size={13}/>
            Файлууд {uploadedCount}/{FILE_SLOTS.length}
          </button>
          <button onClick={() => loadReport()} disabled={loading}
            className="grid h-9 w-9 place-items-center rounded-xl border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 disabled:opacity-60 transition-colors"
            title="Шинэчлэх">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""}/>
          </button>
        </div>

        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.xlsm" className="hidden"
          onChange={e => onFileChosen(e.target.files)}/>
      </div>

      {/* Error */}
      {err && (
        <div className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          <AlertCircle size={13} className="shrink-0"/>
          {err}
          <button onClick={() => setErr("")} className="ml-auto"><X size={12}/></button>
        </div>
      )}

      {/* ── File slots (collapsible) ─────────────────────────────── */}
      {showFiles && (
        <div className="shrink-0 border-b border-gray-100 bg-gray-50/50 px-4 py-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {FILE_SLOTS.map(slot => {
              const info = report?.files?.[slot.kind] ?? null;
              const busy = uploadingKind === slot.kind;
              return (
                <div key={slot.kind}
                  className={`rounded-xl border p-2.5 transition-colors ${
                    info ? "border-emerald-200 bg-emerald-50/50" : "border-dashed border-gray-300 bg-white"
                  }`}>
                  <div className="flex items-start justify-between gap-1">
                    <div className="min-w-0">
                      <div className="text-[11.5px] font-bold text-gray-800 leading-tight">{slot.label}</div>
                      {info ? (
                        <>
                          <div className="mt-0.5 truncate text-[10px] text-emerald-700" title={info.filename}>
                            <Check size={9} className="inline mr-0.5"/>{info.filename}
                          </div>
                          <div className="text-[9.5px] text-gray-400">{info.row_count} мөр · {fmtDT(info.uploaded_at)}</div>
                        </>
                      ) : (
                        <div className="mt-0.5 text-[10px] text-gray-400 leading-snug">{slot.hint}</div>
                      )}
                    </div>
                    {info && (
                      <div className="flex shrink-0 gap-0.5">
                        <button onClick={() => downloadSlot(slot.kind, info.filename)} title="Татах"
                          className="grid h-5 w-5 place-items-center rounded text-gray-400 hover:bg-white hover:text-blue-600">
                          <Download size={10}/>
                        </button>
                        <button onClick={() => deleteSlot(slot.kind)} title="Устгах"
                          className="grid h-5 w-5 place-items-center rounded text-gray-400 hover:bg-white hover:text-red-500">
                          <Trash2 size={10}/>
                        </button>
                      </div>
                    )}
                  </div>
                  <button onClick={() => pickFile(slot.kind)} disabled={busy}
                    className={`mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1 text-[10.5px] font-semibold transition-colors disabled:opacity-60 ${
                      info
                        ? "border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50"
                        : "bg-[#0071E3] text-white hover:bg-blue-600"
                    }`}>
                    {busy ? <><RefreshCw size={10} className="animate-spin"/>Оруулж…</>
                          : <><Upload size={10}/>{info ? "Солих" : "Оруулах"}</>}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Employee filter chips + search ───────────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => setSelectedEmp("all")}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
              selectedEmp === "all"
                ? "bg-[#0071E3] text-white shadow-sm shadow-blue-500/25"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}>
            <Users size={11}/>Бүгд ({rows.length})
          </button>
          {(report?.employees ?? []).map(e => (
            <button key={e.name} onClick={() => setSelectedEmp(e.name)}
              className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                selectedEmp === e.name
                  ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/25"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}>
              {e.name} ({e.customers})
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Зөвхөн дутуутай */}
          <button onClick={() => setOnlyMissing(v => !v)}
            className={`flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors ${
              onlyMissing
                ? "bg-rose-600 text-white shadow-sm shadow-rose-500/25"
                : "border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100"
            }`}>
            <AlertCircle size={11}/>Дутуутай ({missingCount})
          </button>
          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Нэр, код, регистр…"
              className="w-44 rounded-xl border border-gray-200 bg-white py-1.5 pl-7 pr-2 text-[12px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 placeholder:text-gray-300"/>
          </div>
        </div>
      </div>

      {/* ── Table ────────────────────────────────────────────────── */}
      {loading && !report ? (
        <div className="flex flex-1 items-center justify-center text-gray-400">
          <RefreshCw size={15} className="animate-spin mr-2"/>Ачаалж байна…
        </div>
      ) : report?.error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-gray-400">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-amber-50">
            <FileSpreadsheet size={28} className="text-amber-400"/>
          </div>
          <div className="text-center">
            <p className="text-[14px] font-semibold text-gray-700">{report.error}</p>
            <p className="mt-0.5 text-[12px] text-gray-400">Дээрх "Файлууд" товчоор сарын эх файлуудаа оруулна уу</p>
          </div>
          <button onClick={() => setShowFiles(true)}
            className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-600 shadow-sm shadow-blue-500/25">
            <Upload size={13}/>Файл оруулах
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_#f3f4f6]">
              <tr>
                <th className="px-2 pt-2.5 pb-1 text-center text-[10px] font-bold uppercase tracking-wider text-gray-400">#</th>
                <th className="px-2 pt-2.5 pb-1 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">Ажилтан</th>
                <th className="px-2 pt-2.5 pb-1 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">Код</th>
                <th className="px-2 pt-2.5 pb-1 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">Харилцагч</th>
                <th className="px-2 pt-2.5 pb-1 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">Регистр</th>
                <th className="px-2 pt-2.5 pb-1 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">Утас</th>
                <th className="border-l border-blue-100 bg-blue-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-blue-700">Оргил ХА</th>
                <th className="bg-blue-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-blue-700">Оргил Ebarimt</th>
                <th className="border-r border-blue-100 bg-blue-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-blue-700">Зөрүү</th>
                <th className="bg-violet-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-violet-700">Хархорин ХА</th>
                <th className="bg-violet-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-violet-700">Хархорин Ebarimt</th>
                <th className="border-r border-violet-100 bg-violet-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-violet-700">Зөрүү</th>
                <th className="px-2 pt-2.5 pb-1 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">Тайлбар</th>
              </tr>
              {/* Багана тус бүрийн шүүлтийн мөр */}
              <tr className="border-b border-gray-100">
                <th className="px-1 pb-1.5 text-center align-middle">
                  {hasColFilters && (
                    <button onClick={() => setColFilters({ ...EMPTY_COL_FILTERS })}
                      title="Бүх баганын шүүлтийг цэвэрлэх"
                      className="grid h-4 w-4 mx-auto place-items-center rounded-full bg-rose-50 text-rose-500 hover:bg-rose-100">
                      <X size={9}/>
                    </button>
                  )}
                </th>
                <th className="px-1 pb-1.5"><ColFilterInput value={colFilters.employee} onChange={setCF("employee")}/></th>
                <th className="px-1 pb-1.5"><ColFilterInput value={colFilters.code} onChange={setCF("code")}/></th>
                <th className="px-1 pb-1.5"><ColFilterInput value={colFilters.name} onChange={setCF("name")}/></th>
                <th className="px-1 pb-1.5"><ColFilterInput value={colFilters.registry} onChange={setCF("registry")}/></th>
                <th className="px-1 pb-1.5"><ColFilterInput value={colFilters.phone} onChange={setCF("phone")}/></th>
                <th className="border-l border-blue-100 bg-blue-50/40 px-1 pb-1.5"><NumFilterSelect value={colFilters.po} onChange={setCF("po")}/></th>
                <th className="bg-blue-50/40 px-1 pb-1.5"><NumFilterSelect value={colFilters.vo} onChange={setCF("vo")}/></th>
                <th className="border-r border-blue-100 bg-blue-50/40 px-1 pb-1.5"><DiffFilterSelect value={colFilters.do_} onChange={setCF("do_")}/></th>
                <th className="bg-violet-50/40 px-1 pb-1.5"><NumFilterSelect value={colFilters.ph} onChange={setCF("ph")}/></th>
                <th className="bg-violet-50/40 px-1 pb-1.5"><NumFilterSelect value={colFilters.vh} onChange={setCF("vh")}/></th>
                <th className="border-r border-violet-100 bg-violet-50/40 px-1 pb-1.5"><DiffFilterSelect value={colFilters.dh} onChange={setCF("dh")}/></th>
                <th className="px-1 pb-1.5"><ColFilterInput value={colFilters.note} onChange={setCF("note")}/></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const hasMissing = r.diff_orgil > 0.5 || r.diff_harhorin > 0.5;
                return (
                  <tr key={`${r.code}-${i}`}
                    className={`border-b border-gray-50 transition-colors ${
                      hasMissing ? "bg-rose-50/30 hover:bg-rose-50/60" : "hover:bg-gray-50/60"
                    }`}>
                    <td className="px-2 py-1.5 text-center text-[10px] text-gray-300">{i + 1}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-indigo-700">{r.employee}</span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[11px] text-gray-500">{r.code}</td>
                    <td className="px-2 py-1.5 max-w-[220px]">
                      <div className="truncate font-medium text-gray-900" title={r.name}>{r.name}</div>
                      {r.tailbar && <div className="truncate text-[10px] text-gray-400" title={r.tailbar}>{r.tailbar}</div>}
                    </td>
                    <td className="px-2 py-1.5 max-w-[110px] truncate font-mono text-[10.5px] text-gray-500" title={r.registry}>{r.registry || "—"}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap font-mono text-[10.5px] text-gray-500">
                      {r.phone ? <a href={`tel:${r.phone}`} className="flex items-center gap-0.5 hover:text-blue-600"><Phone size={9}/>{r.phone}</a> : "—"}
                    </td>
                    <td className="border-l border-blue-100 px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px] text-gray-700">{fmtMnt(r.purchase_orgil)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px] text-gray-700" title={`${r.cnt_orgil} баримт`}>{fmtMnt(r.vat_orgil)}</td>
                    <td className="border-r border-blue-100 px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px]">{diffCell(r.diff_orgil)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px] text-gray-700">{fmtMnt(r.purchase_harhorin)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px] text-gray-700" title={`${r.cnt_harhorin} баримт`}>{fmtMnt(r.vat_harhorin)}</td>
                    <td className="border-r border-violet-100 px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px]">{diffCell(r.diff_harhorin)}</td>
                    <td className="px-1 py-1 min-w-[140px] max-w-[220px]">
                      <NoteCell value={r.note || ""} onSave={v => saveNote(r.code, v)}/>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {filtered.length > 0 && (
              <tfoot className="sticky bottom-0 bg-white shadow-[0_-1px_0_0_#f3f4f6]">
                <tr className="text-[11.5px] font-bold">
                  <td colSpan={6} className="px-2 py-2 text-right text-gray-500">
                    Нийт ({filtered.length} харилцагч):
                  </td>
                  <td className="border-l border-blue-100 bg-blue-50/40 px-2 py-2 text-right font-mono tabular-nums text-blue-800">{fmtMnt(tot.po)}</td>
                  <td className="bg-blue-50/40 px-2 py-2 text-right font-mono tabular-nums text-blue-800">{fmtMnt(tot.vo)}</td>
                  <td className="border-r border-blue-100 bg-blue-50/40 px-2 py-2 text-right font-mono tabular-nums">{diffCell(tot.po - tot.vo)}</td>
                  <td className="bg-violet-50/40 px-2 py-2 text-right font-mono tabular-nums text-violet-800">{fmtMnt(tot.ph)}</td>
                  <td className="bg-violet-50/40 px-2 py-2 text-right font-mono tabular-nums text-violet-800">{fmtMnt(tot.vh)}</td>
                  <td className="border-r border-violet-100 bg-violet-50/40 px-2 py-2 text-right font-mono tabular-nums">{diffCell(tot.ph - tot.vh)}</td>
                  <td/>
                </tr>
              </tfoot>
            )}
          </table>
          {filtered.length === 0 && (
            <div className="flex flex-col items-center py-14 text-gray-400 gap-2">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gray-50">
                <Search size={22} className="opacity-40"/>
              </div>
              <p className="text-[13px] font-semibold text-gray-600">Илэрц олдсонгүй</p>
              <p className="text-[11px] text-gray-400">Шүүлтээ өөрчилж үзнэ үү</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
