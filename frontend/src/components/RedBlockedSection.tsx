import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Loader2, Download, Printer, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";
import RedReportCard, { type Item as RedItem, type Result as RedResult } from "./RedReportCard";

/* Хянах самбар → Улайлт ба дарагдсан бараа. Зүүн талд Улайлтын тайлан (Эрхэтийн сөрөг үлдэгдэл), баруун
   талд Дарагдсан барааны тайлан — сонгосон өдөр үүссэн бүх deal-ийн tickUsed=false бараа, агуулахаар
   (мөрийн erxes department → Эрхэтийн байршил). «Хэвлэх» — агуулах бүр 1 хуудас: улайсан + дарагдсан. */

interface BDeal { number: string; name: string; qty: number }
interface BItem { location: string; location_name: string; code: string; name: string; qty: number; amount: number; deals: BDeal[] }
interface BLoc { key: string; code: string; name: string; count: number; amount: number }
interface Blocked {
  day: string; checked_at: string; seconds: number; deals: number; deals_blocked: number; count: number;
  amount: number; locations: BLoc[]; items: BItem[]; errors: Record<string, string>;
}
interface Page { key: string; code: string; name: string; red: RedItem[]; blocked: BItem[]; redChecked: boolean }

function todayUB() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function ub(iso?: string) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function n(v: number) { return v.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function esc(s: string) { return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)); }
const keyOf = (i: BItem) => i.location || i.location_name;
/** «2026/10/30-0063» → «0063» (огноо нь толгойд байгаа тул) */
function shortNo(no: string, day: string) {
  const pre = `${day.replace(/-/g, "/")}-`;
  return no.startsWith(pre) ? no.slice(pre.length) : no;
}
function dealsText(it: BItem, day: string) {
  const ds = it.deals.map(d => it.deals.length > 1 ? `${shortNo(d.number, day)} (${n(d.qty)})` : shortNo(d.number, day));
  return ds.length > 5 ? `${ds.slice(0, 5).join(", ")} +${ds.length - 5}` : ds.join(", ");
}

