import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Columns3, Search, Download, RefreshCw, Save, Trash2, Link2, Plus, Pencil, Check, X, AlertCircle, Loader2,
  History, ChevronLeft, ChevronRight,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";

/* ═══════════════════════════════════════════════════════════════════════════
   Нэмэлт талбар (мастер) — Эрхэтээс ирдэггүй багануудыг Бараа / Харилцагч
   дээр энэ системд хөтөлнө (ж: Ачааны ангилал; Нийлүүлэгчийн байршил, тооцоо, НӨАТ).
   Эрхэт дээр код өөрчлөгдөж дахин импортлоход зангуу (баркод/нэр/утас/данс)-аар
   автоматаар шинэ кодтой холбогдоно; олдохгүй бол «Холбоос» таб дээр гараар холбоно.
   ═══════════════════════════════════════════════════════════════════════════ */

type Entity = "product" | "customer";
type Field = { id: number; entity: Entity; key: string; label: string; ftype: "text" | "number" | "select" | "bool" | "date";
  options: string[]; group_filter: string; sort_order: number; is_active: boolean };
type Vals = Record<string, string | number | boolean>;
type Row = { code: string; name: string; info: Record<string, string>; values: Vals; status: string; updated_by: string;
  updated_at: string | null; prev_codes: { code: string; name?: string; at: string; by: string; matched?: string[] }[] };
type Meta = { entity: Entity; label: string; fields: Field[]; source: { file: string; exists: boolean; updated_at: string | null; rows: number };
  records: number; orphans: number; erkhet_groups: string[]; group_key: string };
type Orphan = { code: string; name: string; values: Vals; seen_at: string | null; updated_by: string;
  suggestions: { code: string; name: string; info: Record<string, string>; matched: string[]; score: number }[] };

