import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X, Printer, RefreshCw, Search, CheckCircle2, AlertTriangle, Download, RotateCcw } from "lucide-react";
import { api } from "../lib/api";

// Тооллогын хуудас (Эрхэт) — таарсан / таараагүй, брэндээр бүлэглэсэн, шалтгааны тайлбартай.
// Зөрүү = Тооллого − Програм (дутагдал сөрөг), Зөрүүний дүн = Зөрүү × Зарах үнэ.
// Тоолсон тоо эсвэл зөрүүг засаж болно (дахин тоолсон г.м.) — анхны утга доор нь харагдана.

type Row = {
  code: string; name: string; brand: string; program: number | null;
  counted: number | null; counted_orig: number | null; diff: number; diff_orig: number;
  price: number; amount: number; amount_orig: number; adjusted: boolean;
  note: string; note_by: string; note_at: string | null; counted_by: string; counted_at: string | null;
};
type Totals = {
  items: number; matched: number; unmatched: number; surplus_n: number; shortage_n: number;
  surplus_qty: number; shortage_qty: number; surplus_amt: number; shortage_amt: number; net_qty: number; net_amt: number;
  adjusted: number; net_qty_orig: number; net_amt_orig: number;
};
type FileInfo = { id: number; original_filename: string; uploaded_at: string | null };
type CompareData = {
  count: { id: number; warehouse_label: string; count_date: string; description: string };
  file: FileInfo; files: FileInfo[]; rows: Row[]; groups: { brand: string }[];
};
type View = "unmatched" | "matched" | "adjusted" | "all";
type SaveState = "saving" | "saved" | "error";

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf3 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const fq = (v: number | null | undefined, sign = false) => (v == null ? "" : `${sign && v > 0 ? "+" : ""}${nf3.format(v)}`);
const fa = (v: number | null | undefined, sign = false) => (v == null ? "" : `${sign && v > 0 ? "+" : ""}${nf0.format(Math.round(v))}`);
const tone = (v: number) => (v < 0 ? "text-red-600" : v > 0 ? "text-emerald-600" : "text-gray-400");
const ymdDots = (iso: string) => iso.split("-").join(".");
const pad = (n: number) => String(n).padStart(2, "0");
/** Сервер UTC-ээр хадгалдаг → локал цаг. */
const when = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** «2,376» (мянгатын таслал), «12,5» (аравтын таслал), «+16», «-28» → тоо. */
function parseNum(s: string): number | null {
  let t = s.replace(/\s/g, "");
  t = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : null;
}

function sumUp(rows: Row[]): Totals {
  const t: Totals = { items: rows.length, matched: 0, unmatched: 0, surplus_n: 0, shortage_n: 0, surplus_qty: 0,
    shortage_qty: 0, surplus_amt: 0, shortage_amt: 0, net_qty: 0, net_amt: 0, adjusted: 0, net_qty_orig: 0, net_amt_orig: 0 };
  for (const r of rows) {
    if (r.diff > 0) { t.surplus_n++; t.surplus_qty += r.diff; t.surplus_amt += r.amount; }
    else if (r.diff < 0) { t.shortage_n++; t.shortage_qty += r.diff; t.shortage_amt += r.amount; }
    else t.matched++;
    if (r.adjusted) t.adjusted++;
    t.net_qty_orig += r.diff_orig;
    t.net_amt_orig += r.amount_orig;
  }
  t.unmatched = t.surplus_n + t.shortage_n;
  t.net_qty = t.surplus_qty + t.shortage_qty;
  t.net_amt = t.surplus_amt + t.shortage_amt;
  return t;
}

/** Тоолсон тоог солиход Зөрүү, дүн дагаж өөрчлөгдөнө; null → файлын анхны утга. */
function withCounted(r: Row, c: number | null): Row {
  const diff = c == null ? r.diff_orig : Math.round((c - (r.program ?? 0)) * 1000) / 1000;
  return { ...r, counted: c ?? r.counted_orig, diff, amount: Math.round(diff * r.price * 100) / 100, adjusted: c != null };
}

