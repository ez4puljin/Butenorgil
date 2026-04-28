import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "../components/ui/Card";
import {
  UploadCloud,
  FileText,
  FileSpreadsheet,
  Download,
  Plus,
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Warehouse,
  RefreshCw,
  ChevronDown,
  X,
  FolderOpen,
  Pencil,
  Trash2,
  CheckSquare,
  Square,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";

// ─── Types ────────────────────────────────────────────────────
type WarehouseDef = { key: string; label: string; color: string; bg: string };
type CountFile = { id: number; file_type: string; original_filename: string; uploaded_at: string | null };
type CountRecord = {
  id: number; warehouse_key: string; warehouse_label: string;
  count_date: string; description: string; created_at: string | null;
  created_by: string; file_count: number; files: CountFile[];
  kpi_admin_task_id: number | null;
  kpi_points: number | null;
  kpi_target_employee_ids: number[];
  kpi_task_active: boolean | null;
  // Checklist
  check_all_synced: boolean;
  check_no_partial: boolean;
  check_no_wh14_sales: boolean;
  check_balance_unchanged: boolean;
};

type ChecklistKey = "check_all_synced" | "check_no_partial" | "check_no_wh14_sales" | "check_balance_unchanged";

const CHECKLIST_ITEMS: { key: ChecklistKey; label: string }[] = [
  { key: "check_all_synced",        label: "Бүх гүйлгээ татагдсан буюу Sync хийгдсэн" },
  { key: "check_no_partial",        label: "Бүрэн бус баримт байхгүй" },
  { key: "check_no_wh14_sales",     label: "№14 агуулахаас борлуулалт гараагүй" },
  { key: "check_balance_unchanged", label: "Өмнөх тооллогоны үлдэгдэл дээр өөрчлөлт ороогүй" },
];
type UserOption = {
  id: number;
  username: string;
  nickname: string;
  role: string;
  is_active?: boolean;
};
type CalendarEntry = {
  id: number; warehouse_key: string; warehouse_label: string;
  color: string; bg: string; description: string; file_count: number;
};

// ─── Helpers ──────────────────────────────────────────────────
function fmtDate(iso: string | null) {
  if (!iso) return "-";
  const d = new Date(iso.includes("T") ? `${iso}Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("mn-MN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function getDaysInMonth(y: number, m: number) { return new Date(y, m, 0).getDate(); }
function getFirstDow(y: number, m: number) { const d = new Date(y, m - 1, 1).getDay(); return d === 0 ? 6 : d - 1; }

const MONTH_NAMES = ["1-р сар","2-р сар","3-р сар","4-р сар","5-р сар","6-р сар","7-р сар","8-р сар","9-р сар","10-р сар","11-р сар","12-р сар"];
const WEEKDAYS = ["Да","Мя","Лх","Пү","Ба","Бя","Ня"];

// ─── Main Page ───────────────────────────────────────────────
export default function InventoryCount() {
  const { baseRole, role } = useAuthStore();
  const isAdmin = (baseRole ?? role) === "admin";

  const [tab, setTab] = useState<"import" | "calendar">("import");
  const [warehouses, setWarehouses] = useState<WarehouseDef[]>([]);
  const [counts, setCounts] = useState<CountRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);

  // Selection
  const [selectedWh, setSelectedWh] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Users (for employee selection)
  const [users, setUsers] = useState<UserOption[]>([]);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [createDate, setCreateDate] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createPoints, setCreatePoints] = useState("");
  const [createTargetIds, setCreateTargetIds] = useState<number[]>([]);

  // Edit modal
  const [editTarget, setEditTarget] = useState<CountRecord | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editPoints, setEditPoints] = useState("");
  const [editTargetIds, setEditTargetIds] = useState<number[]>([]);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<CountRecord | null>(null);

  // Calendar
  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth() + 1);
  const [calData, setCalData] = useState<Record<number, CalendarEntry[]>>({});
  const [calLoading, setCalLoading] = useState(false);

  const showFlash = (msg: string, ok = true) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 3000);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [whRes, cRes] = await Promise.all([
        api.get("/inventory-count/warehouses"),
        api.get("/inventory-count/counts"),
      ]);
      setWarehouses(whRes.data);
      setCounts(cRes.data);
      if (!selectedWh && whRes.data.length > 0) setSelectedWh(whRes.data[0].key);
    } catch {
      showFlash("Мэдээлэл ачаалахад алдаа гарлаа", false);
    } finally {
      setLoading(false);
    }
  };

  const loadCalendar = async () => {
    setCalLoading(true);
    try {
      const res = await api.get("/inventory-count/calendar", { params: { year: calYear, month: calMonth } });
      const raw: Record<string, CalendarEntry[]> = res.data.days || {};
      const parsed: Record<number, CalendarEntry[]> = {};
      for (const [k, v] of Object.entries(raw)) parsed[Number(k)] = v;
      setCalData(parsed);
    } catch { showFlash("Календар ачаалахад алдаа", false); }
    finally { setCalLoading(false); }
  };

  useEffect(() => {
    loadData();
    if (isAdmin) {
      api.get("/admin/users").then(r => setUsers(r.data)).catch(() => setUsers([]));
    }
  }, []);
  useEffect(() => { if (tab === "calendar") loadCalendar(); }, [tab, calYear, calMonth]);

  // ── Actions ────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!createDate || !selectedWh) return;
    setBusy(true);
    try {
      await api.post("/inventory-count/counts", {
        warehouse_key: selectedWh,
        count_date: createDate,
        description: createDesc,
        target_employee_ids: createTargetIds,
        points: parseFloat(createPoints) || 0,
      });
      showFlash("Тооллого үүсгэгдлээ");
      setShowCreate(false);
      setCreateDate("");
      setCreateDesc("");
      setCreatePoints("");
      setCreateTargetIds([]);
      await loadData();
    } catch (e: any) { showFlash(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
    finally { setBusy(false); }
  };

  const handleUploadTxt = async (countId: number, files: FileList) => {
    setBusy(true);
    try {
      const fd = new FormData();
      for (let i = 0; i < files.length; i++) fd.append("files", files[i]);
      const res = await api.post(`/inventory-count/counts/${countId}/upload-txt`, fd);
      showFlash(`${res.data.count} TXT файл оруулагдлаа`);
      await loadData();
    } catch (e: any) { showFlash(e?.response?.data?.detail ?? "TXT оруулахад алдаа", false); }
    finally { setBusy(false); }
  };

  const handleUploadExcel = async (countId: number, file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("f", file);
      await api.post(`/inventory-count/counts/${countId}/upload-excel`, fd);
      showFlash("Excel файл оруулагдлаа");
      await loadData();
    } catch (e: any) { showFlash(e?.response?.data?.detail ?? "Excel оруулахад алдаа", false); }
    finally { setBusy(false); }
  };

  const handleDownload = async (fileId: number, filename: string) => {
    try {
      const res = await api.get(`/inventory-count/files/${fileId}/download`, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch { showFlash("Файл татахад алдаа", false); }
  };

  const handleDownloadCountDiff = async (countId: number) => {
    setBusy(true);
    try {
      const res = await api.get(`/inventory-count/counts/${countId}/export-discrepancy`, {
        responseType: "blob",
      });
      const cd = res.headers?.["content-disposition"] ?? "";
      let filename = `inventory_count_${countId}_diff.xlsx`;
      const utf8 = cd.match(/filename\*=UTF-8''([^\s;]+)/i);
      const plain = cd.match(/filename="?([^\";]+)"?/i);
      if (utf8?.[1]) {
        try { filename = decodeURIComponent(utf8[1]); } catch {}
      } else if (plain?.[1]) {
        filename = plain[1];
      }
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      showFlash("Тооллогоны зөрүү Excel татагдлаа");
    } catch (e: any) {
      showFlash(e?.response?.data?.detail ?? "Тооллогоны зөрүү Excel татахад алдаа", false);
    } finally {
      setBusy(false);
    }
  };
  // Зөвхөн админ — TXT/Excel файлыг устгах
  const handleDeleteFile = async (fileId: number, filename: string) => {
    if (!confirm(`"${filename}" файлыг устгах уу?`)) return;
    setBusy(true);
    try {
      await api.delete(`/inventory-count/files/${fileId}`);
      showFlash("Файл устгагдлаа");
      await loadData();
    } catch (e: any) {
      showFlash(e?.response?.data?.detail ?? "Файл устгахад алдаа", false);
    } finally { setBusy(false); }
  };

  // Checklist (4 шалгалтын нэг toggle)
  const handleChecklistToggle = async (countId: number, key: ChecklistKey, value: boolean) => {
    // Optimistic local update
    setCounts(prev => prev.map(c => c.id === countId ? { ...c, [key]: value } : c));
    try {
      await api.patch(`/inventory-count/counts/${countId}/checklist`, { [key]: value });
    } catch (e: any) {
      // Revert on failure
      setCounts(prev => prev.map(c => c.id === countId ? { ...c, [key]: !value } : c));
      showFlash(e?.response?.data?.detail ?? "Шалгалт хадгалахад алдаа", false);
    }
  };

  const handleEdit = async () => {
    if (!editTarget || !editDate) return;
    setBusy(true);
    try {
      await api.put(`/inventory-count/counts/${editTarget.id}`, {
        count_date: editDate,
        description: editDesc,
        target_employee_ids: editTargetIds,
        points: parseFloat(editPoints) || 0,
      });
      showFlash("Тооллого засварлагдлаа");
      setEditTarget(null);
      await loadData();
    } catch (e: any) { showFlash(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
    finally { setBusy(false); }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.delete(`/inventory-count/counts/${deleteTarget.id}`);
      showFlash("Тооллого устгагдлаа");
      setDeleteTarget(null);
      setExpandedId(null);
      await loadData();
    } catch (e: any) { showFlash(e?.response?.data?.detail ?? "Устгахад алдаа гарлаа", false); }
    finally { setBusy(false); }
  };

  // ── Derived ────────────────────────────────────────────────
  const activeWh = warehouses.find((w) => w.key === selectedWh);
  const whCounts = counts.filter((c) => c.warehouse_key === selectedWh);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Тооллогоны тайлан</h1>
          <p className="mt-0.5 text-sm text-gray-500">Агуулах тус бүрийн тооллого болон файлын удирдлага</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-4 flex gap-1 rounded-xl bg-gray-100 p-1 w-fit">
        {([
          { key: "import" as const, label: "Тооллого оруулах", icon: UploadCloud },
          { key: "calendar" as const, label: "Боловсруулсан тайлан", icon: CalendarIcon },
        ]).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === key ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {flash && (
        <div className={`mt-4 rounded-apple px-4 py-3 text-sm font-medium ${flash.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
          {flash.msg}
        </div>
      )}

      {/* ═══════ TAB 1: Master-Detail ═══════ */}
      {tab === "import" && (
        <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* ── Left: Warehouse list ── */}
          <div className="lg:col-span-3">
            <Card className="p-0 overflow-hidden">
              <div className="border-b border-gray-100 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <Warehouse size={15} />
                  Агуулахууд
                </div>
              </div>
              {loading ? (
                <div className="flex justify-center py-8"><RefreshCw size={16} className="animate-spin text-gray-400" /></div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {warehouses.map((wh) => {
                    const cnt = counts.filter((c) => c.warehouse_key === wh.key).length;
                    const isActive = selectedWh === wh.key;
                    return (
                      <button
                        key={wh.key}
                        onClick={() => { setSelectedWh(wh.key); setExpandedId(null); }}
                        className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors ${
                          isActive ? "bg-blue-50" : "hover:bg-gray-50"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${wh.color.replace("text-", "bg-")}`} />
                          <span className={`text-sm font-medium truncate ${isActive ? "text-gray-900" : "text-gray-700"}`}>
                            {wh.label}
                          </span>
                        </div>
                        <span className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                          cnt > 0 ? "bg-gray-200 text-gray-700" : "bg-gray-100 text-gray-400"
                        }`}>
                          {cnt}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* ── Right: Count list ── */}
          <div className="lg:col-span-9">
            <Card className="p-0 overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
                <div className="flex items-center gap-2">
                  {activeWh && (
                    <span className={`h-3 w-3 rounded-full ${activeWh.color.replace("text-", "bg-")}`} />
                  )}
                  <span className="text-sm font-semibold text-gray-900">
                    {activeWh?.label ?? "Агуулах сонгоно уу"}
                  </span>
                  <span className="text-xs text-gray-400">{whCounts.length} тооллого</span>
                </div>
                {selectedWh && (
                  <button
                    onClick={() => { setShowCreate(true); setCreateDate(""); setCreateDesc(""); }}
                    className="inline-flex items-center gap-1.5 rounded-apple bg-[#0071E3] px-3.5 py-2 text-xs font-medium text-white hover:opacity-90"
                  >
                    <Plus size={14} />
                    Тооллого үүсгэх
                  </button>
                )}
              </div>

              {/* Table */}
              {!selectedWh ? (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                  <FolderOpen size={36} className="mb-2 opacity-40" />
                  <span className="text-sm">Зүүн талаас агуулах сонгоно уу</span>
                </div>
              ) : whCounts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                  <FolderOpen size={36} className="mb-2 opacity-40" />
                  <span className="text-sm">Тооллого байхгүй байна</span>
                </div>
              ) : (
                <div>
                  {/* Table header */}
                  <div className="grid grid-cols-12 gap-2 border-b border-gray-100 bg-gray-50/80 px-5 py-2.5 text-xs font-medium text-gray-500">
                    <div className="col-span-1">#</div>
                    <div className="col-span-3">Огноо</div>
                    <div className="col-span-4">Тайлбар</div>
                    <div className="col-span-2 text-center">Файл</div>
                    <div className="col-span-2 text-right">Үйлдэл</div>
                  </div>

                  {/* Rows */}
                  <div className="divide-y divide-gray-100">
                    {whCounts.map((c, idx) => {
                      const isOpen = expandedId === c.id;
                      const txtFiles = c.files.filter((f) => f.file_type === "txt");
                      const excelFiles = c.files.filter((f) => f.file_type === "excel");
                      return (
                        <div key={c.id}>
                          {/* Main row */}
                          <div
                            onClick={() => setExpandedId(isOpen ? null : c.id)}
                            className={`grid grid-cols-12 gap-2 items-center px-5 py-3 cursor-pointer transition-colors ${
                              isOpen ? "bg-blue-50/50" : "hover:bg-gray-50"
                            }`}
                          >
                            <div className="col-span-1 text-xs text-gray-400">{idx + 1}</div>
                            <div className="col-span-3">
                              <span className="text-sm font-semibold text-gray-900">{fmtDate(c.count_date)}</span>
                            </div>
                            <div className="col-span-4 text-sm text-gray-600">
                              <div className="truncate">
                                {c.description || <span className="text-gray-300">—</span>}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                                {c.kpi_admin_task_id && (
                                  <>
                                    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                                      c.kpi_task_active === false
                                        ? "bg-gray-100 text-gray-400"
                                        : "bg-violet-50 text-violet-700"
                                    }`}>
                                      KPI · {c.kpi_points ?? 0} оноо
                                    </span>
                                    <span className="text-[10px] text-gray-400">
                                      {c.kpi_target_employee_ids.length} ажилтан
                                    </span>
                                  </>
                                )}
                                {(() => {
                                  const ck = CHECKLIST_ITEMS.filter(it => c[it.key]).length;
                                  const total = CHECKLIST_ITEMS.length;
                                  const allOk = ck === total;
                                  return (
                                    <span
                                      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                        allOk
                                          ? "bg-emerald-50 text-emerald-700"
                                          : ck > 0
                                            ? "bg-amber-50 text-amber-700"
                                            : "bg-gray-100 text-gray-500"
                                      }`}
                                      title="Тооллогын урьдчилсан шалгалт"
                                    >
                                      <CheckSquare size={10}/>
                                      {ck}/{total}
                                    </span>
                                  );
                                })()}
                              </div>
                            </div>
                            <div className="col-span-2 flex items-center justify-center gap-2">
                              {txtFiles.length > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                                  <FileText size={10} />
                                  {txtFiles.length}
                                </span>
                              )}
                              {excelFiles.length > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                                  <FileSpreadsheet size={10} />
                                  {excelFiles.length}
                                </span>
                              )}
                              {c.file_count === 0 && (
                                <span className="text-xs text-gray-300">0</span>
                              )}
                            </div>
                            <div className="col-span-2 flex items-center justify-end gap-1">
                              {isAdmin && (
                                <>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditTarget(c);
                                      setEditDate(c.count_date);
                                      setEditDesc(c.description);
                                      setEditPoints(c.kpi_points != null ? String(c.kpi_points) : "");
                                      setEditTargetIds(c.kpi_target_employee_ids || []);
                                    }}
                                    className="rounded-lg p-1.5 text-gray-400 hover:text-[#0071E3] hover:bg-blue-50"
                                    title="Засах"
                                  >
                                    <Pencil size={13} />
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDeleteTarget(c);
                                    }}
                                    className="rounded-lg p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50"
                                    title="Устгах"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </>
                              )}
                              <ChevronDown
                                size={16}
                                className={`text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                              />
                            </div>
                          </div>

                          {/* Expanded detail */}
                          <AnimatePresence>
                            {isOpen && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                              >
                                <div className="bg-gray-50/50 px-5 pb-4 pt-1">
                                  {/* ── Checklist (4 шалгалт) ── */}
                                  {(() => {
                                    const checkedCount = CHECKLIST_ITEMS.filter(it => c[it.key]).length;
                                    const allChecked = checkedCount === CHECKLIST_ITEMS.length;
                                    return (
                                      <div
                                        className={`mb-3 rounded-xl border p-3 ${
                                          allChecked
                                            ? "bg-emerald-50 border-emerald-200"
                                            : "bg-white border-gray-200"
                                        }`}
                                      >
                                        <div className="mb-2 flex items-center justify-between">
                                          <span className={`flex items-center gap-1.5 text-xs font-semibold ${allChecked ? "text-emerald-800" : "text-gray-700"}`}>
                                            <CheckSquare size={13}/>
                                            Тооллогын урьдчилсан шалгалт
                                          </span>
                                          <span className={`tabular-nums rounded-full px-2 py-0.5 text-[11px] font-bold ${
                                            allChecked
                                              ? "bg-emerald-100 text-emerald-700"
                                              : "bg-gray-100 text-gray-600"
                                          }`}>
                                            {checkedCount}/{CHECKLIST_ITEMS.length}
                                          </span>
                                        </div>
                                        <ul className="space-y-1.5">
                                          {CHECKLIST_ITEMS.map(it => {
                                            const checked = !!c[it.key];
                                            return (
                                              <li key={it.key}>
                                                <button
                                                  onClick={(e) => { e.stopPropagation(); handleChecklistToggle(c.id, it.key, !checked); }}
                                                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                                                    checked
                                                      ? "bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                                                      : "bg-white text-gray-700 hover:bg-gray-50 ring-1 ring-inset ring-gray-100"
                                                  }`}
                                                >
                                                  {checked
                                                    ? <CheckSquare size={15} className="shrink-0 text-emerald-600"/>
                                                    : <Square size={15} className="shrink-0 text-gray-400"/>}
                                                  <span className={checked ? "font-medium" : ""}>{it.label}</span>
                                                </button>
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      </div>
                                    );
                                  })()}

                                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                                    {/* TXT files */}
                                    <div>
                                      <div className="mb-2 flex items-center justify-between">
                                        <span className="text-xs font-semibold text-gray-600">
                                          Гар утасны мэдээлэл (.txt)
                                        </span>
                                        <label className="inline-flex items-center gap-1 rounded-lg bg-white border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 cursor-pointer hover:bg-gray-50">
                                          <UploadCloud size={12} />
                                          Нэмэх
                                          <input
                                            type="file"
                                            accept=".txt,.text"
                                            multiple
                                            className="hidden"
                                            onChange={(e) => {
                                              if (e.target.files?.length) handleUploadTxt(c.id, e.target.files);
                                              e.currentTarget.value = "";
                                            }}
                                          />
                                        </label>
                                      </div>
                                      {txtFiles.length === 0 ? (
                                        <div className="rounded-lg border border-dashed border-gray-200 bg-white p-4 text-center text-xs text-gray-400">
                                          TXT файл оруулаагүй байна
                                        </div>
                                      ) : (
                                        <div className="space-y-1">
                                          {txtFiles.map((f) => (
                                            <div key={f.id} className="flex items-center justify-between rounded-lg bg-white border border-gray-200 px-3 py-2">
                                              <div className="flex items-center gap-2 min-w-0">
                                                <FileText size={14} className="text-gray-400 shrink-0" />
                                                <span className="text-xs text-gray-700 truncate">{f.original_filename}</span>
                                              </div>
                                              <div className="flex items-center gap-0.5 shrink-0">
                                                <button
                                                  onClick={(e) => { e.stopPropagation(); handleDownload(f.id, f.original_filename); }}
                                                  className="rounded-lg p-1.5 text-gray-400 hover:text-[#0071E3] hover:bg-blue-50"
                                                  title="Татах"
                                                >
                                                  <Download size={13} />
                                                </button>
                                                {isAdmin && (
                                                  <button
                                                    onClick={(e) => { e.stopPropagation(); handleDeleteFile(f.id, f.original_filename); }}
                                                    className="rounded-lg p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50"
                                                    title="Устгах (зөвхөн админ)"
                                                  >
                                                    <Trash2 size={13} />
                                                  </button>
                                                )}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>

                                    {/* Excel files */}
                                    <div>
                                      <div className="mb-2 flex items-center justify-between">
                                        <span className="text-xs font-semibold text-gray-600">
                                          Тооллогоны Эксэл файл (.xlsx)
                                        </span>
                                        <div className="flex items-center gap-1.5">
                                          <button
                                            onClick={(e) => { e.stopPropagation(); handleDownloadCountDiff(c.id); }}
                                            disabled={busy || excelFiles.length === 0}
                                            className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                                            title="Зөрүүтэй барааны шинэ Excel татах"
                                          >
                                            <Download size={12} />
                                            Тооллогоны зөрүү
                                          </button>
                                          <label className="inline-flex items-center gap-1 rounded-lg bg-white border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 cursor-pointer hover:bg-gray-50">
                                            <UploadCloud size={12} />
                                            Нэмэх
                                            <input
                                              type="file"
                                              accept=".xlsx,.xls"
                                              className="hidden"
                                              onChange={(e) => {
                                                const file = e.target.files?.[0];
                                                if (file) handleUploadExcel(c.id, file);
                                                e.currentTarget.value = "";
                                              }}
                                            />
                                          </label>
                                        </div>
                                      </div>
                                      {excelFiles.length === 0 ? (
                                        <div className="rounded-lg border border-dashed border-gray-200 bg-white p-4 text-center text-xs text-gray-400">
                                          Тооллогоны Эксэл файл оруулаагүй байна
                                        </div>
                                      ) : (
                                        <div className="space-y-1">
                                          {excelFiles.map((f) => (
                                            <div key={f.id} className="flex items-center justify-between rounded-lg bg-white border border-gray-200 px-3 py-2">
                                              <div className="flex items-center gap-2 min-w-0">
                                                <FileSpreadsheet size={14} className="text-emerald-500 shrink-0" />
                                                <span className="text-xs text-gray-700 truncate">{f.original_filename}</span>
                                              </div>
                                              <div className="flex items-center gap-0.5 shrink-0">
                                                <button
                                                  onClick={(e) => { e.stopPropagation(); handleDownload(f.id, f.original_filename); }}
                                                  className="rounded-lg p-1.5 text-gray-400 hover:text-[#0071E3] hover:bg-blue-50"
                                                  title="Татах"
                                                >
                                                  <Download size={13} />
                                                </button>
                                                {isAdmin && (
                                                  <button
                                                    onClick={(e) => { e.stopPropagation(); handleDeleteFile(f.id, f.original_filename); }}
                                                    className="rounded-lg p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50"
                                                    title="Устгах (зөвхөн админ)"
                                                  >
                                                    <Trash2 size={13} />
                                                  </button>
                                                )}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {c.created_by && (
                                    <div className="mt-2 text-xs text-gray-400">
                                      Үүсгэсэн: {c.created_by} · {fmtDate(c.created_at)}
                                    </div>
                                  )}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* ═══════ TAB 2: Calendar ═══════ */}
      {tab === "calendar" && (
        <div className="mt-5">
          <Card className="p-0 overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <button onClick={() => { if (calMonth === 1) { setCalYear(y => y-1); setCalMonth(12); } else setCalMonth(m => m-1); }} className="rounded-lg p-2 hover:bg-gray-100">
                <ChevronLeft size={16} />
              </button>
              <div className="text-sm font-semibold text-gray-900">
                {calYear} оны {MONTH_NAMES[calMonth - 1]}
              </div>
              <button onClick={() => { if (calMonth === 12) { setCalYear(y => y+1); setCalMonth(1); } else setCalMonth(m => m+1); }} className="rounded-lg p-2 hover:bg-gray-100">
                <ChevronRight size={16} />
              </button>
            </div>

            {calLoading ? (
              <div className="flex justify-center py-16"><RefreshCw size={20} className="animate-spin text-gray-400" /></div>
            ) : (
              <div className="p-4">
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {WEEKDAYS.map((w) => (
                    <div key={w} className="text-center text-xs font-medium text-gray-400 py-1">{w}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {(() => {
                    const dim = getDaysInMonth(calYear, calMonth);
                    const fd = getFirstDow(calYear, calMonth);
                    const cells: (number|null)[] = [];
                    for (let i=0;i<fd;i++) cells.push(null);
                    for (let d=1;d<=dim;d++) cells.push(d);
                    while (cells.length%7) cells.push(null);
                    const today = new Date();
                    const isTd = (d:number) => today.getFullYear()===calYear && today.getMonth()+1===calMonth && today.getDate()===d;
                    return cells.map((day, i) => {
                      if (day===null) return <div key={`e${i}`} className="min-h-[80px]" />;
                      const entries = calData[day]||[];
                      return (
                        <div key={day} className={`min-h-[80px] rounded-lg border p-1.5 ${
                          isTd(day) ? "border-[#0071E3] bg-blue-50/50" : entries.length>0 ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50/50"
                        }`}>
                          <div className={`text-xs font-medium mb-1 ${isTd(day)?"text-[#0071E3]":"text-gray-500"}`}>{day}</div>
                          <div className="space-y-0.5">
                            {entries.map((e) => (
                              <div key={e.id} className={`rounded px-1 py-0.5 text-[10px] font-medium truncate border ${e.bg} ${e.color}`}
                                title={`${e.warehouse_label} — ${e.description||""} (${e.file_count} файл)`}>
                                {e.warehouse_label}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}
          </Card>

          {/* Legend */}
          <div className="mt-4 flex flex-wrap gap-2">
            {warehouses.map((wh) => (
              <div key={wh.key} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium ${wh.bg} ${wh.color}`}>
                <span className={`h-2 w-2 rounded-full ${wh.color.replace("text-","bg-")}`} />
                {wh.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══════ Create Modal ═══════ */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-apple bg-white p-6 shadow-xl"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Тооллого үүсгэх</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>

            <div className="mb-3 flex items-center gap-2">
              {activeWh && <span className={`h-3 w-3 rounded-full ${activeWh.color.replace("text-","bg-")}`} />}
              <span className="text-sm font-medium text-gray-700">{activeWh?.label}</span>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Огноо *</label>
                  <input
                    type="date"
                    value={createDate}
                    onChange={(e) => setCreateDate(e.target.value)}
                    className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Оноо *</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={createPoints}
                    onChange={(e) => setCreatePoints(e.target.value)}
                    placeholder="Жнь: 10"
                    className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">Тайлбар</label>
                <textarea
                  value={createDesc}
                  onChange={(e) => setCreateDesc(e.target.value)}
                  rows={2}
                  placeholder="Жнь: Дүнгийн тулгалт"
                  className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
                />
              </div>

              {/* Employee selection */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-gray-500">
                    Ажилтан сонгох <span className="text-red-400">*</span>
                  </label>
                  <span className="text-xs text-gray-400">{createTargetIds.length} сонгогдсон</span>
                </div>
                <div className="rounded-apple border border-gray-200 bg-gray-50 max-h-48 overflow-y-auto">
                  {users.filter(u => u.is_active !== false).length === 0 ? (
                    <div className="p-4 text-center text-xs text-gray-400">Ажилтан байхгүй</div>
                  ) : (
                    users.filter(u => u.is_active !== false).map(u => (
                      <label key={u.id} className="flex cursor-pointer items-center justify-between border-b border-gray-100 px-3 py-2 hover:bg-white last:border-b-0">
                        <span className="text-xs text-gray-700">
                          {u.nickname || u.username}
                          <span className="ml-1.5 text-gray-400">({u.role})</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={createTargetIds.includes(u.id)}
                          onChange={(e) =>
                            setCreateTargetIds(prev =>
                              e.target.checked ? [...prev, u.id] : prev.filter(x => x !== u.id)
                            )
                          }
                          className="h-3.5 w-3.5 accent-[#0071E3]"
                        />
                      </label>
                    ))
                  )}
                </div>
                <p className="mt-1 text-[10px] text-gray-400">
                  Сонгосон ажилтнуудын өдрийн даалгавар дээр тооллого автоматаар нэмэгдэнэ
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                Болих
              </button>
              <button
                onClick={handleCreate}
                disabled={!createDate || createTargetIds.length === 0 || !createPoints || busy}
                className="rounded-apple bg-[#0071E3] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? <RefreshCw size={14} className="animate-spin" /> : "Үүсгэх"}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* ═══════ Edit Modal ═══════ */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-apple bg-white p-6 shadow-xl"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Тооллого засах</h2>
              <button onClick={() => setEditTarget(null)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Огноо *</label>
                  <input
                    type="date"
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                    className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Оноо</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={editPoints}
                    onChange={(e) => setEditPoints(e.target.value)}
                    className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">Тайлбар</label>
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  rows={2}
                  className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
                />
              </div>

              {/* Employee selection */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-gray-500">Ажилтан сонгох</label>
                  <span className="text-xs text-gray-400">{editTargetIds.length} сонгогдсон</span>
                </div>
                <div className="rounded-apple border border-gray-200 bg-gray-50 max-h-48 overflow-y-auto">
                  {users.filter(u => u.is_active !== false).length === 0 ? (
                    <div className="p-4 text-center text-xs text-gray-400">Ажилтан байхгүй</div>
                  ) : (
                    users.filter(u => u.is_active !== false).map(u => (
                      <label key={u.id} className="flex cursor-pointer items-center justify-between border-b border-gray-100 px-3 py-2 hover:bg-white last:border-b-0">
                        <span className="text-xs text-gray-700">
                          {u.nickname || u.username}
                          <span className="ml-1.5 text-gray-400">({u.role})</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={editTargetIds.includes(u.id)}
                          onChange={(e) =>
                            setEditTargetIds(prev =>
                              e.target.checked ? [...prev, u.id] : prev.filter(x => x !== u.id)
                            )
                          }
                          className="h-3.5 w-3.5 accent-[#0071E3]"
                        />
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setEditTarget(null)} className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                Болих
              </button>
              <button
                onClick={handleEdit}
                disabled={!editDate || busy}
                className="rounded-apple bg-[#0071E3] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? <RefreshCw size={14} className="animate-spin" /> : "Хадгалах"}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* ═══════ Delete Confirm Modal ═══════ */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-sm rounded-apple bg-white p-6 shadow-xl"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900">Тооллого устгах</h2>
                <p className="text-sm text-gray-500">Энэ үйлдлийг буцаах боломжгүй.</p>
              </div>
            </div>
            <p className="mt-4 text-sm text-gray-700">
              <span className="font-semibold">{fmtDate(deleteTarget.count_date)}</span> огноотой тооллого болон түүний{" "}
              <span className="font-semibold text-red-600">{deleteTarget.file_count} файл</span>-г бүрмөсөн устгах уу?
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                Болих
              </button>
              <button
                onClick={handleDelete}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-apple bg-red-600 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy && <RefreshCw size={13} className="animate-spin" />}
                Устгах
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}

