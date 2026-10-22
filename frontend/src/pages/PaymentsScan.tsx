import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Loader2, Download, Wrench, X, AlertTriangle, CheckCircle2, ChevronRight, Settings2, RefreshCw,
} from "lucide-react";
import { api } from "../lib/api";

/* paymentsData илрүүлэгч ба засагч — Erkhet sync шалгалтын дэд хэсэг.
   paymentsData буруу ({"totalAmount": N}) → syncerkhet «undefined» илгээж Эрхэт CASH гэж бүртгэдэг
   (авлага үүсдэггүй). Мөн Erxes-ийн одоогийн дүн Эрхэт рүү sync хийгдсэн дүнтэй тэнцүү эсэх.
   Засвар/sync нь зөвхөн сонгосон deal дээр, dry-run баталсны дараа, эхлээд 1 deal. */

interface Meta {
  boards: { _id: string; name: string; pipelines: { _id: string; name: string; included: boolean }[] }[];
  defaultBoardId: string; canResync: boolean;
}
interface Item {
  deal_id: string; number: string; name: string; pipeline_id: string; stage_id: string; category: string;
  erxes_amount: number; erkhet_amount: number | null; amount_diff: number; erkhet_payment: string;
  last_sync_undefined: boolean; payments_bad: boolean; severity: string; issues: string[];
  data: {
    board: string; pipeline: string; stage: string; customer: string; createdAt: string; paymentsData: unknown;
    tick_sum: number; sent_amount: number | null; erkhet_paid: number | null; last_sync_at: string | null;
    eff_sync_at: string | null; eff_date: string; items: ItemRow[]; last_user: string; hist_count: number;
  };
}
interface ItemRow {
  code: string; name: string; sent_code: string; erxes_qty: number | null; erxes_price: number | null; erxes_discount: number | null;
  erxes_amount: number | null; sent_qty: number | null; sent_amount: number | null; diff: number; mismatch: boolean;
}
interface Run {
  id: number; kind: string; status: string; params: any; progress: string; done_n: number; total_n: number;
  summary: any; error: string; created_by: string; created_at: string; items?: Item[]; actions?: Action[];
}
interface PlanItem {
  deal_id: string; number: string; name: string; stage: string; category: string; action: string;
  payments_before: unknown; payments_after: unknown; need_fix: boolean; issues: string[]; erxes_amount: number;
  erkhet_before: number | null; prev_date: string; sync: boolean; config_title: string; date_type: string; reason: string;
}
interface Action {
  id: number; number: string; action: string; payments_before: string; payments_after: string; result: string;
  message: string; erkhet_before: number | null; erkhet_after: number | null; date_type: string; config_title: string;
}

const CAT_LABEL: Record<string, string> = { expected: "Эцэслэсэн", pending: "Бэлтгэх", cancel: "Цуцлах" };
const SEV_CLS: Record<string, string> = {
  error: "bg-rose-50 text-rose-700 border-rose-200", warn: "bg-amber-50 text-amber-800 border-amber-200",
  info: "bg-sky-50 text-sky-700 border-sky-200", ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
};
const ACTION_LABEL: Record<string, string> = {
  fix_sync: "Засаад sync", fix_only: "Зөвхөн paymentsData засна", sync_only: "Зөвхөн дахин sync", skip: "Алгасна",
};

