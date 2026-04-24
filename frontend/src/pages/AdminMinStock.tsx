import { useEffect, useState } from "react";
import { Plus, Trash2, Save, X, Loader2, AlertCircle, CheckCheck, List, Search, Package } from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";

type MatchedProduct = {
  id: number;
  item_code: string;
  name: string;
  brand: string;
  warehouse_name: string;
  price_tag: string;
  stock_pcs: number;
  stock_box: number;
  stock_extra_pcs: number;
  pack_ratio: number;
  needs_reorder: boolean;
};

type MatchedProductsData = {
  rule_id: number;
  min_qty_box: number;
  total: number;
  needs_reorder_count: number;
  products: MatchedProduct[];
};

type MinStockRule = {
  id: number;
  name: string;
  product_id: number | null;
  product: { id: number; item_code: string; name: string; brand: string; pack_ratio: number } | null;
  location_tags: string[];
  price_tags: string[];
  min_qty_box: number;
  is_active: boolean;
  priority: number;
  matched_count: number | null;
};

type SearchProduct = {
  id: number;
  item_code: string;
  name: string;
  brand: string;
  warehouse_name: string;
  pack_ratio: number;
};

type TagList = {
  location_tags: string[];
  price_tags: string[];
};

const EMPTY_FORM = {
  name: "",
  location_tags: [] as string[],
  price_tags: [] as string[],
  min_qty_box: 0,
  is_active: true,
  priority: 0,
};

