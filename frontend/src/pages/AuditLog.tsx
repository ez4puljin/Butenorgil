/**
 * Audit Log хуудас — Destructive endpoint-уудаас бүртгэгдсэн өөрчлөлтийг
 * харах, шүүх, before/after-ыг харьцуулах admin интерфейс.
 *
 * Гол хэрэглээ:
 *   - "PO #46 дээр хэн юу хийсэн бэ?" → parent_type=purchase_order, parent_id=46
 *   - "Хамгийн сүүлийн set-lines дуудалт хэн хийсэн?" → action=po_set_lines
 *   - "192.168.1.32 хэн юу хийсэн?" → ip_address-аар шүүх
 */
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  RefreshCw, Filter, ChevronDown, ChevronRight, User, Clock,
  Hash, Globe, Activity, X,
} from "lucide-react";
import { api } from "../lib/api";

type AuditRow = {
  id: number;
  created_at: string | null;
  user_id: number;
  username: string;
  role: string;
  ip_address: string;
  action: string;
  entity_type: string;
  entity_id: number;
  parent_type: string;
  parent_id: number;
  before: any;
  after: any;
  extra: any;
};

const ACTION_LABEL: Record<string, string> = {
  // Purchase order
  po_set_lines: "PO мөр шинэчлэх",
  po_delete: "PO устгах",
  po_delete_line: "PO мөр устгах",
  po_archive: "PO архивлах",
  po_unarchive: "PO архиваас буцаах",
  po_force_status_brand: "Брэндийн статус албадан",
  po_force_status_all: "Бүх статус албадан",
  po_brand_advance: "Брэндийн статус ахиулах",
  // Receiving
  receiving_set_status: "Тулгалт статус солих",
  receiving_archive: "Тулгалт архивлах",
  receiving_unarchive: "Тулгалт архиваас буцаах",
  receiving_delete: "Тулгалт session устгах",
  receiving_delete_line: "Тулгалт мөр устгах",
  receiving_unmatch_brand: "Брэнд тулгалт буцаах",
};

