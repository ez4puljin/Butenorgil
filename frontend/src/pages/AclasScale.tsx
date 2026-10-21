import { useEffect, useRef, useState } from "react";
import {
  Scale, RefreshCw, Plus, Save, Wifi, WifiOff, KeyRound, Eye, Upload, DatabaseBackup, RotateCcw, X, AlertTriangle,
  CheckCircle2, Info, Trash2, Pencil, Printer,
} from "lucide-react";
import { api } from "../lib/api";

// Erxes барааны segment → Aclas LB1H жин. Жин рүү дэлгүүрийн PC дээрх «Aclas Agent» илгээнэ (aclas_agent/).
// Үнэ — offline POS (192.168.1.254:7000) жижиглэнгийн үнэ. Нэр — Ү→Y, Ө→О (жингийн орос фонт).

interface Settings {
  segment_ids: string[]; interval_min: number; auto_enabled: boolean; dry_run: boolean;
  label_id: number; default_valid_days: number; name_max: number; price_pos_url: string; replace_all: boolean;
}
interface ScaleRow {
  id: number; name: string; branch: string; ip: string; label_index: number; enabled: boolean;
  plu_count: number | null; state_at: string | null; managed: number; stale: number[];
  last_ping_at: string | null; last_ping_ok: boolean | null; last_sync_at: string | null;
}
interface Job {
  id: number; scale_id: number; kind: string; status: string; error: string; attempts: number; created_by: string;
  created_at: string; finished_at: string | null; summary?: Record<string, number>; verify?: any; no_change?: boolean;
}
interface Overview {
  settings: Settings; scales: ScaleRow[]; agent: { last_seen: string | null; has_token: boolean; online: boolean };
  jobs: Job[]; backups: { id: number; scale_id: number; reason: string; plu_count: number; has_label: boolean; created_at: string }[];
  last_tick_at: string | null;
}
interface Segment { _id: string; name: string; count: number }
interface PlanItem {
  plu: number; code: string; name: string; name_scale: string; price: number; valid: number; erxes_price: number | null; uom: string;
  status: "add" | "change" | "same"; warnings: string[]; diffs: string[]; manual_override: boolean;
  before: { name: string; price: string; code: string; valid: string } | null;
}
interface Plan {
  summary: Record<string, number>; items: PlanItem[]; removed: any[]; skipped: { code: string; name: string; reason: string }[];
  unmanaged: { plu: number; name: string; price: string }[]; state_known: boolean;
}

const KIND: Record<string, string> = { ping: "Холболт шалгах", backup: "Нөөцлөх", sync: "Sync", restore: "Сэргээх", label: "Шошго" };
const ST: Record<string, string> = {
  pending: "bg-gray-100 text-gray-600", running: "bg-indigo-100 text-indigo-700", done: "bg-emerald-100 text-emerald-700",
  error: "bg-rose-100 text-rose-700",
};
const ST_LABEL: Record<string, string> = { pending: "Хүлээгдэж буй", running: "Ажиллаж байна", done: "Дууссан", error: "Алдаа" };
const fmtDT = (s?: string | null) => {
  if (!s) return "—";
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("sv-SE", { timeZone: "Asia/Ulaanbaatar" }).slice(0, 16);
};
const num = (n: number | string | null | undefined) => (n == null || n === "" ? "—" : Number(n).toLocaleString("en-US"));

// ── Hotkey хуудас: LINK66-ийн товчны байрлал (мм) + erxes-ийн барааны нэр ─────────
interface HkButton { index: number; page: number; row: number; col: number; plu: number; code: string; name: string;
  from_erxes: boolean }
interface HkData {
  sheets: HkSheet[]; dead?: { index: number; plu: number }[]; hotkeys_at?: string | null; scale_items?: number;
  changes?: { index: number; old: number; new: number }[]; overflow?: number[]; known?: boolean;
}
interface HkSheet { hotkey: string; rows: number; cols: number; page_w: number; page_h: number; left: number; top: number;
  btn_w: number; btn_h: number; hgap: number; vgap: number; pages: number; buttons: HkButton[]; border?: number[][] }
const escHtml = (t: string) => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Жингийн гарны доор тавих хуудас — LINK66-тэй ижил хэмжээ (мм), Letter цаасан дээр НЭГ хуудас (эхний
 *  112 товч), хайчлах зураастай. Хэвлэхдээ «Actual size / 100%» — масштаблавал гарын нүхэнд таарахгүй. */
