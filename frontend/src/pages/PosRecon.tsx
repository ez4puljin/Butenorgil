import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarCheck, ChevronLeft, ChevronRight, RefreshCw, AlertCircle, X,
  Loader2, Undo2, ArrowRightLeft, ShoppingCart, ChevronDown,
} from "lucide-react";
import { api } from "../lib/api";

// Касс → erxes → Эрхэт гэсэн ХОЁР шатны тулгалт.
// Тэнцэл: кассын нийт = erxes дээрх + буцаалт. Зөрвөл л жинхэнэ алдагдал.
interface DayCell {
  day: string; status: "ok" | "warn" | "bad" | "online" | "none";
  local: number; erxes: number; returns: number;
  unexplained: number; unsynced: number; pos_count: number;
}
interface MonthData { year: number; month: number; days: DayCell[]; enabled: boolean }
interface PosRow {
  pos_name: string; local_count: number; erxes_count: number;
  returns_count: number; unexplained: number; synced_count: number;
  unsynced_count: number; status: string; error: string; checked_at: string | null;
}
interface ReturnRow {
  _id: string; number?: string; amount?: number | null;
  returned_at?: string; returned_by: string; cashier?: string;
}
interface DayData {
  day: string; rows: PosRow[]; returns: ReturnRow[];
  status: string; checked: boolean;
}
interface RunStatus {
  running: boolean; total: number; done: number; day: string;
  message: string; error: string; log: string[];
}

// Кассын төлөгдөөгүй захиалга — erxes зөвхөн төлөгдсөнийг авдаг тул тэнд огт байхгүй
interface UnpaidOrder {
  pos_name: string; _id: string; number: string; status: string; sale_status: string;
  created_at: string; modified_at: string; amount: number; cashier: string;
  items: { name: string; count: number; price: number }[]; in_erxes: boolean | null;
}
interface UnpaidData { start: string; end: string; orders: UnpaidOrder[]; errors: string[]; total_amount: number; not_in_erxes: number }
const SALE_STATUS: Record<string, string> = { cart: "Сагсанд", confirmed: "Баталгаажсан", complete: "Дууссан" };