export default function RedBlockedSection() {
  const [red, setRed] = useState<RedResult | null>(null);
  const [day, setDay] = useState(todayUB);
  const [data, setData] = useState<Blocked | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [loc, setLoc] = useState("");
  const [printLoc, setPrintLoc] = useState("");
  const seq = useRef(0);

  const load = useCallback(async (d: string, refresh = false) => {
    const my = ++seq.current;
    setLoading(true); setErr("");
    setData(prev => (prev?.day === d ? prev : null));
    try {
      const r = await api.get("/blocked-goods", { params: { day: d, refresh }, timeout: 180000 });
      if (my === seq.current) setData(r.data);
    } catch (e: any) {
      if (my === seq.current) setErr(e?.response?.data?.detail ?? "Дарагдсан барааны тайлан ачаалж чадсангүй");
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(day); }, [day, load]);

  // Хуудсууд: Улайлтын тохиргооны байршлууд + дарагдсан бараатай агуулахууд, кодоор
  const pages = useMemo(() => {
    const m = new Map<string, Page>();
    for (const l of red?.locations ?? []) m.set(l.code, { key: l.code, code: l.code, name: l.name, red: [], blocked: [], redChecked: true });
    for (const it of red?.items ?? []) m.get(it.location)?.red.push(it);
    for (const l of data?.locations ?? []) {
      if (!m.has(l.key)) m.set(l.key, { key: l.key, code: l.code, name: l.name, red: [], blocked: [], redChecked: false });
    }
    for (const it of data?.items ?? []) m.get(keyOf(it))?.blocked.push(it);
    return [...m.values()]
      .filter(p => p.red.length || p.blocked.length)
      .sort((a, b) => Number(!a.code) - Number(!b.code) || a.code.localeCompare(b.code) || a.name.localeCompare(b.name));
  }, [red, data]);

  const sel = pages.some(p => p.key === printLoc) ? printLoc : "";   // өдөр солигдоход алга болсон бол «бүгд»

  function print() {
    const list = pages.filter(p => !sel || p.key === sel);
    if (!list.length) return;
    const sub = `Улайлт: Эрхэтийн үлдэгдэл ${red ? ub(red.checked_at) : "—"}-ийн байдлаар · Дарагдсан: ${day}-нд үүссэн deal`
      + (data ? ` (erxes ${ub(data.checked_at)})` : " — ачаалагдаагүй");
    const page = (p: Page) => {
      const redQty = new Map(p.red.map(r => [r.code, r.qty]));
      return `<div class="page">
<h1>${esc(p.code ? `${p.code} ${p.name}` : p.name)}</h1>
<p class="sub">${esc(sub)}</p>
<h2>Улайсан бараа — ${p.red.length}</h2>
${p.red.length ? `<table><thead><tr><th style="width:24px">№</th><th style="width:62px">Код</th><th>Нэр</th><th class="n">Эхний</th><th class="n">Орлого</th><th class="n">Зарлага</th><th class="n">Эцсийн үлдэгдэл</th></tr></thead><tbody>
${p.red.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="n">${n(r.begin_qty)}</td><td class="n">${n(r.in_qty)}</td><td class="n">${n(r.out_qty)}</td><td class="n red">${n(r.qty)}</td></tr>`).join("")}
</tbody></table>` : `<p class="none">${p.redChecked ? "Улайсан бараа алга." : "Энэ байршлын улайлтыг шалгадаггүй — Улайлтын тайлангийн тохиргооноос нэмж болно."}</p>`}
<h2>Дарагдсан бараа (${esc(day)}) — ${p.blocked.length}</h2>
${p.blocked.length ? `<table><thead><tr><th style="width:24px">№</th><th style="width:62px">Код</th><th>Нэр</th><th class="n" style="width:50px">Тоо</th><th style="width:34%">Захиалга</th></tr></thead><tbody>
${p.blocked.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.code)}</td><td>${esc(b.name)}${redQty.has(b.code) ? ` <span class="tag">улайсан ${n(redQty.get(b.code)!)}</span>` : ""}</td><td class="n">${n(b.qty)}</td><td>${esc(dealsText(b, day))}</td></tr>`).join("")}
</tbody></table>` : `<p class="none">${data ? "Дарагдсан бараа алга." : "Дарагдсан барааны мэдээлэл ачаалагдаагүй."}</p>`}
<div class="sig"><span>Шалгасан: ____________________</span><span>Хариуцагч: ____________________</span></div>
</div>`;
    };
    const html = `<!doctype html><html lang="mn"><head><meta charset="utf-8"><title>Улайлт ба дарагдсан бараа ${esc(day)}</title>
<style>
@page{size:A4 portrait;margin:11mm}body{font-family:Arial,sans-serif;font-size:10.5px;color:#111;margin:0}
.page{page-break-after:always}.page:last-child{page-break-after:auto}
h1{font-size:17px;margin:0 0 2px}p.sub{margin:0 0 8px;color:#555}
h2{font-size:12.5px;margin:12px 0 4px;border-bottom:2px solid #111;padding-bottom:2px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:2px 5px;vertical-align:top}th{background:#f3f4f6;text-align:left}
td.n,th.n{text-align:right;white-space:nowrap}td.red{color:#dc2626;font-weight:bold}tr{page-break-inside:avoid}
p.none{margin:2px 0 0;color:#777;font-style:italic}.tag{color:#dc2626;font-weight:bold;font-size:9.5px;white-space:nowrap}
.sig{margin-top:22px;display:flex;gap:60px}
</style></head><body>
${list.map(page).join("")}
<script>window.onload=function(){setTimeout(function(){window.print()},200)}</script>
</body></html>`;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) { setErr("Хөтөч шинэ цонх нээхийг хориглолоо."); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  async function download() {
    try {
      const r = await api.get("/blocked-goods/xlsx", { params: { day }, responseType: "blob", timeout: 180000 });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url; a.download = `Дарагдсан_бараа_${day}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
    } catch { setErr("Excel татаж чадсангүй"); }
  }

  const items = (data?.items ?? []).filter(i => !loc || keyOf(i) === loc);
  const btn = "flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50";
  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900 sm:text-lg">Улайлт ба дарагдсан бараа</h2>
        <span className="text-xs text-gray-400">Хэвлэхэд агуулах бүр 1 хуудас: улайсан + {day}-ний дарагдсан бараа</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select value={sel} onChange={e => setPrintLoc(e.target.value)}
            className="rounded-xl border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
            <option value="">Бүх агуулах ({pages.length} хуудас)</option>
            {pages.map(p => (
              <option key={p.key} value={p.key}>{p.code ? `${p.code} ` : ""}{p.name} — улайсан {p.red.length}, дарагдсан {p.blocked.length}</option>
            ))}
          </select>
          <button onClick={print} disabled={!pages.length || loading}
            className="flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
            <Printer size={12}/>Хэвлэх
          </button>
        </div>
      </div>

      <div className="grid gap-4 2xl:grid-cols-2">
        <RedReportCard onResult={setRed}/>

        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900 sm:text-base">Дарагдсан бараа</h3>
            {data && <span className="text-xs text-gray-400">{data.deals} deal · {ub(data.checked_at)}-ийн байдлаар</span>}
            <div className="ml-auto flex flex-wrap gap-2">
              <input type="date" value={day} max={todayUB()} onChange={e => { if (e.target.value) { setDay(e.target.value); setLoc(""); } }}
                className="rounded-xl border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"/>
              <button onClick={() => load(day, true)} disabled={loading} className={btn}>
                {loading ? <Loader2 size={12} className="animate-spin"/> : <RefreshCw size={12}/>}Шинэчлэх
              </button>
              <button onClick={download} disabled={!data || loading} className={btn}>
                <Download size={12}/>Татах
              </button>
            </div>
          </div>

          {err && <div className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}

          {!data ? (
            <div className="flex items-center gap-2 rounded-apple bg-white p-4 text-sm text-gray-500 shadow-sm">
              {loading ? <><Loader2 size={14} className="animate-spin"/>erxes-ээс {day}-нд үүссэн deal-уудыг татаж байна…</> : "Мэдээлэл алга"}
            </div>
          ) : (
            <div className="rounded-apple bg-white p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <button onClick={() => setLoc("")}
                  className={`rounded-lg border px-2.5 py-1 text-xs ${!loc ? "border-gray-800 bg-gray-800 text-white" : "border-gray-200 text-gray-600"}`}>
                  Бүгд <b>{data.count}</b>
                </button>
                {data.locations.map(l => (
                  <button key={l.key} onClick={() => setLoc(l.key)}
                    className={`rounded-lg border px-2.5 py-1 text-xs ${loc === l.key ? "border-amber-600 bg-amber-600 text-white" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                    {l.name} <b>{l.count}</b>
                  </button>
                ))}
                <span className={`ml-auto flex items-center gap-1 text-xs ${data.count ? "text-amber-700" : "text-emerald-600"}`}>
                  {data.count ? <AlertTriangle size={12}/> : <CheckCircle2 size={12}/>}
                  {data.count ? `${data.deals_blocked} deal-д ${data.count} бараа дарагдсан` : "Дарагдсан бараа алга"}
                </span>
              </div>
              {Object.keys(data.errors ?? {}).length > 0 && (
                <p className="mb-2 text-[11px] text-amber-700">Бүрэн татаж чадаагүй: {Object.keys(data.errors).join(", ")}</p>
              )}
              {items.length > 0 && (
                <div className="max-h-96 overflow-auto rounded-xl border border-gray-100">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50 text-[10.5px] uppercase text-gray-500">
                      <tr>
                        {["Агуулах", "Код", "Нэр", "Тоо", "Захиалга"].map((h, i) => (
                          <th key={h} className={`px-2 py-1.5 ${i === 3 ? "text-right" : "text-left"}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(i => (
                        <tr key={keyOf(i) + i.code + i.name} className="border-t border-gray-100">
                          <td className="px-2 py-1 text-gray-500">{i.location_name}</td>
                          <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">{i.code}</td>
                          <td className="px-2 py-1 text-gray-800">{i.name}</td>
                          <td className="whitespace-nowrap px-2 py-1 text-right font-mono font-bold text-amber-700">{n(i.qty)}</td>
                          <td className="px-2 py-1 font-mono text-[11px] text-gray-500"
                            title={i.deals.map(d => `${d.number} · ${d.name} · ${n(d.qty)}`).join("\n")}>
                            {dealsText(i, day)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
