import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Repeat, Search, ScanLine, Plus, Minus, Trash2, Loader2, X, ChevronLeft, ChevronRight, Send, Check,
  ExternalLink, Download, AlertTriangle, PackageOpen, ArrowDown, CalendarDays,
} from "lucide-react";
import { api } from "../lib/api";
import BarcodeScanner from "../components/BarcodeScanner";

/* Хөрвүүлэлтийн бараа — заалны барааг задлах/хөрвүүлэх. Утсан (APK) дээр голчлон ашиглана.
   1) Бараа хайж (эсвэл уншуулж) тоо оруулаад «Захиалга илгээх» → erxes-д deal
      (Заалны хөдөлгөөн · Худалдагчийн Захиалга · Заал гурил будаа гоймон).
   2) Мөр бүрт юу болгож, хэдэн ширхэг болгож хөрвүүлснийг оруулна.
   3) Нягтлан/хянагч «Эрхэт рүү илгээх» — 03-Заалаас зарлага, 03-Заалд орлого. */

interface Prod { id: string; code: string; name: string; price: number; uom: string; barcodes: string[]; category: string }
interface Res { id?: number; code: string; name: string; uom: string; qty: number; unit_price: number }
interface Line { id: number; code: string; name: string; uom: string; qty: number; unit_price: number; results: Res[] }
interface Order {
  id: number; status: string; conv_date: string; note: string; deal_id: string; deal_number: string; deal_url: string;
  created_by: string; created_at: string | null; sent_by: string; sent_at: string | null; line_count: number;
  converted_count: number; out_amount: number; in_amount: number; erkhet: Record<string, any>; lines?: Line[];
}
interface CartItem { code: string; name: string; price: number; uom: string; qty: number }

const DRAFT_KEY = "conversion_draft_v1";
const STATUS: Record<string, { label: string; cls: string }> = {
  ordered: { label: "Хөрвүүлэх", cls: "bg-amber-100 text-amber-800" },
  converted: { label: "Эрхэт рүү илгээх", cls: "bg-sky-100 text-sky-800" },
  sent: { label: "Эрхэтэд орсон", cls: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "Цуцалсан", cls: "bg-gray-100 text-gray-500" },
};

const money = (n: number) => `${Math.round(n).toLocaleString("en-US")}₮`;
const qtyFmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));
function loadDraft(): { items: CartItem[]; note: string } {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "") || { items: [], note: "" }; } catch { return { items: [], note: "" }; }
}
function ubDay(iso?: string | null) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// ── Тоо өөрчлөх (том, хуруунд тохиромжтой) ───────────────────────────────────
function QtyStepper({ value, onChange, min = 0 }: { value: number; onChange: (v: number) => void; min?: number }) {
  const [txt, setTxt] = useState(qtyFmt(value));
  useEffect(() => { setTxt(qtyFmt(value)); }, [value]);
  return (
    <div className="flex h-11 items-stretch overflow-hidden rounded-xl border border-gray-200 bg-white">
      <button type="button" aria-label="Хасах" onClick={() => onChange(Math.max(min, value - 1))}
        className="grid w-11 place-items-center text-gray-600 active:bg-gray-100"><Minus size={18} /></button>
      <input inputMode="decimal" value={txt} aria-label="Тоо"
        onChange={e => setTxt(e.target.value.replace(",", "."))}
        onBlur={() => { const n = parseFloat(txt); onChange(isFinite(n) && n >= min ? n : value); }}
        onFocus={e => e.target.select()}
        className="w-14 border-x border-gray-100 text-center text-[16px] font-bold text-gray-900 outline-none" />
      <button type="button" aria-label="Нэмэх" onClick={() => onChange(value + 1)}
        className="grid w-11 place-items-center text-gray-600 active:bg-gray-100"><Plus size={18} /></button>
    </div>
  );
}

// ── Бараа хайх (дээд талд тогтсон) ──────────────────────────────────────────
function useProductSearch() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Prod[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setItems([]); setErr(""); return; }
    const my = ++seq.current;
    const h = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.get("/conversion/products", { params: { q: t }, timeout: 60000 });
        if (my === seq.current) { setItems(r.data.items); setErr(""); }
      } catch (e: any) {
        if (my === seq.current) setErr(e?.response?.data?.detail ?? "Хайж чадсангүй");
      } finally { if (my === seq.current) setBusy(false); }
    }, 250);
    return () => clearTimeout(h);
  }, [q]);
  return { q, setQ, items, busy, err };
}

