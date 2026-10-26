import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Repeat, Search, ScanLine, Plus, Minus, Trash2, Loader2, X, ChevronLeft, ChevronRight, Send, Check,
  ExternalLink, Download, AlertTriangle, PackageOpen, ArrowDown, CalendarDays, RotateCw,
} from "lucide-react";
import { api } from "../lib/api";
import { isNativeApp } from "../lib/serverConfig";
import BarcodeScanner from "../components/BarcodeScanner";

/* Хөрвүүлэлтийн бараа — заалны барааг задлах/хөрвүүлэх. Утсан (APK) дээр голчлон ашиглана.
   1) Бараа хайж (эсвэл уншуулж) тоо оруулаад «Захиалга илгээх» → erxes-д deal
      (Заалны хөдөлгөөн · Худалдагчийн Захиалга · Заал гурил будаа гоймон).
   2) Мөр бүрт юу болгож, хэдэн ширхэг болгож хөрвүүлснийг оруулна.
   3) Нягтлан/хянагч «Эрхэт рүү илгээх» — 03-Заалаас зарлага, 03-Заалд орлого.
   Shell энэ хуудсанд доод цэсээ нуудаг (өөрийн доод товчтой). UI/UX-ийг 2026-10-26-нд шүүгч агентаар шалгуулсан. */

interface Prod { id: string; code: string; name: string; price: number; uom: string; barcodes: string[]; category: string }
interface Res { id?: number; code: string; name: string; uom: string; qty: number; unit_price: number }
interface Line { id: number; code: string; name: string; uom: string; qty: number; unit_price: number; results: Res[] }
interface Order {
  id: number; status: string; conv_date: string; note: string; deal_id: string; deal_number: string; deal_url: string;
  created_by: string; created_at: string | null; sent_by: string; sent_at: string | null; line_count: number;
  converted_count: number; out_amount: number; in_amount: number; erkhet: Record<string, any>; lines?: Line[];
}
interface CartItem { code: string; name: string; price: number; uom: string; qty: number }
interface Draft { items: CartItem[]; note: string; uid: string }

const DRAFT_KEY = "conversion_draft_v2";
const STATUS: Record<string, { label: string; cls: string }> = {
  ordered: { label: "Хөрвүүлэлт дутуу", cls: "bg-amber-100 text-amber-800" },
  converted: { label: "Илгээхэд бэлэн", cls: "bg-sky-100 text-sky-800" },
  sent: { label: "Эрхэтэд орсон", cls: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "Цуцалсан", cls: "bg-gray-100 text-gray-500" },
};
const SEARCH_ATTRS = { autoComplete: "off", autoCorrect: "off", autoCapitalize: "off", spellCheck: false } as const;

const money = (n: number) => `${Math.round(n).toLocaleString("en-US")}₮`;
const qtyFmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));
const newUid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "");
    if (d && Array.isArray(d.items)) return { items: d.items, note: d.note || "", uid: d.uid || newUid() };
  } catch { /* хувийн горим / хоосон */ }
  return { items: [], note: "", uid: newUid() };
}
function ubDay(iso?: string | null) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
const buzz = () => { try { navigator.vibrate?.(40); } catch { /* дэмжихгүй */ } };

/** Android «буцах» товч (lib/backButton → history.back) нээлттэй цонхыг хаана, хуудаснаас гаргахгүй.
 *  onBack false буцаавал (жишээ нь хадгалаагүй өөрчлөлт) цонх нээлттэй үлдэнэ. */
function useBackClose(onBack: () => boolean | void) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    window.history.pushState({ convModal: true }, "");
    let popped = false;
    const onPop = () => {
      if (ref.current() === false) { window.history.pushState({ convModal: true }, ""); return; }
      popped = true;
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!popped && window.history.state?.convModal) window.history.back();
    };
  }, []);
}

