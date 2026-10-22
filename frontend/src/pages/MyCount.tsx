import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import StockBadge from "../components/StockBadge";
import {
  Camera, Keyboard, Loader2, Plus, Search, X, Check, Download, Trash2, ArrowLeft, Pencil,
  RotateCcw, ScanLine, CheckCircle2, Users, AlertCircle, ClipboardList, ChevronRight,
} from "lucide-react";
import { api } from "../lib/api";
import { useBarcodeCamera } from "../lib/useBarcodeCamera";

/* ═══════════════════════════════════════════════════════════════════════════
   Миний тооллого — /hall-count хуудасны хувийн тооллогын горим.

   Хүн бүр ӨӨРИЙН тооллогыг үүсгэж зэрэг тоолно (бусдын тооллоготой холилдохгүй).
   Зөвхөн «Мастер нэгтгэл»-д бүртгэлтэй бараа. Утасны камераар баркод уншуулж тоо
   оруулна — нэг барааг дахин уншуулбал оруулсан тоо нь өмнөх дээр НЭМЭГДЭНЭ.
   Дуусгаад .txt (мөр бүр «code,quantity») татна.

   Shell нь desktop/mobile хувилбарыг зэрэг render хийдэг тул камерыг зөвхөн
   ХАРАГДАЖ байгаа хувилбар асаана (offsetParent).
   ═══════════════════════════════════════════════════════════════════════════ */

type CountRow = {
  id: number; name: string; status: "open" | "done"; owner_id: number; owner_name: string;
  created_at: string | null; updated_at: string | null; finished_at: string | null;
  lines: number; total_qty: number; is_owner: boolean;
};
type Line = { id: number; code: string; name: string; qty: number; scans: number; first_at: string | null; last_at: string | null };
type MasterProduct = { code: string; name: string; barcodes: string[]; brand: string; category: string; image: string; matched: string };
type Lookup = {
  query: string; found: boolean; ambiguous?: boolean; candidates?: { code: string; name: string }[];
  product: MasterProduct | null; line: Line | null;
};

const REPEAT_MS = 1500;
const LS_ACTIVE = "mycount.active";
const QUICK = [1, 2, 3, 5, 6, 10, 12, 24];

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return (Math.round(n * 1000) / 1000).toLocaleString("mn-MN", { maximumFractionDigits: 3 });
}
function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("mn-MN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function errMsg(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" ? d : (e?.message || fallback);
}
function isEnter(e: { key: string; keyCode?: number }) {
  return e.key === "Enter" || e.key === "Return" || e.keyCode === 13;
}
function useVisible(ref: React.RefObject<HTMLElement>): boolean {
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const check = () => setVis(!!ref.current && ref.current.offsetParent !== null);
    check();
    let t: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => { if (t) clearTimeout(t); t = setTimeout(check, 150); };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); if (t) clearTimeout(t); };
  }, [ref]);
  return vis;
}

/** .txt татах: богино хугацаатай холбоос — утасны апп-д Chrome-оор нээгдэж Downloads-д хадгална. */
async function downloadTxt(countId: number) {
  const r = await api.post(`/master-count/counts/${countId}/export-link`);
  const base = String(api.defaults.baseURL || "").replace(/\/$/, "");
  const href = /^https?:\/\//i.test(base) ? base + r.data.url : new URL(base + r.data.url, window.location.origin).href;
  const a = document.createElement("a");
  a.href = href; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
}

