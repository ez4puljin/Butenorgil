import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Layers, Camera, Search, Plus, Save, Trash2, Download, Check, AlertCircle, X, Loader2,
  Package, Ruler, Weight, ArrowUpFromLine, RefreshCw, Pencil, Boxes, Copy, CheckSquare, Square, TrendingUp, ChevronRight,
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
  unit_weight_kg: number; pallet_weight_kg: number; total_height_cm: number; stack_height_cm: number; pallet_length_cm: number;
  pallet_width_cm: number; layer_area_cm2: number; pallet_area_cm2: number; area_fill_pct: number | null; warnings: string[] };
type Cfg = { item_code: string; template_id: number; template_name: string; box_length_cm: number; box_width_cm: number;
  box_height_cm: number; boxes_per_layer: number; layers: number; pcs_per_box_override: number;
  unit_weight_kg_override: number; box_weight_kg_override: number; note: string; updated_by: string; updated_at: string | null; product: Prod; calc: Calc };
type Form = { template_id: number; box_length_cm: string; box_width_cm: string; box_height_cm: string;
  boxes_per_layer: string; layers: string; pcs_per_box_override: string; unit_weight_kg_override: string; box_weight_kg_override: string; note: string };

type CfgCore = Pick<Cfg, "template_id" | "box_length_cm" | "box_width_cm" | "box_height_cm" | "boxes_per_layer" | "layers"
  | "pcs_per_box_override" | "unit_weight_kg_override" | "box_weight_kg_override" | "note">;
type Cand = Prod & { exact: boolean; same_pack: boolean; same_weight: boolean;
  size: string; same_size: boolean; match: boolean;
  config: null | (CfgCore & { template_name: string; same_as_source: boolean }) };
type CopyRes = { copied: Cfg[]; skipped: { item_code: string; name?: string; reason: string }[] };
type YM = { year: number; month: number };
type ProdSales = { months: (YM & { qty: number })[]; avg_monthly: number; tag: string; tags: string[]; rank: number | null; rank_total: number | null };
type WCfg = { template_id: number; template_name: string; box_length_cm: number; box_width_cm: number; box_height_cm: number;
  boxes_per_layer: number; layers: number; note: string; updated_by: string; updated_at: string | null; calc: Calc; pallets_per_month: number | null };
type WRow = { rank: number; item_code: string; name: string; brand: string; barcode: string; pack_ratio: number; unit_weight: number;
  tags: string[]; avg_monthly: number; months: number[]; configured: boolean; config: WCfg | null };
type WList = { tag: string; tags: { name: string; count: number }[]; months: YM[]; counts: { total: number; done: number; todo: number };
  total: number; items: WRow[] };

// Архины агуулах — поддон мэдээллийг борлуулалт ихээс нь эхлэн оруулна
const DEFAULT_TAG = "Архи Ус ундаа пиво";
const TAG_KEY = "pallets:worklist_tag";
const PAGE_W = 200;
const monthsLabel = (ms: YM[]) => {
  if (!ms.length) return "—";
  const years = Array.from(new Set(ms.map((m) => m.year)));
  return years.length === 1 ? `${years[0]} оны ${ms.map((m) => m.month).join(", ")}-р` : ms.map((m) => `${m.year}/${m.month}`).join(", ");
};

const EMPTY_FORM: Form = { template_id: 0, box_length_cm: "", box_width_cm: "", box_height_cm: "",
  boxes_per_layer: "", layers: "", pcs_per_box_override: "", unit_weight_kg_override: "", box_weight_kg_override: "", note: "" };
const EDIT_ROLES = ["admin", "supervisor", "manager", "warehouse_clerk"];

const n = (s: string | number) => { const v = parseFloat(String(s).replace(",", ".")); return Number.isFinite(v) ? v : 0; };
const fmt = (v: number | null | undefined, d = 1) => (v == null || Number.isNaN(v) ? "—" : (Number.isInteger(v) ? v : +v.toFixed(d)).toLocaleString("mn-MN"));
const isEnter = (e: { key: string; code?: string }) => e.key === "Enter" || e.key === "Return" || e.code === "Enter" || e.code === "NumpadEnter";
const errMsg = (e: any, f: string) => (typeof e?.response?.data?.detail === "string" ? e.response.data.detail : f);

const formFromCfg = (cfg: CfgCore, withOverrides = true): Form => ({
  template_id: cfg.template_id, box_length_cm: String(cfg.box_length_cm || ""), box_width_cm: String(cfg.box_width_cm || ""),
  box_height_cm: String(cfg.box_height_cm || ""), boxes_per_layer: String(cfg.boxes_per_layer || ""), layers: String(cfg.layers || ""),
  pcs_per_box_override: withOverrides && cfg.pcs_per_box_override ? String(cfg.pcs_per_box_override) : "",
  unit_weight_kg_override: withOverrides && cfg.unit_weight_kg_override ? String(cfg.unit_weight_kg_override) : "",
  box_weight_kg_override: withOverrides && cfg.box_weight_kg_override ? String(cfg.box_weight_kg_override) : "", note: cfg.note || "",
});

/* Frontend дээр бодох (backend calc-тай ижил томьёо) — оруулж байх үед шууд харуулна */
function calcLocal(f: Form, tpl: Tpl | undefined, p: Prod | null): Calc {
  const pcsBox = n(f.pcs_per_box_override) > 0 ? n(f.pcs_per_box_override) : (p?.pack_ratio ?? 0);
  const unitW = n(f.unit_weight_kg_override) > 0 ? n(f.unit_weight_kg_override) : (p?.unit_weight ?? 0);
  const boxW = n(f.box_weight_kg_override) > 0 ? n(f.box_weight_kg_override) : unitW * pcsBox;
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
  return { boxes_per_pallet: boxes, pcs_per_box: pcsBox, pcs_per_pallet: boxes * pcsBox, unit_weight_kg: unitW, box_weight_kg: boxW,
    pallet_weight_kg: weight, total_height_cm: th, stack_height_cm: stack, pallet_length_cm: tpl?.length_cm ?? 0,
    pallet_width_cm: tpl?.width_cm ?? 0, layer_area_cm2: layerArea, pallet_area_cm2: palletArea,
    area_fill_pct: palletArea > 0 ? layerArea / palletArea * 100 : null, warnings: w };
}

