import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft, ChevronRight, Upload, RefreshCw, AlertCircle, X, Check,
  ReceiptText, FileSpreadsheet, Download, Trash2, Search, Users, Phone,
  RotateCcw, UserX, CalendarRange, ChevronDown, ExternalLink,
} from "lucide-react";
import { Link } from "react-router-dom";
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
  // НӨАТ чөлөөлөгдөх дүн (гараар) — Зөрүү = ХА − Ebarimt − чөлөөлөгдөх
  exempt_orgil: number;
  exempt_harhorin: number;
  note: string;
  is_orphan?: boolean;
  // Гараар засварласан талбарын АНХНЫ (Data файлын) утга — санамжид харуулна
  defaults?: Record<string, string>;
  // Нэгтгэсэн тайланд: сар бүрийн ХА / Ebarimt / чөлөөлөгдөх × (Оргил, Хархорин)
  by_month?: Record<string, { po: number; vo: number; eo: number; ph: number; vh: number; eh: number }>;
}

type Which = "orgil" | "harhorin";
type PurchaseKind = "income" | "legacy" | null;
interface MonthAvail {
  month: number;
  kinds: string[];                                     // Ebarimt цэсэнд оруулсан файлууд
  purchase?: Partial<Record<Which, PurchaseKind>>;     // ХА-ийн эх сурвалж салбар бүрээр
  complete: boolean;
}

// ХА-ийн эх сурвалж — Файл оруулалтын орлогын файл (тэр сард байхгүй бол хуучин өглөгийн тайлан)
interface IncomeFileMeta {
  filename: string; month: number; size_bytes: number; row_count: number;
  uploaded_at: string | null; uploaded_by: string;
}
interface PurchaseSource {
  source: "income" | "legacy" | "none";
  files?: IncomeFileMeta[];
  docs?: number; lines?: number; total?: number;
  date_from?: string | null; date_to?: string | null;
}

// Data-д байхгүй ч худалдан авалттай харилцагчдын бүлэг (backend-тэй ижил)
const ORPHAN_EMP = "Data-д байхгүй";

interface ReportData {
  rows: ReportRow[];
  employees: { name: string; customers: number }[];
  files?: Record<string, FileInfo | null>;
  purchase_source?: Partial<Record<Which, PurchaseSource>>;
  // сарын тайланд: дутуу файлын төрлүүд; нэгтгэсэнд: {сар: дутуу төрлүүд}
  missing: string[] | Record<string, string[]>;
  error: string | null;
  year: number;
  month?: number;
  months?: number[];        // нэгтгэсэн тайланд орсон сарууд
  skipped?: number[];       // Data файлгүй тул орхисон сарууд
}

/** «1–3, 5-р сар» — сонгосон саруудыг товчоор. */
function monthsLabel(ms: number[]) {
  const parts: string[] = [];
  for (let i = 0; i < ms.length; i++) {
    let j = i;
    while (j + 1 < ms.length && ms[j + 1] === ms[j] + 1) j++;
    parts.push(j > i ? `${ms[i]}–${ms[j]}` : `${ms[i]}`);
    i = j;
  }
  return parts.length ? `${parts.join(", ")}-р сар` : "сар сонгоогүй";
}

// Ebarimt цэсэнд оруулдаг файлууд — хуучин Tailan.xlsm-ийн эх үүсвэрүүд
const FILE_SLOTS: { kind: string; label: string; hint: string }[] = [
  { kind: "data",     label: "Data",                     hint: "Харилцагчдын мэдээлэл (Код, Нэр, Регистр, Нөат=ажилтан)" },
  { kind: "ebarimt",  label: "Ebarimt (Оргил)",          hint: "Оргил руу шивсэн Ebarimt-аас татсан файл" },
  { kind: "ebarimt2", label: "Ebarimt (Хархорин)",       hint: "Хархорин руу шивсэн Ebarimt-аас татсан файл" },
];
// Худалдан авалт — энд оруулахгүй, Файл оруулалтын орлогын файлаас автоматаар бодогдоно
const PURCHASE_CARDS: { which: Which; label: string; path: string; link: string }[] = [
  { which: "orgil",    label: "Оргил худалдан авалт",    path: "Файл оруулалт → Орлогын файл",                     link: "/imports/income-file" },
  { which: "harhorin", label: "Хархорин худалдан авалт", path: "Файл оруулалт → Орлогын файл → Хархорин салбар", link: "/imports/income-file?branch=harhorin" },
];
const KIND_LABEL: Record<string, string> = {
  ...Object.fromEntries(FILE_SLOTS.map(x => [x.kind, x.label])),
  income_orgil: "Оргил орлогын файл", income_harhorin: "Хархорин орлогын файл",
};
/** Сарын дутуу эх сурвалжууд — сар сонголтын tooltip-д. */
function monthMissing(a: MonthAvail): string[] {
  return [
    ...FILE_SLOTS.filter(x => !a.kinds.includes(x.kind)).map(x => x.label),
    ...PURCHASE_CARDS.filter(c => a.purchase?.[c.which] !== "income")
      .map(c => KIND_LABEL[`income_${c.which}`] + (a.purchase?.[c.which] === "legacy" ? " (одоохондоо хуучин өглөгийн тайлангаар)" : "")),
  ];
}

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

/** Засварлаж болох нүд — дарж засна. Гараар засварласан бол доор нь
 *  анхны (Data файлын) утгыг санамж болгон харуулж, дарахад буцаана. */
