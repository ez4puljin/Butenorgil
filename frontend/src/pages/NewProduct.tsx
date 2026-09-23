import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera, CheckCircle2, Download, Loader2, Plus, Trash2, X, Sparkles, ImageOff, Pencil, Search,
  ScanBarcode, RefreshCw, AlertCircle, AlertTriangle, Save, ChevronDown, PackagePlus, ListChecks,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import BarcodeScanner from "../components/BarcodeScanner";
import { useErkhetImport, ErkhetImportStatus, ErkhetImportButton } from "../components/ErkhetImport";

/* ═══════════════════════════════════════════════════════════════════════════
   Шинэ бараа таниулах
   1) Зураг авах (+бренд, хайрцгийн тоо) → AI нэр/жин/баркод/ангиллыг уншина
   2) Форм: ангиллын дараагийн чөлөөт код, Эрхэтийн данс/нэгжийг ижил ангилал+брэндийн
      бараанаас автоматаар бөглөнө → хадгалахад давхар баркод/код/нэрийг шалгана
   3) Бүртгэл: сонгоод Эрхэтийн «Бараа материалын нэр төрөл» Excel татах эсвэл Эрхэт рүү
      шууд импортлох → Эрхэтийн барааны жагсаалт шинэчлэгдэхэд «Мастерт орсон» болно
   ═══════════════════════════════════════════════════════════════════════════ */

type Cat = { code: string; name: string; count: number };
type Brand = { code: string; name: string };
type Refs = { source: { file: string; updated_at: string; products: number } | null; categories: Cat[]; brands: Brand[]; units: string[] };
type Issue = { level: "error" | "warn"; msg: string };
type Item = {
  id: number; status: string; status_label: string; item_code: string; name: string; foreign_name: string;
  category_code: string; category_name: string; brand_code: string; brand_name: string; barcode: string; unit_code: string;
  weight_kg: number; pack_ratio: number; box_unit_code: string; retail_price: number; wholesale_price: number;
  sales_account: string; cost_account: string; type_code: string; gs1_code: string; vat_free: boolean; tax_exempt_code: string;
  notes: string; has_image: boolean; created_by: string; created_at: string | null; updated_at: string | null;
  erkhet_message: string; issues: Issue[];
};
type Form = {
  item_code: string; name: string; foreign_name: string; category_code: string; brand_code: string; barcode: string;
  unit_code: string; weight_kg: string; pack_ratio: string; box_unit_code: string; retail_price: string; wholesale_price: string;
  sales_account: string; cost_account: string; type_code: string; gs1_code: string; vat_free: boolean; tax_exempt_code: string; notes: string;
};
type Draft = { form: Form; image: string; photos: string[]; bgRemoved: boolean; existing: { code: string; name: string } | null; ai: any; template: { code: string; name: string } | null };

const EDIT_ROLES = ["admin", "supervisor", "manager"];
const EMPTY_FORM: Form = {
  item_code: "", name: "", foreign_name: "", category_code: "", brand_code: "", barcode: "", unit_code: "ш",
  weight_kg: "", pack_ratio: "", box_unit_code: "ха", retail_price: "", wholesale_price: "",
  sales_account: "510101", cost_account: "610101", type_code: "", gs1_code: "", vat_free: false, tax_exempt_code: "", notes: "",
};
const STATUS_STYLE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600", ready: "bg-emerald-50 text-emerald-700", sent: "bg-sky-50 text-sky-700",
  imported: "bg-indigo-50 text-indigo-700", fail: "bg-red-50 text-red-700", registered: "bg-violet-50 text-violet-700",
};
const num = (s: string) => { const v = parseFloat(String(s).replace(",", ".")); return Number.isFinite(v) ? v : 0; };
const errMsg = (e: any, f: string) => (typeof e?.response?.data?.detail === "string" ? e.response.data.detail : f);
const imgUrl = (x: Item) => `${api.defaults.baseURL || ""}/new-product/items/${x.id}/image?v=${encodeURIComponent(x.updated_at || "")}`;
const toForm = (x: Item): Form => ({
  item_code: x.item_code, name: x.name, foreign_name: x.foreign_name, category_code: x.category_code, brand_code: x.brand_code,
  barcode: x.barcode, unit_code: x.unit_code, weight_kg: x.weight_kg ? String(x.weight_kg) : "", pack_ratio: x.pack_ratio ? String(x.pack_ratio) : "",
  box_unit_code: x.box_unit_code, retail_price: x.retail_price ? String(x.retail_price) : "", wholesale_price: x.wholesale_price ? String(x.wholesale_price) : "",
  sales_account: x.sales_account, cost_account: x.cost_account, type_code: x.type_code, gs1_code: x.gs1_code, vat_free: x.vat_free,
  tax_exempt_code: x.tax_exempt_code, notes: x.notes,
});
const fromForm = (f: Form) => ({ ...f, weight_kg: num(f.weight_kg), pack_ratio: num(f.pack_ratio), retail_price: num(f.retail_price), wholesale_price: num(f.wholesale_price) });