/* ═══ Поддоны тохиргоог өөр кодтой бараанд хуулах ═══
   1) Юуг хуулах — талбар бүрийг сонгоно (загвар, хайрцагны хэмжээ, үе, засварууд, тэмдэглэл).
   2) Хаана хуулах — мастерын БҮХ барааны жагсаалтаас (хайлт, брэнд, ижил хэмжээтэй шүүлт). */
const STALE_SERVER = "Сервер шинэчлэгдээгүй байна — «хуулах» боломж серверийг дахин асаасны дараа ажиллана.";

type CopyField = "template" | "box_dims" | "boxes_per_layer" | "layers" | "pcs_per_box" | "unit_weight" | "box_weight" | "note";
const REQUIRED_NEW: CopyField[] = ["template", "box_dims", "boxes_per_layer", "layers"];
const FIELD_KEYS: Record<CopyField, (keyof Form)[]> = {
  template: ["template_id"], box_dims: ["box_length_cm", "box_width_cm", "box_height_cm"], boxes_per_layer: ["boxes_per_layer"],
  layers: ["layers"], pcs_per_box: ["pcs_per_box_override"], unit_weight: ["unit_weight_kg_override"],
  box_weight: ["box_weight_kg_override"], note: ["note"],
};
const FIELD_META: { key: CopyField; label: string; value: (c: Cfg) => string }[] = [
  { key: "template", label: "Поддоны загвар", value: (c) => c.template_name || "—" },
  { key: "box_dims", label: "Хайрцагны хэмжээ", value: (c) => `${fmt(c.box_length_cm)}×${fmt(c.box_width_cm)}×${fmt(c.box_height_cm)} см` },
  { key: "boxes_per_layer", label: "Нэг үеийн хайрцаг", value: (c) => `${c.boxes_per_layer} ш` },
  { key: "layers", label: "Үеийн тоо", value: (c) => `${c.layers} үе` },
  { key: "pcs_per_box", label: "Ширхэг/хайрцаг", value: (c) => (c.pcs_per_box_override ? `${fmt(c.pcs_per_box_override, 0)} ш` : "мастераас") },
  { key: "unit_weight", label: "Хувийн жин", value: (c) => (c.unit_weight_kg_override ? `${fmt(c.unit_weight_kg_override, 3)} кг` : "мастераас") },
  { key: "box_weight", label: "Хайрцагны жин", value: (c) => (c.box_weight_kg_override ? `${fmt(c.box_weight_kg_override, 2)} кг` : "бодолтоор") },
  { key: "note", label: "Тэмдэглэл", value: (c) => c.note || "хоосон" },
];
const LAYOUT_ONLY: Record<CopyField, boolean> = { template: true, box_dims: true, boxes_per_layer: true, layers: true,
  pcs_per_box: false, unit_weight: false, box_weight: false, note: false };
const ALL_FIELDS: Record<CopyField, boolean> = { template: true, box_dims: true, boxes_per_layer: true, layers: true,
  pcs_per_box: true, unit_weight: true, box_weight: true, note: true };
type Scope = "all" | "brand" | "match";
const PAGE = 100;

/* Цонхны доторх алдаа бүх хуудсыг цагаан болгохгүй — зөвхөн энэ цонхонд мэдэгдэнэ */
class CopyBoundary extends Component<{ onClose: () => void; children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error("CopyModal error:", err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4" onClick={this.props.onClose}>
        <div className="w-full max-w-sm rounded-2xl bg-white p-5 text-center shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <AlertCircle size={28} className="mx-auto text-rose-500" />
          <p className="mt-2 text-[14px] font-bold text-gray-800">Хуулах цонхонд алдаа гарлаа</p>
          <p className="mt-1 text-[12px] text-gray-500">{this.state.err.message}</p>
          <button onClick={this.props.onClose} className="mt-4 w-full rounded-xl bg-gray-900 py-2.5 text-[14px] font-bold text-white">Хаах</button>
        </div>
      </div>
    );
  }
}

