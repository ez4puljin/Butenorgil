import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Download, Send, Clock, RefreshCw, CheckCircle2, XCircle,
  FileText, Truck, Settings, Bot, ChevronDown,
} from "lucide-react";
import { api } from "../lib/api";

type StatusData = {
  erkhet_dir_exists: boolean;
  venv_exists: boolean;
  downloads_count: number;
  latest_files: { name: string; size: number; modified: string }[];
  schedule: { hour: number; minute: number; enabled: boolean; messenger_enabled?: boolean } | null;
};

type LogEntry = { date: string; content: string; size: number };

export default function ErkhetAuto() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  // Schedule form
  const [schedHour, setSchedHour] = useState(8);
  const [schedMin, setSchedMin] = useState(0);
  const [schedEnabled, setSchedEnabled] = useState(false);
  const [schedMessenger, setSchedMessenger] = useState(true);

  const showFlash = (msg: string, ok = true) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 4000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [sRes, lRes] = await Promise.all([
        api.get("/erkhet-auto/status"),
        api.get("/erkhet-auto/logs"),
      ]);
      setStatus(sRes.data);
      setLogs(lRes.data);
      if (sRes.data.schedule) {
        setSchedHour(sRes.data.schedule.hour ?? 8);
        setSchedMin(sRes.data.schedule.minute ?? 0);
        setSchedEnabled(sRes.data.schedule.enabled ?? false);
        setSchedMessenger(sRes.data.schedule.messenger_enabled ?? true);
      }
    } catch {
      showFlash("Мэдээлэл ачаалахад алдаа", false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const downloadAndImport = async (reportType: string, label: string) => {
    setBusy(reportType);
    try {
      const res = await api.post("/erkhet-auto/download-and-import", null, {
        params: { report_type: reportType },
        timeout: 200000,
      });
      if (res.data.ok) {
        showFlash(`${label} — амжилттай татаж шинэчлэгдлээ`);
      } else {
        showFlash(`${label} — алдаа: ${res.data.import_result?.error ?? ""}`, false);
      }
      await load();
    } catch (e: any) {
      showFlash(e?.response?.data?.detail ?? `${label} алдаа`, false);
    } finally {
      setBusy(null);
    }
  };

  const sendMessenger = async (group: string, label: string) => {
    setBusy(`msg_${group}`);
    try {
      const res = await api.post("/erkhet-auto/send-messenger", { group }, { timeout: 200000 });
      if (res.data.ok) {
        showFlash(`${label} — Messenger илгээгдлээ`);
      } else {
        showFlash(`${label} — илгээхэд алдаа`, false);
      }
    } catch (e: any) {
      showFlash(e?.response?.data?.detail ?? "Алдаа", false);
    } finally {
      setBusy(null);
    }
  };

  const saveSchedule = async () => {
    try {
      await api.post("/erkhet-auto/schedule", {
        hour: schedHour,
        minute: schedMin,
        enabled: schedEnabled,
        messenger_enabled: schedMessenger,
      });
      showFlash("Хуваарь хадгалагдлаа");
      await load();
    } catch (e: any) {
      showFlash(e?.response?.data?.detail ?? "Алдаа", false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Erkhet автомат</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Эрхэт системээс тайлан автомат татах, шинэчлэх, Messenger илгээх
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status?.venv_exists ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700">
              <CheckCircle2 size={13} /> Систем бэлэн
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1.5 text-xs text-red-600">
              <XCircle size={13} /> Систем олдсонгүй
            </span>
          )}
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-apple border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Шинэчлэх
          </button>
        </div>
      </div>

      {flash && (
        <div className={`mt-4 rounded-apple px-4 py-3 text-sm font-medium ${flash.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
          {flash.msg}
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* ═══ Left: Download & Import ═══ */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 px-1">
            <Download size={16} className="text-gray-400" />
            <span className="text-sm font-semibold text-gray-700">Татах + Шинэчлэх</span>
          </div>

          {/* Эрхэт бараа */}
          <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                  <FileText size={20} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">Эрхэт бараа</div>
                  <div className="text-xs text-gray-400">Бараа материалын жагсаалт (inventory_cost)</div>
                </div>
              </div>
              <button
                onClick={() => downloadAndImport("inventory_cost", "Эрхэт бараа")}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-4 py-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy === "inventory_cost" ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
                {busy === "inventory_cost" ? "Татаж байна..." : "Татах + Шинэчлэх"}
              </button>
            </div>
          </div>

          {/* Үлдэгдэл тайлан */}
          <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                  <Truck size={20} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">Үлдэгдэл тайлан</div>
                  <div className="text-xs text-gray-400">Барааны үлдэгдэл шинэчлэх (transfer_order)</div>
                </div>
              </div>
              <button
                onClick={() => downloadAndImport("inventory_cost", "Үлдэгдэл тайлан")}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy === "inventory_cost_balance" ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
                {busy === "inventory_cost_balance" ? "Татаж байна..." : "Татах + Шинэчлэх"}
              </button>
            </div>
          </div>

          {/* Messenger cards */}
          <div className="flex items-center gap-2 px-1 mt-6">
            <Send size={16} className="text-gray-400" />
            <span className="text-sm font-semibold text-gray-700">Messenger илгээх</span>
          </div>

          {/* Милко */}
          <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-50 text-violet-600">
                  <Bot size={20} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">Милко ХХК</div>
                  <div className="text-xs text-gray-400">Хөдөлгөөний + борлуулалтын тайлан</div>
                </div>
              </div>
              <button
                onClick={() => sendMessenger("milko", "Милко")}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy === "msg_milko" ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
                {busy === "msg_milko" ? "Илгээж байна..." : "Илгээх"}
              </button>
            </div>
          </div>

          {/* Алтанжолоо */}
          <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
                  <Bot size={20} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">Алтанжолоо ХХК</div>
                  <div className="text-xs text-gray-400">Хөдөлгөөний + борлуулалтын тайлан</div>
                </div>
              </div>
              <button
                onClick={() => sendMessenger("altanjoluu", "Алтанжолоо")}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-4 py-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy === "msg_altanjoluu" ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
                {busy === "msg_altanjoluu" ? "Илгээж байна..." : "Илгээх"}
              </button>
            </div>
          </div>
        </div>

        {/* ═══ Right: Schedule + Logs ═══ */}
        <div className="space-y-4">
          {/* Schedule */}
          <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 mb-4">
              <Clock size={16} className="text-gray-400" />
              <span className="text-sm font-semibold text-gray-700">Хуваарь тохиргоо</span>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-500 w-16">Цаг:</label>
                <input type="number" min={0} max={23} value={schedHour} onChange={(e) => setSchedHour(Number(e.target.value))}
                  className="w-16 rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-center outline-none focus:border-[#0071E3]" />
                <span className="text-gray-400">:</span>
                <input type="number" min={0} max={59} value={schedMin} onChange={(e) => setSchedMin(Number(e.target.value))}
                  className="w-16 rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-center outline-none focus:border-[#0071E3]" />
              </div>

              <label className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 cursor-pointer">
                <span className="text-sm text-gray-700">Автомат татах идэвхтэй</span>
                <input type="checkbox" checked={schedEnabled} onChange={(e) => setSchedEnabled(e.target.checked)}
                  className="h-4 w-4 accent-[#0071E3]" />
              </label>

              <label className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 cursor-pointer">
                <span className="text-sm text-gray-700">Messenger автомат илгээх</span>
                <input type="checkbox" checked={schedMessenger} onChange={(e) => setSchedMessenger(e.target.checked)}
                  className="h-4 w-4 accent-[#0071E3]" />
              </label>

              <button onClick={saveSchedule}
                className="w-full rounded-xl bg-[#0071E3] py-2.5 text-sm font-medium text-white hover:opacity-90">
                <Settings size={13} className="inline mr-1.5" />
                Хуваарь хадгалах
              </button>
            </div>
          </div>

          {/* Downloaded files */}
          {status && status.latest_files.length > 0 && (
            <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-3">
                <FileText size={16} className="text-gray-400" />
                <span className="text-sm font-semibold text-gray-700">Сүүлд татагдсан файлууд</span>
              </div>
              <div className="space-y-1">
                {status.latest_files.slice(0, 5).map((f) => (
                  <div key={f.name} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                    <span className="text-xs text-gray-700 truncate">{f.name}</span>
                    <span className="text-[10px] text-gray-400 shrink-0 ml-2">
                      {new Date(f.modified).toLocaleString("mn-MN")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Logs */}
          <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
              <FileText size={16} className="text-gray-400" />
              <span className="text-sm font-semibold text-gray-700">Лог</span>
              <span className="text-xs text-gray-400">{logs.length} файл</span>
            </div>
            {logs.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">Лог байхгүй</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {logs.map((lg) => (
                  <div key={lg.date}>
                    <button
                      onClick={() => setExpandedLog(expandedLog === lg.date ? null : lg.date)}
                      className="flex w-full items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors"
                    >
                      <span className="text-sm font-medium text-gray-700">{lg.date}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-400">{(lg.size / 1024).toFixed(1)} KB</span>
                        <ChevronDown size={14} className={`text-gray-400 transition-transform ${expandedLog === lg.date ? "rotate-180" : ""}`} />
                      </div>
                    </button>
                    {expandedLog === lg.date && (
                      <div className="bg-gray-900 px-5 py-3 max-h-[300px] overflow-auto">
                        <pre className="text-xs text-green-400 whitespace-pre-wrap font-mono">{lg.content}</pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
