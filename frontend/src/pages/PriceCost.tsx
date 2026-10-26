import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw, Loader2, Download, Settings2, Search, ChevronDown, ChevronRight, Info, AlertTriangle, History,
} from "lucide-react";
import { api } from "../lib/api";

/* Үнийн тохиргоо — Хархорин агуулахын зарах үнийг Эрхэтийн сүүлийн орлогын нэгж үнэтэй тулгана.
   2-р шат: ЗӨВХӨН УНШИНА (erxes/Эрхэтэд юу ч бичихгүй). «Санал» багана нь 4-р шатанд батлах dry-run.
   POS «Хархорин агуулах»-ын үнийг онлайнаар асуух боломжгүй тул «Бодит» = сүүлийн борлуулалтын үнэ. */

interface Plan {
  id: string; name: string; type: string; value: number; priority: boolean; conditional: boolean;
  shared: boolean; own: boolean; price: number | null;
}
interface Row {
  code: string; name: string; brand: string; uom: string; non_piece: boolean; in_erxes: boolean;
  income: number | null; income_date: string; income_customer: string; income_bill: string; income_count: number | null;
  prev_income: number | null; prev_income_date: string; base: number | null; config: number | null; config_how: string;
  plans: Plan[]; others: number; real: number | null; real_date: string; real_order: string;
  since_count: number; since_qty: number; since_prices: number[];
  diff_config: number | null; diff_config_pct: number | null; diff_real: number | null; diff_real_pct: number | null;
  status: "eq" | "high" | "low" | "none"; action: "" | "create" | "update"; review: boolean;
}
interface Summary {
  eq: number; high: number; low: number; none: number; total: number; overlap: number; with_income: number;
  not_in_erxes: number; non_piece: number; pending: number; review: number;
}
interface Result {
  rows: Row[]; summary: Summary; generated_at: string; dept_plans: number; unsupported_plans: string[];
  stats: { income: { from: string; rows: number }; pos: { from: string; items: number }; seconds: number };
}
interface Settings {
  locations: string[]; brands: string[]; exclude_customers: string[]; guard_pct: number; max_apply: number; year_start: string;
}
interface Run { id: number; started_at: string; finished_at: string | null; status: string; by: string; stats: any; error: string }

