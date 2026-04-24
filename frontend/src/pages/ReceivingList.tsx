import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Plus, X, RefreshCw, Archive, ArchiveRestore, PackageCheck,
  ChevronRight, Calendar, User, Hash, Package,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";

type Session = {
  id: number;
  date: string;
  notes: string;
  status: string;
  status_label: string;
  is_archived: boolean;
  created_by_username: string;
  line_count: number;
  total_pcs: number;
  total_amount: number;
  brands: { brand: string; is_matched: boolean }[];
};

const STATUS_TABS = [
  { key: "", label: "Бүгд" },
  { key: "matching", label: "Тулгаж байна" },
  { key: "price_review", label: "Үнэ хянагдаж байна" },
  { key: "received", label: "Орлого авсан" },
];

const STATUS_CHIP: Record<string, string> = {
  matching: "bg-amber-50 text-amber-700 ring-amber-200/60",
  price_review: "bg-indigo-50 text-indigo-700 ring-indigo-200/60",
  received: "bg-emerald-50 text-emerald-700 ring-emerald-200/60",
};

const STATUS_DOT: Record<string, string> = {
  matching: "bg-amber-500",
  price_review: "bg-indigo-500",
  received: "bg-emerald-500",
};

function StatusChip({ status, label }: { status: string; label: string }) {
  const cls = STATUS_CHIP[status] ?? "bg-gray-50 text-gray-600 ring-gray-200/60";
  const dot = STATUS_DOT[status] ?? "bg-gray-400";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function BrandChips({ brands, max = 3 }: { brands: Session["brands"]; max?: number }) {
  if (brands.length === 0) return <span className="text-gray-300">—</span>;
  const shown = brands.slice(0, max);
  const extra = brands.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map(b => (
        <span
          key={b.brand}
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
            b.is_matched
              ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/60"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          {b.is_matched && <span className="h-1 w-1 rounded-full bg-emerald-500" />}
          {b.brand}
        </span>
      ))}
      {extra > 0 && (
        <span className="text-[10px] font-medium text-gray-400">+{extra}</span>
      )}
    </div>
  );
}