function CopyModal({ src, cfg, tpls, onClose, onDone }: {
  src: Prod; cfg: Cfg; tpls: Tpl[]; onClose: () => void; onDone: () => void;
}) {
  const [fields, setFields] = useState<Record<CopyField, boolean>>(LAYOUT_ONLY);
  // Утсан дээр талбарын сонголт 240px эзэлдэг — анхдагчаар нэг мөрөөр хураагдсан
  const [fieldsOpen, setFieldsOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 640);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [onlyNew, setOnlyNew] = useState(false);
  const [items, setItems] = useState<Cand[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Record<string, Cand>>({});
  const [overwrite, setOverwrite] = useState(false);
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [res, setRes] = useState<CopyRes | null>(null);
  const reqId = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const srcForm = useMemo(() => formFromCfg(cfg), [cfg]);
  const chosen = FIELD_META.filter((f) => fields[f.key]).map((f) => f.key);
  const fullNew = REQUIRED_NEW.every((k) => fields[k]);

  const load = useCallback(async (text: string, offset: number, autoPick = false) => {
    const id = ++reqId.current;
    setLoading(true); setErr("");
    try {
      const r = await api.get("/pallets/copy-candidates", { params: {
        source: src.item_code, q: text.trim(), scope, unconfigured: onlyNew || undefined, offset, limit: PAGE } });
      if (id !== reqId.current) return;                       // хуучирсан хариу
      // Хуучин сервер (endpoint-гүй) index.html буцаадаг — массив биш бол унагахгүй, мэдэгдэнэ
      if (!Array.isArray(r.data?.items)) { setItems([]); setTotal(0); setErr(STALE_SERVER); return; }
      const list: Cand[] = r.data.items;
      setItems((prev) => (offset > 0 ? [...prev, ...list] : list));
      setTotal(Number(r.data.total) || 0);
      const hit = autoPick ? list.find((c) => c.exact) : undefined;   // баркод/код яг таарвал шууд сонгоно
      if (hit) setSel((s) => ({ ...s, [hit.item_code]: hit }));
    } catch (e: any) { if (id === reqId.current) setErr(errMsg(e, "Жагсаалт ачаалж чадсангүй")); }
    finally { if (id === reqId.current) setLoading(false); }
  }, [src.item_code, scope, onlyNew]);
  // Хүрээ/шүүлт солигдоход одоогийн хайлтаар дахин ачаална
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(q, 0); }, [load]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onType = (v: string) => { setQ(v); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => load(v, 0), 300); };
  const searchNow = (v: string) => { window.clearTimeout(timer.current); load(v, 0, true); };

  const toggle = (c: Cand) => setSel((s) => { const x = { ...s }; if (x[c.item_code]) delete x[c.item_code]; else x[c.item_code] = c; return x; });
  const picked = Object.values(sel);
  const selectAll = async () => {
    setNote("");
    let list = items;
    if (items.length < total) {
      try {
        const r = await api.get("/pallets/copy-candidates", { params: {
          source: src.item_code, q: q.trim(), scope, unconfigured: onlyNew || undefined, offset: 0, limit: 300 } });
        if (Array.isArray(r.data?.items)) list = r.data.items;
      } catch { /* ачаалсан хэсгийг л сонгоно */ }
      if (total > list.length) setNote(`Нэг удаад 300 хүртэл — эхний ${list.length}-г сонгосон`);
    }
    setSel((s) => { const x = { ...s }; list.forEach((c) => { x[c.item_code] = c; }); return x; });
  };

  // Бараа бүрд юу болохыг урьдчилан бодно (сервер дээрхтэй ижил дүрэм)
  const plan = (c: Cand): { skip: string } | { k: Calc } => {
    if (c.config && !overwrite) return { skip: "тохиргоотой — солихыг сонгоогүй" };
    if (!c.config && !fullNew) return { skip: "тохиргоогүй — загвар, хэмжээ, үе хэрэгтэй" };
    const f: Form = c.config ? formFromCfg(c.config) : { ...EMPTY_FORM };
    chosen.forEach((k) => FIELD_KEYS[k].forEach((key) => { (f as any)[key] = srcForm[key]; }));
    return { k: calcLocal(f, tpls.find((t) => t.id === f.template_id), c) };
  };
  const plans = picked.map((c) => ({ c, p: plan(c) }));
  const willCopy = plans.filter((x) => "k" in x.p).length;
  const withCfg = picked.filter((c) => c.config).length;
  const noCfgSkipped = !fullNew ? picked.filter((c) => !c.config).length : 0;

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api.post(`/pallets/products/${encodeURIComponent(src.item_code)}/copy`,
        { targets: picked.map((c) => c.item_code), fields: chosen, overwrite });
      if (!Array.isArray(r.data?.copied)) { setErr(STALE_SERVER); return; }
      setRes({ copied: r.data.copied, skipped: Array.isArray(r.data.skipped) ? r.data.skipped : [] }); onDone();
    } catch (e: any) { setErr(errMsg(e, "Хуулж чадсангүй")); }
    finally { setBusy(false); }
  };

  const badges = (c: Cand) => (
    <>
      {c.brand && <span className="max-w-[160px] truncate text-gray-400">{c.brand}</span>}
      {c.size && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${c.same_size ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>{c.size}</span>}
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${c.same_pack ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>{fmt(c.pack_ratio, 0)} ш/хайрцаг</span>
      {c.config && (c.config.same_as_source
        ? <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">ижил тохиргоотой</span>
        : <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
            тохиргоотой: {c.config.template_name} · {fmt(c.config.box_length_cm)}×{fmt(c.config.box_width_cm)}×{fmt(c.config.box_height_cm)} · {c.config.boxes_per_layer}×{c.config.layers}
          </span>)}
    </>
  );
  const scopeBtn = (k: Scope, label: string) => (
    <button key={k} onClick={() => setScope(k)}
      className={`rounded-lg px-2.5 py-1 text-[12px] font-semibold ${scope === k ? "bg-violet-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>{label}</button>
  );

  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      {scan && <BarcodeScanner onDetected={(c) => { setScan(false); setQ(c); searchNow(c); }} onClose={() => setScan(false)} />}
      <div className="flex max-h-[96vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-gray-100 px-4 py-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet-600 text-white"><Copy size={16} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-gray-900">Поддоны тохиргоо хуулах</div>
            <div className="truncate text-[12px] text-gray-600">Эх бараа: <span className="font-mono font-semibold">{src.item_code}</span> · {src.name}</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X size={16} /></button>
        </div>

        {res ? (
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-[14px] font-bold text-emerald-800"><Check size={16} />{res.copied.length} бараанд хуулсан</div>
            <div className="mt-1 text-[11.5px] text-gray-500">Хуулсан: {FIELD_META.filter((f) => chosen.includes(f.key)).map((f) => f.label).join(", ")}</div>
            {res.copied.length > 0 && (
              <div className="mt-2 divide-y divide-gray-50 rounded-xl border border-gray-100">
                {res.copied.map((c) => (
                  <div key={c.item_code} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                    <span className="font-mono text-gray-500">{c.item_code}</span>
                    <span className="min-w-0 flex-1 truncate text-gray-800">{c.product.name}</span>
                    <span className="shrink-0 tabular-nums text-gray-500">{c.calc.boxes_per_pallet} х · {fmt(c.calc.pcs_per_pallet, 0)} ш · {fmt(c.calc.pallet_weight_kg, 0)} кг</span>
                    {c.calc.warnings.length > 0 && <span title={c.calc.warnings.join(" · ")} className="text-rose-600"><AlertCircle size={13} /></span>}
                  </div>
                ))}
              </div>
            )}
            {res.skipped.length > 0 && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                <div className="mb-1 font-semibold">Алгассан {res.skipped.length}:</div>
                {res.skipped.map((x) => <div key={x.item_code}>• <span className="font-mono">{x.item_code}</span> {x.name} — {x.reason}</div>)}
              </div>
            )}
            <button onClick={onClose} className="mt-4 w-full rounded-xl bg-gray-900 py-2.5 text-[14px] font-bold text-white">Хаах</button>
          </div>
        ) : (
          <>
            {/* 1. Юуг хуулах */}
            <div className="border-b border-gray-100 px-4 py-2.5">
              <div className={`flex items-center gap-2 ${fieldsOpen ? "mb-1.5" : ""}`}>
                <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-gray-500">1. Юуг хуулах</span>
                {fieldsOpen ? (
                  <>
                    <span className="flex-1" />
                    <button onClick={() => setFields(LAYOUT_ONLY)} className="text-[11.5px] font-semibold text-violet-600 hover:underline">Хэмжээ, өрөлт</button>
                    <button onClick={() => setFields(ALL_FIELDS)} className="text-[11.5px] font-semibold text-violet-600 hover:underline">Бүгд</button>
                  </>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">
                    {chosen.length ? FIELD_META.filter((f) => fields[f.key]).map((f) => f.label).join(", ") : <span className="text-rose-600">сонгоогүй</span>}
                  </span>
                )}
                <button onClick={() => setFieldsOpen((v) => !v)} className="shrink-0 rounded-lg bg-gray-100 px-2 py-0.5 text-[11.5px] font-semibold text-gray-600 hover:bg-gray-200">
                  {fieldsOpen ? "Хураах" : "Өөрчлөх"}
                </button>
              </div>
              {fieldsOpen && <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {FIELD_META.map((f) => {
                  const on = fields[f.key];
                  return (
                    <button key={f.key} onClick={() => setFields((s) => ({ ...s, [f.key]: !s[f.key] }))}
                      className={`flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-left ${on ? "border-violet-300 bg-violet-50" : "border-gray-200 bg-white hover:bg-gray-50"}`}>
                      <span className={`mt-px shrink-0 ${on ? "text-violet-600" : "text-gray-300"}`}>{on ? <CheckSquare size={14} /> : <Square size={14} />}</span>
                      <span className="min-w-0">
                        <span className={`block text-[11.5px] font-semibold leading-tight ${on ? "text-violet-900" : "text-gray-600"}`}>{f.label}</span>
                        <span className="block truncate text-[10.5px] text-gray-500">{f.value(cfg)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>}
              {fieldsOpen && !fullNew && <p className="mt-1.5 text-[11px] text-amber-700">Поддоны тохиргоогүй бараанд шинээр үүсгэхэд загвар, хайрцагны хэмжээ, нэг үеийн хайрцаг, үеийн тоо заавал — эдгээрийг сонгоогүй бол зөвхөн тохиргоотой бараа шинэчлэгдэнэ.</p>}
            </div>

            {/* 2. Хаана хуулах — бүх бараа */}
            <div className="px-4 pt-2.5">
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-500">2. Аль бараанд хуулах</div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={q} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => { if (isEnter(e)) searchNow(q); }}
                    placeholder="Бүх бараанаас: код, нэр, баркод…" inputMode="search"
                    className="w-full rounded-xl border border-gray-200 py-2.5 pl-8 pr-8 text-[14px] outline-none focus:border-violet-400" />
                  {q && <button onClick={() => { setQ(""); searchNow(""); }} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-700"><X size={14} /></button>}
                </div>
                <button onClick={() => setScan(true)} title="Баркод уншуулах" className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-[13px] font-semibold text-white"><Camera size={15} /></button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {scopeBtn("all", "Бүх бараа")}
                {scopeBtn("brand", "Ижил брэнд")}
                {scopeBtn("match", "Ижил хэмжээтэй")}
                <label className="ml-1 inline-flex items-center gap-1 text-[12px] text-gray-600">
                  <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />Тохиргоогүйг л
                </label>
                <span className="flex-1" />
                <span className="text-[11.5px] text-gray-500">{loading ? <Loader2 size={12} className="inline animate-spin" /> : `${total.toLocaleString("mn-MN")} бараа`}</span>
                {total > 0 && <button onClick={selectAll} className="rounded-lg bg-gray-100 px-2 py-1 text-[11.5px] font-semibold text-gray-600 hover:bg-gray-200">Бүгдийг сонгох</button>}
              </div>
            </div>
            <div className="min-h-[120px] flex-1 overflow-y-auto px-4 pb-2 pt-1">
              {items.length === 0 && !loading && !err && (
                <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-[12.5px] text-gray-400">Бараа олдсонгүй</div>
              )}
              <div className="divide-y divide-gray-50">
                {items.map((c) => {
                  const on = !!sel[c.item_code];
                  return (
                    <button key={c.item_code} onClick={() => toggle(c)} className={`flex w-full items-start gap-2.5 px-1 py-1.5 text-left ${on ? "bg-violet-50/60" : "hover:bg-gray-50"}`}>
                      <span className={`mt-0.5 shrink-0 ${on ? "text-violet-600" : "text-gray-300"}`}>{on ? <CheckSquare size={17} /> : <Square size={17} />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-gray-800">{c.name}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-gray-500">
                          <span className="font-mono">{c.item_code}</span>{badges(c)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {items.length < total && (
                <button onClick={() => load(q, items.length)} disabled={loading}
                  className="mt-2 w-full rounded-xl border border-gray-200 py-2 text-[12.5px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                  {loading ? "Ачаалж байна…" : `Цааш харах (${items.length.toLocaleString("mn-MN")} / ${total.toLocaleString("mn-MN")})`}
                </button>
              )}
            </div>

            {picked.length > 0 && (
              <div className="max-h-[24vh] shrink-0 overflow-y-auto border-t border-gray-100 bg-gray-50/70 px-4 py-2">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Сонгосон {picked.length} — хуулсны дараах дүн</span>
                  <span className="flex-1" />
                  <button onClick={() => { setSel({}); setNote(""); }} className="text-[11.5px] font-semibold text-rose-600 hover:underline">Цэвэрлэх</button>
                </div>
                {plans.map(({ c, p }) => (
                  <div key={c.item_code} className="flex items-center gap-2 py-0.5 text-[12px]">
                    <span className="font-mono text-gray-500">{c.item_code}</span>
                    <span className="min-w-0 flex-1 truncate text-gray-800">{c.name}</span>
                    {"k" in p ? (
                      <>
                        <span className="shrink-0 tabular-nums text-gray-600">{p.k.boxes_per_pallet} х · {fmt(p.k.pcs_per_pallet, 0)} ш · {fmt(p.k.pallet_weight_kg, 0)} кг</span>
                        {p.k.warnings.length > 0 && <span title={p.k.warnings.join(" · ")} className="text-rose-600"><AlertCircle size={13} /></span>}
                      </>
                    ) : <span className="shrink-0 text-[11px] text-amber-700">алгасна: {p.skip}</span>}
                    <button onClick={() => toggle(c)} className="rounded p-0.5 text-gray-400 hover:text-rose-600"><X size={13} /></button>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-gray-100 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-2">
              {withCfg > 0 && (
                <label className="flex items-start gap-2 py-1 text-[12.5px] text-gray-700">
                  <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} className="mt-0.5" />
                  <span>Тохиргоотой {withCfg} барааны сонгосон утгуудыг солих<span className="block text-[11px] text-gray-400">Сонгоогүй талбарууд нь хэвээр үлдэнэ; тэмдэглэгээгүй бол алгасна</span></span>
                </label>
              )}
              {noCfgSkipped > 0 && <p className="py-0.5 text-[11px] text-amber-700">Тохиргоогүй {noCfgSkipped} бараа алгасагдана (загвар, хэмжээ, үеийг сонгоогүй)</p>}
              {note && <p className="py-0.5 text-[11px] text-gray-500">{note}</p>}
              {picked.length > 300 && <p className="py-0.5 text-[11px] text-rose-600">Нэг удаад 300 хүртэл бараа хуулна — сонголтоо цөөлнө үү</p>}
              {err && <div className="my-1 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600">{err}</div>}
              <button onClick={submit} disabled={busy || willCopy === 0 || chosen.length === 0 || picked.length > 300}
                className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 py-2.5 text-[14px] font-bold text-white disabled:opacity-40">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Copy size={15} />}
                {chosen.length === 0 ? "Юуг хуулахаа сонгоно уу" : picked.length === 0 ? "Бараа сонгоно уу" : `${willCopy} бараанд хуулах (${chosen.length} талбар)`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
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
  const [sales, setSales] = useState<ProdSales | null>(null);
  const tpl = useMemo(() => tpls.find((t) => t.id === form.template_id), [tpls, form.template_id]);
  const live = useMemo(() => calcLocal(form, tpl, prod), [form, tpl, prod]);

  // lookup нь жагсаалтын state-ээс хамааралгүй байхаар ref-ээр дамжуулна (жагсаалт доор тодорхойлогдоно)
  const tagRef = useRef(DEFAULT_TAG);
  const findNextRef = useRef<(code: string) => void>(() => {});
  const lookup = useCallback(async (code: string): Promise<boolean> => {
    const c = code.trim(); if (!c) return false;
    setBusy(true); setNotFound("");
    try {
      const r = await api.get("/pallets/lookup", { params: { q: c, tag: tagRef.current } });
      if (!r.data.found) { setProd(null); setExisting(null); setSales(null); setNotFound(c); return false; }
      setProd(r.data.product);
      setSales(r.data.sales && Array.isArray(r.data.sales.months) ? r.data.sales : null);
      findNextRef.current(r.data.product.item_code);
      const cfg: Cfg | null = r.data.config;
      setExisting(cfg);
      setForm(cfg ? formFromCfg(cfg) : { ...EMPTY_FORM, template_id: tpls[0]?.id ?? 0 });
      setTab("product");
      return true;
    } catch (e: any) { flash("err", errMsg(e, "Хайлт амжилтгүй")); return false; }
    finally { setBusy(false); }
  }, [tpls, flash]);
  // Хуулах — зөвхөн ХАДГАЛСАН тохиргоог хуулна (засаад хадгалаагүй бол эхлээд хадгална)
  const [copyOpen, setCopyOpen] = useState(false);
  const dirty = useMemo(() => !!existing && JSON.stringify(formFromCfg(existing)) !== JSON.stringify(form), [existing, form]);
  const openCopy = async (code: string) => { if (await lookup(code)) setCopyOpen(true); };

  const save = async () => {
    if (!prod) return;
    setSaving(true);
    try {
      const r = await api.put(`/pallets/products/${encodeURIComponent(prod.item_code)}`, {
        template_id: form.template_id, box_length_cm: n(form.box_length_cm), box_width_cm: n(form.box_width_cm),
        box_height_cm: n(form.box_height_cm), boxes_per_layer: Math.floor(n(form.boxes_per_layer)), layers: Math.floor(n(form.layers)),
        pcs_per_box_override: n(form.pcs_per_box_override), unit_weight_kg_override: n(form.unit_weight_kg_override), box_weight_kg_override: n(form.box_weight_kg_override), note: form.note,
      });
      setExisting(r.data); flash("ok", `${prod.item_code} хадгалагдлаа`); loadList(); findNext(prod.item_code);
    } catch (e: any) { flash("err", errMsg(e, "Хадгалж чадсангүй")); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!prod || !confirm(`${prod.item_code} — поддоны тохиргоог устгах уу?`)) return;
    try { await api.delete(`/pallets/products/${encodeURIComponent(prod.item_code)}`); setExisting(null); setForm({ ...EMPTY_FORM, template_id: tpls[0]?.id ?? 0 }); flash("ok", "Устгалаа"); loadList(); }
    catch (e: any) { flash("err", errMsg(e, "Устгаж чадсангүй")); }
  };

  // ── Жагсаалт (ажлын): tag-ийн бүх бараа борлуулалтын эрэмбээр, оруулсан/оруулаагүй ──
  const [wTag, setWTag] = useState<string>(() => { try { return localStorage.getItem(TAG_KEY) ?? DEFAULT_TAG; } catch { return DEFAULT_TAG; } });
  const [wStatus, setWStatus] = useState<"all" | "todo" | "done">("all");
  const [wQ, setWQ] = useState("");
  const [wLimit, setWLimit] = useState(PAGE_W);
  const [wl, setWl] = useState<WList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const r = await api.get("/pallets/worklist", { params: { tag: wTag, status: wStatus, q: wQ, limit: wLimit } });
      if (Array.isArray(r.data?.items)) setWl(r.data);
    } catch { /* */ } finally { setListLoading(false); }
  }, [wTag, wStatus, wQ, wLimit]);
  useEffect(() => { const t = setTimeout(loadList, 250); return () => clearTimeout(t); }, [loadList]);
  useEffect(() => { try { localStorage.setItem(TAG_KEY, wTag); } catch { /* private mode */ } }, [wTag]);
  const [dl, setDl] = useState(false);
  const exportXlsx = async () => {
    setDl(true);
    try {
      const r = await api.get("/pallets/export", { params: { tag: wTag, status: wStatus }, responseType: "blob" });
      const cd: string = r.headers?.["content-disposition"] || "";
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const url = URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement("a"); a.href = url; a.download = m ? decodeURIComponent(m[1]) : "poddon_huraalt.xlsx";
      document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e: any) { flash("err", errMsg(e, "Татахад алдаа")); } finally { setDl(false); }
  };
  tagRef.current = wTag;
  // Дараагийн оруулаагүй бараа (борлуулалт ихээс) — нэг нэгээр хурдан оруулахад
  const [nextTodo, setNextTodo] = useState<WRow | null>(null);
  const findNext = useCallback(async (current: string) => {
    try {
      const r = await api.get("/pallets/worklist", { params: { tag: wTag, status: "todo", limit: 3 } });
      const items: WRow[] = Array.isArray(r.data?.items) ? r.data.items : [];
      setNextTodo(items.find((x) => x.item_code !== current) ?? null);
    } catch { setNextTodo(null); }
  }, [wTag]);
  findNextRef.current = findNext;

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
      {copyOpen && prod && existing && (
        <CopyBoundary onClose={() => setCopyOpen(false)}>
          <CopyModal src={prod} cfg={existing} tpls={tpls} onClose={() => setCopyOpen(false)} onDone={() => { loadList(); loadTpls(); }} />
        </CopyBoundary>
      )}

      <div className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm"><Layers size={16} /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold leading-tight text-gray-900">Поддон хураалт</h1>
          <p className="truncate text-[11px] text-gray-500">Барааг поддонд хэрхэн өрөх — хайрцгийн хэмжээ, үе, нийт өндөр, жин</p>
        </div>
        <div className="flex rounded-xl bg-gray-100 p-0.5">
          {([["product", "Бараа"], ["list", `Жагсаалт${wl ? ` (${wl.counts.done}/${wl.counts.total})` : ""}`], ["templates", `Загвар (${tpls.length})`]] as const).map(([k, l]) => (
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
                {sales && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900">
                    <TrendingUp size={14} className="shrink-0 text-emerald-600" />
                    <span>Сарын дундаж <b>{fmt(sales.avg_monthly, 0)} ш</b></span>
                    <span>→ <b className="text-[14px]">{live.pcs_per_pallet > 0 ? fmt(sales.avg_monthly / live.pcs_per_pallet, 1) : "—"}</b> поддон/сар</span>
                    {sales.rank != null && <span className="ml-auto text-[11px] text-emerald-700">#{sales.rank} / {sales.rank_total} · {sales.tag}</span>}
                  </div>
                )}

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
                  {F("unit_weight_kg_override", "Хувийн жин (1 ш)", "кг", `мастер ${fmt(prod.unit_weight, 3)}`)}
                  {F("box_weight_kg_override", "Хайрцагны жин засах", "кг", `бодолт ${fmt(live.unit_weight_kg * live.pcs_per_box, 2)}`)}
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
                {canEdit && existing && (
                  <button onClick={() => setCopyOpen(true)} disabled={dirty} title={dirty ? "Өөрчлөлтөө эхлээд хадгална уу" : ""}
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-violet-200 bg-violet-50 py-2 text-[13px] font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-50">
                    <Copy size={14} />Өөр бараанд хуулах
                  </button>
                )}
                {canEdit && existing && dirty && <p className="mt-1 text-center text-[10.5px] text-amber-600">Хадгалаагүй өөрчлөлт байна — хуулахаас өмнө хадгална уу</p>}
                {existing && <p className="mt-2 text-[10.5px] text-gray-400">Сүүлд: {existing.updated_by} · {(existing.updated_at || "").slice(0, 16).replace("T", " ")}</p>}
                {canEdit && nextTodo && nextTodo.item_code !== prod.item_code && (
                  <button onClick={() => lookup(nextTodo.item_code)} disabled={dirty}
                    title={dirty ? "Өөрчлөлтөө эхлээд хадгална уу" : "Борлуулалт ихээс — дараагийн поддон мэдээлэл оруулаагүй бараа"}
                    className="mt-2 flex w-full items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-left text-[12.5px] text-amber-900 hover:bg-amber-100 disabled:opacity-50">
                    <span className="shrink-0 text-[11px] font-semibold text-amber-700">Дараагийн оруулаагүй</span>
                    <span className="min-w-0 flex-1 truncate font-semibold">#{nextTodo.rank} {nextTodo.name}</span>
                    <ChevronRight size={15} className="shrink-0" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Дүн */}
          <div className="flex flex-col gap-2">
            {prod && sales && (
              <div className="rounded-2xl bg-gradient-to-br from-emerald-50 to-teal-50 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold text-emerald-800"><TrendingUp size={14} />Борлуулалт → поддон</div>
                <div className="grid grid-cols-2 gap-2">
                  {Stat("Сарын дундаж", fmt(sales.avg_monthly, 0), "ш", "text-emerald-700")}
                  {Stat("Сард поддон", live.pcs_per_pallet > 0 ? fmt(sales.avg_monthly / live.pcs_per_pallet, 1) : "—", "поддон", "text-emerald-700")}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {sales.months.map((m) => (
                    <div key={`${m.year}-${m.month}`} className="rounded-lg bg-white/80 px-2 py-1.5 text-center">
                      <div className="text-[10px] font-semibold text-gray-400">{m.year}/{String(m.month).padStart(2, "0")}</div>
                      <div className="text-[12px] font-bold tabular-nums text-gray-800">{fmt(m.qty, 0)} ш</div>
                      <div className="text-[11px] tabular-nums text-emerald-700">{live.pcs_per_pallet > 0 ? `${fmt(m.qty / live.pcs_per_pallet, 1)} поддон` : "—"}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[10.5px] text-emerald-800/70">
                  {monthsLabel(sales.months)} сарын дундаж (агуулах + заал). Сард поддон = сарын дундаж ÷ {live.pcs_per_pallet > 0 ? `${fmt(live.pcs_per_pallet, 0)} ш/поддон` : "1 поддоны ширхэг"}
                  {live.pcs_per_box > 0 && <> · ≈ {fmt(sales.avg_monthly / live.pcs_per_box, 0)} хайрцаг/сар</>}
                </p>
              </div>
            )}
            <div className="rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold text-amber-800"><Boxes size={14} />1 поддон дээр</div>
              <div className="grid grid-cols-2 gap-2">
                {Stat("Нийт хайрцаг", fmt(live.boxes_per_pallet, 0), "ш", "text-amber-700")}
                {Stat("Нийт ширхэг", fmt(live.pcs_per_pallet, 0), "ш", "text-amber-700")}
                {Stat("Хувийн жин (1 ш)", fmt(live.unit_weight_kg, 3), "кг")}
                {Stat("Хайрцагны жин", fmt(live.box_weight_kg, 2), "кг")}
                {Stat("Поддоны нийт жин", fmt(live.pallet_weight_kg, 1), "кг", "text-gray-800")}
                <div className="col-span-2 -mt-1 text-[10.5px] text-gray-500">Хайрцагны жин = ширхэг/хайрцаг × хувийн жин; Поддоны нийт жин = нийт хайрцаг × хайрцагны жин (поддоны өөрийн жин ороогүй)</div>
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

      {/* ── Жагсаалт: tag-ийн бүх бараа борлуулалтын эрэмбээр ── */}
      {tab === "list" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2.5 rounded-2xl bg-white p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <select value={wTag} onChange={(e) => { setWTag(e.target.value); setWLimit(PAGE_W); }}
                className="min-w-0 max-w-full rounded-xl border border-gray-200 bg-white px-2.5 py-2 text-[12.5px] font-semibold text-gray-800 outline-none sm:max-w-[260px]">
                {!(wl?.tags ?? []).some((t) => t.name === wTag) && wTag && <option value={wTag}>{wTag}</option>}
                {(wl?.tags ?? []).map((t) => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
                <option value="">Бүх бараа (мастер)</option>
              </select>
              <div className="relative min-w-[160px] flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={wQ} onChange={(e) => { setWQ(e.target.value); setWLimit(PAGE_W); }} placeholder="Код, нэр, баркод…"
                  className="w-full rounded-xl border border-gray-200 py-2 pl-8 pr-3 text-[13px] outline-none focus:border-gray-400" />
              </div>
              <button onClick={loadList} title="Шинэчлэх" className="rounded-xl border border-gray-200 p-2 text-gray-500"><RefreshCw size={14} className={listLoading ? "animate-spin" : ""} /></button>
              <button onClick={exportXlsx} disabled={dl || !wl?.total} className="inline-flex items-center gap-1.5 rounded-xl bg-gray-900 px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40">
                {dl ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}Excel
              </button>
            </div>
            {wl && (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {([["all", "Бүгд", wl.counts.total, "bg-gray-900 text-white"], ["todo", "Оруулаагүй", wl.counts.todo, "bg-amber-500 text-white"],
                    ["done", "Оруулсан", wl.counts.done, "bg-emerald-600 text-white"]] as const).map(([k, l, c, on]) => (
                    <button key={k} onClick={() => { setWStatus(k); setWLimit(PAGE_W); }}
                      className={`rounded-lg px-2.5 py-1 text-[12px] font-semibold ${wStatus === k ? on : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                      {l} <span className="tabular-nums opacity-80">{c.toLocaleString("mn-MN")}</span>
                    </button>
                  ))}
                  <div className="ml-auto flex min-w-[180px] flex-1 items-center gap-2 sm:max-w-[320px]">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${wl.counts.total ? (wl.counts.done / wl.counts.total) * 100 : 0}%` }} />
                    </div>
                    <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-emerald-700">
                      {wl.counts.total ? Math.round((wl.counts.done / wl.counts.total) * 1000) / 10 : 0}% оруулсан
                    </span>
                  </div>
                </div>
                <p className="text-[11px] text-gray-500">
                  Эрэмбэ: {monthsLabel(wl.months)} сарын дундаж борлуулалт (агуулах + заал, ширхэг) — ихээс бага руу
                </p>
              </>
            )}
          </div>

          {!wl ? (
            <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-gray-400"><Loader2 size={18} className="mx-auto animate-spin" /></div>
          ) : wl.items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-[13px] text-gray-400">
              {wStatus === "todo" && wl.counts.total > 0 && !wQ ? "Бүх барааны поддон мэдээлэл оруулсан 🎉" : "Бараа олдсонгүй"}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 lg:hidden">
                {wl.items.map((c) => (
                  <div key={c.item_code} className={`flex items-stretch overflow-hidden rounded-xl border bg-white ${c.configured ? "border-emerald-200" : "border-gray-100"}`}>
                    <div className={`w-1 shrink-0 ${c.configured ? "bg-emerald-500" : "bg-amber-400"}`} />
                    <button onClick={() => lookup(c.item_code)} className={`min-w-0 flex-1 px-3 py-2 text-left ${c.configured ? "bg-emerald-50/40" : ""}`}>
                      <div className="flex items-baseline gap-1.5">
                        <span className="shrink-0 text-[11px] font-bold tabular-nums text-gray-400">#{c.rank}</span>
                        <span className="truncate text-[13px] font-semibold text-gray-800">{c.name || c.item_code}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-500">
                        <span className="font-mono">{c.item_code}</span>
                        <span><b className="text-gray-700">{fmt(c.avg_monthly, 0)}</b> ш/сар</span>
                        {c.config ? (
                          <>
                            <span className="font-semibold text-emerald-700">✓ {c.config.pallets_per_month == null ? "—" : fmt(c.config.pallets_per_month, 1)} поддон/сар</span>
                            <span>{c.config.boxes_per_layer}×{c.config.layers} = {c.config.calc.boxes_per_pallet} х · {fmt(c.config.calc.pcs_per_pallet, 0)} ш</span>
                          </>
                        ) : <span className="rounded-full bg-amber-50 px-1.5 font-semibold text-amber-700">Оруулаагүй</span>}
                      </div>
                    </button>
                    {canEdit && c.configured && <button onClick={() => openCopy(c.item_code)} title="Өөр бараанд хуулах" className="shrink-0 border-l border-gray-100 px-3 text-violet-500"><Copy size={15} /></button>}
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto rounded-2xl border border-gray-100 bg-white lg:block">
                <table className="w-full min-w-[960px] text-[12.5px]">
                  <thead className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500"><tr>
                    <th className="px-3 py-2 text-right">#</th>
                    <th className="px-3 py-2 text-left">Код</th>
                    <th className="px-3 py-2 text-left">Нэр</th>
                    <th className="px-3 py-2 text-right">Сарын дундаж</th>
                    <th className="px-3 py-2 text-left">Поддон мэдээлэл</th>
                    <th className="px-3 py-2 text-right">1 поддон</th>
                    <th className="px-3 py-2 text-right">Сард поддон</th>
                    <th className="px-3 py-2" />
                  </tr></thead>
                  <tbody>
                    {wl.items.map((c) => (
                      <tr key={c.item_code} className={`border-t border-gray-50 ${c.configured ? "bg-emerald-50/50 hover:bg-emerald-50" : "hover:bg-gray-50/60"}`}>
                        <td className="px-3 py-1.5 text-right font-bold tabular-nums text-gray-400">{c.rank}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-500">{c.item_code}</td>
                        <td className="max-w-[340px] px-3 py-1.5">
                          <button onClick={() => lookup(c.item_code)} className="block max-w-full truncate text-left font-medium text-gray-800 hover:underline">{c.name || c.item_code}</button>
                          {c.brand && <div className="truncate text-[10.5px] text-gray-400">{c.brand}</div>}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums" title={wl.months.map((m, i) => `${m.month}-р сар: ${fmt(c.months[i] ?? 0, 0)} ш`).join("\n")}>
                          <b className="text-gray-800">{fmt(c.avg_monthly, 0)}</b> <span className="text-gray-400">ш</span>
                        </td>
                        <td className="px-3 py-1.5">
                          {c.config ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                              <Check size={11} />{c.config.template_name} · {c.config.boxes_per_layer}×{c.config.layers}
                              {c.config.calc.warnings.length > 0 && <span title={c.config.calc.warnings.join("\n")} className="text-rose-600"><AlertCircle size={11} /></span>}
                            </span>
                          ) : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Оруулаагүй</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">
                          {c.config ? <>{c.config.calc.boxes_per_pallet} х · {fmt(c.config.calc.pcs_per_pallet, 0)} ш</> : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right font-bold tabular-nums text-emerald-700">
                          {c.config?.pallets_per_month == null ? <span className="font-normal text-gray-300">—</span> : fmt(c.config.pallets_per_month, 1)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right">
                          {c.configured ? (
                            <>
                              <button onClick={() => lookup(c.item_code)} title="Засах" className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-800"><Pencil size={13} /></button>
                              {canEdit && <button onClick={() => openCopy(c.item_code)} title="Өөр бараанд хуулах" className="rounded-lg p-1.5 text-violet-400 hover:bg-violet-50 hover:text-violet-700"><Copy size={13} /></button>}
                            </>
                          ) : canEdit && (
                            <button onClick={() => lookup(c.item_code)} className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-emerald-700">Оруулах</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {wl.items.length < wl.total && (
                <button onClick={() => setWLimit((l) => l + PAGE_W)} disabled={listLoading}
                  className="rounded-xl border border-gray-200 bg-white py-2 text-[12.5px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                  {listLoading ? "Ачаалж байна…" : `Цааш харах (${wl.items.length.toLocaleString("mn-MN")} / ${wl.total.toLocaleString("mn-MN")})`}
                </button>
              )}
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
