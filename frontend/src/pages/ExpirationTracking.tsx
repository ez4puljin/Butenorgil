/**
 * Хугацааны хяналт (Expiration Tracking)
 * Бараа scan/хайж нэмэх, дуусах хугацаа, Заал + Агуулах үлдэгдэл,
 * status, хариуцлага оноох, архив, A4 landscape хэвлэх.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, Search, X, Check, Loader2, AlertCircle, CheckCircle,
  Timer, Printer, Archive, ArchiveRestore, Trash2, Pencil, Filter,
  ScanLine, Calendar as CalendarIcon, Users, AlertTriangle, FileText,
  Camera,
} from "lucide-react";
import { api } from "../lib/api";
import BarcodeScanner from "../components/BarcodeScanner";

// ── Types ────────────────────────────────────────────────────────────────────

interface ExpirationItemRow {
  id: number;
  product_id: number;
  product_name: string;
  product_code: string;
  product_brand: string;
  product_barcode: string;
  expiration_date: string;
  days_left: number;
  is_expired: boolean;
  is_expiring_soon: boolean;
  qty_floor: number;
  qty_warehouse: number;
  qty_total: number;
  status: string;
  liability_type: string;
  liability_role_ids: string[];
  liability_user_ids: number[];
  liability_note: string;
  notes: string;
  archived_at: string | null;
  archived_by_username: string;
  created_at: string;
  created_by_username: string;
  updated_at: string;
}

interface ProductHit {
  id: number;
  item_code: string;
  name: string;
  brand: string;
  barcode: string;
  stock_qty: number;
}

interface RoleOpt { value: string; label: string; color?: string; }
interface UserOpt { id: number; username: string; nickname: string; role: string; }
interface StatsResp {
  total_active: number;
  expired: number;
  expiring_soon: number;
  by_status: Record<string, number>;
  archived: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; color: string; iconBg: string }> = {
  review:        { label: "Хянагдаж байна",      color: "bg-blue-50 text-blue-700 border-blue-200",         iconBg: "bg-blue-100 text-blue-600" },
  city_return:   { label: "Хот буцаалт",         color: "bg-violet-50 text-violet-700 border-violet-200",   iconBg: "bg-violet-100 text-violet-600" },
  internal_sale: { label: "Дотоод хямдрал (20%)", color: "bg-amber-50 text-amber-700 border-amber-200",      iconBg: "bg-amber-100 text-amber-600" },
  archived:      { label: "Архив",                color: "bg-gray-100 text-gray-600 border-gray-300",        iconBg: "bg-gray-200 text-gray-500" },
};

const LIABILITY_META: Record<string, { label: string; color: string }> = {
  none:      { label: "Хариуцлагагүй",          color: "bg-gray-100 text-gray-500" },
  specific:  { label: "Тодорхой ажилчид",       color: "bg-orange-100 text-orange-700" },
  all_staff: { label: "Бүх ажилчид",            color: "bg-red-100 text-red-700" },
};

type FilterType = "all" | "expired" | "expiring_soon" | "review" | "city_return" | "internal_sale" | "archived";

const FILTER_PILLS: { key: FilterType; label: string; color: string }[] = [
  { key: "all",            label: "Бүгд",                color: "bg-white text-gray-700 border-gray-200" },
  { key: "expired",        label: "Дууссан",             color: "bg-red-50 text-red-700 border-red-200" },
  { key: "expiring_soon",  label: "Дуусах дөхсөн",        color: "bg-amber-50 text-amber-700 border-amber-200" },
  { key: "review",         label: "Хянагдаж байна",      color: "bg-blue-50 text-blue-700 border-blue-200" },
  { key: "city_return",    label: "Хот буцаалт",          color: "bg-violet-50 text-violet-700 border-violet-200" },
  { key: "internal_sale",  label: "Дотоод хямдрал",       color: "bg-amber-50 text-amber-700 border-amber-200" },
  { key: "archived",       label: "Архив",                color: "bg-gray-50 text-gray-700 border-gray-200" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${y}/${m}/${d}`;
}

function daysLabel(d: number): string {
  if (d < 0) return `${Math.abs(d)} хоног өнгөрсөн`;
  if (d === 0) return "Өнөөдөр дуусна";
  return `${d} хоног үлдсэн`;
}

function daysColor(d: number): string {
  if (d < 0) return "text-red-700 font-bold";
  if (d <= 7) return "text-red-600 font-semibold";
  if (d <= 30) return "text-amber-600 font-medium";
  return "text-gray-600";
}

// ── Toast ────────────────────────────────────────────────────────────────────

function Toast({ toast }: { toast: { msg: string; ok: boolean } | null }) {
  if (!toast) return null;
  return (
    <div className={`fixed top-4 right-4 z-[120] flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${
      toast.ok ? "bg-emerald-500 text-white" : "bg-red-500 text-white"
    }`}>
      {toast.ok ? <CheckCircle size={15}/> : <AlertCircle size={15}/>}
      {toast.msg}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ExpirationTracking() {
  const [items, setItems]       = useState<ExpirationItemRow[]>([]);
  const [stats, setStats]       = useState<StatsResp | null>(null);
  const [loading, setLoading]   = useState(false);
  const [filter, setFilter]     = useState<FilterType>("all");
  const [search, setSearch]     = useState("");
  const [toast, setToast]       = useState<{ msg: string; ok: boolean } | null>(null);
  const [roles, setRoles]       = useState<RoleOpt[]>([]);
  const [users, setUsers]       = useState<UserOpt[]>([]);

  // Add modal
  const [addOpen, setAddOpen]     = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerHits, setPickerHits]   = useState<ProductHit[]>([]);
  const [pickerSearching, setPickerSearching] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductHit | null>(null);
  const [addExpDate, setAddExpDate] = useState("");
  const [addQtyFloor, setAddQtyFloor] = useState("");
  const [addQtyWarehouse, setAddQtyWarehouse] = useState("");
  const [addNotes, setAddNotes] = useState("");
  const [adding, setAdding] = useState(false);

  // Liability modal
  const [liabFor, setLiabFor] = useState<ExpirationItemRow | null>(null);
  const [liabType, setLiabType] = useState<string>("none");
  const [liabRoleIds, setLiabRoleIds] = useState<Set<string>>(new Set());
  const [liabUserIds, setLiabUserIds] = useState<Set<number>>(new Set());
  const [liabNote, setLiabNote] = useState("");
  const [liabSaving, setLiabSaving] = useState(false);

  // Edit qty + notes inline
  const [editId, setEditId] = useState<number | null>(null);
  const [editFloor, setEditFloor] = useState("");
  const [editWarehouse, setEditWarehouse] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // Camera barcode scanner
  const [scannerOpen, setScannerOpen] = useState(false);

  // Delete confirm
  const [confirmDel, setConfirmDel] = useState<ExpirationItemRow | null>(null);

  const scanRef = useRef<HTMLInputElement>(null);

  function notify(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 2500);
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async function loadAll() {
    setLoading(true);
    try {
      const params: any = {};
      if (filter === "expired" || filter === "expiring_soon") params.filter_type = filter;
      else if (filter === "archived") { params.include_archived = true; params.status = "archived"; }
      else if (filter !== "all") params.status = filter;
      if (search.trim()) params.search = search.trim();

      const [iRes, sRes] = await Promise.all([
        api.get("/expiration/items", { params }),
        api.get("/expiration/stats").catch(() => ({ data: null })),
      ]);
      setItems(iRes.data);
      if (sRes.data) setStats(sRes.data);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Ачааллахад алдаа гарлаа", false);
    } finally {
      setLoading(false);
    }
  }

  async function loadLookups() {
    try {
      const [rRes, uRes] = await Promise.all([
        api.get("/expiration/lookup/roles"),
        api.get("/expiration/lookup/users"),
      ]);
      setRoles(rRes.data);
      setUsers(uRes.data);
    } catch { /* ignore */ }
  }

  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, [filter]);
  useEffect(() => { loadLookups(); }, []);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => { loadAll(); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // ── Product picker (scan/search) ───────────────────────────────────────────

  useEffect(() => {
    const q = pickerQuery.trim();
    if (q.length < 2) { setPickerHits([]); return; }
    const t = setTimeout(async () => {
      setPickerSearching(true);
      try {
        const r = await api.get("/expiration/lookup/products", { params: { q } });
        setPickerHits(r.data);
      } catch { setPickerHits([]); }
      finally { setPickerSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [pickerQuery]);

  function openAdd() {
    setAddOpen(true);
    setPickerQuery("");
    setPickerHits([]);
    setSelectedProduct(null);
    setAddExpDate("");
    setAddQtyFloor("");
    setAddQtyWarehouse("");
    setAddNotes("");
    setTimeout(() => scanRef.current?.focus(), 100);
  }

  function selectProduct(p: ProductHit) {
    setSelectedProduct(p);
    setPickerHits([]);
    setPickerQuery(p.name);
  }

  async function submitAdd() {
    if (!selectedProduct) { notify("Бараа сонгоно уу", false); return; }
    if (!addExpDate) { notify("Дуусах огноо оруулна уу", false); return; }
    const qf = parseFloat(addQtyFloor) || 0;
    const qw = parseFloat(addQtyWarehouse) || 0;
    if (qf < 0 || qw < 0) { notify("Үлдэгдэл сөрөг байж болохгүй", false); return; }
    if (qf === 0 && qw === 0) { notify("Заал эсвэл Агуулахын үлдэгдэл оруулна уу", false); return; }

    setAdding(true);
    try {
      await api.post("/expiration/items", {
        product_id: selectedProduct.id,
        expiration_date: addExpDate,
        qty_floor: qf,
        qty_warehouse: qw,
        notes: addNotes.trim(),
      });
      notify("Бүртгэгдлээ ✓");
      setAddOpen(false);
      await loadAll();
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setAdding(false);
    }
  }

  // ── Inline qty edit ────────────────────────────────────────────────────────

  function startEdit(it: ExpirationItemRow) {
    setEditId(it.id);
    setEditFloor(String(it.qty_floor));
    setEditWarehouse(String(it.qty_warehouse));
    setEditNotes(it.notes || "");
  }

  async function saveEdit(it: ExpirationItemRow) {
    const qf = parseFloat(editFloor) || 0;
    const qw = parseFloat(editWarehouse) || 0;
    if (qf < 0 || qw < 0) { notify("Үлдэгдэл сөрөг байж болохгүй", false); return; }
    try {
      const r = await api.patch(`/expiration/items/${it.id}`, {
        qty_floor: qf, qty_warehouse: qw, notes: editNotes.trim(),
      });
      setItems(prev => prev.map(p => p.id === it.id ? r.data : p));
      setEditId(null);
      notify("Хадгалагдлаа ✓");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  // ── Status change ──────────────────────────────────────────────────────────

  async function changeStatus(it: ExpirationItemRow, newStatus: string) {
    try {
      const r = await api.patch(`/expiration/items/${it.id}`, { status: newStatus });
      setItems(prev => prev.map(p => p.id === it.id ? r.data : p));
      notify("Статус өөрчлөгдлөө ✓");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  // ── Archive / unarchive ────────────────────────────────────────────────────

  async function toggleArchive(it: ExpirationItemRow) {
    try {
      const url = it.status === "archived"
        ? `/expiration/items/${it.id}/unarchive`
        : `/expiration/items/${it.id}/archive`;
      const r = await api.post(url);
      setItems(prev => prev.map(p => p.id === it.id ? r.data : p));
      notify(it.status === "archived" ? "Архиваас гарав" : "Архивлагдлаа ✓");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function doDelete() {
    if (!confirmDel) return;
    try {
      await api.delete(`/expiration/items/${confirmDel.id}`);
      setItems(prev => prev.filter(p => p.id !== confirmDel.id));
      setConfirmDel(null);
      notify("Устгагдлаа");
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }

  // ── Liability modal ────────────────────────────────────────────────────────

  function openLiability(it: ExpirationItemRow) {
    setLiabFor(it);
    setLiabType(it.liability_type || "none");
    setLiabRoleIds(new Set(it.liability_role_ids || []));
    setLiabUserIds(new Set(it.liability_user_ids || []));
    setLiabNote(it.liability_note || "");
  }

  async function saveLiability() {
    if (!liabFor) return;
    setLiabSaving(true);
    try {
      const r = await api.patch(`/expiration/items/${liabFor.id}`, {
        liability_type: liabType,
        liability_role_ids: Array.from(liabRoleIds).join(","),
        liability_user_ids: Array.from(liabUserIds).join(","),
        liability_note: liabNote.trim(),
      });
      setItems(prev => prev.map(p => p.id === liabFor.id ? r.data : p));
      notify("Хариуцлага хадгалагдлаа ✓");
      setLiabFor(null);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setLiabSaving(false);
    }
  }

  // ── Print (A4 landscape) ───────────────────────────────────────────────────

  function doPrint() {
    window.print();
  }

  // ── Computed ───────────────────────────────────────────────────────────────

  const visibleItems = useMemo(() => items, [items]);

  // Liability label for display
  function liabilityShort(it: ExpirationItemRow): string {
    if (it.liability_type === "all_staff") return "Бүх ажилчид";
    if (it.liability_type === "specific") {
      const rl = it.liability_role_ids.map(rid => roles.find(r => r.value === rid)?.label || rid);
      const ul = it.liability_user_ids.map(uid => {
        const u = users.find(x => x.id === uid);
        return u ? (u.nickname || u.username) : `#${uid}`;
      });
      const all = [...rl, ...ul];
      if (!all.length) return "Тогтоогоогүй";
      if (all.length <= 2) return all.join(", ");
      return `${all.slice(0, 2).join(", ")} +${all.length - 2}`;
    }
    return "—";
  }

  return (
    <div className="space-y-4">
      <Toast toast={toast}/>

      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-100 to-rose-100">
            <Timer size={20} className="text-rose-600"/>
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Хугацааны хяналт</h1>
            <p className="text-xs text-gray-400">Барааны дуусах хугацаа, Заал/Агуулах үлдэгдэл, хариуцлага</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={doPrint}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors">
            <Printer size={14}/> Хэвлэх (A4)
          </button>
          <button onClick={openAdd}
            className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 transition-colors shadow-sm">
            <Plus size={14}/> Шинэ
          </button>
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 print:hidden">
          <StatCard label="Идэвхтэй" value={stats.total_active} sub="бүгд" icon={<FileText size={16}/>} tone="blue"/>
          <StatCard label="Дуусах дөхсөн" value={stats.expiring_soon} sub="30 хоног" icon={<AlertTriangle size={16}/>} tone="amber"/>
          <StatCard label="Дууссан" value={stats.expired} sub="хугацаа өнгөрсөн" icon={<AlertCircle size={16}/>} tone="red"/>
          <StatCard label="Архивлагдсан" value={stats.archived} sub="нийт" icon={<Archive size={16}/>} tone="gray"/>
        </div>
      )}

      {/* Filter + search bar */}
      <div className="rounded-2xl bg-white p-3 shadow-sm border border-gray-100 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative min-w-[200px] flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"/>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Бараа нэр/код/баркод хайх..."
              className="w-full rounded-xl border border-gray-200 bg-gray-50 pl-9 pr-8 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15 transition-all"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X size={13}/>
              </button>
            )}
          </div>
          {/* Filter pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Filter size={13} className="text-gray-400"/>
            {FILTER_PILLS.map(p => (
              <button key={p.key} onClick={() => setFilter(p.key)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${
                  filter === p.key
                    ? `${p.color} ring-2 ring-offset-1 ring-[#0071E3]/30`
                    : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                }`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden print:border-0 print:rounded-none print:shadow-none">
        {/* Print header (only visible when printing) */}
        <div className="hidden print:block px-4 py-3 border-b border-gray-300">
          <h1 className="text-lg font-bold text-gray-900">Хугацааны хяналтын тайлан</h1>
          <p className="text-xs text-gray-500">Хэвлэсэн: {localToday()} · Нийт {visibleItems.length} бараа</p>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50/80 text-[10px] font-bold uppercase tracking-widest text-gray-500 print:bg-gray-100">
              <tr>
                <th className="px-3 py-2.5 text-left">Бараа</th>
                <th className="px-3 py-2.5 text-left">Брэнд</th>
                <th className="px-3 py-2.5 text-left">Тайлбар</th>
                <th className="px-3 py-2.5 text-center">Дуусах огноо</th>
                <th className="px-3 py-2.5 text-center">Үлдсэн</th>
                <th className="px-3 py-2.5 text-right">Заал</th>
                <th className="px-3 py-2.5 text-right">Агуулах</th>
                <th className="px-3 py-2.5 text-right">Нийт</th>
                <th className="px-3 py-2.5 text-center">Статус</th>
                <th className="px-3 py-2.5 text-left">Хариуцлага</th>
                <th className="px-3 py-2.5 text-center print:hidden">Үйлдэл</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading && (
                <tr><td colSpan={11} className="py-12 text-center text-sm text-gray-400">
                  <Loader2 size={14} className="inline animate-spin mr-2"/> Ачааллаж байна...
                </td></tr>
              )}
              {!loading && visibleItems.length === 0 && (
                <tr><td colSpan={11} className="py-12 text-center text-sm text-gray-400">
                  Бүртгэл байхгүй. <button onClick={openAdd} className="text-[#0071E3] hover:underline">Шинэ нэмэх</button>
                </td></tr>
              )}
              {!loading && visibleItems.map(it => {
                const meta = STATUS_META[it.status] || STATUS_META.review;
                const isEditing = editId === it.id;
                return (
                  <tr key={it.id} className={`hover:bg-blue-50/20 transition-colors ${
                    it.is_expired ? "bg-red-50/30" : it.is_expiring_soon ? "bg-amber-50/20" : ""
                  }`}>
                    {/* Бараа */}
                    <td className="px-3 py-2.5 min-w-[180px]">
                      <div className="font-semibold text-gray-900 text-sm">{it.product_name}</div>
                      <div className="text-[10px] text-gray-400 font-mono">{it.product_code}</div>
                    </td>
                    {/* Брэнд */}
                    <td className="px-3 py-2.5 text-xs text-gray-600">{it.product_brand || "—"}</td>
                    {/* Тайлбар — бүтэн харагдана */}
                    <td className="px-3 py-2.5 text-xs text-gray-700 min-w-[180px] align-top">
                      {isEditing ? (
                        <textarea value={editNotes}
                          onChange={e => setEditNotes(e.target.value)}
                          rows={3} placeholder="Тэмдэглэл..."
                          className="w-full rounded-lg border border-blue-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300 resize-y"/>
                      ) : it.notes ? (
                        <span className="italic leading-snug whitespace-pre-wrap break-words">{it.notes}</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    {/* Дуусах огноо */}
                    <td className="px-3 py-2.5 text-center text-xs tabular-nums">{fmtDate(it.expiration_date)}</td>
                    {/* Үлдсэн */}
                    <td className={`px-3 py-2.5 text-center text-xs tabular-nums ${daysColor(it.days_left)}`}>
                      {daysLabel(it.days_left)}
                    </td>
                    {/* Заал */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-xs">
                      {isEditing ? (
                        <input type="number" min={0} value={editFloor}
                          onChange={e => setEditFloor(e.target.value)}
                          onWheel={e => e.currentTarget.blur()}
                          className="w-20 rounded-lg border border-blue-200 px-2 py-1 text-right text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"/>
                      ) : it.qty_floor}
                    </td>
                    {/* Агуулах */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-xs">
                      {isEditing ? (
                        <input type="number" min={0} value={editWarehouse}
                          onChange={e => setEditWarehouse(e.target.value)}
                          onWheel={e => e.currentTarget.blur()}
                          className="w-20 rounded-lg border border-blue-200 px-2 py-1 text-right text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"/>
                      ) : it.qty_warehouse}
                    </td>
                    {/* Нийт */}
                    <td className="px-3 py-2.5 text-right text-sm font-bold tabular-nums">
                      {it.qty_total}
                    </td>
                    {/* Статус */}
                    <td className="px-3 py-2.5 text-center">
                      <select value={it.status}
                        onChange={e => changeStatus(it, e.target.value)}
                        disabled={it.status === "archived"}
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold cursor-pointer disabled:cursor-not-allowed ${meta.color}`}>
                        <option value="review">Хянагдаж байна</option>
                        <option value="city_return">Хот буцаалт</option>
                        <option value="internal_sale">Дотоод хямдрал</option>
                        <option value="archived">Архив</option>
                      </select>
                    </td>
                    {/* Хариуцлага */}
                    <td className="px-3 py-2.5">
                      <button onClick={() => openLiability(it)}
                        className={`rounded-lg px-2 py-1 text-[10px] font-semibold border border-dashed border-transparent hover:border-gray-300 ${
                          LIABILITY_META[it.liability_type]?.color || "bg-gray-100 text-gray-500"
                        }`}>
                        <Users size={9} className="inline mr-0.5"/>
                        {liabilityShort(it)}
                      </button>
                      {it.liability_note && (
                        <div className="mt-0.5 text-[10px] text-gray-500 line-clamp-1 italic">{it.liability_note}</div>
                      )}
                    </td>
                    {/* Үйлдэл */}
                    <td className="px-3 py-2.5 text-center print:hidden">
                      <div className="flex justify-center gap-1">
                        {isEditing ? (
                          <>
                            <button onClick={() => saveEdit(it)}
                              className="rounded-lg bg-emerald-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-600">
                              <Check size={11}/>
                            </button>
                            <button onClick={() => setEditId(null)}
                              className="rounded-lg bg-gray-100 px-2 py-1 text-[10px] font-semibold text-gray-600 hover:bg-gray-200">
                              <X size={11}/>
                            </button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => startEdit(it)} title="Үлдэгдэл засах"
                              className="rounded-lg bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700 hover:bg-blue-100">
                              <Pencil size={11}/>
                            </button>
                            <button onClick={() => toggleArchive(it)}
                              title={it.status === "archived" ? "Архиваас гаргах" : "Архивлах"}
                              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                                it.status === "archived"
                                  ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                                  : "bg-violet-50 text-violet-700 hover:bg-violet-100"
                              }`}>
                              {it.status === "archived" ? <ArchiveRestore size={11}/> : <Archive size={11}/>}
                            </button>
                            <button onClick={() => setConfirmDel(it)} title="Устгах"
                              className="rounded-lg bg-red-50 px-2 py-1 text-[10px] font-semibold text-red-700 hover:bg-red-100">
                              <Trash2 size={11}/>
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add modal ────────────────────────────────────────────── */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setAddOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Timer size={16} className="text-rose-600"/> Шинэ бараа нэмэх
              </h2>
              <button onClick={() => setAddOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X size={16}/>
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              {/* Product picker */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-700 flex items-center gap-1">
                  <ScanLine size={11}/> Бараа (нэр/код/баркод)
                </label>
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"/>
                  <input ref={scanRef} value={pickerQuery}
                    onChange={e => { setPickerQuery(e.target.value); if (selectedProduct) setSelectedProduct(null); }}
                    placeholder="Бараа хайх эсвэл скан хийх..."
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 pl-9 pr-12 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15"/>
                  <button onClick={() => setScannerOpen(true)} type="button"
                    title="Камераар баркод скан хийх"
                    className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-8 items-center justify-center rounded-lg bg-[#0071E3] text-white hover:bg-blue-600 transition-colors shadow-sm">
                    <Camera size={14}/>
                  </button>
                </div>
                {pickerSearching && (
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-gray-400">
                    <Loader2 size={11} className="animate-spin"/> Хайж байна...
                  </div>
                )}
                {pickerHits.length > 0 && !selectedProduct && (
                  <div className="mt-1.5 max-h-48 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                    {pickerHits.map(p => (
                      <button key={p.id} onClick={() => selectProduct(p)}
                        className="flex w-full items-center justify-between border-b border-gray-50 px-3 py-2 text-left hover:bg-blue-50/40 last:border-0">
                        <div className="min-w-0">
                          <div className="font-medium text-sm text-gray-900 truncate">{p.name}</div>
                          <div className="text-[10px] text-gray-400 font-mono">{p.item_code}{p.barcode ? ` · ${p.barcode}` : ""}</div>
                        </div>
                        <span className="ml-2 shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600">{p.brand || "—"}</span>
                      </button>
                    ))}
                  </div>
                )}
                {selectedProduct && (
                  <div className="mt-2 flex items-center justify-between rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium text-sm text-emerald-900 truncate">{selectedProduct.name}</div>
                      <div className="text-[10px] text-emerald-700 font-mono">{selectedProduct.item_code} · {selectedProduct.brand}</div>
                    </div>
                    <button onClick={() => { setSelectedProduct(null); setPickerQuery(""); }}
                      className="rounded p-1 text-emerald-600 hover:bg-emerald-100">
                      <X size={13}/>
                    </button>
                  </div>
                )}
              </div>

              {/* Date + qty */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label className="mb-1.5 block text-xs font-semibold text-gray-700 flex items-center gap-1">
                    <CalendarIcon size={11}/> Дуусах огноо
                  </label>
                  <input type="date" value={addExpDate} onChange={e => setAddExpDate(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15"/>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-gray-700">Заал (ш)</label>
                  <input type="number" min={0} value={addQtyFloor}
                    onChange={e => setAddQtyFloor(e.target.value)}
                    onWheel={e => e.currentTarget.blur()}
                    placeholder="0"
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm tabular-nums focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15"/>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-gray-700">Агуулах (ш)</label>
                  <input type="number" min={0} value={addQtyWarehouse}
                    onChange={e => setAddQtyWarehouse(e.target.value)}
                    onWheel={e => e.currentTarget.blur()}
                    placeholder="0"
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm tabular-nums focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15"/>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-700">Тэмдэглэл (заавал биш)</label>
                <textarea value={addNotes} onChange={e => setAddNotes(e.target.value)} rows={2}
                  placeholder="Жишээ нь: 5 цуглуурын партиар оруулсан..."
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15 resize-none"/>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
              <button onClick={() => setAddOpen(false)}
                className="rounded-xl px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">
                Болих
              </button>
              <button onClick={submitAdd} disabled={adding || !selectedProduct || !addExpDate}
                className="flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 disabled:bg-gray-200 disabled:text-gray-400">
                {adding ? <Loader2 size={13} className="animate-spin"/> : <Plus size={13}/>}
                {adding ? "Хадгалж байна..." : "Нэмэх"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Liability modal ─────────────────────────────────────── */}
      {liabFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setLiabFor(null)}>
          <div className="w-full max-w-xl rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <Users size={16} className="text-orange-600"/> Хариуцлага оноох
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">{liabFor.product_name} · {liabFor.qty_total}ш үлдсэн</p>
              </div>
              <button onClick={() => setLiabFor(null)} className="text-gray-400 hover:text-gray-600">
                <X size={16}/>
              </button>
            </div>
            <div className="space-y-4 px-5 py-4 max-h-[60vh] overflow-y-auto">
              {/* Type radio */}
              <div className="flex flex-wrap gap-2">
                {(["none", "specific", "all_staff"] as const).map(t => (
                  <button key={t} onClick={() => setLiabType(t)}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-all ${
                      liabType === t
                        ? `${LIABILITY_META[t].color} border-current ring-2 ring-offset-1 ring-[#0071E3]/30`
                        : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                    }`}>
                    {LIABILITY_META[t].label}
                  </button>
                ))}
              </div>

              {liabType === "specific" && (
                <>
                  {/* Roles checkboxes */}
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-gray-700">Албан тушаалаар</label>
                    <div className="flex flex-wrap gap-1.5">
                      {roles.map(r => {
                        const checked = liabRoleIds.has(r.value);
                        return (
                          <button key={r.value}
                            onClick={() => setLiabRoleIds(prev => {
                              const s = new Set(prev); checked ? s.delete(r.value) : s.add(r.value); return s;
                            })}
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all ${
                              checked
                                ? "bg-orange-100 text-orange-800 border-orange-300"
                                : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                            }`}>
                            {checked && <Check size={9} className="inline mr-0.5"/>}
                            {r.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {/* Users checkboxes */}
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-gray-700">Тодорхой ажилтан</label>
                    <div className="max-h-40 overflow-y-auto rounded-xl border border-gray-200 bg-gray-50 p-2">
                      <div className="flex flex-wrap gap-1.5">
                        {users.map(u => {
                          const checked = liabUserIds.has(u.id);
                          return (
                            <button key={u.id}
                              onClick={() => setLiabUserIds(prev => {
                                const s = new Set(prev); checked ? s.delete(u.id) : s.add(u.id); return s;
                              })}
                              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-all ${
                                checked
                                  ? "bg-orange-100 text-orange-800 border-orange-300"
                                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                              }`}>
                              {checked && <Check size={9} className="inline mr-0.5"/>}
                              {u.nickname || u.username}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Note */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-700">Тайлбар (хэлбэр, хувь гэх мэт)</label>
                <textarea value={liabNote} onChange={e => setLiabNote(e.target.value)} rows={2}
                  placeholder="Жишээ нь: Цалингаас 50% (тус бүр)..."
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15 resize-none"/>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
              <button onClick={() => setLiabFor(null)} className="rounded-xl px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">
                Болих
              </button>
              <button onClick={saveLiability} disabled={liabSaving}
                className="flex items-center gap-1.5 rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50">
                {liabSaving ? <Loader2 size={13} className="animate-spin"/> : <Check size={13}/>}
                Хадгалах
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm ──────────────────────────────────────── */}
      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDel(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100">
                <Trash2 size={18} className="text-red-600"/>
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-900">Устгах уу?</h3>
                <p className="text-xs text-gray-500 mt-0.5">{confirmDel.product_name} — буцаах боломжгүй</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDel(null)} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                Болих
              </button>
              <button onClick={doDelete} className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600">
                Устгах
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Barcode scanner overlay ─────────────────────────────── */}
      {scannerOpen && (
        <BarcodeScanner
          onClose={() => setScannerOpen(false)}
          onDetected={async (code) => {
            setScannerOpen(false);
            const clean = (code || "").trim();
            if (!clean) return;
            setPickerQuery(clean);
            // Auto-search ба нэг л үр дүн байвал шууд сонгох
            try {
              const r = await api.get("/expiration/lookup/products", { params: { q: clean } });
              const hits: ProductHit[] = r.data;
              if (hits.length === 1) {
                selectProduct(hits[0]);
                notify(`Бараа олдлоо: ${hits[0].name}`);
              } else if (hits.length > 1) {
                // Барадоктой exact match эхэнд байх ёстой — серверээс ингэж буцаадаг
                const exact = hits.find(h => h.barcode === clean);
                if (exact) {
                  selectProduct(exact);
                  notify(`Бараа олдлоо: ${exact.name}`);
                } else {
                  setPickerHits(hits);
                  notify(`${hits.length} бараа олдлоо — сонгоно уу`);
                }
              } else {
                setPickerHits([]);
                notify(`'${clean}' баркодтой бараа олдсонгүй`, false);
              }
            } catch {
              notify("Хайхад алдаа гарлаа", false);
            }
          }}
        />
      )}

      {/* ── Print styles (A4 landscape) ─────────────────────────── */}
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          body { background: white !important; }
        }
      `}</style>
    </div>
  );
}

function StatCard({ label, value, sub, icon, tone }: {
  label: string; value: number; sub: string; icon: React.ReactNode;
  tone: "blue" | "amber" | "red" | "gray";
}) {
  const tones = {
    blue:  { bg: "bg-blue-50", iconBg: "bg-blue-100 text-blue-600", text: "text-blue-700" },
    amber: { bg: "bg-amber-50", iconBg: "bg-amber-100 text-amber-600", text: "text-amber-700" },
    red:   { bg: "bg-red-50", iconBg: "bg-red-100 text-red-600", text: "text-red-700" },
    gray:  { bg: "bg-gray-50", iconBg: "bg-gray-100 text-gray-500", text: "text-gray-700" },
  };
  const t = tones[tone];
  return (
    <div className={`flex items-center gap-3 rounded-2xl ${t.bg} border border-white/80 px-4 py-3 shadow-sm`}>
      <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${t.iconBg}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
        <p className={`text-xl font-bold tabular-nums leading-tight ${t.text}`}>
          {value} <span className="text-[11px] font-medium text-gray-400">{sub}</span>
        </p>
      </div>
    </div>
  );
}
