import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X, Printer, RefreshCw, Search, CheckCircle2, AlertTriangle, Download } from "lucide-react";
import { api } from "../lib/api";

// Тооллогын хуудас (Эрхэт) — таарсан / таараагүй, брэндээр бүлэглэсэн, шалтгааны тайлбартай.
// Зөрүү = Тооллого − Програм (дутагдал сөрөг), Зөрүүний дүн = Зөрүү × Зарах үнэ.

type Row = {
  code: string; name: string; brand: string; program: number | null; counted: number | null;
  diff: number; price: number; amount: number; note: string; note_by: string; note_at: string | null;
};
type Totals = {
  items: number; matched: number; unmatched: number; surplus_n: number; shortage_n: number;
  surplus_qty: number; shortage_qty: number; surplus_amt: number; shortage_amt: number; net_qty: number; net_amt: number;
};
type Group = Totals & { brand: string };
type FileInfo = { id: number; original_filename: string; uploaded_at: string | null };
type CompareData = {
  count: { id: number; warehouse_label: string; count_date: string; description: string };
  file: FileInfo; files: FileInfo[]; rows: Row[]; groups: Group[]; totals: Totals;
};
type View = "unmatched" | "matched" | "all";

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf3 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const fq = (v: number | null | undefined, sign = false) => (v == null ? "" : `${sign && v > 0 ? "+" : ""}${nf3.format(v)}`);
const fa = (v: number | null | undefined, sign = false) => (v == null ? "" : `${sign && v > 0 ? "+" : ""}${nf0.format(Math.round(v))}`);
const tone = (v: number) => (v < 0 ? "text-red-600" : v > 0 ? "text-emerald-600" : "text-gray-400");
const ymdDots = (iso: string) => iso.split("-").join(".");

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
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [view, setView] = useState<View>("unmatched");
  const [q, setQ] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [pdfBusy, setPdfBusy] = useState<"print" | "download" | null>(null);
  const pending = useRef(new Set<Promise<unknown>>());

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr("");
    api.get(`/inventory-count/counts/${countId}/compare`, { params: fid ? { excel_file_id: fid } : {}, timeout: 120000 })
      .then((r) => { if (alive && r.data?.rows) { setData(r.data); setDrafts({}); } })
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

  // Брэнд → мөрүүд (сервер эрэмбэлсэн дарааллаар), шүүлт + хайлттай
  const visible = useMemo(() => {
    if (!data) return [] as { g: Group; rows: Row[] }[];
    const needle = q.trim().toLowerCase();
    const byBrand = new Map<string, Row[]>();
    for (const r of data.rows) {
      if (view === "unmatched" && !r.diff) continue;
      if (view === "matched" && r.diff) continue;
      if (needle && !`${r.code} ${r.name} ${r.brand}`.toLowerCase().includes(needle)) continue;
      const list = byBrand.get(r.brand) ?? [];
      list.push(r);
      byBrand.set(r.brand, list);
    }
    return data.groups.filter((g) => byBrand.has(g.brand)).map((g) => ({ g, rows: byBrand.get(g.brand)! }));
  }, [data, view, q]);

  const saveNote = (code: string) => {
    if (!data) return;
    const row = data.rows.find((r) => r.code === code);
    const draft = drafts[code];
    if (row == null || draft == null || draft.trim() === (row.note ?? "")) return;
    setSaveState((s) => ({ ...s, [code]: "saving" }));
    const p = api.put(`/inventory-count/counts/${countId}/notes`, { code, note: draft })
      .then((r) => {
        setData((d) => d && { ...d, rows: d.rows.map((x) => (x.code === code ? { ...x, note: r.data.note, note_by: r.data.note_by, note_at: r.data.note_at } : x)) });
        setDrafts((m) => { const n = { ...m }; delete n[code]; return n; });
        setSaveState((s) => ({ ...s, [code]: "saved" }));
        setTimeout(() => setSaveState((s) => { const n = { ...s }; if (n[code] === "saved") delete n[code]; return n; }), 1500);
      })
      .catch(() => setSaveState((s) => ({ ...s, [code]: "error" })))
      .finally(() => pending.current.delete(p));
    pending.current.add(p);
  };

  const getPdf = async (mode: "print" | "download") => {
    if (!data) return;
    (document.activeElement as HTMLElement | null)?.blur?.();       // бичиж байсан тайлбарыг хадгална
    await Promise.allSettled([...pending.current]);
    setPdfBusy(mode); setErr("");
    try {
      const r = await api.get(`/inventory-count/counts/${countId}/compare/pdf`, {
        params: { excel_file_id: data.file.id }, responseType: "blob", timeout: 120000,
      });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
      if (mode === "print") { printPdf(url); return; }
      const a = document.createElement("a");
      a.href = url; a.download = `Тооллогын_зөрүү_${data.count.count_date}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e: any) {
      setErr(await blobDetail(e, "PDF гаргахад алдаа гарлаа."));
    } finally { setPdfBusy(null); }
  };

  const t = data?.totals;
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
            title="Зөрүүтэй бүх бараа — A4 хэвтээ PDF татах">
            {pdfBusy === "download" ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />} PDF
          </button>
          <button onClick={() => getPdf("print")} disabled={!data || !!pdfBusy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#0071E3] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            title="Зөрүүтэй бүх бараа, бүх багана — A4 хэвтээ, хуудасны дугаар, огноо, тайлбартай">
            {pdfBusy === "print" ? <RefreshCw size={13} className="animate-spin" /> : <Printer size={13} />} Хэвлэх (A4)
          </button>
          </div>
          <button onClick={onClose} className="order-2 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 sm:order-3" title="Хаах (Esc)">
            <X size={18} />
          </button>
        </div>

        {err && <div className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700 sm:mx-5">{err}</div>}

        {loading && !data ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-gray-400"><RefreshCw size={16} className="animate-spin" /> Тооллогын хуудсыг уншиж байна…</div>
        ) : !data || !t ? (
          <div className="flex-1" />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Нийт дүн */}
            <div className="grid grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-3 sm:px-5 lg:grid-cols-6">
              <Stat label="Нийт бараа" value={nf0.format(t.items)} sub={data.file.original_filename} />
              <Stat label="Таарсан" value={nf0.format(t.matched)} cls="text-emerald-700" icon={<CheckCircle2 size={13} className="text-emerald-600" />} />
              <Stat label="Таараагүй" value={nf0.format(t.unmatched)} cls="text-amber-700" icon={<AlertTriangle size={13} className="text-amber-500" />}
                sub={`илүүдэл ${t.surplus_n} · дутагдал ${t.shortage_n}`} />
              <Stat label="Илүүдэл" value={`${fq(t.surplus_qty, true)} ш`} cls="text-emerald-700" sub={`${fa(t.surplus_amt, true)}₮`} />
              <Stat label="Дутагдал" value={`${fq(t.shortage_qty)} ш`} cls="text-red-600" sub={`${fa(t.shortage_amt)}₮`} />
              <Stat label="Бүх барааны нийт зөрүү" value={`${fa(t.net_amt, true)}₮`} cls={tone(t.net_amt)} sub={`${fq(t.net_qty, true)} ш`} strong />
            </div>

            {/* Шүүлт */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5">
              {([["unmatched", "Таараагүй", t.unmatched], ["matched", "Таарсан", t.matched], ["all", "Бүгд", t.items]] as const).map(([k, l, n]) => (
                <button key={k} onClick={() => setView(k)}
                  className={`rounded-full px-3 py-1 text-[12px] font-semibold ring-1 ring-inset ${view === k
                    ? (k === "matched" ? "bg-emerald-600 text-white ring-emerald-600" : k === "unmatched" ? "bg-amber-500 text-white ring-amber-500" : "bg-gray-800 text-white ring-gray-800")
                    : "bg-white text-gray-600 ring-gray-200 hover:bg-gray-50"}`}>
                  {l} <span className="tabular-nums opacity-80">{nf0.format(n)}</span>
                </button>
              ))}
              <div className="relative ml-auto w-full sm:w-64">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Код, нэр, брэнд…"
                  className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-2 text-[12.5px] outline-none focus:border-blue-400" />
              </div>
            </div>

            {/* Хүснэгт */}
            <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 sm:px-5">
              <table className="w-full min-w-[1000px] border-separate border-spacing-0 text-[12.5px]">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-[#1F4E78] text-left text-[11.5px] font-semibold text-white">
                    <th className="w-10 rounded-tl-lg px-2 py-2 text-center">№</th>
                    <th className="w-24 px-2 py-2">Код</th>
                    <th className="px-2 py-2">Нэр</th>
                    <th className="w-20 px-2 py-2 text-right">Програм</th>
                    <th className="w-20 px-2 py-2 text-right">Тооллого</th>
                    <th className="w-20 px-2 py-2 text-right">Зөрүү</th>
                    <th className="w-24 px-2 py-2 text-right">Зарах үнэ</th>
                    <th className="w-28 px-2 py-2 text-right">Зөрүүний дүн</th>
                    <th className="w-[26%] rounded-tr-lg px-2 py-2">Тайлбар (шалтгаан)</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr><td colSpan={9} className="px-3 py-10 text-center text-gray-400">
                      {view === "unmatched" && !q ? "Зөрүүтэй бараа алга — бүх бараа таарсан." : "Илэрц алга."}
                    </td></tr>
                  )}
                  {visible.map(({ g, rows }) => (
                    <BrandBlock key={g.brand} g={g}>
                      {rows.map((r) => {
                        no += 1;
                        const draft = drafts[r.code];
                        const st = saveState[r.code];
                        return (
                          <tr key={`${g.brand}-${r.code}`} className="align-top hover:bg-blue-50/40">
                            <td className="border-b border-gray-100 px-2 py-1.5 text-center tabular-nums text-gray-400">{no}</td>
                            <td className="border-b border-gray-100 px-2 py-1.5 font-mono text-[12px] text-gray-600">{r.code}</td>
                            <td className="border-b border-gray-100 px-2 py-1.5 text-gray-800">{r.name}</td>
                            <td className="border-b border-gray-100 px-2 py-1.5 text-right tabular-nums">{fq(r.program)}</td>
                            <td className="border-b border-gray-100 px-2 py-1.5 text-right tabular-nums">{fq(r.counted)}</td>
                            <td className={`border-b border-gray-100 px-2 py-1.5 text-right font-bold tabular-nums ${tone(r.diff)}`}>{fq(r.diff, true)}</td>
                            <td className="border-b border-gray-100 px-2 py-1.5 text-right tabular-nums text-gray-600">{fa(r.price)}</td>
                            <td className={`border-b border-gray-100 px-2 py-1.5 text-right font-semibold tabular-nums ${tone(r.amount)}`}>{fa(r.amount, true)}</td>
                            <td className="border-b border-gray-100 px-2 py-1">
                              {r.diff ? (
                                <div className="relative">
                                  <input
                                    value={draft ?? r.note}
                                    onChange={(e) => setDrafts((m) => ({ ...m, [r.code]: e.target.value }))}
                                    onBlur={() => saveNote(r.code)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                      if (e.key === "Escape") setDrafts((m) => { const n = { ...m }; delete n[r.code]; return n; });
                                    }}
                                    placeholder={r.diff < 0 ? "Дутагдлын шалтгаан…" : "Илүүдлийн шалтгаан…"}
                                    title={r.note_by ? `${r.note_by} · ${r.note_at?.slice(0, 16).replace("T", " ") ?? ""}` : ""}
                                    maxLength={1000}
                                    className={`w-full rounded-md border px-2 py-1 pr-6 text-[12px] outline-none focus:border-blue-400 ${st === "error" ? "border-red-300 bg-red-50" : "border-gray-200"}`}
                                  />
                                  <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2">
                                    {st === "saving" && <RefreshCw size={11} className="animate-spin text-gray-400" />}
                                    {st === "saved" && <CheckCircle2 size={12} className="text-emerald-500" />}
                                    {st === "error" && <AlertTriangle size={12} className="text-red-500" />}
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
                    <tr className="bg-blue-50 font-bold text-gray-900">
                      <td colSpan={5} className="rounded-bl-lg border-t border-blue-200 px-2 py-2 text-right">
                        Бүх барааны нийт зөрүү
                        <span className="ml-2 font-normal text-gray-500">
                          (илүүдэл {fq(t.surplus_qty, true)} ш / {fa(t.surplus_amt, true)}₮ · дутагдал {fq(t.shortage_qty)} ш / {fa(t.shortage_amt)}₮)
                        </span>
                      </td>
                      <td className={`border-t border-blue-200 px-2 py-2 text-right tabular-nums ${tone(t.net_qty)}`}>{fq(t.net_qty, true)}</td>
                      <td className="border-t border-blue-200" />
                      <td className={`border-t border-blue-200 px-2 py-2 text-right tabular-nums ${tone(t.net_amt)}`}>{fa(t.net_amt, true)}₮</td>
                      <td className="rounded-br-lg border-t border-blue-200" />
                    </tr>
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

function BrandBlock({ g, children }: { g: Group; children: ReactNode }) {
  return (
    <>
      <tr>
        <td colSpan={9} className="border-b border-emerald-100 bg-emerald-50/70 px-2 py-1.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-[13px] font-bold text-gray-900">{g.brand}</span>
            <span className="text-[11.5px] text-gray-500">{g.unmatched} зөрүүтэй / {g.items} бараа</span>
            <span className="ml-auto text-[11.5px] tabular-nums text-gray-600">
              Илүүдэл <b className="text-emerald-700">{fq(g.surplus_qty, true)} ш · {fa(g.surplus_amt, true)}₮</b>
              <span className="mx-1.5 text-gray-300">|</span>
              Дутагдал <b className="text-red-600">{fq(g.shortage_qty)} ш · {fa(g.shortage_amt)}₮</b>
              <span className="mx-1.5 text-gray-300">|</span>
              Нийт <b className={tone(g.net_amt)}>{fa(g.net_amt, true)}₮</b>
            </span>
          </div>
        </td>
      </tr>
      {children}
    </>
  );
}
