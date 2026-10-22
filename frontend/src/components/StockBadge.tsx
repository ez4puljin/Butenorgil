import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/* Эрхэтийн одоогийн үлдэгдэл байршлаар (/stock-live/codes — ХТ-ууд erxes deal дээр хардагтай ижил).
   Эрхэтэд ачаалал үүсгэхгүйн тулд:
     · зөвхөн дэлгэц дээр харагдсан мөрийн кодыг (IntersectionObserver) асууна;
     · 80мс дотор ирсэн кодуудыг нэг хүсэлтэд (≤ 50) нэгтгэнэ;
     · хариуг 60 сек энэ хөтчид хадгална (сервер ч мөн 60 сек кэшилдэг). */

export interface LiveStock { total: number; locations: { code: string; name: string; qty: number }[] }
// null — код erxes/Эрхэтэд идэвхтэй бараагаар бүртгэлгүй; "error" — сервер/Эрхэт түр хариу өгсөнгүй
type Val = LiveStock | null | "error";

// Байршлын товч нэр (мөрөнд багтаах) — «11:12» гэх мэт цаг шиг харагдахаас сэргийлнэ
const SHORT: Record<string, string> = {
  "01": "Бөөний", "02": "Ус ундаа", "05": "Хархорин", "08": "Заал архи", "10": "Хөргүүр", "11": "Жижиглэн", "12": "Гэрээт",
};

const TTL = 60_000;
const cache = new Map<string, { at: number; v: Val }>();
const waiting = new Map<string, ((v: Val) => void)[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const codes = Array.from(waiting.keys());
  for (let i = 0; i < codes.length; i += 50) {
    const chunk = codes.slice(i, i + 50);
    const cbs = chunk.map(c => [c, waiting.get(c) ?? []] as const);
    chunk.forEach(c => waiting.delete(c));
    api.get("/stock-live/codes", { params: { codes: chunk.join(",") }, timeout: 60000 })
      .then(r => {
        const by = new Map<string, LiveStock>((r.data.items ?? []).map((x: any) => [x.code, x]));
        for (const [c, fs] of cbs) {
          const v = by.get(c) ?? null;
          cache.set(c, { at: Date.now(), v });
          fs.forEach(f => f(v));
        }
      })
      .catch(() => { for (const [, fs] of cbs) fs.forEach(f => f("error")); });   // кэшлэхгүй — дараа дахин
  }
}

export function fetchLiveStock(code: string): Promise<Val> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.v);
  return new Promise(res => {
    waiting.set(code, [...(waiting.get(code) ?? []), res]);
    if (!timer) timer = setTimeout(flush, 80);
  });
}

function q(n: number) { return Math.round(n).toLocaleString("en-US"); }

export default function StockBadge({ code, variant = "inline", className = "" }:
  { code: string; variant?: "inline" | "block"; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [v, setV] = useState<Val | undefined>(undefined);

  useEffect(() => {
    if (!code) return;
    const el = ref.current;
    let alive = true;
    const load = () => fetchLiveStock(code).then(x => { if (alive) setV(x); });
    if (!el || typeof IntersectionObserver === "undefined") { load(); return () => { alive = false; }; }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); load(); } },
      { rootMargin: "200px" });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [code]);

  const ok = v && v !== "error" ? v : null;
  const locs = (ok?.locations ?? []).filter(l => l.qty);
  const title = ok
    ? `Эрхэтийн үлдэгдэл: ${q(ok.total)}\n` + ok.locations.map(l => `${l.code} ${l.name}: ${q(l.qty)}`).join("\n")
    : v === null ? "Энэ код erxes, Эрхэтэд идэвхтэй бараагаар бүртгэлгүй (код өөрчлөгдсөн эсвэл хасагдсан бараа)"
    : v === "error" ? "Эрхэтийн үлдэгдэл түр авч чадсангүй — хуудсыг дахин ачаална уу" : "";
  const empty = v === undefined ? "…" : v === null ? "бүртгэлгүй" : "алдаа";

  if (variant === "block") {
    return (
      <span ref={ref} className={`flex flex-wrap items-center gap-1 text-[11.5px] ${className}`}>
        <span className="text-gray-500">Эрхэт үлдэгдэл:</span>
        {!ok ? <span className={v === null ? "text-amber-600" : "text-gray-300"} title={title}>{empty}</span>
          : <>
              <b className={ok.total > 0 ? "text-teal-700" : "text-gray-400"}>{q(ok.total)}</b>
              {locs.map(l => (
                <span key={l.code} className="rounded-md bg-teal-50 px-1.5 text-teal-800">{l.name} {q(l.qty)}</span>
              ))}
            </>}
      </span>
    );
  }
  return (
    <span ref={ref} title={title}
      className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold ${
        ok && ok.total > 0 ? "border-teal-200 bg-teal-50 text-teal-700"
          : v === null ? "border-amber-200 bg-amber-50 text-amber-700" : "border-gray-200 bg-gray-50 text-gray-400"} ${className}`}>
      Эрхэт {ok ? q(ok.total) : empty}
      {locs.length > 0 && <span className="font-normal opacity-80">· {locs.map(l => `${SHORT[l.code] ?? l.code} ${q(l.qty)}`).join(", ")}</span>}
    </span>
  );
}