function hotkeyHtml(sh: HkSheet): string {
  const cells: string[] = [];
  for (let r = 0; r < sh.rows; r++) for (let c = 0; c < sh.cols; c++) {
    const b = sh.buttons.find(x => x.page === 0 && x.row === r && x.col === c);
    const x = sh.left + c * (sh.btn_w + sh.hgap), y = sh.top + r * (sh.btn_h + sh.vgap);
    cells.push(`<div class="k" style="left:${x}mm;top:${y}mm;width:${sh.btn_w}mm;height:${sh.btn_h}mm">${
      b ? `<div class="c">${b.plu}</div><div class="n">${escHtml(b.name)}</div>` : ""}</div>`);
  }
  const bd = sh.border?.length ? sh.border : [[0, 0], [sh.page_w, 0], [sh.page_w, sh.page_h], [0, sh.page_h], [0, 0]];
  const cut = `<svg class="cut" width="${sh.page_w}mm" height="${sh.page_h}mm" viewBox="0 0 ${sh.page_w} ${sh.page_h}">
    <polyline points="${bd.map(p => p.join(",")).join(" ")}" fill="none" stroke="#000" stroke-width="0.3"/></svg>`;
  const gridBottom = sh.top + sh.rows * (sh.btn_h + sh.vgap);
  const stamp = `${escHtml(sh.hotkey)} · ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Ulaanbaatar" }).slice(0, 16)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hotkey ${escHtml(sh.hotkey)}</title><style>
    @page { size: letter landscape; margin: 0; }   /* LINK66-тэй адил Letter ХЭВТЭЭ — босоо (216мм) дээр 225мм хуудас багтахгүй тул хэвлэгч ~7% жижигрүүлдэг */
    html, body { margin: 0; padding: 0; }
    body { font-family: "Segoe UI", Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .p { position: relative; width: ${sh.page_w}mm; height: ${sh.page_h}mm; margin: 5mm 0 0 5mm; }
    .cut { position: absolute; left: 0; top: 0; overflow: visible; }
    .k { position: absolute; box-sizing: border-box; border: 0.25mm solid #000; padding: 0.4mm 0.3mm; overflow: hidden; text-align: center; }
    .c { font-size: 3.5mm; line-height: 1.05; }
    .n { font-size: 3.1mm; line-height: 1.08; word-break: break-word; max-height: 6.8mm; overflow: hidden; }
    .f { position: absolute; left: 0; width: ${sh.page_w}mm; text-align: center; font-size: 3.2mm; }
  </style></head><body><section class="p">${cut}${cells.join("")}<div class="f" style="top:${gridBottom + 2}mm">${stamp}</div></section>
  <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`;
}

const EMPTY_SCALE = { id: 0, name: "", branch: "", ip: "192.168.1.", label_index: 0, enabled: true };