// UTC ISO → Улаанбаатарын цаг (UTC+8)
function ubDate(iso: string) {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

const WD = ["Да", "Мя", "Лх", "Пү", "Ба", "Бя", "Ня"];
const MONTHS = ["1-р сар", "2-р сар", "3-р сар", "4-р сар", "5-р сар", "6-р сар",
  "7-р сар", "8-р сар", "9-р сар", "10-р сар", "11-р сар", "12-р сар"];

const CELL: Record<string, string> = {
  ok:   "bg-emerald-500 text-white hover:bg-emerald-600",
  warn: "bg-amber-400 text-white hover:bg-amber-500",
  bad:  "bg-rose-500 text-white hover:bg-rose-600",
  online: "bg-sky-400 text-white hover:bg-sky-500",
  none: "bg-gray-100 text-gray-400 hover:bg-gray-200",
};
const LEGEND: [string, string][] = [
  ["ok", "Бүрэн таарсан"],
  ["warn", "Эрхэт рүү ороогүй"],
  ["bad", "Тайлбаргүй зөрүү / алдаа"],
  ["online", "Онлайн касс — локал POS ажиллаагүй"],
  ["none", "Шалгаагүй"],
];
// Нүдний баруун дээд буланд нил ягаан тоо = тэр өдрийн төлөгдөөгүй захиалга

function fmt(n: number | null | undefined) {
  return Math.round(n || 0).toLocaleString("mn-MN");
}
function pad(n: number) { return String(n).padStart(2, "0"); }

export default function PosReconPage({ embedded = false }: { embedded?: boolean }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState<MonthData | null>(null);
  const [sel, setSel] = useState<string>("");
  const [detail, setDetail] = useState<DayData | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [err, setErr] = useState("");
  const [job, setJob] = useState<RunStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [unpaid, setUnpaid] = useState<UnpaidData | null>(null);
  const [unpaidLoading, setUnpaidLoading] = useState(false);
  const [unpaidOpen, setUnpaidOpen] = useState<string>("");

  const loadMonth = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const r = await api.get("/pos-recon/month", { params: { year, month } });
      setData(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Календарь ачаалж чадсангүй");
    } finally { setLoading(false); }
  }, [year, month]);

  const loadDay = useCallback(async (d: string) => {
    setSel(d); setDetailLoading(true);
    try {
      const r = await api.get("/pos-recon/day", { params: { day: d }, timeout: 120000 });
      setDetail(r.data);
    } catch {
      setDetail(null);
    } finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { loadMonth(); }, [loadMonth]);

  // Сонгосон сарын төлөгдөөгүй захиалга (локал кассаас шууд, ~5-10 сек)
  const loadUnpaid = useCallback(async () => {
    const last = new Date(year, month, 0).getDate();
    const today = new Date().toISOString().slice(0, 10);
    const end = `${year}-${pad(month)}-${pad(last)}`;
    setUnpaidLoading(true);
    try {
      const r = await api.get("/pos-recon/unpaid", {
        params: { start: `${year}-${pad(month)}-01`, end: end > today ? today : end }, timeout: 120000 });
      setUnpaid(r.data);
    } catch (e: any) {
      setUnpaid({ start: "", end: "", orders: [], total_amount: 0, not_in_erxes: 0,
        errors: [e?.response?.data?.detail ?? "Төлөгдөөгүй захиалгыг ачаалж чадсангүй"] });
    } finally { setUnpaidLoading(false); }
  }, [year, month]);
  useEffect(() => { loadUnpaid(); }, [loadUnpaid]);
  useEffect(() => {
    api.get("/pos-recon/run-status").then(r => setJob(r.data)).catch(() => {});
  }, []);

  // Ажиллаж байх үед явцыг уншина; дуусмагц календарийг шинэчилнэ.
  useEffect(() => {
    if (!job?.running) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.get("/pos-recon/run-status");
        setJob(r.data);
        if (!r.data.running) {
          loadMonth();
          if (sel) loadDay(sel);
        }
      } catch { /* silent */ }
    }, 2000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [job?.running, loadMonth, loadDay, sel]);

  async function runCheck(body: Record<string, string>, label: string) {
    if (!confirm(`${label}\n\nНэг өдөр POS тутамд 1-2 минут болно.`)) return;
    setErr("");
    try {
      await api.post("/pos-recon/run", body);
      const r = await api.get("/pos-recon/run-status");
      setJob(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Эхлүүлэх амжилтгүй");
    }
  }

  async function cancelRun() {
    try { await api.post("/pos-recon/cancel"); } catch { /* silent */ }
  }

  function shift(delta: number) {
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setYear(y); setMonth(m); setSel(""); setDetail(null);
  }

  // Даваа гарагаас эхэлсэн сүлжээ
  const lead = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const cells: (DayCell | null)[] = data
    ? Array<DayCell | null>(lead).fill(null).concat(data.days)
    : [];
  while (cells.length % 7 !== 0) cells.push(null);

  const monthStart = `${year}-${pad(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${pad(month)}-${pad(lastDay)}`;
  const unpaidByDay: Record<string, number> = {};
  (unpaid?.orders ?? []).forEach(o => { const d = ubDate(o.created_at).slice(0, 10); unpaidByDay[d] = (unpaidByDay[d] || 0) + 1; });
  const unpaidShown = (unpaid?.orders ?? []).filter(o => !sel || ubDate(o.created_at).startsWith(sel));
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div className={`flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ${embedded ? "min-h-0 flex-1" : "h-[calc(100vh-5rem)] lg:h-[calc(100vh-2.5rem)]"}`}>

      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-4 py-3 sm:px-5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-sm shadow-sky-500/30">
          <CalendarCheck size={16}/>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold leading-tight tracking-tight text-gray-900">POS тулгалт</h1>
          <p className="text-[11px] leading-tight text-gray-500">
            Касс → erxes → Эрхэт · өдөр бүрийн хоёр шатны шалгалт
          </p>
        </div>
        <button onClick={loadMonth} disabled={loading}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""}/>Шинэчлэх
        </button>
      </div>

      {err && (
        <div className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          <AlertCircle size={13} className="shrink-0"/><span className="min-w-0 flex-1">{err}</span>
          <button onClick={() => setErr("")}><X size={12}/></button>
        </div>
      )}

      {data && !data.enabled && (
        <div className="mx-4 mt-2 flex shrink-0 items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <AlertCircle size={13} className="mt-0.5 shrink-0"/>
          <span>erxes тохиргоо дутуу. <code className="font-mono">backend/.env</code>-д <code className="font-mono">ERXES_EMAIL</code>, <code className="font-mono">ERXES_PASSWORD</code> нэмнэ үү.</span>
        </div>
      )}

      {/* Явц */}
      {job?.running && (
        <div className="shrink-0 border-b border-sky-100 bg-sky-50/60 px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin text-sky-600"/>
            <span className="text-[12.5px] font-semibold text-sky-800">
              Тулгаж байна — {job.day}
            </span>
            <span className="ml-auto font-mono text-[12px] font-bold text-sky-700">
              {job.done}/{job.total} · {pct}%
            </span>
            <button onClick={cancelRun}
              className="rounded-lg border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-100">
              Цуцлах
            </button>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-sky-100">
            <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${pct}%` }}/>
          </div>
          <p className="mt-1.5 text-[11px] text-sky-700">{job.message}</p>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {/* Сар сонгох */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button onClick={() => shift(-1)} className="rounded-lg border border-gray-200 p-1.5 hover:bg-gray-50">
            <ChevronLeft size={14}/>
          </button>
          <span className="min-w-[7.5rem] text-center text-[14px] font-bold text-gray-900">
            {year} · {MONTHS[month - 1]}
          </span>
          <button onClick={() => shift(1)} className="rounded-lg border border-gray-200 p-1.5 hover:bg-gray-50">
            <ChevronRight size={14}/>
          </button>
          <button
            onClick={() => runCheck({ start: monthStart, end: monthEnd }, `${year} оны ${MONTHS[month - 1]}-ыг бүхэлд нь шалгах уу?`)}
            disabled={job?.running}
            className="ml-auto flex items-center gap-1.5 rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-[12px] font-semibold text-sky-700 hover:bg-sky-100 disabled:opacity-50">
            <ArrowRightLeft size={12}/>Сарыг нөхөх
          </button>
        </div>

        {/* Тайлбар */}
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          {LEGEND.map(([k, label]) => (
            <span key={k} className="flex items-center gap-1.5 text-[11px] text-gray-500">
              <span className={`inline-block h-3 w-3 rounded ${CELL[k].split(" ")[0]}`}/>{label}
            </span>
          ))}
        </div>

        {/* Календарь */}
        <div className="grid grid-cols-7 gap-1.5">
          {WD.map(w => (
            <div key={w} className="pb-1 text-center text-[10px] font-bold uppercase tracking-wider text-gray-400">{w}</div>
          ))}
          {cells.map((c, i) => c === null ? <div key={`e${i}`}/> : (
            <button key={c.day} onClick={() => loadDay(c.day)}
              className={`flex aspect-square flex-col items-center justify-center rounded-xl text-[13px] font-bold transition ${CELL[c.status]} ${sel === c.day ? "ring-2 ring-gray-900 ring-offset-1" : ""}`}
              title={c.status === "none" ? "Шалгаагүй" :
                `касс ${fmt(c.local)} = erxes ${fmt(c.erxes)} + буцаалт ${c.returns}`}>
              <span className="relative">
                {Number(c.day.slice(-2))}
                {unpaidByDay[c.day] > 0 && (
                  <span title={`${unpaidByDay[c.day]} төлөгдөөгүй захиалга`}
                    className="absolute -right-3.5 -top-2 rounded-full bg-violet-600 px-1 text-[8.5px] font-bold leading-[14px] text-white ring-1 ring-white">
                    {unpaidByDay[c.day]}
                  </span>
                )}
              </span>
              {c.status !== "none" && (
                <span className="text-[9px] font-medium opacity-90">
                  {c.unexplained ? `−${c.unexplained}` : c.unsynced ? `⇢${c.unsynced}` : fmt(c.local || c.erxes)}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Өдрийн дэлгэрэнгүй */}
        {sel && (
          <div className="mt-5 rounded-2xl border border-gray-200 bg-gray-50/50 p-3">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-[13.5px] font-bold text-gray-900">{sel}</h2>
              {detailLoading && <Loader2 size={13} className="animate-spin text-gray-400"/>}
              <button
                onClick={() => runCheck({ day: sel }, `${sel}-ны тулгалтыг дахин шалгах уу?`)}
                disabled={job?.running}
                className="ml-auto flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                <RefreshCw size={11}/>Энэ өдрийг шалгах
              </button>
              <button onClick={() => { setSel(""); setDetail(null); }} className="text-gray-400 hover:text-gray-700">
                <X size={13}/>
              </button>
            </div>

            {!detail || !detail.checked ? (
              <p className="py-4 text-center text-[12px] text-gray-400">
                Энэ өдөр хараахан шалгагдаагүй байна — «Энэ өдрийг шалгах» дарна уу
              </p>
            ) : (
              <>
                {/* POS тус бүр */}
                <div className="mb-3 space-y-2">
                  {detail.rows.map(r => (
                    <div key={r.pos_name} className="rounded-xl border border-gray-200 bg-white p-3">
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${CELL[r.status]?.split(" ")[0] ?? "bg-gray-300"}`}/>
                        <span className="text-[12.5px] font-bold text-gray-900">{r.pos_name}</span>
                      </div>
                      {r.status === "online" && (
                        <p className="mb-1 text-[11.5px] text-sky-700">
                          Энэ өдөр локал касс (192.168.1.254) ажиллаагүй — онлайн кассаар заржээ. Касс ↔ erxes шатыг шалгах боломжгүй; Эрхэт рүү орсныг шалгав.
                        </p>
                      )}
                      {r.error ? (
                        <p className="text-[11.5px] text-rose-600">{r.error}</p>
                      ) : (
                        <div className="space-y-1 text-[12px]">
                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="text-gray-500">Кассын нийт</span>
                            <span className="font-mono font-bold text-gray-900">{fmt(r.local_count)}</span>
                            <span className="text-gray-400">=</span>
                            <span className="text-gray-500">erxes</span>
                            <span className="font-mono font-bold text-gray-900">{fmt(r.erxes_count)}</span>
                            <span className="text-gray-400">+</span>
                            <span className="text-gray-500">буцаалт</span>
                            <span className="font-mono font-bold text-amber-600">{fmt(r.returns_count)}</span>
                            {r.unexplained !== 0 && (
                              <span className="ml-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-700">
                                тайлбаргүй {r.unexplained}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-1.5 border-t border-gray-100 pt-1 text-[11.5px]">
                            <span className="text-gray-500">Эрхэт рүү:</span>
                            <span className="font-mono font-semibold text-emerald-600">{fmt(r.synced_count)} орсон</span>
                            {r.unsynced_count > 0 && (
                              <span className="font-mono font-semibold text-amber-600">· {fmt(r.unsynced_count)} ороогүй</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Буцаалт */}
                {detail.returns.length > 0 && (
                  <div className="overflow-hidden rounded-xl border border-amber-200 bg-white">
                    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5">
                      <Undo2 size={12} className="text-amber-700"/>
                      <span className="text-[12px] font-bold text-amber-900">
                        Буцаалт — {detail.returns.length} баримт
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-[12px]">
                        <thead>
                          <tr className="bg-amber-50/50">
                            {["Баримт №", "Дүн ₮", "Цаг", "ХЭН буцаасан", "Анхны касс"].map((h, i) => (
                              <th key={h} className={`whitespace-nowrap px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 ${i === 1 ? "text-right" : "text-left"}`}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {detail.returns.map(r => (
                            <tr key={r._id} className="border-t border-amber-100">
                              <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-gray-700">{r.number ?? "—"}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px] font-semibold text-rose-700">
                                {r.amount == null ? "?" : fmt(r.amount)}
                              </td>
                              <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-gray-500">
                                {(r.returned_at || "").replace("T", " ").slice(0, 16)}
                              </td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-[11.5px] font-semibold text-amber-900">{r.returned_by}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-[11.5px] text-gray-600">{r.cashier || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Төлөгдөөгүй захиалга */}
        <div className="mt-5 overflow-hidden rounded-2xl border border-violet-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-violet-100 bg-violet-50/70 px-3 py-2">
            <ShoppingCart size={13} className="text-violet-700"/>
            <span className="text-[12.5px] font-bold text-violet-900">
              Төлөгдөөгүй захиалга — erxes рүү ороогүй
            </span>
            <span className="text-[11.5px] text-violet-700">
              {sel ? `${sel}` : `${year} · ${MONTHS[month - 1]}`}
              {unpaid && ` · ${unpaidShown.length} захиалга · ${fmt(unpaidShown.reduce((a, o) => a + o.amount, 0))}₮`}
            </span>
            {unpaidLoading && <Loader2 size={12} className="animate-spin text-violet-500"/>}
            <button onClick={loadUnpaid} disabled={unpaidLoading}
              className="ml-auto flex items-center gap-1 rounded-lg border border-violet-200 bg-white px-2 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-50 disabled:opacity-50">
              <RefreshCw size={11}/>Шинэчлэх
            </button>
          </div>
          <p className="border-b border-violet-50 px-3 py-1.5 text-[11px] leading-relaxed text-gray-500">
            Кассчин бараа уншуулаад төлбөр авалгүй орхисон захиалга локал кассад «төлөгдөөгүй» хэвээр үлддэг.
            erxes зөвхөн төлөгдсөн захиалгыг хүлээж авдаг тул эдгээр нь тулгалтын тоонд ордоггүй.
            Өнөөдрийнх нь кассад одоо үйлчилж буй сагс байж болно.
          </p>
          {(unpaid?.errors ?? []).map(e => (
            <p key={e} className="px-3 py-1 text-[11.5px] text-rose-600">{e}</p>
          ))}
          {unpaid && unpaidShown.length === 0 ? (
            <p className="py-4 text-center text-[12px] text-gray-400">Төлөгдөөгүй захиалга алга.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="bg-violet-50/40">
                    {["Огноо", "Касс", "Дугаар", "Кассчин", "Төлөв", "Дүн ₮", "erxes"].map((h, i) => (
                      <th key={h} className={`whitespace-nowrap px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-violet-700 ${i === 5 ? "text-right" : "text-left"}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {unpaidShown.map(o => (
                    <Fragment key={o._id}>
                      <tr onClick={() => setUnpaidOpen(v => v === o._id ? "" : o._id)}
                        className="cursor-pointer border-t border-violet-50 hover:bg-violet-50/40">
                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-gray-600">
                          <ChevronDown size={11} className={`mr-1 inline transition ${unpaidOpen === o._id ? "rotate-180" : ""}`}/>
                          {ubDate(o.created_at)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-[11.5px] text-gray-700">{o.pos_name}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-gray-700">{o.number}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-[11.5px] text-gray-700">{o.cashier || "—"}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-[11.5px] text-gray-600">{SALE_STATUS[o.sale_status] ?? o.sale_status}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px] font-semibold text-gray-900">{fmt(o.amount)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-[11px]">
                          {o.in_erxes === false ? <span className="font-semibold text-rose-600">ороогүй</span>
                            : o.in_erxes ? <span className="text-emerald-600">байгаа</span>
                            : <span className="text-gray-400">шалгаж чадсангүй</span>}
                        </td>
                      </tr>
                      {unpaidOpen === o._id && (
                        <tr className="bg-gray-50/70">
                          <td colSpan={7} className="px-6 py-1.5">
                            {o.items.length === 0 ? <span className="text-[11px] text-gray-400">Бараагүй сагс</span> : (
                              <ul className="space-y-0.5">
                                {o.items.map((it, k) => (
                                  <li key={k} className="flex gap-2 text-[11.5px] text-gray-700">
                                    <span className="min-w-0 flex-1 truncate">{it.name}</span>
                                    <span className="font-mono text-gray-500">{it.count} × {fmt(it.price)}</span>
                                    <span className="w-20 text-right font-mono font-semibold">{fmt(it.count * it.price)}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            <p className="mt-1 text-[10.5px] text-gray-400">Сүүлд өөрчилсөн: {ubDate(o.modified_at)}</p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Лог */}
      {job && job.log?.length > 0 && (
        <div className="max-h-24 shrink-0 overflow-y-auto border-t border-gray-100 bg-gray-50/60 px-4 py-2">
          {job.log.map((l, i) => (
            <div key={i} className="font-mono text-[10.5px] leading-relaxed text-gray-500">{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
