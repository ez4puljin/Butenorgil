import { useCallback, useEffect, useState } from "react";
import { History, X, Search, Download, ChevronLeft, ChevronRight, RefreshCw, RotateCcw } from "lucide-react";
import { api } from "../lib/api";

/* ═══════════════════════════════════════════════════════════════════════════
   Захиалгын түүх (Log) — нэг захиалгын аудит бичлэгүүд. Бренд, бараа, хэрэглэгч,
   огнооны муж, өөрчлөлтийн төрлөөр (тоог 0 болгосон, шинээр оруулсан, нэмсэн,
   хассан, үнэ, статус, машин…) болон чөлөөт текстээр шүүнэ. Excel татна.
   ═══════════════════════════════════════════════════════════════════════════ */

type Change = { field: string; label: string; before: string | number | null; after: string | number | null };
type Ev = {
  id: number; at: string | null; username: string; role: string; ip: string; action: string; action_label: string;
  kinds: string[]; brand: string; product: string; item_code: string; status: string; changes: Change[]; qty_delta: number;
};
type Facet = { name: string; count: number };
type Resp = {
  total_all: number; total: number; page: number; size: number; items: Ev[];
  facets: { users: Facet[]; brands: Facet[]; kinds: { key: string; label: string; count: number }[] };
  sums: { added_boxes: number; removed_boxes: number };
};
type Filters = { q: string; brand: string; product: string; user: string; kinds: string[]; date_from: string; date_to: string };

const EMPTY: Filters = { q: "", brand: "", product: "", user: "", kinds: [], date_from: "", date_to: "" };
const SIZE = 100;

const KIND_STYLE: Record<string, string> = {
  zeroed: "bg-rose-50 text-rose-700 ring-rose-200",
  brand_zeroed: "bg-rose-100 text-rose-800 ring-rose-300",
  line_deleted: "bg-rose-50 text-rose-700 ring-rose-200",
  decreased: "bg-orange-50 text-orange-700 ring-orange-200",
  added: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  increased: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  price: "bg-violet-50 text-violet-700 ring-violet-200",
  status: "bg-sky-50 text-sky-700 ring-sky-200",
  vehicle: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  conflict: "bg-amber-50 text-amber-800 ring-amber-200",
};
const kindStyle = (k: string) => KIND_STYLE[k] ?? "bg-gray-100 text-gray-600 ring-gray-200";

