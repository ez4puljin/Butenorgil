import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Truck,
  Plus,
  Pencil,
  X,
  RefreshCw,
  Package,
  Trophy,
} from "lucide-react";
import { api } from "../lib/api";
import { useLogisticsStore, type Vehicle } from "../store/logisticsStore";

const emptyVehicle = (): Omit<Vehicle, "id"> => ({
  name: "",
  plate: "",
  capacity_kg: 5000,
  driver_name: "",
  driver_phone: "",
  is_active: true,
});

export default function Logistics() {
  const store = useLogisticsStore();

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Vehicle modal
  const [showVehicleModal, setShowVehicleModal] = useState(false);
  const [editingVehicleId, setEditingVehicleId] = useState<number | null>(null);
  const [vehicleForm, setVehicleForm] = useState(emptyVehicle());

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const vRes = await api.get("/logistics/vehicles");
      store.setVehicles(vRes.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // ── Vehicle modal ────────────────────────────────────────────────────────────

  const openCreateVehicle = () => {
    setEditingVehicleId(null);
    setVehicleForm(emptyVehicle());
    setShowVehicleModal(true);
  };

  const openEditVehicle = (v: Vehicle) => {
    setEditingVehicleId(v.id);
    setVehicleForm({
      name: v.name,
      plate: v.plate,
      capacity_kg: v.capacity_kg,
      driver_name: v.driver_name,
      driver_phone: v.driver_phone,
      is_active: v.is_active,
    });
    setShowVehicleModal(true);
  };

  const submitVehicle = async () => {
    if (!vehicleForm.name.trim()) {
      flash("Машины нэр оруулна уу", false);
      return;
    }
    try {
      if (editingVehicleId) {
        await api.put(`/logistics/vehicles/${editingVehicleId}`, vehicleForm);
        flash("Машин шинэчлэгдлээ");
      } else {
        await api.post("/logistics/vehicles", vehicleForm);
        flash("Машин нэмэгдлээ");
      }
      setShowVehicleModal(false);
      await load();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  };

  const deleteVehicle = async (id: number) => {
    if (!confirm("Машин устгах уу?")) return;
    try {
      await api.delete(`/logistics/vehicles/${id}`);
      await load();
    } catch {
      flash("Устгахад алдаа гарлаа", false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Логистик</h1>
          <p className="mt-0.5 text-sm text-gray-500">Машины парк ба ачааны хуваарилалт</p>
        </div>
        <button
          onClick={openCreateVehicle}
          className="inline-flex items-center gap-2 rounded-apple bg-[#0071E3] px-4 py-2 text-sm text-white hover:opacity-90"
        >
          <Plus size={15} />
          Шинэ машин
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

      {/* Vehicle fleet */}
      {store.vehicles.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-3">
          {store.vehicles.map((v) => (
            <div
              key={v.id}
              className={`flex items-center gap-3 rounded-apple border px-4 py-3 shadow-sm ${
                v.is_active ? "bg-white border-gray-200" : "bg-gray-50 border-gray-100 opacity-60"
              }`}
            >
              <Truck size={18} className="text-gray-400" />
              <div>
                <div className="text-sm font-semibold text-gray-900">
                  {v.name}
                  {v.plate && (
                    <span className="ml-2 text-xs font-normal text-gray-400">{v.plate}</span>
                  )}
                </div>
                <div className="text-xs text-gray-500">
                  {v.driver_name || "Жолооч байхгүй"}
                </div>
              </div>
              <button
                onClick={() => openEditVehicle(v)}
                className="ml-1 rounded p-1 text-gray-400 hover:text-gray-700"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => deleteVehicle(v.id)}
                className="rounded p-1 text-gray-300 hover:text-red-500"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Машины Top List */}
      <div className="mt-5">
        <div className="rounded-apple bg-white shadow-sm">
          <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-2">
            <Trophy size={16} className="text-amber-500" />
            <div className="text-sm font-semibold text-gray-900">Машины Top List</div>
          </div>

          {loading ? (
            <div className="px-4 py-8 text-center">
              <RefreshCw size={18} className="mx-auto animate-spin text-gray-400" />
              <p className="mt-2 text-xs text-gray-400">Уншиж байна...</p>
            </div>
          ) : store.vehicles.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Package size={28} className="mx-auto mb-2 opacity-40 text-gray-400" />
              <p className="text-sm text-gray-400">Машин байхгүй байна</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-4 py-3 font-medium w-12">#</th>
                    <th className="px-4 py-3 font-medium">Машин</th>
                    <th className="px-4 py-3 font-medium">Улсын дугаар</th>
                    <th className="px-4 py-3 font-medium">Жолооч</th>
                    <th className="px-4 py-3 font-medium text-right">Нийт удаа</th>
                    <th className="px-4 py-3 font-medium text-right">Нийт тонн</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {store.vehicles.map((v, idx) => {
                    const rank = v.rank ?? idx + 1;
                    const medalColor =
                      rank === 1
                        ? "bg-amber-100 text-amber-700"
                        : rank === 2
                        ? "bg-gray-100 text-gray-600"
                        : rank === 3
                        ? "bg-orange-100 text-orange-700"
                        : "bg-gray-50 text-gray-500";
                    return (
                      <tr key={v.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${medalColor}`}
                          >
                            {rank}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-semibold text-gray-900">{v.name}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-500">{v.plate || "—"}</td>
                        <td className="px-4 py-3 text-gray-500">{v.driver_name || "—"}</td>
                        <td className="px-4 py-3 text-right">
                          <span className="font-semibold text-gray-900">
                            {v.trip_count ?? 0}
                          </span>
                          <span className="ml-1 text-xs text-gray-400">удаа</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="font-semibold text-gray-900">
                            {(v.total_weight_ton ?? 0).toFixed(2)}
                          </span>
                          <span className="ml-1 text-xs text-gray-400">тн</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Vehicle Modal */}
      {showVehicleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-apple bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingVehicleId ? "Машин засах" : "Шинэ машин"}
              </h2>
              <button
                onClick={() => setShowVehicleModal(false)}
                className="text-gray-400 hover:text-gray-700"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {(
                [
                  { key: "name", label: "Нэр *", placeholder: "ж: Хиаб 1" },
                  { key: "plate", label: "Улсын дугаар", placeholder: "1234УБА" },
                  { key: "driver_name", label: "Жолооч", placeholder: "Нэр" },
                  { key: "driver_phone", label: "Жолоочийн утас", placeholder: "99001122" },
                ] as const
              ).map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="mb-1 block text-xs text-gray-500">{label}</label>
                  <input
                    value={vehicleForm[key] as string}
                    onChange={(e) => setVehicleForm((f) => ({ ...f, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
                  />
                </div>
              ))}

              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={vehicleForm.is_active}
                  onChange={(e) =>
                    setVehicleForm((f) => ({ ...f, is_active: e.target.checked }))
                  }
                  className="rounded"
                />
                Идэвхтэй
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowVehicleModal(false)}
                className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Болих
              </button>
              <button
                onClick={submitVehicle}
                className="rounded-apple bg-[#0071E3] px-4 py-2 text-sm text-white hover:opacity-90"
              >
                Хадгалах
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
