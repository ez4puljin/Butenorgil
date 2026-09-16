import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Layers, Camera, Search, Plus, Save, Trash2, Download, Check, AlertCircle, X, Loader2,
  Package, Ruler, Weight, ArrowUpFromLine, RefreshCw, Pencil, Boxes,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import BarcodeScanner from "../components/BarcodeScanner";

/* ═══════════════════════════════════════════════════════════════════════════
   Поддон хураалт — барааг поддонд хэрхэн өрөхийг тэмдэглэнэ.
   1) Загвар: поддоны урт/өргөн/өндөр, даац — гараар цөөн загвар үүсгэнэ.
   2) Бараа: баркод уншуулах/код бичих → мастерын мэдээлэл → загвар сонгож
      хайрцагны хэмжээ, нэг үеийн хайрцаг, үеийн тоог оруулахад нийт хайрцаг,
      ширхэг, жин, шалнаас дээд хайрцаг хүртэлх өндөр шууд бодогдоно.
   3) Тохиргоотой бараануудын жагсаалт + Excel экспорт.
   ═══════════════════════════════════════════════════════════════════════════ */

type Tpl = { id: number; name: string; length_cm: number; width_cm: number; height_cm: number;
  max_weight_kg: number; max_height_cm: number; note: string; used_by: number };
type Prod = { item_code: string; name: string; brand?: string; warehouse_name?: string; barcode?: string;
  pack_ratio: number; unit_weight: number; box_weight_kg?: number };
type Calc = { boxes_per_pallet: number; pcs_per_box: number; pcs_per_pallet: number; box_weight_kg: number;
  pallet_weight_kg: number; total_height_cm: number; stack_height_cm: number; pallet_length_cm: number;
  pallet_width_cm: number; layer_area_cm2: number; pallet_area_cm2: number; area_fill_pct: number | null; warnings: string[] };
type Cfg = { item_code: string; template_id: number; template_name: string; box_length_cm: number; box_width_cm: number;
  box_height_cm: number; boxes_per_layer: number; layers: number; pcs_per_box_override: number;
  box_weight_kg_override: number; note: string; updated_by: string; updated_at: string | null; product: Prod; calc: Calc };
type Form = { template_id: number; box_length_cm: string; box_width_cm: string; box_height_cm: string;
  boxes_per_layer: string; layers: string; pcs_per_box_override: string; box_weight_kg_override: string; note: string };

const EMPTY_FORM: Form = { template_id: 0, box_length_cm: "", box_width_cm: "", box_height_cm: "",
  boxes_per_layer: "", layers: "", pcs_per_box_override: "", box_weight_kg_override: "", note: "" };
const EDIT_ROLES = ["admin", "supervisor", "manager", "warehouse_clerk"];

const n = (s: string | number) => { const v = parseFloat(String(s).replace(",", ".")); return Number.isFinite(v) ? v : 0; };
const fmt = (v: number | null | undefined, d = 1) => (v == null || Number.isNaN(v) ? "—" : (Number.isInteger(v) ? v : +v.toFixed(d)).toLocaleString("mn-MN"));
const isEnter = (e: { key: string; code?: string }) => e.key === "Enter" || e.key === "Return" || e.code === "Enter" || e.code === "NumpadEnter";
const errMsg = (e: any, f: string) => (typeof e?.response?.data?.detail === "string" ? e.response.data.detail : f);

