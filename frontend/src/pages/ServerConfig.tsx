import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Server, Check, AlertCircle, Wifi } from "lucide-react";
import { setServerUrl, getServerUrl } from "../lib/serverConfig";
import { setApiBaseUrl } from "../lib/api";

export default function ServerConfig() {
  const navigate = useNavigate();
  const [ip, setIp] = useState("192.168.");
  const [port, setPort] = useState("8000");
  const [protocol, setProtocol] = useState<"http" | "https">("http");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // Аль хэдийн хадгалсан байвал эхний утгаар fill хийнэ
    (async () => {
      const saved = await getServerUrl();
      if (saved) {
        try {
          const u = new URL(saved);
          setProtocol(u.protocol === "https:" ? "https" : "http");
          setIp(u.hostname);
          setPort(u.port || (u.protocol === "https:" ? "443" : "80"));
        } catch {}
      }
    })();
  }, []);

  const buildUrl = () => `${protocol}://${ip.trim()}:${port.trim()}`;

  const connect = async () => {
    setError(null);
    setSuccess(false);
    const url = buildUrl();
    if (!ip.trim() || !port.trim()) {
      setError("IP болон порт заавал бөглөнө үү");
      return;
    }
    setTesting(true);
    try {
      // `fetch` ашиглан шалгана — Capacitor дээр CapacitorHttp plugin fetch-ийг
      // native Java client руу rewrite хийдэг тул CORS/mixed-content асуудалгүй.
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`${url}/openapi.json`, { method: "GET", signal: ctrl.signal });
      clearTimeout(to);
      if (res.ok) {
        await setServerUrl(url);
        setApiBaseUrl(url);
        setSuccess(true);
        setTimeout(() => {
          try { (window as any).location.reload(); }
          catch { navigate("/", { replace: true }); }
        }, 700);
      } else {
        setError(`Серверээс ${res.status} код ирлээ`);
      }
    } catch (e: any) {
      const parts: string[] = [];
      if (e?.name === "AbortError") parts.push("timeout (10s)");
      if (e?.code) parts.push(`code=${e.code}`);
      if (e?.message) parts.push(e.message);
      if (parts.length === 0) parts.push(String(e));
      setError(`Холбогдож чадсангүй — ${parts.join(" · ")}`);
      console.error("Server connect error:", e);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-blue-50 via-white to-blue-50/40 px-4 py-8 overflow-x-hidden"
         style={{ paddingTop: "max(2rem, env(safe-area-inset-top))", paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
      <div className="w-full max-w-sm">
        {/* Hero illustration */}
        <div className="mb-6 flex flex-col items-center">
          <div className="relative mb-4">
            <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-[#0071E3] to-[#004aad] blur-xl opacity-20"/>
            <div className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-[#0071E3] to-[#004aad] text-white shadow-lg shadow-blue-500/30">
              <Server size={36} strokeWidth={1.8}/>
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Bto</h1>
          <p className="mt-1.5 text-sm text-gray-500">Дотоод нөөцийн систем</p>
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-xl shadow-gray-900/5 ring-1 ring-gray-100">
          <div className="mb-5 flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-[#0071E3]">
              <Wifi size={18}/>
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900">Серверийн тохиргоо</h2>
              <p className="text-xs text-gray-500">Ажилтны сүлжээний серверийн хаягийг оруулна уу</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">Протокол</label>
              <div className="flex gap-2">
                {(["http", "https"] as const).map(p => (
                  <button key={p} onClick={() => setProtocol(p)}
                          className={`flex-1 rounded-xl border py-3 text-sm font-semibold transition-colors ${
                            protocol === p
                              ? "border-[#0071E3] bg-[#0071E3] text-white shadow-sm"
                              : "border-gray-200 bg-white text-gray-700 active:bg-gray-50"
                          }`}>
                    {p.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">IP хаяг</label>
              <input
                value={ip}
                onChange={e => setIp(e.target.value)}
                placeholder="192.168.1.100"
                inputMode="decimal"
                autoCorrect="off"
                autoCapitalize="none"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 text-base outline-none transition focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">Порт</label>
              <input
                value={port}
                onChange={e => setPort(e.target.value)}
                placeholder="8000"
                inputMode="numeric"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 text-base outline-none transition focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15"
              />
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2.5 text-xs">
              <span className="text-gray-400">URL:</span>
              <span className="flex-1 truncate font-mono text-gray-700">{buildUrl()}</span>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-xs text-red-700 ring-1 ring-inset ring-red-100">
                <AlertCircle size={14} className="mt-0.5 shrink-0"/>
                <span className="break-words">{error}</span>
              </div>
            )}
            {success && (
              <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-100">
                <Check size={14}/>
                Амжилттай холбогдлоо!
              </div>
            )}

            <button
              onClick={connect}
              disabled={testing}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#0071E3] py-3.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-[#005BB5] active:bg-[#004aad] disabled:opacity-50"
            >
              {testing ? <Loader2 size={18} className="animate-spin"/> : <Server size={18}/>}
              {testing ? "Холбогдож байна..." : "Холбогдох"}
            </button>
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-gray-400 px-2">
          Серверийн хаягаа мэдэхгүй бол систем хариуцагчаасаа асуугаарай.
        </p>
      </div>
    </div>
  );
}
