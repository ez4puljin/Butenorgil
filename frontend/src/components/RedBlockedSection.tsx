import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Download, Printer, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";
import RedReportCard, { type Item as RedItem, type Result as RedResult } from "./RedReportCard";

/* Хянах самбар → Улайлт ба дарагдсан бараа. Автоматаар ТАТАХГҮЙ: хэрэглэгч байршил, огноогоо сонгоод «Татах»
   дарахад л Улайлт (Эрхэтийн сөрөг үлдэгдэл) ба Дарагдсан бараа (тухайн өдөр үүссэн бүх deal-ийн tickUsed=false,
   мөрийн erxes department → Эрхэтийн байршил) гарна. «Хэвлэх» — агуулах бүр 1 хуудас: улайсан + дарагдсан. */

interface BDeal { number: string; name: string; qty: number }
interface BItem { location: string; location_name: string; code: string; name: string; qty: number; amount: number; deals: BDeal[] }
interface BLoc { key: string; code: string; name: string; count: number; amount: number }
interface Blocked {
  day: string; checked_at: string; seconds: number; deals: number; deals_blocked: number; count: number;
  amount: number; locations: BLoc[]; items: BItem[]; errors: Record<string, string>;
}
interface Page { key: string; code: string; name: string; red: RedItem[]; blocked: BItem[]; redChecked: boolean }
interface Pulled { codes: string[]; other: boolean; day: string }