/* Frontend дээр бодох (backend calc-тай ижил томьёо) — оруулж байх үед шууд харуулна */
function calcLocal(f: Form, tpl: Tpl | undefined, p: Prod | null): Calc {
  const pcsBox = n(f.pcs_per_box_override) > 0 ? n(f.pcs_per_box_override) : (p?.pack_ratio ?? 0);
  const boxW = n(f.box_weight_kg_override) > 0 ? n(f.box_weight_kg_override) : (p?.unit_weight ?? 0) * pcsBox;
  const boxes = Math.max(0, Math.floor(n(f.boxes_per_layer))) * Math.max(0, Math.floor(n(f.layers)));
  const stack = Math.floor(n(f.layers)) * n(f.box_height_cm);
  const th = (tpl?.height_cm ?? 0) + stack;
  const layerArea = n(f.boxes_per_layer) * n(f.box_length_cm) * n(f.box_width_cm);
  const palletArea = tpl ? tpl.length_cm * tpl.width_cm : 0;
  const w: string[] = [];
  if (tpl && palletArea > 0 && layerArea > palletArea * 1.0001) w.push(`Нэг үеийн хайрцгийн талбай (${layerArea.toFixed(0)} см²) поддоны талбайгаас (${palletArea.toFixed(0)} см²) их`);
  if (tpl && tpl.max_height_cm > 0 && th > tpl.max_height_cm) w.push(`Нийт өндөр ${th.toFixed(0)} см > зөвшөөрөгдөх ${tpl.max_height_cm} см`);
  const weight = boxes * boxW;
  if (tpl && tpl.max_weight_kg > 0 && weight > tpl.max_weight_kg) w.push(`Жин ${weight.toFixed(0)} кг > даац ${tpl.max_weight_kg} кг`);
  if (pcsBox <= 0) w.push("Хайрцаг дахь ширхэг мэдэгдэхгүй (мастерт 0) — гараар оруулна уу");
  if (boxW <= 0) w.push("Хайрцагны жин мэдэгдэхгүй (мастерт жин 0) — гараар оруулна уу");
  return { boxes_per_pallet: boxes, pcs_per_box: pcsBox, pcs_per_pallet: boxes * pcsBox, box_weight_kg: boxW,
    pallet_weight_kg: weight, total_height_cm: th, stack_height_cm: stack, pallet_length_cm: tpl?.length_cm ?? 0,
    pallet_width_cm: tpl?.width_cm ?? 0, layer_area_cm2: layerArea, pallet_area_cm2: palletArea,
    area_fill_pct: palletArea > 0 ? layerArea / palletArea * 100 : null, warnings: w };
}

