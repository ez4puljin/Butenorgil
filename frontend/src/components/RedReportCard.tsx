import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Loader2, Download, Printer, Settings2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";

/* Хянах самбар → Улайлтын тайлан: Эрхэтэд сөрөг үлдэгдэлтэй бараа, тохируулсан байршлаар.
   Сервер ажлын цагаар (анхдагч 1 цаг тутам) Эрхэтээс байршил бүрийг ТУСАД НЬ татна — нэг тайланд
   олон байршил асуухад Эрхэт 5 мин боловсруулаад унасан тул. «Хэвлэх» нь «Улайлт тайлан» хэлбэрээр. */

interface Item {
  location: string; location_name: string; code: string; name: string; qty: number; amount: number;
  unit_cost: number; begin_qty: number; in_qty: number; out_qty: number;
}
interface Result {
  checked_at: string; day: string; seconds: number; locations: { code: string; name: string }[];
  count: number; amount: number; by_location: Record<string, number>; items: Item[]; errors?: Record<string, string>;
}
interface Settings { locations: string[]; interval_min: number; start_hour: number; end_hour: number }

function ub(iso?: string) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function n(v: number) { return v.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function esc(s: string) { return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)); }

export default function RedReportCard() {
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

  function print() {
    if (!res) return;
    const items = res.items.filter(i => !loc || i.location === loc);
    const groups = res.locations.filter(l => !loc || l.code === loc).map(l => ({ l, rows: items.filter(i => i.location === l.code) }));
    const html = `<!doctype html><html lang="mn"><head><meta charset="utf-8"><title>Улайлт тайлан</title>
<style>
@page{size:A4 portrait;margin:12mm}body{font-family:Arial,sans-serif;font-size:11px;color:#111;margin:0}
h1{font-size:18px;margin:0 0 2px}p.sub{margin:0 0 10px;color:#555}h2{font-size:13px;margin:14px 0 4px;border-bottom:2px solid #111;padding-bottom:2px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:3px 5px}th{background:#f3f4f6;text-align:left}
td.n,th.n{text-align:right;white-space:nowrap}td.red{color:#dc2626;font-weight:bold}tr{page-break-inside:avoid}
.foot{margin-top:12px;font-weight:bold}.sig{margin-top:28px;display:flex;gap:60px}
</style></head><body>
<h1>Улайлт тайлан</h1>
<p class="sub">Эрхэтийн үлдэгдэл ${esc(ub(res.checked_at))}-ийн байдлаар · ${items.length} бараа</p>
${groups.map(g => `<h2>${esc(g.l.code)} ${esc(g.l.name)} — ${g.rows.length} бараа</h2>
<table><thead><tr><th style="width:28px">№</th><th style="width:70px">Код</th><th>Нэр</th><th class="n">Эхний</th><th class="n">Орлого</th><th class="n">Зарлага</th><th class="n">Эцсийн үлдэгдэл</th></tr></thead><tbody>
${g.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="n">${n(r.begin_qty)}</td><td class="n">${n(r.in_qty)}</td><td class="n">${n(r.out_qty)}</td><td class="n red">${n(r.qty)}</td></tr>`).join("")}
</tbody></table>`).join("")}
<div class="foot">Нийт: ${items.length} бараа</div>
<div class="sig"><span>Шалгасан: ____________________</span><span>Хариуцагч: ____________________</span></div>
<script>window.onload=function(){setTimeout(function(){window.print()},200)}</script>
</body></html>`;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) { setErr("Хөтөч шинэ цонх нээхийг хориглолоо."); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  const items = (res?.items ?? []).filter(i => !loc || i.location === loc);
  const bad = !!res && res.count > 0;
  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900 sm:text-lg">Улайлтын тайлан</h2>
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
          <button onClick={print} disabled={!res}
            className="flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
            <Printer size={12}/>Хэвлэх
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
                      <td className="whitespace-nowrap px-2 py-1 text-gray-500">{i.location_name}</td>
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