export default function AclasScalePage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [segs, setSegs] = useState<Segment[] | null>(null);
  const [st, setSt] = useState<Settings | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [token, setToken] = useState("");
  const [edit, setEdit] = useState<typeof EMPTY_SCALE | null>(null);
  const [plan, setPlan] = useState<{ scale: ScaleRow; plan: Plan | null; loading: boolean } | null>(null);
  const [planFilter, setPlanFilter] = useState<"changed" | "all">("changed");
  const [jobDetail, setJobDetail] = useState<any>(null);
  const [hk, setHk] = useState<{ scale: ScaleRow; cur: HkData; plan: HkData | null } | null>(null);
  async function openHotkeys(sc: ScaleRow) {
    try { setHk({ scale: sc, cur: (await api.get(`/aclas/scales/${sc.id}/hotkeys`, { timeout: 60000 })).data, plan: null }); }
    catch (e) { fail(e, "Hotkey уншиж чадсангүй"); }
  }
  async function planHotkeys() {
    if (!hk) return;
    try { const r = await api.get(`/aclas/scales/${hk.scale.id}/hotkey-plan`, { timeout: 60000 }); setHk({ ...hk, plan: r.data }); }
    catch (e) { fail(e, "Hotkey санал гаргаж чадсангүй"); }
  }
  async function applyHotkeys() {
    if (!hk?.plan) return;
    if (!confirm(`Жингийн ${hk.plan.changes?.length ?? 0} товчийг өөрчлөх үү? Жин дээр байхгүй бараатай товч чөлөөлөгдөж, товчгүй бараа хоосон товчнуудад орно.`)) return;
    try { const r = await api.post(`/aclas/scales/${hk.scale.id}/hotkey-apply`); flash(`Hotkey даалгавар #${r.data.job_id} — агент илгээнэ`); setHk(null); load(); }
    catch (e) { fail(e, "Hotkey илгээж чадсангүй"); }
  }
  const timer = useRef<number | undefined>(undefined);

  const load = () => api.get("/aclas/overview").then(r => {
    setOv(r.data);
    setSt(s => s ?? r.data.settings);
  }).catch(e => setErr(e?.response?.data?.detail ?? "Ачаалж чадсангүй"));
  useEffect(() => {
    load();
    api.get("/aclas/segments", { timeout: 60000 }).then(r => setSegs(r.data)).catch(() => setSegs([]));
    timer.current = window.setInterval(load, 8000);
    return () => window.clearInterval(timer.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const flash = (m: string) => { setMsg(m); window.setTimeout(() => setMsg(""), 4000); };
  const fail = (e: any, d: string) => setErr(e?.response?.data?.detail ?? d);

  async function saveSettings() {
    if (!st) return;
    try { const r = await api.put("/aclas/settings", st); setSt(r.data); flash("Тохиргоо хадгалагдлаа"); load(); }
    catch (e) { fail(e, "Хадгалж чадсангүй"); }
  }
  async function saveScale() {
    if (!edit) return;
    try {
      if (edit.id) await api.put(`/aclas/scales/${edit.id}`, edit); else await api.post("/aclas/scales", edit);
      setEdit(null); load();
    } catch (e) { fail(e, "Жин хадгалж чадсангүй"); }
  }
  async function act(s: ScaleRow, what: "ping" | "backup" | "sync") {
    if (what === "sync" && !confirm(`«${s.name}» жин рүү сонгосон segment-ийн барааг илгээх үү? Өмнө нь жингийн одоогийн PLU автоматаар нөөцлөгдөнө.`)) return;
    try { const r = await api.post(`/aclas/scales/${s.id}/${what}`); flash(`Даалгавар #${r.data.job_id} — агент гүйцэтгэнэ`); load(); }
    catch (e) { fail(e, "Даалгавар үүсгэж чадсангүй"); }
  }
  async function preview(s: ScaleRow) {
    setPlan({ scale: s, plan: null, loading: true });
    try { const r = await api.get(`/aclas/scales/${s.id}/preview`, { timeout: 180000 }); setPlan({ scale: s, plan: r.data, loading: false }); }
    catch (e) { fail(e, "Урьдчилан харах амжилтгүй"); setPlan(null); }
  }
  async function restore(id: number) {
    if (!confirm("Энэ нөөцийг жин рүү буцааж илгээх үү? (PLU + шошго байвал)")) return;
    try { const r = await api.post(`/aclas/backups/${id}/restore`); flash(`Сэргээх даалгавар #${r.data.job_id}`); load(); }
    catch (e) { fail(e, "Сэргээж чадсангүй"); }
  }
  async function newToken() {
    if (ov?.agent.has_token && !confirm("Шинэ token үүсгэвэл хуучин агент холбогдохоо болино. Үргэлжлүүлэх үү?")) return;
    try { setToken((await api.post("/aclas/agent-token")).data.token); load(); } catch (e) { fail(e, "Token үүсгэж чадсангүй"); }
  }

  const items = (plan?.plan?.items ?? []).filter(i => planFilter === "all" || i.status !== "same");

  return (
    <div className="flex flex-col gap-3 pb-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white"><Scale size={18}/></div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Aclas жин</h1>
          <p className="text-[12px] text-gray-500">Erxes барааны segment → жин (нэр, offline POS-ийн жижиглэнгийн үнэ, код). Жингийн дэлгэц/цэсний хэл firmware-ээс хамаарна (орос).</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {ov && (
            <span title={ov.agent.last_seen ? `Сүүлд: ${fmtDT(ov.agent.last_seen)}` : "Агент холбогдож байгаагүй"}
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold ${ov.agent.online ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
              {ov.agent.online ? <Wifi size={12}/> : <WifiOff size={12}/>}Агент {ov.agent.online ? "холбогдсон" : "холбогдоогүй"}
            </span>
          )}
          <button onClick={newToken} className="flex items-center gap-1 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-gray-600 hover:bg-gray-50">
            <KeyRound size={13}/>Агентын token
          </button>
          <button onClick={load} className="grid h-8 w-8 place-items-center rounded-xl border border-gray-200 bg-white text-gray-500 hover:bg-gray-50"><RefreshCw size={13}/></button>
        </div>
      </div>

      {err && <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700"><AlertTriangle size={13}/>{err}<button className="ml-auto" onClick={() => setErr("")}><X size={12}/></button></div>}
      {msg && <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700"><CheckCircle2 size={13}/>{msg}</div>}
      {token && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-900">
          <b>Шинэ агентын token</b> — зөвхөн одоо харагдана. <code>aclas_agent\AclasAgent.json</code>-ийн <code>token</code>-д хуулна:
          <div className="mt-1 flex items-center gap-2"><code className="select-all break-all rounded bg-white px-2 py-1 font-mono">{token}</code>
            <button onClick={() => setToken("")} className="ml-auto text-amber-700"><X size={13}/></button></div>
        </div>
      )}

      {/* Тохиргоо */}
      {st && (
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[14px] font-bold text-gray-900">Тохиргоо</h2>
            {st.dry_run && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Dry-run — жин рүү илгээхгүй</span>}
            <button onClick={saveSettings} className="ml-auto flex items-center gap-1 rounded-xl bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-700"><Save size={13}/>Хадгалах</button>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] font-semibold text-gray-500">Барааны segment (erxes) — сонгосон бүх бараа жинд орно</div>
              <div className="max-h-56 overflow-auto rounded-xl border border-gray-200 p-1.5">
                {segs === null ? <div className="p-2 text-[12px] text-gray-400">Ачаалж байна…</div> : segs.map(s => (
                  <label key={s._id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[12.5px] hover:bg-gray-50">
                    <input type="checkbox" className="accent-indigo-600" checked={st.segment_ids.includes(s._id)}
                      onChange={() => setSt({ ...st, segment_ids: st.segment_ids.includes(s._id) ? st.segment_ids.filter(x => x !== s._id) : [...st.segment_ids, s._id] })}/>
                    <span className="min-w-0 flex-1 truncate">{s.name}</span><span className="text-[11px] text-gray-400">{num(s.count)}</span>
                  </label>
                ))}
              </div>
              {st.segment_ids.some(id => (segs ?? []).find(s => s._id === id)?.count! > 2000) && (
                <div className="mt-1 text-[11px] text-amber-700">Анхаар: маш олон бараатай segment — жингийн санах ой хязгаартай байж болно.</div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] font-semibold text-gray-500">
              <label className="col-span-2">Үнийн эх сурвалж — offline POS-ийн API (жижиглэнгийн үнэ)
                <input value={st.price_pos_url} onChange={e => setSt({ ...st, price_pos_url: e.target.value })}
                  className="mt-0.5 block w-full rounded-lg border border-gray-200 px-2 py-1.5 font-mono text-[12px] font-normal text-gray-800"/>
              </label>
              <label>Автомат хуваарь (мин)
                <input type="number" min={5} value={st.interval_min} onChange={e => setSt({ ...st, interval_min: Number(e.target.value) })}
                  className="mt-0.5 block w-full rounded-lg border border-gray-200 px-2 py-1.5 text-[12px] font-normal"/>
              </label>
              <label>Хадгалах хоног — шошго хэвлэснээс хойш, бүх бараанд (0 = жин дээрхийг хөндөхгүй)
                <input type="number" min={0} value={st.default_valid_days} onChange={e => setSt({ ...st, default_valid_days: Number(e.target.value) })}
                  className="mt-0.5 block w-full rounded-lg border border-gray-200 px-2 py-1.5 text-[12px] font-normal"/>
              </label>
              <label>Шошгоны ID (Label1ID)
                <input type="number" min={0} value={st.label_id} onChange={e => setSt({ ...st, label_id: Number(e.target.value) })}
                  className="mt-0.5 block w-full rounded-lg border border-gray-200 px-2 py-1.5 text-[12px] font-normal"/>
              </label>
              <label>Нэрийн дээд урт (тэмдэгт)
                <input type="number" min={8} max={40} value={st.name_max} onChange={e => setSt({ ...st, name_max: Number(e.target.value) })}
                  className="mt-0.5 block w-full rounded-lg border border-gray-200 px-2 py-1.5 text-[12px] font-normal"/>
              </label>
              <label className="col-span-2 flex items-center gap-2 text-[12.5px] font-normal text-gray-700">
                <input type="checkbox" className="accent-indigo-600" checked={st.auto_enabled} onChange={() => setSt({ ...st, auto_enabled: !st.auto_enabled })}/>
                Автомат sync ({st.interval_min} мин тутам, өөрчлөлт байвал л илгээнэ)
              </label>
              <label className="col-span-2 flex items-start gap-2 text-[12.5px] font-normal text-gray-700">
                <input type="checkbox" className="mt-0.5 accent-rose-600" checked={st.replace_all} onChange={() => setSt({ ...st, replace_all: !st.replace_all })}/>
                <span>Segment-д ороогүй хуучин бүртгэлийг жингээс устгах <span className="text-gray-400">(жин дээр зөвхөн segment-ийн бараа үлдэнэ — агент цэвэрлээд шинэ жагсаалт илгээнэ, ~20 сек)</span></span>
              </label>
              <label className="col-span-2 flex items-center gap-2 text-[12.5px] font-normal text-gray-700">
                <input type="checkbox" className="accent-amber-600" checked={st.dry_run} onChange={() => setSt({ ...st, dry_run: !st.dry_run })}/>
                Dry-run — зөвхөн юу өөрчлөгдөхийг харуулна, жин рүү илгээхгүй
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Жингүүд */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[14px] font-bold text-gray-900">Жингүүд</h2>
          <button onClick={() => setEdit({ ...EMPTY_SCALE })} className="ml-auto flex items-center gap-1 rounded-xl border border-gray-200 px-2.5 py-1.5 text-[12px] font-semibold text-gray-700 hover:bg-gray-50"><Plus size={13}/>Жин нэмэх</button>
        </div>
        {edit && (
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl bg-gray-50 p-3 text-[11px] font-semibold text-gray-500">
            <label>Нэр<input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} className="mt-0.5 block w-40 rounded-lg border border-gray-200 px-2 py-1.5 text-[12px] font-normal"/></label>
            <label>Дэлгүүр/салбар<input value={edit.branch} onChange={e => setEdit({ ...edit, branch: e.target.value })} className="mt-0.5 block w-40 rounded-lg border border-gray-200 px-2 py-1.5 text-[12px] font-normal"/></label>
            <label>IP<input value={edit.ip} onChange={e => setEdit({ ...edit, ip: e.target.value })} className="mt-0.5 block w-36 rounded-lg border border-gray-200 px-2 py-1.5 font-mono text-[12px] font-normal"/></label>
            <label>Шошго №<input type="number" min={0} max={7} value={edit.label_index} onChange={e => setEdit({ ...edit, label_index: Number(e.target.value) })} className="mt-0.5 block w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-[12px] font-normal"/></label>
            <label className="flex items-center gap-1 pb-2 text-[12px] font-normal text-gray-700"><input type="checkbox" checked={edit.enabled} onChange={() => setEdit({ ...edit, enabled: !edit.enabled })}/>Идэвхтэй</label>
            <button onClick={saveScale} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white">Хадгалах</button>
            <button onClick={() => setEdit(null)} className="rounded-lg px-2 py-1.5 text-[12px] text-gray-500">Болих</button>
          </div>
        )}
        {(ov?.scales ?? []).length === 0 && !edit && <div className="py-6 text-center text-[12.5px] text-gray-400">Жин бүртгээгүй байна</div>}
        <div className="space-y-2">
          {ov?.scales.map(s => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 px-3 py-2.5">
              <span className={`h-2.5 w-2.5 rounded-full ${s.last_ping_ok ? "bg-emerald-500" : s.last_ping_ok === false ? "bg-rose-500" : "bg-gray-300"}`}
                title={s.last_ping_ok === false ? "Сүүлд холбогдоогүй" : s.last_ping_ok ? "Холбогдсон" : "Шалгаагүй"}/>
              <div className="min-w-0">
                <div className="text-[13.5px] font-bold text-gray-900">{s.name} {!s.enabled && <span className="text-[11px] font-normal text-gray-400">(идэвхгүй)</span>}</div>
                <div className="text-[11.5px] text-gray-500">{s.branch} · <span className="font-mono">{s.ip}</span> · шошго №{s.label_index} · жин дээр {num(s.plu_count)} PLU (sync-ээр {s.managed}) · сүүлд шалгасан {fmtDT(s.last_ping_at)} · sync {fmtDT(s.last_sync_at)}</div>
                {s.stale.length > 0 && <div className="text-[11px] text-amber-700">Хасагдах ёстой ч жин дээр үлдсэн PLU: {s.stale.join(", ")} (жин upsert хийдэг байж магадгүй)</div>}
              </div>
              <div className="ml-auto flex flex-wrap gap-1.5">
                <button onClick={() => act(s, "ping")} className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11.5px] font-semibold text-gray-600 hover:bg-gray-50"><Wifi size={12}/>Шалгах</button>
                <button onClick={() => act(s, "backup")} className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11.5px] font-semibold text-gray-600 hover:bg-gray-50"><DatabaseBackup size={12}/>Нөөцлөх</button>
                <button onClick={() => openHotkeys(s)} className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11.5px] font-semibold text-gray-600 hover:bg-gray-50"><Printer size={12}/>Hotkey</button>
                <button onClick={() => preview(s)} className="flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11.5px] font-semibold text-indigo-700 hover:bg-indigo-100"><Eye size={12}/>Урьдчилан харах</button>
                <button onClick={() => act(s, "sync")} disabled={st?.dry_run}
                  title={st?.dry_run ? "Dry-run идэвхтэй — тохиргооноос унтраана" : "Одоо sync хийх"}
                  className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"><Upload size={12}/>Одоо sync</button>
                <button onClick={() => setEdit({ id: s.id, name: s.name, branch: s.branch, ip: s.ip, label_index: s.label_index, enabled: s.enabled })} className="grid h-7 w-7 place-items-center rounded-lg text-gray-400 hover:bg-gray-100"><Pencil size={12}/></button>
                <button onClick={async () => { if (confirm(`«${s.name}» жинг жагсаалтаас устгах уу?`)) { await api.delete(`/aclas/scales/${s.id}`); load(); } }} className="grid h-7 w-7 place-items-center rounded-lg text-gray-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={12}/></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Түүх */}
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm xl:col-span-2">
          <h2 className="mb-2 text-[14px] font-bold text-gray-900">Sync-ийн түүх {ov?.last_tick_at && <span className="text-[11px] font-normal text-gray-400">· сүүлийн автомат шалгалт {fmtDT(ov.last_tick_at)}</span>}</h2>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-[11.5px]">
              <thead className="sticky top-0 bg-white text-left text-[10px] font-bold uppercase text-gray-500"><tr>
                <th className="px-2 py-1">#</th><th className="px-2 py-1">Жин</th><th className="px-2 py-1">Төрөл</th><th className="px-2 py-1">Төлөв</th>
                <th className="px-2 py-1">Нэмсэн / өөрчилсөн / хассан</th><th className="px-2 py-1">Баталгаажуулалт</th><th className="px-2 py-1">Хэн</th><th className="px-2 py-1">Хэзээ</th>
              </tr></thead>
              <tbody>{ov?.jobs.map(j => (
                <tr key={j.id} onClick={() => api.get(`/aclas/jobs/${j.id}`).then(r => setJobDetail(r.data))} className="cursor-pointer border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-2 py-1 text-gray-400">{j.id}</td>
                  <td className="px-2 py-1">{ov.scales.find(s => s.id === j.scale_id)?.name ?? j.scale_id}</td>
                  <td className="px-2 py-1">{KIND[j.kind] ?? j.kind}</td>
                  <td className="px-2 py-1"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${ST[j.status]}`}>{ST_LABEL[j.status] ?? j.status}</span>
                    {j.status === "pending" && j.attempts > 0 && <span className="ml-1 text-[10px] text-amber-700">дахин оролдоно ({j.attempts})</span>}</td>
                  <td className="px-2 py-1">{j.no_change ? <span className="text-gray-400">өөрчлөлтгүй</span> : j.summary ? `${j.summary.add ?? 0} / ${j.summary.change ?? 0} / ${j.summary.remove ?? 0}` : "—"}</td>
                  <td className="px-2 py-1">{j.verify ? (j.verify.ok ? <span className="text-emerald-700">✓ {j.verify.checked} таарсан</span> : <span className="text-rose-600">{j.verify.mismatch_n} зөрүү, {j.verify.missing?.length ?? 0} дутуу</span>) : j.error ? <span className="text-rose-600" title={j.error}>{j.error.slice(0, 50)}</span> : "—"}</td>
                  <td className="px-2 py-1 text-gray-500">{j.created_by}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-gray-500">{fmtDT(j.created_at)}</td>
                </tr>))}</tbody>
            </table>
            {!ov?.jobs.length && <div className="py-6 text-center text-[12px] text-gray-400">Даалгавар алга</div>}
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-[14px] font-bold text-gray-900">Нөөц (жингээс татсан)</h2>
          <div className="max-h-96 space-y-1 overflow-auto">
            {ov?.backups.map(b => (
              <div key={b.id} className="flex items-center gap-2 rounded-lg border border-gray-100 px-2 py-1.5 text-[11.5px]">
                <div className="min-w-0 flex-1"><div className="font-semibold">{fmtDT(b.created_at)} · {b.reason}</div>
                  <div className="text-gray-500">{ov.scales.find(s => s.id === b.scale_id)?.name} · {b.plu_count} PLU{b.has_label ? " + шошго" : ""}</div></div>
                <button onClick={() => restore(b.id)} title="Жин рүү сэргээх" className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"><RotateCcw size={11}/>Сэргээх</button>
              </div>
            ))}
            {!ov?.backups.length && <div className="py-6 text-center text-[12px] text-gray-400">Нөөц алга — «Нөөцлөх» дарна уу</div>}
          </div>
        </div>
      </div>

      {/* Урьдчилан харах */}
      {plan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={() => setPlan(null)}>
          <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
              <div><div className="text-[15px] font-bold">Урьдчилан харах — {plan.scale.name}</div>
                <div className="text-[11.5px] text-gray-500">Erxes segment + offline POS-ийн үнэ ↔ жингийн сүүлд мэдэгдсэн төлөв. Жин рүү юу ч илгээгээгүй.</div></div>
              <button onClick={() => setPlan(null)} className="ml-auto text-gray-400"><X size={16}/></button>
            </div>
            {plan.loading ? <div className="flex items-center gap-2 p-8 text-[12.5px] text-gray-400"><RefreshCw size={14} className="animate-spin"/>Erxes, offline POS-оос татаж байна…</div> : plan.plan && (
              <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
                {!plan.plan.state_known && <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800"><Info size={12} className="mr-1 inline"/>Жингийн одоогийн төлөв мэдэгдэхгүй — «Нөөцлөх» дарж агентаар татуулбал илүү нарийн харьцуулна.</div>}
                <div className="mb-3 flex flex-wrap gap-1.5 text-[12px]">
                  {[["Segment-ийн бараа", plan.plan.summary.desired, "bg-gray-100"], ["Нэмэх", plan.plan.summary.add, "bg-emerald-100 text-emerald-800"],
                    ["Өөрчлөх", plan.plan.summary.change, "bg-indigo-100 text-indigo-800"], ["Хасах", plan.plan.summary.remove, "bg-rose-100 text-rose-800"],
                    ["Өөрчлөлтгүй", plan.plan.summary.same, "bg-gray-100"], ["Алгассан", plan.plan.summary.skipped, "bg-amber-100 text-amber-800"],
                    ["Гараар оруулсан (хөндөхгүй)", plan.plan.summary.unmanaged, "bg-gray-100"]].map(([l, v, c]) => (
                    <span key={l as string} className={`rounded-lg px-2 py-1 font-semibold ${c}`}>{l}: {v as number}</span>
                  ))}
                  <span className="ml-auto flex rounded-lg bg-gray-100 p-0.5">
                    {(["changed", "all"] as const).map(f => <button key={f} onClick={() => setPlanFilter(f)} className={`rounded-md px-2 py-0.5 ${planFilter === f ? "bg-white shadow-sm" : "text-gray-500"}`}>{f === "changed" ? "Өөрчлөгдөх" : "Бүгд"}</button>)}
                  </span>
                </div>
                <table className="w-full text-[11.5px]">
                  <thead className="sticky top-0 bg-white text-left text-[10px] font-bold uppercase text-gray-500"><tr>
                    <th className="px-2 py-1">Төлөв</th><th className="px-2 py-1">PLU</th><th className="px-2 py-1">Код</th><th className="px-2 py-1">Erxes нэр</th>
                    <th className="px-2 py-1">Жин дээр одоо</th><th className="px-2 py-1">Жин рүү очих нэр</th><th className="px-2 py-1 text-right">Үнэ (₮/кг)</th><th className="px-2 py-1 text-right">Хоног</th><th className="px-2 py-1">Анхааруулга</th>
                  </tr></thead>
                  <tbody>{items.map(i => (
                    <tr key={i.plu} className="border-t border-gray-100">
                      <td className="px-2 py-1"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${i.status === "add" ? "bg-emerald-100 text-emerald-800" : i.status === "change" ? "bg-indigo-100 text-indigo-800" : "bg-gray-100 text-gray-500"}`}>{i.status === "add" ? "Нэмэх" : i.status === "change" ? "Өөрчлөх" : "Ижил"}</span></td>
                      <td className="px-2 py-1 font-mono">{i.plu}</td><td className="px-2 py-1 font-mono">{i.code}</td>
                      <td className="max-w-[220px] truncate px-2 py-1" title={i.name}>{i.name}</td>
                      <td className="px-2 py-1 text-gray-500">{i.before ? `${i.before.name} · ${num(i.before.price)}` : "—"}</td>
                      <td className="px-2 py-1 font-medium">{i.name_scale}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono" title={i.erxes_price != null ? `erxes-ийн үнэ ${num(i.erxes_price)}` : ""}>
                        {i.before && i.before.price !== String(i.price) ? <><span className="text-gray-400 line-through">{num(i.before.price)}</span> → </> : null}<b>{num(i.price)}</b></td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                        {i.before && i.before.valid !== String(i.valid) ? <><span className="text-gray-400 line-through">{i.before.valid}</span> → </> : null}<b>{i.valid}</b></td>
                      <td className="px-2 py-1 text-[10.5px] text-amber-700">{i.warnings.join("; ")}{i.manual_override ? `${i.warnings.length ? "; " : ""}гараар оруулсан PLU-г дарна` : ""}</td>
                    </tr>))}</tbody>
                </table>
                {plan.plan.removed.length > 0 && <div className="mt-3 text-[12px]"><b className="text-rose-700">Хасагдах ({plan.plan.removed.length}):</b> {plan.plan.removed.map((r: any) => `${r.plu} ${r.name}`).join(", ")}</div>}
                {plan.plan.skipped.length > 0 && <div className="mt-2 text-[12px]"><b className="text-amber-700">Алгассан ({plan.plan.skipped.length}):</b> {plan.plan.skipped.slice(0, 50).map(s => `${s.code} ${s.name} (${s.reason})`).join("; ")}{plan.plan.skipped.length > 50 ? " …" : ""}</div>}
                {plan.plan.unmanaged.length > 0 && <div className="mt-2 text-[12px] text-gray-500"><b>Жин дээр гараар оруулсан, хөндөхгүй ({plan.plan.unmanaged.length}):</b> {plan.plan.unmanaged.map(u => `${u.plu} ${u.name}`).join(", ")}</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {hk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={() => setHk(null)}>
          <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
              <div><div className="text-[15px] font-bold">Hotkey — {hk.scale.name}</div>
                <div className="text-[11.5px] text-gray-500">Жингийн өөрийн hotkey (сүүлд уншсан {fmtDT(hk.cur.hotkeys_at)}) · зөвхөн жин дээр байгаа бараа · нэр нь erxes-ийн бүртгэлээс. Letter хэвтээ, нэг хуудас, хайчлах зураастай — хэвлэхдээ масштаб 100% (Actual size), «Fit to page» биш.</div></div>
              <button onClick={() => setHk(null)} className="ml-auto text-gray-400"><X size={16}/></button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
              {(() => {
                const view = hk.plan ?? hk.cur;
                const sh = view.sheets[0];
                return (
                  <>
                    <div className="flex flex-wrap items-center gap-2 text-[12px]">
                      {hk.plan
                        ? <span className="rounded-lg bg-indigo-50 px-2 py-1 font-semibold text-indigo-800">Санал: {hk.plan.changes?.length ?? 0} товч өөрчлөгдөнө{hk.plan.overflow?.length ? ` · ${hk.plan.overflow.length} бараа товч хүрэлцээгүй` : ""}</span>
                        : <span className="text-gray-500">{sh.buttons.length} товч · жин дээр {hk.cur.scale_items} бараа</span>}
                      <div className="ml-auto flex gap-2">
                        {hk.plan
                          ? <>
                              <button onClick={() => setHk({ ...hk, plan: null })} className="rounded-lg border border-gray-200 px-3 py-1.5 font-semibold text-gray-600">Одоогийнх руу буцах</button>
                              <button onClick={applyHotkeys} disabled={!hk.plan.changes?.length}
                                className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white disabled:opacity-40"><Upload size={13}/>Жин рүү илгээх</button>
                            </>
                          : <button onClick={planHotkeys} className="flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 font-semibold text-indigo-700"><RotateCcw size={13}/>Жингийн бараагаар шинэчлэх</button>}
                        <button onClick={() => { const w = window.open("", "_blank"); if (w) { w.document.write(hotkeyHtml(sh)); w.document.close(); } }}
                          className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-700"><Printer size={13}/>Хэвлэх{hk.plan ? " (санал)" : ""}</button>
                      </div>
                    </div>
                    {!hk.plan && (hk.cur.dead?.length ?? 0) > 0 && (
                      <div className="rounded-lg bg-rose-50 px-3 py-1.5 text-[12px] text-rose-700">
                        Жин дээр байхгүй бараанд оноосон товч ({hk.cur.dead!.length}): {hk.cur.dead!.map(d => `№${d.index}→${d.plu}`).join(", ")} — хуудсанд хоосон хэвлэгдэнэ.
                        «Жингийн бараагаар шинэчлэх»-ээр чөлөөлж, жин дээрх бараагаар бөглөнө.
                      </div>
                    )}
                    {Array.from({ length: sh.pages }, (_, pg) => (
                      <div key={pg} className="overflow-auto">
                        <div className="mb-1 text-[11px] text-gray-400">Хуудас {pg + 1}</div>
                        <div className="grid border-l border-t border-gray-400" style={{ gridTemplateColumns: `repeat(${sh.cols}, minmax(64px, 1fr))` }}>
                          {Array.from({ length: sh.rows * sh.cols }, (_, i) => {
                            const b = sh.buttons.find(x => x.page === pg && x.row === Math.floor(i / sh.cols) && x.col === i % sh.cols);
                            const idx = pg * sh.rows * sh.cols + i + 1;
                            const ch = hk.plan?.changes?.find(c => c.index === idx);
                            return (
                              <div key={i} title={b ? `№${idx} · ${b.plu} · ${b.name}` : `№${idx}`}
                                className={`h-14 overflow-hidden border-b border-r border-gray-400 p-0.5 text-center text-[9.5px] leading-tight ${ch ? "bg-indigo-50" : b && !b.from_erxes ? "bg-amber-50" : ""}`}>
                                {b && <><div className="font-bold">{b.plu}</div><div>{b.name}</div></>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {jobDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={() => setJobDetail(null)}>
          <div className="max-h-full w-full max-w-3xl overflow-auto rounded-2xl bg-white p-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="mb-2 flex items-center"><b className="text-[15px]">Даалгавар #{jobDetail.id} — {KIND[jobDetail.kind] ?? jobDetail.kind}</b><button onClick={() => setJobDetail(null)} className="ml-auto text-gray-400"><X size={16}/></button></div>
            {jobDetail.error && <div className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{jobDetail.error}</div>}
            {jobDetail.result?.verify?.mismatch?.length > 0 && (
              <div className="mb-2 text-[12px]"><b>Зөрүү:</b>{jobDetail.result.verify.mismatch.map((m: any) => <div key={m.plu}>PLU {m.plu}: {m.fields.join(", ")} — хүссэн «{m.want.name}» {m.want.price}, жин дээр «{m.got.name}» {m.got.price}</div>)}</div>
            )}
            <pre className="max-h-80 overflow-auto rounded-lg bg-gray-50 p-2 text-[11px]">{(jobDetail.result?.log ?? []).join("\n") || "Лог алга"}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
