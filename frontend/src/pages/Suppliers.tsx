import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Plus, Pencil, Check, X, Building2, Link2, Trash2, AlertCircle, RefreshCw } from "lucide-react";
import { api } from "../lib/api";

type Supplier = {
  id: number;
  name: string;
  phone: string;
  viber: string;
  email: string;
  notes: string;
  is_active: boolean;
};

type BrandMap = {
  brand: string;
  supplier_id: number | null;
  supplier_name: string | null;
};

const emptyForm = (): Omit<Supplier, "id"> => ({
  name: "",
  phone: "",
  viber: "",
  email: "",
  notes: "",
  is_active: true,
});

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [brandMap, setBrandMap] = useState<Record<string, number | null>>({});
  const [pendingMap, setPendingMap] = useState<Record<string, number | null>>({});
  const [savingMap, setSavingMap] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // ── Delete confirm modal ─────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3000);
  };

  const load = async () => {
    setLoadError(null);
    try {
      const [sRes, bRes, mRes] = await Promise.all([
        api.get("/suppliers"),
        api.get("/suppliers/all-brands"),
        api.get("/suppliers/brand-map"),
      ]);
      setSuppliers(sRes.data);
      setBrands(bRes.data);
      const mapRaw: BrandMap[] = mRes.data;
      const mapObj: Record<string, number | null> = {};
      for (const b of bRes.data as string[]) {
        const found = mapRaw.find((m) => m.brand === b);
        mapObj[b] = found?.supplier_id ?? null;
      }
      setBrandMap(mapObj);
      setPendingMap({ ...mapObj });
    } catch (e: any) {
      setLoadError(e?.response?.data?.detail ?? "Мэдээлэл ачаалахад алдаа гарлаа");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setShowModal(true);
  };

  const openEdit = (s: Supplier) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
      phone: s.phone,
      viber: s.viber,
      email: s.email,
      notes: s.notes,
      is_active: s.is_active,
    });
    setShowModal(true);
  };

  const submit = async () => {
    if (!form.name.trim()) {
      flash("Нийлүүлэгчийн нэр оруулна уу", false);
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/suppliers/${editingId}`, form);
        flash("Засварлагдлаа");
      } else {
        await api.post("/suppliers", form);
        flash("Нийлүүлэгч нэмэгдлээ");
      }
      setShowModal(false);
      await load();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setSaving(false);
    }
  };

  // ── Delete supplier ──────────────────────────────────────────────────────
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    setDeleteMsg(null);
    try {
      await api.delete(`/suppliers/${deleteTarget.id}`);
      setSuppliers((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      setDeleteTarget(null);
      flash("Нийлүүлэгч устгагдлаа");
    } catch (e: any) {
      setDeleteMsg(e?.response?.data?.detail ?? "Устгахад алдаа гарлаа");
    } finally {
      setDeleteLoading(false);
    }
  };

  // ── Brand map save ───────────────────────────────────────────────────────
  const saveBrandMap = async () => {
    setSavingMap(true);
    try {
      const promises: Promise<any>[] = [];
      for (const brand of brands) {
        const prev = brandMap[brand];
        const next = pendingMap[brand];
        if (prev !== next) {
          if (next) {
            promises.push(api.post("/suppliers/brand-map", { brand, supplier_id: next }));
          } else {
            promises.push(api.delete(`/suppliers/brand-map/${encodeURIComponent(brand)}`));
          }
        }
      }
      const results = await Promise.allSettled(promises);
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        flash(`${results.length - failed} хадгалагдлаа, ${failed} алдаатай`, false);
      } else {
        flash("Холбоос хадгалагдлаа");
      }
      await load();
    } catch {
      flash("Хадгалахад алдаа гарлаа", false);
    } finally {
      setSavingMap(false);
    }
  };

  const pendingChanged = brands.some((b) => pendingMap[b] !== brandMap[b]);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Нийлүүлэгчид</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Нийлүүлэгчийн мэдээлэл болон брэндийн холбоос
          </p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-apple bg-[#0071E3] px-4 py-2 text-sm text-white hover:opacity-90"
        >
          <Plus size={15} />
          Шинэ нийлүүлэгч
        </button>
      </div>

      {msg && (
        <div
          className={`mt-4 rounded-apple px-4 py-3 text-sm font-medium ${
            msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      {loadError && (
        <div className="mt-4 flex items-center gap-2 rounded-apple bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={14} />
          {loadError}
          <button onClick={load} className="ml-2 underline text-gray-600 hover:text-gray-900">
            Дахин оролдох
          </button>
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* ── Left: Supplier list ── */}
        <div className="lg:col-span-2">
          <div className="rounded-apple bg-white shadow-sm">
            <div className="border-b border-gray-100 px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <Building2 size={16} />
                Нийлүүлэгчид ({suppliers.length})
              </div>
            </div>
            {suppliers.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-gray-400">
                Нийлүүлэгч байхгүй байна
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {suppliers.map((s) => (
                  <div key={s.id} className="flex items-start justify-between px-5 py-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">{s.name}</span>
                        {!s.is_active && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                            Идэвхгүй
                          </span>
                        )}
                      </div>
                      {s.phone && (
                        <div className="mt-0.5 text-xs text-gray-500">📞 {s.phone}</div>
                      )}
                      {s.email && (
                        <div className="text-xs text-gray-500">✉️ {s.email}</div>
                      )}
                      {s.notes && (
                        <div className="mt-1 text-xs text-gray-400">{s.notes}</div>
                      )}
                    </div>
                    <div className="ml-3 flex items-center gap-1.5">
                      <button
                        onClick={() => openEdit(s)}
                        className="rounded-apple border border-gray-200 p-1.5 text-gray-400 hover:text-gray-700"
                        title="Засах"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => { setDeleteTarget({ id: s.id, name: s.name }); setDeleteMsg(null); }}
                        className="rounded-apple border border-red-200 bg-red-50 p-1.5 text-red-500 hover:bg-red-100"
                        title="Устгах"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: Brand mapping ── */}
        <div className="lg:col-span-3">
          <div className="rounded-apple bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <Link2 size={16} />
                Брэнд → Нийлүүлэгч холбоос
              </div>
              <button
                onClick={saveBrandMap}
                disabled={!pendingChanged || savingMap}
                className="inline-flex items-center gap-1.5 rounded-apple bg-[#0071E3] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
              >
                <Check size={13} />
                {savingMap ? "Хадгалж байна..." : "Хадгалах"}
              </button>
            </div>

            {brands.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-gray-400">
                Бараа байхгүй (эхлээд бараа файл оруулна уу)
              </div>
            ) : (
              <div className="max-h-[520px] overflow-auto divide-y divide-gray-100">
                {brands.map((brand) => (
                  <div
                    key={brand}
                    className="flex items-center justify-between px-5 py-3"
                  >
                    <span className="text-sm text-gray-800 font-medium">{brand}</span>
                    <select
                      value={pendingMap[brand] ?? ""}
                      onChange={(e) =>
                        setPendingMap((prev) => ({
                          ...prev,
                          [brand]: e.target.value ? Number(e.target.value) : null,
                        }))
                      }
                      className={`rounded-apple border px-3 py-1.5 text-sm outline-none focus:border-[#0071E3] ${
                        pendingMap[brand] !== brandMap[brand]
                          ? "border-amber-300 bg-amber-50"
                          : "border-gray-200"
                      }`}
                    >
                      <option value="">— Холбоогүй —</option>
                      {suppliers
                        .filter((s) => s.is_active)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Create/Edit Modal ── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-apple bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingId ? "Нийлүүлэгч засах" : "Шинэ нийлүүлэгч"}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {(
                [
                  { key: "name", label: "Нэр *", placeholder: "Нийлүүлэгчийн нэр" },
                  { key: "phone", label: "Утас", placeholder: "99001122" },
                  { key: "viber", label: "Viber", placeholder: "99001122" },
                  { key: "email", label: "И-мэйл", placeholder: "supplier@example.com" },
                ] as const
              ).map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="mb-1 block text-xs text-gray-500">{label}</label>
                  <input
                    value={form[key] as string}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
                  />
                </div>
              ))}

              <div>
                <label className="mb-1 block text-xs text-gray-500">Тэмдэглэл</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                  className="rounded"
                />
                Идэвхтэй
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Болих
              </button>
              <button
                onClick={submit}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-apple bg-[#0071E3] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving && <RefreshCw size={13} className="animate-spin" />}
                {saving ? "Хадгалж байна..." : "Хадгалах"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm modal ── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-sm rounded-apple bg-white p-6 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900">Нийлүүлэгч устгах</h2>
                <p className="text-sm text-gray-500">Энэ үйлдлийг буцаах боломжгүй.</p>
              </div>
            </div>
            <p className="mt-4 text-sm text-gray-700">
              <span className="font-semibold text-red-600">{deleteTarget.name}</span> нийлүүлэгчийг бүрмөсөн устгах уу?
            </p>
            {deleteMsg && (
              <div className="mt-3 flex items-center gap-1.5 text-sm font-medium text-red-500">
                <AlertCircle size={14} />
                {deleteMsg}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Болих
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleteLoading}
                className="inline-flex items-center gap-2 rounded-apple bg-red-600 px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {deleteLoading && <RefreshCw size={13} className="animate-spin" />}
                Устгах
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