function SearchBox({ s, onScan, placeholder }: { s: ReturnType<typeof useProductSearch>; onScan: () => void; placeholder: string }) {
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={s.q} onChange={e => s.setQ(e.target.value)} placeholder={placeholder} enterKeyHint="search"
          className="h-12 w-full rounded-2xl border border-gray-200 bg-white pl-9 pr-9 text-[15px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
        {s.busy ? <Loader2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-gray-400" />
          : s.q && <button aria-label="Цэвэрлэх" onClick={() => s.setQ("")} className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center text-gray-400"><X size={16} /></button>}
      </div>
      <button onClick={onScan} aria-label="Баркод уншуулах"
        className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-indigo-600 text-white shadow-sm active:bg-indigo-700"><ScanLine size={20} /></button>
    </div>
  );
}

function ProductRow({ p, right, onClick }: { p: Prod; right?: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl border border-gray-100 bg-white px-3 py-2.5 text-left active:bg-indigo-50">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold leading-snug text-gray-900">{p.name}</div>
        <div className="mt-0.5 text-[12px] text-gray-500"><span className="font-mono">{p.code}</span> · {money(p.price)}</div>
      </div>
      {right ?? <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-700"><Plus size={20} /></span>}
    </button>
  );
}

// ── Нүүр: шинэ захиалга | жагсаалт ───────────────────────────────────────────
export default function ConversionPage() {
  const { id } = useParams();
  if (id) return <OrderDetail id={Number(id)} />;
  return <ConversionHome />;
}

function ConversionHome() {
  const [tab, setTab] = useState<"new" | "list">(() => (loadDraft().items.length ? "new" : "list"));
  return (
    <div className="mx-auto max-w-2xl pb-28">
      <div className="mb-3 flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-sm"><Repeat size={18} /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-bold leading-tight text-gray-900">Хөрвүүлэлт</h1>
          <p className="text-[12px] text-gray-500">Заалны барааг задлах, хөрвүүлэх</p>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-2 rounded-2xl bg-gray-100 p-1">
        {([["new", "Шинэ захиалга"], ["list", "Захиалгууд"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`h-10 rounded-xl text-[14px] font-semibold ${tab === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>{l}</button>
        ))}
      </div>
      {tab === "new" ? <NewOrder onSent={() => setTab("list")} /> : <OrderList />}
    </div>
  );
}

function NewOrder({ onSent }: { onSent: () => void }) {
  const nav = useNavigate();
  const s = useProductSearch();
  const [cart, setCart] = useState<CartItem[]>(() => loadDraft().items);
  const [note, setNote] = useState(() => loadDraft().note);
  const [scan, setScan] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [flash, setFlash] = useState("");
  const [customer, setCustomer] = useState("Заал гурил будаа гоймон");

  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ items: cart, note })); } catch { /* хувийн горим */ } }, [cart, note]);
  useEffect(() => { api.get("/conversion/settings").then(r => setCustomer(r.data.customer_name)).catch(() => {}); }, []);

  const add = useCallback((p: Prod) => {
    setCart(c => {
      const i = c.findIndex(x => x.code === p.code);
      if (i >= 0) { const n = [...c]; n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; }
      return [{ code: p.code, name: p.name, price: p.price, uom: p.uom, qty: 1 }, ...c];
    });
    setFlash(`${p.name} нэмэгдлээ`);
    setTimeout(() => setFlash(""), 1500);
    s.setQ("");
  }, [s]);

  async function onScanned(code: string) {
    setScan(false);
    try {
      const r = await api.get("/conversion/products", { params: { q: code } });
      const hit = (r.data.items as Prod[]).find(p => p.code === code || p.barcodes.includes(code));
      if (hit) add(hit); else { s.setQ(code); setErr(`«${code}» баркодоор бараа олдсонгүй.`); }
    } catch { setErr("Хайж чадсангүй"); }
  }

  async function send() {
    setSending(true); setErr("");
    try {
      const r = await api.post("/conversion/orders", { lines: cart.map(c => ({ code: c.code, qty: c.qty })), note }, { timeout: 90000 });
      setCart([]); setNote(""); setConfirm(false);
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
      onSent();
      nav(`/conversion/${r.data.id}`);
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Илгээж чадсангүй — дахин оролдоно уу");
    } finally { setSending(false); }
  }

  const total = cart.reduce((a, c) => a + c.qty * c.price, 0);
  const pcs = cart.reduce((a, c) => a + c.qty, 0);
  return (
    <>
      <div className="sticky top-0 z-10 -mx-1 bg-gray-50/95 px-1 pb-2 pt-1 backdrop-blur">
        <SearchBox s={s} onScan={() => setScan(true)} placeholder="Хөрвүүлэх бараа: код, нэр, баркод" />
      </div>
      {s.err && <p className="mb-2 text-[13px] text-rose-600">{s.err}</p>}
      {s.q.trim().length >= 2 && (
        <div className="mb-4 space-y-2">
          {s.items.map(p => <ProductRow key={p.code} p={p} onClick={() => add(p)} />)}
          {!s.busy && !s.items.length && <p className="py-4 text-center text-[13px] text-gray-400">Бараа олдсонгүй</p>}
        </div>
      )}

      {err && (
        <div className="mb-3 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-[13px] text-rose-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span className="flex-1">{err}</span>
          <button aria-label="Хаах" onClick={() => setErr("")}><X size={16} /></button>
        </div>
      )}

      {cart.length === 0 && s.q.trim().length < 2 ? (
        <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-gray-200 bg-white px-6 py-10 text-center">
          <PackageOpen size={36} className="text-gray-300" />
          <p className="text-[15px] font-semibold text-gray-700">Хөрвүүлэх бараагаа нэмнэ үү</p>
          <p className="text-[13px] text-gray-500">Дээрх талбарт хайх эсвэл <ScanLine size={13} className="inline" /> дарж баркод уншуулна.</p>
        </div>
      ) : cart.length > 0 && (
        <>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[14px] font-bold text-gray-800">Захиалга · {cart.length} бараа</h2>
            <button onClick={() => { if (confirm_("Сагсыг цэвэрлэх үү?")) setCart([]); }} className="h-9 px-2 text-[13px] text-gray-400">Цэвэрлэх</button>
          </div>
          <div className="space-y-2">
            {cart.map((c, i) => (
              <div key={c.code} className="rounded-2xl border border-gray-100 bg-white p-3 shadow-sm">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold leading-snug text-gray-900">{c.name}</div>
                    <div className="mt-0.5 text-[12px] text-gray-500"><span className="font-mono">{c.code}</span> · {money(c.price)}</div>
                  </div>
                  <button aria-label="Устгах" onClick={() => setCart(x => x.filter((_, j) => j !== i))}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-gray-300 active:text-rose-600"><Trash2 size={17} /></button>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <QtyStepper value={c.qty} min={0} onChange={v => setCart(x => x.map((y, j) => j === i ? { ...y, qty: v } : y))} />
                  <span className="text-[13px] font-semibold text-gray-700">{money(c.qty * c.price)}</span>
                </div>
              </div>
            ))}
          </div>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Тэмдэглэл (заавал биш)"
            className="mt-3 w-full rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-[14px] outline-none focus:border-indigo-400" />
        </>
      )}

      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-gray-200 bg-white/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-64">
          <div className="mx-auto max-w-2xl">
            <button onClick={() => setConfirm(true)} disabled={cart.some(c => c.qty <= 0)}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-[16px] font-bold text-white shadow-lg shadow-indigo-600/20 active:bg-indigo-700 disabled:opacity-50">
              <Send size={18} />Захиалга илгээх · {cart.length} бараа
            </button>
            {cart.some(c => c.qty <= 0) && <p className="mt-1 text-center text-[12px] text-rose-600">Тоо 0 мөрийг устгах эсвэл тоо оруулна уу</p>}
          </div>
        </div>
      )}

      {flash && <div className="fixed inset-x-0 bottom-24 z-30 mx-auto w-fit rounded-full bg-gray-900/90 px-4 py-2 text-[13px] text-white shadow-lg">{flash}</div>}

      {confirm && (
        <Sheet onClose={() => !sending && setConfirm(false)} title="Захиалга илгээх үү?">
          <p className="mb-3 text-[13px] text-gray-600">
            erxes-д «Худалдагчийн Захиалга» шатанд шинэ deal үүснэ. Харилцагч: <b>{customer}</b>.
          </p>
          <div className="mb-3 max-h-60 space-y-1.5 overflow-auto rounded-2xl bg-gray-50 p-3">
            {cart.map(c => (
              <div key={c.code} className="flex justify-between gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate text-gray-800">{c.name}</span>
                <b className="shrink-0">{qtyFmt(c.qty)} {c.uom}</b>
              </div>
            ))}
          </div>
          <div className="mb-4 flex justify-between text-[14px]"><span className="text-gray-500">{qtyFmt(pcs)} ширхэг</span><b>{money(total)}</b></div>
          <button onClick={send} disabled={sending}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-[16px] font-bold text-white active:bg-indigo-700 disabled:opacity-60">
            {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}{sending ? "Илгээж байна…" : "Тийм, илгээх"}
          </button>
          <button onClick={() => setConfirm(false)} disabled={sending} className="mt-2 h-12 w-full rounded-2xl text-[15px] font-semibold text-gray-600">Буцах</button>
        </Sheet>
      )}
      {scan && <BarcodeScanner onClose={() => setScan(false)} onDetected={onScanned} />}
    </>
  );
}

function confirm_(msg: string) { return window.confirm(msg); }

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(20px,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-200 sm:hidden" />
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[17px] font-bold text-gray-900">{title}</h3>
          <button aria-label="Хаах" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl text-gray-400 active:bg-gray-100"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function OrderList() {
  const nav = useNavigate();
  const [items, setItems] = useState<Order[] | null>(null);
  const [filter, setFilter] = useState("ordered,converted");
  const [err, setErr] = useState("");
  useEffect(() => {
    setItems(null);
    api.get("/conversion/orders", { params: { status: filter } })
      .then(r => setItems(r.data.items)).catch(e => setErr(e?.response?.data?.detail ?? "Ачаалж чадсангүй"));
  }, [filter]);
  return (
    <>
      <div className="mb-3 flex gap-2 overflow-x-auto">
        {([["ordered,converted", "Хийгдэж буй"], ["sent", "Эрхэтэд орсон"], ["", "Бүгд"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`h-9 shrink-0 rounded-full px-4 text-[13px] font-semibold ${filter === k ? "bg-gray-900 text-white" : "bg-white text-gray-600 ring-1 ring-gray-200"}`}>{l}</button>
        ))}
      </div>
      {err && <p className="text-[13px] text-rose-600">{err}</p>}
      {!items ? <div className="flex justify-center py-10"><Loader2 className="animate-spin text-gray-400" /></div>
        : !items.length ? <p className="py-10 text-center text-[14px] text-gray-400">Хөрвүүлэлт алга</p>
        : (
          <div className="space-y-2">
            {items.map(o => {
              const st = STATUS[o.status] ?? { label: o.status, cls: "bg-gray-100" };
              const pct = o.line_count ? Math.round(o.converted_count / o.line_count * 100) : 0;
              return (
                <button key={o.id} onClick={() => nav(`/conversion/${o.id}`)}
                  className="w-full rounded-2xl border border-gray-100 bg-white p-3.5 text-left shadow-sm active:bg-gray-50">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-bold text-gray-900">#{o.id}</span>
                    <span className="text-[13px] text-gray-500">{o.conv_date}</span>
                    <span className={`ml-auto rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${st.cls}`}>{st.label}</span>
                    <ChevronRight size={18} className="text-gray-300" />
                  </div>
                  <div className="mt-1 text-[12.5px] text-gray-500">{o.line_count} бараа · {o.deal_number || "deal —"} · {o.created_by}</div>
                  {o.status !== "cancelled" && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                        <div className={`h-full rounded-full ${pct === 100 ? "bg-emerald-500" : "bg-amber-400"}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[12px] font-semibold text-gray-600">{o.converted_count}/{o.line_count}</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
    </>
  );
}

// ── Дэлгэрэнгүй: мөр бүрт хөрвүүлэлтийн үр дүн ──────────────────────────────
function OrderDetail({ id }: { id: number }) {
  const nav = useNavigate();
  const [o, setO] = useState<Order | null>(null);
  const [err, setErr] = useState("");
  const [canSend, setCanSend] = useState(false);
  const [editLine, setEditLine] = useState<Line | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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
      a.click(); URL.revokeObjectURL(url);
    } catch { setErr("Excel татаж чадсангүй"); }
  }

  async function sendErkhet() {
    setBusy(true); setErr("");
    try { const r = await api.post(`/conversion/orders/${id}/erkhet`, { confirm: true }, { timeout: 180000 }); setO(r.data); setSendOpen(false); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? "Эрхэт рүү илгээж чадсангүй"); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!window.confirm("Энэ хөрвүүлэлтийг цуцлах уу? (erxes дээрх deal-ийг гараар устгана)")) return;
    try { const r = await api.post(`/conversion/orders/${id}/cancel`); setO(r.data); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? "Цуцалж чадсангүй"); }
  }

  if (!o) return (
    <div className="mx-auto max-w-2xl">
      <button onClick={() => nav("/conversion")} className="mb-3 flex h-10 items-center gap-1 text-[14px] text-gray-600"><ChevronLeft size={18} />Буцах</button>
      {err ? <p className="text-rose-600">{err}</p> : <div className="flex justify-center py-10"><Loader2 className="animate-spin text-gray-400" /></div>}
    </div>
  );
  const st = STATUS[o.status] ?? { label: o.status, cls: "bg-gray-100" };
  const diff = o.in_amount - o.out_amount;
  return (
    <div className="mx-auto max-w-2xl pb-32">
      <div className="mb-3 flex items-center gap-2">
        <button onClick={() => nav("/conversion")} aria-label="Буцах" className="grid h-10 w-10 place-items-center rounded-xl bg-white text-gray-600 ring-1 ring-gray-200"><ChevronLeft size={20} /></button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-bold leading-tight text-gray-900">Хөрвүүлэлт #{o.id}</h1>
          <p className="truncate text-[12px] text-gray-500">{o.created_by} · {ubDay(o.created_at)}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${st.cls}`}>{st.label}</span>
      </div>

      {err && (
        <div className="mb-3 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-[13px] text-rose-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span className="flex-1">{err}</span>
          <button aria-label="Хаах" onClick={() => setErr("")}><X size={16} /></button>
        </div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="rounded-2xl bg-white p-3 ring-1 ring-gray-100">
          <span className="flex items-center gap-1 text-[12px] text-gray-500"><CalendarDays size={13} />Хөрвүүлсэн огноо</span>
          <input type="date" value={o.conv_date} disabled={locked} onChange={e => e.target.value && setDate(e.target.value)}
            className="mt-1 w-full bg-transparent text-[15px] font-semibold text-gray-900 outline-none disabled:text-gray-500" />
        </label>
        <a href={o.deal_url || undefined} target="_blank" rel="noreferrer"
          className="rounded-2xl bg-white p-3 ring-1 ring-gray-100 active:bg-gray-50">
          <span className="flex items-center gap-1 text-[12px] text-gray-500">erxes deal <ExternalLink size={12} /></span>
          <span className="mt-1 block truncate font-mono text-[14px] font-semibold text-indigo-700">{o.deal_number || "—"}</span>
        </a>
      </div>
      {o.note && <p className="mb-3 rounded-2xl bg-white p-3 text-[13px] text-gray-700 ring-1 ring-gray-100">{o.note}</p>}

      <h2 className="mb-2 text-[14px] font-bold text-gray-800">Бараа бүрийг юу болгож хөрвүүлсэн бэ? · {o.converted_count}/{o.line_count}</h2>
      <div className="space-y-2">
        {(o.lines ?? []).map(l => {
          const done = l.results.some(r => r.qty > 0);
          return (
            <div key={l.id} className={`rounded-2xl border bg-white p-3 shadow-sm ${done ? "border-emerald-200" : "border-amber-200"}`}>
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${done ? "bg-emerald-500 text-white" : "bg-amber-100 text-amber-700"}`}>
                  {done ? <Check size={14} /> : <span className="text-[12px] font-bold">!</span>}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold leading-snug text-gray-900">{l.name}</div>
                  <div className="text-[12px] text-gray-500"><span className="font-mono">{l.code}</span> · <b className="text-gray-800">{qtyFmt(l.qty)} {l.uom}</b> · {money(l.qty * l.unit_price)}</div>
                </div>
              </div>
              {done && (
                <div className="mt-2 rounded-xl bg-emerald-50/70 p-2.5">
                  <div className="mb-1 flex items-center gap-1 text-[11.5px] font-semibold text-emerald-700"><ArrowDown size={13} />Хөрвүүлсэн</div>
                  {l.results.map(r => (
                    <div key={r.id ?? r.code} className="flex justify-between gap-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate text-gray-800">{r.name} <span className="font-mono text-[11px] text-gray-400">{r.code}</span></span>
                      <b className="shrink-0">{qtyFmt(r.qty)} {r.uom}</b>
                    </div>
                  ))}
                </div>
              )}
              {!locked && (
                <button onClick={() => setEditLine(l)}
                  className={`mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl text-[14px] font-semibold ${done ? "bg-gray-100 text-gray-700" : "bg-amber-500 text-white"} active:opacity-80`}>
                  {done ? "Засах" : <><Plus size={16} />Хөрвүүлэлт оруулах</>}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-2xl bg-white p-3 text-[13px] ring-1 ring-gray-100">
        <div className="flex justify-between"><span className="text-gray-500">Зарлага (03-Заалаас)</span><b>{money(o.out_amount)}</b></div>
        <div className="flex justify-between"><span className="text-gray-500">Орлого (03-Заалд)</span><b>{money(o.in_amount)}</b></div>
        {o.converted_count > 0 && Math.abs(diff) > 1 && (
          <div className={`mt-1 flex justify-between border-t border-gray-100 pt-1 ${diff < 0 ? "text-rose-600" : "text-emerald-700"}`}>
            <span>Зөрүү (нэгж үнээр)</span><b>{diff > 0 ? "+" : "−"}{money(Math.abs(diff))}</b>
          </div>
        )}
        {o.status === "sent" && <p className="mt-2 text-[12px] text-emerald-700">Эрхэтэд илгээсэн: {o.sent_by} · {ubDay(o.sent_at)}</p>}
        {Object.entries(o.erkhet || {}).map(([k, v]: any) => v?.status === "fail" && (
          <p key={k} className="mt-1 text-[12px] text-rose-600">{k === "so" ? "Зарлага" : "Орлого"}: {v.message || (v.errors || []).join("; ")}</p>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button onClick={() => download("so")} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-white text-[13px] font-semibold text-gray-700 ring-1 ring-gray-200"><Download size={15} />Зарлага Excel</button>
        <button onClick={() => download("income")} disabled={!o.converted_count} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-white text-[13px] font-semibold text-gray-700 ring-1 ring-gray-200 disabled:opacity-40"><Download size={15} />Орлого Excel</button>
      </div>
      {!locked && <button onClick={cancel} className="mt-2 h-11 w-full rounded-xl text-[13px] font-semibold text-rose-600">Хөрвүүлэлтийг цуцлах</button>}

      {canSend && o.status === "converted" && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-gray-200 bg-white/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:left-64">
          <div className="mx-auto max-w-2xl">
            <button onClick={() => setSendOpen(true)}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 text-[16px] font-bold text-white shadow-lg shadow-emerald-600/20 active:bg-emerald-700">
              <Send size={18} />Эрхэт рүү илгээх
            </button>
          </div>
        </div>
      )}

      {editLine && <ResultEditor order={o} line={editLine} onClose={() => setEditLine(null)} onSaved={x => { setO(x); setEditLine(null); }} />}

      {sendOpen && (
        <Sheet title="Эрхэт рүү илгээх үү?" onClose={() => !busy && setSendOpen(false)}>
          <ul className="mb-4 space-y-1.5 text-[13px] text-gray-700">
            <li>• <b>Зарлага</b> — {o.line_count} бараа 03-Заалаас, {money(o.out_amount)}</li>
            <li>• <b>Орлого</b> — хөрвүүлсэн бараа 03-Заалд, {money(o.in_amount)}</li>
            <li>• Гүйлгээний утга: «{o.conv_date}-ний хөрвүүлэлт #{o.id}», данс 320101</li>
          </ul>
          <p className="mb-4 rounded-xl bg-amber-50 p-2.5 text-[12px] text-amber-800">Нэг удаа л илгээнэ — дахин илгээхгүй. Илгээсний дараа засах боломжгүй.</p>
          <button onClick={sendErkhet} disabled={busy}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 text-[16px] font-bold text-white active:bg-emerald-700 disabled:opacity-60">
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}{busy ? "Илгээж байна…" : "Тийм, илгээх"}
          </button>
          <button onClick={() => setSendOpen(false)} disabled={busy} className="mt-2 h-12 w-full rounded-2xl text-[15px] font-semibold text-gray-600">Буцах</button>
        </Sheet>
      )}
    </div>
  );
}

function ResultEditor({ order, line, onClose, onSaved }: { order: Order; line: Line; onClose: () => void; onSaved: (o: Order) => void }) {
  const s = useProductSearch();
  const [rows, setRows] = useState<Res[]>(() => line.results.map(r => ({ ...r })));
  const [scan, setScan] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const dirty = useMemo(() => JSON.stringify(rows.map(r => [r.code, r.qty])) !== JSON.stringify(line.results.map(r => [r.code, r.qty])), [rows, line]);

  function add(p: Prod) {
    setRows(x => x.some(r => r.code === p.code) ? x : [...x, { code: p.code, name: p.name, uom: p.uom, qty: 1, unit_price: p.price }]);
    s.setQ("");
  }
  async function onScanned(code: string) {
    setScan(false);
    const r = await api.get("/conversion/products", { params: { q: code } }).catch(() => null);
    const hit = (r?.data.items as Prod[] | undefined)?.find(p => p.code === code || p.barcodes.includes(code));
    if (hit) add(hit); else s.setQ(code);
  }
  async function save() {
    setSaving(true); setErr("");
    try {
      const r = await api.put(`/conversion/orders/${order.id}/lines/${line.id}`, { results: rows.filter(x => x.qty > 0).map(x => ({ code: x.code, qty: x.qty })) });
      onSaved(r.data);
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Хадгалж чадсангүй"); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-50">
      <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 pb-2 pt-[max(8px,env(safe-area-inset-top))]">
        <button aria-label="Хаах" onClick={() => (!dirty || window.confirm("Хадгалаагүй өөрчлөлт алга болно. Хаах уу?")) && onClose()}
          className="grid h-11 w-11 place-items-center rounded-xl text-gray-600 active:bg-gray-100"><X size={22} /></button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold text-gray-900">{line.name}</div>
          <div className="text-[12px] text-gray-500"><span className="font-mono">{line.code}</span> · {qtyFmt(line.qty)} {line.uom} хөрвүүлсэн</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-32 pt-3">
        <p className="mb-2 text-[13px] font-semibold text-gray-700">Юу болгож хөрвүүлсэн бэ?</p>
        <SearchBox s={s} onScan={() => setScan(true)} placeholder="Гарсан бараа: код, нэр, баркод" />
        {s.q.trim().length >= 2 && (
          <div className="mt-2 space-y-2">
            {s.items.map(p => <ProductRow key={p.code} p={p} onClick={() => add(p)} />)}
            {!s.busy && !s.items.length && <p className="py-3 text-center text-[13px] text-gray-400">Бараа олдсонгүй</p>}
          </div>
        )}
        {rows.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-[13px] font-semibold text-gray-700">Хөрвүүлсэн бараа · хэдэн ширхэг болсон бэ?</p>
            {rows.map((r, i) => (
              <div key={r.code} className="rounded-2xl border border-gray-100 bg-white p-3 shadow-sm">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold leading-snug text-gray-900">{r.name}</div>
                    <div className="text-[12px] text-gray-500"><span className="font-mono">{r.code}</span> · {money(r.unit_price)}</div>
                  </div>
                  <button aria-label="Устгах" onClick={() => setRows(x => x.filter((_, j) => j !== i))}
                    className="grid h-9 w-9 place-items-center rounded-lg text-gray-300 active:text-rose-600"><Trash2 size={17} /></button>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <QtyStepper value={r.qty} onChange={v => setRows(x => x.map((y, j) => j === i ? { ...y, qty: v } : y))} />
                  <span className="text-[13px] font-semibold text-gray-700">{money(r.qty * r.unit_price)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {err && <p className="mt-3 text-[13px] text-rose-600">{err}</p>}
      </div>
      <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">
        <button onClick={save} disabled={saving || !dirty}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-[16px] font-bold text-white active:bg-indigo-700 disabled:opacity-50">
          {saving ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}Хадгалах
        </button>
      </div>
      {scan && <BarcodeScanner onClose={() => setScan(false)} onDetected={onScanned} />}
    </div>
  );
}