/** Жижиг мэдэгдэл (+ «Буцаах» сонголт) — нэг timer-тэй, дэлгэц уншигчид зарлагдана. */
function useToast() {
  const [t, setT] = useState<{ text: string; undo?: () => void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, undo?: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    setT({ text, undo });
    timer.current = setTimeout(() => setT(null), undo ? 4000 : 1600);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const node = t && (
    <div role="status" aria-live="polite"
      className="fixed inset-x-0 bottom-[calc(124px+env(safe-area-inset-bottom))] z-[70] mx-auto flex w-fit max-w-[90vw] items-center gap-3 rounded-full bg-gray-900/95 py-2 pl-4 pr-2 text-[14px] text-white shadow-lg">
      <span className="truncate">{t.text}</span>
      {t.undo
        ? <button onClick={() => { t.undo!(); setT(null); }} className="h-9 rounded-full bg-white/15 px-3 font-semibold">Буцаах</button>
        : <span className="w-2" />}
    </div>
  );
  return { show, node };
}

// ── Тоо өөрчлөх (том, хуруунд тохиромжтой; бичих үед шууд хадгалагдана) ────────
function QtyStepper({ value, onChange, min = 0 }: { value: number; onChange: (v: number) => void; min?: number }) {
  const [txt, setTxt] = useState(qtyFmt(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setTxt(qtyFmt(value)); }, [value]);
  return (
    <div className="flex h-12 items-stretch overflow-hidden rounded-xl border border-gray-200 bg-white">
      <button type="button" aria-label="Нэгээр хасах" onClick={() => onChange(Math.max(min, value - 1))}
        className="grid w-12 place-items-center text-gray-700 active:bg-gray-100"><Minus size={20} /></button>
      <input inputMode="decimal" enterKeyHint="done" value={txt} aria-label="Тоо"
        onChange={e => {
          const t = e.target.value.replace(",", ".");
          setTxt(t);
          const n = parseFloat(t);
          if (isFinite(n) && n >= min) onChange(n);
        }}
        onFocus={e => { focused.current = true; e.target.select(); }}
        onBlur={() => { focused.current = false; setTxt(qtyFmt(value)); }}
        onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
        className="w-16 border-x border-gray-100 text-center text-[17px] font-bold text-gray-900 outline-none" />
      <button type="button" aria-label="Нэгээр нэмэх" onClick={() => onChange(value + 1)}
        className="grid w-12 place-items-center text-gray-700 active:bg-gray-100"><Plus size={20} /></button>
    </div>
  );
}

// ── Бараа хайх ────────────────────────────────────────────────────────────────
function useProductSearch() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Prod[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    const t = q.trim();
    const my = ++seq.current;                       // богино болсон ч хуучин хариу ирж дүүргэхгүй
    if (t.length < 2) { setItems([]); setErr(""); setBusy(false); return; }
    setBusy(true);
    const h = setTimeout(async () => {
      try {
        const r = await api.get("/conversion/products", { params: { q: t }, timeout: 60000 });
        if (my === seq.current) { setItems(r.data.items); setErr(""); }
      } catch (e: any) {
        if (my === seq.current) setErr(e?.response?.data?.detail ?? "Хайж чадсангүй — сүлжээгээ шалгана уу");
      } finally { if (my === seq.current) setBusy(false); }
    }, 250);
    return () => clearTimeout(h);
  }, [q]);
  return { q, setQ, items, busy, err };
}

async function lookupScanned(code: string): Promise<Prod | null | "error"> {
  try {
    const r = await api.get("/conversion/products", { params: { q: code }, timeout: 30000 });
    return (r.data.items as Prod[]).find(p => p.code === code || p.barcodes.includes(code)) ?? null;
  } catch { return "error"; }
}

function SearchBox({ s, onScan, placeholder, onEnterOne, autoFocus }: {
  s: ReturnType<typeof useProductSearch>; onScan: () => void; placeholder: string;
  onEnterOne: (p: Prod) => void; autoFocus?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={s.q} onChange={e => s.setQ(e.target.value)} placeholder={placeholder} enterKeyHint="search"
          autoFocus={autoFocus} {...SEARCH_ATTRS} aria-label="Бараа хайх"
          onKeyDown={e => { if (e.key === "Enter" && s.items.length === 1 && !s.busy) onEnterOne(s.items[0]); }}
          className="h-12 w-full rounded-2xl border border-gray-200 bg-white pl-10 pr-11 text-[16px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
        {s.busy ? <Loader2 size={17} className="absolute right-3.5 top-1/2 -translate-y-1/2 animate-spin text-gray-400" />
          : s.q && <button aria-label="Хайлт цэвэрлэх" onClick={() => s.setQ("")}
            className="absolute right-1 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center text-gray-500"><X size={18} /></button>}
      </div>
      <button onClick={onScan} aria-label="Баркод уншуулах"
        className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-indigo-600 text-white shadow-sm active:bg-indigo-700"><ScanLine size={22} /></button>
    </div>
  );
}

function ProductRow({ p, onClick }: { p: Prod; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl border border-gray-100 bg-white px-3 py-2.5 text-left active:bg-indigo-50">
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-snug text-gray-900">{p.name}</div>
        <div className="mt-0.5 text-[13px] text-gray-500"><span className="font-mono">{p.code}</span> · {money(p.price)}</div>
      </div>
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-700"><Plus size={22} /></span>
    </button>
  );
}

function ErrorBox({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div role="alert" className="mb-3 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 py-2 pl-3 pr-1 text-[14px] text-rose-700">
      <AlertTriangle size={17} className="mt-1 shrink-0" /><span className="flex-1 py-1">{text}</span>
      <button aria-label="Хаах" onClick={onClose} className="grid h-10 w-10 shrink-0 place-items-center"><X size={18} /></button>
    </div>
  );
}

