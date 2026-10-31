import { useEffect, useRef, useState } from "react";
import { X, Download, RefreshCw, AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import { api } from "../lib/api";

// Тооллогын хуудас → Эрхэтийн импорт Excel: илүүдэл = «Бараа материалын орлого»,
// дутагдал = «Бараа материалын хангамжын зарлага». Нэгж үнэ = өртөг (Эрхэтийн байршлын өртгийг
// арын ажлаар ~1-2 минут татна) эсвэл зарах үнэ. Логик: backend/app/services/count_erkhet.py

type Brief = { code: string; name: string; qty: number; price: number; sell: number; src: string };
type KindPreview = { rows: number; pieces: number; amount: number; by_src: Record<string, number>; review: Brief[]; skipped: Brief[] };
type CostState = { status: "none" | "running" | "done" | "error"; fetched_at?: string; started_at?: string; n?: number; fresh?: boolean; error?: string };
type Info = {
  defaults: { location: string; date: string; mode: string; customer: string; related_account: string; account: string };
  locations: { code: string; name: string }[];
  price_src_label: Record<string, string>;
  kind_label: Record<"income" | "expense", string>;
  cost: CostState;
  preview: Record<"income" | "expense", KindPreview> | null;
};
type Mode = "cost" | "sell";

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const pad = (n: number) => String(n).padStart(2, "0");
/** Сервер UTC-ээр хадгалдаг → локал цаг. */
const hm = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const detail = async (e: any, fallback: string) => {
  try { const t = await e?.response?.data?.text?.(); return JSON.parse(t ?? "").detail ?? fallback; }
  catch { return typeof e?.response?.data?.detail === "string" ? e.response.data.detail : fallback; }
};
const KIND_TITLE = { income: "Орлого — илүүдэл", expense: "Зарлага — дутагдал" } as const;

export default function CountErkhetExport({ countId, fileId, flush, onClose }: {
  countId: number; fileId: number; flush?: () => Promise<void>; onClose: () => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loc, setLoc] = useState("");
  const [day, setDay] = useState("");
  const [mode, setMode] = useState<Mode>("cost");
  const [noCost, setNoCost] = useState(false);
  const [cust, setCust] = useState("");
  const [rel, setRel] = useState("");
  const [acc, setAcc] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "income" | "expense" | "cost">("");
  const [showReview, setShowReview] = useState(false);
  const autoStarted = useRef(new Set<string>());

  const load = async (l = loc, d = day, m = mode, nc = noCost) => {
    try {
      const r = await api.get(`/inventory-count/counts/${countId}/erkhet-export`, {
        params: { excel_file_id: fileId, mode: m, no_erkhet_cost: nc, ...(l ? { location: l } : {}), ...(d ? { date: d } : {}) },
        timeout: 120000,
      });
      const x: Info = r.data;
      setInfo(x);
      if (!l) {                                               // эхний ачаалалт — анхдагч утгууд
        setLoc(x.defaults.location); setDay(x.defaults.date);
        setCust(x.defaults.customer); setRel(x.defaults.related_account); setAcc(x.defaults.account);
      }
      return x;
    } catch (e: any) {
      setErr(await detail(e, "Мэдээлэл ачаалахад алдаа гарлаа."));
      return null;
    }
  };

  const startCost = async (force = false) => {
    if (!loc || !day) return;
    setBusy("cost"); setErr("");
    try {
      await api.post(`/inventory-count/counts/${countId}/erkhet-export/costs`, { location: loc, date: day, force });
      await load();
    } catch (e: any) {
      setErr(await detail(e, "Эрхэтээс өртөг татаж эхлүүлж чадсангүй."));
    } finally { setBusy(""); }
  };

  useEffect(() => { load("", "", "cost", false); }, [countId, fileId]);           // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {                                           // байршил/огноо/горим солигдоход дахин ачаална
    if (loc && day) load(loc, day, mode, noCost);
  }, [loc, day, mode, noCost]);                               // eslint-disable-line react-hooks/exhaustive-deps

  // Өртөг татагдаагүй бол нэг удаа автоматаар эхлүүлнэ; татаж байх хооронд 4 сек тутам шалгана
  const st = info?.cost.status;
  useEffect(() => {
    if (mode !== "cost" || !loc || !day || !info) return;
    const key = `${loc}|${day}`;
    if (st === "none" && !autoStarted.current.has(key)) { autoStarted.current.add(key); startCost(); }
    if (st !== "running") return;
    const t = setInterval(() => load(), 4000);
    return () => clearInterval(t);
  }, [st, loc, day, mode, info]);                             // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = async (kind: "income" | "expense") => {
    setBusy(kind); setErr("");
    try {
      await flush?.();
      const r = await api.post(`/inventory-count/counts/${countId}/erkhet-export/file`, {
        kind, location: loc, date: day, excel_file_id: fileId, mode, no_erkhet_cost: noCost,
        customer: cust, related_account: rel, account: acc,
      }, { responseType: "blob", timeout: 180000 });
      const cd = String(r.headers?.["content-disposition"] ?? "");
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      const fname = m ? decodeURIComponent(m[1]) : `toollogo_${countId}_${kind}.xlsx`;
      const url = URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement("a");
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e: any) {
      setErr(await detail(e, "Файл гаргахад алдаа гарлаа."));
    } finally { setBusy(""); }
  };

  const pv = info?.preview;
  const cost = info?.cost;
  const locName = info?.locations.find((l) => l.code === loc)?.name ?? "";
  const review = pv ? [...pv.income.review.map((r) => ({ ...r, kind: "income" as const })),
                      ...pv.expense.review.map((r) => ({ ...r, kind: "expense" as const }))] : [];
  const field = "w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 outline-none focus:border-blue-400";

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-gray-900">Эрхэт рүү импортлох файл</div>
            <div className="text-[12.5px] text-gray-500">Илүүдэл → Бараа материалын орлого · Дутагдал → Бараа материалын хангамжын зарлага</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Хаах (Esc)"><X size={18} /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!info ? (
            <div className="flex items-center gap-2 py-10 text-sm text-gray-400"><RefreshCw size={16} className="animate-spin" /> Ачаалж байна…</div>
          ) : (
            <>
              {/* Тохиргоо */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <label className="col-span-2 sm:col-span-2">
                  <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">Байршил</span>
                  <select value={loc} onChange={(e) => setLoc(e.target.value)} className={field}>
                    {info.locations.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
                  </select>
                </label>
                <label className="col-span-2 sm:col-span-1">
                  <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">Огноо</span>
                  <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className={field} />
                </label>
                <label>
                  <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">Харилцагч</span>
                  <input value={cust} onChange={(e) => setCust(e.target.value.trim())} className={field} />
                </label>
                <label>
                  <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">Харьцсан данс</span>
                  <input value={rel} onChange={(e) => setRel(e.target.value.trim())} className={field} />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="w-28">
                  <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">Данс</span>
                  <input value={acc} onChange={(e) => setAcc(e.target.value.trim())} className={field} />
                </label>
                <div>
                  <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">Нэгж үнэ</span>
                  <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
                    {([["cost", "Өртгөөр"], ["sell", "Зарах үнээр"]] as const).map(([k, l]) => (
                      <button key={k} onClick={() => setMode(k)}
                        className={`rounded-md px-3 py-1 text-[12.5px] font-semibold ${mode === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Эрхэтийн өртгийн төлөв */}
              {mode === "cost" && cost && (
                <div className={`mt-3 rounded-xl px-3.5 py-2.5 text-[12.5px] ${cost.status === "error" ? "bg-red-50 text-red-700"
                  : cost.status === "done" ? "bg-emerald-50 text-emerald-800" : "bg-blue-50 text-blue-800"}`}>
                  {cost.status === "running" || busy === "cost" ? (
                    <span className="inline-flex items-center gap-2"><RefreshCw size={14} className="animate-spin" />
                      {loc} {locName}-ын нэгж өртгийг Эрхэтээс татаж байна… (1–2 минут, зөвхөн уншина)</span>
                  ) : cost.status === "done" ? (
                    <span className="inline-flex flex-wrap items-center gap-x-2">
                      <CheckCircle2 size={14} /> Эрхэтийн өртөг: {loc} {locName}, {day} · {nf0.format(cost.n ?? 0)} бараа · {hm(cost.fetched_at)}-д татсан
                      {!cost.fresh && <b>(хуучирсан)</b>}
                      <button onClick={() => startCost(true)} className="font-semibold underline">Дахин татах</button>
                    </span>
                  ) : cost.status === "error" ? (
                    <div className="space-y-1.5">
                      <div className="flex items-start gap-1.5"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> Эрхэтээс өртөг татаж чадсангүй: {cost.error}</div>
                      <div className="flex flex-wrap items-center gap-3">
                        <button onClick={() => startCost(true)} className="font-semibold underline">Дахин оролдох</button>
                        <label className="inline-flex items-center gap-1.5 text-gray-700">
                          <input type="checkbox" checked={noCost} onChange={(e) => setNoCost(e.target.checked)} />
                          Эрхэтийн байршлын өртөггүйгээр гаргах (агуулахын өртөг / сүүлийн үнэ / зарах үнэ)
                        </label>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => startCost()} className="font-semibold underline">Эрхэтээс өртөг татах</button>
                  )}
                </div>
              )}

              {err && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{err}</div>}

              {/* Орлого / зарлага */}
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {(["income", "expense"] as const).map((k) => {
                  const p = pv?.[k];
                  return (
                    <div key={k} className="rounded-xl border border-gray-200 p-3.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="text-[13.5px] font-bold text-gray-900">{KIND_TITLE[k]}</div>
                        <div className="text-[11px] text-gray-400">{info.kind_label[k]}</div>
                      </div>
                      {p ? (
                        <>
                          <div className={`mt-1 text-xl font-bold ${k === "income" ? "text-emerald-700" : "text-red-600"}`}>{nf0.format(p.amount)}₮</div>
                          <div className="text-[12px] text-gray-500">{p.rows} мөр · {nf2.format(p.pieces)} ширхэг</div>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {Object.entries(p.by_src).filter(([, n]) => n > 0).map(([s, n]) => (
                              <span key={s} className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${s === "sell" && mode === "cost" ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-600"}`}>
                                {info.price_src_label[s] ?? s}: {n}
                              </span>
                            ))}
                          </div>
                          {p.skipped.length > 0 && (
                            <div className="mt-1.5 text-[11.5px] text-red-600">Үнэгүй тул хасагдах: {p.skipped.map((r) => r.code).join(", ")}</div>
                          )}
                        </>
                      ) : (
                        <div className="mt-2 text-[12px] text-gray-400">{mode === "cost" ? "Эрхэтийн өртөг татагдсаны дараа тооцоолно." : "—"}</div>
                      )}
                      <button onClick={() => download(k)} disabled={!p || !p.rows || !!busy || !loc}
                        className={`mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-40 ${k === "income" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700"}`}>
                        {busy === k ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />} {k === "income" ? "Орлогын" : "Зарлагын"} Excel татах
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Зарах үнээр бодсон (өртөг олдоогүй) мөрүүд */}
              {mode === "cost" && review.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60">
                  <button onClick={() => setShowReview((v) => !v)} className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[12.5px] font-semibold text-amber-900">
                    <AlertTriangle size={14} /> Шалгах: {review.length} барааны өртөг олдоогүй тул зарах үнээр бодсон
                    <ChevronDown size={14} className={`ml-auto transition ${showReview ? "rotate-180" : ""}`} />
                  </button>
                  {showReview && (
                    <div className="max-h-56 overflow-y-auto border-t border-amber-200 px-3.5 py-2">
                      <table className="w-full text-[12px]">
                        <tbody>
                          {review.map((r) => (
                            <tr key={`${r.kind}${r.code}`} className="border-b border-amber-100 last:border-0">
                              <td className="py-1 pr-2 font-mono text-gray-600">{r.code}</td>
                              <td className="py-1 pr-2 text-gray-800">{r.name}</td>
                              <td className={`py-1 pr-2 text-right ${r.kind === "income" ? "text-emerald-700" : "text-red-600"}`}>{r.kind === "income" ? "+" : "−"}{nf2.format(r.qty)}</td>
                              <td className="py-1 text-right text-gray-700">{nf0.format(r.price)}₮</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 rounded-xl bg-gray-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-gray-600">
                <b className="text-gray-800">Файл бүрийг Эрхэтэд НЭГ л удаа импортлоно</b> — дахин импортловол зөрүү 2 удаа бүртгэгдэнэ.
                Эрхэтийн «Файл импортлох» дээр төрлийг орлогын файлд <b>«Бараа материалын орлого»</b>, зарлагын файлд
                <b> «Бараа материалын хангамжын зарлага»</b> гэж сонгоно. Тоо = тооллогын хуудасны (засварласан) зөрүү.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
