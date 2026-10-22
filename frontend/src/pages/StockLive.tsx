import { useEffect, useRef, useState } from "react";
import { Boxes, Search, Loader2, ScanLine, X } from "lucide-react";
import { api } from "../lib/api";
import BarcodeScanner from "../components/BarcodeScanner";

/* Эрхэтийн үлдэгдэл байршлаар — бодит цагт (ХТ-ууд erxes deal дээр хардагтай ижил эх сурвалж).
   Эрхэтэд ачаалал үүсгэхгүйн тулд сервер 60 сек кэшилж, хайлт бүрт ≤ 20 бараа асууна. */

export interface StockItem {
  id: string; code: string; name: string; price: number | null; barcodes: string[]; uom: string;
  category: string; total: number; locations: { code: string; name: string; qty: number }[];
}

function qty(n: number) {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export default function StockLive() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [onlyStock, setOnlyStock] = useState(false);
  const [scan, setScan] = useState(false);
  const [at, setAt] = useState<Date | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function run(term = q) {
    const t = term.trim();
    if (t.length < 2) return;
    setBusy(true); setErr("");
    try {
      const r = await api.get("/stock-live/search", { params: { q: t }, timeout: 60000 });
      setItems(r.data.items); setAt(new Date());
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Үлдэгдэл авч чадсангүй");
    } finally { setBusy(false); }
  }

  useEffect(() => { inputRef.current?.focus(); }, []);

  const shown = (items ?? []).filter(i => !onlyStock || i.total > 0);
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-sm">
          <Boxes size={16}/>
        </div>
        <div>
          <h1 className="text-[15px] font-bold leading-tight text-gray-900">Үлдэгдэл (Эрхэт)</h1>
          <p className="text-[11px] text-gray-500">Эрхэтийн одоогийн үлдэгдэл байршлаар — код, нэр, баркодоор хайна</p>
        </div>
      </div>

      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/>
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") run(); }}
            placeholder="Код, нэр эсвэл баркод…"
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-8 text-[14px] outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100"/>
          {q && <button onClick={() => { setQ(""); setItems(null); inputRef.current?.focus(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400"><X size={14}/></button>}
        </div>
        <button onClick={() => setScan(true)} className="rounded-xl border border-gray-200 bg-white px-3 text-gray-600 hover:bg-gray-50" title="Баркод уншуулах">
          <ScanLine size={16}/>
        </button>
        <button onClick={() => run()} disabled={busy || q.trim().length < 2}
          className="flex items-center gap-1.5 rounded-xl bg-teal-600 px-4 text-[13px] font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin"/> : <Search size={14}/>}Хайх
        </button>
      </div>

      {err && <p className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{err}</p>}

      {items && (
        <div className="mb-2 flex items-center gap-3 text-[12px] text-gray-500">
          <span>{shown.length} бараа</span>
          <label className="flex items-center gap-1"><input type="checkbox" checked={onlyStock} onChange={e => setOnlyStock(e.target.checked)}/>Зөвхөн үлдэгдэлтэй</label>
          {at && <span className="ml-auto">{at.toLocaleTimeString("mn-MN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}-ийн байдлаар</span>}
        </div>
      )}

      <div className="space-y-2">
        {shown.map(i => (
          <div key={i.id} className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-gray-900">{i.name}</div>
                <div className="text-[11.5px] text-gray-500">
                  <span className="font-mono font-semibold text-gray-700">{i.code}</span>
                  {i.category && ` · ${i.category}`}
                  {i.price != null && ` · ${Math.round(i.price).toLocaleString("en-US")}₮`}
                </div>
              </div>
              <div className="text-right">
                <div className={`text-[20px] font-black leading-none ${i.total > 0 ? "text-teal-700" : "text-gray-300"}`}>{qty(i.total)}</div>
                <div className="text-[10.5px] text-gray-400">нийт {i.uom}</div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {i.locations.map(l => (
                <span key={l.code}
                  className={`rounded-lg border px-2 py-1 text-[11.5px] ${l.qty > 0 ? "border-teal-200 bg-teal-50 text-teal-800" : "border-gray-100 bg-gray-50 text-gray-400"}`}>
                  <span className="font-mono text-[10.5px] opacity-70">{l.code}</span> {l.name}: <b>{qty(l.qty)}</b>
                </span>
              ))}
            </div>
          </div>
        ))}
        {items && shown.length === 0 && <p className="py-8 text-center text-[13px] text-gray-400">Бараа олдсонгүй.</p>}
      </div>

      <p className="mt-4 text-[11px] text-gray-400">
        Эх сурвалж: Эрхэт (erxes-ийн «Үлдэгдэл харуулах тохиргоо»-гоор, данс 150101). Нэг барааны үлдэгдлийг 1 минут хадгалдаг тул
        Эрхэтэд ачаалал үүсгэхгүй. Тохиргоонд ороогүй байршил (жишээ нь 03 Заал) энд харагдахгүй.
      </p>

      {scan && (
        <BarcodeScanner onClose={() => setScan(false)}
          onDetected={(code: string) => { setScan(false); setQ(code); run(code); }}/>
      )}
    </div>
  );
}