const blobDetail = async (e: any, fallback: string) => {
  try { const t = await e?.response?.data?.text?.(); return JSON.parse(t ?? "").detail ?? fallback; }
  catch { return typeof e?.response?.data?.detail === "string" ? e.response.data.detail : fallback; }
};

/** PDF-ийг нуугдмал iframe-д ачаалж хөтөчийн хэвлэх цонхыг шууд нээнэ (болохгүй бол шинэ табд). */
function printPdf(url: string) {
  const ifr = document.createElement("iframe");
  ifr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  ifr.src = url;
  ifr.onload = () => {
    try { ifr.contentWindow?.focus(); ifr.contentWindow?.print(); }
    catch { window.open(url, "_blank"); }
    setTimeout(() => { ifr.remove(); URL.revokeObjectURL(url); }, 60_000);
  };
  document.body.appendChild(ifr);
}

export default function InventoryCountCompare({ countId, fileId, onClose }: {
  countId: number; fileId: number | null; onClose: () => void;
}) {
  const [fid, setFid] = useState<number | null>(fileId);
  const [data, setData] = useState<CompareData | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [view, setView] = useState<View>("unmatched");
  const [brand, setBrand] = useState("");
  const [q, setQ] = useState("");
  const [pinned, setPinned] = useState<Set<string>>(new Set());     // энэ удаа зассан мөр — таб/шүүлт солигдтол харагдана
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [noteState, setNoteState] = useState<Record<string, SaveState>>({});
  const [adjState, setAdjState] = useState<Record<string, SaveState>>({});
  const [pdfBusy, setPdfBusy] = useState<"print" | "download" | null>(null);
  const pending = useRef(new Set<Promise<unknown>>());

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr("");
    api.get(`/inventory-count/counts/${countId}/compare`, { params: fid ? { excel_file_id: fid } : {}, timeout: 120000 })
      .then((r) => { if (alive && r.data?.rows) { setData(r.data); setRows(r.data.rows); setDrafts({}); setPinned(new Set()); } })
      .catch((e) => { if (alive) { setErr(e?.response?.data?.detail ?? "Тооллогын хуудсыг уншихад алдаа гарлаа."); setData(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [countId, fid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input")) onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  useEffect(() => { setPinned(new Set()); }, [view, brand, q]);

  const flash = (msg: string) => { setErr(msg); setTimeout(() => setErr((m) => (m === msg ? "" : m)), 4000); };
  const markSaved = (set: typeof setNoteState, code: string) => {
    set((s) => ({ ...s, [code]: "saved" }));
    setTimeout(() => set((s) => { const n = { ...s }; if (n[code] === "saved") delete n[code]; return n; }), 1500);
  };
  const track = (p: Promise<unknown>) => { pending.current.add(p); p.finally(() => pending.current.delete(p)); };

  const total = useMemo(() => sumUp(rows), [rows]);
  const brandStats = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) m.set(r.brand, [...(m.get(r.brand) ?? []), r]);
    return new Map([...m].map(([b, rs]) => [b, sumUp(rs)]));
  }, [rows]);

  // Брэнд → мөрүүд (сервер эрэмбэлсэн дарааллаар), таб + брэнд + хайлтаар шүүсэн
  const needle = q.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!data) return [] as { brand: string; rows: Row[] }[];
    const byBrand = new Map<string, Row[]>();
    for (const r of rows) {
      if (brand && r.brand !== brand) continue;
      if (needle && !`${r.code} ${r.name} ${r.brand}`.toLowerCase().includes(needle)) continue;
      if (!pinned.has(r.code)) {
        if (view === "unmatched" && !r.diff) continue;
        if (view === "matched" && r.diff) continue;
        if (view === "adjusted" && !r.adjusted) continue;
      }
      byBrand.set(r.brand, [...(byBrand.get(r.brand) ?? []), r]);
    }
    return data.groups.filter((g) => byBrand.has(g.brand)).map((g) => ({ brand: g.brand, rows: byBrand.get(g.brand)! }));
  }, [data, rows, view, brand, needle, pinned]);
  const shown = useMemo(() => sumUp(visible.flatMap((g) => g.rows)), [visible]);
  const filtered = !!brand || !!needle || view === "adjusted";

  const saveNote = (code: string) => {
    const row = rows.find((r) => r.code === code);
    const draft = drafts[code];
    if (row == null || draft == null || draft.trim() === (row.note ?? "")) return;
    setNoteState((s) => ({ ...s, [code]: "saving" }));
    track(api.put(`/inventory-count/counts/${countId}/notes`, { code, note: draft })
      .then((r) => {
        setRows((rs) => rs.map((x) => (x.code === code ? { ...x, note: r.data.note, note_by: r.data.note_by, note_at: r.data.note_at } : x)));
        setDrafts((m) => { const n = { ...m }; delete n[code]; return n; });
        markSaved(setNoteState, code);
      })
      .catch(() => setNoteState((s) => ({ ...s, [code]: "error" }))));
  };

  /** Тоолсон тоог засна (null = анхны утга руу буцаах). Зөрүүг засвал тоолсон = Програм + зөрүү. */
  const saveCounted = (code: string, value: number | null) => {
    const prev = rows.find((r) => r.code === code);
    if (!prev) return;
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      flash(`${code}: тоолсон тоо сөрөг гарч байна (${fq(value)}) — Програм ${fq(prev.program)}, зөрүүг шалгана уу.`);
      return;
    }
    const c = value != null && prev.counted_orig != null && Math.abs(value - prev.counted_orig) < 1e-9 ? null : value;
    if (c === (prev.adjusted ? prev.counted : null)) return;
    setRows((rs) => rs.map((x) => (x.code === code ? withCounted(x, c) : x)));
    setPinned((p) => new Set(p).add(code));
    setAdjState((s) => ({ ...s, [code]: "saving" }));
    track(api.put(`/inventory-count/counts/${countId}/adjust`, { code, counted: c })
      .then((r) => {
        setRows((rs) => rs.map((x) => (x.code === code ? { ...x, counted_by: r.data.counted_by, counted_at: r.data.counted_at } : x)));
        markSaved(setAdjState, code);
      })
      .catch((e) => {
        setRows((rs) => rs.map((x) => (x.code === code ? prev : x)));
        setAdjState((s) => ({ ...s, [code]: "error" }));
        flash(e?.response?.data?.detail ?? `${code}: тоог хадгалж чадсангүй.`);
      }));
  };

  const getPdf = async (mode: "print" | "download") => {
    if (!data) return;
    (document.activeElement as HTMLElement | null)?.blur?.();       // бичиж байсан утгыг хадгална
    await new Promise((r) => setTimeout(r, 0));
    await Promise.allSettled([...pending.current]);
    setPdfBusy(mode); setErr("");
    try {
      const r = await api.get(`/inventory-count/counts/${countId}/compare/pdf`, {
        params: { excel_file_id: data.file.id, ...(brand ? { brand } : {}) }, responseType: "blob", timeout: 120000,
      });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
      if (mode === "print") { printPdf(url); return; }
      const a = document.createElement("a");
      a.href = url; a.download = `Тооллогын_зөрүү_${data.count.count_date}${brand ? `_${brand}` : ""}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e: any) {
      setErr(await blobDetail(e, "PDF гаргахад алдаа гарлаа."));
    } finally { setPdfBusy(null); }
  };

  const t = total;
  let no = 0;

  return (
    <div className="fixed inset-0 z-50 flex bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-white shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Толгой */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-100 px-4 py-3 sm:px-5">
          <div className="order-1 min-w-0 flex-1">
            <div className="text-base font-bold text-gray-900">Тооллогын хуудас — таарсан / таараагүй</div>
            {data && (
              <div className="truncate text-[12.5px] text-gray-500">
                {data.count.warehouse_label} · <b className="text-gray-700">{ymdDots(data.count.count_date)}</b>
                {data.count.description ? ` · ${data.count.description}` : ""}
              </div>
            )}
          </div>
          <div className="order-3 flex w-full flex-wrap items-center gap-2 sm:order-2 sm:w-auto">
            {data && data.files.length > 1 && (
              <select value={data.file.id} onChange={(e) => setFid(Number(e.target.value))}
                className="min-w-0 max-w-[260px] flex-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 outline-none sm:flex-none">
                {data.files.map((f) => <option key={f.id} value={f.id}>{f.original_filename}</option>)}
              </select>
            )}
            <button onClick={() => getPdf("download")} disabled={!data || !!pdfBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              title={brand ? `«${brand}» брэндийн зөрүүтэй бараа — A4 хэвтээ PDF` : "Зөрүүтэй бүх бараа — A4 хэвтээ PDF татах"}>
              {pdfBusy === "download" ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />} PDF
            </button>
            <button onClick={() => getPdf("print")} disabled={!data || !!pdfBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#0071E3] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              title={brand ? `Зөвхөн «${brand}» брэнд — A4 хэвтээ, хуудасны дугаар, огноо, тайлбартай`
                : "Зөрүүтэй бүх бараа, бүх багана — A4 хэвтээ, хуудасны дугаар, огноо, тайлбартай"}>
              {pdfBusy === "print" ? <RefreshCw size={13} className="animate-spin" /> : <Printer size={13} />}
              {brand ? "Хэвлэх (энэ брэнд)" : "Хэвлэх (A4)"}
            </button>
          </div>
          <button onClick={onClose} className="order-2 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 sm:order-3" title="Хаах (Esc)">
            <X size={18} />
          </button>
        </div>

        {err && <div className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700 sm:mx-5">{err}</div>}

        {loading && !data ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-gray-400"><RefreshCw size={16} className="animate-spin" /> Тооллогын хуудсыг уншиж байна…</div>
        ) : !data ? (
          <div className="flex-1" />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Нийт дүн (засварласан утгаар) */}
            <div className="grid grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-3 sm:px-5 lg:grid-cols-6">
              <Stat label="Нийт бараа" value={nf0.format(t.items)} sub={data.file.original_filename} />
              <Stat label="Таарсан" value={nf0.format(t.matched)} cls="text-emerald-700" icon={<CheckCircle2 size={13} className="text-emerald-600" />} />
              <Stat label="Таараагүй" value={nf0.format(t.unmatched)} cls="text-amber-700" icon={<AlertTriangle size={13} className="text-amber-500" />}
                sub={`илүүдэл ${t.surplus_n} · дутагдал ${t.shortage_n}`} />
              <Stat label="Илүүдэл" value={`${fq(t.surplus_qty, true)} ш`} cls="text-emerald-700" sub={`${fa(t.surplus_amt, true)}₮`} />
              <Stat label="Дутагдал" value={`${fq(t.shortage_qty)} ш`} cls="text-red-600" sub={`${fa(t.shortage_amt)}₮`} />
              <Stat label="Бүх барааны нийт зөрүү" value={`${fa(t.net_amt, true)}₮`} cls={tone(t.net_amt)} strong
                sub={`${fq(t.net_qty, true)} ш${t.adjusted ? ` · анх ${fa(t.net_amt_orig, true)}₮` : ""}`} />
            </div>

            {/* Шүүлт: таб · брэнд · хайлт */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5">
              {([["unmatched", "Таараагүй", t.unmatched], ["matched", "Таарсан", t.matched], ["adjusted", "Засагдсан", t.adjusted],
                 ["all", "Бүгд", t.items]] as const).map(([k, l, n]) => (k === "adjusted" && !n && view !== k ? null : (
                <button key={k} onClick={() => setView(k)}
                  className={`rounded-full px-3 py-1 text-[12px] font-semibold ring-1 ring-inset ${view === k
                    ? ({ matched: "bg-emerald-600 ring-emerald-600", unmatched: "bg-amber-500 ring-amber-500", adjusted: "bg-violet-600 ring-violet-600", all: "bg-gray-800 ring-gray-800" }[k] + " text-white")
                    : "bg-white text-gray-600 ring-gray-200 hover:bg-gray-50"}`}>
                  {l} <span className="tabular-nums opacity-80">{nf0.format(n)}</span>
                </button>
              )))}
              <select value={brand} onChange={(e) => setBrand(e.target.value)}
                className={`max-w-[260px] rounded-lg border px-2.5 py-1.5 text-[12.5px] outline-none ${brand ? "border-emerald-300 bg-emerald-50 font-semibold text-emerald-800" : "border-gray-200 bg-white text-gray-700"}`}
                title="Брэндээр шүүх">
                <option value="">Бүх брэнд ({data.groups.length})</option>
                {data.groups.map((g) => {
                  const s = brandStats.get(g.brand);
                  return <option key={g.brand} value={g.brand}>{g.brand} — {s?.unmatched ?? 0}/{s?.items ?? 0}</option>;
                })}
              </select>
              <div className="relative ml-auto w-full sm:w-64">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Код, нэр, брэнд…"
                  className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-2 text-[12.5px] outline-none focus:border-blue-400" />
              </div>
            </div>

            {/* Хүснэгт */}
            <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 sm:px-5">
              <table className="w-full min-w-[1040px] border-separate border-spacing-0 text-[12.5px]">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-[#1F4E78] text-left text-[11.5px] font-semibold text-white">
                    <th className="w-10 rounded-tl-lg px-2 py-2 text-center">№</th>
                    <th className="w-24 px-2 py-2">Код</th>
                    <th className="px-2 py-2">Нэр</th>
                    <th className="w-20 px-2 py-2 text-right">Програм</th>
                    <th className="w-24 px-2 py-2 text-right" title="Засах боломжтой — анхны утга доор нь">Тооллого ✎</th>
                    <th className="w-24 px-2 py-2 text-right" title="Засах боломжтой — тоолсон = Програм + зөрүү">Зөрүү ✎</th>
                    <th className="w-24 px-2 py-2 text-right">Зарах үнэ</th>
                    <th className="w-28 px-2 py-2 text-right">Зөрүүний дүн</th>
                    <th className="w-[24%] rounded-tr-lg px-2 py-2">Тайлбар (шалтгаан)</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr><td colSpan={9} className="px-3 py-10 text-center text-gray-400">
                      {view === "unmatched" && !needle && !brand ? "Зөрүүтэй бараа алга — бүх бараа таарсан." : "Илэрц алга."}
                    </td></tr>
                  )}
                  {visible.map(({ brand: b, rows: rs }) => (
                    <BrandBlock key={b} brand={b} t={sumUp(rs)} active={brand === b} onPick={() => setBrand(brand === b ? "" : b)}>
                      {rs.map((r) => {
                        no += 1;
                        const draft = drafts[r.code];
                        const ns = noteState[r.code];
                        const as = adjState[r.code];
                        const by = r.counted_by ? `Зассан: ${r.counted_by} · ${when(r.counted_at)}` : "";
                        return (
                          <tr key={`${b}-${r.code}`} className={`align-top ${r.adjusted ? "bg-violet-50/50" : ""} hover:bg-blue-50/40`}>
                            <td className="border-b border-gray-100 px-2 py-1.5 text-center tabular-nums text-gray-400">{no}</td>
                            <td className="border-b border-gray-100 px-2 py-1.5 font-mono text-[12px] text-gray-600">{r.code}</td>
                            <td className="border-b border-gray-100 px-2 py-1.5 text-gray-800">{r.name}</td>
                            <td className="border-b border-gray-100 px-2 py-1.5 text-right tabular-nums">{fq(r.program)}</td>
                            <td className="border-b border-gray-100 px-1 py-1 text-right">
                              <div className="relative">
                                <NumInput value={r.counted} invalid={as === "error"} onCommit={(v) => saveCounted(r.code, v)} />
                                <span className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2">
                                  {as === "saving" && <RefreshCw size={10} className="animate-spin text-gray-400" />}
                                  {as === "saved" && <CheckCircle2 size={11} className="text-emerald-500" />}
                                </span>
                              </div>
                              {r.adjusted && (
                                <div className="flex items-center justify-end gap-1 px-1 text-[10.5px] text-gray-400" title={by}>
                                  анх {fq(r.counted_orig)}
                                  <button onClick={() => saveCounted(r.code, null)} className="rounded p-0.5 text-violet-500 hover:bg-violet-100"
                                    title="Анхны утга руу буцаах">
                                    <RotateCcw size={10} />
                                  </button>
                                </div>
                              )}
                            </td>
                            <td className="border-b border-gray-100 px-1 py-1 text-right">
                              <NumInput value={r.diff} sign className={`font-bold ${tone(r.diff)}`}
                                onCommit={(v) => saveCounted(r.code, Math.round(((r.program ?? 0) + v) * 1000) / 1000)} />
                              {r.adjusted && <div className="px-1 text-[10.5px] text-gray-400" title={by}>анх {fq(r.diff_orig, true)}</div>}
                            </td>
                            <td className="border-b border-gray-100 px-2 py-1.5 text-right tabular-nums text-gray-600">{fa(r.price)}</td>
                            <td className={`border-b border-gray-100 px-2 py-1.5 text-right font-semibold tabular-nums ${tone(r.amount)}`}>
                              {fa(r.amount, true)}
                              {r.adjusted && <div className="text-[10.5px] font-normal text-gray-400">анх {fa(r.amount_orig, true)}</div>}
                            </td>
                            <td className="border-b border-gray-100 px-2 py-1">
                              {r.diff || r.adjusted || r.note ? (
                                <div className="relative">
                                  <input
                                    value={draft ?? r.note}
                                    onChange={(e) => setDrafts((m) => ({ ...m, [r.code]: e.target.value }))}
                                    onBlur={() => saveNote(r.code)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                      if (e.key === "Escape") setDrafts((m) => { const n = { ...m }; delete n[r.code]; return n; });
                                    }}
                                    placeholder={r.diff < 0 ? "Дутагдлын шалтгаан…" : r.diff > 0 ? "Илүүдлийн шалтгаан…" : "Засварын тайлбар…"}
                                    title={r.note_by ? `${r.note_by} · ${when(r.note_at)}` : ""}
                                    maxLength={1000}
                                    className={`w-full rounded-md border px-2 py-1 pr-6 text-[12px] outline-none focus:border-blue-400 ${ns === "error" ? "border-red-300 bg-red-50" : "border-gray-200"}`}
                                  />
                                  <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2">
                                    {ns === "saving" && <RefreshCw size={11} className="animate-spin text-gray-400" />}
                                    {ns === "saved" && <CheckCircle2 size={12} className="text-emerald-500" />}
                                    {ns === "error" && <AlertTriangle size={12} className="text-red-500" />}
                                  </span>
                                </div>
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </BrandBlock>
                  ))}
                </tbody>
                {visible.length > 0 && (
                  <tfoot className="sticky bottom-0">
                    {filtered && <TotalRow label={`Шүүлтийн дүн — ${nf0.format(shown.items)} бараа${brand ? ` · ${brand}` : ""}`} t={shown} bg="bg-amber-50" border="border-amber-200" />}
                    <TotalRow label="Бүх барааны нийт зөрүү" t={t} bg="bg-blue-50" border="border-blue-200" />
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Тоон нүд — дарахад засна, Enter/гарахад хадгална, Esc-ээр болино. */
function NumInput({ value, sign, className = "", invalid, onCommit }: {
  value: number | null; sign?: boolean; className?: string; invalid?: boolean; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancel = useRef(false);
  return (
    <input
      value={draft ?? fq(value, sign)}
      inputMode="decimal"
      onFocus={(e) => { cancel.current = false; setDraft(value == null ? "" : String(value)); const el = e.target; requestAnimationFrame(() => el.select()); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const d = draft;
        setDraft(null);
        if (cancel.current || d == null || d.trim() === "") return;
        const v = parseNum(d);
        if (v != null && v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { cancel.current = true; e.currentTarget.blur(); }
      }}
      className={`w-full rounded-md border bg-transparent px-1 py-0.5 text-right tabular-nums outline-none hover:border-gray-300 focus:border-blue-400 focus:bg-white ${invalid ? "border-red-300" : "border-transparent"} ${className}`}
    />
  );
}

function Stat({ label, value, sub, cls = "text-gray-900", icon, strong }: {
  label: string; value: string; sub?: string; cls?: string; icon?: ReactNode; strong?: boolean;
}) {
  return (
    <div className={`min-w-0 rounded-xl border px-3 py-2 ${strong ? "border-blue-200 bg-blue-50/60" : "border-gray-100 bg-gray-50/60"}`}>
      <div className="flex items-center gap-1 text-[11px] font-medium text-gray-500">{icon}{label}</div>
      <div className={`truncate text-[17px] font-black tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="truncate text-[11px] text-gray-500" title={sub}>{sub}</div>}
    </div>
  );
}