const STATUS: Record<string, { label: string; dot: string; chip: string }> = {
  eq:   { label: "Таарч байна",       dot: "🟢", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  high: { label: "Орлогоос өндөр",    dot: "🟡", chip: "bg-amber-50 text-amber-800 border-amber-200" },
  low:  { label: "Орлогоос доогуур",  dot: "🔴", chip: "bg-rose-50 text-rose-700 border-rose-200" },
  none: { label: "Орлогогүй",         dot: "⚪", chip: "bg-gray-50 text-gray-500 border-gray-200" },
};
const TYPE_LABEL: Record<string, string> = { fixed: "тогтмол", subtraction: "хасах", percentage: "%" };
const LOCS = [{ id: "7", name: "05 Хархорин агуулах" }, { id: "6", name: "04 Хархорин заал" }];

function ub(iso?: string | null) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function m(v: number | null | undefined) {
  return v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function signed(v: number | null, pct: number | null) {
  if (v == null) return <span className="text-gray-300">—</span>;
  if (Math.abs(v) < 0.5) return <span className="text-emerald-600">0</span>;
  const cls = v > 0 ? "text-amber-700" : "text-rose-600";
  return (
    <span className={cls}>
      {v > 0 ? "+" : ""}{m(v)}
      {pct != null && <span className="ml-1 text-[10.5px] opacity-70">({v > 0 ? "+" : ""}{pct}%)</span>}
    </span>
  );
}

type Filter = "all" | "eq" | "high" | "low" | "none" | "overlap" | "pending";

export default function PriceCost() {
  const [res, setRes] = useState<Result | null>(null);
  const [st, setSt] = useState<{ running: boolean; error: string; step: string; next_manual_in: number } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [brand, setBrand] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [showSet, setShowSet] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [limit, setLimit] = useState(300);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get("/price-cost/data", { timeout: 60000 });
      setRes(r.data.result); setSt(r.data.status); setSettings(r.data.settings);
      setRuns(r.data.runs ?? []); setIsAdmin(!!r.data.is_admin);
      return r.data.status;
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Ачаалж чадсангүй");
      return null;
    } finally { setLoading(false); }
  }, []);

  const watch = useCallback(() => {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      const s = await load();
      if (!s?.running && poll.current) { clearInterval(poll.current); poll.current = null; }
    }, 4000);
  }, [load]);

  useEffect(() => {
    load().then(s => { if (s?.running) watch(); });
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [load, watch]);

  async function refresh(full = false) {
    setErr("");
    try {
      await api.post(`/price-cost/run${full ? "?full=true" : ""}`);
      setSt(s => ({ ...(s ?? { error: "", next_manual_in: 0, step: "" }), running: true }));
      watch();
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Шинэчилж чадсангүй"); }
  }

  async function download() {
    try {
      const r = await api.get("/price-cost/xlsx", { responseType: "blob", timeout: 60000 });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url; a.download = `Үнийн_тохиргоо_${(ub(res?.generated_at) || "").replace(/[: ]/g, "-")}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
    } catch { setErr("Excel татаж чадсангүй"); }
  }

  const brands = useMemo(() => [...new Set((res?.rows ?? []).map(r => r.brand).filter(Boolean))].sort(), [res]);

  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return (res?.rows ?? []).filter(r => {
      if (brand && r.brand !== brand) return false;
      if (filter === "overlap" && !r.others) return false;
      if (filter === "pending" && !r.action) return false;
      if (["eq", "high", "low", "none"].includes(filter) && r.status !== filter) return false;
      if (qq && !r.code.toLowerCase().includes(qq) && !r.name.toLowerCase().includes(qq)) return false;
      return true;
    });
  }, [res, filter, brand, q]);

  const s = res?.summary;
  const tiles: { key: Filter; label: string; n?: number; cls: string }[] = [
    { key: "all", label: "Нийт бараа", n: s?.total, cls: "text-gray-900" },
    { key: "eq", label: "🟢 Таарч байна", n: s?.eq, cls: "text-emerald-700" },
    { key: "high", label: "🟡 Орлогоос өндөр", n: s?.high, cls: "text-amber-700" },
    { key: "low", label: "🔴 Орлогоос доогуур", n: s?.low, cls: "text-rose-600" },
    { key: "none", label: "⚪ Орлогогүй", n: s?.none, cls: "text-gray-500" },
    { key: "overlap", label: "🟠 Бусдын plan-тай", n: s?.overlap, cls: "text-orange-600" },
    { key: "pending", label: "Санал болгох өөрчлөлт", n: s?.pending, cls: "text-indigo-700" },
  ];

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-lg font-semibold text-gray-900 sm:text-xl">Үнийн тохиргоо — Хархорин агуулах</h1>
          <p className="text-xs text-gray-500">
            Зарах үнэ = Эрхэтийн «{(settings?.locations ?? ["7"]).map(l => LOCS.find(x => x.id === l)?.name ?? l).join(", ")}»
            байршлын сүүлийн орлогын нэгж үнэ
            {res && <> · {ub(res.generated_at)}-ийн байдлаар</>}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {isAdmin && (
            <button onClick={() => setShowSet(v => !v)} title="Тохиргоо"
              className={`rounded-xl border p-2 text-gray-500 hover:bg-gray-50 ${showSet ? "border-gray-400 bg-gray-50" : "border-gray-200 bg-white"}`}>
              <Settings2 size={15} />
            </button>
          )}
          <button onClick={() => setShowRuns(v => !v)} title="Синкийн түүх"
            className={`rounded-xl border p-2 text-gray-500 hover:bg-gray-50 ${showRuns ? "border-gray-400 bg-gray-50" : "border-gray-200 bg-white"}`}>
            <History size={15} />
          </button>
          <button onClick={download} disabled={!res}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            <Download size={13} />Excel
          </button>
          <button onClick={() => refresh()} disabled={!!st?.running}
            className="flex items-center gap-1.5 rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50">
            {st?.running ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}Одоо шинэчлэх
          </button>
        </div>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-xl border border-sky-100 bg-sky-50/60 px-3 py-2 text-xs text-sky-900">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Одоогоор <b>зөвхөн уншина</b> — erxes-ийн үнэ, plan-д юу ч өөрчлөхгүй. «Санал» багана нь ирээдүйд батлах өөрчлөлтийн урьдчилсан харагдац.
          Хархорин агуулахын POS-ийн үнийг онлайнаар асуух боломжгүй тул «Тохиргоот» нь plan-уудаас тооцсон үнэ, «Бодит» нь сүүлийн борлуулалтын үнэ.
        </span>
      </div>

      {st?.running && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-900">
          <Loader2 size={13} className="animate-spin" />
          Шинэчилж байна{st.step ? ` — ${st.step}` : ""}… (анх удаа ~2 минут, дараа нь хурдан)
        </div>
      )}
      {(err || st?.error) && (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{err || st?.error}</div>
      )}
      {!!res?.unsupported_plans?.length && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          Тооцоонд оруулаагүй төрлийн plan (bundle/segment/vendor): {res.unsupported_plans.join(", ")}
        </div>
      )}

      {showSet && settings && <SettingsPanel s={settings} onSaved={x => { setSettings(x); setShowSet(false); }} />}
      {showRuns && <RunsPanel runs={runs} isAdmin={isAdmin} running={!!st?.running} onFull={() => refresh(true)} />}

      {loading ? (
        <div className="flex items-center gap-2 rounded-apple bg-white p-6 text-sm text-gray-500 shadow-sm"><Loader2 size={15} className="animate-spin" />Ачаалж байна…</div>
      ) : !res ? (
        <div className="rounded-apple bg-white p-6 text-sm text-gray-500 shadow-sm">Синк хараахан хийгдээгүй — «Одоо шинэчлэх» дарна уу.</div>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {tiles.map(t => (
              <button key={t.key} onClick={() => setFilter(f => (f === t.key && t.key !== "all" ? "all" : t.key))}
                className={`rounded-xl border bg-white px-3 py-2 text-left shadow-sm transition hover:border-gray-300 ${filter === t.key ? "border-gray-900 ring-1 ring-gray-900" : "border-gray-100"}`}>
                <div className={`text-xl font-semibold tabular-nums ${t.cls}`}>{t.n ?? 0}</div>
                <div className="text-[11px] leading-tight text-gray-500">{t.label}</div>
              </button>
            ))}
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Код, нэрээр хайх"
                className="w-56 rounded-xl border border-gray-200 bg-white py-1.5 pl-8 pr-3 text-xs outline-none focus:border-gray-400" />
            </div>
            {brands.length > 1 && (
              <select value={brand} onChange={e => setBrand(e.target.value)}
                className="rounded-xl border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
                <option value="">Бүх брэнд</option>
                {brands.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
            <span className="ml-auto text-xs text-gray-400">{rows.length} мөр</span>
          </div>

          <div className="overflow-auto rounded-apple bg-white shadow-sm" style={{ maxHeight: "calc(100vh - 290px)" }}>
            <table className="w-full min-w-[1150px] text-xs">
              <thead className="sticky top-0 z-10 bg-gray-50 text-[10.5px] text-gray-500">
                <tr>
                  <th className="px-2 py-2 text-left">Бараа</th>
                  <th className="px-2 py-2 text-left">Сүүлийн орлого</th>
                  <th className="px-2 py-2 text-right">Орлогын үнэ</th>
                  <th className="px-2 py-2 text-right">erxes үндсэн</th>
                  <th className="px-2 py-2 text-right">Тохиргоот</th>
                  <th className="px-2 py-2 text-right">Тохиргоо − орлого</th>
                  <th className="px-2 py-2 text-right">Бодит (сүүлд)</th>
                  <th className="px-2 py-2 text-right">Бодит − орлого</th>
                  <th className="px-2 py-2 text-center">Орлогоос хойш</th>
                  <th className="px-2 py-2 text-left">Төлөв</th>
                  <th className="px-2 py-2 text-left">Санал</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map(r => {
                  const isOpen = open === r.code;
                  return (
                    <Fragment key={r.code}>
                      <tr onClick={() => setOpen(isOpen ? null : r.code)}
                        className={`cursor-pointer border-t border-gray-100 align-top hover:bg-gray-50/70 ${isOpen ? "bg-gray-50" : ""}`}>
                        <td className="px-2 py-1.5">
                          <div className="flex items-start gap-1">
                            {isOpen ? <ChevronDown size={13} className="mt-0.5 shrink-0 text-gray-400" /> : <ChevronRight size={13} className="mt-0.5 shrink-0 text-gray-300" />}
                            <div>
                              <div><span className="font-mono text-gray-500">{r.code}</span> <span className="text-gray-900">{r.name}</span></div>
                              <div className="text-[10.5px] text-gray-400">
                                {r.brand}{r.uom && <> · <span className={r.non_piece ? "font-semibold text-orange-600" : ""}>{r.uom}</span></>}
                                {!r.in_erxes && <span className="ml-1 text-rose-600">· erxes-д алга</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-gray-600">
                          {r.income_date ? (
                            <>
                              <div>{r.income_date} · {m(r.income_count)} ш</div>
                              <div className="max-w-[220px] truncate text-[10.5px] text-gray-400" title={`${r.income_customer} · ${r.income_bill}`}>
                                {r.income_customer} · {r.income_bill}
                              </div>
                            </>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-gray-900">{m(r.income)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{m(r.base)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          <div className="text-gray-900">{m(r.config)}</div>
                          {r.plans.length > 0 && (
                            <div className={`text-[10.5px] ${r.config_how === "guess" ? "text-orange-600" : "text-gray-400"}`}>
                              {r.plans.length} plan{r.config_how === "guess" ? " · таамаг" : ""}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{signed(r.diff_config, r.diff_config_pct)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          <div className="text-gray-900">{m(r.real)}</div>
                          {r.real_date && <div className="text-[10.5px] text-gray-400">{r.real_date.slice(0, 10)}</div>}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{signed(r.diff_real, r.diff_real_pct)}</td>
                        <td className="px-2 py-1.5 text-center tabular-nums text-gray-600">
                          {r.income_date ? (
                            <>
                              <div>{r.since_count ? `${r.since_count} удаа` : <span className="text-gray-300">0</span>}</div>
                              {r.since_prices.length > 1 && <div className="text-[10.5px] text-orange-600">{r.since_prices.length} өөр үнэ</div>}
                            </>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className={`inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10.5px] ${STATUS[r.status].chip}`}>
                            {STATUS[r.status].dot} {STATUS[r.status].label}
                          </span>
                          {r.others > 0 && (
                            <div className="mt-0.5 whitespace-nowrap text-[10.5px] text-orange-600">🟠 бусдын {r.others} plan</div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {r.action === "create" && <span className="text-indigo-700">Plan үүсгэх → {m(r.income)}</span>}
                          {r.action === "update" && <span className="text-indigo-700">Plan засах → {m(r.income)}</span>}
                          {r.review && <div className="text-[10.5px] font-semibold text-rose-600">±{settings?.guard_pct ?? 30}% — шалгах</div>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-gray-50">
                          <td colSpan={11} className="px-8 pb-3 pt-1">
                            <Detail r={r} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {rows.length > limit && (
              <button onClick={() => setLimit(l => l + 300)} className="w-full border-t border-gray-100 py-2 text-xs text-gray-500 hover:bg-gray-50">
                Цааш харах ({rows.length - limit})
              </button>
            )}
            {!rows.length && <div className="p-6 text-center text-sm text-gray-400">Шүүлтүүрт тохирох бараа алга.</div>}
          </div>
          <p className="mt-2 text-[11px] text-gray-400">
            Хэлтэст хамаарах идэвхтэй plan: {res.dept_plans} · Эрхэт орлого {res.stats?.income?.rows ?? 0} мөр ({res.stats?.income?.from}-ээс шинэчилсэн)
            · POS борлуулалт {res.stats?.pos?.items ?? 0} мөр · {res.stats?.seconds} сек
          </p>
        </>
      )}
    </div>
  );
}

function Detail({ r }: { r: Row }) {
  return (
    <div className="grid gap-3 text-xs md:grid-cols-3">
      <div>
        <div className="mb-1 font-semibold text-gray-700">Орлого</div>
        <div className="text-gray-600">Сүүлийн: {r.income_date || "—"} · {m(r.income)}₮ · {r.income_customer}</div>
        <div className="text-gray-600">Баримт: {r.income_bill || "—"} · {m(r.income_count)} {r.uom || "ш"}</div>
        <div className="text-gray-500">Өмнөх (өөр баримт): {r.prev_income_date ? `${r.prev_income_date} · ${m(r.prev_income)}₮` : "—"}</div>
        {r.non_piece && <div className="mt-1 text-orange-600">Хэмжих нэгж «{r.uom}» — ширхэг биш, үнийг шалгаарай.</div>}
      </div>
      <div>
        <div className="mb-1 font-semibold text-gray-700">Хэлтэст хамаарах plan ({r.plans.length})</div>
        {r.plans.length === 0 && <div className="text-gray-400">Алга — үндсэн үнээр.</div>}
        {r.plans.map(p => (
          <div key={p.id} className="mb-0.5 text-gray-600">
            <span className="text-gray-900">{p.name}</span>{" "}
            <span className="text-gray-500">({TYPE_LABEL[p.type] ?? p.type} {m(p.value)} → {m(p.price)}₮)</span>
            {p.shared && <span className="ml-1 rounded bg-orange-50 px-1 text-[10px] text-orange-700">жижиглэнтэй хуваалцсан</span>}
            {p.conditional && <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600">нөхцөлтэй</span>}
            {!p.priority && <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600">priority биш</span>}
            {p.own && <span className="ml-1 rounded bg-indigo-50 px-1 text-[10px] text-indigo-700">манай</span>}
          </div>
        ))}
        {r.config_how === "guess" && (
          <div className="mt-1 text-orange-600">Олон plan давхцсан — erxes аль нь үйлчлэхийг туршилтаар батлаагүй, «Бодит» үнийг харна уу.</div>
        )}
      </div>
      <div>
        <div className="mb-1 font-semibold text-gray-700">POS «Хархорин агуулах» борлуулалт</div>
        <div className="text-gray-600">Сүүлд: {r.real_date ? `${r.real_date} · ${m(r.real)}₮ · №${r.real_order}` : "—"}</div>
        <div className="text-gray-600">Орлогоос хойш: {r.since_count} удаа, {m(r.since_qty)} ш</div>
        {r.since_prices.length > 0 && <div className="text-gray-500">Зарсан үнүүд: {r.since_prices.map(x => m(x)).join(", ")}</div>}
      </div>
    </div>
  );
}

function SettingsPanel({ s, onSaved }: { s: Settings; onSaved: (s: Settings) => void }) {
  const [brands, setBrands] = useState(s.brands.join("\n"));
  const [excl, setExcl] = useState(s.exclude_customers.join("\n"));
  const [locs, setLocs] = useState<string[]>(s.locations);
  const [guard, setGuard] = useState(s.guard_pct);
  const [max, setMax] = useState(s.max_apply);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const lines = (t: string) => t.split("\n").map(x => x.trim()).filter(Boolean);

  async function save() {
    setBusy(true); setErr("");
    try {
      const r = await api.put("/price-cost/settings", {
        brands: lines(brands), exclude_customers: lines(excl), locations: locs, guard_pct: guard, max_apply: max,
      });
      onSaved(r.data.settings);
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Хадгалж чадсангүй"); } finally { setBusy(false); }
  }

  return (
    <div className="mb-3 rounded-xl border border-gray-200 bg-white p-3 text-xs">
      <div className="grid gap-3 md:grid-cols-4">
        <label className="block">
          <div className="mb-1 font-semibold text-gray-700">Брэнд (мөр бүрт нэг)</div>
          <textarea value={brands} onChange={e => setBrands(e.target.value)} rows={4}
            className="w-full rounded-lg border border-gray-200 p-2 outline-none focus:border-gray-400" />
          <div className="mt-0.5 text-[11px] text-gray-400">Хоосон бол орлоготой бүх бараа.</div>
        </label>
        <label className="block">
          <div className="mb-1 font-semibold text-gray-700">Хасах харилцагч</div>
          <textarea value={excl} onChange={e => setExcl(e.target.value)} rows={4}
            className="w-full rounded-lg border border-gray-200 p-2 outline-none focus:border-gray-400" />
          <div className="mt-0.5 text-[11px] text-gray-400">Эдгээр харилцагчтай орлого үнэд тооцогдохгүй.</div>
        </label>
        <div>
          <div className="mb-1 font-semibold text-gray-700">Эрхэтийн байршил</div>
          {LOCS.map(l => (
            <label key={l.id} className="mb-1 flex items-center gap-2">
              <input type="checkbox" checked={locs.includes(l.id)}
                onChange={e => setLocs(v => e.target.checked ? [...v, l.id] : v.filter(x => x !== l.id))} />
              {l.name}
            </label>
          ))}
          <div className="mt-0.5 text-[11px] text-gray-400">Байршил өөрчилсний дараа «Бүрэн шинэчлэх» хийнэ.</div>
        </div>
        <div className="space-y-2">
          <label className="block">
            <div className="mb-1 font-semibold text-gray-700">Хамгаалалт: өөрчлөлт ±%</div>
            <input type="number" value={guard} min={1} max={100} onChange={e => setGuard(+e.target.value)}
              className="w-24 rounded-lg border border-gray-200 px-2 py-1" />
          </label>
          <label className="block">
            <div className="mb-1 font-semibold text-gray-700">Нэг батлалтын дээд тоо</div>
            <input type="number" value={max} min={1} max={1000} onChange={e => setMax(+e.target.value)}
              className="w-24 rounded-lg border border-gray-200 px-2 py-1" />
          </label>
        </div>
      </div>
      {err && <div className="mt-2 text-rose-600">{err}</div>}
      <div className="mt-2 flex justify-end">
        <button onClick={save} disabled={busy || !locs.length}
          className="flex items-center gap-1.5 rounded-xl bg-gray-900 px-3 py-1.5 font-semibold text-white disabled:opacity-50">
          {busy && <Loader2 size={12} className="animate-spin" />}Хадгалах
        </button>
      </div>
    </div>
  );
}

function RunsPanel({ runs, isAdmin, running, onFull }: { runs: Run[]; isAdmin: boolean; running: boolean; onFull: () => void }) {
  return (
    <div className="mb-3 rounded-xl border border-gray-200 bg-white p-3 text-xs">
      <div className="mb-2 flex items-center">
        <span className="font-semibold text-gray-700">Сүүлийн синкүүд</span>
        {isAdmin && (
          <button onClick={onFull} disabled={running}
            className="ml-auto rounded-lg border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="Эрхэтийн орлогыг оны эхнээс дахин татна (~2 минут)">
            Бүрэн шинэчлэх
          </button>
        )}
      </div>
      {!runs.length && <div className="text-gray-400">Алга.</div>}
      {runs.map(r => (
        <div key={r.id} className="flex flex-wrap gap-x-3 border-t border-gray-50 py-1 text-gray-600">
          <span className="tabular-nums">{ub(r.started_at)}</span>
          <span className={r.status === "ok" ? "text-emerald-600" : r.status === "error" ? "text-rose-600" : "text-indigo-600"}>
            {r.status === "ok" ? "амжилттай" : r.status === "error" ? "алдаа" : "явж байна"}
          </span>
          <span className="text-gray-400">{r.by || "хуваарь"}</span>
          {r.stats?.seconds != null && <span className="text-gray-400">{r.stats.seconds} сек</span>}
          {r.error && <span className="text-rose-600">{r.error}</span>}
        </div>
      ))}
    </div>
  );
}