function EditableCell({ value, defaultValue, placeholder, mono, onSave, onRevert }: {
  value: string;
  defaultValue?: string;          // засварласан үед л ирнэ (анхны утга)
  placeholder: string;
  mono?: boolean;
  onSave: (v: string) => void;
  onRevert: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const edited = defaultValue !== undefined;
  function commit() {
    setEditing(false);
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  }
  return (
    <div>
      {editing ? (
        <input ref={ref} value={draft} placeholder={placeholder}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
          className={`w-full rounded border border-blue-400 bg-white px-1 py-0.5 text-[11px] outline-none ring-2 ring-blue-200 ${mono ? "font-mono" : ""}`}/>
      ) : (
        <div onClick={() => setEditing(true)} title={value || placeholder}
          className={`cursor-pointer truncate rounded px-1 py-0.5 text-[11px] hover:bg-blue-50 hover:text-blue-700 ${mono ? "font-mono" : ""} ${
            value ? (edited ? "font-semibold text-blue-700" : "text-gray-700") : "text-gray-300 italic"
          }`}>
          {value || placeholder}
        </div>
      )}
      {edited && (
        <button onClick={onRevert} title="Анхны утгад буцаах"
          className="mt-0.5 flex w-full items-center gap-0.5 truncate px-1 text-left text-[9px] text-gray-400 hover:text-rose-500">
          <RotateCcw size={7} className="shrink-0"/>
          <span className="truncate">{defaultValue || "(хоосон)"}</span>
        </button>
      )}
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

// ── Ebarimt (НӨАТ) дүнгийн задаргаа — манай компани руу шивсэн баримтууд ─────────
interface EntriesData {
  columns: string[]; rows: Record<string, string | number | null>[];
  registries: string[]; no_file: number[]; months: number[];
}
const AMOUNT_COLS = ["НӨАТ", "Цэвэр дүн", "Нийт дүн"];
const fmtAmt = (v: unknown) =>
  typeof v === "number" ? v.toLocaleString("mn-MN", { maximumFractionDigits: 2 }) : (v ?? "") as string;

/** Файлын самбар дахь «худалдан авалт» карт — Файл оруулалтын орлогын файлын мэдээлэл. */
function PurchaseSourceCard({ card, src, legacy }: {
  card: (typeof PURCHASE_CARDS)[number]; src?: PurchaseSource; legacy?: FileInfo | null;
}) {
  const ok = src?.source === "income";
  const files = src?.files ?? [];
  const last = [...files].sort((a, b) => (b.uploaded_at ?? "").localeCompare(a.uploaded_at ?? ""))[0];
  return (
    <div className={`flex flex-col rounded-xl border p-2.5 ${ok ? "border-emerald-200 bg-emerald-50/50" : "border-amber-200 bg-amber-50/60"}`}>
      <div className="flex-1">
      <div className="text-[11.5px] font-bold text-gray-800 leading-tight">{card.label}</div>
      <div className="text-[9.5px] text-gray-400 leading-tight">{card.path}</div>
      {ok ? (
        <>
          {files.map(f => (
            <div key={f.filename} className="mt-0.5 truncate text-[10px] text-emerald-700" title={f.filename}>
              <Check size={9} className="inline mr-0.5"/>{f.filename}{f.month ? "" : " · бүтэн он"}
            </div>
          ))}
          <div className="text-[9.5px] text-gray-500">
            {src?.docs} баримт · {src?.lines} мөр{src?.date_from ? ` · ${src.date_from.slice(5)} – ${(src.date_to ?? "").slice(5)}` : ""}
          </div>
          <div className="text-[9.5px] text-gray-500">Нийт <b className="font-mono text-gray-700">{fmtMnt(src?.total ?? 0)}</b></div>
          {last && <div className="text-[9.5px] text-gray-400">{fmtDT(last.uploaded_at)}{last.uploaded_by ? ` · ${last.uploaded_by}` : ""}</div>}
        </>
      ) : (
        <div className="mt-0.5 text-[10px] leading-snug text-amber-800">
          Энэ сарын орлогын файл оруулаагүй{src?.source === "legacy"
            ? <> — одоохондоо хуучин өглөгийн тайлангаар{legacy?.filename ? <> (<span className="font-medium">{legacy.filename}</span>)</> : null}.</>
            : " — ХА тооцогдохгүй."}
        </div>
      )}
      </div>
      <Link to={card.link}
        className={`mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1 text-[10.5px] font-semibold transition-colors ${
          ok ? "border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50"
             : "bg-amber-500 text-white hover:bg-amber-600"}`}>
        <ExternalLink size={10}/>{ok ? "Файл оруулалт" : "Орлогын файл оруулах"}
      </Link>
    </div>
  );
}

/** Салбарын утгууд: ХА, Ebarimt, НӨАТ чөлөөлөгдөх, Зөрүү (= ХА − Ebarimt − чөлөөлөгдөх). */
function branchVals(row: ReportRow, which: Which) {
  const o = which === "orgil";
  const p = o ? row.purchase_orgil : row.purchase_harhorin;
  const e = o ? row.vat_orgil : row.vat_harhorin;
  const x = (o ? row.exempt_orgil : row.exempt_harhorin) || 0;
  return { p, e, x, d: p - e - x };
}
const diffTone = (d: number) => (d > 0.5 ? "text-rose-600" : d < -0.5 ? "text-sky-600" : "text-emerald-600");
// Хүснэгтийн diffCell-тэй ижил: дутуу — дүнгээр, илүү шивсэн — «+дүн», таарсан — ✓
const fmtDiff = (d: number, zero = "✓") => (d > 0.5 ? fmtMnt(d) : d < -0.5 ? `+${fmtMnt(-d)}` : zero);

function SummaryStats({ row, which, extra }: { row: ReportRow; which: Which; extra?: ReactNode }) {
  const v = branchVals(row, which);
  const items: [string, number, string][] = [
    ["Худалдан авалт", v.p, "text-gray-900"],
    ["Ebarimt шивэлт", v.e, which === "orgil" ? "text-blue-700" : "text-violet-700"],
  ];
  if (v.x) items.push(["НӨАТ чөлөөлөгдөх", v.x, "text-amber-700"]);
  items.push(["Зөрүү", v.d, diffTone(v.d)]);
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3 sm:px-5">
      {items.map(([l, val, c]) => (
        <div key={l} className="rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-1.5">
          <div className="text-[10.5px] font-semibold text-gray-500">{l}</div>
          <div className={`font-mono text-[15px] font-bold tabular-nums ${c}`}>{l === "Зөрүү" ? fmtDiff(val, "✓ 0") : fmtMnt(val)}</div>
        </div>
      ))}
      {extra}
    </div>
  );
}

/** Нэгтгэсэн тайланд — аль сард зөрүү гарсныг харуулна. docs — сар бүрийн орлогын баримтын нийлбэр
 *  (null = тэр сарын орлогын файл оруулаагүй); ХА-аас зөрсөн сар шараар тодорно. */
function PerMonthTable({ row, which, docs }: { row: ReportRow; which: Which; docs?: Record<number, number | null> }) {
  const o = which === "orgil";
  const pm = Object.entries(row.by_month ?? {})
    .map(([m, v]) => ({ m: Number(m), p: o ? v.po : v.ph, e: o ? v.vo : v.vh, x: o ? v.eo : v.eh }))
    .sort((a, b) => a.m - b.m);
  if (pm.length < 2) return null;
  const hasX = pm.some(x => x.x);
  return (
    <div className="mb-3 overflow-x-auto">
      <table className="text-[11.5px]">
        <thead><tr className="text-gray-500">
          <th className="pr-3 text-left font-semibold">Сар</th>
          {pm.map(x => <th key={x.m} className="px-2 text-right font-semibold">{x.m}</th>)}
        </tr></thead>
        <tbody className="font-mono tabular-nums">
          <tr><td className="pr-3 font-sans text-gray-500">ХА</td>{pm.map(x => <td key={x.m} className="px-2 text-right">{fmtMnt(x.p)}</td>)}</tr>
          {docs && <tr><td className="pr-3 font-sans text-gray-500">Орлогын баримт</td>{pm.map(x => {
            const v = docs[x.m];
            if (v === undefined) return <td key={x.m}/>;
            if (v === null) return <td key={x.m} className="px-2 text-right font-sans text-[10.5px] text-amber-600">файлгүй</td>;
            const off = Math.abs(x.p - v) > 0.5;
            return <td key={x.m} title={off ? `ХА-аас зөрүү: ${fmtMnt(x.p - v)}` : "ХА-тай таарсан"}
              className={`px-2 text-right ${off ? "font-semibold text-amber-700" : "text-gray-400"}`}>{fmtMnt(v)}</td>;
          })}</tr>}
          <tr><td className="pr-3 font-sans text-gray-500">Ebarimt</td>{pm.map(x => <td key={x.m} className="px-2 text-right">{fmtMnt(x.e)}</td>)}</tr>
          {hasX && <tr><td className="pr-3 font-sans text-gray-500">Чөлөөлөгдөх</td>{pm.map(x => <td key={x.m} className="px-2 text-right text-amber-700">{fmtMnt(x.x)}</td>)}</tr>}
          <tr><td className="pr-3 font-sans text-gray-500">Зөрүү</td>{pm.map(x => {
            const d = x.p - x.e - x.x;
            return <td key={x.m} className={`px-2 text-right font-semibold ${diffTone(d)}`}>{fmtDiff(d)}</td>;
          })}</tr>
        </tbody>
      </table>
    </div>
  );
}

function EntriesModal({ row, which, year, months, onClose }: {
  row: ReportRow; which: Which; year: number; months: number[]; onClose: () => void;
}) {
  const [data, setData] = useState<EntriesData | null>(null);
  const [err, setErr] = useState("");
  const monthsKey = months.join(",");
  useEffect(() => {
    let alive = true;
    api.get("/ebarimt/entries", { params: { year, months: monthsKey, code: row.code, which }, timeout: 120000 })
      .then(r => { if (alive) setData(r.data); })
      .catch(e => { if (alive) setErr(e?.response?.data?.detail ?? "Баримт ачааллах амжилтгүй"); });
    return () => { alive = false; };
  }, [row.code, which, year, monthsKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const orgil = which === "orgil";
  const multi = months.length > 1;
  const cols = data?.columns ?? [];
  const sums = Object.fromEntries(AMOUNT_COLS.map(c => [c, (data?.rows ?? []).reduce((s, x) => s + (typeof x[c] === "number" ? (x[c] as number) : 0), 0)]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-6" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-gray-100 px-4 py-3 sm:px-5">
          <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white ${orgil ? "bg-blue-600" : "bg-violet-600"}`}><ReceiptText size={16}/></div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-bold text-gray-900">{row.name || row.code} <span className="font-mono text-[12px] font-normal text-gray-400">#{row.code}</span></div>
            <div className="text-[11.5px] text-gray-500">
              {orgil ? "Оргил" : "Хархорин"} руу шивсэн Ebarimt (НӨАТ) баримтууд · {year} · {monthsLabel(months)}
              {data?.registries.length ? <> · Регистр: <span className="font-mono">{data.registries.join(", ")}</span></> : null}
            </div>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Хаах (Esc)"><X size={16}/></button>
        </div>

        <SummaryStats row={row} which={which}
          extra={data && <div className="self-center text-[12px] text-gray-500">{data.rows.length} баримт</div>}/>

        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-3 sm:px-5">
          {multi && <PerMonthTable row={row} which={which}/>}
          {err ? (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-[12px] text-red-700">{err}</div>
          ) : !data ? (
            <div className="flex items-center gap-2 py-10 text-[12.5px] text-gray-400"><RefreshCw size={14} className="animate-spin"/>Баримтуудыг уншиж байна…</div>
          ) : data.rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 py-10 text-center text-[12.5px] text-gray-500">
              {data.registries.length
                ? "Энэ хугацаанд энэ харилцагчийн регистрээр шивсэн баримт алга."
                : "Регистр бүртгэлгүй тул Ebarimt тулгагдаагүй — хүснэгтийн Регистр нүдэнд ТТД оруулна уу."}
            </div>
          ) : (
            <table className="w-full border-collapse text-[11.5px]">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-gray-200 text-left text-[10.5px] font-bold uppercase tracking-wider text-gray-500">
                  <th className="px-2 py-1.5">#</th>
                  {multi && <th className="px-2 py-1.5">Сар</th>}
                  {cols.map(c => <th key={c} className={`px-2 py-1.5 ${AMOUNT_COLS.includes(c) ? "text-right" : ""}`}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((x, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/60">
                    <td className="px-2 py-1 text-gray-300">{i + 1}</td>
                    {multi && <td className="px-2 py-1 text-gray-500">{x.month}</td>}
                    {cols.map(c => (
                      <td key={c} className={`px-2 py-1 ${AMOUNT_COLS.includes(c) ? "text-right font-mono tabular-nums" : ""} ${c === "ДДТД" ? "font-mono text-[10.5px] text-gray-500" : "text-gray-700"}`}>
                        {AMOUNT_COLS.includes(c) ? fmtAmt(x[c]) : String(x[c] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-white">
                <tr className="border-t border-gray-200 font-bold">
                  <td className="px-2 py-1.5 text-gray-500" colSpan={1 + (multi ? 1 : 0)}>Нийт</td>
                  {cols.map(c => <td key={c} className="px-2 py-1.5 text-right font-mono tabular-nums">{AMOUNT_COLS.includes(c) ? fmtAmt(sums[c]) : ""}</td>)}
                </tr>
              </tfoot>
            </table>
          )}
          {!!data?.no_file.length && (
            <div className="mt-2 text-[11.5px] text-amber-700">Ebarimt файл оруулаагүй сар: {monthsLabel(data.no_file)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ХА (худалдан авалт)-ын задаргаа — Файл оруулалтын орлогын файлын баримтууд ─────
interface PurchaseDoc {
  month: number; doc: string; date: string; utga: string; account: string; user: string;
  supplier: string; amount: number; discount: number; locations: string[];
  lines: [string, string, string, number, number, number, number][];   // код, нэр, байршил, тоо, нэгж үнэ, дүн, хөнгөлөлт
}
const fmtQty = (n: number) => n.toLocaleString("mn-MN", { maximumFractionDigits: 3 });

function PurchasesModal({ row, which, year, months, onClose }: {
  row: ReportRow; which: Which; year: number; months: number[]; onClose: () => void;
}) {
  const [data, setData] = useState<{ documents: PurchaseDoc[]; missing: number[]; total: number } | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const monthsKey = months.join(",");
  useEffect(() => {
    let alive = true;
    api.get("/ebarimt/purchases", { params: { year, months: monthsKey, code: row.code, which }, timeout: 120000 })
      .then(r => { if (alive) setData(r.data); })
      .catch(e => { if (alive) setErr(e?.response?.data?.detail ?? "Орлогын баримт ачааллах амжилтгүй"); });
    return () => { alive = false; };
  }, [row.code, which, year, monthsKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const orgil = which === "orgil";
  const multi = months.length > 1;
  const purchase = branchVals(row, which).p;
  const gap = data ? purchase - data.total : 0;
  const toggle = (k: string) => setOpen(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const docs = data?.documents ?? [];
  const docsByMonth = data ? Object.fromEntries(months.map(m => [m, data.missing.includes(m) ? null
    : docs.reduce((s, d) => s + (d.month === m ? d.amount : 0), 0)])) as Record<number, number | null> : undefined;
  const allOpen = docs.length > 0 && docs.every(d => open.has(`${d.month}-${d.doc}`));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-6" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-gray-100 px-4 py-3 sm:px-5">
          <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white ${orgil ? "bg-blue-600" : "bg-violet-600"}`}><FileSpreadsheet size={16}/></div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-bold text-gray-900">{row.name || row.code} <span className="font-mono text-[12px] font-normal text-gray-400">#{row.code}</span></div>
            <div className="text-[11.5px] text-gray-500">
              {orgil ? "Оргил" : "Хархорин"} — худалдан авалтын задаргаа (орлогын файлын баримтууд) · {year} · {monthsLabel(months)}
            </div>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Хаах (Esc)"><X size={16}/></button>
        </div>

        <SummaryStats row={row} which={which} extra={data && (
          <>
            <div className="rounded-xl border border-gray-100 bg-white px-3 py-1.5">
              <div className="text-[10.5px] font-semibold text-gray-500">Орлогын баримт ({docs.length})</div>
              <div className="font-mono text-[15px] font-bold tabular-nums text-gray-900">{fmtMnt(data.total)}</div>
            </div>
            {Math.abs(gap) > 0.5 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5" title="ХА (өглөгийн тайлан) ба орлогын файлын баримтуудын зөрүү — үйлчилгээ, бусад кредит гүйлгээ эсвэл орлогын файл дутуу байж болно">
                <div className="text-[10.5px] font-semibold text-amber-700">Орлогын файлд тусгагдаагүй</div>
                <div className="font-mono text-[15px] font-bold tabular-nums text-amber-700">{fmtMnt(gap)}</div>
              </div>
            )}
          </>
        )}/>

        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-3 sm:px-5">
          {multi && <PerMonthTable row={row} which={which} docs={docsByMonth}/>}
          {!!data?.missing.length && (
            <div className="mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-[11.5px] text-amber-800">
              Орлогын файл оруулаагүй: {monthsLabel(data.missing)} —{" "}
              <Link to={orgil ? "/imports/income-file" : "/imports/income-file?branch=harhorin"} className="font-semibold underline underline-offset-2 hover:text-amber-950">
                Файл оруулалт → Орлогын файл{orgil ? "" : " → Хархорин салбар"}
              </Link>.
            </div>
          )}
          {err ? (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-[12px] text-red-700">{err}</div>
          ) : !data ? (
            <div className="flex items-center gap-2 py-10 text-[12.5px] text-gray-400"><RefreshCw size={14} className="animate-spin"/>Орлогын баримтуудыг уншиж байна…</div>
          ) : docs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 py-10 text-center text-[12.5px] text-gray-500">
              {data.missing.length === months.length ? "Эдгээр сарын орлогын файл оруулаагүй байна." : "Энэ хугацаанд энэ нийлүүлэгчээс орлогын баримт алга."}
            </div>
          ) : (
            <table className="w-full border-collapse text-[11.5px]">
              <thead className="sticky top-0 z-10 bg-white">
                <tr className="border-b border-gray-200 text-left text-[10.5px] font-bold uppercase tracking-wider text-gray-500">
                  <th className="w-7 px-1 py-1.5">
                    <button onClick={() => setOpen(allOpen ? new Set() : new Set(docs.map(d => `${d.month}-${d.doc}`)))}
                      title={allOpen ? "Бүгдийг хураах" : "Бүгдийг дэлгэх"} className="grid h-5 w-5 place-items-center rounded text-gray-400 hover:bg-gray-100">
                      <ChevronDown size={12} className={allOpen ? "" : "-rotate-90"}/>
                    </button>
                  </th>
                  {multi && <th className="px-2 py-1.5">Сар</th>}
                  <th className="px-2 py-1.5">Огноо</th>
                  <th className="px-2 py-1.5">Баримтын дугаар</th>
                  <th className="px-2 py-1.5">Утга</th>
                  <th className="px-2 py-1.5">Байршил</th>
                  <th className="px-2 py-1.5 text-right">Мөр</th>
                  <th className="px-2 py-1.5 text-right">Дүн</th>
                  <th className="px-2 py-1.5">Оруулсан</th>
                </tr>
              </thead>
              <tbody>
                {docs.map(d => {
                  const k = `${d.month}-${d.doc}`;
                  const isOpen = open.has(k);
                  return [
                    <tr key={k} onClick={() => toggle(k)} className={`cursor-pointer border-b border-gray-50 ${isOpen ? "bg-blue-50/50" : "hover:bg-gray-50/70"}`}>
                      <td className="px-1 py-1 text-gray-400"><ChevronDown size={12} className={isOpen ? "" : "-rotate-90"}/></td>
                      {multi && <td className="px-2 py-1 text-gray-500">{d.month}</td>}
                      <td className="px-2 py-1 whitespace-nowrap text-gray-700">{d.date}</td>
                      <td className="px-2 py-1 whitespace-nowrap font-mono text-gray-700">{d.doc}</td>
                      <td className="max-w-[220px] truncate px-2 py-1 text-gray-600" title={d.utga}>{d.utga}</td>
                      <td className="max-w-[180px] truncate px-2 py-1 text-gray-600" title={d.locations.join(", ")}>{d.locations.join(", ")}</td>
                      <td className="px-2 py-1 text-right text-gray-500">{d.lines.length}</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold tabular-nums text-gray-900">
                        <span className="underline-offset-2 hover:underline">{fmtMnt(d.amount)}</span>
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-gray-500">{d.user}</td>
                    </tr>,
                    isOpen && (
                      <tr key={`${k}-lines`} className="border-b border-blue-100 bg-blue-50/30">
                        <td/>
                        <td colSpan={multi ? 8 : 7} className="px-2 pb-2 pt-1">
                          <table className="w-full text-[11px]">
                            <thead><tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                              <th className="px-1.5 py-1">Код</th><th className="px-1.5 py-1">Бараа</th><th className="px-1.5 py-1">Байршил</th>
                              <th className="px-1.5 py-1 text-right">Тоо</th><th className="px-1.5 py-1 text-right">Нэгж үнэ</th>
                              <th className="px-1.5 py-1 text-right">Дүн</th>
                              {d.discount ? <th className="px-1.5 py-1 text-right">Хөнгөлөлт</th> : null}
                            </tr></thead>
                            <tbody>
                              {d.lines.map((l, i) => (
                                <tr key={i} className="border-t border-blue-100/70">
                                  <td className="px-1.5 py-0.5 font-mono text-gray-500">{l[0]}</td>
                                  <td className="px-1.5 py-0.5 text-gray-800">{l[1]}</td>
                                  <td className="px-1.5 py-0.5 text-gray-500">{l[2]}</td>
                                  <td className="px-1.5 py-0.5 text-right font-mono tabular-nums">{fmtQty(l[3])}</td>
                                  <td className="px-1.5 py-0.5 text-right font-mono tabular-nums">{fmtAmt(l[4])}</td>
                                  <td className="px-1.5 py-0.5 text-right font-mono font-semibold tabular-nums">{fmtAmt(l[5])}</td>
                                  {d.discount ? <td className="px-1.5 py-0.5 text-right font-mono tabular-nums text-gray-500">{fmtAmt(l[6])}</td> : null}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
              <tfoot className="sticky bottom-0 bg-white">
                <tr className="border-t border-gray-200 font-bold">
                  <td colSpan={multi ? 6 : 5} className="px-2 py-1.5 text-gray-500">Нийт {docs.length} баримт</td>
                  <td className="px-2 py-1.5 text-right text-gray-500">{docs.reduce((n, d) => n + d.lines.length, 0)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtMnt(data.total)}</td>
                  <td/>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/** НӨАТ чөлөөлөгдөх дүн — сараар горимд дарж оруулна (Enter/blur хадгална, Esc болино). */
function ExemptCell({ value, editable, onSave }: { value: number; editable: boolean; onSave: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);
  if (!editable) return <span className={value ? "text-amber-700" : "text-gray-300"}>{fmtMnt(value)}</span>;
  function commit() {
    setEditing(false);
    const t = draft.replace(/[\s,]/g, "");
    const v = t === "" ? 0 : Number(t);
    if (Number.isFinite(v) && Math.abs(v - (value || 0)) > 0.004) onSave(Math.round(v * 100) / 100);
  }
  if (editing) {
    return (
      <input ref={ref} value={draft} inputMode="decimal" onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className="w-full rounded border border-amber-400 bg-white px-1 py-0.5 text-right font-mono text-[11px] outline-none ring-2 ring-amber-200"/>
    );
  }
  return (
    <div onClick={() => { setDraft(value ? String(value) : ""); setEditing(true); }} title="НӨАТ чөлөөлөгдөх дүн оруулах"
      className={`cursor-pointer rounded px-1 py-0.5 hover:bg-amber-50 hover:text-amber-700 ${value ? "font-semibold text-amber-700" : "text-gray-300"}`}>
      {value ? fmtMnt(value) : "—"}
    </div>
  );
}

// Баганын шүүлтүүдийн анхны утга
const EMPTY_COL_FILTERS = {
  employee: "", code: "", name: "", registry: "", phone: "", note: "",
  po: "", vo: "", eo: "", do_: "", ph: "", vh: "", eh: "", dh: "",
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

  // Сараар | Нэгтгэсэн (сонгосон сарууд / бүтэн он)
  const [mode, setMode] = useState<"month" | "range">("month");
  const [avail, setAvail] = useState<MonthAvail[]>([]);
  const [rangeMonths, setRangeMonths] = useState<number[]>([]);
  // Ebarimt (НӨАТ) дүн дээр дарахад — тухайн харилцагчийн шивсэн баримтууд
  const [entries, setEntries] = useState<{ row: ReportRow; which: Which } | null>(null);
  // ХА дүн дээр дарахад — орлогын файлын баримтууд → бараа
  const [purchases, setPurchases] = useState<{ row: ReportRow; which: Which } | null>(null);

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

  async function loadRange(y = year, ms = rangeMonths) {
    if (!ms.length) { setReport(null); return; }
    setLoading(true);
    try {
      const r = await api.get("/ebarimt/report-range", { params: { year: y, months: ms.join(",") }, timeout: 180000 });
      setReport(r.data);
      setErr("");
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Нэгтгэсэн тайлан ачааллах амжилтгүй");
    } finally { setLoading(false); }
  }
  const reload = () => (mode === "month" ? loadReport() : loadRange());

  useEffect(() => { if (mode === "month") loadReport(year, month); }, [year, month, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Нэгтгэсэн: тухайн оны файлтай саруудыг аваад анхдагчаар Data-тай бүх сарыг сонгоно
  useEffect(() => {
    if (mode !== "range") return;
    let alive = true;
    api.get("/ebarimt/months", { params: { year } }).then(r => {
      if (!alive) return;
      const list: MonthAvail[] = Array.isArray(r.data) ? r.data : [];
      setAvail(list);
      setRangeMonths(list.filter(x => x.kinds.includes("data")).map(x => x.month));
    }).catch(() => { if (alive) { setAvail([]); setRangeMonths([]); } });
    return () => { alive = false; };
  }, [mode, year]);
  useEffect(() => {
    if (mode !== "range") return;
    const t = setTimeout(() => loadRange(year, rangeMonths), 250);     // сар дараалан дарахад нэг л удаа ачаална
    return () => clearTimeout(t);
  }, [mode, year, rangeMonths]); // eslint-disable-line react-hooks/exhaustive-deps

  // Сар/горим солигдоход шүүлтийг цэвэрлэнэ (ажилтны сонголт хадгална — өдөр тутмын хэрэглээ)
  useEffect(() => { setSearch(""); setColFilters({ ...EMPTY_COL_FILTERS }); }, [year, month, mode]);

  function switchMode(m: "month" | "range") {
    if (m === mode) return;
    setReport(null);
    setShowFiles(false);
    setMode(m);
  }
  const hasData = (m: number) => !!avail.find(x => x.month === m)?.kinds.includes("data");
  const toggleMonth = (m: number) =>
    setRangeMonths(ms => (ms.includes(m) ? ms.filter(x => x !== m) : [...ms, m].sort((a, b) => a - b)));
  const pickMonths = (ms: number[]) => setRangeMonths(ms.filter(hasData));
  const usedMonths = mode === "month" ? [month] : (report?.months ?? rangeMonths);

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

  // НӨАТ чөлөөлөгдөх дүн — мөрийг шууд шинэчилж (Зөрүү дахин бодогдоно), дараа нь хадгална
  async function saveExempt(code: string, which: Which, amount: number) {
    const k = which === "orgil" ? "exempt_orgil" : "exempt_harhorin";
    const dk = which === "orgil" ? "diff_orgil" : "diff_harhorin";
    setReport(prev => prev ? {
      ...prev,
      rows: prev.rows.map(x => x.code !== code ? x : { ...x, [k]: amount, [dk]: x[dk] + (x[k] || 0) - amount }),
    } : prev);
    try {
      await api.put("/ebarimt/exempt", { year, month, code, which, amount });
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Чөлөөлөгдөх дүн хадгалах амжилтгүй");
      await reload();
    }
  }

  // Харилцагчийн мэдээллийн гар засвар (Ажилтан/Регистр/Утас/Тайлбар).
  // value=null → анхны (Data) утгад буцаана. Регистр солигдвол Ebarimt дүн
  // дахин тооцоологддог тул тайланг backend-ээс шинэчилж авна.
  async function saveOverride(code: string, field: string, value: string | null) {
    try {
      await api.put("/ebarimt/customer-override", { code, field, value });
      await reload();
    } catch { setErr("Засвар хадгалах амжилтгүй"); }
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
    if (!numOk(r.exempt_orgil || 0, cf.eo)) return false;
    if (!diffOk(r.diff_orgil, cf.do_)) return false;
    if (!numOk(r.purchase_harhorin, cf.ph)) return false;
    if (!numOk(r.vat_harhorin, cf.vh)) return false;
    if (!numOk(r.exempt_harhorin || 0, cf.eh)) return false;
    if (!diffOk(r.diff_harhorin, cf.dh)) return false;
    return true;
  });
  const hasColFilters = Object.values(colFilters).some(v => v !== "");

  const tot = filtered.reduce((a, r) => ({
    po: a.po + r.purchase_orgil, vo: a.vo + r.vat_orgil, eo: a.eo + (r.exempt_orgil || 0),
    ph: a.ph + r.purchase_harhorin, vh: a.vh + r.vat_harhorin, eh: a.eh + (r.exempt_harhorin || 0),
  }), { po: 0, vo: 0, eo: 0, ph: 0, vh: 0, eh: 0 });

  const missingCount = rows.filter(r => r.diff_orgil > 0.5 || r.diff_harhorin > 0.5).length;
  // Файлууд n/5: Ebarimt цэсний 3 файл + салбар бүрийн орлогын файл (Файл оруулалт)
  const uploadedCount = report
    ? FILE_SLOTS.filter(s => report.files?.[s.kind]).length
      + PURCHASE_CARDS.filter(c => report.purchase_source?.[c.which]?.source === "income").length
    : 0;
  const totalSlots = FILE_SLOTS.length + PURCHASE_CARDS.length;

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

        {/* Сараар | Нэгтгэсэн */}
        <div className="flex rounded-xl bg-gray-100 p-0.5 text-[12px] font-semibold">
          <button onClick={() => switchMode("month")}
            className={`rounded-lg px-3 py-1.5 transition-colors ${mode === "month" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>
            Сараар
          </button>
          <button onClick={() => switchMode("range")} title="Сонгосон сарууд эсвэл бүтэн оны нэгтгэсэн тайлан"
            className={`flex items-center gap-1 rounded-lg px-3 py-1.5 transition-colors ${mode === "range" ? "bg-white text-indigo-700 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>
            <CalendarRange size={12}/>Нэгтгэсэн
          </button>
        </div>

        {/* Month nav (сараар) / Year nav (нэгтгэсэн) */}
        <div className="flex items-center gap-1 rounded-2xl bg-gray-50 p-1 ring-1 ring-gray-100">
          <button onClick={mode === "month" ? prevMonth : () => setYear(y => y - 1)}
            className="grid h-8 w-8 place-items-center rounded-xl text-gray-400 hover:bg-white hover:text-gray-700 transition-colors">
            <ChevronLeft size={15}/>
          </button>
          <div className="px-2 text-center min-w-[86px]">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 leading-none">{mode === "month" ? year : "Нэгтгэсэн"}</div>
            <div className="text-[13px] font-bold text-gray-900 leading-tight">{mode === "month" ? MN_MONTHS[month - 1] : `${year} он`}</div>
          </div>
          <button onClick={mode === "month" ? nextMonth : () => setYear(y => y + 1)}
            className="grid h-8 w-8 place-items-center rounded-xl text-gray-400 hover:bg-white hover:text-gray-700 transition-colors">
            <ChevronRight size={15}/>
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Files toggle */}
          {mode === "month" && <button onClick={() => setShowFiles(v => !v)}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-semibold transition-colors ${
              showFiles
                ? "bg-[#0071E3] text-white shadow-sm shadow-blue-500/25"
                : uploadedCount < totalSlots
                  ? "border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
                  : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}>
            <FileSpreadsheet size={13}/>
            Файлууд {uploadedCount}/{totalSlots}
          </button>}
          <button onClick={() => reload()} disabled={loading}
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
      {showFiles && mode === "month" && (
        <div className="shrink-0 border-b border-gray-100 bg-gray-50/50 px-4 py-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {[FILE_SLOTS[0], ...PURCHASE_CARDS, ...FILE_SLOTS.slice(1)].map(item => {
              if ("which" in item) {
                return <PurchaseSourceCard key={item.which} card={item}
                  src={report?.purchase_source?.[item.which]} legacy={report?.files?.[item.which]}/>;
              }
              const slot = item;
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

      {/* ── Нэгтгэсэн: сар сонголт ─────────────────────────────── */}
      {mode === "range" && (
        <div className="shrink-0 border-b border-gray-100 bg-indigo-50/30 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11.5px] font-semibold text-gray-600">Сарууд:</span>
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
              const a = avail.find(x => x.month === m);
              const has = !!a?.kinds.includes("data");
              const on = rangeMonths.includes(m);
              return (
                <button key={m} onClick={() => toggleMonth(m)} disabled={!has}
                  title={!a ? "Файл оруулаагүй" : !has ? "Data файл оруулаагүй" : a.complete ? `${m}-р сар — бүх файл бүрэн` : `${m}-р сар — дутуу: ${monthMissing(a).join(", ")}`}
                  className={`relative h-7 min-w-[34px] rounded-lg px-2 text-[12px] font-semibold transition-colors ${
                    on ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/25"
                    : has ? "bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-indigo-50"
                    : "cursor-not-allowed bg-transparent text-gray-300"}`}>
                  {m}
                  {a && !a.complete && has && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400"/>}
                </button>
              );
            })}
            <span className="mx-1 h-5 w-px bg-gray-200"/>
            {([["Бүтэн он", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]], ["I улирал", [1, 2, 3]], ["II", [4, 5, 6]],
               ["III", [7, 8, 9]], ["IV", [10, 11, 12]]] as [string, number[]][]).map(([l, ms]) => (
              <button key={l} onClick={() => pickMonths(ms)} disabled={!ms.some(hasData)}
                className="rounded-lg px-2 py-1 text-[11.5px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:text-gray-300">
                {l}
              </button>
            ))}
            <span className="ml-auto text-[11.5px] text-gray-500">
              {year} · <b className="text-gray-800">{monthsLabel(usedMonths)}</b>
            </span>
          </div>
          {!!(report?.skipped?.length || (report?.missing && !Array.isArray(report.missing) && Object.keys(report.missing).length)) && (
            <div className="mt-1.5 text-[11.5px] text-amber-700">
              {!!report?.skipped?.length && <>Data файлгүй тул орхисон: {monthsLabel(report.skipped)}. </>}
              {report?.missing && !Array.isArray(report.missing) && Object.entries(report.missing).map(([m, ks]) =>
                `${m}-р сар: ${ks.map(k => KIND_LABEL[k] ?? k).join(", ")} дутуу`).join(" · ")}
            </div>
          )}
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
          {(report?.employees ?? []).map(e => {
            const orphan = e.name === ORPHAN_EMP;
            return (
              <button key={e.name} onClick={() => setSelectedEmp(e.name)}
                title={orphan ? "Худалдан авалт байгаа ч Data файлд бүртгэлгүй харилцагчид" : undefined}
                className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                  selectedEmp === e.name
                    ? orphan
                      ? "bg-amber-500 text-white shadow-sm shadow-amber-500/25"
                      : "bg-indigo-600 text-white shadow-sm shadow-indigo-500/25"
                    : orphan
                      ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}>
                {orphan && <UserX size={11}/>}
                {e.name} ({e.customers})
              </button>
            );
          })}
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
          <button onClick={() => { if (mode === "range") switchMode("month"); setShowFiles(true); }}
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
                <th className="bg-blue-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-amber-700" title="Оргил — НӨАТ чөлөөлөгдөх дүн (Зөрүү = ХА − Ebarimt − чөлөөлөгдөх)">НӨАТ чөлөөлөгдөх</th>
                <th className="border-r border-blue-100 bg-blue-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-blue-700">Зөрүү</th>
                <th className="bg-violet-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-violet-700">Хархорин ХА</th>
                <th className="bg-violet-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-violet-700">Хархорин Ebarimt</th>
                <th className="bg-violet-50/40 px-2 pt-2.5 pb-1 text-right text-[10px] font-bold uppercase tracking-wider text-amber-700" title="Хархорин — НӨАТ чөлөөлөгдөх дүн (Зөрүү = ХА − Ebarimt − чөлөөлөгдөх)">НӨАТ чөлөөлөгдөх</th>
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
                <th className="bg-blue-50/40 px-1 pb-1.5"><NumFilterSelect value={colFilters.eo} onChange={setCF("eo")}/></th>
                <th className="border-r border-blue-100 bg-blue-50/40 px-1 pb-1.5"><DiffFilterSelect value={colFilters.do_} onChange={setCF("do_")}/></th>
                <th className="bg-violet-50/40 px-1 pb-1.5"><NumFilterSelect value={colFilters.ph} onChange={setCF("ph")}/></th>
                <th className="bg-violet-50/40 px-1 pb-1.5"><NumFilterSelect value={colFilters.vh} onChange={setCF("vh")}/></th>
                <th className="bg-violet-50/40 px-1 pb-1.5"><NumFilterSelect value={colFilters.eh} onChange={setCF("eh")}/></th>
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
                      r.is_orphan ? "bg-amber-50/40 hover:bg-amber-50/70"
                      : hasMissing ? "bg-rose-50/30 hover:bg-rose-50/60"
                      : "hover:bg-gray-50/60"
                    }`}>
                    <td className="px-2 py-1.5 text-center text-[10px] text-gray-300">{i + 1}</td>
                    <td className="px-1 py-1 min-w-[112px]">
                      <EditableCell
                        value={r.employee === ORPHAN_EMP ? "" : r.employee}
                        defaultValue={r.defaults?.employee}
                        placeholder={r.is_orphan ? "Ажилтан оноох…" : "Ажилтан…"}
                        onSave={v => saveOverride(r.code, "employee", v)}
                        onRevert={() => saveOverride(r.code, "employee", null)}/>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap font-mono text-[11px] text-gray-500">
                      {r.is_orphan && (
                        <span title="Data файлд байхгүй харилцагч"
                          className="mr-1 inline-flex items-center rounded bg-amber-100 px-1 py-0.5 text-[9px] font-semibold text-amber-700">
                          <UserX size={8}/>
                        </span>
                      )}
                      {r.code}
                    </td>
                    <td className="px-2 py-1.5 max-w-[220px]">
                      <div className="truncate font-medium text-gray-900" title={r.name}>{r.name || "—"}</div>
                      <EditableCell
                        value={r.tailbar} defaultValue={r.defaults?.tailbar}
                        placeholder="Тайлбар (Data)…"
                        onSave={v => saveOverride(r.code, "tailbar", v)}
                        onRevert={() => saveOverride(r.code, "tailbar", null)}/>
                    </td>
                    <td className="px-1 py-1 min-w-[104px]">
                      <EditableCell
                        value={r.registry} defaultValue={r.defaults?.registry}
                        placeholder="Регистр…" mono
                        onSave={v => saveOverride(r.code, "registry", v)}
                        onRevert={() => saveOverride(r.code, "registry", null)}/>
                    </td>
                    <td className="px-1 py-1 min-w-[96px]">
                      <div className="flex items-center gap-0.5">
                        {r.phone && (
                          <a href={`tel:${r.phone}`} title="Залгах"
                            className="shrink-0 text-gray-400 hover:text-blue-600"><Phone size={9}/></a>
                        )}
                        <div className="min-w-0 flex-1">
                          <EditableCell
                            value={r.phone} defaultValue={r.defaults?.phone}
                            placeholder="Утас…" mono
                            onSave={v => saveOverride(r.code, "phone", v)}
                            onRevert={() => saveOverride(r.code, "phone", null)}/>
                        </div>
                      </div>
                    </td>
                    <td className="border-l border-blue-100 px-1 py-1 text-right font-mono tabular-nums text-[11.5px]">
                      <button onClick={() => setPurchases({ row: r, which: "orgil" })} title="Дарж орлогын баримтууд, бараануудыг харах"
                        className="w-full rounded px-1 py-0.5 text-right text-gray-700 underline-offset-2 hover:bg-blue-50 hover:text-blue-700 hover:underline">
                        {fmtMnt(r.purchase_orgil)}
                      </button>
                    </td>
                    <td className="px-1 py-1 text-right font-mono tabular-nums text-[11.5px]">
                      <button onClick={() => setEntries({ row: r, which: "orgil" })} title={`${r.cnt_orgil} баримт — дарж шивсэн баримтуудыг харах`}
                        className="w-full rounded px-1 py-0.5 text-right text-gray-700 underline-offset-2 hover:bg-blue-50 hover:text-blue-700 hover:underline">
                        {fmtMnt(r.vat_orgil)}
                      </button>
                    </td>
                    <td className="px-1 py-1 text-right font-mono tabular-nums text-[11.5px] min-w-[84px]">
                      <ExemptCell value={r.exempt_orgil || 0} editable={mode === "month"} onSave={v => saveExempt(r.code, "orgil", v)}/>
                    </td>
                    <td className="border-r border-blue-100 px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px]">{diffCell(r.diff_orgil)}</td>
                    <td className="px-1 py-1 text-right font-mono tabular-nums text-[11.5px]">
                      <button onClick={() => setPurchases({ row: r, which: "harhorin" })} title="Дарж орлогын баримтууд, бараануудыг харах"
                        className="w-full rounded px-1 py-0.5 text-right text-gray-700 underline-offset-2 hover:bg-violet-50 hover:text-violet-700 hover:underline">
                        {fmtMnt(r.purchase_harhorin)}
                      </button>
                    </td>
                    <td className="px-1 py-1 text-right font-mono tabular-nums text-[11.5px]">
                      <button onClick={() => setEntries({ row: r, which: "harhorin" })} title={`${r.cnt_harhorin} баримт — дарж шивсэн баримтуудыг харах`}
                        className="w-full rounded px-1 py-0.5 text-right text-gray-700 underline-offset-2 hover:bg-violet-50 hover:text-violet-700 hover:underline">
                        {fmtMnt(r.vat_harhorin)}
                      </button>
                    </td>
                    <td className="px-1 py-1 text-right font-mono tabular-nums text-[11.5px] min-w-[84px]">
                      <ExemptCell value={r.exempt_harhorin || 0} editable={mode === "month"} onSave={v => saveExempt(r.code, "harhorin", v)}/>
                    </td>
                    <td className="border-r border-violet-100 px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px]">{diffCell(r.diff_harhorin)}</td>
                    <td className="px-1 py-1 min-w-[140px] max-w-[220px]">
                      {mode === "month" ? <NoteCell value={r.note || ""} onSave={v => saveNote(r.code, v)}/> : (
                        <div className="truncate px-1.5 py-0.5 text-[11px] text-gray-600" title={r.note || "Тайлбарыг сар сонгож бичнэ"}>
                          {r.note || <span className="text-gray-300">—</span>}
                        </div>
                      )}
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
                  <td className="bg-blue-50/40 px-2 py-2 text-right font-mono tabular-nums text-amber-700">{fmtMnt(tot.eo)}</td>
                  <td className="border-r border-blue-100 bg-blue-50/40 px-2 py-2 text-right font-mono tabular-nums">{diffCell(tot.po - tot.vo - tot.eo)}</td>
                  <td className="bg-violet-50/40 px-2 py-2 text-right font-mono tabular-nums text-violet-800">{fmtMnt(tot.ph)}</td>
                  <td className="bg-violet-50/40 px-2 py-2 text-right font-mono tabular-nums text-violet-800">{fmtMnt(tot.vh)}</td>
                  <td className="bg-violet-50/40 px-2 py-2 text-right font-mono tabular-nums text-amber-700">{fmtMnt(tot.eh)}</td>
                  <td className="border-r border-violet-100 bg-violet-50/40 px-2 py-2 text-right font-mono tabular-nums">{diffCell(tot.ph - tot.vh - tot.eh)}</td>
                  <td/>
                </tr>
              </tfoot>
            )}
          </table>
          {entries && (
            <EntriesModal row={entries.row} which={entries.which} year={year} months={usedMonths} onClose={() => setEntries(null)}/>
          )}
          {purchases && (
            <PurchasesModal row={purchases.row} which={purchases.which} year={year} months={usedMonths} onClose={() => setPurchases(null)}/>
          )}
          {filtered.length === 0 && (
            <div className="flex flex-col items-center py-14 text-gray-400 gap-2">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gray-50">
                <Search size={22} className="opacity-40"/>
              </div>
              <p className="text-[13px] font-semibold text-gray-600">{mode === "range" && !rangeMonths.length ? "Нэгтгэх саруудаа сонгоно уу" : "Илэрц олдсонгүй"}</p>
              <p className="text-[11px] text-gray-400">{mode === "range" && !rangeMonths.length ? "Дээрх сарууд дээр дарж сонгоно" : "Шүүлтээ өөрчилж үзнэ үү"}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
