import { useCallback, useEffect, useRef, useState } from "react";
import {
  Tag, Camera, Loader2, RefreshCw, Keyboard, SearchX, ScanLine, X, Printer,
} from "lucide-react";
import { api } from "../lib/api";

/* Заалны таблетад зориулсан үнийн лавлагаа.
   Камер БАЙНГА ажиллана — үйлчлүүлэгч ирээд шууд уншуулна. Тиймээс нийтлэг
   BarcodeScanner (modal) тохирохгүй: тэр нь нэг уншаад хаагддаг.
   Мөн USB/Bluetooth скáннер (гар шиг бичдэг) ажиллана — гар оролтыг сонсоно. */

interface Product {
  _id: string; code: string; name: string; short_name: string;
  price: number | null; barcodes: string[]; uom: string;
  category: string; image: string; description: string; source: string;
}
interface BulkInfo { quantity: string; price: string; unit_price: string; ok: boolean }
interface LookupRes {
  query: string; found: boolean; product: Product | null;
  others: Product[]; error: string;
}

// Скáннер бүр Enter-ийг өөрөөр илгээдэг (Enter / Return / keyCode 13).
function isEnter(e: { key: string; keyCode?: number }) {
  return e.key === "Enter" || e.key === "Return" || e.keyCode === 13;
}

const NATIVE_FORMATS = ["ean_13", "ean_8", "code_128", "code_39", "code_93",
  "upc_a", "upc_e", "itf", "codabar"];
const REPEAT_MS = 2500;    // ижил баркодыг дахин асуухгүй байх хугацаа
const CLEAR_MS = 30000;    // үр дүнг автоматаар цэвэрлэх

function money(n: number | null | undefined) {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("mn-MN");
}