export default function ReceivingList() {
  const { role } = useAuthStore();
  const navigate = useNavigate();
  const [tab, setTab] = useState("");
  const [rows, setRows] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [archiveMode, setArchiveMode] = useState<"false" | "only">("false");
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    notes: "",
  });
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const params: any = { archived: archiveMode };
      if (tab) params.status = tab;
      const r = await api.get("/receivings", { params });
      setRows(r.data);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [tab, archiveMode]);

  const create = async () => {
    setCreating(true);
    try {
      const r = await api.post("/receivings", createForm);
      flash("Үүслээ");
      setShowCreate(false);
      setCreateForm({ date: new Date().toISOString().slice(0, 10), notes: "" });
      navigate(`/receivings/${r.data.id}`);
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа", false);
    } finally {
      setCreating(false);
    }
  };

  const toggleArchive = async (id: number, archive: boolean) => {
    if (!confirm(archive ? "Архивлах уу?" : "Архиваас буцаах уу?")) return;
    try {
      await api.patch(`/receivings/${id}/archive`, null, { params: { archived: archive } });
      await load();
    } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); }
  };

  const canArchive = ["admin", "manager", "supervisor"].includes(role ?? "");

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="pb-24 sm:pb-0">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">
            Бараа тулгаж авах
          </h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">
            Захиалгагүйгээр ирсэн бараанд баримт тулгаж орлого авах
          </p>
        </div>
        {/* Desktop action button */}
        <button
          onClick={() => setShowCreate(true)}
          className="hidden sm:inline-flex items-center gap-1.5 rounded-apple bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#005BB5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3]/30"
        >
          <Plus size={15}/>
          Шинэ тулгалт
        </button>
      </div>

      {/* Flash */}
      {msg && (
        <div className={`mb-3 rounded-apple px-4 py-2 text-sm ring-1 ring-inset ${
          msg.ok ? "bg-emerald-50 text-emerald-700 ring-emerald-200/60"
                 : "bg-red-50 text-red-700 ring-red-200/60"
        }`}>
          {msg.text}
        </div>
      )}

      {/* Tabs + controls */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Status segmented / pills — horizontal scroll on mobile */}
        <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0 sm:flex-1">
          <div className="inline-flex min-w-full gap-1 rounded-apple bg-white p-1 shadow-sm ring-1 ring-gray-100 sm:min-w-0">
            {STATUS_TABS.map(t => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`shrink-0 rounded-[12px] px-3 py-1.5 text-xs font-medium transition-all sm:text-[13px] ${
                    active
                      ? "bg-[#0071E3] text-white shadow-sm"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {canArchive && (
            <button
              onClick={() => setArchiveMode(m => m === "only" ? "false" : "only")}
              className={`inline-flex items-center gap-1.5 rounded-apple px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors ${
                archiveMode === "only"
                  ? "bg-amber-50 text-amber-700 ring-amber-200/60"
                  : "bg-white text-gray-600 ring-gray-100 hover:bg-gray-50"
              }`}
            >
              {archiveMode === "only" ? <ArchiveRestore size={13}/> : <Archive size={13}/>}
              {archiveMode === "only" ? "Үндсэн" : "Архив"}
            </button>
          )}
          <button
            onClick={load}
            className="inline-flex items-center justify-center rounded-apple bg-white p-2 text-gray-500 ring-1 ring-inset ring-gray-100 hover:bg-gray-50"
            title="Шинэчлэх"
            aria-label="Шинэчлэх"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""}/>
          </button>
        </div>
      </div>

      {/* Empty state */}
      {rows.length === 0 && !loading ? (
        <div className="flex flex-col items-center gap-2 rounded-apple bg-white py-16 text-gray-400 shadow-sm ring-1 ring-gray-100">
          <PackageCheck size={36} className="text-gray-200"/>
          <span className="text-sm">Тулгалт байхгүй</span>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-apple bg-[#0071E3] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#005BB5]"
          >
            <Plus size={13}/> Шинэ үүсгэх
          </button>
        </div>
      ) : (
        <>
          {/* Mobile card grid (< md) */}
          <div className="grid grid-cols-1 gap-2.5 md:hidden">
            {rows.map(r => (
              <button
                key={r.id}
                onClick={() => navigate(`/receivings/${r.id}`)}
                className="group rounded-apple bg-white p-3.5 text-left shadow-sm ring-1 ring-gray-100 transition-all active:scale-[0.995] active:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[15px] font-semibold text-gray-900 tabular-nums">
                      <Calendar size={13} className="text-gray-400"/>
                      {r.date.replaceAll("-", "/")}
                      <span className="text-xs font-normal text-gray-400">#{r.id}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
                      <span className="inline-flex items-center gap-1"><User size={11}/>{r.created_by_username}</span>
                    </div>
                  </div>
                  <StatusChip status={r.status} label={r.status_label}/>
                </div>

                <div className="mt-2">
                  <BrandChips brands={r.brands} max={4}/>
                </div>

                <div className="mt-2.5 grid grid-cols-3 gap-2 rounded-lg bg-gray-50/60 p-2">
                  <div className="text-center">
                    <div className="text-[9px] font-medium uppercase tracking-wide text-gray-400">Мөр</div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-gray-800">{r.line_count}</div>
                  </div>
                  <div className="text-center border-x border-gray-200/70">
                    <div className="text-[9px] font-medium uppercase tracking-wide text-gray-400">Ширхэг</div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-gray-800">{r.total_pcs.toFixed(0)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[9px] font-medium uppercase tracking-wide text-gray-400">Дүн</div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-gray-900">
                      {r.total_amount.toLocaleString("mn-MN")}
                    </div>
                  </div>
                </div>

                {r.notes && (
                  <p className="mt-2 line-clamp-2 text-[11px] italic text-gray-400">{r.notes}</p>
                )}

                {canArchive && (
                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleArchive(r.id, !r.is_archived); }}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-amber-50 hover:text-amber-600"
                    >
                      {r.is_archived ? <><ArchiveRestore size={12}/> Буцаах</> : <><Archive size={12}/> Архив</>}
                    </button>
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* Desktop table (md+) */}
          <div className="hidden md:block rounded-apple bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 border-b border-gray-100 bg-gray-50/80 backdrop-blur text-left text-[11px] uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-3 font-medium">Огноо</th>
                    <th className="px-5 py-3 font-medium">Статус</th>
                    <th className="px-5 py-3 font-medium">Бренд</th>
                    <th className="px-5 py-3 font-medium text-right">Мөр</th>
                    <th className="px-5 py-3 font-medium text-right">Нийт ш</th>
                    <th className="px-5 py-3 font-medium text-right">Нийт дүн</th>
                    <th className="px-5 py-3 font-medium">Үүсгэсэн</th>
                    <th className="px-5 py-3 font-medium">Тэмдэглэл</th>
                    <th className="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map(r => (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`/receivings/${r.id}`)}
                      className="group cursor-pointer transition-colors hover:bg-blue-50/30"
                    >
                      <td className="px-5 py-3 font-semibold text-gray-900 tabular-nums">
                        <div className="flex items-center gap-2">
                          <span>{r.date.replaceAll("-", "/")}</span>
                          <span className="text-xs font-normal text-gray-400">#{r.id}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <StatusChip status={r.status} label={r.status_label}/>
                      </td>
                      <td className="px-5 py-3 max-w-[240px]">
                        <BrandChips brands={r.brands} max={3}/>
                      </td>
                      <td className="px-5 py-3 text-right text-gray-700 tabular-nums">{r.line_count}</td>
                      <td className="px-5 py-3 text-right text-gray-700 tabular-nums">{r.total_pcs.toFixed(0)}</td>
                      <td className="px-5 py-3 text-right font-semibold text-gray-900 tabular-nums">
                        {r.total_amount.toLocaleString("mn-MN")}
                      </td>
                      <td className="px-5 py-3 text-xs text-gray-500">{r.created_by_username}</td>
                      <td className="px-5 py-3 max-w-[200px] truncate text-xs text-gray-400" title={r.notes}>
                        {r.notes || <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {canArchive && (
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleArchive(r.id, !r.is_archived); }}
                              className="rounded-md p-1.5 text-gray-300 opacity-0 transition hover:bg-amber-50 hover:text-amber-600 group-hover:opacity-100"
                              title={r.is_archived ? "Архиваас буцаах" : "Архивлах"}
                            >
                              {r.is_archived ? <ArchiveRestore size={14}/> : <Archive size={14}/>}
                            </button>
                          )}
                          <ChevronRight size={16} className="text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-gray-500"/>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Mobile FAB */}
      <button
        onClick={() => setShowCreate(true)}
        className="fixed bottom-5 right-5 z-40 inline-flex h-14 w-14 items-center justify-center rounded-full bg-[#0071E3] text-white shadow-lg shadow-blue-500/30 transition-transform active:scale-95 sm:hidden"
        aria-label="Шинэ тулгалт"
      >
        <Plus size={24} strokeWidth={2.4}/>
      </button>

      {/* Create modal */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
          onClick={() => setShowCreate(false)}
        >
          <div
            className="w-full max-w-md rounded-t-3xl bg-white p-5 pb-[max(20px,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-apple sm:p-6 sm:pb-6"
            onClick={e => e.stopPropagation()}
          >
            {/* grabber */}
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-200 sm:hidden"/>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#0071E3]/10 text-[#0071E3]">
                  <Package size={18}/>
                </div>
                <h2 className="text-base font-semibold text-gray-900 sm:text-lg">Шинэ тулгалт</h2>
              </div>
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Хаах"
              >
                <X size={18}/>
              </button>
            </div>

            <div className="mt-4 space-y-3.5">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Огноо</label>
                <div className="relative">
                  <Calendar size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/>
                  <input
                    type="date"
                    value={createForm.date}
                    onChange={e => setCreateForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-[15px] outline-none transition focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20 sm:text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Тэмдэглэл</label>
                <textarea
                  value={createForm.notes}
                  onChange={e => setCreateForm(f => ({ ...f, notes: e.target.value }))}
                  rows={3}
                  placeholder="Нэмэлт мэдээлэл..."
                  className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2.5 text-[15px] outline-none transition focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20 sm:text-sm"
                />
              </div>
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="flex-1 rounded-apple border border-gray-200 bg-white py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Болих
              </button>
              <button
                onClick={create}
                disabled={creating}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-apple bg-[#0071E3] py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#005BB5] disabled:opacity-50"
              >
                {creating ? <RefreshCw size={14} className="animate-spin"/> : <Plus size={14}/>}
                Үүсгэх
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