function b64ToBlob(b64: string, mime = "image/jpeg"): Blob {
  const data = b64.includes(",") ? b64.split(",")[1] : b64;
  const bytes = atob(data); const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
function compressImage(file: File, maxPx = 1280, quality = 0.8): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(""); };
    img.src = url;
  });
}

/* ── Барааны форм (тусдаа компонент — оролт фокус алдахгүй) ─────────────── */
function ProductForm({ refs, initial, image, issues, existing, template, editingId, saving, onSave, onCancel }: {
  refs: Refs; initial: Form; image: string; issues: Issue[]; existing: { code: string; name: string } | null;
  template: { code: string; name: string } | null; editingId: number | null; saving: boolean;
  onSave: (f: Form) => void; onCancel: () => void;
}) {
  const [f, setF] = useState<Form>(initial);
  const [scan, setScan] = useState(false);
  const [adv, setAdv] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const [brandText, setBrandText] = useState(() => refs.brands.find((b) => b.code === initial.brand_code)?.name ?? "");
  // refs дараа ачаалагдвал брэндийн нэрийг нөхнө (форм өөрөө `key`-ээр л шинэчлэгдэнэ)
  useEffect(() => { if (!brandText && f.brand_code) setBrandText(refs.brands.find((b) => b.code === f.brand_code)?.name ?? ""); }, [refs.brands]);  // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const fetchCode = async (cat: string) => {
    if (!cat) return;
    setCodeBusy(true);
    try { const r = await api.get("/new-product/next-code", { params: { category: cat, exclude_id: editingId ?? 0 } }); set("item_code", r.data.code || ""); }
    catch { /* гараар */ } finally { setCodeBusy(false); }
  };
  const applyDefaults = async (cat: string, brand: string) => {
    try {
      const r = await api.get("/new-product/defaults", { params: { category: cat, brand } });
      const d = r.data || {};
      setF((x) => ({ ...x, unit_code: d.unit_code || x.unit_code, box_unit_code: d.box_unit_code || x.box_unit_code,
        sales_account: d.sales_account || x.sales_account, cost_account: d.cost_account || x.cost_account,
        type_code: d.type_code ?? x.type_code, gs1_code: d.gs1_code ?? x.gs1_code }));
    } catch { /* үлдээнэ */ }
  };
  const onCategory = (cat: string) => { set("category_code", cat); fetchCode(cat); applyDefaults(cat, f.brand_code); };
  const onBrandText = (t: string) => {
    setBrandText(t);
    const m = refs.brands.find((b) => b.name.toLowerCase() === t.trim().toLowerCase() || b.code === t.trim());
    set("brand_code", m ? m.code : "");
    if (m && f.category_code) applyDefaults(f.category_code, m.code);
  };

  const inp = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-purple-400 disabled:bg-gray-50";
  const lbl = "mb-1 block text-[11px] font-medium text-gray-500";
  const errs = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  const req = (ok: boolean) => (ok ? "" : " border-rose-300");

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      {scan && <BarcodeScanner onDetected={(c) => { setScan(false); set("barcode", f.barcode ? `${f.barcode},${c}` : c); }} onClose={() => setScan(false)} />}
      <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-2">
          {image ? (
            <img src={image} alt="" className="h-44 w-44 rounded-xl border border-gray-100 bg-gray-50 object-contain" />
          ) : (
            <div className="grid h-44 w-44 place-items-center rounded-xl bg-gray-100"><ImageOff size={30} className="text-gray-300" /></div>
          )}
          {template?.code && <div className="text-center text-[10.5px] text-gray-400">Данс/нэгжийг «{template.code} {template.name}»-аас авсан</div>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {existing && (
            <div className="col-span-2 flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 ring-1 ring-inset ring-rose-200">
              <AlertCircle size={15} className="mt-0.5 shrink-0" /> Энэ баркод Эрхэтэд аль хэдийн бүртгэлтэй: <b>{existing.code} {existing.name}</b>
            </div>
          )}
          <label className="col-span-2"><span className={lbl}>Нэр *</span>
            <input value={f.name} onChange={(e) => set("name", e.target.value)} className={inp + req(!!f.name.trim())} placeholder="Jacobs Monarch кофе 95гр" /></label>
          <label className="col-span-2"><span className={lbl}>Гадаад нэр</span>
            <input value={f.foreign_name} onChange={(e) => set("foreign_name", e.target.value)} className={inp} placeholder="Савлагаан дээрх латин/орос нэр" /></label>
          <label className="col-span-2 sm:col-span-1"><span className={lbl}>Ангилал *</span>
            <select value={f.category_code} onChange={(e) => onCategory(e.target.value)} className={inp + req(!!f.category_code)}>
              <option value="">— Ангилал сонгох —</option>
              {refs.categories.map((c) => <option key={c.code} value={c.code}>{c.name.startsWith(c.code) ? c.name : `${c.code} ${c.name}`} ({c.count})</option>)}
            </select></label>
          <label className="col-span-2 sm:col-span-1"><span className={lbl}>Барааны код *</span>
            <div className="flex gap-1.5">
              <input value={f.item_code} onChange={(e) => set("item_code", e.target.value)} inputMode="numeric" className={inp + " font-mono" + req(!!f.item_code)} />
              <button type="button" onClick={() => fetchCode(f.category_code)} disabled={!f.category_code || codeBusy} title="Ангиллын дараагийн чөлөөт код"
                className="shrink-0 rounded-lg border border-gray-200 px-2.5 text-gray-500 hover:bg-gray-50 disabled:opacity-40">
                {codeBusy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </button>
            </div></label>
          <label className="col-span-2 sm:col-span-1"><span className={lbl}>Брэнд * {f.brand_code && <span className="font-mono text-gray-400">({f.brand_code})</span>}</span>
            <input value={brandText} onChange={(e) => onBrandText(e.target.value)} list="np-brands" className={inp + req(!!f.brand_code)} placeholder="Брэндийн нэрээр хайх…" />
            <datalist id="np-brands">{refs.brands.map((b) => <option key={b.code} value={b.name}>{b.code}</option>)}</datalist></label>
          <label className="col-span-2 sm:col-span-1"><span className={lbl}>Баркод</span>
            <div className="flex gap-1.5">
              <input value={f.barcode} onChange={(e) => set("barcode", e.target.value)} inputMode="numeric" className={inp + " font-mono"} placeholder="EAN-13 (олон бол таслалаар)" />
              <button type="button" onClick={() => setScan(true)} className="shrink-0 rounded-lg bg-emerald-600 px-2.5 text-white" title="Камераар уншуулах"><ScanBarcode size={15} /></button>
            </div></label>
          <label><span className={lbl}>Жин (1 ш, кг)</span>
            <input value={f.weight_kg} onChange={(e) => set("weight_kg", e.target.value)} inputMode="decimal" className={inp} placeholder="0.75" /></label>
          <label><span className={lbl}>Хайрцаг дахь ширхэг *</span>
            <input value={f.pack_ratio} onChange={(e) => set("pack_ratio", e.target.value)} inputMode="numeric" className={inp + req(num(f.pack_ratio) > 0)} placeholder="12" /></label>
          <label><span className={lbl}>Жижиглэнгийн үнэ ₮</span>
            <input value={f.retail_price} onChange={(e) => set("retail_price", e.target.value)} inputMode="decimal" className={inp} /></label>
          <label><span className={lbl}>Бөөний үнэ ₮</span>
            <input value={f.wholesale_price} onChange={(e) => set("wholesale_price", e.target.value)} inputMode="decimal" className={inp} /></label>
          <label><span className={lbl}>Хэмжих нэгж</span>
            <select value={f.unit_code} onChange={(e) => set("unit_code", e.target.value)} className={inp}>
              {Array.from(new Set([f.unit_code, ...refs.units])).filter(Boolean).map((u) => <option key={u} value={u}>{u}</option>)}
            </select></label>
          <label><span className={lbl}>Задрах нэгж</span>
            <select value={f.box_unit_code} onChange={(e) => set("box_unit_code", e.target.value)} className={inp}>
              {Array.from(new Set(["ха", "ш", "боодол", f.box_unit_code])).filter(Boolean).map((u) => <option key={u} value={u}>{u}</option>)}
            </select></label>

          <button type="button" onClick={() => setAdv((v) => !v)} className="col-span-2 flex items-center gap-1 text-[12px] font-semibold text-gray-500 hover:text-gray-800">
            <ChevronDown size={14} className={`transition-transform ${adv ? "rotate-180" : ""}`} /> Нягтлангийн тохиргоо (данс, төрөл, НӨАТ)
          </button>
          {adv && (
            <>
              <label><span className={lbl}>Борлуулалтын данс</span><input value={f.sales_account} onChange={(e) => set("sales_account", e.target.value)} className={inp + " font-mono"} /></label>
              <label><span className={lbl}>Өртгийн данс</span><input value={f.cost_account} onChange={(e) => set("cost_account", e.target.value)} className={inp + " font-mono"} /></label>
              <label><span className={lbl}>Төрөл код</span><input value={f.type_code} onChange={(e) => set("type_code", e.target.value)} className={inp + " font-mono"} /></label>
              <label><span className={lbl}>Бүт.Үйл нэгдсэн код</span><input value={f.gs1_code} onChange={(e) => set("gs1_code", e.target.value)} className={inp + " font-mono"} /></label>
              <label className="flex items-center gap-2 pt-5 text-[13px] text-gray-700"><input type="checkbox" checked={f.vat_free} onChange={(e) => set("vat_free", e.target.checked)} className="accent-purple-600" /> НӨАТ тооцохгүй</label>
              <label><span className={lbl}>Татвар чөлөөлөгдөх код</span><input value={f.tax_exempt_code} onChange={(e) => set("tax_exempt_code", e.target.value)} className={inp + " font-mono"} /></label>
            </>
          )}
          <label className="col-span-2"><span className={lbl}>Тэмдэглэл</span>
            <input value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inp} /></label>

          {(errs.length > 0 || warns.length > 0) && (
            <div className="col-span-2 space-y-1">
              {errs.map((i, k) => <div key={"e" + k} className="flex items-start gap-1.5 text-[12px] text-rose-600"><AlertCircle size={13} className="mt-0.5 shrink-0" />{i.msg}</div>)}
              {warns.map((i, k) => <div key={"w" + k} className="flex items-start gap-1.5 text-[12px] text-amber-600"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{i.msg}</div>)}
            </div>
          )}
          <div className="col-span-2 flex gap-2 pt-1">
            <button onClick={() => onSave(f)} disabled={saving} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-purple-600 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-purple-700 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Хадгалах
            </button>
            <button onClick={onCancel} className="rounded-xl border border-gray-200 px-4 py-2.5 text-[13px] font-semibold text-gray-600">Болих</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Үндсэн хуудас ────────────────────────────────────────────────────────── */
export default function NewProductPage() {
  const { role, baseRole } = useAuthStore();
  const canEdit = EDIT_ROLES.includes((baseRole || role || "") as string);
  const [tab, setTab] = useState<"add" | "list">("add");
  const [refs, setRefs] = useState<Refs>({ source: null, categories: [], brands: [], units: ["ш"] });
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const flash = useCallback((text: string, ok = true) => { setToast({ text, ok }); setTimeout(() => setToast(null), 4000); }, []);
  useEffect(() => { api.get("/new-product/refs").then((r) => setRefs(r.data)).catch(() => flash("Лавлах мэдээлэл ачаалахад алдаа", false)); }, [flash]);

  /* ── Нэмэх: зураг → AI → форм ── */
  const [photos, setPhotos] = useState<string[]>([]);
  const [brandText, setBrandText] = useState("");
  const [packText, setPackText] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveIssues, setSaveIssues] = useState<Issue[]>([]);
  const [draftKey, setDraftKey] = useState(0);
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  const addFiles = async (files: FileList | null) => {
    const arr = Array.from(files ?? []);
    if (!arr.length) return;
    const b = (await Promise.all(arr.map((x) => compressImage(x)))).filter(Boolean);
    setPhotos((p) => [...p, ...b].slice(0, 6));
    if (camRef.current) camRef.current.value = "";
    if (galRef.current) galRef.current.value = "";
  };
  const brandCode = useMemo(() => refs.brands.find((b) => b.name.toLowerCase() === brandText.trim().toLowerCase())?.code ?? "", [brandText, refs.brands]);

  const analyze = async () => {
    if (!photos.length) return;
    setAnalyzing(true); setSaveIssues([]);
    try {
      const fd = new FormData();
      photos.forEach((p, i) => fd.append("photos", b64ToBlob(p), `photo_${i}.jpg`));
      fd.append("brand", brandCode || brandText);
      fd.append("pack_ratio", String(parseInt(packText) || 0));
      const r = await api.post("/new-product/analyze", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 120000 });
      const d = r.data;
      setDraftKey((k) => k + 1);
      setDraft({
        form: { ...EMPTY_FORM, item_code: d.item_code || "", name: d.name || "", foreign_name: d.foreign_name || "", category_code: d.category_code || "",
          brand_code: d.brand_code || brandCode || "", barcode: d.barcode || "", unit_code: d.unit_code || "ш", box_unit_code: d.box_unit_code || "ха",
          weight_kg: d.weight_kg ? String(d.weight_kg) : "", pack_ratio: d.pack_ratio ? String(d.pack_ratio) : (packText || ""),
          sales_account: d.sales_account || "510101", cost_account: d.cost_account || "610101", type_code: d.type_code || "", gs1_code: d.gs1_code || "" },
        image: d.processed_image_b64 || photos[0], photos, bgRemoved: !!d.bg_removed, existing: d.existing, ai: d, template: d.template,
      });
    } catch (e: any) {
      flash(errMsg(e, "AI шинжилгээ амжилтгүй — гараар бөглөнө үү"), false);
      manual();
    } finally { setAnalyzing(false); }
  };
  const manual = () => (setDraftKey((k) => k + 1), setDraft({ form: { ...EMPTY_FORM, brand_code: brandCode, pack_ratio: packText }, image: photos[0] ?? "", photos, bgRemoved: false, existing: null, ai: null, template: null }));
  const resetAdd = () => { setPhotos([]); setDraft(null); setSaveIssues([]); setPackText(""); };

  const saveNew = async (f: Form) => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await api.post("/new-product/items", { ...fromForm(f), image_b64: draft.image || null, photos_b64: draft.photos, ai: draft.ai });
      const it: Item = r.data;
      const errs = it.issues.filter((i) => i.level === "error");
      flash(errs.length ? `Хадгалсан — ${errs.length} алдаа засах шаардлагатай (Бүртгэл дээр)` : `«${it.name}» бэлэн боллоо ✓`, !errs.length);
      resetAdd(); loadList();
      if (errs.length) { setTab("list"); setEditing(it); }
    } catch (e: any) { flash(errMsg(e, "Хадгалахад алдаа"), false); }
    finally { setSaving(false); }
  };

  /* ── Бүртгэл ── */
  const [items, setItems] = useState<Item[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [stFilter, setStFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Item | null>(null);
  const loadList = useCallback(async () => {
    setLoading(true);
    try { const r = await api.get("/new-product/items"); setItems(r.data.items); setCounts(r.data.counts || {}); }
    catch (e: any) { flash(errMsg(e, "Жагсаалт ачаалахад алдаа"), false); }
    finally { setLoading(false); }
  }, [flash]);
  useEffect(() => { loadList(); }, [loadList]);
  const shown = items.filter((x) => (!stFilter || x.status === stFilter) &&
    (!q.trim() || `${x.item_code} ${x.name} ${x.barcode} ${x.brand_name}`.toLowerCase().includes(q.trim().toLowerCase())));
  const selectable = (x: Item) => !x.issues.some((i) => i.level === "error");
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selItems = items.filter((x) => sel.has(x.id));

  const saveEdit = async (f: Form) => {
    if (!editing) return;
    setSaving(true);
    try {
      const r = await api.put(`/new-product/items/${editing.id}`, fromForm(f));
      const it: Item = r.data;
      setItems((xs) => xs.map((x) => (x.id === it.id ? it : x)));
      const errs = it.issues.filter((i) => i.level === "error");
      if (errs.length) { setEditing(it); flash(`${errs.length} алдаа үлдсэн байна`, false); }
      else { setEditing(null); flash("Хадгалагдлаа ✓"); }
      loadList();
    } catch (e: any) { flash(errMsg(e, "Хадгалахад алдаа"), false); }
    finally { setSaving(false); }
  };
  const del = async (x: Item) => {
    if (!confirm(`«${x.item_code} ${x.name}»-г устгах уу?`)) return;
    try { await api.delete(`/new-product/items/${x.id}`); flash("Устгагдлаа"); setSel((s) => { const n = new Set(s); n.delete(x.id); return n; }); loadList(); }
    catch (e: any) { flash(errMsg(e, "Устгахад алдаа"), false); }
  };
  const exportXlsx = async () => {
    try {
      const r = await api.post("/new-product/export", { ids: Array.from(sel) }, { responseType: "blob" });
      const cd = r.headers["content-disposition"] || ""; const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      const a = document.createElement("a"); a.href = URL.createObjectURL(r.data); a.download = m ? decodeURIComponent(m[1]) : "new_products.xlsx"; a.click(); URL.revokeObjectURL(a.href);
    } catch { flash("Excel үүсгэхэд алдаа", false); }
  };
  const erk = useErkhetImport("/new-product", "");
  useEffect(() => { if (erk.res && (erk.res.status === "ok" || erk.res.status === "fail")) loadList(); }, [erk.res?.status, loadList]);

  const tabBtn = (k: "add" | "list", label: string, Icon: typeof Plus, n?: number) => (
    <button onClick={() => setTab(k)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold ${tab === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>
      <Icon size={13} /> {label}{n ? <span className="rounded-full bg-gray-100 px-1.5 text-[10px]">{n}</span> : null}
    </button>
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-3">
      {toast && (
        <div className={`fixed left-3 right-3 top-3 z-[70] flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg sm:left-auto sm:right-5 sm:max-w-md ${toast.ok ? "bg-emerald-600" : "bg-red-600"}`}>
          {toast.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}<span className="flex-1">{toast.text}</span>
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 text-white shadow-sm"><Sparkles size={16} /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold leading-tight text-gray-900">Шинэ бараа таниулах</h1>
          <p className="truncate text-[11px] text-gray-500">
            Зураг → AI → Эрхэтийн «Бараа материалын нэр төрөл»
            {refs.source ? ` · лавлах: ${refs.source.products.toLocaleString()} бараа (${refs.source.updated_at.replace("T", " ")})` : " · Эрхэтийн барааны жагсаалт оруулаагүй"}
          </p>
        </div>
        <div className="flex rounded-xl bg-gray-100 p-0.5">
          {tabBtn("add", "Бараа нэмэх", PackagePlus)}
          {tabBtn("list", "Бүртгэл", ListChecks, total)}
        </div>
      </div>

      {/* ══ НЭМЭХ ══ */}
      {tab === "add" && (
        !canEdit ? <div className="rounded-2xl bg-white p-8 text-center text-sm text-gray-500 shadow-sm">Бараа нэмэх эрх алга (admin / хянагч / менежер).</div> :
        draft ? (
          <>
            {draft.ai && <div className="rounded-xl bg-violet-50 px-3 py-2 text-[12px] text-violet-800">AI ({draft.ai.ai_model}) уншсан мэдээллийг шалгаж, дутууг нөхөөд хадгална уу.</div>}
            <ProductForm key={draftKey} refs={refs} initial={draft.form} image={draft.image} issues={saveIssues} existing={draft.existing} template={draft.template}
              editingId={null} saving={saving} onSave={saveNew} onCancel={resetAdd} />
          </>
        ) : (
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="mb-3 text-[13px] font-semibold text-gray-700">1. Барааны савлагааны зураг (нүүр, ар тал, баркод — 6 хүртэл)</div>
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <div key={i} className="group relative">
                  <img src={p} alt="" className="h-24 w-24 rounded-xl border border-gray-100 object-cover" />
                  <button onClick={() => setPhotos((xs) => xs.filter((_, k) => k !== i))} className="absolute right-1 top-1 rounded-full bg-red-500 p-0.5 text-white"><X size={11} /></button>
                </div>
              ))}
              <label className="grid h-24 w-24 cursor-pointer place-items-center rounded-xl border-2 border-dashed border-purple-200 bg-purple-50 text-purple-600">
                <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => addFiles(e.target.files)} />
                <div className="flex flex-col items-center gap-1 text-[11px] font-semibold"><Camera size={20} />Камер</div>
              </label>
              <label className="grid h-24 w-24 cursor-pointer place-items-center rounded-xl border-2 border-dashed border-gray-200 text-gray-500">
                <input ref={galRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
                <div className="flex flex-col items-center gap-1 text-[11px] font-semibold"><Plus size={20} />Галерей</div>
              </label>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label><span className="mb-1 block text-[11px] font-medium text-gray-500">2. Брэнд (нийлүүлэгч) {brandCode && <span className="font-mono text-gray-400">({brandCode})</span>}</span>
                <input value={brandText} onChange={(e) => setBrandText(e.target.value)} list="np-brands-add" placeholder="Брэндийн нэрээр хайх…"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-purple-400" />
                <datalist id="np-brands-add">{refs.brands.map((b) => <option key={b.code} value={b.name}>{b.code}</option>)}</datalist></label>
              <label><span className="mb-1 block text-[11px] font-medium text-gray-500">Хайрцаг дахь ширхэг</span>
                <input value={packText} onChange={(e) => setPackText(e.target.value)} inputMode="numeric" placeholder="жишээ 12"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-purple-400" /></label>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={analyze} disabled={!photos.length || analyzing}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow disabled:opacity-40">
                {analyzing ? <><Loader2 size={15} className="animate-spin" /> AI уншиж байна…</> : <><Sparkles size={15} /> AI-аар таних</>}
              </button>
              <button onClick={manual} disabled={analyzing} className="rounded-xl border border-gray-200 px-4 py-2.5 text-[13px] font-semibold text-gray-600">Гараар бөглөх</button>
            </div>
          </div>
        )
      )}

      {/* ══ БҮРТГЭЛ ══ */}
      {tab === "list" && (
        editing ? (
          <ProductForm key={`${editing.id}-${editing.updated_at}`} refs={refs} initial={toForm(editing)} image={editing.has_image ? imgUrl(editing) : ""} issues={editing.issues} existing={null}
            template={null} editingId={editing.id} saving={saving} onSave={saveEdit} onCancel={() => setEditing(null)} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm">
              <div className="flex flex-wrap gap-1">
                {[["", "Бүгд", total] as const, ...Object.entries({ draft: "Ноорог", ready: "Бэлэн", sent: "Илгээсэн", imported: "Эрхэтэд орсон", fail: "Алдаа", registered: "Мастерт орсон" })
                  .map(([k, l]) => [k, l, counts[k] ?? 0] as const)].filter(([k, , n]) => !k || n > 0).map(([k, l, n]) => (
                  <button key={k || "all"} onClick={() => setStFilter(k)} className={`rounded-lg px-2.5 py-1 text-[11.5px] font-semibold ${stFilter === k ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"}`}>{l} {n}</button>
                ))}
              </div>
              <div className="relative ml-auto min-w-[180px] flex-1 sm:max-w-xs">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Код, нэр, баркод…" className="w-full rounded-xl border border-gray-200 py-2 pl-8 pr-3 text-[13px] outline-none focus:border-purple-400" />
              </div>
              <button onClick={loadList} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>
            </div>

            {sel.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-[12.5px] text-violet-900">
                <span className="font-semibold">Сонгосон: {sel.size}</span>
                <button onClick={exportXlsx} className="inline-flex items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1.5 text-[12px] font-semibold text-white"><Download size={12} /> Эрхэтийн импорт Excel</button>
                {erk.allowed && (
                  <ErkhetImportButton busy={erk.busy} className="rounded-lg px-3 py-1.5 text-[12px]"
                    onClick={() => erk.run({ ids: Array.from(sel) }, `${sel.size} шинэ бараа → «Бараа материалын нэр төрөл»:\n` + selItems.slice(0, 8).map((x) => `• ${x.item_code} ${x.name}`).join("\n"))} />
                )}
                <button onClick={() => setSel(new Set())} className="ml-auto rounded-lg p-1 text-violet-500 hover:bg-violet-100"><X size={14} /></button>
              </div>
            )}
            {erk.allowed && (erk.res || erk.error) && <ErkhetImportStatus prev={[]} res={erk.res} error={erk.error} subject="бараануудыг" />}

            <div className="space-y-2">
              {shown.length === 0 && <div className="rounded-2xl bg-white p-10 text-center text-sm text-gray-400 shadow-sm">{loading ? "Ачаалж байна…" : "Бүртгэл алга — «Бараа нэмэх»-ээс эхэлнэ үү"}</div>}
              {shown.map((x) => {
                const errs = x.issues.filter((i) => i.level === "error");
                const warns = x.issues.filter((i) => i.level === "warn");
                const locked = ["sent", "imported", "registered"].includes(x.status);
                return (
                  <div key={x.id} className="flex gap-3 rounded-2xl bg-white p-3 shadow-sm">
                    <div className="flex shrink-0 flex-col items-center gap-2">
                      <input type="checkbox" checked={sel.has(x.id)} disabled={!selectable(x) || x.status === "registered"} onChange={() => toggle(x.id)}
                        className="h-4 w-4 accent-violet-600 disabled:opacity-30" title={selectable(x) ? "" : "Алдаатай — засаад сонгоно"} />
                      {x.has_image ? <img src={imgUrl(x)} alt="" className="h-16 w-16 rounded-lg border border-gray-100 object-contain" />
                        : <div className="grid h-16 w-16 place-items-center rounded-lg bg-gray-100"><ImageOff size={18} className="text-gray-300" /></div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[12px] text-gray-500">{x.item_code || "—"}</span>
                        <span className="text-[13.5px] font-semibold text-gray-900">{x.name || "(нэргүй)"}</span>
                        <span className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold ${STATUS_STYLE[x.status] ?? "bg-gray-100 text-gray-600"}`}>{x.status_label}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-gray-500">
                        <span>{x.brand_name || "брэндгүй"}</span><span>{x.category_name || x.category_code}</span>
                        {x.barcode && <span className="font-mono">{x.barcode}</span>}
                        <span>{x.pack_ratio || "?"} ш/хайрцаг · {x.weight_kg || 0} кг</span>
                        {x.retail_price > 0 && <span>{x.retail_price.toLocaleString("mn-MN")}₮</span>}
                        <span className="text-gray-400">{x.created_by}</span>
                      </div>
                      {errs.map((i, k) => <div key={"e" + k} className="mt-0.5 flex items-start gap-1 text-[11.5px] text-rose-600"><AlertCircle size={12} className="mt-0.5 shrink-0" />{i.msg}</div>)}
                      {warns.slice(0, 2).map((i, k) => <div key={"w" + k} className="mt-0.5 flex items-start gap-1 text-[11.5px] text-amber-600"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{i.msg}</div>)}
                      {x.status === "fail" && x.erkhet_message && <div className="mt-0.5 text-[11.5px] text-red-600">Эрхэт: {x.erkhet_message}</div>}
                    </div>
                    {canEdit && (
                      <div className="flex shrink-0 flex-col gap-1">
                        {!locked && <button onClick={() => setEditing(x)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-800" title="Засах"><Pencil size={14} /></button>}
                        <button onClick={() => del(x)} className="rounded-lg p-1.5 text-gray-300 hover:bg-rose-50 hover:text-rose-600" title="Устгах"><Trash2 size={14} /></button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )
      )}
    </div>
  );
}