export default function AdminMinStock() {
  const { role } = useAuthStore();
  const canEdit = role === "admin";

  const [rules, setRules] = useState<MinStockRule[]>([]);
  const [tagList, setTagList] = useState<TagList>({ location_tags: [], price_tags: [] });
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<MinStockRule | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Product-based rule modal
  const [showProductModal, setShowProductModal] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState<SearchProduct[]>([]);
  const [productMinInputs, setProductMinInputs] = useState<Record<number, number>>({});
  const [productSearching, setProductSearching] = useState(false);
  const [productBulkSaving, setProductBulkSaving] = useState(false);

  // Matched-products modal state
  const [matchedFor, setMatchedFor] = useState<MinStockRule | null>(null);
  const [matched, setMatched] = useState<MatchedProductsData | null>(null);
  const [matchedLoading, setMatchedLoading] = useState(false);
  const [matchedFilter, setMatchedFilter] = useState<"all" | "reorder">("all");
  const [matchedSearch, setMatchedSearch] = useState("");
  const [matchedBrand, setMatchedBrand] = useState("");
  const [matchedWarehouse, setMatchedWarehouse] = useState("");
  const [matchedSort, setMatchedSort] = useState<"default" | "stock_asc" | "stock_desc" | "name">("default");

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [rRules, rTags] = await Promise.all([
        api.get("/admin/min-stock-rules"),
        api.get("/admin/tags"),
      ]);
      setRules(rRules.data);
      setTagList(rTags.data);
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Ачаалахад алдаа гарлаа", false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (r: MinStockRule) => {
    setEditing(r);
    setForm({
      name: r.name,
      location_tags: [...r.location_tags],
      price_tags: [...r.price_tags],
      min_qty_box: r.min_qty_box,
      is_active: r.is_active,
      priority: r.priority,
    });
    setShowForm(true);
  };

  const save = async () => {
    if (form.location_tags.length === 0 && form.price_tags.length === 0) {
      flash("Дор хаяж нэг tag сонгоно уу", false);
      return;
    }
    if (form.min_qty_box < 0) {
      flash("Доод үлдэгдэл 0-ээс багагүй байна", false);
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/admin/min-stock-rules/${editing.id}`, form);
        flash("Шинэчлэгдлээ");
      } else {
        await api.post("/admin/min-stock-rules", form);
        flash("Үүсгэгдлээ");
      }
      setShowForm(false);
      await load();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: MinStockRule) => {
    if (!confirm(`"${r.name || "Нэргүй дүрэм"}" устгахдаа итгэлтэй байна уу?`)) return;
    try {
      await api.delete(`/admin/min-stock-rules/${r.id}`);
      flash("Устгагдлаа");
      await load();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Устгахад алдаа", false);
    }
  };

  // Debounced product search
  useEffect(() => {
    if (!showProductModal) return;
    const term = productSearch.trim();
    if (term.length < 2) {
      setProductResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setProductSearching(true);
      try {
        const r = await api.get("/products/search", { params: { q: term } });
        setProductResults(r.data);
      } catch {
        setProductResults([]);
      } finally {
        setProductSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [productSearch, showProductModal]);

  const openProductModal = () => {
    setShowProductModal(true);
    setProductSearch("");
    setProductResults([]);
    setProductMinInputs({});
  };

  const saveBulkProducts = async () => {
    const items = Object.entries(productMinInputs)
      .filter(([, v]) => v > 0)
      .map(([pid, v]) => ({ product_id: parseInt(pid), min_qty_box: v }));
    if (items.length === 0) {
      flash("Ядаж нэг бараанд min тоо оруулна уу", false);
      return;
    }
    setProductBulkSaving(true);
    try {
      const res = await api.post("/admin/min-stock-rules/bulk-products", { items });
      flash(`${res.data.created ?? 0} шинэ + ${res.data.updated ?? 0} шинэчилсэн`);
      setShowProductModal(false);
      await load();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа", false);
    } finally {
      setProductBulkSaving(false);
    }
  };

  const openMatched = async (r: MinStockRule) => {
    setMatchedFor(r);
    setMatched(null);
    setMatchedFilter("all");
    setMatchedSearch("");
    setMatchedBrand("");
    setMatchedWarehouse("");
    setMatchedSort("default");
    setMatchedLoading(true);
    try {
      const res = await api.get(`/admin/min-stock-rules/${r.id}/products`);
      setMatched(res.data);
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Ачаалахад алдаа", false);
      setMatchedFor(null);
    } finally {
      setMatchedLoading(false);
    }
  };

  const toggleTag = (type: "location_tags" | "price_tags", tag: string) => {
    setForm(prev => {
      const current = prev[type];
      const has = current.includes(tag);
      return {
        ...prev,
        [type]: has ? current.filter(t => t !== tag) : [...current, tag],
      };
    });
  };

  return (
    <div className="mx-auto max-w-5xl px-1 py-2 sm:px-4 sm:py-6 overflow-x-hidden">
      <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">Доод үлдэгдлийн дүрэм</h1>
          <p className="mt-1 text-xs text-gray-400">
            Tag хосломолоор барааны доод үлдэгдлийг тохируулна.
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <button
              onClick={openProductModal}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#0071E3] bg-white px-3 text-sm font-semibold text-[#0071E3] hover:bg-blue-50 active:bg-blue-100 sm:flex-initial sm:h-10 sm:px-4"
            >
              <Package size={14}/>
              <span className="hidden sm:inline">Бараагаар нэмэх</span>
              <span className="sm:hidden">Бараагаар</span>
            </button>
            <button
              onClick={openCreate}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#0071E3] px-3 text-sm font-semibold text-white shadow-sm hover:bg-[#005BB5] active:bg-[#004aad] sm:flex-initial sm:h-10 sm:px-4"
            >
              <Plus size={14}/>
              <span className="hidden sm:inline">Tag дүрэм нэмэх</span>
              <span className="sm:hidden">Tag дүрэм</span>
            </button>
          </div>
        )}
      </div>

      {msg && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>
          {msg.ok ? <CheckCheck size={14}/> : <AlertCircle size={14}/>}
          {msg.text}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin"/>
          </div>
        ) : rules.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">
            Дүрэм байхгүй байна. "Дүрэм нэмэх" товчийг дарж эхлүүлнэ үү.
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-4 py-2.5">Нэр</th>
                <th className="px-4 py-2.5">Байршил tag</th>
                <th className="px-4 py-2.5">Үнэ tag</th>
                <th className="px-4 py-2.5 text-right">Min хайрцаг</th>
                <th className="px-4 py-2.5 text-right">Тохирсон бараа</th>
                <th className="px-4 py-2.5 text-center">Идэвх</th>
                {canEdit && <th className="px-4 py-2.5 text-right">Үйлдэл</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rules.map(r => (
                <tr key={r.id} className={!r.is_active ? "opacity-50" : ""}>
                  <td className="px-4 py-3 text-xs font-medium text-gray-800">
                    {r.product ? (
                      <div>
                        <div className="font-semibold text-gray-800">{r.product.name}</div>
                        <div className="font-mono text-[10px] text-gray-400">{r.product.item_code}</div>
                      </div>
                    ) : (
                      r.name || <span className="italic text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {r.product ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-medium text-purple-700">
                        <Package size={9}/>
                        Бараагаар
                      </span>
                    ) : r.location_tags.length === 0 ? (
                      <span className="text-xs text-gray-300">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {r.location_tags.map(t => (
                          <span key={t} className="inline-flex rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {r.product ? (
                      <span className="text-[11px] text-gray-400">{r.product.brand}</span>
                    ) : r.price_tags.length === 0 ? (
                      <span className="text-xs text-gray-300">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {r.price_tags.map(t => (
                          <span key={t} className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs font-semibold tabular-nums text-gray-800">{r.min_qty_box}</td>
                  <td className="px-4 py-3 text-right">
                    {r.product ? (
                      <span className="text-xs tabular-nums text-gray-500">1</span>
                    ) : (
                      <button
                        onClick={() => openMatched(r)}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 hover:underline"
                        title="Тохирсон барааг харах"
                      >
                        <List size={11}/>
                        {r.matched_count ?? "—"}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${r.is_active ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                      {r.is_active ? "Идэвхтэй" : "Идэвхгүй"}
                    </span>
                  </td>
                  {canEdit && (
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => openEdit(r)}
                          className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
                        >
                          Засах
                        </button>
                        <button
                          onClick={() => remove(r)}
                          className="rounded-lg border border-red-200 bg-red-50 p-1.5 text-red-600 hover:bg-red-100"
                          title="Устгах"
                        >
                          <Trash2 size={13}/>
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Form modal */}
      {showForm && canEdit && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => setShowForm(false)}>
          <div
            className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
            onClick={e => e.stopPropagation()}
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            {/* Grabber */}
            <div className="flex justify-center py-2 sm:hidden">
              <div className="h-1 w-10 rounded-full bg-gray-300"/>
            </div>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 sm:px-6 sm:py-4">
              <h2 className="text-base font-semibold text-gray-900">
                {editing ? "Дүрэм засах" : "Шинэ дүрэм"}
              </h2>
              <button onClick={() => setShowForm(false)} className="grid h-9 w-9 place-items-center rounded-lg text-gray-400 hover:bg-gray-100">
                <X size={18}/>
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 sm:px-6">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600">Нэр (заавал биш)</label>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Жишээ: Сүү бөөн"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-base outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 sm:text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-600">
                  Байршил tag ({form.location_tags.length})
                </label>
                <p className="mb-2 text-[10px] text-gray-400">Сонгогдсон бүх tag-ыг барааны warehouse_name агуулсан байх ёстой.</p>
                <div className="flex flex-wrap gap-1.5">
                  {tagList.location_tags.length === 0 && (
                    <span className="text-xs italic text-gray-400">Байршил tag байхгүй. Master оруулсны дараа харагдана.</span>
                  )}
                  {tagList.location_tags.map(t => {
                    const active = form.location_tags.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => toggleTag("location_tags", t)}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${active
                          ? "border-sky-300 bg-sky-100 text-sky-800"
                          : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-600">
                  Үнэ tag ({form.price_tags.length})
                </label>
                <p className="mb-2 text-[10px] text-gray-400">Сонгогдсон бүх tag-ыг барааны price_tag агуулсан байх ёстой.</p>
                <div className="flex flex-wrap gap-1.5">
                  {tagList.price_tags.length === 0 && (
                    <span className="text-xs italic text-gray-400">Үнэ tag байхгүй. Master оруулсны дараа харагдана.</span>
                  )}
                  {tagList.price_tags.map(t => {
                    const active = form.price_tags.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => toggleTag("price_tags", t)}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${active
                          ? "border-amber-300 bg-amber-100 text-amber-800"
                          : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600">Min хайрцаг</label>
                  <input
                    type="number" min={0} step={1}
                    value={form.min_qty_box === 0 ? "" : form.min_qty_box}
                    placeholder="0"
                    onWheel={e => e.currentTarget.blur()}
                    onChange={e => {
                      const v = e.target.value;
                      setForm({ ...form, min_qty_box: v === "" ? 0 : (parseFloat(v) || 0) });
                    }}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-base outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 sm:text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600">Priority (tie-break)</label>
                  <input
                    type="number" step={1}
                    value={form.priority === 0 ? "" : form.priority}
                    placeholder="0"
                    onWheel={e => e.currentTarget.blur()}
                    onChange={e => {
                      const v = e.target.value;
                      setForm({ ...form, priority: v === "" ? 0 : (parseInt(v) || 0) });
                    }}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-base outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 sm:text-sm"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={e => setForm({ ...form, is_active: e.target.checked })}
                  className="h-4 w-4 rounded border-gray-300 text-[#0071E3] accent-[#0071E3]"
                />
                Идэвхтэй
              </label>
            </div>

            <div className="flex flex-col-reverse items-stretch gap-2 border-t border-gray-100 px-5 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-6">
              <button
                onClick={() => setShowForm(false)}
                className="h-11 rounded-lg border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 active:bg-gray-100"
              >
                Болих
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[#0071E3] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[#005BB5] active:bg-[#004aad] disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin"/> : <Save size={14}/>}
                Хадгалах
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Matched products modal */}
      {matchedFor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => setMatchedFor(null)}>
          <div
            className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
            onClick={e => e.stopPropagation()}
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="flex justify-center py-2 sm:hidden">
              <div className="h-1 w-10 rounded-full bg-gray-300"/>
            </div>
            <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-6 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-gray-900">
                  Тохирсон бараанууд
                  {matchedFor.name && <span className="ml-2 text-sm font-normal text-gray-500">— {matchedFor.name}</span>}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  {matchedFor.location_tags.map(t => (
                    <span key={t} className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">{t}</span>
                  ))}
                  {matchedFor.price_tags.map(t => (
                    <span key={t} className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">{t}</span>
                  ))}
                  <span className="text-gray-400">· Min {matchedFor.min_qty_box} хайрцаг</span>
                </div>
              </div>
              <button onClick={() => setMatchedFor(null)} className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
                <X size={16}/>
              </button>
            </div>

            {/* Toolbar */}
            {(() => {
              const brands = matched ? Array.from(new Set(matched.products.map(p => p.brand).filter(Boolean))).sort() : [];
              const warehouses = matched
                ? Array.from(new Set(matched.products.flatMap(p => p.warehouse_name.split(",").map(s => s.trim()).filter(Boolean)))).sort()
                : [];
              return (
                <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50/60 px-6 py-3">
                  <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm">
                    <button
                      onClick={() => setMatchedFilter("all")}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${matchedFilter === "all" ? "bg-[#0071E3] text-white" : "text-gray-600 hover:bg-gray-50"}`}
                    >
                      Бүгд {matched && `(${matched.total})`}
                    </button>
                    <button
                      onClick={() => setMatchedFilter("reorder")}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${matchedFilter === "reorder" ? "bg-red-600 text-white" : "text-red-600 hover:bg-red-50"}`}
                    >
                      Захиалах {matched && `(${matched.needs_reorder_count})`}
                    </button>
                  </div>

                  <select
                    value={matchedBrand}
                    onChange={e => setMatchedBrand(e.target.value)}
                    className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                  >
                    <option value="">Бренд: бүгд ({brands.length})</option>
                    {brands.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>

                  {warehouses.length > 1 && (
                    <select
                      value={matchedWarehouse}
                      onChange={e => setMatchedWarehouse(e.target.value)}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                    >
                      <option value="">Байршил: бүгд</option>
                      {warehouses.map(w => <option key={w} value={w}>{w}</option>)}
                    </select>
                  )}

                  <select
                    value={matchedSort}
                    onChange={e => setMatchedSort(e.target.value as any)}
                    className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                  >
                    <option value="default">Эрэмбэ: үндсэн</option>
                    <option value="stock_asc">Үлдэгдэл ↑ (бага нь)</option>
                    <option value="stock_desc">Үлдэгдэл ↓ (их нь)</option>
                    <option value="name">Нэрээр</option>
                  </select>

                  <input
                    value={matchedSearch}
                    onChange={e => setMatchedSearch(e.target.value)}
                    placeholder="Код / нэр / бренд хайх..."
                    className="flex-1 min-w-[140px] rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                  />

                  {(matchedBrand || matchedWarehouse || matchedSearch || matchedSort !== "default" || matchedFilter !== "all") && (
                    <button
                      onClick={() => { setMatchedBrand(""); setMatchedWarehouse(""); setMatchedSearch(""); setMatchedSort("default"); setMatchedFilter("all"); }}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[11px] text-gray-600 hover:bg-gray-50"
                    >
                      Цэвэрлэх
                    </button>
                  )}
                </div>
              );
            })()}

            {/* Body */}
            <div className="flex-1 overflow-y-auto overflow-x-auto">
              {matchedLoading || !matched ? (
                <div className="flex items-center justify-center py-12 text-gray-400">
                  <Loader2 size={20} className="animate-spin"/>
                </div>
              ) : (() => {
                const s = matchedSearch.trim().toLowerCase();
                let rows = matched.products.filter(p => {
                  if (matchedFilter === "reorder" && !p.needs_reorder) return false;
                  if (matchedBrand && p.brand !== matchedBrand) return false;
                  if (matchedWarehouse) {
                    const whs = p.warehouse_name.split(",").map(t => t.trim());
                    if (!whs.includes(matchedWarehouse)) return false;
                  }
                  if (s) {
                    const hit = p.item_code.toLowerCase().includes(s) ||
                                p.name.toLowerCase().includes(s) ||
                                (p.brand || "").toLowerCase().includes(s);
                    if (!hit) return false;
                  }
                  return true;
                });
                // Sort
                if (matchedSort === "stock_asc") rows = [...rows].sort((a,b) => a.stock_box - b.stock_box || a.stock_pcs - b.stock_pcs);
                else if (matchedSort === "stock_desc") rows = [...rows].sort((a,b) => b.stock_box - a.stock_box || b.stock_pcs - a.stock_pcs);
                else if (matchedSort === "name") rows = [...rows].sort((a,b) => a.name.localeCompare(b.name));
                if (rows.length === 0) {
                  return (
                    <div className="py-12 text-center text-sm text-gray-400">
                      Бараа олдсонгүй
                    </div>
                  );
                }
                return (
                  <table className="w-full text-sm min-w-[640px]">
                    <thead className="sticky top-0 border-b border-gray-100 bg-white">
                      <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        <th className="px-4 py-2">Код</th>
                        <th className="px-4 py-2">Нэр</th>
                        <th className="px-4 py-2">Бренд</th>
                        <th className="px-4 py-2 text-right">Үлдэгдэл</th>
                        <th className="px-4 py-2 text-right">Хайрцаг / Min</th>
                        <th className="px-4 py-2 text-center">Төлөв</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {rows.map(p => (
                        <tr key={p.id} className={p.needs_reorder ? "bg-red-50/30" : ""}>
                          <td className="px-4 py-2 font-mono text-[11px] text-gray-500">{p.item_code}</td>
                          <td className="px-4 py-2 text-xs text-gray-800">{p.name}</td>
                          <td className="px-4 py-2 text-[11px] text-gray-500">{p.brand}</td>
                          <td className="px-4 py-2 text-right">
                            <div className={`text-base font-bold leading-tight tabular-nums ${p.needs_reorder ? "text-red-600" : "text-gray-800"}`}>
                              {p.stock_box}
                              <span className="ml-0.5 text-[10px] font-normal text-gray-400">хайрцаг</span>
                            </div>
                            <div className="text-[10px] tabular-nums text-gray-400">
                              үлдэгдэл {p.stock_pcs.toFixed(0)}ш{p.stock_extra_pcs > 0 ? ` (+${p.stock_extra_pcs}ш)` : ""}
                            </div>
                          </td>
                          <td className="px-4 py-2 text-right text-xs tabular-nums">
                            <span className={p.needs_reorder ? "font-bold text-red-600" : "font-semibold text-gray-700"}>
                              {p.stock_box}
                            </span>
                            <span className="text-gray-300"> / {matched?.min_qty_box ?? 0}</span>
                          </td>
                          <td className="px-4 py-2 text-center">
                            {p.needs_reorder ? (
                              <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                                Захиалах
                              </span>
                            ) : (
                              <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
                                Хангалттай
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              })()}
            </div>

            <div className="flex items-center justify-end border-t border-gray-100 px-6 py-3">
              <button
                onClick={() => setMatchedFor(null)}
                className="rounded-lg border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Хаах
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product-based rules modal (search + bulk create) */}
      {showProductModal && canEdit && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => setShowProductModal(false)}>
          <div
            className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
            onClick={e => e.stopPropagation()}
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="flex justify-center py-2 sm:hidden">
              <div className="h-1 w-10 rounded-full bg-gray-300"/>
            </div>
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Бараагаар доод үлдэгдэл тохируулах</h2>
                <p className="mt-0.5 text-xs text-gray-400">Нэрээр/кодоор хайж олоод, ард нь хайрцагны тоо оруулаад хадгална.</p>
              </div>
              <button onClick={() => setShowProductModal(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
                <X size={16}/>
              </button>
            </div>

            {/* Search */}
            <div className="border-b border-gray-100 bg-gray-50/60 px-6 py-3">
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm focus-within:border-[#0071E3] focus-within:ring-1 focus-within:ring-[#0071E3]/20">
                <Search size={14} className="text-gray-400"/>
                <input
                  autoFocus
                  value={productSearch}
                  onChange={e => setProductSearch(e.target.value)}
                  placeholder="Нэр эсвэл код хайх (дор хаяж 2 тэмдэгт)..."
                  className="flex-1 bg-transparent text-sm outline-none"
                />
                {productSearching && <Loader2 size={14} className="animate-spin text-gray-400"/>}
              </div>
              {Object.keys(productMinInputs).filter(k => productMinInputs[+k] > 0).length > 0 && (
                <div className="mt-2 text-[11px] text-[#0071E3]">
                  {Object.keys(productMinInputs).filter(k => productMinInputs[+k] > 0).length} бараа min-тэй — хадгалахад бэлэн
                </div>
              )}
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto px-4 py-2">
              {productSearch.trim().length < 2 ? (
                <div className="flex flex-col items-center gap-2 py-16 text-gray-400">
                  <Search size={24} className="text-gray-200"/>
                  <span className="text-sm">Бараа хайж эхлэнэ үү</span>
                  <span className="text-[11px] text-gray-300">Жишээ: "Хараа архи"</span>
                </div>
              ) : productResults.length === 0 && !productSearching ? (
                <div className="py-10 text-center text-sm text-gray-400">
                  Бараа олдсонгүй
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {productResults.map(p => (
                    <div key={p.id} className="flex items-center gap-3 px-2 py-2.5 hover:bg-gray-50">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-gray-800">{p.name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-400">
                          <span className="font-mono">{p.item_code}</span>
                          {p.brand && <span>· {p.brand}</span>}
                          {p.warehouse_name && <span>· {p.warehouse_name}</span>}
                          <span>· {p.pack_ratio}ш/хайрцаг</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number" min={0} step={1}
                          value={productMinInputs[p.id] === 0 || productMinInputs[p.id] === undefined ? "" : productMinInputs[p.id]}
                          placeholder="Min"
                          onWheel={e => e.currentTarget.blur()}
                          onChange={e => {
                            const v = e.target.value;
                            setProductMinInputs(prev => ({ ...prev, [p.id]: v === "" ? 0 : (parseFloat(v) || 0) }));
                          }}
                          className="w-24 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-right text-sm tabular-nums outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                        />
                        <span className="text-[10px] text-gray-400">хайрцаг</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-3">
              <button
                onClick={() => setShowProductModal(false)}
                className="rounded-lg border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Болих
              </button>
              <button
                onClick={saveBulkProducts}
                disabled={productBulkSaving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#0071E3] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#005BB5] disabled:opacity-50"
              >
                {productBulkSaving ? <Loader2 size={14} className="animate-spin"/> : <Save size={14}/>}
                Хадгалах
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
