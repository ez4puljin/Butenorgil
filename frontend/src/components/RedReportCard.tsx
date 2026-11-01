import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Loader2, Download, Settings2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";

/* Хянах самбар → Улайлтын тайлан: Эрхэтэд сөрөг үлдэгдэлтэй бараа, тохируулсан байршлаар.
   Сервер ажлын цагаар (анхдагч 1 цаг тутам) Эрхэтээс байршил бүрийг ТУСАД НЬ татна — нэг тайланд
   олон байршил асуухад Эрхэт 5 мин боловсруулаад унасан тул. Хэвлэх нь RedBlockedSection-д —
   дарагдсан бараатай нэгтгэж агуулах бүр 1 хуудас. */

export interface Item {
  location: string; location_name: string; code: string; name: string; qty: number; amount: number;
  unit_cost: number; begin_qty: number; in_qty: number; out_qty: number;
}
export interface Result {
  checked_at: string; day: string; seconds: number; locations: { code: string; name: string }[];
  count: number; amount: number; by_location: Record<string, number>; items: Item[]; errors?: Record<string, string>;
}
interface Settings { locations: string[]; interval_min: number; start_hour: number; end_hour: number }

function ub(iso?: string) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function n(v: number) { return v.toLocaleString("en-US", { maximumFractionDigits: 2 }); }