const PARENT_LABEL: Record<string, string> = {
  purchase_order: "Захиалга",
  receiving_session: "Тулгалт",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    // UTC → Ulaanbaatar timezone (+08)
    return d.toLocaleString("mn-MN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtValue(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

/** Before/after-ийн өөрчлөгдсөн талбаруудыг ялгаж diff highlight үзүүлнэ. */
function diffKeys(before: any, after: any): { key: string; b: any; a: any }[] {
  if (!before && !after) return [];
  const allKeys = new Set<string>([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  const out: { key: string; b: any; a: any }[] = [];
  for (const k of Array.from(allKeys).sort()) {
    const b = before?.[k];
    const a = after?.[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      out.push({ key: k, b, a });
    }
  }
  return out;
}

export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [actions, setActions] = useState<string[]>([]);

  // Filters
  const [filterAction, setFilterAction] = useState("");
  const [filterParentType, setFilterParentType] = useState("");
  const [filterParentId, setFilterParentId] = useState("");
  const [filterUsername, setFilterUsername] = useState("");
  const [filterIp, setFilterIp] = useState("");
  const [filterSinceHours, setFilterSinceHours] = useState<string>("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const params: Record<string, string | number> = { limit: 200 };
      if (filterAction) params.action = filterAction;
      if (filterParentType) params.parent_type = filterParentType;
      if (filterParentId) params.parent_id = Number(filterParentId);
      if (filterUsername) params.username = filterUsername;
      if (filterIp) params.ip_address = filterIp;
      if (filterSinceHours) params.since_hours = Number(filterSinceHours);
      const r = await api.get("/admin/audit-log", { params });
      setRows(r.data.items || []);
      setTotal(r.data.total || 0);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Алдаа гарлаа");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.get("/admin/audit-log/distinct-actions")
      .then(r => setActions(r.data || []))
      .catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetFilters = () => {
    setFilterAction("");
    setFilterParentType("");
    setFilterParentId("");
    setFilterUsername("");
    setFilterIp("");
    setFilterSinceHours("");
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="pb-12"
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-gray-900">
            Audit Log — Үйлдлийн бүртгэл
          </h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Захиалга, тулгалтын өгөгдөл устсан, өөрчлөгдсөн тохиолдолд хэн, хэзээ, юунаас юу болгосон бэ — бүгдийг нь энд харна.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""}/>
          Шинэчлэх
        </button>
      </div>

      {/* Filters */}
      <div className="mb-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-gray-100">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          <Filter size={12}/> Шүүлтүүр
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className="mb-0.5 block text-[10px] font-medium text-gray-500">Үйлдэл</label>
            <select
              value={filterAction}
              onChange={e => setFilterAction(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px]"
            >
              <option value="">Бүгд</option>
              {actions.map(a => (
                <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] font-medium text-gray-500">Объектын төрөл</label>
            <select
              value={filterParentType}
              onChange={e => setFilterParentType(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px]"
            >
              <option value="">Бүгд</option>
              <option value="purchase_order">Захиалга</option>
              <option value="receiving_session">Тулгалт</option>
            </select>
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] font-medium text-gray-500">Объектын ID</label>
            <input
              value={filterParentId}
              onChange={e => setFilterParentId(e.target.value.replace(/\D/g, ""))}
              placeholder="ж: 46"
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px]"
            />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] font-medium text-gray-500">Хэрэглэгчийн нэр</label>
            <input
              value={filterUsername}
              onChange={e => setFilterUsername(e.target.value)}
              placeholder="нэрнээс шүүх"
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px]"
            />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] font-medium text-gray-500">IP хаяг</label>
            <input
              value={filterIp}
              onChange={e => setFilterIp(e.target.value)}
              placeholder="192.168.1.32"
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px]"
            />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] font-medium text-gray-500">Хэдэн цагт</label>
            <select
              value={filterSinceHours}
              onChange={e => setFilterSinceHours(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[12px]"
            >
              <option value="">Бүх хугацаа</option>
              <option value="1">Сүүлийн 1 цаг</option>
              <option value="6">Сүүлийн 6 цаг</option>
              <option value="24">Сүүлийн 24 цаг</option>
              <option value="72">Сүүлийн 3 хоног</option>
              <option value="168">Сүүлийн 7 хоног</option>
            </select>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={load}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            Шүүх
          </button>
          <button
            onClick={() => { resetFilters(); setTimeout(load, 50); }}
            className="rounded-lg bg-gray-100 px-3 py-1.5 text-[12px] font-medium text-gray-700 hover:bg-gray-200"
          >
            Цэвэрлэх
          </button>
          <span className="ml-auto text-[11px] text-gray-500">
            Нийт {total.toLocaleString("mn-MN")} бүртгэл олдсон ({rows.length}-г харуулсан)
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-xl bg-red-50 p-2.5 text-[12px] text-red-700 ring-1 ring-red-200">
          {error}
        </div>
      )}

      {/* List */}
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100">
        {rows.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-gray-400">
            {loading ? "Ачаалж байна…" : "Бүртгэл олдсонгүй"}
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              <tr>
                <th className="w-8 px-2 py-2"></th>
                <th className="px-2 py-2 text-left">Хэзээ</th>
                <th className="px-2 py-2 text-left">Хэрэглэгч</th>
                <th className="px-2 py-2 text-left">IP</th>
                <th className="px-2 py-2 text-left">Үйлдэл</th>
                <th className="px-2 py-2 text-left">Объект</th>
                <th className="px-2 py-2 text-left">Тойм</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-[12px]">
              {rows.map(r => {
                const isOpen = !!expanded[r.id];
                const diffs = diffKeys(r.before, r.after);
                return (
                  <>
                    <tr
                      key={r.id}
                      className="cursor-pointer transition-colors hover:bg-indigo-50/40"
                      onClick={() => setExpanded(s => ({ ...s, [r.id]: !s[r.id] }))}
                    >
                      <td className="px-2 py-2 text-gray-400">
                        {isOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
                      </td>
                      <td className="px-2 py-2 tabular-nums text-gray-700">
                        {fmtTime(r.created_at)}
                      </td>
                      <td className="px-2 py-2">
                        <div className="font-medium text-gray-900">{r.username || "—"}</div>
                        {r.role && <div className="text-[10px] text-gray-400">{r.role}</div>}
                      </td>
                      <td className="px-2 py-2 font-mono text-[11px] text-gray-500">{r.ip_address || "—"}</td>
                      <td className="px-2 py-2">
                        <span className="inline-block rounded-md bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">
                          {ACTION_LABEL[r.action] ?? r.action}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-gray-700">
                        {PARENT_LABEL[r.parent_type] ?? r.parent_type}
                        {r.parent_id ? <span className="ml-1 text-gray-400">#{r.parent_id}</span> : null}
                      </td>
                      <td className="px-2 py-2 text-gray-500">
                        {diffs.length > 0
                          ? <span className="tabular-nums">{diffs.length} талбар өөрчлөгдсөн</span>
                          : r.after === null && r.before
                            ? <span className="text-red-600">УСТГАГДСАН</span>
                            : "—"}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${r.id}-detail`} className="bg-gray-50/50">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="grid grid-cols-1 gap-3 text-[12px] md:grid-cols-2">
                            {/* Meta */}
                            <div className="rounded-xl bg-white p-3 ring-1 ring-gray-100">
                              <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                                <Activity size={11}/> Мэдээлэл
                              </div>
                              <div className="space-y-1 text-[11px]">
                                <div className="flex items-center gap-1.5"><Clock size={11} className="text-gray-400"/> <span className="text-gray-500">UTC:</span> <span className="font-mono">{r.created_at}</span></div>
                                <div className="flex items-center gap-1.5"><User size={11} className="text-gray-400"/> <span className="text-gray-500">User:</span> {r.username} (id={r.user_id}, role={r.role || "—"})</div>
                                <div className="flex items-center gap-1.5"><Globe size={11} className="text-gray-400"/> <span className="text-gray-500">IP:</span> <span className="font-mono">{r.ip_address || "—"}</span></div>
                                <div className="flex items-center gap-1.5"><Hash size={11} className="text-gray-400"/> <span className="text-gray-500">Entity:</span> {r.entity_type} #{r.entity_id}</div>
                                {r.extra && (
                                  <div className="mt-1 rounded-md bg-gray-50 p-1.5 font-mono text-[10px]">
                                    <pre className="whitespace-pre-wrap break-words">{fmtValue(r.extra)}</pre>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Diff */}
                            <div className="rounded-xl bg-white p-3 ring-1 ring-gray-100">
                              <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                                Өөрчлөлт ({diffs.length})
                              </div>
                              {diffs.length === 0 ? (
                                r.after === null && r.before ? (
                                  <div>
                                    <div className="mb-1 text-[10px] font-semibold uppercase text-red-600">Устгасан утга</div>
                                    <pre className="rounded-md bg-red-50 p-2 font-mono text-[10px] text-red-900 whitespace-pre-wrap break-words">
{fmtValue(r.before)}
                                    </pre>
                                  </div>
                                ) : (
                                  <div className="text-[11px] text-gray-400">Утга өөрчлөгдөөгүй</div>
                                )
                              ) : (
                                <table className="w-full text-[11px]">
                                  <thead>
                                    <tr className="text-[10px] font-semibold uppercase text-gray-500">
                                      <th className="text-left py-0.5">Талбар</th>
                                      <th className="text-left py-0.5">Өмнө</th>
                                      <th className="text-left py-0.5">Дараа</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-100">
                                    {diffs.map(d => (
                                      <tr key={d.key}>
                                        <td className="py-1 pr-2 font-mono text-gray-600">{d.key}</td>
                                        <td className="py-1 pr-2 font-mono text-red-700 line-through tabular-nums">{fmtValue(d.b)}</td>
                                        <td className="py-1 font-mono text-emerald-700 tabular-nums">{fmtValue(d.a)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </motion.div>
  );
}