export default function MyCountPanel({ header }: { header?: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = useVisible(rootRef);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 1024);
  useEffect(() => {
    const on = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((kind: "ok" | "err", msg: string, ms = 3200) => {
    setToast({ kind, msg });
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(null), ms);
  }, []);

  /* ═══════════════ Тооллогууд ═══════════════ */
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [masterInfo, setMasterInfo] = useState<{ products: number; exists: boolean } | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const loadCounts = useCallback(async () => {
    setListLoading(true);
    try {
      const r = await api.get("/master-count/counts", { params: { scope } });
      setCounts(r.data.counts || []);
      setCanManage(!!r.data.can_manage);
      setMasterInfo(r.data.master || null);
    } catch (e: any) { flash("err", errMsg(e, "Тооллогууд татаж чадсангүй")); }
    finally { setListLoading(false); }
  }, [scope, flash]);

  const [activeId, setActiveIdState] = useState<number | null>(() => {
    try { return Number(localStorage.getItem(LS_ACTIVE)) || null; } catch { return null; }
  });
  const setActiveId = (id: number | null) => {
    setActiveIdState(id);
    try { if (id) localStorage.setItem(LS_ACTIVE, String(id)); else localStorage.removeItem(LS_ACTIVE); } catch { /* ignore */ }
  };

  useEffect(() => { if (visible && !activeId) loadCounts(); }, [visible, activeId, loadCounts]);

  async function createCount() {
    setCreating(true);
    try {
      const r = await api.post("/master-count/counts", { name: newName.trim() });
      setNewName("");
      setActiveId(r.data.id);
    } catch (e: any) { flash("err", errMsg(e, "Тооллого үүсгэж чадсангүй")); }
    finally { setCreating(false); }
  }
  async function removeCount(c: CountRow) {
    if (!confirm(`«${c.name}» тооллогыг бүх тоолсон мөртэй нь устгах уу?`)) return;
    try {
      await api.delete(`/master-count/counts/${c.id}`);
      if (activeId === c.id) setActiveId(null);
      flash("ok", "Тооллого устгагдлаа");
      loadCounts();
    } catch (e: any) { flash("err", errMsg(e, "Устгаж чадсангүй")); }
  }
  async function exportTxt(id: number) {
    try { await downloadTxt(id); }
    catch (e: any) { flash("err", errMsg(e, ".txt татаж чадсангүй")); }
  }

  /* ═══════════════ Идэвхтэй тооллого ═══════════════ */
  const [count, setCount] = useState<CountRow | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loadingCount, setLoadingCount] = useState(false);

  const loadCount = useCallback(async (id: number) => {
    setLoadingCount(true);
    try {
      const r = await api.get(`/master-count/counts/${id}`);
      setCount(r.data.count); setLines(r.data.lines || []); setCanEdit(!!r.data.can_edit);
    } catch (e: any) {
      if ([403, 404].includes(e?.response?.status)) setActiveId(null);
      flash("err", errMsg(e, "Тооллого нээгдсэнгүй"));
    } finally { setLoadingCount(false); }
  }, [flash]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeId) { setCount(null); setLines([]); return; }
    if (visible) loadCount(activeId);
  }, [activeId, visible, loadCount]);

  async function patchCount(body: { name?: string; status?: "open" | "done" }) {
    if (!count) return;
    try {
      const r = await api.patch(`/master-count/counts/${count.id}`, body);
      setCount(r.data);
      setCanEdit(r.data.is_owner && r.data.status === "open");
      if (body.status === "done") flash("ok", "Тооллого дууслаа — .txt татаж болно");
    } catch (e: any) { flash("err", errMsg(e, "Хадгалж чадсангүй")); }
  }
  function rename() {
    if (!count) return;
    const n = prompt("Тооллогын нэр", count.name);
    if (n != null && n.trim() && n.trim() !== count.name) patchCount({ name: n.trim() });
  }
  function finish() {
    if (!count) return;
    if (!confirm(`«${count.name}» тооллогыг дуусгах уу? (${count.lines} бараа, нийт ${fmt(count.total_qty)})`)) return;
    patchCount({ status: "done" });
  }

  /* ═══════════════ Скан ═══════════════ */
  const pausedRef = useRef(false);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const bufRef = useRef<{ s: string; at: number }>({ s: "", at: 0 });
  const qtyRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Lookup | null>(null);
  const pendingRef = useRef<Lookup | null>(null);
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [lastAdd, setLastAdd] = useState<{ code: string; prev: number; added: number; total: number } | null>(null);
  const [manual, setManual] = useState("");
  const [showManual, setShowManual] = useState(false);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  // Бараа сонгогдоод тоо нь хараахан ороогүй (эсвэл аль барааг сонгохыг хүлээж) байх үед уншихгүй
  useEffect(() => {
    pausedRef.current = !!pending?.found && !lastAdd;
  }, [pending, lastAdd]);

  const lookup = useCallback(async (raw: string, force = false) => {
    const c = (raw || "").trim();
    if (!c || !activeId) return;
    const now = Date.now();
    if (!force && c === lastRef.current.code && now - lastRef.current.at < REPEAT_MS) return;
    const cur = pendingRef.current;
    // Карт дээрх бараа камерт хэвээр харагдаж байвал дахин ачаалахгүй («+N» мэдээлэл үлдэнэ)
    if (!force && cur?.product && (cur.query === c || cur.product.code === c || cur.product.barcodes.includes(c))) {
      lastRef.current = { code: c, at: now };
      return;
    }
    lastRef.current = { code: c, at: now };
    try { navigator.vibrate?.(50); } catch { /* ignore */ }
    setBusy(true);
    try {
      const r = await api.get("/master-count/lookup", { params: { q: c, count_id: activeId }, timeout: 20000 });
      setPending(r.data); setQty(""); setLastAdd(null);
      if (r.data?.found && r.data?.product) setTimeout(() => qtyRef.current?.focus(), 60);
    } catch (e: any) {
      flash("err", errMsg(e, "Хайлт амжилтгүй"));
    } finally { setBusy(false); }
  }, [activeId, flash]);

  const addQty = useCallback(async (q?: number) => {
    const p = pendingRef.current;
    if (!p?.product || !count) return;
    const typed = (qty || "").trim();
    if (q == null && /^\d{8,}$/.test(typed)) {      // USB скáннер тооны талбарт баркод бичсэн — шинэ бараа
      setQty(""); lookup(typed, true); return;
    }
    const n = q != null ? q : parseFloat(typed.replace(",", "."));
    if (!Number.isFinite(n) || n === 0) { flash("err", "Тоо оруулна уу"); qtyRef.current?.focus(); return; }
    setAdding(true);
    try {
      const r = await api.post(`/master-count/counts/${count.id}/scan`, { code: p.product.code, qty: n, barcode: p.query });
      const line: Line = r.data.line;
      setPending((prev) => (prev ? { ...prev, line } : prev));
      setLastAdd({ code: line.code, prev: r.data.prev, added: r.data.added, total: line.qty });
      setLines((prev) => [line, ...prev.filter((x) => x.id !== line.id)]);
      setCount(r.data.count);
      setQty("");
      try { navigator.vibrate?.([30, 40, 30]); } catch { /* ignore */ }
    } catch (e: any) {
      flash("err", errMsg(e, "Нэмэхэд алдаа гарлаа"));
      if (e?.response?.status === 409 && activeId) loadCount(activeId);
    } finally { setAdding(false); }
  }, [qty, count, lookup, flash, activeId, loadCount]);

  const clearPending = () => { setPending(null); setQty(""); setLastAdd(null); lastRef.current = { code: "", at: 0 }; };

  const cam = useBarcodeCamera((code) => lookup(code), pausedRef);
  const camActive = visible && !!count && canEdit;
  // Утсан дээр тооллого нээгдмэгц камер автоматаар асна
  useEffect(() => {
    if (!camActive || !isMobile) { cam.stop(); return; }
    const t = setTimeout(cam.start, 150);
    return () => { clearTimeout(t); cam.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camActive, isMobile]);

  // USB/Bluetooth скáннер — гар шиг бичээд Enter дардаг
  useEffect(() => {
    if (!camActive) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      const now = Date.now();
      if (now - bufRef.current.at > 120) bufRef.current.s = "";
      bufRef.current.at = now;
      if (isEnter(e)) {
        const s = bufRef.current.s; bufRef.current.s = "";
        if (s.length >= 4) lookup(s, true);
      } else if (e.key.length === 1) {
        bufRef.current.s += e.key;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [camActive, lookup]);

  /* ═══════════════ Мөр засах ═══════════════ */
  const [lq, setLq] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editQty, setEditQty] = useState("");
  async function saveLine(l: Line) {
    if (!count) return;
    const n = parseFloat(editQty.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { flash("err", "Тоо буруу"); return; }
    try {
      const r = await api.put(`/master-count/counts/${count.id}/lines/${l.id}`, { qty: n });
      setLines((prev) => prev.map((x) => (x.id === l.id ? r.data.line : x)));
      setCount(r.data.count); setEditId(null);
      if (pendingRef.current?.line?.id === l.id) setPending((p) => (p ? { ...p, line: r.data.line } : p));
      flash("ok", `${l.code}: ${fmt(n)} болгож засав`);
    } catch (e: any) { flash("err", errMsg(e, "Засаж чадсангүй")); }
  }
  async function deleteLine(l: Line) {
    if (!count || !confirm(`${l.code} · ${l.name} — мөрийг устгах уу?`)) return;
    try {
      const r = await api.delete(`/master-count/counts/${count.id}/lines/${l.id}`);
      setLines((prev) => prev.filter((x) => x.id !== l.id));
      setCount(r.data.count); setEditId(null);
      if (pendingRef.current?.line?.id === l.id) setPending((p) => (p ? { ...p, line: null } : p));
    } catch (e: any) { flash("err", errMsg(e, "Устгаж чадсангүй")); }
  }
  const lql = lq.trim().toLowerCase();
  const shownLines = lql ? lines.filter((l) => `${l.code} ${l.name}`.toLowerCase().includes(lql)) : lines;

  /* ═══════════════ Render ═══════════════ */
  const toastEl = toast && (
    <div className={`fixed left-3 right-3 top-3 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg sm:left-auto sm:right-5 sm:max-w-md ${
      toast.kind === "err" ? "bg-red-600 text-white" : "bg-emerald-600 text-white"}`}>
      {toast.kind === "err" ? <AlertCircle size={15}/> : <Check size={15}/>}
      <span className="flex-1">{toast.msg}</span>
      <button onClick={() => setToast(null)}><X size={14}/></button>
    </div>
  );

  // ── Тооллогын жагсаалт ──
  if (!activeId) {
    return (
      <div ref={rootRef} className="flex flex-col gap-3">
        {header}
        {toastEl}
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <ClipboardList size={18} className="text-indigo-600"/>
            <h2 className="text-[15px] font-bold text-gray-900">Миний тооллого</h2>
            {masterInfo && (
              <span className={`ml-auto text-[11px] ${masterInfo.exists ? "text-gray-400" : "text-rose-600"}`}>
                {masterInfo.exists ? `Мастерт ${masterInfo.products.toLocaleString("mn-MN")} бараа` : "Мастер файл олдсонгүй"}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-gray-500">
            Өөрийн тооллогоо үүсгээд мастерт бүртгэлтэй барааг утасны камераар уншуулж тоол. Нэг барааг дахин уншуулбал тоо нь нэмэгдэнэ. Дуусгаад .txt (code,quantity) татна.
          </p>
          <div className="mt-3 flex gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Нэр (заавал биш) — ж: 2-р тавиур"
              onKeyDown={(e) => { if (isEnter(e)) createCount(); }}
              className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-[14px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"/>
            <button onClick={createCount} disabled={creating}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">
              {creating ? <Loader2 size={15} className="animate-spin"/> : <Plus size={15}/>}Шинэ тооллого
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
            <span className="text-[13px] font-semibold text-gray-700">{scope === "all" ? "Бүх хүний тооллого" : "Миний тооллогууд"}</span>
            {listLoading && <Loader2 size={13} className="animate-spin text-gray-400"/>}
            {canManage && (
              <div className="ml-auto flex rounded-lg bg-gray-100 p-0.5 text-[11.5px] font-semibold">
                <button onClick={() => setScope("mine")} className={`rounded-md px-2.5 py-1 ${scope === "mine" ? "bg-white shadow-sm" : "text-gray-500"}`}>Минийх</button>
                <button onClick={() => setScope("all")} className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${scope === "all" ? "bg-white shadow-sm" : "text-gray-500"}`}>
                  <Users size={11}/>Бүгд
                </button>
              </div>
            )}
          </div>
          {counts.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-gray-400">{listLoading ? "Ачаалж байна…" : "Тооллого алга — «Шинэ тооллого» дарна уу."}</div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {counts.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <button onClick={() => setActiveId(c.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold text-gray-900">{c.name}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                        c.status === "open" ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                        {c.status === "open" ? "Нээлттэй" : "Дууссан"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-gray-500">
                      {c.lines} бараа · нийт {fmt(c.total_qty)} · {when(c.updated_at)}{!c.is_owner && ` · ${c.owner_name}`}
                    </div>
                  </button>
                  <button onClick={() => exportTxt(c.id)} title=".txt татах" disabled={!c.lines}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30">
                    <Download size={15}/>
                  </button>
                  <button onClick={() => removeCount(c)} title="Устгах"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-gray-200 text-gray-400 hover:bg-rose-50 hover:text-rose-600">
                    <Trash2 size={15}/>
                  </button>
                  <ChevronRight size={16} className="shrink-0 text-gray-300"/>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  // ── Тооллого ──
  const p = pending?.product ?? null;
  const showCam = !!count && canEdit;
  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      {header}
      {toastEl}
      {/* Толгой */}
      <div className="rounded-2xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
        <div className="flex items-center gap-2">
          <button onClick={() => { cam.stop(); clearPending(); setActiveId(null); }} title="Тооллогын жагсаалт"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gray-100 text-gray-600 hover:bg-gray-200">
            <ArrowLeft size={16}/>
          </button>
          <div className="min-w-0 flex-1">
            <button onClick={() => count?.is_owner && rename()} className="flex max-w-full items-center gap-1.5 text-left">
              <span className="truncate text-[15px] font-bold text-gray-900">{count?.name ?? "…"}</span>
              {count?.is_owner && <Pencil size={12} className="shrink-0 text-gray-400"/>}
            </button>
            <div className="text-[11.5px] text-gray-500">
              {count ? <>{count.lines} бараа · нийт <b className="text-gray-800">{fmt(count.total_qty)}</b>
                {!count.is_owner && ` · ${count.owner_name}`}</> : "Ачаалж байна…"}
              {count?.status === "done" && <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-gray-500">Дууссан</span>}
            </div>
          </div>
          {count?.is_owner && (count.status === "open" ? (
            <button onClick={finish} className="flex shrink-0 items-center gap-1 rounded-xl bg-emerald-600 px-3 py-2 text-[12.5px] font-semibold text-white hover:bg-emerald-700">
              <CheckCircle2 size={14}/>Дуусгах
            </button>
          ) : (
            <button onClick={() => patchCount({ status: "open" })} className="flex shrink-0 items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-[12.5px] font-semibold text-gray-600 hover:bg-gray-50">
              <RotateCcw size={13}/>Дахин нээх
            </button>
          ))}
          <button onClick={() => count && exportTxt(count.id)} disabled={!count?.lines} title=".txt татах (code,quantity)"
            className={`flex shrink-0 items-center gap-1 rounded-xl px-3 py-2 text-[12.5px] font-semibold disabled:opacity-40 ${
              count?.status === "done" ? "bg-indigo-600 text-white hover:bg-indigo-700" : "border border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
            <Download size={14}/>.txt
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        {/* Скан */}
        {showCam && (
          <div className="flex w-full flex-col gap-2 lg:w-[44%]">
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-black">
              <video ref={cam.videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay/>
              <div id={cam.boxId} className="absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover"/>
              {!cam.camOn && !cam.starting && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-900/90 p-5 text-center text-white">
                  <Camera size={26} className={cam.camErr ? "text-rose-400" : "text-white/70"}/>
                  {cam.camErr && <p className="max-w-xs text-[12px] text-white/80">{cam.camErr}</p>}
                  <div className="flex gap-2">
                    <button onClick={cam.start} className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-[13px] font-semibold hover:bg-indigo-500">
                      <Camera size={14}/>Камер асаах
                    </button>
                    <button onClick={() => setShowManual(true)} className="flex items-center gap-1.5 rounded-xl border border-white/30 px-3.5 py-2 text-[13px] hover:bg-white/10">
                      <Keyboard size={14}/>Гараар
                    </button>
                  </div>
                </div>
              )}
              {cam.starting && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/70 text-[12px] text-white">
                  <Loader2 size={18} className="animate-spin"/>Камер нээгдэж байна…
                </div>
              )}
              {cam.camOn && (
                <>
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className={`h-32 w-64 max-w-[80%] rounded-2xl border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.4)] ${pausedRef.current ? "border-amber-400" : "border-indigo-400"}`}/>
                  </div>
                  <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1.5 text-[11px] text-white/85">
                    <ScanLine size={12}/>{pending?.found && !lastAdd ? "Тоог оруулна уу" : "Баркодыг рамкан дотор барина"}
                  </div>
                  <button onClick={() => setShowManual((v) => !v)} className="absolute right-2 top-2 rounded-lg bg-black/50 p-1.5 text-white/90">
                    <Keyboard size={14}/>
                  </button>
                </>
              )}
              {busy && <div className="absolute left-2 top-2 rounded-full bg-white/90 p-1.5"><Loader2 size={14} className="animate-spin text-indigo-600"/></div>}
            </div>

            {showManual && (
              <div className="flex gap-2">
                <input autoFocus value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Баркод эсвэл код…" inputMode="numeric"
                  onKeyDown={(e) => { if (isEnter(e)) { lookup(manual, true); setManual(""); } }}
                  className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-[14px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"/>
                <button onClick={() => { lookup(manual, true); setManual(""); }} className="shrink-0 rounded-xl bg-indigo-600 px-4 text-[13px] font-semibold text-white">Хайх</button>
              </div>
            )}

            {/* Уншсан бараа */}
            {pending && !pending.found && (
              <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-700">
                <AlertCircle size={16} className="mt-0.5 shrink-0"/>
                <div className="min-w-0 flex-1">
                  <b>Мастерт бүртгэлгүй бараа</b>
                  <div className="font-mono text-[12px]">{pending.query}</div>
                </div>
                <button onClick={clearPending} className="text-rose-400"><X size={15}/></button>
              </div>
            )}
            {pending?.ambiguous && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
                <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-amber-800">
                  <AlertCircle size={15}/>Энэ баркод {pending.candidates?.length} бараанд бүртгэлтэй — аль нь вэ?
                  <button onClick={clearPending} className="ml-auto text-amber-500"><X size={15}/></button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {(pending.candidates || []).map((c) => (
                    <button key={c.code} onClick={() => lookup(c.code, true)}
                      className="flex items-center gap-2 rounded-xl border border-amber-200 bg-white px-3 py-2.5 text-left hover:bg-amber-100/50">
                      <span className="font-mono text-[12px] text-gray-500">{c.code}</span>
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-gray-900">{c.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {p && (
              <div className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-3">
                <div className="flex items-start gap-2.5">
                  {p.image && <img src={p.image.includes("width=") ? p.image : p.image + (p.image.includes("?") ? "&" : "?") + "width=200"} alt=""
                    className="h-14 w-14 shrink-0 rounded-xl bg-white object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}/>}
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-bold leading-snug text-gray-900">{p.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-gray-500">
                      <span className="font-mono font-semibold text-gray-700">{p.code}</span>
                      {pending?.query && pending.query !== p.code && <span className="font-mono">· {pending.query}</span>}
                    </div>
                    <StockBadge code={p.code} variant="block" className="mt-1" />
                  </div>
                  <button onClick={clearPending} className="text-gray-400"><X size={16}/></button>
                </div>

                {lastAdd ? (
                  <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-white">
                    <Check size={18}/>
                    <span className="text-[14px]">{lastAdd.prev ? `${fmt(lastAdd.prev)} + ${fmt(lastAdd.added)} = ` : "+"}<b className="text-[18px]">{fmt(lastAdd.total)}</b></span>
                    <span className="ml-auto text-[11.5px] text-white/80">Дараагийн барааг уншуулна уу</span>
                  </div>
                ) : pending?.line ? (
                  <div className="mt-2 rounded-xl bg-amber-50 px-3 py-1.5 text-[12.5px] text-amber-800">
                    Өмнө тоолсон: <b>{fmt(pending.line.qty)}</b> — оруулсан тоо нэмэгдэнэ
                  </div>
                ) : null}

                <div className="mt-2.5 flex gap-2">
                  <input ref={qtyRef} value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder="Тоо"
                    onKeyDown={(e) => { if (isEnter(e)) addQty(); }}
                    className="min-w-0 flex-1 rounded-xl border border-indigo-200 bg-white px-3 py-3 text-center text-[20px] font-bold outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"/>
                  <button onClick={() => addQty()} disabled={adding || !qty.trim()}
                    className="flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-5 text-[15px] font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
                    {adding ? <Loader2 size={16} className="animate-spin"/> : <Plus size={16}/>}Нэмэх
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-8 gap-1">
                  {QUICK.map((n) => (
                    <button key={n} onClick={() => addQty(n)} disabled={adding}
                      className="rounded-lg border border-indigo-200 bg-white py-2 text-[13px] font-semibold text-indigo-700 active:bg-indigo-100 disabled:opacity-50">
                      +{n}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Тоолсон бараа */}
        <div className="min-w-0 flex-1 rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2.5">
            <span className="text-[13px] font-semibold text-gray-700">Тоолсон бараа ({lines.length})</span>
            {loadingCount && <Loader2 size={13} className="animate-spin text-gray-400"/>}
            <div className="relative ml-auto">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
              <input value={lq} onChange={(e) => setLq(e.target.value)} placeholder="Код, нэр…"
                className="w-36 rounded-lg border border-gray-200 py-1.5 pl-7 pr-2 text-[12.5px] outline-none focus:border-indigo-400 sm:w-48"/>
            </div>
          </div>
          {shownLines.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-gray-400">
              {lines.length ? "Олдсонгүй" : canEdit ? "Барааны баркодыг уншуулж тоолж эхэлнэ үү" : "Тоолсон бараа алга"}
            </div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {shownLines.map((l) => (
                <li key={l.id} className={`px-3 py-2 ${pending?.line?.id === l.id ? "bg-indigo-50/60" : ""}`}>
                  <div className="flex items-center gap-2.5">
                    <button onClick={() => { if (!canEdit) return; setEditId(editId === l.id ? null : l.id); setEditQty(String(l.qty)); }}
                      className="min-w-0 flex-1 text-left">
                      <div className="truncate text-[13.5px] font-medium text-gray-900">{l.name || l.code}</div>
                      <div className="text-[11px] text-gray-400"><span className="font-mono text-gray-500">{l.code}</span> · {l.scans} удаа · {when(l.last_at)}</div>
                    </button>
                    <span className="shrink-0 font-mono text-[18px] font-bold tabular-nums text-gray-900">{fmt(l.qty)}</span>
                  </div>
                  {editId === l.id && canEdit && (
                    <div className="mt-2 flex items-center gap-2">
                      <input autoFocus value={editQty} onChange={(e) => setEditQty(e.target.value)} inputMode="decimal"
                        onKeyDown={(e) => { if (isEnter(e)) saveLine(l); }}
                        className="w-28 rounded-lg border border-gray-300 px-2.5 py-2 text-right text-[15px] font-semibold outline-none focus:border-indigo-400"/>
                      <button onClick={() => saveLine(l)} className="rounded-lg bg-indigo-600 px-3 py-2 text-[12.5px] font-semibold text-white">Хадгалах</button>
                      <button onClick={() => deleteLine(l)} className="ml-auto flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-2 text-[12px] text-rose-600 hover:bg-rose-50">
                        <Trash2 size={12}/>Устгах
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