export default function PalletsPage() {
  const { role, baseRole } = useAuthStore();
  const canEdit = EDIT_ROLES.includes((baseRole || role || "") as string);
  const [tab, setTab] = useState<"product" | "list" | "templates">("product");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const flash = useCallback((kind: "ok" | "err", msg: string) => { setToast({ kind, msg }); setTimeout(() => setToast(null), 3500); }, []);

  // ── Загварууд ──
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const loadTpls = useCallback(async () => { try { const r = await api.get("/pallets/templates"); setTpls(r.data); } catch { /* */ } }, []);
  useEffect(() => { loadTpls(); }, [loadTpls]);
  const [tplForm, setTplForm] = useState<{ id: number | null; name: string; length_cm: string; width_cm: string; height_cm: string; max_weight_kg: string; max_height_cm: string; note: string } | null>(null);
  const saveTpl = async () => {
    if (!tplForm) return;
    const body = { name: tplForm.name, length_cm: n(tplForm.length_cm), width_cm: n(tplForm.width_cm), height_cm: n(tplForm.height_cm),
      max_weight_kg: n(tplForm.max_weight_kg), max_height_cm: n(tplForm.max_height_cm), note: tplForm.note };
    try {
      if (tplForm.id) await api.put(`/pallets/templates/${tplForm.id}`, body); else await api.post("/pallets/templates", body);
      flash("ok", "Загвар хадгалагдлаа"); setTplForm(null); loadTpls();
    } catch (e: any) { flash("err", errMsg(e, "Хадгалж чадсангүй")); }
  };
  const delTpl = async (t: Tpl) => {
    if (!confirm(`«${t.name}» загварыг устгах уу?`)) return;
    try { await api.delete(`/pallets/templates/${t.id}`); flash("ok", "Устгалаа"); loadTpls(); }
    catch (e: any) { flash("err", errMsg(e, "Устгаж чадсангүй")); }
  };

  // ── Бараа ──
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false);
  const [prod, setProd] = useState<Prod | null>(null);
  const [existing, setExisting] = useState<Cfg | null>(null);
  const [notFound, setNotFound] = useState("");
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const tpl = useMemo(() => tpls.find((t) => t.id === form.template_id), [tpls, form.template_id]);
  const live = useMemo(() => calcLocal(form, tpl, prod), [form, tpl, prod]);

  const lookup = useCallback(async (code: string) => {
    const c = code.trim(); if (!c) return;
    setBusy(true); setNotFound("");
    try {
      const r = await api.get("/pallets/lookup", { params: { q: c } });
      if (!r.data.found) { setProd(null); setExisting(null); setNotFound(c); return; }
      setProd(r.data.product);
      const cfg: Cfg | null = r.data.config;
      setExisting(cfg);
      setForm(cfg ? {
        template_id: cfg.template_id, box_length_cm: String(cfg.box_length_cm || ""), box_width_cm: String(cfg.box_width_cm || ""),
        box_height_cm: String(cfg.box_height_cm || ""), boxes_per_layer: String(cfg.boxes_per_layer || ""), layers: String(cfg.layers || ""),
        pcs_per_box_override: cfg.pcs_per_box_override ? String(cfg.pcs_per_box_override) : "",
        box_weight_kg_override: cfg.box_weight_kg_override ? String(cfg.box_weight_kg_override) : "", note: cfg.note || "",
      } : { ...EMPTY_FORM, template_id: tpls[0]?.id ?? 0 });
      setTab("product");
    } catch (e: any) { flash("err", errMsg(e, "Хайлт амжилтгүй")); }
    finally { setBusy(false); }
  }, [tpls, flash]);

  const save = async () => {
    if (!prod) return;
    setSaving(true);
    try {
      const r = await api.put(`/pallets/products/${encodeURIComponent(prod.item_code)}`, {
        template_id: form.template_id, box_length_cm: n(form.box_length_cm), box_width_cm: n(form.box_width_cm),
        box_height_cm: n(form.box_height_cm), boxes_per_layer: Math.floor(n(form.boxes_per_layer)), layers: Math.floor(n(form.layers)),
        pcs_per_box_override: n(form.pcs_per_box_override), box_weight_kg_override: n(form.box_weight_kg_override), note: form.note,
      });
      setExisting(r.data); flash("ok", `${prod.item_code} хадгалагдлаа`); loadList();
    } catch (e: any) { flash("err", errMsg(e, "Хадгалж чадсангүй")); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!prod || !confirm(`${prod.item_code} — поддоны тохиргоог устгах уу?`)) return;
    try { await api.delete(`/pallets/products/${encodeURIComponent(prod.item_code)}`); setExisting(null); setForm({ ...EMPTY_FORM, template_id: tpls[0]?.id ?? 0 }); flash("ok", "Устгалаа"); loadList(); }
    catch (e: any) { flash("err", errMsg(e, "Устгаж чадсангүй")); }
  };

  // ── Жагсаалт ──
  const [list, setList] = useState<Cfg[]>([]);
  const [listQ, setListQ] = useState("");
  const [listTpl, setListTpl] = useState<number>(0);
  const [listLoading, setListLoading] = useState(false);
  const loadList = useCallback(async () => {
    setListLoading(true);
    try { const r = await api.get("/pallets/products", { params: { q: listQ, template_id: listTpl || undefined } }); setList(r.data.items); }
    catch { /* */ } finally { setListLoading(false); }
  }, [listQ, listTpl]);
  useEffect(() => { loadList(); }, [loadList]);
  const [dl, setDl] = useState(false);
  const exportXlsx = async () => {
    setDl(true);
    try {
      const r = await api.get("/pallets/export", { params: { template_id: listTpl || undefined }, responseType: "blob" });
      const cd: string = r.headers?.["content-disposition"] || "";
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const url = URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement("a"); a.href = url; a.download = m ? decodeURIComponent(m[1]) : "poddon_huraalt.xlsx";
      document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e: any) { flash("err", errMsg(e, "Татахад алдаа")); } finally { setDl(false); }
  };

  // Render-функц (компонент БИШ): компонент болговол render бүрд шинэ төрөл үүсч
  // input дахин mount болж, нэг тоо бичих бүрд фокус/гар алга болдог.
  const F = (k: keyof Form, label: string, unit?: string, ph?: string) => (
    <label key={k} className="block text-[11px] text-gray-500">
      {label}{unit && <span className="text-gray-400"> ({unit})</span>}
      <input value={form[k] as string} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} inputMode="decimal" placeholder={ph}
        disabled={!canEdit}
        className="mt-0.5 w-full rounded-lg border border-gray-200 px-2.5 py-2 text-[14px] font-semibold text-gray-900 outline-none focus:border-emerald-400 disabled:bg-gray-50" />
    </label>
  );
  const Stat = (label: string, v: string, unit?: string, cls?: string) => (
    <div key={label} className="rounded-xl bg-white p-2.5 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</div>
      <div className={`text-[20px] font-black ${cls || "text-gray-800"}`}>{v}{unit && <span className="ml-1 text-[12px] font-semibold text-gray-400">{unit}</span>}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {toast && (
        <div className={`fixed left-3 right-3 top-3 z-[70] flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg sm:left-auto sm:right-5 sm:max-w-md ${toast.kind === "err" ? "bg-red-600" : "bg-emerald-600"}`}>
          {toast.kind === "err" ? <AlertCircle size={15} /> : <Check size={15} />}<span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}
      {scan && <BarcodeScanner onDetected={(c) => { setScan(false); lookup(c); }} onClose={() => setScan(false)} />}

      <div className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm"><Layers size={16} /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold leading-tight text-gray-900">Поддон хураалт</h1>
          <p className="truncate text-[11px] text-gray-500">Барааг поддонд хэрхэн өрөх — хайрцгийн хэмжээ, үе, нийт өндөр, жин</p>
        </div>
        <div className="flex rounded-xl bg-gray-100 p-0.5">
          {([["product", "Бараа"], ["list", `Жагсаалт${list.length ? ` (${list.length})` : ""}`], ["templates", `Загвар (${tpls.length})`]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold ${tab === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>{l}</button>
          ))}
        </div>
      </div>

      {/* ── Бараа ── */}
      {tab === "product" && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex flex-col gap-3">
            <div className="flex gap-2 rounded-2xl bg-white p-3 shadow-sm">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (isEnter(e)) { lookup(q); setQ(""); } }}
                  placeholder="Баркод эсвэл барааны код…" inputMode="search"
                  className="w-full rounded-xl border border-gray-200 py-2.5 pl-8 pr-3 text-[14px] outline-none focus:border-emerald-400" />
              </div>
              <button onClick={() => { lookup(q); setQ(""); }} disabled={busy || !q.trim()} className="rounded-xl bg-gray-900 px-3.5 text-[13px] font-semibold text-white disabled:opacity-40">
                {busy ? <Loader2 size={15} className="animate-spin" /> : "Хайх"}
              </button>
              <button onClick={() => setScan(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 text-[13px] font-semibold text-white"><Camera size={15} />Скан</button>
            </div>

            {notFound && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-center">
                <p className="text-[14px] font-bold text-gray-800">Бараа олдсонгүй</p><p className="font-mono text-[12px] text-gray-500">{notFound}</p>
              </div>
            )}
            {!prod && !notFound && (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-400">
                <Package size={30} className="mx-auto" /><p className="mt-2 text-[13px]">Баркод уншуулах эсвэл код бичээд барааг сонгоно</p>
                {tpls.length === 0 && <p className="mt-1 text-[12px] text-amber-600">Эхлээд «Загвар» таб дээр поддоны загвар үүсгэнэ үү.</p>}
              </div>
            )}

            {prod && (
              <div className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[17px] font-bold leading-snug text-gray-900">{prod.name}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-gray-500">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 font-mono font-semibold text-gray-700">{prod.item_code}</span>
                      {prod.brand && <span>{prod.brand}</span>}{prod.warehouse_name && <span>· {prod.warehouse_name}</span>}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11.5px] text-gray-500">
                      <span>Мастер: <b>{fmt(prod.pack_ratio, 0)} ш/хайрцаг</b></span>
                      <span>нэгж жин <b>{fmt(prod.unit_weight, 3)} кг</b></span>
                      <span>хайрцагны жин <b>{fmt(prod.box_weight_kg ?? prod.unit_weight * prod.pack_ratio, 2)} кг</b></span>
                    </div>
                  </div>
                  {existing && <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">Тохиргоотой</span>}
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <label className="col-span-2 block text-[11px] text-gray-500 sm:col-span-3">Поддоны загвар
                    <select value={form.template_id} onChange={(e) => setForm((f) => ({ ...f, template_id: Number(e.target.value) }))} disabled={!canEdit}
                      className="mt-0.5 w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-[13px] font-semibold text-gray-900 outline-none focus:border-emerald-400">
                      <option value={0}>— сонгох —</option>
                      {tpls.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.length_cm}×{t.width_cm}×{t.height_cm} см{t.max_weight_kg ? ` · ${t.max_weight_kg} кг` : ""}</option>)}
                    </select>
                  </label>
                  {F("box_length_cm", "Хайрцаг урт", "см")}
                  {F("box_width_cm", "Хайрцаг өргөн", "см")}
                  {F("box_height_cm", "Хайрцаг өндөр", "см")}
                  {F("boxes_per_layer", "Нэг үед хайрцаг", "ш", "жишээ 16")}
                  {F("layers", "Үе (давхар)", "", "жишээ 4")}
                  {F("pcs_per_box_override", "Ширхэг/хайрцаг засах", undefined, `мастер ${fmt(prod.pack_ratio, 0)}`)}
                  {F("box_weight_kg_override", "Хайрцагны жин засах", "кг", `мастер ${fmt(prod.unit_weight * prod.pack_ratio, 2)}`)}
                  <label className="col-span-2 block text-[11px] text-gray-500 sm:col-span-2">Тэмдэглэл
                    <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} disabled={!canEdit}
                      className="mt-0.5 w-full rounded-lg border border-gray-200 px-2.5 py-2 text-[13px] outline-none focus:border-emerald-400 disabled:bg-gray-50" />
                  </label>
                </div>

                {canEdit && (
                  <div className="mt-3 flex gap-2">
                    <button onClick={save} disabled={saving || !form.template_id}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2.5 text-[14px] font-bold text-white disabled:opacity-40">
                      {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}Хадгалах
                    </button>
                    {existing && <button onClick={remove} className="rounded-xl border border-gray-200 px-3 text-rose-600"><Trash2 size={15} /></button>}
                  </div>
                )}
                {existing && <p className="mt-2 text-[10.5px] text-gray-400">Сүүлд: {existing.updated_by} · {(existing.updated_at || "").slice(0, 16).replace("T", " ")}</p>}
              </div>
            )}
          </div>

          {/* Дүн */}
          <div className="flex flex-col gap-2">
            <div className="rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold text-amber-800"><Boxes size={14} />1 поддон дээр</div>
              <div className="grid grid-cols-2 gap-2">
                {Stat("Нийт хайрцаг", fmt(live.boxes_per_pallet, 0), "ш", "text-amber-700")}
                {Stat("Нийт ширхэг", fmt(live.pcs_per_pallet, 0), "ш", "text-amber-700")}
                {Stat("Барааны жин", fmt(live.pallet_weight_kg, 1), "кг", "text-gray-800")}
                {Stat("Хайрцагны жин", fmt(live.box_weight_kg, 2), "кг")}
              </div>
            </div>
            <div className="rounded-2xl bg-gradient-to-br from-sky-50 to-blue-50 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold text-sky-800"><Ruler size={14} />Хэмжээ</div>
              <div className="grid grid-cols-2 gap-2">
                {Stat("Шалнаас дээд хайрцаг", fmt(live.total_height_cm, 1), "см", "text-sky-700")}
                {Stat("Өрөлтийн өндөр", fmt(live.stack_height_cm, 1), "см")}
                {Stat("Урт × Өргөн", tpl ? `${fmt(tpl.length_cm, 0)}×${fmt(tpl.width_cm, 0)}` : "—", "см")}
                {Stat("Талбайн дүүргэлт", live.area_fill_pct == null ? "—" : fmt(live.area_fill_pct, 0), "%", live.area_fill_pct != null && live.area_fill_pct > 100 ? "text-rose-600" : "text-gray-800")}
              </div>
              {tpl && <p className="mt-2 text-[10.5px] text-sky-700/70">Поддон {tpl.height_cm} см + {form.layers || 0} үе × {form.box_height_cm || 0} см</p>}
            </div>
            {live.warnings.length > 0 && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-[11.5px] text-rose-700">
                {live.warnings.map((w, i) => <div key={i} className="flex gap-1.5"><AlertCircle size={13} className="mt-0.5 shrink-0" />{w}</div>)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Жагсаалт ── */}
      {tab === "list" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm">
            <div className="relative min-w-[200px] flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={listQ} onChange={(e) => setListQ(e.target.value)} placeholder="Код эсвэл нэрээр…" className="w-full rounded-xl border border-gray-200 py-2 pl-8 pr-3 text-[13px] outline-none focus:border-gray-400" />
            </div>
            <select value={listTpl} onChange={(e) => setListTpl(Number(e.target.value))} className="rounded-xl border border-gray-200 bg-white px-2.5 py-2 text-[12.5px] outline-none">
              <option value={0}>Бүх загвар</option>{tpls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button onClick={loadList} className="rounded-xl border border-gray-200 p-2 text-gray-500"><RefreshCw size={14} className={listLoading ? "animate-spin" : ""} /></button>
            <button onClick={exportXlsx} disabled={dl || list.length === 0} className="inline-flex items-center gap-1.5 rounded-xl bg-gray-900 px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40">
              {dl ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}Excel
            </button>
          </div>
          {list.length === 0 ? <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-[13px] text-gray-400">Тохиргоотой бараа алга</div> : (
            <>
              <div className="flex flex-col gap-1.5 lg:hidden">
                {list.map((c) => (
                  <button key={c.item_code} onClick={() => lookup(c.item_code)} className="rounded-xl border border-gray-100 bg-white px-3 py-2 text-left">
                    <div className="truncate text-[13px] font-semibold text-gray-800">{c.product.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-gray-500">
                      <span className="font-mono">{c.item_code}</span><span>{c.template_name}</span>
                      <span>{c.boxes_per_layer}×{c.layers} = <b>{c.calc.boxes_per_pallet} х</b></span>
                      <span><b>{fmt(c.calc.pcs_per_pallet, 0)} ш</b></span><span>{fmt(c.calc.total_height_cm, 0)} см</span><span>{fmt(c.calc.pallet_weight_kg, 0)} кг</span>
                      {c.calc.warnings.length > 0 && <span className="text-rose-600">⚠ {c.calc.warnings.length}</span>}
                    </div>
                  </button>
                ))}
              </div>
              <div className="hidden overflow-x-auto rounded-2xl border border-gray-100 bg-white lg:block">
                <table className="w-full min-w-[900px] text-[12.5px]">
                  <thead className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500"><tr>
                    {["Код", "Нэр", "Загвар", "Хайрцаг (У×Ө×Ө см)", "Үед × Үе", "Хайрцаг", "Ширхэг", "Жин кг", "Өндөр см", "Дүүргэлт", "", ""].map((h, i) => <th key={i} className={`px-3 py-2 ${i >= 5 && i <= 9 ? "text-right" : "text-left"}`}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.item_code} className="border-t border-gray-50 hover:bg-gray-50/60">
                        <td className="px-3 py-1.5 font-mono text-gray-500">{c.item_code}</td>
                        <td className="max-w-[300px] truncate px-3 py-1.5 font-medium text-gray-800">{c.product.name}</td>
                        <td className="px-3 py-1.5 text-gray-600">{c.template_name}</td>
                        <td className="px-3 py-1.5 tabular-nums text-gray-600">{fmt(c.box_length_cm, 1)}×{fmt(c.box_width_cm, 1)}×{fmt(c.box_height_cm, 1)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-gray-600">{c.boxes_per_layer} × {c.layers}</td>
                        <td className="px-3 py-1.5 text-right font-bold tabular-nums text-amber-700">{c.calc.boxes_per_pallet}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(c.calc.pcs_per_pallet, 0)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(c.calc.pallet_weight_kg, 1)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-sky-700">{fmt(c.calc.total_height_cm, 1)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${c.calc.area_fill_pct != null && c.calc.area_fill_pct > 100 ? "text-rose-600" : "text-gray-500"}`}>{c.calc.area_fill_pct == null ? "—" : `${fmt(c.calc.area_fill_pct, 0)}%`}</td>
                        <td className="px-2 py-1.5">{c.calc.warnings.length > 0 && <span title={c.calc.warnings.join("\n")} className="text-rose-600"><AlertCircle size={14} /></span>}</td>
                        <td className="px-2 py-1.5 text-right"><button onClick={() => lookup(c.item_code)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-800"><Pencil size={13} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Загвар ── */}
      {tab === "templates" && (
        <div className="flex flex-col gap-3">
          {canEdit && !tplForm && (
            <button onClick={() => setTplForm({ id: null, name: "", length_cm: "120", width_cm: "80", height_cm: "15", max_weight_kg: "", max_height_cm: "", note: "" })}
              className="inline-flex w-fit items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white"><Plus size={14} />Шинэ загвар</button>
          )}
          {tplForm && (
            <div className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="mb-2 text-[13px] font-bold text-gray-800">{tplForm.id ? "Загвар засах" : "Шинэ поддоны загвар"}</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([["name", "Нэр", "жишээ EUR 120×80"], ["length_cm", "Урт (см)", ""], ["width_cm", "Өргөн (см)", ""], ["height_cm", "Поддоны өндөр (см)", ""],
                  ["max_weight_kg", "Даац (кг, заавал биш)", ""], ["max_height_cm", "Дээд өндөр (см, заавал биш)", "шалнаас"], ["note", "Тэмдэглэл", ""]] as const).map(([k, l, ph]) => (
                  <label key={k} className={`block text-[11px] text-gray-500 ${k === "name" || k === "note" ? "col-span-2" : ""}`}>{l}
                    <input value={(tplForm as any)[k]} onChange={(e) => setTplForm((f) => f && ({ ...f, [k]: e.target.value }))} placeholder={ph}
                      inputMode={k === "name" || k === "note" ? "text" : "decimal"}
                      className="mt-0.5 w-full rounded-lg border border-gray-200 px-2.5 py-2 text-[13px] font-semibold text-gray-900 outline-none focus:border-emerald-400" />
                  </label>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={saveTpl} disabled={!tplForm.name.trim()} className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"><Save size={14} />Хадгалах</button>
                <button onClick={() => setTplForm(null)} className="rounded-xl border border-gray-200 px-4 py-2 text-[13px] text-gray-600">Болих</button>
              </div>
            </div>
          )}
          {tpls.length === 0 && !tplForm && <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-[13px] text-gray-400">Загвар алга — «Шинэ загвар» дарж үүсгэнэ үү (жишээ: EUR 120×80×15 см, 1000 кг)</div>}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {tpls.map((t) => (
              <div key={t.id} className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div><div className="text-[14px] font-bold text-gray-900">{t.name}</div>
                    <div className="mt-1 text-[12px] text-gray-600"><Ruler size={11} className="mr-1 inline" />{t.length_cm} × {t.width_cm} см · өндөр {t.height_cm} см</div>
                    <div className="text-[12px] text-gray-600"><Weight size={11} className="mr-1 inline" />{t.max_weight_kg ? `даац ${t.max_weight_kg} кг` : "даац —"}{t.max_height_cm ? <> · <ArrowUpFromLine size={11} className="inline" /> дээд {t.max_height_cm} см</> : null}</div>
                    {t.note && <div className="mt-1 text-[11px] text-gray-400">{t.note}</div>}
                    <div className="mt-1 text-[11px] text-gray-400">{t.used_by} бараа ашиглаж байна</div>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 gap-1">
                      <button onClick={() => setTplForm({ id: t.id, name: t.name, length_cm: String(t.length_cm), width_cm: String(t.width_cm), height_cm: String(t.height_cm), max_weight_kg: t.max_weight_kg ? String(t.max_weight_kg) : "", max_height_cm: t.max_height_cm ? String(t.max_height_cm) : "", note: t.note })}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-800"><Pencil size={14} /></button>
                      <button onClick={() => delTpl(t)} className="rounded-lg p-1.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={14} /></button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