export default function RedReportCard({ onResult }: { onResult?: (r: Result | null) => void }) {
  const onRes = useRef(onResult);
  onRes.current = onResult;
  const [res, setRes] = useState<Result | null>(null);
  const [st, setSt] = useState<{ running: boolean; error: string; next_manual_in: number } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [all, setAll] = useState<{ id: string; code: string; name: string }[]>([]);
  const [showSet, setShowSet] = useState(false);
  const [err, setErr] = useState("");
  const [loc, setLoc] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get("/red-report", { timeout: 60000 });
      setRes(r.data.result); setSt(r.data.status); setSettings(r.data.settings); setAll(r.data.all_locations ?? []);
      onRes.current?.(r.data.result);
      return r.data.status;
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Улайлтын тайлан ачаалж чадсангүй"); return null; }
  }, []);

  const watch = useCallback(() => {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      const s = await load();
      if (!s?.running && poll.current) { clearInterval(poll.current); poll.current = null; }
    }, 5000);
  }, [load]);

  useEffect(() => {
    load().then(s => { if (s?.running) watch(); });
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [load, watch]);

  async function refresh() {
    setErr("");
    try {
      await api.post("/red-report/run");
      setSt(s => ({ ...(s ?? { error: "", next_manual_in: 0 }), running: true }));
      watch();
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Шинэчилж чадсангүй"); }
  }

  async function saveLocs(codes: string[]) {
    const r = await api.put("/red-report/settings", { locations: codes });
    setSettings(r.data.settings);
  }

  async function download() {
    const r = await api.get("/red-report/xlsx", { responseType: "blob", timeout: 60000 });
    const url = URL.createObjectURL(r.data);
    const a = document.createElement("a");
    a.href = url; a.download = `Улайлт_тайлан_${(ub(res?.checked_at) || "").replace(/[: ]/g, "-")}.xlsx`;
    a.click(); URL.revokeObjectURL(url);
  }

  const items = (res?.items ?? []).filter(i => !loc || i.location === loc);
  const bad = !!res && res.count > 0;
  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900 sm:text-base">Улайлтын тайлан</h3>
        {res && <span className="text-xs text-gray-400">{ub(res.checked_at)}-ийн байдлаар</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          <button onClick={() => setShowSet(v => !v)} title="Байршил тохируулах"
            className="rounded-xl border border-gray-200 bg-white p-1.5 text-gray-500 hover:bg-gray-50"><Settings2 size={14}/></button>
          <button onClick={refresh} disabled={st?.running}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            {st?.running ? <Loader2 size={12} className="animate-spin"/> : <RefreshCw size={12}/>}Шинэчлэх
          </button>
          <button onClick={download} disabled={!res}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            <Download size={12}/>Татах
          </button>
        </div>
      </div>

      {showSet && settings && (
        <div className="mb-2 rounded-xl border border-gray-200 bg-white p-3 text-xs">
          <div className="mb-1.5 font-semibold text-gray-700">Улайлт шалгах байршил</div>
          <div className="flex flex-wrap gap-1.5">
            {all.map(l => {
              const on = settings.locations.includes(l.code);
              return (
                <button key={l.code} onClick={() => saveLocs(on ? settings.locations.filter(x => x !== l.code) : [...settings.locations, l.code])}
                  className={`rounded-lg border px-2 py-1 ${on ? "border-rose-300 bg-rose-50 text-rose-700" : "border-gray-200 text-gray-500"}`}>
                  <span className="font-mono text-[10.5px] opacity-70">{l.code}</span> {l.name}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-gray-400">
            Сервер {settings.start_hour}:00–{settings.end_hour}:00 цагт {settings.interval_min} минут тутам шинэчилнэ. Байршил бүрийг тусад нь
            татдаг (Бөөний агуулах ~80 сек) тул олон байршил сонгох тусам удаан. Өөрчлөлт дараагийн шинэчлэлтэд орно.
          </p>
        </div>
      )}

      {st?.running && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-rose-100 bg-rose-50/50 px-3 py-2 text-xs text-rose-800">
          <Loader2 size={13} className="animate-spin"/>Эрхэтээс байршил бүрээр татаж байна (1–3 минут)…
        </div>
      )}
      {(err || (st && !st.running && st.error)) && (
        <div className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{err || st?.error}</div>
      )}

      {!res ? (
        <div className="rounded-apple bg-white p-4 text-sm text-gray-500 shadow-sm">Улайлтын тайлан хараахан гараагүй — «Шинэчлэх» дарна уу.</div>
      ) : (
        <div className="rounded-apple bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <button onClick={() => setLoc("")}
              className={`rounded-lg border px-2.5 py-1 text-xs ${!loc ? "border-gray-800 bg-gray-800 text-white" : "border-gray-200 text-gray-600"}`}>
              Бүгд <b>{res.count}</b>
            </button>
            {res.locations.map(l => (
              <button key={l.code} onClick={() => setLoc(l.code)}
                className={`rounded-lg border px-2.5 py-1 text-xs ${loc === l.code ? "border-rose-600 bg-rose-600 text-white"
                  : res.by_location[l.code] ? "border-rose-200 bg-rose-50 text-rose-700" : "border-gray-200 text-gray-500"}`}>
                {l.name} <b>{res.by_location[l.code] ?? 0}</b>
              </button>
            ))}
            <span className={`ml-auto flex items-center gap-1 text-xs ${bad ? "text-rose-600" : "text-emerald-600"}`}>
              {bad ? <AlertTriangle size={12}/> : <CheckCircle2 size={12}/>}{bad ? `${res.count} бараа улайсан` : "Улайсан бараа алга"}
            </span>
          </div>
          {res.errors && Object.keys(res.errors).length > 0 && (
            <p className="mb-2 text-[11px] text-amber-700">Татаж чадаагүй байршил: {Object.keys(res.errors).join(", ")}</p>
          )}
          {items.length > 0 && (
            <div className="max-h-96 overflow-auto rounded-xl border border-gray-100">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 text-[10.5px] uppercase text-gray-500">
                  <tr>
                    {["Байршил", "Код", "Нэр", "Эхний", "Орлого", "Зарлага", "Үлдэгдэл"].map((h, i) => (
                      <th key={h} className={`px-2 py-1.5 ${i >= 3 ? "text-right" : "text-left"}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map(i => (
                    <tr key={i.location + i.code} className="border-t border-gray-100">
                      <td className="px-2 py-1 text-gray-500">{i.location_name}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">{i.code}</td>
                      <td className="px-2 py-1 text-gray-800">{i.name}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-gray-500">{n(i.begin_qty)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-gray-500">{n(i.in_qty)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-gray-500">{n(i.out_qty)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono font-bold text-rose-600">{n(i.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
