import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";

type U = { id: number; username: string; role: string; is_active: boolean; tag_ids: number[] };

export default function OrderManager() {
  const [users, setUsers] = useState<U[]>([]);
  const [form, setForm] = useState({ username: "", password: "", role: "manager", tagIds: "1" });

  const load = async () => {
    const res = await api.get("/admin/users");
    setUsers(res.data);
  };

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    const payload = {
      username: form.username,
      password: form.password,
      role: form.role,
      tag_ids: form.tagIds
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((x) => !Number.isNaN(x)),
    };
    await api.post("/admin/users", payload);
    setForm({ username: "", password: "", role: "manager", tagIds: "1" });
    await load();
  };

  const toggle = async (id: number) => {
    await api.post(`/admin/users/${id}/toggle`);
    await load();
  };

  const roleLabel = (role: string) => {
    if (role === "admin") return "Админ";
    if (role === "supervisor") return "Хянагч";
    if (role === "manager") return "Менежер";
    return role;
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="text-2xl font-semibold text-gray-900">Удирдлагын хэсэг</div>
      <div className="mt-1 text-sm text-gray-500">Хэрэглэгч болон агуулахын эрхийн тохиргоо</div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-6">
          <div className="text-lg font-semibold text-gray-900">Шинэ хэрэглэгч</div>
          <div className="mt-4 space-y-3">
            <input
              className="w-full rounded-apple border border-gray-200 px-4 py-3 outline-none focus:border-[#0071E3]"
              placeholder="Хэрэглэгчийн нэр"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <input
              className="w-full rounded-apple border border-gray-200 px-4 py-3 outline-none focus:border-[#0071E3]"
              placeholder="Нууц үг"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <select
              className="w-full rounded-apple border border-gray-200 px-4 py-3 outline-none focus:border-[#0071E3]"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              <option value="manager">Менежер</option>
              <option value="supervisor">Хянагч</option>
              <option value="admin">Админ</option>
            </select>
            <input
              className="w-full rounded-apple border border-gray-200 px-4 py-3 outline-none focus:border-[#0071E3]"
              placeholder="Агуулахын дугаарууд (ж: 1,2,12)"
              value={form.tagIds}
              onChange={(e) => setForm({ ...form, tagIds: e.target.value })}
            />
            <Button onClick={create}>Үүсгэх</Button>
          </div>
        </Card>

        <Card className="p-6">
          <div className="text-lg font-semibold text-gray-900">Хэрэглэгчид</div>
          <div className="mt-3 max-h-[520px] overflow-auto rounded-apple border border-gray-100">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white shadow-sm">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3">Нэр</th>
                  <th className="px-4 py-3">Эрх</th>
                  <th className="px-4 py-3">Агуулах</th>
                  <th className="px-4 py-3">Төлөв</th>
                  <th className="px-4 py-3">Үйлдэл</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3">{u.username}</td>
                    <td className="px-4 py-3">{roleLabel(u.role)}</td>
                    <td className="px-4 py-3">{u.tag_ids.join(",")}</td>
                    <td className="px-4 py-3">{u.is_active ? "Идэвхтэй" : "Идэвхгүй"}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => toggle(u.id)} className="rounded-apple border border-gray-200 bg-white px-3 py-2 hover:bg-gray-50">
                        Төлөв солих
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </motion.div>
  );
}