const fmtAt = (s: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const fmtVal = (v: string | number | null) =>
  v == null || v === "" ? "—" : typeof v === "number" ? (Number.isInteger(v) ? v : +v.toFixed(2)).toLocaleString("mn-MN") : v;

export default function OrderHistoryModal({ orderId, orderLabel, initialBrand, onClose }: {
  orderId: number | string; orderLabel?: string; initialBrand?: string; onClose: () => void;
}) {
  const [f, setF] = useState<Filters>({ ...EMPTY, brand: initialBrand ?? "" });
  const [dq, setDq] = useState({ q: "", product: "" });   // бичих үеийн debounce
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setDq({ q: f.q.trim(), product: f.product.trim() }), 350); return () => clearTimeout(t); }, [f.q, f.product]);
  useEffect(() => { setPage(1); }, [dq, f.brand, f.user, f.kinds, f.date_from, f.date_to]);

  const params = useCallback(() => ({
    q: dq.q, product: dq.product, brand: f.brand, user: f.user, kinds: f.kinds.join(","), date_from: f.date_from, date_to: f.date_to,
  }), [dq, f.brand, f.user, f.kinds, f.date_from, f.date_to]);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await api.get(`/purchase-orders/${orderId}/history`, { params: { ...params(), page, size: SIZE } });
      setData(r.data);
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Түүх ачаалахад алдаа"); }
    finally { setLoading(false); }
  }, [orderId, params, page]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const exportXlsx = async () => {
    try {
      const r = await api.get(`/purchase-orders/${orderId}/history/export`, { params: params(), responseType: "blob" });
      const cd = r.headers["content-disposition"] || ""; const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      const a = document.createElement("a"); a.href = URL.createObjectURL(r.data); a.download = m ? decodeURIComponent(m[1]) : `order_${orderId}_history.xlsx`; a.click(); URL.revokeObjectURL(a.href);
    } catch { setErr("Excel татахад алдаа"); }
  };

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleKind = (k: string) => setF((x) => ({ ...x, kinds: x.kinds.includes(k) ? x.kinds.filter((y) => y !== k) : [...x.kinds, k] }));
  const active = f.q || f.brand || f.product || f.user || f.kinds.length || f.date_from || f.date_to;
  const pages = data ? Math.max(1, Math.ceil(data.total / SIZE)) : 1;
  const inputCls = "rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[#0071E3]";

  return (
    <div className="fixed inset-0 z-[80] flex items-stretch justify-center bg-black/30 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden bg-white shadow-xl sm:h-[90vh] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-slate-600"><History size={16} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold text-gray-900">Захиалгын түүх {orderLabel ? `— ${orderLabel}` : `#${orderId}`}</div>
            <div className="text-[11px] text-gray-500">
              {data ? <>{data.total.toLocaleString("mn-MN")} / {data.total_all.toLocaleString("mn-MN")} бичлэг
                {(data.sums.added_boxes > 0 || data.sums.removed_boxes > 0) && <> · <span className="text-emerald-600">+{data.sums.added_boxes.toLocaleString("mn-MN")}</span> / <span className="text-rose-600">−{data.sums.removed_boxes.toLocaleString("mn-MN")}</span> хайрцаг</>}
              </> : "…"}
            </div>
          </div>
          <button onClick={load} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100" title="Шинэчлэх"><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button>
          <button onClick={exportXlsx} className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-[12px] font-semibold text-white"><Download size={13} />Excel</button>
          <button onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"><X size={17} /></button>
        </div>

        {/* Filters */}
        <div className="space-y-2 border-b border-gray-100 bg-gray-50/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="Хайх: бараа, бренд, хэрэглэгч, утга…" className={`${inputCls} w-full pl-8`} />
            </div>
            <input value={f.product} onChange={(e) => set("product", e.target.value)} placeholder="Барааны код/нэр" className={`${inputCls} w-40`} />
            <select value={f.brand} onChange={(e) => set("brand", e.target.value)} className={`${inputCls} max-w-[220px]`}>
              <option value="">Бүх бренд</option>
              {(data?.facets.brands ?? []).map((b) => <option key={b.name} value={b.name}>{b.name} ({b.count})</option>)}
              {f.brand && !(data?.facets.brands ?? []).some((b) => b.name === f.brand) && <option value={f.brand}>{f.brand}</option>}
            </select>
            <select value={f.user} onChange={(e) => set("user", e.target.value)} className={`${inputCls} max-w-[180px]`}>
              <option value="">Бүх хэрэглэгч</option>
              {(data?.facets.users ?? []).map((u) => <option key={u.name} value={u.name}>{u.name} ({u.count})</option>)}
            </select>
            <label className="flex items-center gap-1 text-[11.5px] text-gray-500">
              <input type="date" value={f.date_from} onChange={(e) => set("date_from", e.target.value)} className={inputCls} />
              –
              <input type="date" value={f.date_to} onChange={(e) => set("date_to", e.target.value)} className={inputCls} />
            </label>
            {active ? (
              <button onClick={() => setF(EMPTY)} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50"><RotateCcw size={12} />Цэвэрлэх</button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(data?.facets.kinds ?? []).map((k) => {
              const on = f.kinds.includes(k.key);
              return (
                <button key={k.key} onClick={() => toggleKind(k.key)}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ${on ? "bg-gray-900 text-white ring-gray-900" : kindStyle(k.key)}`}>
                  {k.label}<span className={`rounded-full px-1.5 text-[10px] font-bold ${on ? "bg-white/25" : "bg-white/70"}`}>{k.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto">
          {err && <div className="m-3 rounded-xl bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{err}</div>}
          {!data && loading && <div className="p-10 text-center text-sm text-gray-400">Ачаалж байна…</div>}
          {data && data.items.length === 0 && <div className="p-10 text-center text-sm text-gray-400">{data.total_all ? "Шүүлтэд тохирох бичлэг алга" : "Энэ захиалгад түүх бүртгэгдээгүй байна"}</div>}
          {data && data.items.length > 0 && (
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-white text-[10.5px] uppercase tracking-wider text-gray-400 shadow-[0_1px_0_#f1f1f1]">
                <tr>
                  <th className="px-3 py-2 text-left">Огноо</th>
                  <th className="px-3 py-2 text-left">Хэрэглэгч</th>
                  <th className="px-3 py-2 text-left">Үйлдэл</th>
                  <th className="px-3 py-2 text-left">Бренд / Бараа</th>
                  <th className="px-3 py-2 text-left">Өөрчлөлт</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id} className="border-t border-gray-50 align-top hover:bg-gray-50/60">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-gray-500">{fmtAt(e.at)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <button onClick={() => set("user", e.username)} className="font-medium text-gray-800 hover:text-[#0071E3] hover:underline">{e.username || "—"}</button>
                      {e.ip && <div className="text-[10px] text-gray-400">{e.ip}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-[12px] text-gray-700">{e.action_label}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {e.kinds.filter((k) => k !== "other").map((k) => (
                          <span key={k} className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${kindStyle(k)}`}>
                            {data.facets.kinds.find((x) => x.key === k)?.label ?? k}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="max-w-[320px] px-3 py-2">
                      {e.brand && <button onClick={() => set("brand", e.brand)} className="block truncate text-left text-[11.5px] font-semibold text-indigo-700 hover:underline" title={e.brand}>{e.brand}</button>}
                      {e.product && (
                        <button onClick={() => set("product", e.item_code || e.product)} className="block w-full truncate text-left text-gray-800 hover:text-[#0071E3]" title={e.product}>
                          {e.item_code && <span className="mr-1 font-mono text-[11px] text-gray-400">{e.item_code}</span>}{e.product}
                        </button>
                      )}
                      {e.status && <div className="text-[10.5px] text-gray-400">{e.status}</div>}
                    </td>
                    <td className="px-3 py-2">
                      {e.changes.map((c, i) => (
                        <div key={i} className="whitespace-nowrap text-[12px]">
                          <span className="text-gray-400">{c.label}{c.before != null || c.after != null ? ":" : ""}</span>{" "}
                          {(c.before != null || c.after != null) && (
                            <>
                              <span className="tabular-nums text-gray-500 line-through decoration-gray-300">{fmtVal(c.before)}</span>
                              <span className="mx-1 text-gray-300">→</span>
                              <span className={`font-semibold tabular-nums ${c.field === "order_qty_box" || c.field === "brand_total" ? (Number(c.after ?? 0) < Number(c.before ?? 0) ? "text-rose-600" : "text-emerald-700") : "text-gray-900"}`}>{fmtVal(c.after)}</span>
                            </>
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {data && data.total > SIZE && (
          <div className="flex items-center gap-2 border-t border-gray-100 px-4 py-2 text-[12px] text-gray-500">
            <span>{((page - 1) * SIZE + 1).toLocaleString("mn-MN")}–{Math.min(page * SIZE, data.total).toLocaleString("mn-MN")} / {data.total.toLocaleString("mn-MN")}</span>
            <div className="ml-auto flex items-center gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-lg p-1 hover:bg-gray-100 disabled:opacity-30"><ChevronLeft size={16} /></button>
              <span>{page} / {pages}</span>
              <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="rounded-lg p-1 hover:bg-gray-100 disabled:opacity-30"><ChevronRight size={16} /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