const EDIT_ROLES = ["admin", "supervisor", "manager"];
const ENTITY_TABS: [Entity, string][] = [["product", "Бараа"], ["customer", "Харилцагч"]];
const TYPE_LABEL: Record<Field["ftype"], string> = { text: "Текст", number: "Тоо", select: "Сонголт", bool: "Тийм/Үгүй", date: "Огноо" };
const INFO_COLS: Record<Entity, [string, string][]> = {
  product: [["brand", "Брэнд"], ["location_tag", "Байршил tag"], ["barcode", "Баркод"]],
  customer: [["group_name", "Эрхэт бүлэг"], ["phone", "Утас"], ["address", "Хаяг"]],
};
const errMsg = (e: any, f: string) => (typeof e?.response?.data?.detail === "string" ? e.response.data.detail : f);
/* Серверийн бичлэгийн цаг UTC (tz тэмдэггүй) → локал цагаар харуулна; файлын цаг аль хэдийн локал */
const fmtDate = (s: string | null | undefined, utc = false) => {
  if (!s) return "";
  if (!utc) return s.replace("T", " ").slice(0, 16);
  const d = new Date(/[Zz]|[+-]\d\d:\d\d$/.test(s) ? s : s + "Z");
  if (Number.isNaN(d.getTime())) return s.replace("T", " ").slice(0, 16);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function CustomMasterPage() {
  const { role, baseRole } = useAuthStore();
  const canEdit = EDIT_ROLES.includes((baseRole || role || "") as string);
  const [tab, setTab] = useState<"records" | "orphans" | "fields">("records");
  const [entity, setEntity] = useState<Entity>("product");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const flash = useCallback((kind: "ok" | "err", msg: string) => { setToast({ kind, msg }); setTimeout(() => setToast(null), 3500); }, []);

  const loadMeta = useCallback(async (ent: Entity = entity) => {
    try { const r = await api.get("/custom-master/meta", { params: { entity: ent } }); setMeta(r.data); } catch (e) { flash("err", errMsg(e, "Мэдээлэл ачаалахад алдаа")); }
  }, [entity, flash]);
  useEffect(() => { loadMeta(entity); }, [entity, loadMeta]);
  const fields = useMemo(() => (meta?.fields ?? []).filter((f) => f.is_active), [meta]);
  const groupKey = meta?.group_key ?? "sys_group";

  /* ── Бичлэгүүд ── */
  const [q, setQ] = useState(""); const [dq, setDq] = useState("");
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [fField, setFField] = useState(""); const [fValue, setFValue] = useState("__any__");
  const [eGroup, setEGroup] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]); const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState<Record<string, Vals>>({});
  const [savingCode, setSavingCode] = useState<string | null>(null);
  const SIZE = 100;
  useEffect(() => { setPage(1); setFField(""); setFValue("__any__"); setEGroup(""); setDirty({}); }, [entity]);
  useEffect(() => { setPage(1); }, [dq, onlyFilled, fField, fValue, eGroup]);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/custom-master/records", { params: { entity, q: dq, only_filled: onlyFilled, field: fField, value: fField ? fValue : "", erkhet_group: eGroup, page, size: SIZE } });
      setRows(r.data.items); setTotal(r.data.total);
    } catch (e) { flash("err", errMsg(e, "Жагсаалт ачаалахад алдаа")); }
    finally { setLoading(false); }
  }, [entity, dq, onlyFilled, fField, fValue, eGroup, page, flash]);
  useEffect(() => { if (tab === "records") loadRows(); }, [tab, loadRows]);

  const effVals = (r: Row): Vals => ({ ...r.values, ...(dirty[r.code] ?? {}) });
  const visibleFor = (f: Field, vals: Vals) => !f.group_filter || String(vals[groupKey] ?? "") === f.group_filter;
  const setVal = (code: string, key: string, v: string | number | boolean) => setDirty((d) => ({ ...d, [code]: { ...(d[code] ?? {}), [key]: v } }));
  const saveRow = async (r: Row) => {
    const vals = effVals(r);
    // Бүлэг өөрчлөгдвөл тухайн бүлэгт хамаарахгүй талбарын утгыг хадгалахгүй
    const body: Vals = {}; fields.forEach((f) => { if (visibleFor(f, vals) && vals[f.key] !== undefined && vals[f.key] !== "") body[f.key] = vals[f.key]; });
    setSavingCode(r.code);
    try {
      const res = await api.put(`/custom-master/records/${entity}/${encodeURIComponent(r.code)}`, { values: body });
      setRows((rs) => rs.map((x) => (x.code === r.code ? { ...x, values: res.data.values, status: res.data.status, updated_by: res.data.updated_by, updated_at: res.data.updated_at } : x)));
      setDirty((d) => { const n = { ...d }; delete n[r.code]; return n; });
      flash("ok", `${r.code} хадгалагдлаа`); loadMeta();
    } catch (e) { flash("err", errMsg(e, "Хадгалахад алдаа")); }
    finally { setSavingCode(null); }
  };
  const saveAll = async () => { for (const r of rows) if (dirty[r.code]) await saveRow(r); };
  const clearRow = async (r: Row) => {
    if (!confirm(`${r.code} — ${r.name}\nНэмэлт мэдээллийг бүхэлд нь устгах уу?`)) return;
    try { await api.delete(`/custom-master/records/${entity}/${encodeURIComponent(r.code)}`); flash("ok", "Устгагдлаа"); loadRows(); loadMeta(); }
    catch (e) { flash("err", errMsg(e, "Устгахад алдаа")); }
  };
  const exportXlsx = async () => {
    try {
      const r = await api.get("/custom-master/export", { params: { entity }, responseType: "blob" });
      const cd = r.headers["content-disposition"] || ""; const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      const a = document.createElement("a"); a.href = URL.createObjectURL(r.data); a.download = m ? decodeURIComponent(m[1]) : `${entity}_custom.xlsx`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { flash("err", errMsg(e, "Экспорт алдаа")); }
  };
  const [resyncing, setResyncing] = useState(false);
  const resync = async () => {
    setResyncing(true);
    try {
      const r = await api.post("/custom-master/resync", null, { params: { entity } });
      const s = r.data?.sync; flash(s ? "ok" : "err", s ? `Тулгав: ${s.rows} мөр, автоматаар холбосон ${s.relinked?.length ?? 0}, холбоос хүлээж буй ${s.orphans}` : (r.data?.sync_error || "Алдаа"));
      loadMeta(); loadRows(); if (tab === "orphans") loadOrphans();
    } catch (e) { flash("err", errMsg(e, "Тулгахад алдаа")); }
    finally { setResyncing(false); }
  };

  /* ── Холбоос (orphans) ── */
  const [orphans, setOrphans] = useState<Orphan[]>([]); const [oLoading, setOLoading] = useState(false);
  const [manual, setManual] = useState<Record<string, string>>({});
  const loadOrphans = useCallback(async () => {
    setOLoading(true);
    try { const r = await api.get("/custom-master/orphans", { params: { entity } }); setOrphans(r.data); } catch (e) { flash("err", errMsg(e, "Ачаалахад алдаа")); }
    finally { setOLoading(false); }
  }, [entity, flash]);
  useEffect(() => { if (tab === "orphans") loadOrphans(); }, [tab, loadOrphans]);
  const doRelink = async (old_code: string, new_code: string) => {
    if (!new_code.trim()) return;
    try { await api.post("/custom-master/relink", { entity, old_code, new_code: new_code.trim() }); flash("ok", `${old_code} → ${new_code} холбогдлоо`); loadOrphans(); loadMeta(); }
    catch (e) { flash("err", errMsg(e, "Холбоход алдаа")); }
  };
  const dropOrphan = async (o: Orphan) => {
    if (!confirm(`${o.code} — ${o.name}\nЭнэ бичлэгийг (утгатай нь) устгах уу?`)) return;
    try { await api.delete(`/custom-master/records/${entity}/${encodeURIComponent(o.code)}`); flash("ok", "Устгагдлаа"); loadOrphans(); loadMeta(); }
    catch (e) { flash("err", errMsg(e, "Устгахад алдаа")); }
  };

  /* ── Талбарууд ── */
  type FForm = { id: number | null; label: string; ftype: Field["ftype"]; options: string; group_filter: string; sort_order: string; is_active: boolean };
  const [fForm, setFForm] = useState<FForm | null>(null);
  const groupOptions = useMemo(() => (meta?.fields ?? []).find((f) => f.key === groupKey)?.options ?? [], [meta, groupKey]);
  const saveField = async () => {
    if (!fForm) return;
    const body = { entity, label: fForm.label, ftype: fForm.ftype, options: fForm.options.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean),
      group_filter: fForm.group_filter, sort_order: Number(fForm.sort_order) || 0, is_active: fForm.is_active };
    try {
      if (fForm.id) await api.put(`/custom-master/fields/${fForm.id}`, body); else await api.post("/custom-master/fields", body);
      flash("ok", "Талбар хадгалагдлаа"); setFForm(null); loadMeta();
    } catch (e) { flash("err", errMsg(e, "Хадгалахад алдаа")); }
  };
  const deleteField = async (f: Field) => {
    if (!confirm(`«${f.label}» талбарыг устгах уу?`)) return;
    try { await api.delete(`/custom-master/fields/${f.id}`); flash("ok", "Устгагдлаа"); loadMeta(); }
    catch (e) { flash("err", errMsg(e, "Устгахад алдаа")); }
  };

  /* ── Render helpers (render functions — inner component биш, фокус алдахгүй) ── */
  const inputCls = "w-full rounded-lg border border-gray-200 bg-white px-2 py-1 text-[12.5px] outline-none focus:border-emerald-400 disabled:bg-gray-50 disabled:text-gray-500";
  const renderCell = (r: Row, f: Field) => {
    const vals = effVals(r);
    if (!visibleFor(f, vals)) return <span className="text-gray-300">—</span>;
    const v = vals[f.key];
    const dis = !canEdit;
    if (f.ftype === "select") return (
      <select value={String(v ?? "")} disabled={dis} onChange={(e) => setVal(r.code, f.key, e.target.value)} className={inputCls}>
        <option value="">—</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>);
    if (f.ftype === "bool") return <input type="checkbox" checked={Boolean(v)} disabled={dis} onChange={(e) => setVal(r.code, f.key, e.target.checked)} className="h-4 w-4 accent-emerald-600" />;
    return <input value={String(v ?? "")} disabled={dis} type={f.ftype === "date" ? "date" : "text"} inputMode={f.ftype === "number" ? "decimal" : undefined}
      onChange={(e) => setVal(r.code, f.key, e.target.value)} className={inputCls} />;
  };
  const filterValueOptions = (): [string, string][] => {
    const f = fields.find((x) => x.key === fField); const base: [string, string][] = [["__any__", "Утгатай"], ["__empty__", "Хоосон"]];
    if (f?.ftype === "select") return [...base, ...f.options.map((o): [string, string] => [o, o])];
    if (f?.ftype === "bool") return [...base, ["true", "Тийм"], ["false", "Үгүй"]];
    return base;
  };
  const dirtyCount = Object.keys(dirty).length;
  const pages = Math.max(1, Math.ceil(total / SIZE));

  return (
    <div className="flex flex-col gap-3">
      {toast && (
        <div className={`fixed left-3 right-3 top-3 z-[70] flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg sm:left-auto sm:right-5 sm:max-w-md ${toast.kind === "err" ? "bg-red-600" : "bg-emerald-600"}`}>
          {toast.kind === "err" ? <AlertCircle size={15} /> : <Check size={15} />}<span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm"><Columns3 size={16} /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold leading-tight text-gray-900">Нэмэлт талбар (мастер)</h1>
          <p className="truncate text-[11px] text-gray-500">
            {meta ? `${meta.label}: ${meta.source.rows.toLocaleString()} мөр (${meta.source.file}, ${fmtDate(meta.source.updated_at) || "файл алга"}) · утгатай ${meta.records}` : "…"}
          </p>
        </div>
        <div className="flex rounded-xl bg-gray-100 p-0.5">
          {ENTITY_TABS.map(([k, l]) => (
            <button key={k} onClick={() => setEntity(k)} className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold ${entity === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>{l}</button>
          ))}
        </div>
        <div className="flex rounded-xl bg-gray-100 p-0.5">
          {([["records", "Жагсаалт"], ["orphans", `Холбоос${meta?.orphans ? ` (${meta.orphans})` : ""}`], ["fields", `Талбар (${fields.length})`]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold ${tab === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"} ${k === "orphans" && meta?.orphans ? "text-amber-600" : ""}`}>{l}</button>
          ))}
        </div>
      </div>

      {!!meta?.orphans && tab !== "orphans" && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
          <AlertCircle size={14} /> Импортын дараа {meta.orphans} бичлэгийн код файлд олдсонгүй (Эрхэт дээр код өөрчлөгдсөн байж магадгүй).
          <button onClick={() => setTab("orphans")} className="ml-auto rounded-lg bg-amber-600 px-2.5 py-1 text-[12px] font-semibold text-white">Холбох</button>
        </div>
      )}

      {/* ── Жагсаалт ── */}
      {tab === "records" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm">
            <div className="relative min-w-[200px] flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={entity === "product" ? "Код, нэр эсвэл баркод…" : "Код эсвэл нэр…"} inputMode="search"
                className="w-full rounded-xl border border-gray-200 py-2 pl-8 pr-3 text-[13px] outline-none focus:border-emerald-400" />
            </div>
            <label className="flex items-center gap-1.5 text-[12.5px] text-gray-600"><input type="checkbox" checked={onlyFilled} onChange={(e) => setOnlyFilled(e.target.checked)} className="accent-emerald-600" />Зөвхөн утгатай</label>
            <select value={fField} onChange={(e) => { setFField(e.target.value); setFValue("__any__"); }} className="rounded-xl border border-gray-200 bg-white px-2.5 py-2 text-[12.5px] outline-none">
              <option value="">Талбараар шүүх…</option>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            {fField && (
              <select value={fValue} onChange={(e) => setFValue(e.target.value)} className="rounded-xl border border-gray-200 bg-white px-2.5 py-2 text-[12.5px] outline-none">
                {filterValueOptions().map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            )}
            {entity === "customer" && (
              <select value={eGroup} onChange={(e) => setEGroup(e.target.value)} className="max-w-[220px] rounded-xl border border-gray-200 bg-white px-2.5 py-2 text-[12.5px] outline-none">
                <option value="">Эрхэт бүлэг: бүгд</option>{(meta?.erkhet_groups ?? []).map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
            <div className="ml-auto flex items-center gap-2">
              {canEdit && <button onClick={resync} disabled={resyncing} title="Мастер файлтай дахин тулгаж, код өөрчлөгдсөнийг холбоно" className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                <RefreshCw size={13} className={resyncing ? "animate-spin" : ""} />Тулгах</button>}
              <button onClick={exportXlsx} className="inline-flex items-center gap-1.5 rounded-xl bg-gray-900 px-3 py-2 text-[12.5px] font-semibold text-white"><Download size={13} />Excel</button>
            </div>
          </div>

          {dirtyCount > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
              Хадгалаагүй өөрчлөлт: {dirtyCount} мөр
              <button onClick={saveAll} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[12px] font-semibold text-white"><Save size={12} />Бүгдийг хадгалах</button>
              <button onClick={() => setDirty({})} className="rounded-lg border border-emerald-300 px-2.5 py-1 text-[12px] font-semibold">Цуцлах</button>
            </div>
          )}

          <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-[12.5px]">
                <thead className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500"><tr>
                  <th className="px-3 py-2 text-left">Код</th><th className="px-3 py-2 text-left">Нэр</th>
                  {INFO_COLS[entity].map(([k, l]) => <th key={k} className="px-3 py-2 text-left">{l}</th>)}
                  {fields.map((f) => <th key={f.key} className="bg-amber-50/70 px-3 py-2 text-left text-amber-800" title={f.group_filter ? `Зөвхөн «${f.group_filter}» бүлэгт` : ""}>{f.label}{f.group_filter && <span className="ml-1 font-normal normal-case text-amber-500">({f.group_filter})</span>}</th>)}
                  <th className="px-2 py-2"></th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.code} className={`border-t border-gray-50 ${dirty[r.code] ? "bg-emerald-50/40" : "hover:bg-gray-50/60"}`}>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-gray-600">
                        {r.code}
                        {r.prev_codes.length > 0 && <span title={`Өмнөх код: ${r.prev_codes.map((p) => `${p.code} (${fmtDate(p.at, true)}, ${p.matched?.join("/") || p.by})`).join("; ")}`} className="ml-1 inline-flex items-center text-sky-500"><History size={11} /></span>}
                      </td>
                      <td className="max-w-[280px] truncate px-3 py-1.5 font-medium text-gray-800" title={r.name}>{r.name}</td>
                      {INFO_COLS[entity].map(([k]) => <td key={k} className="max-w-[160px] truncate px-3 py-1.5 text-gray-500" title={r.info[k]}>{r.info[k] || ""}</td>)}
                      {fields.map((f) => <td key={f.key} className="min-w-[120px] px-2 py-1">{renderCell(r, f)}</td>)}
                      <td className="whitespace-nowrap px-2 py-1 text-right">
                        {canEdit && dirty[r.code] && <button onClick={() => saveRow(r)} disabled={savingCode === r.code} className="rounded-lg bg-emerald-600 p-1.5 text-white disabled:opacity-50" title="Хадгалах">{savingCode === r.code ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}</button>}
                        {canEdit && !dirty[r.code] && Object.keys(r.values).length > 0 && <button onClick={() => clearRow(r)} className="rounded-lg p-1.5 text-gray-300 hover:bg-rose-50 hover:text-rose-600" title="Нэмэлт мэдээллийг устгах"><Trash2 size={13} /></button>}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={99} className="px-3 py-8 text-center text-gray-400">{loading ? "Ачаалж байна…" : (meta?.source.exists ? "Мөр олдсонгүй" : "Мастер файл алга — эхлээд импорт хийнэ үү")}</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 border-t border-gray-100 px-3 py-2 text-[12px] text-gray-500">
              <span>{total.toLocaleString()} мөр</span>
              <div className="ml-auto flex items-center gap-1">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-lg p-1 hover:bg-gray-100 disabled:opacity-30"><ChevronLeft size={15} /></button>
                <span>{page} / {pages}</span>
                <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="rounded-lg p-1 hover:bg-gray-100 disabled:opacity-30"><ChevronRight size={15} /></button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Холбоос ── */}
      {tab === "orphans" && (
        <div className="flex flex-col gap-3">
          <div className="rounded-2xl bg-white p-3 text-[12.5px] text-gray-600 shadow-sm">
            Доорх бичлэгүүдийн код сүүлийн импортын файлд байхгүй. Эрхэт дээр код өөрчлөгдсөн бол шинэ кодыг сонгож/бичиж <b>Холбох</b> дарна — нэмэлт мэдээлэл шинэ код руу шилжинэ.
            Бараа үнэхээр устсан бол устгаж болно.
          </div>
          {oLoading && <div className="rounded-2xl bg-white p-6 text-center text-gray-400 shadow-sm">Ачаалж байна…</div>}
          {!oLoading && orphans.length === 0 && <div className="rounded-2xl bg-white p-6 text-center text-gray-400 shadow-sm">Холбоос хүлээж буй бичлэг алга ✓</div>}
          {orphans.map((o) => (
            <div key={o.code} className="rounded-2xl bg-white p-3 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-lg bg-amber-100 px-2 py-0.5 font-mono text-[12px] font-semibold text-amber-800">{o.code}</span>
                <span className="text-[13px] font-semibold text-gray-800">{o.name}</span>
                <span className="text-[11px] text-gray-400">сүүлд файлд: {fmtDate(o.seen_at, true) || "—"}</span>
                {canEdit && <button onClick={() => dropOrphan(o)} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-[11.5px] text-rose-600 hover:bg-rose-50"><Trash2 size={12} />Устгах</button>}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {fields.filter((f) => o.values[f.key] !== undefined).map((f) => <span key={f.key} className="rounded-md bg-gray-100 px-2 py-0.5 text-[11.5px] text-gray-700">{f.label}: <b>{String(o.values[f.key])}</b></span>)}
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {o.suggestions.map((s) => (
                  <div key={s.code} className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-100 px-2.5 py-1.5 text-[12.5px]">
                    <span className="font-mono text-gray-600">{s.code}</span><span className="font-medium text-gray-800">{s.name}</span>
                    <span className="text-[11px] text-emerald-700">таарсан: {s.matched.join(", ")}</span>
                    {canEdit && <button onClick={() => doRelink(o.code, s.code)} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[12px] font-semibold text-white"><Link2 size={12} />Холбох</button>}
                  </div>
                ))}
                {canEdit && (
                  <div className="flex items-center gap-2">
                    <input value={manual[o.code] ?? ""} onChange={(e) => setManual((m) => ({ ...m, [o.code]: e.target.value }))} placeholder="Шинэ кодыг бичих…"
                      className="w-48 rounded-lg border border-gray-200 px-2 py-1.5 text-[12.5px] outline-none focus:border-emerald-400" />
                    <button onClick={() => doRelink(o.code, manual[o.code] ?? "")} disabled={!(manual[o.code] ?? "").trim()} className="inline-flex items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"><Link2 size={12} />Холбох</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Талбарууд ── */}
      {tab === "fields" && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
            <table className="w-full text-[12.5px]">
              <thead className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500"><tr>
                {["Нэр", "Төрөл", "Сонголт", entity === "customer" ? "Зөвхөн бүлэг" : "", "№", "Идэвх", ""].map((h, i) => <th key={i} className="px-3 py-2 text-left">{h}</th>)}
              </tr></thead>
              <tbody>
                {(meta?.fields ?? []).map((f) => (
                  <tr key={f.id} className={`border-t border-gray-50 ${f.is_active ? "" : "text-gray-400"}`}>
                    <td className="px-3 py-1.5 font-medium">{f.label} <span className="font-mono text-[10.5px] text-gray-400">{f.key}</span></td>
                    <td className="px-3 py-1.5">{TYPE_LABEL[f.ftype]}</td>
                    <td className="max-w-[260px] truncate px-3 py-1.5 text-gray-500" title={f.options.join(", ")}>{f.options.join(", ")}</td>
                    <td className="px-3 py-1.5 text-gray-500">{entity === "customer" ? f.group_filter || "бүгд" : ""}</td>
                    <td className="px-3 py-1.5 tabular-nums">{f.sort_order}</td>
                    <td className="px-3 py-1.5">{f.is_active ? "✓" : "—"}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      {canEdit && <button onClick={() => setFForm({ id: f.id, label: f.label, ftype: f.ftype, options: f.options.join(", "), group_filter: f.group_filter, sort_order: String(f.sort_order), is_active: f.is_active })} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-800"><Pencil size={13} /></button>}
                      {canEdit && <button onClick={() => deleteField(f)} className="rounded-lg p-1.5 text-gray-300 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={13} /></button>}
                    </td>
                  </tr>
                ))}
                {(meta?.fields ?? []).length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">Талбар алга</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="rounded-2xl bg-white p-3 shadow-sm">
            {!fForm ? (
              <div className="flex flex-col gap-2 text-[12.5px] text-gray-600">
                <p>Талбар нэмэхэд Excel экспорт болон мастер файлд шинэ багана болж гарна. Утгатай талбарыг устгахын оронд идэвхгүй болгоно.</p>
                {entity === "customer" && <p>«{(meta?.fields ?? []).find((f) => f.key === groupKey)?.label ?? "Бүлэг (систем)"}» талбарын сонголтуудыг засаж бүлэг үүсгэнэ (ж: Нийлүүлэгч). Бусад талбарт «Зөвхөн бүлэг» тохируулбал тэр бүлгийн харилцагч дээр л харагдана.</p>}
                {canEdit && <button onClick={() => setFForm({ id: null, label: "", ftype: "text", options: "", group_filter: "", sort_order: String((meta?.fields.length ?? 0) + 1), is_active: true })} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gray-900 px-3 py-2 text-[13px] font-semibold text-white"><Plus size={14} />Шинэ талбар</button>}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                <div className="text-[13px] font-bold text-gray-800">{fForm.id ? "Талбар засах" : "Шинэ талбар"}</div>
                <label className="text-[11.5px] text-gray-500">Нэр (Excel багана)<input value={fForm.label} onChange={(e) => setFForm((f) => f && { ...f, label: e.target.value })} className={inputCls + " mt-0.5 py-1.5"} /></label>
                <label className="text-[11.5px] text-gray-500">Төрөл
                  <select value={fForm.ftype} onChange={(e) => setFForm((f) => f && { ...f, ftype: e.target.value as Field["ftype"] })} className={inputCls + " mt-0.5 py-1.5"}>
                    {(Object.keys(TYPE_LABEL) as Field["ftype"][]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                  </select></label>
                {fForm.ftype === "select" && <label className="text-[11.5px] text-gray-500">Сонголтууд (таслалаар)<textarea value={fForm.options} onChange={(e) => setFForm((f) => f && { ...f, options: e.target.value })} rows={3} className={inputCls + " mt-0.5"} placeholder="Хүнд, Хөнгөн, Цул" /></label>}
                {entity === "customer" && (
                  <label className="text-[11.5px] text-gray-500">Зөвхөн бүлэгт харагдах
                    <select value={fForm.group_filter} onChange={(e) => setFForm((f) => f && { ...f, group_filter: e.target.value })} className={inputCls + " mt-0.5 py-1.5"}>
                      <option value="">Бүх харилцагч</option>{groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select></label>
                )}
                <div className="flex items-center gap-3">
                  <label className="flex-1 text-[11.5px] text-gray-500">Дараалал<input value={fForm.sort_order} onChange={(e) => setFForm((f) => f && { ...f, sort_order: e.target.value })} inputMode="numeric" className={inputCls + " mt-0.5 py-1.5"} /></label>
                  <label className="flex items-center gap-1.5 pt-4 text-[12.5px] text-gray-700"><input type="checkbox" checked={fForm.is_active} onChange={(e) => setFForm((f) => f && { ...f, is_active: e.target.checked })} className="accent-emerald-600" />Идэвхтэй</label>
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={saveField} disabled={!fForm.label.trim()} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-40"><Save size={14} />Хадгалах</button>
                  <button onClick={() => setFForm(null)} className="rounded-xl border border-gray-200 px-3 py-2 text-[13px] font-semibold text-gray-600">Болих</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