/** Дэлгэцийн доод тогтсон үйлдлийн мөр (Shell-ийн доод цэс энэ хуудсанд нуугдсан). Гар нээлттэй үед нуугдана. */
function BottomBar({ children }: { children: React.ReactNode }) {
  // Android-д гарыг back/IME-ээр хаахад input focus-оо алддаггүй — тиймээс цонхны өндөр багассанаар таних
  const [kb, setKb] = useState(false);
  const maxH = useRef(typeof window !== "undefined" ? window.innerHeight : 0);
  useEffect(() => {
    const f = () => {
      maxH.current = Math.max(maxH.current, window.innerHeight);
      setKb(window.innerHeight < maxH.current * 0.75);
    };
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  if (kb) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-64">
      <div className="mx-auto max-w-2xl">{children}</div>
    </div>
  );
}

/** Сканнер — Android «буцах» нь зөвхөн камерыг хаана (хуудаснаас гаргахгүй). */
function ScanModal({ onClose, onDetected }: { onClose: () => void; onDetected: (code: string) => void }) {
  useBackClose(() => { onClose(); });
  return <BarcodeScanner onClose={onClose} onDetected={onDetected} />;
}

function Sheet({ title, onClose, children, locked }: { title: string; onClose: () => void; children: React.ReactNode; locked?: boolean }) {
  useBackClose(() => { if (locked) return false; onClose(); });
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center" onClick={() => !locked && onClose()}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(20px,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-200 sm:hidden" />
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[18px] font-bold text-gray-900">{title}</h3>
          <button aria-label="Хаах" disabled={locked} onClick={onClose} className="grid h-11 w-11 place-items-center rounded-xl text-gray-500 active:bg-gray-100"><X size={22} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Нүүр: шинэ захиалга | жагсаалт ───────────────────────────────────────────
export default function ConversionPage() {
  const { id } = useParams();
  if (id) return <OrderDetail id={Number(id)} />;
  return <ConversionHome />;
}

function ConversionHome() {
  const [params, setParams] = useSearchParams();
  const tab: "new" | "list" = params.get("tab") === "list" ? "list" : params.get("tab") === "new" ? "new"
    : (loadDraft().items.length ? "new" : "list");
  const setTab = (t: "new" | "list") => setParams({ tab: t }, { replace: true });
  return (
    <div className="mx-auto max-w-2xl pb-32">
      <div className="mb-3 hidden items-center gap-3 lg:flex">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-sm"><Repeat size={18} /></div>
        <div>
          <h1 className="text-[17px] font-bold leading-tight text-gray-900">Хөрвүүлэлт</h1>
          <p className="text-[12px] text-gray-500">Заалны барааг задлах, хөрвүүлэх</p>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-2 rounded-2xl bg-gray-100 p-1" role="tablist">
        {([["new", "Шинэ захиалга"], ["list", "Захиалгууд"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`h-11 rounded-xl text-[15px] font-semibold ${tab === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-600"}`}>{l}</button>
        ))}
      </div>
      {tab === "new" ? <NewOrder onSent={() => setTab("list")} /> : <OrderList />}
    </div>
  );
}

function NewOrder({ onSent }: { onSent: () => void }) {
  const nav = useNavigate();
  const s = useProductSearch();
  const init = useMemo(loadDraft, []);
  const [cart, setCart] = useState<CartItem[]>(init.items);
  const [note, setNote] = useState(init.note);
  const [uid, setUid] = useState(init.uid);
  const [scan, setScan] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [customer, setCustomer] = useState("Заал гурил будаа гоймон");
  const toast = useToast();

  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ items: cart, note, uid })); } catch { /* */ } }, [cart, note, uid]);
  useEffect(() => { api.get("/conversion/settings").then(r => setCustomer(r.data.customer_name)).catch(() => {}); }, []);

  const add = useCallback((p: Prod) => {
    setCart(c => {
      const i = c.findIndex(x => x.code === p.code);
      if (i >= 0) { const n = [...c]; n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; }
      return [{ code: p.code, name: p.name, price: p.price, uom: p.uom, qty: 1 }, ...c];
    });
    buzz();
    toast.show(`Нэмэгдлээ: ${p.name}`);
    s.setQ("");
  }, [s, toast]);

  function remove(i: number) {
    const item = cart[i];
    setCart(x => x.filter((_, j) => j !== i));
    toast.show(`Хасагдлаа: ${item.name}`, () => setCart(x => {
      if (x.some(y => y.code === item.code)) return x;
      const n = [...x]; n.splice(Math.min(i, n.length), 0, item); return n;
    }));
  }

  async function onScanned(code: string) {
    setScan(false); setScanBusy(true);
    const hit = await lookupScanned(code);
    setScanBusy(false);
    if (hit === "error") setErr("Хайж чадсангүй — сүлжээгээ шалгана уу");
    else if (hit) add(hit);
    else setErr(`«${code}» баркодтой бараа олдсонгүй. Нэрээр нь хайна уу.`);
  }

  async function send() {
    setSending(true); setErr("");
    try {
      const r = await api.post("/conversion/orders",
        { lines: cart.map(c => ({ code: c.code, qty: c.qty })), note, client_uid: uid }, { timeout: 90000 });
      setCart([]); setNote(""); setUid(newUid()); setConfirm(false);
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
      onSent();
      nav(`/conversion/${r.data.id}`, { replace: true, state: r.data.deduped ? { deduped: true } : undefined });
    } catch (e: any) {
      // uid хэвээр — дахин дарахад сервер давхар deal үүсгэхгүй
      setErr(e?.response?.data?.detail ?? "Илгээж чадсангүй — дахин дарна уу (давхар үүсэхгүй)");
      setConfirm(false);
    } finally { setSending(false); }
  }

  const total = cart.reduce((a, c) => a + c.qty * c.price, 0);
  const zero = cart.some(c => c.qty <= 0);
  return (
    <>
      <div className="sticky top-[calc(max(8px,env(safe-area-inset-top))+49px)] z-20 -mx-3 bg-gray-50/95 px-3 pb-2 pt-1 backdrop-blur lg:top-0">
        <SearchBox s={s} onScan={() => setScan(true)} placeholder="Код, нэр эсвэл баркод" onEnterOne={add} />
      </div>
      {scanBusy && <p className="mb-2 flex items-center gap-2 text-[14px] text-gray-600"><Loader2 size={16} className="animate-spin" />Баркодоор хайж байна…</p>}
      {s.err && <p className="mb-2 text-[14px] text-rose-600">{s.err}</p>}
      {s.q.trim().length >= 2 && (
        <div className="mb-4 space-y-2">
          {s.items.map(p => <ProductRow key={p.code} p={p} onClick={() => add(p)} />)}
          {!s.busy && !s.err && !s.items.length && <p className="py-4 text-center text-[14px] text-gray-500">Бараа олдсонгүй</p>}
        </div>
      )}

      {err && <ErrorBox text={err} onClose={() => setErr("")} />}

      {cart.length === 0 && s.q.trim().length < 2 ? (
        <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center">
          <PackageOpen size={40} className="text-gray-400" />
          <p className="text-[16px] font-semibold text-gray-800">Хөрвүүлэх бараагаа нэмнэ үү</p>
          <p className="text-[14px] text-gray-500">Дээрх талбарт хайх эсвэл <ScanLine size={14} className="inline" /> товчоор баркод уншуулна.</p>
        </div>
      ) : cart.length > 0 && (
        <>
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-[15px] font-bold text-gray-800">Захиалга · {cart.length} бараа</h2>
            <button onClick={() => { if (window.confirm("Сагсыг бүхэлд нь цэвэрлэх үү?")) setCart([]); }}
              className="h-11 px-2 text-[14px] text-gray-500">Бүгдийг цэвэрлэх</button>
          </div>
          <div className="space-y-2">
            {cart.map((c, i) => (
              <div key={c.code} className={`rounded-2xl border bg-white p-3 shadow-sm ${c.qty <= 0 ? "border-rose-300" : "border-gray-100"}`}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold leading-snug text-gray-900">{c.name}</div>
                    <div className="mt-0.5 text-[13px] text-gray-500"><span className="font-mono">{c.code}</span> · {money(c.price)} / {c.uom}</div>
                  </div>
                  <button aria-label={`${c.name} хасах`} onClick={() => remove(i)}
                    className="-mr-1 -mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-xl text-gray-400 active:bg-rose-50 active:text-rose-600"><Trash2 size={19} /></button>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <QtyStepper value={c.qty} min={0} onChange={v => setCart(x => x.map((y, j) => j === i ? { ...y, qty: v } : y))} />
                  <span className="text-[14px] font-semibold text-gray-800">{money(c.qty * c.price)}</span>
                </div>
              </div>
            ))}
          </div>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Тэмдэглэл (заавал биш)"
            className="mt-3 w-full rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-[16px] outline-none focus:border-indigo-400" />
        </>
      )}

      {cart.length > 0 && (
        <BottomBar>
          {zero && <p className="mb-1.5 text-center text-[13px] font-medium text-rose-600">Тоо 0 мөрийг хасах эсвэл тоо оруулна уу</p>}
          <button onClick={() => setConfirm(true)} disabled={zero}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-[17px] font-bold text-white shadow-lg shadow-indigo-600/20 active:bg-indigo-700 disabled:opacity-50">
            <Send size={19} />Захиалга илгээх · {cart.length} бараа
          </button>
        </BottomBar>
      )}

      {toast.node}

      {confirm && (
        <Sheet onClose={() => setConfirm(false)} title="Захиалга илгээх үү?" locked={sending}>
          <p className="mb-3 text-[14px] text-gray-600">
            erxes-д «Худалдагчийн Захиалга» шатанд шинэ захиалга үүснэ. Харилцагч: <b>{customer}</b>.
          </p>
          <div className="mb-3 max-h-64 space-y-2 overflow-auto rounded-2xl bg-gray-50 p-3">
            {cart.map(c => (
              <div key={c.code} className="flex justify-between gap-2 text-[14px]">
                <span className="min-w-0 flex-1 text-gray-800">{c.name}</span>
                <b className="shrink-0">{qtyFmt(c.qty)} {c.uom}</b>
              </div>
            ))}
          </div>
          <div className="mb-4 flex justify-between text-[15px]"><span className="text-gray-600">Нийт дүн</span><b>{money(total)}</b></div>
          <button onClick={send} disabled={sending}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-[17px] font-bold text-white active:bg-indigo-700 disabled:opacity-60">
            {sending ? <Loader2 size={19} className="animate-spin" /> : <Send size={19} />}{sending ? "Илгээж байна…" : "Тийм, илгээх"}
          </button>
          <button onClick={() => setConfirm(false)} disabled={sending} className="mt-2 h-12 w-full rounded-2xl text-[16px] font-semibold text-gray-600">Буцах</button>
        </Sheet>
      )}
      {scan && <ScanModal onClose={() => setScan(false)} onDetected={onScanned} />}
    </>
  );
}

