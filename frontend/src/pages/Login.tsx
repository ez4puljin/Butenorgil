import { useState } from "react";
import { motion } from "framer-motion";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { firstPermittedPath } from "../App";

export default function Login() {
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const form = new URLSearchParams();
      form.append("username", username);
      form.append("password", password);

      const res = await api.post("/auth/login", form, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      const perms: string[] = res.data.permissions ?? [];
      setAuth({
        token: res.data.access_token,
        username: res.data.username,
        nickname: res.data.nickname ?? "",
        role: res.data.role,
        base_role: res.data.base_role ?? res.data.role,
        permissions: perms,
        tagIds: res.data.tag_ids,
        userId: res.data.user_id,
      });
      // Эхний зөвшөөрөгдсөн хуудас руу redirect (dashboard биш байж болно)
      window.location.href = firstPermittedPath(perms);
    } catch (e: any) {
      if (!e?.response) {
        setErr("Серверт холбогдох боломжгүй байна. Backend асаагүй байж магадгүй.");
      } else {
        setErr(e?.response?.data?.detail ?? "Нэвтрэхэд алдаа гарлаа");
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md rounded-apple bg-white p-8 shadow-sm">
        <div className="text-center">
          <div className="text-sm text-gray-500">Бүтэн-Оргил ХХК</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">Нэвтрэх</div>
          <div className="mt-2 text-sm text-gray-500">Дотоод сүлжээнд ашиглана</div>
        </div>

        <form onSubmit={onSubmit} className="mt-6 space-y-3">
          <input
            className="w-full rounded-apple border border-gray-200 px-4 py-3 outline-none focus:border-[#0071E3]"
            placeholder="Хэрэглэгчийн нэр"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="w-full rounded-apple border border-gray-200 px-4 py-3 outline-none focus:border-[#0071E3]"
            placeholder="Нууц үг"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {err && <div className="rounded-apple bg-red-50 px-4 py-2 text-sm text-red-700">{err}</div>}

          <button className="w-full rounded-apple bg-[#0071E3] py-3 text-white font-medium shadow-sm hover:opacity-95">
            Нэвтрэх
          </button>
        </form>

      </motion.div>
    </div>
  );
}

