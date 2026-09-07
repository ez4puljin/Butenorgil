import { useEffect, useRef, useState } from "react";
import {
  Store, RefreshCw, AlertCircle, X, Download, CheckCircle2, Search, Loader2, Undo2,
} from "lucide-react";
import { api } from "../lib/api";

interface Pos { _id: string; name: string; description?: string }
interface UnsyncedRow { _id: string; number?: string; paidDate?: string; totalAmount?: number }
interface CheckResult {
  total: number; synced: number; unsynced_count: number;
  unsynced_amount: number; unsynced: UnsyncedRow[];
}
interface ReturnRow {
  _id: string; number?: string; amount?: number | null;
  returned_at?: string; returned_by: string; cashier?: string;
}
interface ReturnResult { count: number; amount: number; rows: ReturnRow[] }
interface JobStatus {
  enabled: boolean; running: boolean; total: number; done: number;
  ok: number; failed: number; message: string; error: string;
  pos_name: string; log: string[]; finished_at: string | null;
}

function today() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function fmt(n: number) { return Math.round(n || 0).toLocaleString("mn-MN"); }

export default function PosSyncPage() {
  const [posList, setPosList] = useState<Pos[]>([]);
  const [posId, setPosId] = useState("");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());

  const [result, setResult]   = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr]         = useState("");
  const [job, setJob]         = useState<JobStatus | null>(null);
  const [rets, setRets]       = useState<ReturnResult | null>(null);
  const [retLoading, setRetLoading] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Анхны ачаалалт ────────────────────────────────────────────────
  useEffect(() => {
    api.get("/pos-sync/status").then(r => setJob(r.data)).catch(() => {});
    api.get("/pos-sync/pos-list")
      .then(r => setPosList(r.data.pos ?? []))
      .catch(e => setErr(e?.response?.data?.detail ?? "POS жагсаалт авах амжилтгүй"));
  }, []);

  // ── Ажиллаж байх үед явцыг тогтмол уншина ─────────────────────────
  useEffect(() => {
    if (!job?.running) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.get("/pos-sync/status");
        setJob(r.data);
        if (!r.data.running) { doCheck(true); }     // дуусмагц дахин тоолно
      } catch { /* silent */ }
    }, 1500);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [job?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  // «Бүх POS» × олон хоног сонговол хэдэн минут үргэлжилнэ. Тиймээс хүсэлтийг
  // client талд таслахаас гадна backend руу ч зогсоох дохио явуулна — эс тэгвээс
  // сервер дээр erxes рүү дэмий хүсэлт үргэлжилсээр байна.
  async function doCheck(silent = false) {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    if (!silent) { setChecking(true); setErr(""); }
    try {
      const r = await api.get("/pos-sync/check", {
        params: { pos_id: posId, paid_start: start, paid_end: end },
        timeout: 600000,   // өдөр тутам ~1800 захиалга, шалгалт удаан явдаг
        signal: ac.signal,
      });
      if (!r.data?.cancelled) setResult(r.data);   // цуцалсан бол өмнөх үр дүн хэвээр
    } catch (e: any) {
      if (e?.code === "ERR_CANCELED" || e?.name === "CanceledError") return;
      if (!silent) setErr(e?.response?.data?.detail ?? "Шалгах амжилтгүй");
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      if (!silent) setChecking(false);
    }
  }

  async function cancelCheck() {
    abortRef.current?.abort();
    setChecking(false);
    try { await api.post("/pos-sync/cancel-check"); } catch { /* silent */ }
  }

  // Буцаалт нь sync-ээс ТУСДАА асуудал: гүйлгээ Эрхэт рүү зөв очсон ч
  // дараа нь буцаагдвал борлуулалт хасагдана. Огноог БУЦААСАН өдрөөр
  // шүүнэ — захиалгын өдөр өөр байж болно.
  async function doReturns() {
    setRetLoading(true); setErr("");
    try {
      const r = await api.get("/pos-sync/returns", {
        params: { start, end }, timeout: 300000,
      });
      setRets(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Буцаалт татах амжилтгүй");
    } finally { setRetLoading(false); }
  }

  async function startSync() {
    if (!result?.unsynced_count) return;
    const posName = posList.find(p => p._id === posId)?.name ?? "Бүх POS";
    if (!confirm(`${result.unsynced_count} гүйлгээг Эрхэт рүү татах уу?\n\nPOS: ${posName}\nХугацаа: ${start} — ${end}`)) return;
    setErr("");
    try {
      await api.post("/pos-sync/start", {
        pos_id: posId, pos_name: posName, paid_start: start, paid_end: end,
      });
      const r = await api.get("/pos-sync/status");
      setJob(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Татах эхлүүлэх амжилтгүй");
    }
  }

  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div className="flex h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-2xl bg-white shadow-sm lg:h-[calc(100vh-2.5rem)]">

      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-4 py-3 sm:px-5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-sm shadow-teal-500/30">
          <Store size={16}/>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold tracking-tight text-gray-900 leading-tight">POS татах</h1>
          <p className="text-[11px] text-gray-500 leading-tight">erxes-ийн POS гүйлгээг Эрхэт рүү татах</p>
        </div>
      </div>

      {err && (
        <div className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          <AlertCircle size={13} className="shrink-0"/><span className="min-w-0 flex-1">{err}</span>
          <button onClick={() => setErr("")}><X size={12}/></button>
        </div>
      )}

      {job && !job.enabled && (
        <div className="mx-4 mt-2 flex shrink-0 items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <AlertCircle size={13} className="mt-0.5 shrink-0"/>
          <span>erxes тохиргоо дутуу. <code className="font-mono">backend/.env</code>-д <code className="font-mono">ERXES_EMAIL</code>, <code className="font-mono">ERXES_PASSWORD</code> нэмнэ үү.</span>
        </div>
      )}

      {/* Шүүлтүүр */}
      <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-gray-100 bg-gray-50/50 px-4 py-3">
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-gray-500">POS</label>
          <select value={posId} onChange={e => setPosId(e.target.value)}
            className="w-56 rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12.5px] outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100">
            <option value="">Бүх POS</option>
            {posList.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-gray-500">Төлсөн огноо — эхлэл</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12.5px] outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100"/>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-gray-500">Төгсгөл</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12.5px] outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100"/>
        </div>
        <p className="w-full text-[10.5px] text-gray-400">
          Нэг өдөр ~5-10 сек. Олон хоног сонговол хэдэн минут болно (өдөрт ~1,800 гүйлгээ).
          {!posId && (
            <span className="font-semibold text-amber-600">
              {" "}«Бүх POS» сонгосон — хамгийн удаан хувилбар.
            </span>
          )}
        </p>
        <button onClick={() => doCheck()} disabled={checking || job?.running}
          className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-blue-600 disabled:opacity-60 shadow-sm shadow-blue-500/25">
          {checking ? <><RefreshCw size={13} className="animate-spin"/>Шалгаж…</> : <><Search size={13}/>Шалгах</>}
        </button>
        {checking && (
          <button onClick={cancelCheck}
            className="flex items-center gap-1.5 rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-[12.5px] font-semibold text-rose-700 hover:bg-rose-100">
            <X size={13}/>Цуцлах
          </button>
        )}
        <button onClick={doReturns} disabled={retLoading}
          className="flex items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-[12.5px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60">
          {retLoading ? <><RefreshCw size={13} className="animate-spin"/>Татаж…</> : <><Undo2 size={13}/>Буцаалт</>}
        </button>
      </div>

      {/* Явц */}
      {job?.running && (
        <div className="shrink-0 border-b border-teal-100 bg-teal-50/60 px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin text-teal-600"/>
            <span className="text-[12.5px] font-semibold text-teal-800">
              Татаж байна — {job.pos_name}
            </span>
            <span className="ml-auto font-mono text-[12px] font-bold text-teal-700">
              {job.done}/{job.total} · {pct}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-teal-100">
            <div className="h-full rounded-full bg-teal-500 transition-all" style={{ width: `${pct}%` }}/>
          </div>
          <div className="mt-1.5 flex items-center gap-3 text-[11px]">
            <span className="text-teal-700">{job.message}</span>
            {job.ok > 0 && <span className="text-emerald-700">✓ {job.ok}</span>}
            {job.failed > 0 && <span className="text-rose-700">✗ {job.failed}</span>}
          </div>
        </div>
      )}

      {/* Дууссан */}
      {job && !job.running && job.finished_at && job.total > 0 && (
        <div className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          <CheckCircle2 size={13} className="shrink-0"/>{job.message}
        </div>
      )}

      {/* Үр дүн */}
      <div className="flex-1 overflow-auto p-4">
        {rets && (
          <div className="mb-4 overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/40">
            <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2">
              <Undo2 size={13} className="shrink-0 text-amber-700"/>
              <span className="text-[12.5px] font-bold text-amber-900">
                Буцаалт / устгал — {start}{end !== start ? ` … ${end}` : ""}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[12px] font-bold text-amber-800">
                {fmt(rets.count)} ш · {fmt(rets.amount)}₮
              </span>
              <button onClick={() => setRets(null)} className="shrink-0 text-amber-600 hover:text-amber-900">
                <X size={12}/>
              </button>
            </div>
            {rets.count === 0 ? (
              <p className="px-3 py-4 text-center text-[12px] text-amber-700">
                Энэ хугацаанд буцаалт хийгдээгүй байна
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="bg-amber-50/60">
                      {["Дугаар", "Дүн ₮", "Буцаасан цаг", "ХЭН буцаасан", "Анхны касс"].map((h, i) => (
                        <th key={h} className={`whitespace-nowrap px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 ${i === 1 ? "text-right" : "text-left"}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rets.rows.map(r => (
                      <tr key={r._id} className="border-t border-amber-100 hover:bg-amber-50/60">
                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-gray-700">{r.number || r._id.slice(-8)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px] font-semibold text-rose-700">
                          {r.amount == null ? "?" : fmt(r.amount)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-gray-500">{(r.returned_at || "").replace("T", " ").slice(0, 16)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-[11.5px] font-semibold text-amber-900">{r.returned_by}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-[11.5px] text-gray-600">{r.cashier || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {!result ? (
          rets ? null : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-400">
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-teal-50 to-emerald-50">
                <Store size={28} className="text-teal-400"/>
              </div>
              <p className="text-[14px] font-semibold text-gray-700">POS болон огноогоо сонгоод «Шалгах» дарна уу</p>
            </div>
          )
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Нийт гүйлгээ", value: fmt(result.total), cls: "text-gray-900" },
                { label: "Татагдсан", value: fmt(result.synced), cls: "text-emerald-600" },
                { label: "ТАТАГДААГҮЙ", value: fmt(result.unsynced_count), cls: "text-rose-600" },
                { label: "Дүн (₮)", value: fmt(result.unsynced_amount), cls: "text-rose-600" },
              ].map(s => (
                <div key={s.label} className="rounded-2xl border border-gray-100 bg-white px-3 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{s.label}</div>
                  <div className={`mt-0.5 text-[20px] font-bold leading-none ${s.cls}`}>{s.value}</div>
                </div>
              ))}
            </div>

            {result.unsynced_count > 0 ? (
              <>
                <button onClick={startSync} disabled={job?.running}
                  className="mb-3 flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 shadow-sm shadow-emerald-500/25">
                  <Download size={14}/>Татах ({fmt(result.unsynced_count)})
                </button>
                <table className="w-full border-collapse text-[12px]">
                  <thead className="sticky top-0 bg-white shadow-[0_1px_0_0_#f3f4f6]">
                    <tr>
                      <th className="px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wider text-gray-400">#</th>
                      <th className="px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">Дугаар</th>
                      <th className="px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">Төлсөн огноо</th>
                      <th className="px-2 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-gray-500">Дүн ₮</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.unsynced.map((o, i) => (
                      <tr key={o._id} className="border-b border-gray-50 hover:bg-rose-50/30">
                        <td className="px-2 py-1.5 text-center text-[10px] text-gray-300">{i + 1}</td>
                        <td className="px-2 py-1.5 font-mono text-[11px] text-gray-700">{o.number || o._id.slice(-8)}</td>
                        <td className="px-2 py-1.5 font-mono text-[11px] text-gray-500">{(o.paidDate || "").replace("T", " ").slice(0, 16)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-[11.5px] text-gray-800">{fmt(o.totalAmount || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.unsynced_count > result.unsynced.length && (
                  <p className="mt-2 text-center text-[11px] text-gray-400">
                    Эхний {result.unsynced.length} мөр харагдаж байна — «Татах» дарвал бүгдийг татна
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-14 text-gray-400">
                <div className="grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50">
                  <CheckCircle2 size={24} className="text-emerald-500"/>
                </div>
                <p className="text-[13px] font-semibold text-gray-600">Бүх гүйлгээ татагдсан байна</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Лог */}
      {job && job.log?.length > 0 && (
        <div className="max-h-28 shrink-0 overflow-y-auto border-t border-gray-100 bg-gray-50/60 px-4 py-2">
          {job.log.map((l, i) => (
            <div key={i} className="font-mono text-[10.5px] leading-relaxed text-gray-500">{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