function OrderList() {
  const nav = useNavigate();
  const [items, setItems] = useState<Order[] | null>(null);
  const [filter, setFilter] = useState("ordered,converted");
  const [limit, setLimit] = useState(30);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setErr("");
    api.get("/conversion/orders", { params: { status: filter, limit } })
      .then(r => setItems(r.data.items))
      .catch(e => { setErr(e?.response?.data?.detail ?? "Ачаалж чадсангүй — сүлжээгээ шалгана уу"); setItems([]); });
  }, [filter, limit, tick]);
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex flex-1 gap-2 overflow-x-auto">
          {([["ordered,converted", "Хийгдэж буй"], ["sent", "Эрхэтэд орсон"], ["", "Бүгд"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => { setFilter(k); setItems(null); setLimit(30); }}
              className={`h-11 shrink-0 rounded-full px-4 text-[14px] font-semibold ${filter === k ? "bg-gray-900 text-white" : "bg-white text-gray-700 ring-1 ring-gray-200"}`}>{l}</button>
          ))}
        </div>
        <button aria-label="Шинэчлэх" onClick={() => { setItems(null); setTick(t => t + 1); }}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-gray-600 ring-1 ring-gray-200"><RotateCw size={18} /></button>
      </div>
      {err && <ErrorBox text={err} onClose={() => setErr("")} />}
      {!items ? <div className="flex justify-center py-10"><Loader2 className="animate-spin text-gray-400" /></div>
        : !items.length ? (!err && <p className="py-10 text-center text-[15px] text-gray-500">Хөрвүүлэлт алга</p>)
        : (
          <div className="space-y-2">
            {items.map(o => {
              const st = STATUS[o.status] ?? { label: o.status, cls: "bg-gray-100" };
              const pct = o.line_count ? Math.round(o.converted_count / o.line_count * 100) : 0;
              return (
                <button key={o.id} onClick={() => nav(`/conversion/${o.id}`)}
                  className="w-full rounded-2xl border border-gray-100 bg-white p-3.5 text-left shadow-sm active:bg-gray-50">
                  <div className="flex items-center gap-2">
                    <span className="text-[16px] font-bold text-gray-900">#{o.id}</span>
                    <span className="text-[14px] text-gray-500">{o.conv_date}</span>
                    <span className={`ml-auto rounded-full px-2.5 py-1 text-[12px] font-semibold ${st.cls}`}>{st.label}</span>
                    <ChevronRight size={18} className="text-gray-400" />
                  </div>
                  <div className="mt-1 text-[13px] text-gray-500">{o.line_count} бараа · №{o.deal_number || " —"} · {o.created_by}</div>
                  {o.status !== "cancelled" && o.status !== "sent" && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                        <div className={`h-full rounded-full ${pct === 100 ? "bg-emerald-500" : "bg-amber-400"}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[13px] font-semibold text-gray-700">{o.converted_count}/{o.line_count}</span>
                    </div>
                  )}
                </button>
              );
            })}
            {items.length >= limit && (
              <button onClick={() => setLimit(l => l + 30)} className="h-12 w-full rounded-2xl bg-white text-[15px] font-semibold text-gray-700 ring-1 ring-gray-200">Цааш үзэх</button>
            )}
          </div>
        )}
    </>
  );
}

// ── Дэлгэрэнгүй: мөр бүрт хөрвүүлэлтийн үр дүн ──────────────────────────────
function OrderDetail({ id }: { id: number }) {
  const nav = useNavigate();
  const goList = () => nav("/conversion?tab=list", { replace: true });
  const [o, setO] = useState<Order | null>(null);
  const [err, setErr] = useState("");
  const [canSend, setCanSend] = useState(false);
  const [editLine, setEditLine] = useState<Line | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const native = isNativeApp();

  const [deduped] = useState(() => !!(window.history.state?.usr as any)?.deduped);
  const load = useCallback(() => api.get(`/conversion/orders/${id}`).then(r => setO(r.data))
    .catch(e => setErr(e?.response?.data?.detail ?? "Ачаалж чадсангүй")), [id]);
  useEffect(() => { load(); api.get("/conversion/settings").then(r => setCanSend(!!r.data.can_send)).catch(() => {}); }, [load]);

  const locked = !o || o.status === "sent" || o.status === "cancelled";

  async function setDate(d: string) {
    try { const r = await api.put(`/conversion/orders/${id}`, { conv_date: d }); setO(r.data); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? "Хадгалж чадсангүй"); }
  }

  async function download(kind: "so" | "income") {
    try {
      const r = await api.get(`/conversion/orders/${id}/xlsx`, { params: { kind }, responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url; a.download = `Хөрвүүлэлт_${id}_${kind === "so" ? "Зарлага" : "Орлого"}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch { setErr("Excel татаж чадсангүй"); }
  }

  async function sendErkhet() {
    setBusy(true); setErr("");
    try { await api.post(`/conversion/orders/${id}/erkhet`, { confirm: true }, { timeout: 180000 }); setSendOpen(false); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? "Эрхэт рүү илгээж чадсангүй — төлөвийг шалгаад дахин оролдоно уу"); setSendOpen(false); }
    finally { setBusy(false); load(); }               // хариу тасарсан ч бодит төлөвийг харуулна
  }

  async function cancel() {
    if (!window.confirm("Энэ хөрвүүлэлтийг цуцлах уу?\n\nerxes дээрх захиалга автоматаар устахгүй — erxes-ээс гараар устгана.")) return;
    try { const r = await api.post(`/conversion/orders/${id}/cancel`); setO(r.data); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? "Цуцалж чадсангүй"); }
  }

  function onSaved(x: Order, lineId: number) {
    setO(x);
    // Дараагийн хөрвүүлэлт оруулаагүй мөрийг шууд нээнэ
    const lines = x.lines ?? [];
    const idx = lines.findIndex(l => l.id === lineId);
    const next = [...lines.slice(idx + 1), ...lines.slice(0, idx)].find(l => !l.results.some(r => r.qty > 0));
    setEditLine(next ?? null);
  }

  if (!o) return (
    <div className="mx-auto max-w-2xl">
      <button onClick={goList} className="mb-3 flex h-11 items-center gap-1 text-[15px] text-gray-700"><ChevronLeft size={20} />Буцах</button>
      {err ? <ErrorBox text={err} onClose={() => setErr("")} /> : <div className="flex justify-center py-10"><Loader2 className="animate-spin text-gray-400" /></div>}
    </div>
  );
  const st = STATUS[o.status] ?? { label: o.status, cls: "bg-gray-100" };
  const diff = o.in_amount - o.out_amount;
  const incomplete = o.converted_count < o.line_count;
  const needsCheck = incomplete || Math.abs(diff) > 1;
  return (
    <div className="mx-auto max-w-2xl pb-32">
      <div className="mb-3 flex items-center gap-2">
        <button onClick={goList} aria-label="Буцах" className="grid h-11 w-11 place-items-center rounded-xl bg-white text-gray-700 ring-1 ring-gray-200"><ChevronLeft size={22} /></button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[18px] font-bold leading-tight text-gray-900">Хөрвүүлэлт #{o.id}</h1>
          <p className="truncate text-[13px] text-gray-500">{o.created_by} · {ubDay(o.created_at)}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${st.cls}`}>{st.label}</span>
      </div>

      {err && <ErrorBox text={err} onClose={() => setErr("")} />}
      {deduped && (
        <p role="status" className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-[14px] text-amber-900">
          Энэ захиалга өмнөх илгээлтээр аль хэдийн үүссэн байсан тул шинээр үүсгээгүй. Бараа, тоог шалгана уу.
        </p>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="rounded-2xl bg-white p-3 ring-1 ring-gray-100">
          <span className="flex items-center gap-1 text-[13px] text-gray-500"><CalendarDays size={14} />Хөрвүүлсэн огноо</span>
          <input type="date" value={o.conv_date} disabled={locked} onChange={e => e.target.value && setDate(e.target.value)}
            className="mt-1 h-8 w-full bg-transparent text-[16px] font-semibold text-gray-900 outline-none disabled:text-gray-500" />
        </label>
        {o.deal_url ? (
          <a href={o.deal_url} target="_blank" rel="noreferrer" className="rounded-2xl bg-white p-3 ring-1 ring-gray-100 active:bg-gray-50">
            <span className="flex items-center gap-1 text-[13px] text-gray-500">erxes захиалга № <ExternalLink size={13} /></span>
            <span className="mt-1 block truncate font-mono text-[15px] font-semibold text-indigo-700">{o.deal_number || "—"}</span>
          </a>
        ) : (
          <div className="rounded-2xl bg-white p-3 ring-1 ring-gray-100">
            <span className="text-[13px] text-gray-500">erxes захиалга №</span>
            <span className="mt-1 block font-mono text-[15px] text-gray-500">—</span>
          </div>
        )}
      </div>
      {o.note && <p className="mb-3 rounded-2xl bg-white p-3 text-[14px] text-gray-700 ring-1 ring-gray-100">{o.note}</p>}

      <h2 className="mb-2 text-[15px] font-bold text-gray-800">Бараа бүрийг юу болгож хөрвүүлсэн бэ? · {o.converted_count}/{o.line_count}</h2>
      <div className="space-y-2">
        {(o.lines ?? []).map(l => {
          const done = l.results.some(r => r.qty > 0);
          return (
            <div key={l.id} className={`rounded-2xl border bg-white p-3 shadow-sm ${done ? "border-emerald-200" : "border-amber-300"}`}>
              <div className="flex items-start gap-2">
                <span role="img" aria-label={done ? "Хөрвүүлэлт оруулсан" : "Хөрвүүлэлт оруулаагүй"}
                  className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${done ? "bg-emerald-500 text-white" : "bg-amber-100 text-amber-800"}`}>
                  {done ? <Check size={14} /> : <span className="text-[12px] font-bold">!</span>}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold leading-snug text-gray-900">{l.name}</div>
                  <div className="text-[13px] text-gray-500"><span className="font-mono">{l.code}</span> · <b className="text-gray-800">{qtyFmt(l.qty)} {l.uom}</b> · {money(l.qty * l.unit_price)}</div>
                </div>
              </div>
              {done && (
                <div className="mt-2 rounded-xl bg-emerald-50/70 p-2.5">
                  <div className="mb-1 flex items-center gap-1 text-[12.5px] font-semibold text-emerald-800"><ArrowDown size={14} />Гарсан бараа</div>
                  {l.results.map(r => (
                    <div key={r.id ?? r.code} className="flex justify-between gap-2 text-[14px]">
                      <span className="min-w-0 flex-1 text-gray-800">{r.name} <span className="font-mono text-[12px] text-gray-500">{r.code}</span></span>
                      <b className="shrink-0">{qtyFmt(r.qty)} {r.uom}</b>
                    </div>
                  ))}
                </div>
              )}
              {!locked && (
                <button onClick={() => setEditLine(l)}
                  className={`mt-2 flex h-12 w-full items-center justify-center gap-1.5 rounded-xl text-[15px] font-semibold ${done ? "bg-gray-100 text-gray-800" : "bg-amber-500 text-white"} active:opacity-80`}>
                  {done ? "Засах" : <><Plus size={18} />Хөрвүүлэлт оруулах</>}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-2xl bg-white p-3 text-[14px] ring-1 ring-gray-100">
        <div className="flex justify-between"><span className="text-gray-600">Зарлага (03-Заалаас)</span><b>{money(o.out_amount)}</b></div>
        <div className="flex justify-between"><span className="text-gray-600">Орлого (03-Заалд)</span><b>{money(o.in_amount)}</b></div>
        {o.converted_count > 0 && Math.abs(diff) > 1 && (
          <div className={`mt-1 flex justify-between border-t border-gray-100 pt-1 ${diff < 0 ? "text-rose-600" : "text-emerald-700"}`}>
            <span>Үнийн зөрүү (орлого − зарлага)</span><b>{diff > 0 ? "+" : "−"}{money(Math.abs(diff))}</b>
          </div>
        )}
        {o.status === "sent" && <p className="mt-2 text-[13px] text-emerald-700">Эрхэтэд илгээсэн: {o.sent_by} · {ubDay(o.sent_at)}</p>}
        {Object.entries(o.erkhet || {}).map(([k, v]: any) => v?.status === "fail" && (
          <p key={k} className="mt-1 text-[13px] text-rose-600">{k === "so" ? "Зарлага" : "Орлого"}: {v.message || (v.errors || []).join("; ")}</p>
        ))}
      </div>

      {/* Excel — APK-д (WebView) файл татагддаггүй тул зөвхөн компьютер/хөтөчид */}
      {!native && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button onClick={() => download("so")} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-white text-[14px] font-semibold text-gray-700 ring-1 ring-gray-200"><Download size={16} />Зарлага Excel</button>
          <button onClick={() => download("income")} disabled={!o.converted_count} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-white text-[14px] font-semibold text-gray-700 ring-1 ring-gray-200 disabled:opacity-40"><Download size={16} />Орлого Excel</button>
        </div>
      )}
      {!locked && (
        <div className="mt-8 border-t border-gray-200 pt-4">
          <button onClick={cancel} className="h-12 w-full rounded-xl text-[15px] font-semibold text-rose-600 ring-1 ring-rose-200">Хөрвүүлэлтийг цуцлах</button>
        </div>
      )}

      {canSend && o.status === "converted" && (
        <BottomBar>
          <button onClick={() => { setChecked(false); setSendOpen(true); }} disabled={busy}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 text-[17px] font-bold text-white shadow-lg shadow-emerald-600/20 active:bg-emerald-700 disabled:opacity-60">
            <Send size={19} />Эрхэт рүү илгээх
          </button>
        </BottomBar>
      )}

      {editLine && (
        <EditorHost>
          {register => (
            <ResultEditor key={editLine.id} order={o} line={editLine} registerClose={register}
              hasNext={(o.lines ?? []).some(l => l.id !== editLine.id && !l.results.some(r => r.qty > 0))}
              onClose={() => setEditLine(null)} onSaved={x => onSaved(x, editLine.id)} />
          )}
        </EditorHost>
      )}

      {sendOpen && (
        <Sheet title="Эрхэт рүү илгээх үү?" onClose={() => setSendOpen(false)} locked={busy}>
          <ul className="mb-3 space-y-1.5 text-[14px] text-gray-700">
            <li>• <b>Зарлага</b> — {o.line_count} бараа 03-Заалаас, {money(o.out_amount)}</li>
            <li>• <b>Орлого</b> — гарсан бараа 03-Заалд, {money(o.in_amount)}</li>
            <li>• Гүйлгээний утга: «{o.conv_date}-ний хөрвүүлэлт #{o.id}», данс 320101</li>
          </ul>
          {needsCheck && (
            <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[14px] text-rose-700">
              {incomplete && <p>⚠ {o.line_count - o.converted_count} мөрөнд хөрвүүлэлт оруулаагүй.</p>}
              {Math.abs(diff) > 1 && <p>⚠ Үнийн зөрүү: {diff > 0 ? "+" : "−"}{money(Math.abs(diff))} — шалгаад илгээнэ үү.</p>}
              <label className="mt-2 flex min-h-[44px] items-center gap-3 font-semibold">
                <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} className="h-6 w-6 accent-rose-600" />
                Шалгасан, илгээнэ
              </label>
            </div>
          )}
          <p className="mb-4 rounded-xl bg-amber-50 p-2.5 text-[13px] text-amber-900">Нэг удаа л илгээнэ. Илгээсний дараа засах боломжгүй.</p>
          <button onClick={sendErkhet} disabled={busy || (needsCheck && !checked)}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 text-[17px] font-bold text-white active:bg-emerald-700 disabled:opacity-50">
            {busy ? <Loader2 size={19} className="animate-spin" /> : <Send size={19} />}{busy ? "Илгээж байна…" : "Тийм, илгээх"}
          </button>
          <button onClick={() => setSendOpen(false)} disabled={busy} className="mt-2 h-12 w-full rounded-2xl text-[16px] font-semibold text-gray-600">Буцах</button>
        </Sheet>
      )}
    </div>
  );
}

/** Засварын цонх мөр солигдсон ч НЭГ history entry-тэй байна (мөр бүрт push/back хийвэл дараагийн цонх өөрөө хаагддаг байсан). */
function EditorHost({ children }: { children: (register: (f: () => boolean) => void) => React.ReactNode }) {
  const closeRef = useRef<() => boolean>(() => true);
  useBackClose(() => closeRef.current());
  return <>{children(f => { closeRef.current = f; })}</>;
}

function ResultEditor({ order, line, onClose, onSaved, registerClose, hasNext }: {
  order: Order; line: Line; onClose: () => void; onSaved: (o: Order) => void;
  registerClose: (f: () => boolean) => void; hasNext: boolean;
}) {
  const s = useProductSearch();
  const [rows, setRows] = useState<Res[]>(() => line.results.map(r => ({ ...r })));
  const [scan, setScan] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();
  const dirty = useMemo(() => JSON.stringify(rows.map(r => [r.code, r.qty])) !== JSON.stringify(line.results.map(r => [r.code, r.qty])), [rows, line]);
  const tryClose = () => { if (dirty && !window.confirm("Хадгалаагүй өөрчлөлт алга болно. Хаах уу?")) return false; onClose(); return true; };
  registerClose(() => (saving ? false : tryClose()));

  function add(p: Prod) {
    setRows(x => {
      const i = x.findIndex(r => r.code === p.code);
      if (i >= 0) { const n = [...x]; n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; }
      return [...x, { code: p.code, name: p.name, uom: p.uom, qty: 1, unit_price: p.price }];
    });
    buzz();
    toast.show(`Нэмэгдлээ: ${p.name}`);
    s.setQ("");
  }
  function remove(i: number) {
    const r = rows[i];
    setRows(x => x.filter((_, j) => j !== i));
    toast.show(`Хасагдлаа: ${r.name}`, () => setRows(x => {
      if (x.some(y => y.code === r.code)) return x;
      const n = [...x]; n.splice(Math.min(i, n.length), 0, r); return n;
    }));
  }
  async function onScanned(code: string) {
    setScan(false); setScanBusy(true);
    const hit = await lookupScanned(code);
    setScanBusy(false);
    if (hit === "error") setErr("Хайж чадсангүй — сүлжээгээ шалгана уу");
    else if (hit) add(hit);
    else setErr(`«${code}» баркодтой бараа олдсонгүй. Нэрээр нь хайна уу.`);
  }
  async function save() {
    setSaving(true); setErr("");
    try {
      const r = await api.put(`/conversion/orders/${order.id}/lines/${line.id}`, { results: rows.filter(x => x.qty > 0).map(x => ({ code: x.code, qty: x.qty })) });
      onSaved(r.data);
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Хадгалж чадсангүй — дахин дарна уу"); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-gray-50" role="dialog" aria-modal="true" aria-label="Хөрвүүлэлт оруулах">
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-2 pb-2 pt-[max(8px,env(safe-area-inset-top))]">
        <button aria-label="Хаах" onClick={tryClose} className="grid h-12 w-12 place-items-center rounded-xl text-gray-700 active:bg-gray-100"><X size={24} /></button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-bold text-gray-900">{line.name}</div>
          <div className="text-[13px] text-gray-500"><span className="font-mono">{line.code}</span> · Задалсан: <b className="text-gray-800">{qtyFmt(line.qty)} {line.uom}</b></div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
        <p className="mb-2 text-[14px] font-semibold text-gray-800">Юу болгож хөрвүүлсэн бэ?</p>
        <SearchBox s={s} onScan={() => setScan(true)} placeholder="Гарсан бараа: код, нэр, баркод" onEnterOne={add} autoFocus={rows.length === 0} />
        {scanBusy && <p className="mt-2 flex items-center gap-2 text-[14px] text-gray-600"><Loader2 size={16} className="animate-spin" />Баркодоор хайж байна…</p>}
        {s.err && <p className="mt-2 text-[14px] text-rose-600">{s.err}</p>}
        {s.q.trim().length >= 2 && (
          <div className="mt-2 space-y-2">
            {s.items.map(p => <ProductRow key={p.code} p={p} onClick={() => add(p)} />)}
            {!s.busy && !s.err && !s.items.length && <p className="py-3 text-center text-[14px] text-gray-500">Бараа олдсонгүй</p>}
          </div>
        )}
        {err && <div className="mt-3"><ErrorBox text={err} onClose={() => setErr("")} /></div>}
        {rows.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-[14px] font-semibold text-gray-800">Гарсан бараа · тоо хэмжээ</p>
            {rows.map((r, i) => (
              <div key={r.code} className={`rounded-2xl border bg-white p-3 shadow-sm ${r.qty <= 0 ? "border-rose-300" : "border-gray-100"}`}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold leading-snug text-gray-900">{r.name}</div>
                    <div className="text-[13px] text-gray-500"><span className="font-mono">{r.code}</span> · {money(r.unit_price)} / {r.uom}</div>
                  </div>
                  <button aria-label={`${r.name} хасах`} onClick={() => remove(i)}
                    className="-mr-1 -mt-1 grid h-11 w-11 place-items-center rounded-xl text-gray-400 active:bg-rose-50 active:text-rose-600"><Trash2 size={19} /></button>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <QtyStepper value={r.qty} onChange={v => setRows(x => x.map((y, j) => j === i ? { ...y, qty: v } : y))} />
                  <span className="text-[14px] font-semibold text-gray-800">{money(r.qty * r.unit_price)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-gray-200 bg-white px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">
        <button onClick={save} disabled={saving || !dirty}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-[17px] font-bold text-white active:bg-indigo-700 disabled:opacity-50">
          {saving ? <Loader2 size={19} className="animate-spin" /> : <Check size={19} />}{dirty ? (hasNext ? "Хадгалаад дараагийнх" : "Хадгалах") : "Өөрчлөлтгүй"}
        </button>
      </div>
      {toast.node}
      {scan && <ScanModal onClose={() => setScan(false)} onDetected={onScanned} />}
    </div>
  );
}
