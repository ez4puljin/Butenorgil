import { useState } from "react";
import { motion } from "framer-motion";
import { Server, User, Lock, LogIn, AlertCircle, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { firstPermittedPath } from "../App";
import { clearServerUrl, getServerUrlSync, isNativeApp } from "../lib/serverConfig";

export default function Login() {
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-blue-50 via-white to-blue-50/40 px-4 py-6 overflow-x-hidden"
      style={{ paddingTop: "max(1.5rem, env(safe-area-inset-top))", paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        {/* Brand header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="relative mb-3">
            <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-[#0071E3] to-[#004aad] blur-xl opacity-20"/>
            <div className="relative flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-[#0071E3] to-[#004aad] text-white shadow-lg shadow-blue-500/30">
              <span className="text-2xl font-bold tracking-tight">Bto</span>
            </div>
          </div>
          <div className="text-sm text-gray-500">Бүтэн-Оргил ХХК</div>
          <div className="mt-1 text-xl font-semibold tracking-tight text-gray-900">Нэвтрэх</div>
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-xl shadow-gray-900/5 ring-1 ring-gray-100">
          <form onSubmit={onSubmit} className="space-y-3.5">
            {/* Username */}
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">
                Хэрэглэгчийн нэр
              </label>
              <div className="relative">
                <User size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"/>
                <input
                  className="w-full rounded-xl border border-gray-200 bg-white pl-10 pr-4 py-3 text-base outline-none transition focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15"
                  placeholder="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoCorrect="off"
                  autoCapitalize="none"
                  autoComplete="username"
                  inputMode="text"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">
                Нууц үг
              </label>
              <div className="relative">
                <Lock size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"/>
                <input
                  className="w-full rounded-xl border border-gray-200 bg-white pl-10 pr-4 py-3 text-base outline-none transition focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15"
                  placeholder="••••••••"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
            </div>

            {err && (
              <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-xs text-red-700 ring-1 ring-inset ring-red-100">
                <AlertCircle size={14} className="mt-0.5 shrink-0"/>
                <span className="break-words">{err}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#0071E3] py-3.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-[#005BB5] active:bg-[#004aad] disabled:opacity-50"
            >
              {busy ? <Loader2 size={18} className="animate-spin"/> : <LogIn size={18}/>}
              {busy ? "Нэвтэрч байна..." : "Нэвтрэх"}
            </button>
          </form>

          {/* Server config button — native app эсвэл URL хадгалагдсан бол л харуулна */}
          {(isNativeApp() || getServerUrlSync()) && (
            <>
              <div className="mt-5 flex items-center gap-3">
                <div className="h-px flex-1 bg-gray-100"/>
                <span className="text-[10px] uppercase tracking-wider text-gray-300">Тохиргоо</span>
                <div className="h-px flex-1 bg-gray-100"/>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await clearServerUrl();
                  try { (window as any).location.replace("/"); }
                  catch { window.location.href = "/"; }
                }}
                className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-gray-200 bg-white py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 active:bg-gray-100"
              >
                <Server size={15}/>
                Серверийн тохиргоо
              </button>
              {getServerUrlSync() && (
                <p className="mt-2 text-center text-[11px] text-gray-400 break-all font-mono">
                  {getServerUrlSync()}
                </p>
              )}
            </>
          )}
        </div>

        <p className="mt-5 text-center text-[11px] text-gray-400">
          Дотоод сүлжээнд ашиглана
        </p>
      </motion.div>
    </div>
  );
}