function TotalRow({ label, t, bg, border }: { label: string; t: Totals; bg: string; border: string }) {
  return (
    <tr className={`font-bold text-gray-900 ${bg}`}>
      <td colSpan={5} className={`border-t px-2 py-2 text-right ${border}`}>
        {label}
        <span className="ml-2 font-normal text-gray-500">
          (илүүдэл {fq(t.surplus_qty, true)} ш / {fa(t.surplus_amt, true)}₮ · дутагдал {fq(t.shortage_qty)} ш / {fa(t.shortage_amt)}₮)
        </span>
      </td>
      <td className={`border-t px-2 py-2 text-right tabular-nums ${border} ${tone(t.net_qty)}`}>{fq(t.net_qty, true)}</td>
      <td className={`border-t ${border}`} />
      <td className={`border-t px-2 py-2 text-right tabular-nums ${border} ${tone(t.net_amt)}`}>{fa(t.net_amt, true)}₮</td>
      <td className={`border-t ${border}`} />
    </tr>
  );
}

function BrandBlock({ brand, t, active, onPick, children }: {
  brand: string; t: Totals; active: boolean; onPick: () => void; children: ReactNode;
}) {
  return (
    <>
      <tr>
        <td colSpan={9} className="border-b border-emerald-100 bg-emerald-50/70 px-2 py-1.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <button onClick={onPick} className="text-[13px] font-bold text-gray-900 hover:text-emerald-700 hover:underline"
              title={active ? "Бүх брэндийг харуулах" : "Зөвхөн энэ брэндийг харах"}>
              {brand}{active && <span className="ml-1.5 text-[11px] font-semibold text-emerald-700">✕ шүүлт</span>}
            </button>
            <span className="text-[11.5px] text-gray-500">{t.items} бараа{t.adjusted ? ` · ${t.adjusted} засагдсан` : ""}</span>
            <span className="ml-auto text-[11.5px] tabular-nums text-gray-600">
              Илүүдэл <b className="text-emerald-700">{fq(t.surplus_qty, true)} ш · {fa(t.surplus_amt, true)}₮</b>
              <span className="mx-1.5 text-gray-300">|</span>
              Дутагдал <b className="text-red-600">{fq(t.shortage_qty)} ш · {fa(t.shortage_amt)}₮</b>
              <span className="mx-1.5 text-gray-300">|</span>
              Нийт <b className={tone(t.net_amt)}>{fa(t.net_amt, true)}₮</b>
            </span>
          </div>
        </td>
      </tr>
      {children}
    </>
  );
}