function money(n: number | null | undefined) {
  if (n == null) return "—";
  return `${Math.round(n).toLocaleString("en-US")}₮`;
}
function signed(n: number) {
  const r = Math.round(n);
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toLocaleString("en-US")}₮`;
}
function ub(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}
function pd(v: unknown) {
  if (v == null || (typeof v === "object" && Object.keys(v as object).length === 0)) return "{}";
  return JSON.stringify(v);
}
function iso(d: Date) { return d.toISOString().slice(0, 10); }

export default function PaymentsScan() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [issueInfo, setIssueInfo] = useState<Record<string, [string, string]>>({});
  const [allowed, setAllowed] = useState<string[]>([]);
  const [boardId, setBoardId] = useState("");
  const [start, setStart] = useState(() => iso(new Date(Date.now() - 30 * 86400000)));
  const [end, setEnd] = useState(() => iso(new Date()));
  const [cats, setCats] = useState<string[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // клиент талын шүүлтүүр
  const [fIssue, setFIssue] = useState("");
  const [fCat, setFCat] = useState("");
  const [fPipe, setFPipe] = useState("");
  const [fCash, setFCash] = useState(false);
  const [fMismatch, setFMismatch] = useState(false);
  const [fMin, setFMin] = useState("");
  const [fProblems, setFProblems] = useState(true);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Item | null>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    api.get("/erkhet-sync/meta").then(r => { setMeta(r.data); setBoardId(""); })
      .catch(e => setErr(e?.response?.data?.detail ?? "erxes meta ачаалж чадсангүй"));
    api.get("/erkhet-sync/payments/settings").then(r => { setIssueInfo(r.data.issues); setAllowed(r.data.allowed); })
      .catch(() => {});
  }, []);

  const loadRuns = useCallback(async () => {
    const r = await api.get("/erkhet-sync/payments-scan/runs", { params: { kind: "scan,auto", limit: 15 } });
    setRuns(r.data);
    return r.data as Run[];
  }, []);

  const openRun = useCallback(async (id: number) => {
    const r = await api.get(`/erkhet-sync/payments-scan/runs/${id}`, { timeout: 120000 });
    setRun(r.data); setSel(new Set());
    if (r.data.status === "running") {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        const x = await api.get(`/erkhet-sync/payments-scan/runs/${id}`, { timeout: 120000 });
        setRun(x.data);
        if (x.data.status !== "running" && pollRef.current) {
          clearInterval(pollRef.current); pollRef.current = null; loadRuns();
        }
      }, 3000);
    }
  }, [loadRuns]);

  useEffect(() => {
    loadRuns().then(rs => { const d = rs.find(x => x.status === "done" || x.status === "running"); if (d) openRun(d.id); })
      .catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadRuns, openRun]);

  async function startScan() {
    setErr("");
    try {
      const r = await api.post("/erkhet-sync/payments-scan", {
        boardIds: boardId ? [boardId] : [], startDate: start, endDate: end, categories: cats });
      await loadRuns();
      openRun(r.data.run_id);
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Скан эхлүүлж чадсангүй"); }
  }

  async function exportXlsx() {
    if (!run) return;
    const r = await api.get(`/erkhet-sync/payments-scan/runs/${run.id}/xlsx`, { responseType: "blob", timeout: 120000 });
    const url = URL.createObjectURL(r.data);
    const a = document.createElement("a");
    a.href = url; a.download = `paymentsData_${run.params?.startDate ?? ""}_${run.params?.endDate ?? ""}.xlsx`;
    a.click(); URL.revokeObjectURL(url);
  }

  const items = run?.items ?? [];
  const pipes = useMemo(() => Array.from(new Set(items.map(i => i.data.pipeline))).filter(Boolean).sort(), [items]);
  const shown = useMemo(() => {
    const min = Number(fMin) || 0;
    const s = q.trim().toLowerCase();
    return items.filter(i =>
      (!fProblems || i.severity !== "ok")
      && (!fIssue || i.issues.includes(fIssue))
      && (!fCat || i.category === fCat)
      && (!fPipe || i.data.pipeline === fPipe)
      && (!fCash || i.erkhet_payment === "CASH")
      && (!fMismatch || i.issues.includes("AMOUNT_MISMATCH"))
      && (!min || Math.abs(i.amount_diff) >= min)
      && (!s || i.number.toLowerCase().includes(s) || i.name.toLowerCase().includes(s)
          || (i.data.customer || "").toLowerCase().includes(s)));
  }, [items, fProblems, fIssue, fCat, fPipe, fCash, fMismatch, fMin, q]);
  const sm = run?.summary ?? {};
  const issueCodes = useMemo(() => Array.from(new Set(items.flatMap(i => i.issues))).sort(), [items]);

  function toggle(id: string) {
    setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div className="flex flex-col gap-3 p-1">
      {/* Скан */}
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-gray-200 bg-white p-3">
        <label className="text-[11px] text-gray-500">Board
          <select value={boardId} onChange={e => setBoardId(e.target.value)}
            className="mt-0.5 block rounded-lg border border-gray-200 px-2 py-1.5 text-[12.5px]">
            <option value="">Бүгд</option>
            {meta?.boards.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-gray-500">Үүссэн (УБ) — эхлэх
          <input type="date" value={start} onChange={e => setStart(e.target.value)}
            className="mt-0.5 block rounded-lg border border-gray-200 px-2 py-1 text-[12.5px]"/>
        </label>
        <label className="text-[11px] text-gray-500">дуусах
          <input type="date" value={end} onChange={e => setEnd(e.target.value)}
            className="mt-0.5 block rounded-lg border border-gray-200 px-2 py-1 text-[12.5px]"/>
        </label>
        <div className="text-[11px] text-gray-500">Stage-ийн ангилал
          <div className="mt-0.5 flex gap-1">
            {Object.entries(CAT_LABEL).map(([k, l]) => (
              <button key={k} onClick={() => setCats(c => c.includes(k) ? c.filter(x => x !== k) : [...c, k])}
                className={`rounded-lg border px-2 py-1 text-[12px] ${cats.includes(k) ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-gray-200 text-gray-600"}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <button onClick={startScan} disabled={run?.status === "running"}
          className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
          {run?.status === "running" ? <Loader2 size={14} className="animate-spin"/> : <Search size={14}/>}Скан хийх
        </button>
        <select value={run?.id ?? ""} onChange={e => e.target.value && openRun(Number(e.target.value))}
          className="ml-auto rounded-lg border border-gray-200 px-2 py-1.5 text-[12px] text-gray-600">
          <option value="">Өмнөх скан…</option>
          {runs.map(r => (
            <option key={r.id} value={r.id}>
              #{r.id} {r.kind === "auto" ? "(автомат) " : ""}{r.params?.startDate}–{r.params?.endDate} · {r.status === "done" ? `${r.summary?.total ?? 0} deal` : r.status}
            </option>
          ))}
        </select>
        <button onClick={() => setShowSettings(v => !v)} title="Зөвшөөрөгдсөн төлбөрийн төрөл"
          className="rounded-lg border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-50"><Settings2 size={14}/></button>
      </div>

      {showSettings && <AllowedTypes allowed={allowed} onSaved={setAllowed} canEdit={!!meta?.canResync}/>}

      {err && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          <AlertTriangle size={13}/>{err}<button className="ml-auto" onClick={() => setErr("")}><X size={12}/></button>
        </div>
      )}

      {run?.status === "running" && (
        <div className="flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-[12.5px] text-indigo-800">
          <Loader2 size={14} className="animate-spin"/>Скан #{run.id}: {run.progress}
          {run.total_n > 0 && <span className="ml-auto font-mono">{run.total_n} deal</span>}
        </div>
      )}
      {run?.status === "error" && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">Скан алдаа: {run.error}</div>
      )}

      {run?.status === "done" && (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Kpi label="Буруу paymentsData" value={String(sm.payments_bad ?? 0)} bad={!!sm.payments_bad}/>
            <Kpi label="Дүн зөрүүтэй deal" value={String(sm.amount_mismatch ?? 0)} bad={!!sm.amount_mismatch}
              sub={sm.amount_mismatch ? `нийт ${signed(sm.amount_mismatch_sum ?? 0)} · |${money(sm.amount_mismatch_abs)}|` : ""}/>
            <Kpi label="Erkhet дээр CASH" value={String(sm.cash_n ?? 0)} bad={!!sm.cash_n} sub={sm.cash_n ? money(sm.cash_amount) : ""}/>
            <Kpi label="Erkhet хариугүй" value={String(sm.no_response ?? 0)} bad={!!sm.no_response}/>
            <Kpi label="Шалгасан deal" value={String(sm.total ?? 0)} sub={`#${run.id} · ${run.params?.startDate}–${run.params?.endDate}`}/>
          </div>

          {/* Шүүлтүүр */}
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white p-2.5 text-[12px]">
            <label className="flex items-center gap-1"><input type="checkbox" checked={fProblems} onChange={e => setFProblems(e.target.checked)}/>Зөвхөн асуудалтай</label>
            <select value={fIssue} onChange={e => setFIssue(e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1">
              <option value="">Бүх асуудал</option>
              {issueCodes.map(c => <option key={c} value={c}>{issueInfo[c]?.[1] ?? c} ({sm.by_issue?.[c] ?? 0})</option>)}
            </select>
            <select value={fCat} onChange={e => setFCat(e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1">
              <option value="">Бүх ангилал</option>
              {Object.entries(CAT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select value={fPipe} onChange={e => setFPipe(e.target.value)} className="max-w-[12rem] rounded-lg border border-gray-200 px-2 py-1">
              <option value="">Бүх pipeline</option>
              {pipes.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <label className="flex items-center gap-1"><input type="checkbox" checked={fCash} onChange={e => setFCash(e.target.checked)}/>Erkhet дээр CASH</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={fMismatch} onChange={e => setFMismatch(e.target.checked)}/>Зөвхөн дүн зөрүүтэй</label>
            <label className="flex items-center gap-1">Зөрүү ≥
              <input value={fMin} onChange={e => setFMin(e.target.value.replace(/[^\d]/g, ""))} placeholder="0"
                className="w-20 rounded-lg border border-gray-200 px-1.5 py-0.5 text-right"/>₮
            </label>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Дугаар, нэр, харилцагч…"
              className="min-w-[10rem] flex-1 rounded-lg border border-gray-200 px-2 py-1"/>
            <span className="text-gray-500">{shown.length} мөр</span>
            <button onClick={exportXlsx} className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 hover:bg-gray-50">
              <Download size={12}/>Excel
            </button>
            {meta?.canResync && (
              <button onClick={() => setFixOpen(true)} disabled={sel.size === 0}
                className="flex items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1 font-semibold text-white hover:bg-rose-700 disabled:opacity-40">
                <Wrench size={12}/>Засаж sync хийх ({sel.size})
              </button>
            )}
          </div>

          {/* Хүснэгт */}
          <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="px-2 py-2">
                    <input type="checkbox" checked={shown.length > 0 && shown.every(i => sel.has(i.deal_id))}
                      onChange={e => setSel(e.target.checked ? new Set(shown.map(i => i.deal_id)) : new Set())}/>
                  </th>
                  {["Deal №", "Нэр / харилцагч", "Pipeline / stage", "Erxes дүн", "Erkhet дүн", "Зөрүү", "paymentsData", "Асуудал", "Сүүлийн sync", "Erkhet"].map((h, i) => (
                    <th key={h} className={`whitespace-nowrap px-2 py-2 font-bold ${i >= 3 && i <= 5 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 1000).map(i => (
                  <tr key={i.deal_id} className="cursor-pointer border-t border-gray-100 hover:bg-indigo-50/40" onClick={() => setOpen(i)}>
                    <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(i.deal_id)} onChange={() => toggle(i.deal_id)}/>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px]">{i.number}</td>
                    <td className="max-w-[14rem] px-2 py-1.5">
                      <div className="truncate text-gray-900">{i.name}</div>
                      <div className="truncate text-[11px] text-gray-500">{i.data.customer}</div>
                    </td>
                    <td className="max-w-[12rem] px-2 py-1.5">
                      <div className="truncate text-gray-700">{i.data.pipeline}</div>
                      <div className="truncate text-[11px] text-gray-500">{i.data.stage} · {CAT_LABEL[i.category] ?? i.category}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums">{money(i.erxes_amount)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums">{money(i.erkhet_amount)}</td>
                    <td className={`whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums ${i.erkhet_amount != null && Math.abs(i.amount_diff) > 1 ? "font-bold text-rose-600" : "text-gray-300"}`}>
                      {i.erkhet_amount != null ? signed(i.amount_diff) : ""}
                    </td>
                    <td className={`max-w-[12rem] truncate px-2 py-1.5 font-mono text-[10.5px] ${i.payments_bad ? "text-rose-700" : "text-gray-500"}`}
                      title={pd(i.data.paymentsData)}>{pd(i.data.paymentsData)}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {i.issues.map(c => (
                          <span key={c} title={issueInfo[c]?.[1]}
                            className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${SEV_CLS[(issueInfo[c]?.[0]) ?? "info"]}`}>{c}</span>
                        ))}
                        {i.issues.length === 0 && <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${SEV_CLS.ok}`}>OK</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[10.5px] text-gray-500">{ub(i.data.last_sync_at)}</td>
                    <td className={`whitespace-nowrap px-2 py-1.5 text-[11px] font-semibold ${i.erkhet_payment === "CASH" ? "text-rose-600" : i.erkhet_payment ? "text-emerald-600" : "text-gray-400"}`}>
                      {i.erkhet_payment === "PAYMENT_CARD" ? "Авлага" : i.erkhet_payment === "CASH" ? "CASH" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <p className="py-6 text-center text-[12px] text-gray-400">Шүүлтүүрт тохирох deal алга.</p>}
            {shown.length > 1000 && <p className="py-2 text-center text-[11px] text-gray-400">Эхний 1000 мөр — шүүлтүүрээ нарийсгана уу.</p>}
          </div>
        </>
      )}

      {open && <Drawer item={open} issueInfo={issueInfo} onClose={() => setOpen(null)}/>}
      {fixOpen && run && (
        <FixModal ids={Array.from(sel)} items={items} onClose={() => setFixOpen(false)}
          onDone={() => { setFixOpen(false); }}/>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, bad }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <div className={`rounded-2xl border p-3 ${bad ? "border-rose-200 bg-rose-50/50" : "border-gray-200 bg-white"}`}>
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`text-[22px] font-black leading-tight ${bad ? "text-rose-700" : "text-gray-900"}`}>{value}</div>
      {sub && <div className="truncate text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}

function AllowedTypes({ allowed, onSaved, canEdit }: { allowed: string[]; onSaved: (v: string[]) => void; canEdit: boolean }) {
  const [v, setV] = useState(allowed.join(", "));
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white p-3 text-[12px]">
      <span className="font-semibold text-gray-700">Зөвшөөрөгдсөн төлбөрийн төрөл (paymentsData-ийн түлхүүр):</span>
      <input value={v} onChange={e => setV(e.target.value)} disabled={!canEdit}
        className="min-w-[12rem] flex-1 rounded-lg border border-gray-200 px-2 py-1 font-mono"/>
      {canEdit && (
        <button disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const r = await api.put("/erkhet-sync/payments/settings", { types: v.split(",").map(s => s.trim()) });
            onSaved(r.data.allowed); setV(r.data.allowed.join(", "));
          } finally { setBusy(false); }
        }} className="rounded-lg bg-indigo-600 px-3 py-1 font-semibold text-white disabled:opacity-50">Хадгалах</button>
      )}
      <span className="w-full text-[11px] text-gray-400">erxes-д deal-ийн төлбөрийн төрлийн тохиргоо алга (2026-10-22 шалгасан) — бодит өгөгдөлд зөвхөн «other» байна.</span>
    </div>
  );
}

function Drawer({ item: i, issueInfo, onClose }: { item: Item; issueInfo: Record<string, [string, string]>; onClose: () => void }) {
  const rows = i.data.items ?? [];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-3xl overflow-y-auto bg-white p-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="font-mono text-[15px] font-bold text-gray-900">{i.number}</h2>
            <p className="text-[12.5px] text-gray-700">{i.name} · {i.data.customer}</p>
            <p className="text-[11.5px] text-gray-500">{i.data.board} / {i.data.pipeline} / {i.data.stage} ({CAT_LABEL[i.category] ?? i.category}) · үүссэн {ub(i.data.createdAt)}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100"><X size={16}/></button>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
          <Box label="A · Erxes дүн" v={money(i.erxes_amount)} sub={`tickUsed нийлбэр ${money(i.data.tick_sum)}`}/>
          <Box label="B · Erkhet рүү илгээсэн" v={money(i.data.sent_amount)}/>
          <Box label="C · Erkhet бүртгэсэн" v={money(i.erkhet_amount)} sub={i.erkhet_payment || "—"}/>
          <Box label="Зөрүү (C − A)" v={i.erkhet_amount != null ? signed(i.amount_diff) : "—"} bad={i.erkhet_amount != null && Math.abs(i.amount_diff) > 1}/>
        </div>

        <div className="mb-3 space-y-1">
          {i.issues.map(c => (
            <div key={c} className={`rounded-lg border px-2 py-1 text-[12px] ${SEV_CLS[issueInfo[c]?.[0] ?? "info"]}`}>
              <b className="font-mono">{c}</b> — {issueInfo[c]?.[1]}
            </div>
          ))}
        </div>

        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">paymentsData</h3>
        <pre className={`mb-3 overflow-auto rounded-lg px-2 py-1.5 text-[11.5px] ${i.payments_bad ? "bg-rose-50 text-rose-800" : "bg-gray-50"}`}>
          {JSON.stringify(i.data.paymentsData ?? {}, null, 2)}
        </pre>

        <p className="mb-2 text-[11.5px] text-gray-500">
          Сүүлийн амжилттай sync: {ub(i.data.eff_sync_at) || "—"} (огноо {i.data.eff_date || "—"}) · сүүлийн оролдлого {ub(i.data.last_sync_at) || "—"} · {i.data.hist_count} оролдлого · {i.data.last_user}
        </p>

        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">Бараа тус бүрийн тулгалт</h3>
        {rows.length === 0 ? <p className="text-[12px] text-gray-400">Амжилттай sync алга — тулгах зүйлгүй.</p> : (
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr className="bg-gray-50 text-[10px] uppercase text-gray-500">
                {["Код", "Нэр", "Erxes: тоо × үнэ − хямдрал", "Erxes дүн", "Erkhet рүү: тоо", "Erkhet рүү дүн", "Зөрүү"].map((h, k) => (
                  <th key={h} className={`px-1.5 py-1 ${k >= 2 ? "text-right" : "text-left"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.code} className={`border-t border-gray-100 ${r.mismatch ? "bg-rose-50 font-semibold text-rose-800" : ""}`}>
                  <td className="px-1.5 py-1 font-mono">{r.code}{r.sent_code && <div className="text-[10px] font-normal text-amber-700" title="Erkhet рүү өөр кодоор илгээгдсэн (код sync-ээс хойш өөрчлөгдсөн байж болно)">→ {r.sent_code}</div>}</td>
                  <td className="max-w-[12rem] truncate px-1.5 py-1">{r.name}</td>
                  <td className="whitespace-nowrap px-1.5 py-1 text-right font-mono">
                    {r.erxes_qty == null ? "—" : `${r.erxes_qty} × ${Math.round(r.erxes_price ?? 0).toLocaleString("en-US")}${r.erxes_discount ? ` − ${Math.round(r.erxes_discount).toLocaleString("en-US")}` : ""}`}
                  </td>
                  <td className="whitespace-nowrap px-1.5 py-1 text-right font-mono">{money(r.erxes_amount)}</td>
                  <td className="whitespace-nowrap px-1.5 py-1 text-right font-mono">{r.sent_qty ?? "—"}</td>
                  <td className="whitespace-nowrap px-1.5 py-1 text-right font-mono">{money(r.sent_amount)}</td>
                  <td className="whitespace-nowrap px-1.5 py-1 text-right font-mono">{Math.abs(r.diff) > 1 ? signed(r.diff) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Box({ label, v, sub, bad }: { label: string; v: string; sub?: string; bad?: boolean }) {
  return (
    <div className={`rounded-xl border p-2 ${bad ? "border-rose-200 bg-rose-50" : "border-gray-200"}`}>
      <div className="text-[10.5px] text-gray-500">{label}</div>
      <div className={`font-mono text-[14px] font-bold ${bad ? "text-rose-700" : "text-gray-900"}`}>{v}</div>
      {sub && <div className="text-[10.5px] text-gray-500">{sub}</div>}
    </div>
  );
}

function FixModal({ ids, items, onClose, onDone }: { ids: string[]; items: Item[]; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"empty" | "other">("empty");
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [fixRun, setFixRun] = useState<Run | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [firstDone, setFirstDone] = useState(false);
  const byId = useMemo(() => Object.fromEntries(items.map(i => [i.deal_id, i])), [items]);

  async function preview() {
    setBusy(true); setErr(""); setPlan(null); setFixRun(null); setFirstDone(false); setRemaining(null);
    try {
      const r = await api.post("/erkhet-sync/payments-fix/preview", { deal_ids: ids, mode }, { timeout: 600000 });
      setPlan(r.data.plan); setToken(r.data.token);
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Dry-run амжилтгүй"); }
    finally { setBusy(false); }
  }

  async function execute(onlyFirst: boolean) {
    const n = onlyFirst ? 1 : remaining ?? 0;
    if (!confirm(onlyFirst ? "Эхний 1 deal дээр ажиллуулах уу?" : `Үлдсэн ${n} deal дээр ажиллуулах уу?`)) return;
    setBusy(true); setErr("");
    try {
      const r = await api.post("/erkhet-sync/payments-fix", { token, only_first: onlyFirst, confirm: true });
      setRemaining(onlyFirst ? r.data.remaining : 0);
      const poll = async () => {
        const x = await api.get(`/erkhet-sync/payments-scan/runs/${r.data.run_id}`);
        setFixRun(x.data);
        if (x.data.status === "running") setTimeout(poll, 3000);
        else { setBusy(false); if (onlyFirst) setFirstDone(true); }
      };
      poll();
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Ажиллуулж чадсангүй"); setBusy(false); }
  }

  const todo = plan?.filter(p => p.action !== "skip") ?? [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <Wrench size={16} className="text-rose-600"/>
          <h2 className="text-[15px] font-bold">paymentsData засаж sync хийх — {ids.length} deal</h2>
          <button onClick={onClose} className="ml-auto rounded-lg p-1 text-gray-400 hover:bg-gray-100"><X size={16}/></button>
        </div>
        <div className="mb-3 space-y-1 text-[12.5px]">
          <label className="flex items-start gap-2">
            <input type="radio" checked={mode === "empty"} onChange={() => setMode("empty")} className="mt-1"/>
            <span><b>paymentsData = {"{}"}</b> (анхдагч) — 2026-10-д 89 deal дээр баталсан; sync хийхэд дүн бүхэлдээ авлага (debtAmount) болно.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={mode === "other"} onChange={() => setMode("other")} className="mt-1"/>
            <span><b>{'{"other": {"amount": <tickUsed нийлбэр>, "currency": "MNT"}}'}</b></span>
          </label>
          <p className="text-[11.5px] text-gray-500">
            Зөвхөн «Эцэслэсэн» stage-ийн deal-ийг sync хийнэ; бэлтгэх/цуцлах stage-д зөвхөн paymentsData засна. Config-ийг
            өмнөх sync-ийн hasVat, userEmail-ээр; огноог өмнөх sync-ийн огноотой тааруулж (created / lastMove) сонгоно —
            таарахгүй бол sync хийхгүй. Засахын өмнө хуучин paymentsData audit-д хадгалагдана; бараа/дүн/stage өөрчлөгдвөл бүгд зогсоно.
          </p>
        </div>
        <button onClick={preview} disabled={busy}
          className="mb-3 flex items-center gap-1.5 rounded-xl border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-[12.5px] font-semibold text-indigo-700 disabled:opacity-50">
          {busy && !fixRun ? <Loader2 size={13} className="animate-spin"/> : <RefreshCw size={13}/>}Dry-run (юу ч бичихгүй)
        </button>
        {err && <p className="mb-2 rounded-lg bg-rose-50 px-2 py-1 text-[12px] text-rose-700">{err}</p>}

        {plan && (
          <div className="mb-3 overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full border-collapse text-[11.5px]">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase text-gray-500">
                  {["Deal", "Үйлдэл", "paymentsData: хуучин → шинэ", "Config / dateType", "Erkhet дүн", "Тайлбар"].map(h => (
                    <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.map(p => {
                  const it = byId[p.deal_id];
                  const diff = p.erkhet_before != null ? p.erkhet_before - p.erxes_amount : null;
                  return (
                    <tr key={p.deal_id} className={`border-t border-gray-100 ${p.action === "skip" ? "text-gray-400" : ""}`}>
                      <td className="whitespace-nowrap px-2 py-1 font-mono">{p.number}<div className="text-[10.5px] text-gray-500">{p.stage}</div></td>
                      <td className="whitespace-nowrap px-2 py-1 font-semibold">{ACTION_LABEL[p.action] ?? p.action}</td>
                      <td className="max-w-[16rem] px-2 py-1 font-mono text-[10.5px]">
                        {p.need_fix ? <><span className="text-rose-700">{pd(p.payments_before)}</span> → <span className="text-emerald-700">{pd(p.payments_after)}</span></> : <span className="text-gray-400">өөрчлөхгүй</span>}
                      </td>
                      <td className="max-w-[14rem] px-2 py-1 text-[10.5px]">{p.sync ? <>{p.config_title}<div className="font-mono">{p.date_type} · {p.prev_date}</div></> : "—"}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-[10.5px]">
                        {p.sync && diff != null && Math.abs(diff) > 1
                          ? <>Erkhet {money(p.erkhet_before)} → {money(p.erxes_amount)} <span className="text-rose-600">({signed(-diff)})</span></>
                          : p.sync ? money(p.erxes_amount) : it ? money(it.erxes_amount) : ""}
                      </td>
                      <td className="max-w-[16rem] px-2 py-1 text-[10.5px] text-gray-500">{p.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {plan && todo.length > 0 && !firstDone && !fixRun && (
          <button onClick={() => execute(true)} disabled={busy}
            className="flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
            <ChevronRight size={14}/>Эхний 1 deal-ийг ажиллуулах ({todo[0].number})
          </button>
        )}
        {plan && todo.length === 0 && <p className="text-[12px] text-gray-500">Хийх зүйл алга — бүгд алгасагдана.</p>}

        {fixRun && (
          <div className="mt-3 rounded-xl border border-gray-200 p-3">
            <div className="mb-1 flex items-center gap-2 text-[12.5px]">
              {fixRun.status === "running" ? <Loader2 size={14} className="animate-spin text-indigo-600"/>
                : fixRun.status === "done" ? <CheckCircle2 size={14} className="text-emerald-600"/>
                : <AlertTriangle size={14} className="text-rose-600"/>}
              <b>Засвар #{fixRun.id}</b> — {fixRun.status === "running" ? fixRun.progress : fixRun.status === "done" ? "дууслаа" : fixRun.error || fixRun.status}
            </div>
            {(fixRun.actions ?? []).map(a => (
              <div key={a.id} className={`mt-1 rounded-lg px-2 py-1 text-[11.5px] ${a.result === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>
                <b className="font-mono">{a.number}</b> · {ACTION_LABEL[a.action] ?? a.action} · {a.result}
                {a.erkhet_after != null && <> · Erkhet {money(a.erkhet_before)} → {money(a.erkhet_after)}</>}
                <div className="text-[10.5px] opacity-80">{a.message}</div>
              </div>
            ))}
            {firstDone && fixRun.status === "done" && (remaining ?? 0) > 0 && (
              <button onClick={() => execute(false)} disabled={busy}
                className="mt-2 flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
                <ChevronRight size={14}/>Үлдсэн {remaining} deal-ийг ажиллуулах
              </button>
            )}
            {fixRun.status !== "running" && (firstDone ? (remaining ?? 0) === 0 : true) && (
              <button onClick={onDone} className="mt-2 rounded-xl border border-gray-200 px-3 py-1.5 text-[12px]">Хаах</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