export default function PriceCheckPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const qrRef = useRef<any>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const clearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufRef = useRef<{ s: string; at: number }>({ s: "", at: 0 });

  const [camErr, setCamErr] = useState("");
  const [starting, setStarting] = useState(true);
  const [mode, setMode] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<LookupRes | null>(null);
  const [manual, setManual] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [copies, setCopies] = useState(1);
  const [printing, setPrinting] = useState(false);
  const [printErr, setPrintErr] = useState("");
  const [bulk, setBulk] = useState<BulkInfo | null>(null);

  const lookup = useCallback(async (code: string) => {
    const c = (code || "").trim();
    if (!c) return;
    const now = Date.now();
    if (c === lastRef.current.code && now - lastRef.current.at < REPEAT_MS) return;
    lastRef.current = { code: c, at: now };

    try { navigator.vibrate?.(60); } catch { /* дэмжихгүй бол алгасна */ }
    setBusy(true);
    try {
      const r = await api.get("/price-check/lookup", { params: { q: c }, timeout: 20000 });
      setRes(r.data);
      // Бөөний үнэ erxes-ээс ирдэг тул удаан — үндсэн үнийг хүлээлгэхгүйн
      // тулд тусад нь ачаална. Энэ хооронд өөр бараа уншуулсан бол хаяна.
      setBulk(null);
      if (r.data?.product?.code) {
        const code = r.data.product.code;
        api.get("/price-check/bulk", { params: { q: code }, timeout: 30000 })
          .then(b => { if (lastRef.current.code === c) setBulk(b.data); })
          .catch(() => {});
      }
    } catch {
      setRes({ query: c, found: false, product: null, others: [],
               error: "Сервертэй холбогдож чадсангүй" });
      setBulk(null);
    } finally {
      setBusy(false);
      if (clearRef.current) clearTimeout(clearRef.current);
      clearRef.current = setTimeout(() => setRes(null), CLEAR_MS);
    }
  }, []);

  // Шошгыг auth-тай татаад шинэ цонхонд бичнэ — шууд URL нээвэл токен
  // дамжихгүй тул 401 болно. Сервер юу ч хэвлэхгүй: хэвлэгчийн харилцах
  // цонх гарч, хүн баталгаажуулна.
  async function printLabel(code: string) {
    setPrinting(true); setPrintErr("");
    try {
      const r = await api.get("/price-check/label", {
        params: { q: code, copies }, responseType: "text", timeout: 60000,
      });
      const w = window.open("", "_blank", "width=460,height=640");
      if (!w) { setPrintErr("Хөтөч шинэ цонх нээхийг хориглолоо."); return; }
      w.document.open(); w.document.write(r.data); w.document.close();
    } catch (e: any) {
      setPrintErr(e?.response?.data?.detail ?? "Шошго татах амжилтгүй");
    } finally { setPrinting(false); }
  }

  // ── Камер ──────────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (qrRef.current) {
      try { qrRef.current.stop(); } catch { /* аль хэдийн зогссон */ }
      try { qrRef.current.clear(); } catch { /* аль хэдийн цэвэрлэсэн */ }
      qrRef.current = null;
    }
  }, []);

  const detectLoop = useCallback(async () => {
    if (videoRef.current && detectorRef.current) {
      try {
        const codes = await detectorRef.current.detect(videoRef.current);
        const raw = codes?.[0]?.rawValue || codes?.[0]?.value;
        if (raw) lookup(raw);          // ЗОГСООХГҮЙ — үргэлжлүүлэн уншина
      } catch { /* нэг кадр уншигдаагүй — цааш */ }
    }
    rafRef.current = requestAnimationFrame(detectLoop);
  }, [lookup]);

  const start = useCallback(async () => {
    setCamErr(""); setStarting(true); stopAll();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Камерын API байхгүй байна.");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      streamRef.current = stream;

      if ("BarcodeDetector" in window) {
        const D = (window as any).BarcodeDetector;
        const sup = await D.getSupportedFormats().catch(() => NATIVE_FORMATS);
        const fmts = NATIVE_FORMATS.filter(f => sup.includes(f));
        detectorRef.current = new D({ formats: fmts.length ? fmts : NATIVE_FORMATS });
        const v = videoRef.current!;
        v.srcObject = stream;
        v.setAttribute("playsinline", "true");
        await v.play().catch(() => {});
        setMode("native"); setStarting(false);
        rafRef.current = requestAnimationFrame(detectLoop);
        return;
      }

      // html5-qrcode нь өөрийн stream үүсгэдэг тул энэийг чөлөөлнө
      stream.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      const { Html5Qrcode } = await import("html5-qrcode");
      const devices = await Html5Qrcode.getCameras();
      if (!devices?.length) throw new Error("Камер олдсонгүй");
      const back = devices.find((d: any) => /back|rear|environment/i.test(d.label || ""));
      const qr = new Html5Qrcode("pricecheck-cam", false);
      qrRef.current = qr;
      await qr.start((back || devices[0]).id,
        { fps: 10, qrbox: { width: 300, height: 200 }, aspectRatio: 1.4 },
        (decoded: string) => lookup(decoded), () => {});
      setMode("html5"); setStarting(false);
    } catch (e: any) {
      const n = e?.name || "";
      setCamErr(
        n === "NotAllowedError" ? "Камер зөвшөөрөгдөөгүй — хөтчийн тохиргооноос зөвшөөрнө үү."
        : n === "NotFoundError" ? "Камер олдсонгүй."
        : n === "NotReadableError" ? "Камерыг өөр програм ашиглаж байна."
        : (e?.message || "Камер нээгдсэнгүй"));
      setStarting(false); stopAll();
    }
  }, [detectLoop, lookup, stopAll]);

  useEffect(() => {
    const t = setTimeout(start, 120);
    return () => { clearTimeout(t); stopAll(); if (clearRef.current) clearTimeout(clearRef.current); };
  }, [start, stopAll]);

  // ── USB/Bluetooth скáннер (гар шиг бичээд Enter дардаг) ────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showManual) return;                       // гарын талбар идэвхтэй үед хөндөхгүй
      const now = Date.now();
      if (now - bufRef.current.at > 120) bufRef.current.s = "";   // хүн бичсэн бол хаяна
      bufRef.current.at = now;
      if (isEnter(e)) {
        const s = bufRef.current.s;
        bufRef.current.s = "";
        if (s.length >= 4) lookup(s);
      } else if (e.key.length === 1) {
        bufRef.current.s += e.key;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lookup, showManual]);

  const p = res?.product ?? null;

  return (
    <div className="flex h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-2xl bg-white shadow-sm lg:h-[calc(100vh-2.5rem)]">

      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-4 py-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-sm shadow-violet-500/30">
          <Tag size={16}/>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold leading-tight tracking-tight text-gray-900">Үнэ харах</h1>
          <p className="text-[11px] leading-tight text-gray-500">Барааны баркодыг камерт уншуулна уу</p>
        </div>
        <button onClick={() => setShowManual(v => !v)}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50">
          <Keyboard size={12}/>Гараар
        </button>
      </div>

      {showManual && (
        <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 bg-gray-50/70 px-4 py-2.5">
          <input autoFocus value={manual} onChange={e => setManual(e.target.value)}
            onKeyDown={e => { if (isEnter(e)) { lookup(manual); setManual(""); } }}
            placeholder="Баркод, код эсвэл нэр…"
            className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"/>
          <button onClick={() => { lookup(manual); setManual(""); }}
            className="rounded-xl bg-violet-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-violet-700">
            Хайх
          </button>
          <button onClick={() => setShowManual(false)} className="p-1 text-gray-400 hover:text-gray-700">
            <X size={14}/>
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 lg:flex-row">

        {/* Камер */}
        <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden rounded-2xl bg-black lg:aspect-auto lg:h-full lg:w-[42%]">
          <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay/>
          <div id="pricecheck-cam" className="absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover"/>

          {starting && !camErr && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white">
              <Loader2 size={24} className="animate-spin"/>
              <span className="text-[12px]">Камер нээгдэж байна…</span>
            </div>
          )}

          {camErr && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-6 text-center">
              <Camera size={28} className="text-rose-400"/>
              <p className="text-[13px] font-semibold text-gray-800">Камер нээгдсэнгүй</p>
              <p className="max-w-xs text-[11.5px] leading-relaxed text-gray-600">{camErr}</p>
              <div className="flex gap-2">
                <button onClick={start} className="flex items-center gap-1.5 rounded-xl bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-violet-700">
                  <RefreshCw size={12}/>Дахин
                </button>
                <button onClick={() => setShowManual(true)} className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
                  <Keyboard size={12}/>Гараар
                </button>
              </div>
            </div>
          )}

          {!starting && !camErr && (
            <>
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-40 w-72 max-w-[80%] rounded-2xl border-2 border-violet-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"/>
              </div>
              <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1.5 text-[11px] text-white/80">
                <ScanLine size={12}/>Баркодыг рамкан дотор барина
                {mode && <span className="text-white/30">· {mode}</span>}
              </div>
            </>
          )}

          {busy && (
            <div className="absolute right-2 top-2 rounded-full bg-white/90 p-1.5">
              <Loader2 size={14} className="animate-spin text-violet-600"/>
            </div>
          )}
        </div>

        {/* Үр дүн */}
        <div className="flex min-h-0 flex-1 flex-col">
          {!res ? (
            <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 rounded-2xl bg-gray-50 text-gray-400">
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-violet-50 to-fuchsia-50">
                <ScanLine size={28} className="text-violet-400"/>
              </div>
              <p className="text-[14px] font-semibold text-gray-600">Баркодыг уншуулна уу</p>
            </div>
          ) : p ? (
            <div className="flex h-full flex-col rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50/60 to-white p-4">
              <div className="flex items-start gap-3">
                {p.image && (
                  <img src={p.image} alt="" className="h-20 w-20 shrink-0 rounded-xl object-cover shadow-sm"
                       onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}/>
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="text-[19px] font-bold leading-snug text-gray-900 sm:text-[22px]">{p.name}</h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-gray-500">
                    <span className="rounded-full bg-white px-2 py-0.5 font-mono font-semibold text-gray-700 shadow-sm">{p.code}</span>
                    {p.uom && <span>{p.uom}</span>}
                    {p.category && <span>· {p.category}</span>}
                  </div>
                </div>
              </div>

              <div className="my-auto py-4 text-center">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-violet-400">Зарах үнэ</div>
                <div className="text-[52px] font-black leading-none tracking-tight text-violet-700 sm:text-[68px]">
                  {money(p.price)}<span className="ml-1 text-[28px] font-bold sm:text-[34px]">₮</span>
                </div>
              </div>

              {bulk?.ok && (
                <div className="-mt-2 mb-3 text-center text-[13px] text-gray-500">
                  Бөөний <span className="text-[17px] font-bold text-emerald-600">{bulk.quantity} ш</span>
                  {" — "}
                  <span className="text-[17px] font-bold text-emerald-600">{bulk.price}₮</span>
                </div>
              )}

              <div className="flex items-center justify-center gap-2">
                <select value={copies} onChange={e => setCopies(Number(e.target.value))}
                  className="rounded-xl border border-violet-200 bg-white px-2.5 py-2 text-[12.5px] outline-none">
                  {[1, 2, 4, 8].map(n => <option key={n} value={n}>{n} ш</option>)}
                </select>
                <button onClick={() => printLabel(p.code)} disabled={printing}
                  className="flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60">
                  {printing ? <Loader2 size={14} className="animate-spin"/> : <Printer size={14}/>}
                  Шошго хэвлэх
                </button>
              </div>
              {printErr && <p className="mt-1.5 text-center text-[11.5px] text-rose-600">{printErr}</p>}

              {p.barcodes.length > 0 && (
                <div className="mt-2 border-t border-violet-100 pt-2 text-center font-mono text-[10.5px] text-gray-400">
                  {p.barcodes.slice(0, 3).join(" · ")}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 rounded-2xl border border-amber-200 bg-amber-50/50 p-5 text-center">
              <SearchX size={30} className="text-amber-500"/>
              <div>
                <p className="text-[15px] font-bold text-gray-800">Бараа олдсонгүй</p>
                <p className="mt-0.5 font-mono text-[12px] text-gray-500">{res.query}</p>
              </div>
              {res.error && <p className="text-[11.5px] text-rose-600">{res.error}</p>}
              {res.others.length > 0 && (
                <div className="w-full max-w-md">
                  <p className="mb-1.5 text-[11px] font-semibold text-gray-500">Ойролцоо бараанууд:</p>
                  <div className="space-y-1">
                    {res.others.slice(0, 5).map(o => (
                      <button key={o._id} onClick={() => lookup(o.code)}
                        className="flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-left hover:bg-violet-50">
                        <span className="font-mono text-[11px] text-gray-500">{o.code}</span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-800">{o.name}</span>
                        <span className="shrink-0 font-mono text-[12.5px] font-bold text-violet-700">{money(o.price)}₮</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