function todayUB() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function ub(iso?: string) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function n(v: number) { return v.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function esc(s: string) { return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)); }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
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
  const [allLocs, setAllLocs] = useState<{ code: string; name: string }[]>([]);
  const [codes, setCodes] = useState<string[]>([]);
  const [other, setOther] = useState(false);
  const [day, setDay] = useState(todayUB);
  const [pulled, setPulled] = useState<Pulled | null>(null);
  const [red, setRed] = useState<RedResult | null>(null);
  const [redBusy, setRedBusy] = useState(false);
  const [redErr, setRedErr] = useState("");
  const [data, setData] = useState<Blocked | null>(null);
  const [blockedBusy, setBlockedBusy] = useState(false);
  const [blockedErr, setBlockedErr] = useState("");
  const [loc, setLoc] = useState("");
  const [printLoc, setPrintLoc] = useState("");
  const seq = useRef(0);

  // Зөвхөн байршлын жагсаалт + сүүлд сонгосон — тайлан татахгүй
  useEffect(() => {
    let alive = true;
    api.get("/red-report", { timeout: 60000 }).then(r => {
      if (!alive) return;
      const list: { code: string; name: string }[] = r.data.all_locations ?? [];
      setAllLocs(list);
      setCodes((r.data.settings?.locations ?? []).filter((c: string) => list.some(l => l.code === c)));
    }).catch(e => { if (alive) setRedErr(e?.response?.data?.detail ?? "Байршлын жагсаалт ачаалж чадсангүй"); });
    return () => { alive = false; seq.current++; };
  }, []);

  async function pullRed(my: number, list: string[]) {
    const q = { params: { locations: list.join(",") }, timeout: 60000 };
    let started = false;
    for (let t = 0; t < 400 && my === seq.current; t++) {     // ~20 минут хүртэл (өөр хүний татлагыг хүлээж болно)
      if (!started) started = (await api.post("/red-report/run", { locations: list })).data.started;
      if (started) {
        const r = await api.get("/red-report", q);
        if (!r.data.status.running) {
          if (my !== seq.current) return;
          if (r.data.status.error) throw new Error(r.data.status.error);
          setRed(r.data.result);
          return;
        }
      }
      await wait(3000);
    }
  }

  async function pull() {
    const my = ++seq.current;
    const list = [...codes];
    const p = { codes: list, other, day };
    setPulled(p); setRed(null); setData(null); setLoc(""); setRedErr(""); setBlockedErr("");
    setBlockedBusy(true); setRedBusy(list.length > 0);
    await Promise.all([
      list.length > 0 && pullRed(my, list)
        .catch((e: any) => { if (my === seq.current) setRedErr(e?.response?.data?.detail ?? e?.message ?? "Улайлт татаж чадсангүй"); })
        .finally(() => { if (my === seq.current) setRedBusy(false); }),
      api.get("/blocked-goods", { params: { day: p.day, refresh: true }, timeout: 180000 })
        .then(r => { if (my === seq.current) setData(r.data); })
        .catch((e: any) => { if (my === seq.current) setBlockedErr(e?.response?.data?.detail ?? "Дарагдсан бараа татаж чадсангүй"); })
        .finally(() => { if (my === seq.current) setBlockedBusy(false); }),
    ]);
  }

  const busy = redBusy || blockedBusy;
  const inPull = (i: BItem) => !!pulled && (i.location ? pulled.codes.includes(i.location) : pulled.other);
  const blockedItems = useMemo(() => (data?.items ?? []).filter(inPull), [data, pulled]);
  const blockedLocs = useMemo(() => (data?.locations ?? []).filter(l => l.code ? pulled?.codes.includes(l.code) : pulled?.other), [data, pulled]);
  const hiddenOther = data && pulled && !pulled.other ? data.items.filter(i => !i.location).length : 0;
  const blockedDeals = new Set(blockedItems.flatMap(i => i.deals.map(d => d.number))).size;
  const shown = blockedItems.filter(i => !loc || keyOf(i) === loc);
  const pday = pulled?.day ?? day;

  // Хуудсууд: сонгосон байршлууд, кодоор; юу ч байхгүйг алгасна
  const pages = useMemo(() => {
    const m = new Map<string, Page>();
    for (const c of pulled?.codes ?? []) {
      m.set(c, { key: c, code: c, name: allLocs.find(l => l.code === c)?.name ?? c, red: [], blocked: [], redChecked: !!red?.locations.some(l => l.code === c) });
    }
    for (const it of red?.items ?? []) m.get(it.location)?.red.push(it);
    for (const it of blockedItems) {
      const k = keyOf(it);
      if (!m.has(k)) m.set(k, { key: k, code: it.location, name: it.location_name, red: [], blocked: [], redChecked: false });
      m.get(k)!.blocked.push(it);
    }
    return [...m.values()]
      .filter(p => p.red.length || p.blocked.length)
      .sort((a, b) => Number(!a.code) - Number(!b.code) || a.code.localeCompare(b.code) || a.name.localeCompare(b.name));
  }, [red, blockedItems, pulled, allLocs]);

  const sel = pages.some(p => p.key === printLoc) ? printLoc : "";   // шинэ татлагад алга болсон бол «бүгд»

  function print() {
    const list = pages.filter(p => !sel || p.key === sel);
    if (!list.length) return;
    const sub = `Улайлт: Эрхэтийн үлдэгдэл ${red ? ub(red.checked_at) : "—"}-ийн байдлаар · Дарагдсан: ${pday}-нд үүссэн deal`
      + (data ? ` (erxes ${ub(data.checked_at)})` : " — ачаалагдаагүй");
    const page = (p: Page) => {
      const redQty = new Map(p.red.map(r => [r.code, r.qty]));
      return `<div class="page">
<h1>${esc(p.code ? `${p.code} ${p.name}` : p.name)}</h1>
<p class="sub">${esc(sub)}</p>
<h2>Улайсан бараа — ${p.red.length}</h2>
${p.red.length ? `<table><thead><tr><th style="width:24px">№</th><th style="width:62px">Код</th><th>Нэр</th><th class="n">Эхний</th><th class="n">Орлого</th><th class="n">Зарлага</th><th class="n">Эцсийн үлдэгдэл</th></tr></thead><tbody>
${p.red.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="n">${n(r.begin_qty)}</td><td class="n">${n(r.in_qty)}</td><td class="n">${n(r.out_qty)}</td><td class="n red">${n(r.qty)}</td></tr>`).join("")}
</tbody></table>` : `<p class="none">${p.redChecked ? "Улайсан бараа алга." : "Энэ байршлын улайлтыг татаагүй."}</p>`}
<h2>Дарагдсан бараа (${esc(pday)}) — ${p.blocked.length}</h2>
${p.blocked.length ? `<table><thead><tr><th style="width:24px">№</th><th style="width:62px">Код</th><th>Нэр</th><th class="n" style="width:50px">Тоо</th><th style="width:34%">Захиалга</th></tr></thead><tbody>
${p.blocked.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.code)}</td><td>${esc(b.name)}${redQty.has(b.code) ? ` <span class="tag">улайсан ${n(redQty.get(b.code)!)}</span>` : ""}</td><td class="n">${n(b.qty)}</td><td>${esc(dealsText(b, pday))}</td></tr>`).join("")}
</tbody></table>` : `<p class="none">${data ? "Дарагдсан бараа алга." : "Дарагдсан барааны мэдээлэл ачаалагдаагүй."}</p>`}
<div class="sig"><span>Шалгасан: ____________________</span><span>Хариуцагч: ____________________</span></div>
</div>`;
    };
    const html = `<!doctype html><html lang="mn"><head><meta charset="utf-8"><title>Улайлт ба дарагдсан бараа ${esc(pday)}</title>
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
    if (!w) { setBlockedErr("Хөтөч шинэ цонх нээхийг хориглолоо."); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  async function download() {
    if (!pulled) return;
    try {
      const locations = [...pulled.codes, ...(pulled.other ? ["_other"] : [])].join(",");
      const r = await api.get("/blocked-goods/xlsx", { params: { day: pulled.day, locations }, responseType: "blob", timeout: 180000 });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url; a.download = `Дарагдсан_бараа_${pulled.day}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
    } catch { setBlockedErr("Excel татаж чадсангүй"); }
  }

  const toggle = (c: string) => setCodes(v => v.includes(c) ? v.filter(x => x !== c) : [...v, c]);
  const chip = (on: boolean) => `rounded-lg border px-2 py-1 text-xs ${on ? "border-rose-300 bg-rose-50 text-rose-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`;
  const nothing = !codes.length && !other;
  return (
    <div className="mt-6">
      <h2 className="mb-3 text-base font-semibold text-gray-900 sm:text-lg">Улайлт ба дарагдсан бараа</h2>

      <div className="mb-4 rounded-apple bg-white p-4 shadow-sm">
        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-gray-700">
          Байршил
          <button onClick={() => setCodes(allLocs.map(l => l.code))} className="font-normal text-gray-500 underline">бүгд</button>
          <button onClick={() => setCodes([])} className="font-normal text-gray-500 underline">цэвэрлэх</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {allLocs.map(l => (
            <button key={l.code} onClick={() => toggle(l.code)} className={chip(codes.includes(l.code))}>
              <span className="font-mono text-[10.5px] opacity-70">{l.code}</span> {l.name}
            </button>
          ))}
          <button onClick={() => setOther(v => !v)} className={chip(other)} title="Эрхэтийн байршилгүй department-тэй дарагдсан бараа (улайлтад хамаарахгүй)">Байршилгүй</button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            Дарагдсан барааны огноо
            <input type="date" value={day} max={todayUB()} onChange={e => { if (e.target.value) setDay(e.target.value); }}
              className="rounded-xl border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"/>
          </label>
          <button onClick={pull} disabled={busy || nothing}
            className="flex items-center gap-1.5 rounded-xl bg-gray-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin"/> : <Download size={12}/>}{busy ? "Татаж байна…" : "Татах"}
          </button>
          {pages.length > 0 && !busy && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <select value={sel} onChange={e => setPrintLoc(e.target.value)}
                className="rounded-xl border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700">
                <option value="">Бүх агуулах ({pages.length} хуудас)</option>
                {pages.map(p => (
                  <option key={p.key} value={p.key}>{p.code ? `${p.code} ` : ""}{p.name} — улайсан {p.red.length}, дарагдсан {p.blocked.length}</option>
                ))}
              </select>
              <button onClick={print}
                className="flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700">
                <Printer size={12}/>Хэвлэх
              </button>
            </div>
          )}
        </div>
        {!pulled && <p className="mt-2 text-[11px] text-gray-400">Байршлаа сонгоод «Татах» дарна уу. Байршил бүрийг Эрхэтээс тусад нь татдаг (Бөөний агуулах ~80 сек) тул цөөн сонгох тусам хурдан.</p>}
      </div>

      {pulled && (
        <div className="grid gap-4 2xl:grid-cols-2">
          {pulled.codes.length > 0 && <RedReportCard res={red} loading={redBusy} err={redErr}/>}

          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900 sm:text-base">Дарагдсан бараа — {pulled.day}</h3>
              {data && <span className="text-xs text-gray-400">{data.deals} deal · {ub(data.checked_at)}-ийн байдлаар</span>}
              <button onClick={download} disabled={!data}
                className="ml-auto flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                <Download size={12}/>Excel
              </button>
            </div>

            {blockedErr && <div className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{blockedErr}</div>}

            {!data ? (
              <div className="flex items-center gap-2 rounded-apple bg-white p-4 text-sm text-gray-500 shadow-sm">
                {blockedBusy ? <><Loader2 size={14} className="animate-spin"/>erxes-ээс {pulled.day}-нд үүссэн deal-уудыг татаж байна…</> : "Дарагдсан барааны мэдээлэл алга."}
              </div>
            ) : (
              <div className="rounded-apple bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <button onClick={() => setLoc("")}
                    className={`rounded-lg border px-2.5 py-1 text-xs ${!loc ? "border-gray-800 bg-gray-800 text-white" : "border-gray-200 text-gray-600"}`}>
                    Бүгд <b>{blockedItems.length}</b>
                  </button>
                  {blockedLocs.map(l => (
                    <button key={l.key} onClick={() => setLoc(l.key)}
                      className={`rounded-lg border px-2.5 py-1 text-xs ${loc === l.key ? "border-amber-600 bg-amber-600 text-white" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                      {l.name} <b>{l.count}</b>
                    </button>
                  ))}
                  <span className={`ml-auto flex items-center gap-1 text-xs ${blockedItems.length ? "text-amber-700" : "text-emerald-600"}`}>
                    {blockedItems.length ? <AlertTriangle size={12}/> : <CheckCircle2 size={12}/>}
                    {blockedItems.length ? `${blockedDeals} deal-д ${blockedItems.length} бараа дарагдсан` : "Дарагдсан бараа алга"}
                  </span>
                </div>
                {hiddenOther > 0 && <p className="mb-2 text-[11px] text-amber-700">Байршилгүй {hiddenOther} бараа сонголтод ороогүй — «Байршилгүй»-г сонгоод дахин татна уу.</p>}
                {Object.keys(data.errors ?? {}).length > 0 && (
                  <p className="mb-2 text-[11px] text-amber-700">Бүрэн татаж чадаагүй: {Object.keys(data.errors).join(", ")}</p>
                )}
                {shown.length > 0 && (
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
                        {shown.map(i => (
                          <tr key={keyOf(i) + i.code + i.name} className="border-t border-gray-100">
                            <td className="px-2 py-1 text-gray-500">{i.location_name}</td>
                            <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">{i.code}</td>
                            <td className="px-2 py-1 text-gray-800">{i.name}</td>
                            <td className="whitespace-nowrap px-2 py-1 text-right font-mono font-bold text-amber-700">{n(i.qty)}</td>
                            <td className="px-2 py-1 font-mono text-[11px] text-gray-500"
                              title={i.deals.map(d => `${d.number} · ${d.name} · ${n(d.qty)}`).join("\n")}>
                              {dealsText(i, pulled.day)}
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
      )}
    </div>
  );
}
