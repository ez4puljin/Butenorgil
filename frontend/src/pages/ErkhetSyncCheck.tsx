import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft, RefreshCw, Search, X, Download, Settings2, Play, AlertTriangle, CheckCircle2, Info,
  ShieldAlert, History, RotateCcw, ChevronRight,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ───────────────────────────────────────────────────────────────────
type Sev = "error" | "warn" | "info" | "ok";
interface Stage { _id: string; name: string; category: string; saved: boolean }
interface Pipe { _id: string; name: string; included: boolean; stages: Stage[] }
interface Board { _id: string; name: string; pipelines: Pipe[] }
interface Cfg { stageId: string; title: string; pipelineId: string; userEmail: string; defaultPay: string; hasVat: boolean }
interface Meta {
  boards: Board[]; defaultBoardId: string; configs: Cfg[];
  dateTypes: { value: string; label: string }[];
  statuses: Record<string, { severity: Sev; label: string }>;
  canResync: boolean;
}
interface Hist {
  at: string; user_email: string; date: string; number: string; customer: string; pay_keys: string[];
  debt: number; details_sum: number; no_response: boolean; has_undefined: boolean; resp_codes: string[]; resp_total: number | null;
  resp_date: string; resp_success: boolean | null; resp_error: string; resp_warning: string; error: string;
  order: Record<string, unknown>; response: unknown;
}
interface ItemData {
  pipeline: string; stage: string; createdAt: string; stageChangedDate: string | null; closeDate: string | null;
  paymentsData: unknown; payments_bad: boolean;
  products: { count: number; used: number; sum_used: number; sum_all: number };
  erkhet_bill: string; erkhet_customer: string; erkhet_date: string; last_sync_at: string | null;
  pay_label: string; resp_codes: string[]; status_sev: Record<string, Sev>; notes: string[];
  amounts: Record<string, number>; last_user: string; hists: Hist[];
}
interface Item {
  deal_id: string; number: string; name: string; pipeline_id: string; stage_id: string; category: string;
  amount: number; severity: Sev; statuses: string[]; data: ItemData;
}
interface Action {
  deal_id: string; number: string; config_title: string; date_type: string; payments_before: string;
  payments_after: string; before: string[]; after: string[]; result: string; message: string; user: string; at: string;
}
interface Run {
  id: number; kind: string; status: "running" | "done" | "error"; params: any; progress: string; done_n: number;
  total_n: number; summary: any; error: string; created_by: string; created_at: string;
  items?: Item[]; actions?: Action[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmt = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n).toLocaleString("en-US")}₮`);
const TZ = "Asia/Ulaanbaatar";
function ubDate(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}
function ubDT(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16);
}
const todayUB = () => new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const SEV_STYLE: Record<Sev, string> = {
  error: "bg-rose-100 text-rose-700 ring-rose-200", warn: "bg-amber-100 text-amber-800 ring-amber-200",
  info: "bg-sky-100 text-sky-700 ring-sky-200", ok: "bg-emerald-100 text-emerald-700 ring-emerald-200",
};
const SEV_LABEL: Record<Sev, string> = { error: "Алдаа", warn: "Анхааруулга", info: "Мэдээлэл", ok: "Зөв" };
const CAT_LABEL: Record<string, string> = { expected: "Авлагатай байх", pending: "Эцэслээгүй", cancel: "Цуцлах" };
const CAT_STYLE: Record<string, string> = {
  expected: "bg-indigo-50 text-indigo-700", pending: "bg-gray-100 text-gray-600", cancel: "bg-rose-50 text-rose-600",
};
const DATE_FIELDS = [
  { v: "createdAt", l: "Үүссэн огноо" }, { v: "stageChangedDate", l: "Stage сольсон огноо" }, { v: "closeDate", l: "Хаах огноо" },
];
const LS = "erkhetSync.params";

function StatusBadges({ item, meta }: { item: Item; meta: Meta | null }) {
  return (
    <div className="flex flex-wrap gap-1">
      {item.statuses.map(s => {
        const sev = (item.data.status_sev?.[s] ?? meta?.statuses[s]?.severity ?? (s === "OK" ? "ok" : "info")) as Sev;
        return (
          <span key={s} title={meta?.statuses[s]?.label ?? s}
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ring-1 ${SEV_STYLE[sev]}`}>{s}</span>
        );
      })}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function ErkhetSyncCheck({ embedded = false }: { embedded?: boolean }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState("");
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; } })();
  const [boardId, setBoardId] = useState<string>(saved.boardId ?? "");
  const [pipeIds, setPipeIds] = useState<string[]>(saved.pipeIds ?? []);
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [dateField, setDateField] = useState<string>(saved.dateField ?? "createdAt");
  const [start, setStart] = useState(addDays(todayUB(), -6));
  const [end, setEnd] = useState(todayUB());
  const [run, setRun] = useState<Run | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const poll = useRef<number | undefined>(undefined);

  // Хүснэгтийн шүүлт
  const [q, setQ] = useState("");
  const [fSev, setFSev] = useState<string>("problem");
  const [fStatus, setFStatus] = useState("");
  const [fCat, setFCat] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Item | null>(null);
  const [showCfg, setShowCfg] = useState(false);
  const [showResync, setShowResync] = useState(false);
  const [resyncRun, setResyncRun] = useState<Run | null>(null);

  const loadMeta = (fresh = false) => api.get("/erkhet-sync/meta", { params: { fresh }, timeout: 120000 })
    .then(r => {
      const m: Meta = r.data; setMeta(m);
      setBoardId(b => b || m.defaultBoardId);
    }).catch(e => setErr(e?.response?.data?.detail ?? "erxes-ээс мэдээлэл авч чадсангүй"));
  const loadRuns = () => api.get("/erkhet-sync/runs", { params: { kind: "check", limit: 15 } })
    .then(r => setRuns(r.data)).catch(() => {});
  useEffect(() => {
    loadMeta(); loadRuns();
    return () => window.clearTimeout(poll.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const board = meta?.boards.find(b => b._id === boardId);
  // Анхдагч pipeline-ууд — тохиргоогоор «оруулах» (хөдөлгөөний pipeline хасагдсан)
  useEffect(() => {
    if (board && !pipeIds.some(id => board.pipelines.some(p => p._id === id)))
      setPipeIds(board.pipelines.filter(p => p.included).map(p => p._id));
  }, [board?._id]); // eslint-disable-line react-hooks/exhaustive-deps
  const stagesShown = (board?.pipelines ?? []).filter(p => pipeIds.includes(p._id))
    .flatMap(p => p.stages.map(s => ({ ...s, pipe: p.name })));

  function watch(id: number, setter: (r: Run) => void, onDone?: (r: Run) => void) {
    window.clearTimeout(poll.current);
    const tick = () => api.get(`/erkhet-sync/runs/${id}`).then(r => {
      setter(r.data);
      if (r.data.status === "running") poll.current = window.setTimeout(tick, 2000);
      else onDone?.(r.data);
    }).catch(() => { poll.current = window.setTimeout(tick, 4000); });
    tick();
  }
  async function startCheck() {
    setErr(""); setSel(new Set());
    try { localStorage.setItem(LS, JSON.stringify({ boardId, pipeIds, dateField })); } catch { /* ignore */ }
    try {
      const r = await api.post("/erkhet-sync/check", { boardId, pipelineIds: pipeIds, stageIds, dateField, startDate: start, endDate: end });
      watch(r.data.run_id, setRun, () => loadRuns());
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Шалгалт эхлүүлж чадсангүй"); }
  }
  function openRun(id: number) { setSel(new Set()); watch(id, setRun); }

  async function exportXlsx() {
    if (!run) return;
    try {
      const r = await api.get(`/erkhet-sync/runs/${run.id}/xlsx`, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement("a");
      a.href = url; a.download = `Erkhet_sync_${run.params?.startDate ?? ""}_${run.params?.endDate ?? ""}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch { setErr("Excel татаж чадсангүй"); }
  }

  const items = run?.items ?? [];
  const ql = q.trim().toLowerCase();
  const filtered = useMemo(() => items.filter(x => {
    if (fSev === "problem" && !(x.severity === "error" || x.severity === "warn")) return false;
    if (fSev && fSev !== "problem" && x.severity !== fSev) return false;
    if (fStatus && !x.statuses.includes(fStatus)) return false;
    if (fCat && x.category !== fCat) return false;
    if (ql && !`${x.number} ${x.name} ${x.data.erkhet_bill} ${x.data.erkhet_customer}`.toLowerCase().includes(ql)) return false;
    return true;
  }), [items, fSev, fStatus, fCat, ql]);
  const sum = run?.summary ?? {};
  const kpi = (sev: Sev) => sum.by_severity?.[sev] ?? { n: 0, amount: 0 };
  const allSel = filtered.length > 0 && filtered.every(x => sel.has(x.deal_id));
  const selItems = items.filter(x => sel.has(x.deal_id));

  return (
    <div className="flex min-h-[calc(100vh-5rem)] flex-col gap-3 pb-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        {!embedded && <Link to="/reports" className="grid h-9 w-9 place-items-center rounded-xl bg-gray-100 hover:bg-gray-200"><ArrowLeft size={16}/></Link>}
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Deal sync шалгалт</h1>
          <p className="text-[12px] text-gray-500">erxes-ийн deal бүр Эрхэт рүү авлага (debtAmount) болж sync хийгдсэн эсэх</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {runs.length > 0 && (
            <select value={run?.kind === "check" ? run.id : ""} onChange={e => e.target.value && openRun(Number(e.target.value))}
              className="rounded-xl border border-gray-200 bg-white px-2 py-1.5 text-[12px]">
              <option value="">Өмнөх шалгалтууд…</option>
              {runs.map(r => <option key={r.id} value={r.id}>
                #{r.id} · {r.params?.startDate}–{r.params?.endDate} · {ubDT(r.created_at)} · {r.created_by}{r.status !== "done" ? ` (${r.status})` : ""}
              </option>)}
            </select>
          )}
          {meta?.canResync && (
            <button onClick={() => setShowCfg(true)} title="Stage-ийн ангилал, pipeline"
              className="flex items-center gap-1 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-gray-600 hover:bg-gray-50">
              <Settings2 size={13}/>Тохиргоо
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          <AlertTriangle size={13}/>{err}<button className="ml-auto" onClick={() => setErr("")}><X size={12}/></button>
        </div>
      )}

      {/* Filters */}
      <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        {!meta ? (
          <div className="flex items-center gap-2 text-[12.5px] text-gray-400"><RefreshCw size={13} className="animate-spin"/>erxes-ээс board, stage татаж байна…</div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[11px] font-semibold text-gray-500">Board
                <select value={boardId} onChange={e => { setBoardId(e.target.value); setPipeIds([]); setStageIds([]); }}
                  className="mt-0.5 block rounded-lg border border-gray-200 px-2 py-1.5 text-[12.5px] text-gray-800">
                  {meta.boards.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
                </select>
              </label>
              <label className="text-[11px] font-semibold text-gray-500">Огнооны талбар
                <select value={dateField} onChange={e => setDateField(e.target.value)}
                  className="mt-0.5 block rounded-lg border border-gray-200 px-2 py-1.5 text-[12.5px] text-gray-800">
                  {DATE_FIELDS.map(f => <option key={f.v} value={f.v}>{f.l}</option>)}
                </select>
              </label>
              <label className="text-[11px] font-semibold text-gray-500">Эхлэх (УБ)
                <input type="date" value={start} max={end} onChange={e => setStart(e.target.value)}
                  className="mt-0.5 block rounded-lg border border-gray-200 px-2 py-1 text-[12.5px]"/>
              </label>
              <label className="text-[11px] font-semibold text-gray-500">Дуусах (УБ)
                <input type="date" value={end} min={start} onChange={e => setEnd(e.target.value)}
                  className="mt-0.5 block rounded-lg border border-gray-200 px-2 py-1 text-[12.5px]"/>
              </label>
              <div className="flex gap-1">
                {[["Өнөөдөр", 0], ["7 хоног", 6], ["30 хоног", 29]].map(([l, n]) => (
                  <button key={l as string} onClick={() => { setEnd(todayUB()); setStart(addDays(todayUB(), -(n as number))); }}
                    className="rounded-lg px-2 py-1 text-[11.5px] font-semibold text-indigo-700 hover:bg-indigo-50">{l}</button>
                ))}
              </div>
              <button onClick={startCheck} disabled={run?.status === "running" || !pipeIds.length}
                className="ml-auto flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-[12.5px] font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50">
                {run?.status === "running" && run.kind === "check" ? <RefreshCw size={13} className="animate-spin"/> : <Play size={13}/>}Шалгах
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-semibold text-gray-500">Pipeline:</span>
              {board?.pipelines.map(p => {
                const on = pipeIds.includes(p._id);
                return (
                  <button key={p._id} onClick={() => setPipeIds(ps => on ? ps.filter(x => x !== p._id) : [...ps, p._id])}
                    className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${on ? "bg-indigo-600 text-white" : p.included ? "bg-gray-100 text-gray-600 hover:bg-gray-200" : "bg-gray-50 text-gray-400 hover:bg-gray-100"}`}>
                    {p.name}
                  </button>
                );
              })}
            </div>
            {stagesShown.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[11px] font-semibold text-gray-500">Stage{stageIds.length ? ` (${stageIds.length})` : " (бүгд)"}:</span>
                {stagesShown.map(s => {
                  const on = stageIds.includes(s._id);
                  return (
                    <button key={s._id} title={`${s.pipe} · ${CAT_LABEL[s.category]}`}
                      onClick={() => setStageIds(ss => on ? ss.filter(x => x !== s._id) : [...ss, s._id])}
                      className={`rounded-md px-1.5 py-0.5 text-[10.5px] ${on ? "bg-indigo-600 text-white" : CAT_STYLE[s.category]}`}>
                      {s.name}
                    </button>
                  );
                })}
                {stageIds.length > 0 && <button onClick={() => setStageIds([])} className="text-[10.5px] text-gray-400 underline">цэвэрлэх</button>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Progress */}
      {run && run.status !== "done" && (
        <div className={`rounded-xl border px-3 py-2 text-[12.5px] ${run.status === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-indigo-200 bg-indigo-50 text-indigo-800"}`}>
          {run.status === "error" ? <>Шалгалт амжилтгүй: {run.error}</> : (
            <div className="flex items-center gap-2"><RefreshCw size={13} className="animate-spin"/>
              {run.progress || "Эхэлж байна…"}{run.total_n ? ` · ${run.total_n} deal` : ""}
              <span className="text-indigo-500">— 200 deal ойролцоогоор 1 минут</span>
            </div>
          )}
        </div>
      )}

      {run?.status === "done" && (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {([["Нийт deal", { n: sum.total, amount: sum.amount }, "text-gray-900", ""],
               ["Зөв", kpi("ok"), "text-emerald-700", "ok"], ["Алдаатай", kpi("error"), "text-rose-600", "error"],
               ["Анхааруулга", kpi("warn"), "text-amber-700", "warn"], ["Мэдээлэл", kpi("info"), "text-sky-700", "info"]] as
              [string, { n: number; amount: number }, string, string][]).map(([l, v, c, f]) => (
              <button key={l} onClick={() => { setFSev(f); setFStatus(""); }}
                className={`rounded-2xl border bg-white px-3 py-2 text-left shadow-sm hover:border-indigo-300 ${fSev === f ? "border-indigo-400 ring-2 ring-indigo-100" : "border-gray-200"}`}>
                <div className="text-[11px] font-semibold text-gray-500">{l}</div>
                <div className={`text-[20px] font-bold tabular-nums ${c}`}>{(v?.n ?? 0).toLocaleString("en-US")}</div>
                <div className="font-mono text-[11px] tabular-nums text-gray-500">{fmt(v?.amount ?? 0)}</div>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(sum.by_status ?? {}).sort((a: any, b: any) => b[1].n - a[1].n).map(([s, v]: [string, any]) => {
              const sev = (meta?.statuses[s]?.severity ?? "info") as Sev;
              return (
                <button key={s} onClick={() => { setFStatus(fStatus === s ? "" : s); setFSev(""); }}
                  title={meta?.statuses[s]?.label}
                  className={`rounded-lg px-2 py-1 text-[11px] font-semibold ring-1 ${fStatus === s ? "ring-2 ring-indigo-500 " : ""}${SEV_STYLE[sev]}`}>
                  {s} · {v.n} · {fmt(v.amount)}
                </button>
              );
            })}
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Дугаар, нэр, bill №…"
                className="w-56 rounded-xl border border-gray-200 bg-white py-1.5 pl-7 pr-2 text-[12px] outline-none focus:border-indigo-400"/>
            </div>
            <select value={fSev} onChange={e => setFSev(e.target.value)} className="rounded-xl border border-gray-200 bg-white px-2 py-1.5 text-[12px]">
              <option value="">Бүх статус</option><option value="problem">Асуудалтай (алдаа + анхааруулга)</option>
              {(["error", "warn", "info", "ok"] as Sev[]).map(s => <option key={s} value={s}>{SEV_LABEL[s]}</option>)}
            </select>
            <select value={fCat} onChange={e => setFCat(e.target.value)} className="rounded-xl border border-gray-200 bg-white px-2 py-1.5 text-[12px]">
              <option value="">Бүх ангилал</option>
              {Object.entries(CAT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <span className="text-[12px] text-gray-500">{filtered.length} / {items.length} deal</span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={exportXlsx} className="flex items-center gap-1 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:bg-gray-50">
                <Download size={13}/>Excel
              </button>
              {meta?.canResync && (
                <button disabled={!sel.size} onClick={() => setShowResync(true)}
                  className="flex items-center gap-1 rounded-xl bg-rose-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-rose-700 disabled:opacity-40">
                  <RotateCcw size={13}/>Дахин sync{sel.size ? ` (${sel.size})` : ""}
                </button>
              )}
            </div>
          </div>

          {/* Table */}
          <div className="overflow-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
            <table className="w-full border-collapse text-[11.5px]">
              <thead className="sticky top-0 z-10 bg-gray-50 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-2 py-2">
                    <input type="checkbox" checked={allSel} className="accent-indigo-600"
                      onChange={() => setSel(s => { const n = new Set(s); filtered.forEach(x => allSel ? n.delete(x.deal_id) : n.add(x.deal_id)); return n; })}/>
                  </th>
                  <th className="px-2 py-2">Deal №</th><th className="px-2 py-2">Нэр</th><th className="px-2 py-2">Pipeline / Stage</th>
                  <th className="px-2 py-2 text-right">Дүн</th><th className="px-2 py-2">Erkhet bill №</th><th className="px-2 py-2">Харилцагч</th>
                  <th className="px-2 py-2">Erkhet огноо</th><th className="px-2 py-2">Сүүлийн sync</th><th className="px-2 py-2">Илгээсэн</th>
                  <th className="px-2 py-2">Erkhet хариу</th><th className="px-2 py-2">Статус</th><th className="px-2 py-2">Тайлбар</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(x => (
                  <tr key={x.deal_id} onClick={() => setOpen(x)}
                    className={`cursor-pointer border-t border-gray-100 ${sel.has(x.deal_id) ? "bg-indigo-50" : x.severity === "error" ? "bg-rose-50/40 hover:bg-rose-50" : "hover:bg-gray-50"}`}>
                    <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(x.deal_id)} className="accent-indigo-600"
                        onChange={() => setSel(s => { const n = new Set(s); if (n.has(x.deal_id)) n.delete(x.deal_id); else n.add(x.deal_id); return n; })}/>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-gray-700">{x.number}</td>
                    <td className="max-w-[220px] truncate px-2 py-1.5 text-gray-900" title={x.name}>{x.name}</td>
                    <td className="px-2 py-1.5">
                      <div className="text-gray-700">{x.data.pipeline}</div>
                      <div className="flex items-center gap-1 text-[10.5px] text-gray-500">{x.data.stage}
                        <span className={`rounded px-1 text-[9.5px] ${CAT_STYLE[x.category]}`}>{CAT_LABEL[x.category]}</span></div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums">{fmt(x.amount)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-gray-600">{x.data.erkhet_bill || "—"}</td>
                    <td className="px-2 py-1.5 font-mono text-gray-600">{x.data.erkhet_customer || "—"}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-gray-600">{x.data.erkhet_date || "—"}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-gray-500">{ubDT(x.data.last_sync_at) || "—"}</td>
                    <td className={`px-2 py-1.5 font-mono ${x.data.pay_label === "debtAmount" ? "text-emerald-700" : x.data.pay_label ? "font-bold text-rose-600" : "text-gray-300"}`}>{x.data.pay_label || "—"}</td>
                    <td className={`px-2 py-1.5 font-mono ${x.data.resp_codes?.includes("PAYMENT_CARD") ? "text-emerald-700" : x.data.resp_codes?.length ? "font-bold text-rose-600" : "text-gray-300"}`}>{x.data.resp_codes?.join(", ") || "—"}</td>
                    <td className="px-2 py-1.5"><StatusBadges item={x} meta={meta}/></td>
                    <td className="max-w-[260px] truncate px-2 py-1.5 text-[10.5px] text-gray-500" title={x.data.notes?.join("\n")}>{x.data.notes?.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && <div className="py-10 text-center text-[12.5px] text-gray-400">Илэрц алга</div>}
          </div>
        </>
      )}

      {!run && (
        <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center text-[13px] text-gray-400">
          Огнооны хүрээгээ сонгоод «Шалгах» дарна уу. Хөдөлгөөний pipeline-ууд анхнаасаа хасагдсан.
        </div>
      )}

      {open && <DealDrawer item={open} meta={meta} onClose={() => setOpen(null)}/>}
      {showCfg && meta && board && <SettingsModal board={board} onClose={() => setShowCfg(false)} onSaved={() => loadMeta(true)}/>}
      {showResync && meta && run && (
        <ResyncModal run={run} items={selItems} meta={meta} onClose={() => setShowResync(false)}
          onStarted={id => { setShowResync(false); watch(id, setResyncRun); }}/>
      )}
      {resyncRun && (
        <ResyncResult run={resyncRun} onClose={() => setResyncRun(null)}
          onRecheck={() => { setResyncRun(null); startCheck(); }}/>
      )}
    </div>
  );
}

// ── Drawer ──────────────────────────────────────────────────────────────────
function DealDrawer({ item, meta, onClose }: { item: Item; meta: Meta | null; onClose: () => void }) {
  const d = item.data;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const dates: [string, string][] = [
    ["Үүссэн (createdAt)", ubDT(d.createdAt)], ["Stage сольсон", ubDT(d.stageChangedDate)], ["Хаах огноо", ubDT(d.closeDate)],
    ["Илгээсэн date", d.hists.length ? d.hists[d.hists.length - 1].date : ""], ["Эрхэтийн syncedDate", d.erkhet_date],
  ];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-gray-100 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[12px] text-gray-500">{item.number}</div>
            <div className="truncate text-[15px] font-bold text-gray-900">{item.name}</div>
            <div className="text-[11.5px] text-gray-500">{d.pipeline} · {d.stage} · {CAT_LABEL[item.category]} · {fmt(item.amount)}</div>
            <div className="mt-1"><StatusBadges item={item} meta={meta}/></div>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-gray-100"><X size={16}/></button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3 text-[12px]">
          {d.notes?.length > 0 && <div className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">{d.notes.map((n, i) => <div key={i}>• {n}</div>)}</div>}
          <section>
            <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">Огноонууд (УБ)</h3>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {dates.map(([l, v]) => <div key={l} className="rounded-lg bg-gray-50 px-2 py-1"><div className="text-[10px] text-gray-500">{l}</div><div className="font-mono">{v || "—"}</div></div>)}
            </div>
          </section>
          <section>
            <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">Дүн</h3>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(d.amounts ?? {}).map(([k, v]) => <div key={k} className="rounded-lg bg-gray-50 px-2 py-1">
                <div className="text-[10px] text-gray-500">{({ deal: "Deal", debt: "Илгээсэн авлага", erkhet: "Эрхэтийн дүн", payments: "paymentsData" } as any)[k] ?? k}</div>
                <div className="font-mono">{fmt(v)}</div></div>)}
              <div className="rounded-lg bg-gray-50 px-2 py-1"><div className="text-[10px] text-gray-500">Бараа (tickUsed {d.products.used}/{d.products.count})</div>
                <div className="font-mono">{fmt(d.products.sum_used)}{d.products.sum_all !== d.products.sum_used ? ` / бүгд ${fmt(d.products.sum_all)}` : ""}</div></div>
            </div>
          </section>
          <section>
            <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">paymentsData {d.payments_bad && <span className="text-rose-600">— буруу бүтэцтэй</span>}</h3>
            <pre className={`overflow-auto rounded-lg px-2 py-1.5 text-[11px] ${d.payments_bad ? "bg-rose-50 text-rose-800" : "bg-gray-50"}`}>{JSON.stringify(d.paymentsData, null, 1)}</pre>
          </section>
          <section>
            <h3 className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-gray-500"><History size={11}/>Sync түүх ({d.hists.length})</h3>
            {d.hists.length === 0 && <div className="text-gray-400">Sync хийгдээгүй</div>}
            <div className="space-y-2">
              {[...d.hists].reverse().map((h, i) => {
                const ok = !h.no_response && h.resp_success === true && h.resp_codes.includes("PAYMENT_CARD");
                return (
                  <details key={i} open={i === 0} className={`rounded-lg border px-2 py-1.5 ${ok ? "border-emerald-200" : "border-rose-200"}`}>
                    <summary className="cursor-pointer">
                      <span className="font-mono">{ubDT(h.at)}</span> · {h.user_email} · date {h.date} ·{" "}
                      <b className={h.debt > 0 ? "text-emerald-700" : "text-rose-600"}>{h.has_undefined ? "undefined" : h.debt > 0 ? `debtAmount ${fmt(h.debt)}` : "төлбөрийн талбаргүй (CASH)"}</b>
                      {" → "}<b className={ok ? "text-emerald-700" : "text-rose-600"}>{h.no_response ? "хариу ирээгүй" : h.resp_codes.join(", ") || h.resp_error || "—"}</b>
                    </summary>
                    {(h.error || h.resp_error || h.resp_warning) && <div className="mt-1 text-[11px] text-amber-700">{[h.error, h.resp_error, h.resp_warning].filter(Boolean).join(" · ")}</div>}
                    <div className="mt-1 text-[10px] font-semibold text-gray-500">Илгээсэн (apiKey/apiSecret-гүй)</div>
                    <pre className="max-h-60 overflow-auto rounded bg-gray-50 px-2 py-1 text-[10.5px]">{JSON.stringify(h.order, null, 1)}</pre>
                    <div className="mt-1 text-[10px] font-semibold text-gray-500">Эрхэтийн хариу</div>
                    <pre className="max-h-60 overflow-auto rounded bg-gray-50 px-2 py-1 text-[10.5px]">{JSON.stringify(h.response, null, 1)}</pre>
                  </details>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Тохиргоо: stage-ийн ангилал, pipeline ────────────────────────────────────
function SettingsModal({ board, onClose, onSaved }: { board: Board; onClose: () => void; onSaved: () => void }) {
  const [cats, setCats] = useState<Record<string, string>>(
    Object.fromEntries(board.pipelines.flatMap(p => p.stages.map(s => [s._id, s.category]))));
  const [inc, setInc] = useState<Record<string, boolean>>(Object.fromEntries(board.pipelines.map(p => [p._id, p.included])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save() {
    setBusy(true);
    try {
      const body = [
        ...board.pipelines.map(p => ({ kind: "pipeline", ref_id: p._id, name: p.name, value: inc[p._id] ? "include" : "exclude" })),
        ...board.pipelines.flatMap(p => p.stages.map(s => ({ kind: "stage", ref_id: s._id, name: `${p.name} / ${s.name}`, value: cats[s._id] }))),
      ];
      await api.put("/erkhet-sync/settings", body);
      onSaved(); onClose();
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Хадгалж чадсангүй"); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center border-b border-gray-100 px-4 py-3">
          <div><div className="text-[15px] font-bold">Stage-ийн ангилал · {board.name}</div>
            <div className="text-[11.5px] text-gray-500">Авлагатай байх — Эрхэт дээр авлага байх ёстой · Эцэслээгүй — түр CASH байж болно · Цуцлах — Эрхэт дээр байх ёсгүй</div></div>
          <button onClick={onClose} className="ml-auto text-gray-400"><X size={16}/></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
          {board.pipelines.map(p => (
            <div key={p._id} className="rounded-xl border border-gray-200 p-2.5">
              <label className="flex items-center gap-2 text-[13px] font-semibold">
                <input type="checkbox" checked={inc[p._id]} onChange={() => setInc(s => ({ ...s, [p._id]: !s[p._id] }))} className="accent-indigo-600"/>
                {p.name} <span className="text-[11px] font-normal text-gray-400">{inc[p._id] ? "шалгалтад анхдагчаар орно" : "анхдагчаар хасагдсан"}</span>
              </label>
              <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                {p.stages.map(s => (
                  <div key={s._id} className="flex items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <select value={cats[s._id]} onChange={e => setCats(c => ({ ...c, [s._id]: e.target.value }))}
                      className={`rounded-md border-0 px-1.5 py-0.5 text-[11px] font-semibold ${CAT_STYLE[cats[s._id]]}`}>
                      {Object.entries(CAT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-gray-100 px-4 py-3">
          {err && <span className="text-[12px] text-rose-600">{err}</span>}
          <button onClick={save} disabled={busy} className="ml-auto rounded-xl bg-indigo-600 px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50">Хадгалах</button>
        </div>
      </div>
    </div>
  );
}

// ── Дахин sync: config, dateType, paymentsData засах → dry-run → батлах ─────────
function ResyncModal({ run, items, meta, onClose, onStarted }: {
  run: Run; items: Item[]; meta: Meta; onClose: () => void; onStarted: (id: number) => void;
}) {
  const pipes = [...new Map(items.map(x => [x.pipeline_id, x.data.pipeline])).entries()];
  const debtCfgs = (pid: string) => meta.configs.filter(c => c.pipelineId === pid && c.defaultPay === "debtAmount");
  // Санал: авлагатай (debtAmount) config-уудаас — өмнөх sync-ийн userEmail, НӨАТ (hasVat) таарсан, «Баримт хэвлэх»
  function suggest(pid: string) {
    const cs = debtCfgs(pid);
    const its = items.filter(x => x.pipeline_id === pid);
    const top = <T,>(xs: T[]) => [...xs.reduce((m, u) => m.set(u, (m.get(u) ?? 0) + 1), new Map<T, number>()).entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    const user = top(its.map(x => x.data.last_user).filter(Boolean));
    const vat = top(its.map(x => x.data.hists[x.data.hists.length - 1]?.order?.hasVat).filter(v => typeof v === "boolean") as boolean[]);
    const score = (c: Cfg) => (c.userEmail && c.userEmail === user ? 2 : 0) + (vat !== undefined && c.hasVat === vat ? 3 : 0)
      + (c.title.includes("Баримт хэвлэх") ? 1 : 0);
    return [...cs].sort((a, b) => score(b) - score(a))[0]?.stageId ?? "";
  }
  const [cfg, setCfg] = useState<Record<string, string>>(Object.fromEntries(pipes.map(([pid]) => [pid, suggest(pid)])));
  const [dateType, setDateType] = useState("created");
  const [fix, setFix] = useState(true);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const badPay = items.filter(x => x.data.payments_bad).length;
  const body = { run_id: run.id, deal_ids: items.map(x => x.deal_id), configs: cfg, dateType, fixPayments: fix && badPay > 0 };
  useEffect(() => { setPreview(null); }, [JSON.stringify(cfg), dateType, fix]); // eslint-disable-line react-hooks/exhaustive-deps
  async function doPreview() {
    setBusy(true); setErr("");
    try { setPreview((await api.post("/erkhet-sync/resync/preview", body)).data); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? "Урьдчилан харах амжилтгүй"); } finally { setBusy(false); }
  }
  async function doRun() {
    setBusy(true); setErr("");
    try { onStarted((await api.post("/erkhet-sync/resync", { ...body, confirm: true })).data.run_id); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? "Sync эхлүүлж чадсангүй"); setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center border-b border-gray-100 px-4 py-3">
          <div><div className="text-[15px] font-bold">Дахин sync — {items.length} deal</div>
            <div className="text-[11.5px] text-gray-500">Нийт {fmt(items.reduce((s, x) => s + x.amount, 0))}. Эрхэт рүү бодитоор илгээнэ — урьдчилан харж батална.</div></div>
          <button onClick={onClose} className="ml-auto text-gray-400"><X size={16}/></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3 text-[12.5px]">
          {pipes.map(([pid, name]) => {
            const c = meta.configs.find(x => x.stageId === cfg[pid]);
            const n = items.filter(x => x.pipeline_id === pid).length;
            return (
              <div key={pid} className="rounded-xl border border-gray-200 p-2.5">
                <div className="mb-1 font-semibold">{name} <span className="font-normal text-gray-500">· {n} deal</span></div>
                <select value={cfg[pid] ?? ""} onChange={e => setCfg(s => ({ ...s, [pid]: e.target.value }))}
                  className="w-full rounded-lg border border-gray-200 px-2 py-1.5">
                  <option value="">— Config сонгох —</option>
                  {meta.configs.map(x => <option key={x.stageId} value={x.stageId}>
                    {x.title}{x.pipelineId !== pid ? " (өөр pipeline)" : ""} · defaultPay={x.defaultPay || "хоосон"}
                  </option>)}
                </select>
                {c && c.defaultPay !== "debtAmount" && (
                  <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-rose-50 px-2 py-1.5 text-[12px] font-semibold text-rose-700">
                    <ShieldAlert size={14}/>Энэ config-оор sync хийвэл авлага үүсэхгүй (CASH болно)
                  </div>
                )}
              </div>
            );
          })}
          <label className="block text-[11px] font-semibold text-gray-500">Огнооны төрөл (dateType)
            <select value={dateType} onChange={e => setDateType(e.target.value)} className="mt-0.5 block w-full rounded-lg border border-gray-200 px-2 py-1.5 text-[12.5px] text-gray-800">
              {meta.dateTypes.map(t => <option key={t.value} value={t.value}>{t.label}{t.value ? ` (${t.value})` : ""}</option>)}
            </select>
          </label>
          {badPay > 0 && (
            <label className="flex items-start gap-2 rounded-lg bg-amber-50 px-2.5 py-2 text-amber-900">
              <input type="checkbox" checked={fix} onChange={() => setFix(v => !v)} className="mt-0.5 accent-amber-600"/>
              <span><b>paymentsData-г засах</b> — {badPay} deal буруу бүтэцтэй. Sync хийхийн өмнө {"{}"} болгоно (хуучин утга audit-д хадгалагдана). Засварын дараа хоосон болоогүй deal-ийг sync хийхгүй.</span>
            </label>
          )}
          {preview && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
              <div className="font-semibold text-indigo-900">Урьдчилан харах (dry-run) — erxes-т юу ч бичээгүй</div>
              <ul className="mt-1 space-y-0.5 text-[12px] text-indigo-900">
                <li>{preview.n} deal · нийт {fmt(preview.amount)} · dateType = <b>{preview.dateType || "Now"}</b> · {preview.batches} батч (10-аар, дараалан)</li>
                {preview.groups.map((g: any) => <li key={g.config_stage_id}>• {g.title}: {g.n} deal, {fmt(g.amount)} {g.cash_warning && <b className="text-rose-600">— CASH болно!</b>}</li>)}
                {preview.fix_payments.length > 0 && <li>• paymentsData засагдах: {preview.fix_payments.length} deal ({preview.fix_payments.slice(0, 5).join(", ")}{preview.fix_payments.length > 5 ? "…" : ""})</li>}
                {preview.no_config.length > 0 && <li className="text-rose-600">• Config сонгоогүй: {preview.no_config.join(", ")}</li>}
              </ul>
            </div>
          )}
          {err && <div className="text-[12px] text-rose-600">{err}</div>}
        </div>
        <div className="flex items-center gap-2 border-t border-gray-100 px-4 py-3">
          <button onClick={doPreview} disabled={busy} className="rounded-xl border border-indigo-300 bg-white px-3 py-2 text-[12.5px] font-semibold text-indigo-700 disabled:opacity-50">Урьдчилан харах</button>
          <button onClick={doRun} disabled={busy || !preview || preview.no_config.length > 0}
            className="ml-auto flex items-center gap-1 rounded-xl bg-rose-600 px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40">
            <RotateCcw size={13}/>Баталгаажуулж sync хийх
          </button>
        </div>
      </div>
    </div>
  );
}

function ResyncResult({ run, onClose, onRecheck }: { run: Run; onClose: () => void; onRecheck: () => void }) {
  const acts = run.actions ?? [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3">
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center border-b border-gray-100 px-4 py-3">
          <div className="text-[15px] font-bold">Дахин sync #{run.id}</div>
          {run.status === "running" && <span className="ml-3 flex items-center gap-1 text-[12px] text-indigo-700"><RefreshCw size={12} className="animate-spin"/>{run.progress}</span>}
          {run.status === "done" && <span className="ml-3 text-[12px] text-gray-600">Амжилттай {run.summary?.ok ?? 0} · алдаатай {run.summary?.error ?? 0}</span>}
          {run.status === "error" && <span className="ml-3 text-[12px] text-rose-600">{run.error}</span>}
          {run.status !== "running" && <button onClick={onClose} className="ml-auto text-gray-400"><X size={16}/></button>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {acts.length > 0 && (
            <table className="w-full text-[11.5px]">
              <thead className="text-left text-[10px] font-bold uppercase text-gray-500"><tr>
                <th className="px-2 py-1">Deal</th><th className="px-2 py-1">Config</th><th className="px-2 py-1">Өмнө</th><th className="px-2 py-1"/><th className="px-2 py-1">Одоо</th><th className="px-2 py-1">Тайлбар</th>
              </tr></thead>
              <tbody>{acts.map(a => (
                <tr key={a.deal_id} className="border-t border-gray-100">
                  <td className="px-2 py-1 font-mono">{a.result === "ok" ? <CheckCircle2 size={12} className="mr-1 inline text-emerald-600"/> : <AlertTriangle size={12} className="mr-1 inline text-rose-600"/>}{a.number}</td>
                  <td className="px-2 py-1">{a.config_title} · {a.date_type || "Now"}</td>
                  <td className="px-2 py-1 text-rose-700">{a.before.join(", ")}</td>
                  <td><ChevronRight size={11} className="text-gray-400"/></td>
                  <td className="px-2 py-1 text-emerald-700">{a.after.join(", ")}</td>
                  <td className="px-2 py-1 text-[10.5px] text-gray-500">{a.payments_before && `paymentsData ${a.payments_before} → ${a.payments_after || "?"}; `}{a.message}</td>
                </tr>))}</tbody>
            </table>
          )}
          {run.status === "running" && !acts.length && <div className="flex items-center gap-2 py-8 text-[12.5px] text-gray-500"><Info size={13}/>Эрхэт рүү 10-аар дараалан илгээж, дараа нь үр дүнг шалгана…</div>}
        </div>
        {run.status === "done" && (
          <div className="flex border-t border-gray-100 px-4 py-3">
            <button onClick={onRecheck} className="ml-auto flex items-center gap-1 rounded-xl bg-indigo-600 px-4 py-2 text-[12.5px] font-semibold text-white"><Play size={13}/>Дахин шалгах</button>
          </div>
        )}
      </div>
    </div>
  );
}
