import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { TrendingUp, RefreshCw, X, Search, Table2, BarChart3, ChevronRight, ChevronDown, Check, Upload } from "lucide-react";
import { api } from "../lib/api";

/* ═══════════════════════════════════════════════════════════════════════════
   Борлуулалтын график — сарын борлуулалт (Агуулах, Заал, Заалны архи)-ыг мастерын
   ангилал, бренд, бараагаар өсөлт/бууралтыг харуулна. Өгөгдлийг сервер урьдчилан
   ачаалсан (мастер/борлуулалт шинэчлэгдэх бүрт) тул хариу ~0-30мс.
   Шүүлтүүд URL-д хадгалагдана — drill-down хийгээд «Буцах»-аар өмнөх харагдац руу.
   Өнгө: dataviz reference palette (цагаан гадаргуу дээр validate хийсэн).
   ═══════════════════════════════════════════════════════════════════════════ */

type Kind = "warehouse" | "showroom" | "liquor";
type Dim = "category" | "brand" | "product" | "location";
type Metric = "amount" | "qty";
type Sort = "total" | "growth" | "decline";
type Row = { key: string; label: string; sub: string; count: number; series: (number | null)[]; total: number;
  last: number; prev: number | null; mom: number | null; trend: number | null; share: number | null };
type Mover = { key: string; label: string; trend: number; recent: number; base: number; total: number };
type Result = {
  year: number; months: number[]; metric: Metric; dim: Dim; kinds: Kind[]; version: string; ms?: number;
  kpi: { total: number; avg_month: number; last: number; prev: number | null; mom: number | null; trend: number | null; products: number } | null;
  trend_basis: { recent: number[]; base: number[] } | null;
  by_location: { key: Kind; label: string; series: number[]; total: number }[];
  total_series: number[]; rows: Row[]; rows_total: number; movers: { up: Mover[]; down: Mover[] };
};
type Meta = {
  version: string; default_year: number;
  info: { products: number; rows: number; master_updated: string | null; built_at: string; has_amount: boolean };
  years: { year: number; months: number[]; default: [number, number] }[];
  kinds: { key: Kind; label: string }[];
  categories: { name: string; count: number }[]; brands: { name: string; count: number }[]; tags: string[];
};

// ── Өнгө (light surface #ffffff дээр validate_palette.js-ээр шалгасан) ──
const C = {
  ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e9e8e3", axis: "#c3c2b7", wash: "#f4f3ef",
  up: "#2a78d6", down: "#e34948", spark: "#b4b2a9", good: "#006300", bad: "#d03b3b",
  loc: { warehouse: "#2a78d6", showroom: "#eb6834", liquor: "#1baf7a" } as Record<Kind, string>,
};
const KIND_LABEL: Record<Kind, string> = { warehouse: "Агуулах", showroom: "Заал", liquor: "Заалны архи" };
const ALL_KINDS: Kind[] = ["warehouse", "showroom", "liquor"];
const DIM_LABEL: Record<Dim, string> = { category: "Ангилал", brand: "Бренд", product: "Бараа", location: "Байршил" };
const DIMS: Dim[] = ["category", "brand", "product", "location"];

// ── Тоо форматлах ──
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const unit = (m: Metric) => (m === "amount" ? "₮" : "ш");
const compact = (v: number | null | undefined) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  const f = (x: number) => (x >= 100 ? nf.format(x) : nf1.format(x));
  if (a >= 1e9) return `${f(v / 1e9)} тэрбум`;
  if (a >= 1e6) return `${f(v / 1e6)} сая`;
  if (a >= 1e4) return `${f(v / 1e3)} мянга`;
  return nf1.format(v);
};
const full = (v: number | null | undefined, m: Metric) => (v == null ? "—" : `${m === "amount" ? nf.format(Math.round(v)) : nf1.format(v)} ${unit(m)}`);
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${nf1.format(Math.abs(v))}%`);
const monthsText = (ms: number[]) => (ms.length ? (ms.length === 1 ? `${ms[0]}` : `${ms[0]}–${ms[ms.length - 1]}`) : "");

function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setW(Math.floor(es[0].contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ── Жижиг хэсгүүд ──
function Delta({ v, suffix }: { v: number | null | undefined; suffix?: string }) {
  if (v == null) return <span className="text-[12px] text-gray-400">—</span>;
  const upv = v > 0, zero = v === 0;
  return (
    <span className="inline-flex items-center gap-0.5 text-[12px] font-semibold tabular-nums" style={{ color: zero ? C.muted : upv ? C.good : C.bad }}>
      <span aria-hidden>{zero ? "■" : upv ? "▲" : "▼"}</span>{pct(v)}{suffix && <span className="ml-1 font-normal text-gray-500">{suffix}</span>}
    </span>
  );
}

function Sparkline({ values, width = 96, height = 26 }: { values: (number | null)[]; width?: number; height?: number }) {
  const vs = values.map((v) => v ?? 0);
  if (vs.length < 2) return <svg width={width} height={height} />;
  const max = Math.max(...vs), min = Math.min(0, ...vs);
  const x = (i: number) => 3 + (i * (width - 6)) / (vs.length - 1);
  const y = (v: number) => height - 3 - ((v - min) / (max - min || 1)) * (height - 6);
  const d = vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} aria-hidden>
      <path d={d} fill="none" stroke={C.spark} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(vs.length - 1)} cy={y(vs[vs.length - 1])} r={3.5} fill={C.up} stroke="#fff" strokeWidth={1.5} />
    </svg>
  );
}

function StatTile({ label, value, sub, delta, deltaSuffix, spark }: {
  label: string; value: string; sub?: string; delta?: number | null; deltaSuffix?: string; spark?: (number | null)[];
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 truncate text-[12px] text-gray-500">{label}</div>
        {spark && <div className="-mt-1 shrink-0"><Sparkline values={spark} width={64} height={22} /></div>}
      </div>
      <div className="mt-0.5 text-[20px] font-semibold leading-tight text-gray-900">{value}</div>
      {delta !== undefined && <div className="mt-0.5"><Delta v={delta} suffix={deltaSuffix} /></div>}
      {sub && <div className="mt-0.5 truncate text-[11px] text-gray-400">{sub}</div>}
    </div>
  );
}

// ── Сар бүрийн багана (байршлаар давхарласан) ──
function StackedColumns({ months, series, metric }: {
  months: number[]; series: { key: Kind; label: string; series: number[] }[]; metric: Metric;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const H = 250, top = 22, bottom = 26, left = 58, right = 8;
  const M = months.length;
  const totals = months.map((_, i) => series.reduce((s, sr) => s + (sr.series[i] || 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals), 4);
  const yMax = ticks[ticks.length - 1] || 1;
  const innerW = Math.max(0, width - left - right), innerH = H - top - bottom;
  const band = M ? innerW / M : 0;
  const bw = Math.max(4, Math.min(24, band * 0.62));
  const y = (v: number) => top + innerH - (v / yMax) * innerH;
  const colX = (i: number) => left + i * band + (band - bw) / 2;
  const roundTop = (x: number, yt: number, w: number, h: number) => {
    const r = Math.min(4, h, w / 2);
    return `M${x},${yt + h}L${x},${yt + r}Q${x},${yt} ${x + r},${yt}L${x + w - r},${yt}Q${x + w},${yt} ${x + w},${yt + r}L${x + w},${yt + h}Z`;
  };
  return (
    <div ref={ref} className="relative w-full" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Сар бүрийн борлуулалт байршлаар">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.axis : C.grid} strokeWidth={1} />
              <text x={left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10.5} fill={C.muted} style={{ fontVariantNumeric: "tabular-nums" }}>{compact(t)}</text>
            </g>
          ))}
          {hover && <rect x={left + hover.i * band} y={top} width={band} height={innerH} fill={C.wash} />}
          {months.map((m, i) => {
            let cum = 0;
            const segs = series.map((sr) => ({ key: sr.key, v: sr.series[i] || 0 })).filter((s) => s.v > 0);
            const topIdx = segs.length - 1;
            return (
              <g key={m}>
                {segs.map((s, si) => {
                  const y0 = y(cum), y1 = y(cum + s.v);
                  cum += s.v;
                  let h = y0 - y1;
                  const gap = si < topIdx && h > 3 ? 2 : 0;               // 2px гадаргуун зай (дээд сегменттэй)
                  const yt = y1 + gap;
                  h -= gap;
                  if (h <= 0) return null;
                  return si === topIdx
                    ? <path key={s.key} d={roundTop(colX(i), yt, bw, h)} fill={C.loc[s.key as Kind]} />
                    : <rect key={s.key} x={colX(i)} y={yt} width={bw} height={h} fill={C.loc[s.key as Kind]} />;
                })}
                <text x={left + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize={10.5} fill={C.muted}>
                  {band >= 48 ? `${m}-р сар` : band >= 36 ? `${m} сар` : m}
                </text>
                {i === M - 1 && totals[i] > 0 && (() => {
                  const lbl = compact(totals[i]);
                  const half = (lbl.length * 6.4) / 2;                  // 11px фонтын ойролцоо өргөн
                  if (half * 2 > band * 1.8) return null;               // багтахгүй бол шошгогүй — tooltip/хүснэгтэд байгаа
                  const cx = Math.min(colX(i) + bw / 2, width - right - half);
                  return <text x={cx} y={y(totals[i]) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill={C.ink2}>{lbl}</text>;
                })()}
                <rect x={left + i * band} y={top} width={band} height={innerH} fill="transparent" tabIndex={0}
                  aria-label={`${m}-р сар: ${full(totals[i], metric)}`}
                  onPointerMove={(e) => { const r = ref.current!.getBoundingClientRect(); setHover({ i, x: e.clientX - r.left, y: e.clientY - r.top }); }}
                  onFocus={() => setHover({ i, x: left + i * band + band / 2, y: top + 20 })} onBlur={() => setHover(null)} />
              </g>
            );
          })}
        </svg>
      )}
      {hover && (
        <div className="pointer-events-none absolute z-10 min-w-[190px] rounded-xl border border-gray-100 bg-white px-3 py-2 text-[12px] shadow-lg"
          style={{ left: Math.min(Math.max(8, hover.x + 12), Math.max(8, width - 210)), top: Math.max(0, hover.y - 20) }}>
          <div className="mb-1 font-semibold text-gray-800">{months[hover.i]}-р сар</div>
          {series.map((sr) => (
            <div key={sr.key} className="flex items-center gap-2 py-0.5">
              <span className="inline-block h-[2px] w-3 rounded" style={{ background: C.loc[sr.key] }} />
              <span className="text-gray-500">{sr.label}</span>
              <span className="ml-auto font-semibold tabular-nums text-gray-900">{full(sr.series[hover.i] || 0, metric)}</span>
            </div>
          ))}
          {series.length > 1 && (
            <div className="mt-1 flex border-t border-gray-100 pt-1">
              <span className="text-gray-500">Нийт</span>
              <span className="ml-auto font-bold tabular-nums text-gray-900">{full(totals[hover.i], metric)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Хамгийн их өссөн / буурсан (diverging) ──
function DivergingBars({ up, down, metric, basis, onPick }: {
  up: Mover[]; down: Mover[]; metric: Metric; basis: Result["trend_basis"]; onPick: (m: Mover) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ m: Mover; x: number; y: number } | null>(null);
  // Дээрээс доош буурах дарааллаар: хамгийн их өссөн → … → хамгийн их буурсан
  const rows = [...up, ...[...down].reverse()];
  const cap = Math.min(200, Math.max(10, ...rows.map((r) => Math.abs(r.trend))));
  const narrow = width < 480;
  const labelW = Math.min(180, Math.max(96, width * (narrow ? 0.42 : 0.3)));
  const valW = narrow ? 46 : 58;
  const maxChars = Math.max(6, Math.floor((labelW - 10) / 6.3));   // 11.5px фонтын ойролцоо тэмдэгтийн өргөн
  const barArea = Math.max(40, width - labelW - valW * 2);
  const half = barArea / 2, zeroX = labelW + valW + half;
  const rowH = 26, bh = 14;
  const H = rows.length * rowH + (up.length && down.length ? 10 : 0);
  let yCursor = 0;
  const rr = (x: number, yy: number, w: number, dir: 1 | -1) => {
    const r = Math.min(4, w, bh / 2);
    if (dir === 1) return `M${x},${yy}L${x + w - r},${yy}Q${x + w},${yy} ${x + w},${yy + r}L${x + w},${yy + bh - r}Q${x + w},${yy + bh} ${x + w - r},${yy + bh}L${x},${yy + bh}Z`;
    return `M${x},${yy}L${x - w + r},${yy}Q${x - w},${yy} ${x - w},${yy + r}L${x - w},${yy + bh - r}Q${x - w},${yy + bh} ${x - w + r},${yy + bh}L${x},${yy + bh}Z`;
  };
  return (
    <div ref={ref} className="relative w-full" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Хамгийн их өссөн ба буурсан">
          <line x1={zeroX} x2={zeroX} y1={0} y2={H} stroke={C.axis} strokeWidth={1} />
          {rows.map((m, idx) => {
            if (idx === up.length && up.length) yCursor += 10;
            const yy = yCursor + idx * rowH + (rowH - bh) / 2;
            const w = (Math.min(Math.abs(m.trend), cap) / cap) * half;
            const pos = m.trend >= 0;
            const tx = pos ? zeroX + w + 5 : zeroX - w - 5;
            return (
              <g key={`${m.key}-${idx}`} className="cursor-pointer" onClick={() => onPick(m)}
                onPointerMove={(e) => { const r = ref.current!.getBoundingClientRect(); setHover({ m, x: e.clientX - r.left, y: e.clientY - r.top }); }}>
                <rect x={0} y={yy - (rowH - bh) / 2} width={width} height={rowH} fill={hover?.m === m ? C.wash : "transparent"} />
                <text x={labelW - 6} y={yy + bh / 2} dy="0.34em" textAnchor="end" fontSize={11.5} fill={C.ink}>
                  {m.label.length > maxChars ? m.label.slice(0, maxChars - 1) + "…" : m.label}
                </text>
                <path d={rr(zeroX, yy, Math.max(1, w), pos ? 1 : -1)} fill={pos ? C.up : C.down} />
                <text x={tx} y={yy + bh / 2} dy="0.34em" textAnchor={pos ? "start" : "end"} fontSize={11} fontWeight={600} fill={C.ink2}
                  style={{ fontVariantNumeric: "tabular-nums" }}>{pct(m.trend)}</text>
              </g>
            );
          })}
        </svg>
      )}
      {hover && basis && (
        <div className="pointer-events-none absolute z-10 w-[230px] rounded-xl border border-gray-100 bg-white px-3 py-2 text-[12px] shadow-lg"
          style={{ left: Math.min(Math.max(8, hover.x + 12), Math.max(8, width - 240)), top: hover.y + 12 }}>
          <div className="mb-1 font-semibold text-gray-800">{hover.m.label}</div>
          <div className="flex"><span className="text-gray-500">{monthsText(basis.recent)} сарын дундаж</span><span className="ml-auto font-semibold tabular-nums">{compact(hover.m.recent)} {unit(metric)}</span></div>
          <div className="flex"><span className="text-gray-500">{monthsText(basis.base)} сарын дундаж</span><span className="ml-auto font-semibold tabular-nums">{compact(hover.m.base)} {unit(metric)}</span></div>
          <div className="mt-1 border-t border-gray-100 pt-1"><Delta v={hover.m.trend} /></div>
        </div>
      )}
    </div>
  );
}

// ── Хайж, олон сонгох шүүлт (ангилал / бренд / tag) ──
type Opt = { name: string; count: number; total: number | null };
type Facets = { categories: Opt[]; brands: Opt[]; tags: Opt[] };
const SEP = "||";                                   // олон утгын тусгаарлагч (нэрэнд таслал байдаг)
const splitSel = (v: string) => (v ? v.split(SEP).filter(Boolean) : []);

function MultiSelect({ label, allLabel, options, selected, onChange, metric, className = "" }: {
  label: string; allLabel: string; options: Opt[]; selected: string[]; onChange: (v: string[]) => void;
  metric: Metric; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [alignRight, setAlignRight] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const openMenu = () => {
    const r = boxRef.current?.getBoundingClientRect();
    setAlignRight(!!r && r.left + 340 > window.innerWidth - 8);
    setQ(""); setHi(0); setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const selSet = useMemo(() => new Set(selected), [selected]);
  const toks = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = useMemo(() => {
    const all = [...options];
    selected.forEach((v) => { if (!all.some((o) => o.name === v)) all.push({ name: v, count: 0, total: null }); });
    const f = toks.length ? all.filter((o) => { const n = o.name.toLowerCase(); return toks.every((t) => n.includes(t)); }) : all;
    return [...f.filter((o) => selSet.has(o.name)), ...f.filter((o) => !selSet.has(o.name))];   // сонгосон нь дээр
  }, [options, selected, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" }); }, [hi]);

  const toggle = (name: string) => onChange(selSet.has(name) ? selected.filter((x) => x !== name) : [...selected, name]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(list.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (list[hi]) toggle(list[hi].name); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };
  const found = toks.length ? list.filter((o) => !selSet.has(o.name)) : [];
  const summary = selected.length === 0 ? allLabel : selected.length === 1 ? selected[0] : `${selected[0]} +${selected.length - 1}`;

  return (
    <div ref={boxRef} className={`relative min-w-0 ${className}`}>
      <button type="button" onClick={() => (open ? setOpen(false) : openMenu())} aria-haspopup="listbox" aria-expanded={open}
        title={selected.join(", ")}
        className={`flex w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] outline-none focus:border-blue-400 ${
          selected.length ? "border-blue-300 bg-blue-50/60 text-blue-900" : "border-gray-200 bg-white text-gray-800"}`}>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {selected.length > 1 && <span className="shrink-0 rounded-full bg-blue-600 px-1.5 text-[10.5px] font-bold leading-4 text-white">{selected.length}</span>}
        <ChevronDown size={14} className={`shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className={`absolute z-30 mt-1 w-[340px] max-w-[calc(100vw-24px)] rounded-xl border border-gray-200 bg-white shadow-xl ${alignRight ? "right-0" : "left-0"}`}>
          <div className="border-b border-gray-100 p-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
                placeholder={`${label} бичиж хайх…`} aria-label={`${label} хайх`}
                className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-2 text-[13px] outline-none focus:border-blue-400" />
            </div>
          </div>
          <div className="flex px-3 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            <span className="flex-1">{label}</span><span>бараа</span><span className="w-[64px] text-right">{metric === "amount" ? "дүн ₮" : "тоо ш"}</span>
          </div>
          <div ref={listRef} role="listbox" aria-multiselectable="true" aria-label={label} className="max-h-[300px] overflow-y-auto pb-1">
            {list.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-gray-400">«{q}» олдсонгүй</div>
            ) : list.map((o, i) => {
              const on = selSet.has(o.name);
              return (
                <div key={o.name} data-i={i} role="option" aria-selected={on} onClick={() => toggle(o.name)} onMouseEnter={() => setHi(i)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12.5px] ${i === hi ? "bg-blue-50/70" : ""}`}>
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${on ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300 bg-white"}`}>
                    {on && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${on ? "font-semibold text-gray-900" : "text-gray-700"}`}>{o.name}</span>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-gray-400">{o.count}</span>
                  <span className="w-[64px] shrink-0 text-right text-[11px] tabular-nums text-gray-500">{o.total == null ? "" : compact(o.total)}</span>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-100 px-3 py-2 text-[12px]">
            <span className="text-gray-500">{selected.length ? `${selected.length} сонгосон` : "Олныг сонгож болно"}</span>
            {found.length > 1 && found.length <= 100 && (
              <button onClick={() => onChange([...selected, ...found.map((o) => o.name)])} className="font-medium text-blue-700 hover:underline">Олдсон {found.length}-г сонгох</button>
            )}
            <span className="flex-1" />
            {selected.length > 0 && <button onClick={() => onChange([])} className="text-gray-600 hover:underline">Цэвэрлэх</button>}
            <button onClick={() => setOpen(false)} className="rounded-md bg-blue-600 px-2.5 py-1 font-semibold text-white hover:bg-blue-700">Болсон</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ Хуудас ═══
const cache = new Map<string, Result>();
const fcache = new Map<string, Facets>();

export default function SalesAnalytics() {
  const [sp, setSp] = useSearchParams();
  const P = {
    y: Number(sp.get("y")) || 0, from: Number(sp.get("from")) || 0, to: Number(sp.get("to")) || 0,
    k: (sp.get("k") || ALL_KINDS.join(",")).split(",").filter((x): x is Kind => (ALL_KINDS as string[]).includes(x)),
    mt: (sp.get("mt") === "qty" ? "qty" : "amount") as Metric,
    d: ((DIMS as string[]).includes(sp.get("d") || "") ? sp.get("d") : "category") as Dim,
    cat: sp.get("cat") || "", br: sp.get("br") || "", tag: sp.get("tag") || "", q: sp.get("q") || "",
    code: sp.get("code") || "", cn: sp.get("cn") || "",
    s: ((["total", "growth", "decline"] as string[]).includes(sp.get("s") || "") ? sp.get("s") : "total") as Sort,
  };
  const setP = useCallback((patch: Record<string, string | number | null>, push = true) => {
    setSp((cur) => {
      const n = new URLSearchParams(cur);
      Object.entries(patch).forEach(([k, v]) => { if (v === null || v === "" || v === 0) n.delete(k); else n.set(k, String(v)); });
      return n;
    }, { replace: !push });
  }, [setSp]);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [top, setTop] = useState(50);
  const [tableView, setTableView] = useState(false);
  const [qInput, setQInput] = useState(P.q);

  const loadMeta = useCallback(async (fresh = false) => {
    try {
      const r = await api.get("/sales-analytics/meta");
      if (fresh || (meta && meta.version !== r.data.version)) cache.clear();
      setMeta(r.data);
    } catch (e: any) { setErr(e?.response?.data?.detail ?? "Мэдээлэл ачаалж чадсангүй."); }
  }, [meta]);
  useEffect(() => { loadMeta(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const year = P.y || meta?.default_year || 0;
  const yInfo = meta?.years.find((y) => y.year === year);
  const mFrom = P.from || yInfo?.default[0] || 1;
  const mTo = P.to || yInfo?.default[1] || 12;
  const kinds = P.k.length ? P.k : ALL_KINDS;

  const qsFor = useCallback((dim: Dim, topN: number) => {
    const u = new URLSearchParams({
      year: String(year), m_from: String(mFrom), m_to: String(mTo), kinds: kinds.join(","), metric: P.mt, dim,
      cats: P.cat, brands: P.br, tags: P.tag, q: P.q, code: P.code, sort: P.s, top: String(topN),
    });
    return u.toString();
  }, [year, mFrom, mTo, kinds.join(","), P.mt, P.cat, P.br, P.tag, P.q, P.code, P.s]); // eslint-disable-line react-hooks/exhaustive-deps

  const qs = meta ? qsFor(P.d, top) : "";

  // Сонголтын жагсаалт — бусад шүүлтээр шүүгдсэн (ангилал сонговол бренд нь зөвхөн түүнийх г.м)
  const [facets, setFacets] = useState<Facets | null>(null);
  const fqs = meta ? new URLSearchParams({ year: String(year), m_from: String(mFrom), m_to: String(mTo), kinds: kinds.join(","),
    metric: P.mt, cats: P.cat, brands: P.br, tags: P.tag, q: P.q }).toString() : "";
  useEffect(() => {
    if (!fqs) return;
    const hit = fcache.get(fqs);
    if (hit) { setFacets(hit); return; }
    let dead = false;
    api.get(`/sales-analytics/facets?${fqs}`).then((r) => { fcache.set(fqs, r.data); if (!dead) setFacets(r.data); }).catch(() => { /* meta-гийн жагсаалт үлдэнэ */ });
    return () => { dead = true; };
  }, [fqs]);
  useEffect(() => { setTop(50); }, [qsFor, P.d]);
  useEffect(() => {
    if (!qs) return;
    const hit = cache.get(qs);
    if (hit) { setData(hit); setLoading(false); return; }
    let dead = false;
    setLoading(true); setErr("");
    api.get(`/sales-analytics/query?${qs}`).then((r) => {
      cache.set(qs, r.data);
      if (!dead) setData(r.data);
      // Бусад бүлэглэлтийг background-д урьдчилан татна — tab солиход шууд гарна
      DIMS.filter((d) => d !== P.d).forEach((d) => {
        const k = qsFor(d, 50);
        if (!cache.has(k)) api.get(`/sales-analytics/query?${k}`).then((x) => cache.set(k, x.data)).catch(() => {});
      });
    }).catch((e) => { if (!dead) setErr(e?.response?.data?.detail ?? "Өгөгдөл ачаалж чадсангүй."); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [qs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Хайлт — бичиж дуусахад (300мс)
  useEffect(() => { setQInput(P.q); }, [P.q]);
  useEffect(() => {
    if (qInput === P.q) return;
    const t = setTimeout(() => setP({ q: qInput, code: null, cn: null }, false), 300);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const drill = (key: string, label: string) => {
    if (P.d === "category") setP({ cat: key, d: "brand", s: null });
    else if (P.d === "brand") setP({ br: key, d: "product", s: null });
    else if (P.d === "product") setP({ code: key, cn: label, d: "location", s: null });
    else setP({ k: key, d: "category", s: null });
  };
  const toggleKind = (k: Kind) => {
    const on = kinds.includes(k);
    const next = on ? kinds.filter((x) => x !== k) : ALL_KINDS.filter((x) => x === k || kinds.includes(x));
    if (next.length === 0) return;
    setP({ k: next.length === 3 ? null : next.join(",") });
  };

  const d = data;
  const kpi = d?.kpi;
  const lastM = d?.months[d.months.length - 1];
  const catSel = splitSel(P.cat), brSel = splitSel(P.br), tagSel = splitSel(P.tag);
  const listTxt = (lb: string, arr: string[]) =>
    arr.length ? `${lb}: ${arr.length > 2 ? `${arr.slice(0, 2).join(", ")} +${arr.length - 2}` : arr.join(", ")}` : "";
  const scope = [listTxt("Ангилал", catSel), listTxt("Бренд", brSel), listTxt("Tag", tagSel),
    P.code && `Бараа: ${P.cn || P.code}`, P.q && `«${P.q}»`].filter(Boolean).join(" · ");
  const without = (arr: string[], v: string) => arr.filter((x) => x !== v).join(SEP) || null;
  const chips: { k: string; label: string; clear: Record<string, string | null> }[] = [
    ...catSel.map((v) => ({ k: `cat:${v}`, label: `Ангилал: ${v}`, clear: { cat: without(catSel, v) } })),
    ...brSel.map((v) => ({ k: `br:${v}`, label: `Бренд: ${v}`, clear: { br: without(brSel, v) } })),
    ...tagSel.map((v) => ({ k: `tag:${v}`, label: `Tag: ${v}`, clear: { tag: without(tagSel, v) } })),
    ...(P.code ? [{ k: "code", label: `Бараа: ${P.cn || P.code}`, clear: { code: null, cn: null } }] : []),
    ...(P.q ? [{ k: "q", label: `Хайлт: ${P.q}`, clear: { q: null } }] : []),
  ];
  const optCats: Opt[] = facets?.categories ?? (meta?.categories ?? []).map((c) => ({ name: c.name, count: c.count, total: null }));
  const optBrands: Opt[] = facets?.brands ?? (meta?.brands ?? []).map((b) => ({ name: b.name, count: b.count, total: null }));
  const optTags: Opt[] = facets?.tags ?? (meta?.tags ?? []).map((t) => ({ name: t, count: 0, total: null }));
  const sel = "rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[12.5px] text-gray-800 outline-none focus:border-blue-400";

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-3">
      {/* Толгой */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white"><TrendingUp size={19} /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[16px] font-bold leading-tight text-gray-900">Борлуулалтын график</h1>
          <p className="truncate text-[11.5px] text-gray-500">
            {d ? `${d.year} оны ${monthsText(d.months)}-р сар · ${P.mt === "amount" ? "Дүн ₮ (НӨАТ-тэй)" : "Тоо ширхэг"}` : "Ачаалж байна…"}
            {meta?.info.master_updated && ` · мастер ${meta.info.master_updated.split("T")[0]}`}
            {meta?.info.built_at && ` · бэлдсэн ${meta.info.built_at.split("T")[1]?.slice(0, 5)}`}
          </p>
        </div>
        <Link to="/imports/product-monthly-sales" title="Сарын борлуулалт оруулах"
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50">
          <Upload size={13} /><span className="hidden sm:inline">Сарын борлуулалт</span>
        </Link>
        <button onClick={() => { cache.clear(); fcache.clear(); loadMeta(true); setData(null); }} title="Шинэчлэх"
          className="rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-50"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>
      </div>

      {/* Шүүлтүүд — бүх график, хүснэгтийг хамарна */}
      <div className="flex flex-col gap-2 rounded-2xl bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select value={year} onChange={(e) => setP({ y: Number(e.target.value), from: null, to: null })} className={sel} aria-label="Он">
            {(meta?.years ?? []).map((y) => <option key={y.year} value={y.year}>{y.year} он</option>)}
          </select>
          <span className="inline-flex items-center gap-1 text-[12px] text-gray-500">
            <select value={mFrom} onChange={(e) => setP({ from: Number(e.target.value) })} className={sel} aria-label="Эхлэх сар">
              {(yInfo?.months ?? []).map((m) => <option key={m} value={m}>{m}-р сар</option>)}
            </select>–
            <select value={mTo} onChange={(e) => setP({ to: Number(e.target.value) })} className={sel} aria-label="Дуусах сар">
              {(yInfo?.months ?? []).map((m) => <option key={m} value={m}>{m}-р сар</option>)}
            </select>
          </span>
          <div className="flex rounded-lg bg-gray-100 p-0.5">
            {(["amount", "qty"] as Metric[]).map((m) => (
              <button key={m} onClick={() => setP({ mt: m === "amount" ? null : m })}
                className={`rounded-md px-2.5 py-1 text-[12px] font-semibold ${P.mt === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>
                {m === "amount" ? "Дүн ₮" : "Тоо ш"}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_KINDS.map((k) => {
              const on = kinds.includes(k);
              return (
                <button key={k} onClick={() => toggleKind(k)} aria-pressed={on}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset ${on ? "bg-white text-gray-800 ring-gray-300" : "bg-gray-50 text-gray-400 ring-gray-200"}`}>
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: on ? C.loc[k] : "#d4d3cd" }} />{KIND_LABEL[k]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MultiSelect label="Ангилал" allLabel="Бүх ангилал" options={optCats} selected={catSel} metric={P.mt}
            onChange={(v) => setP({ cat: v.join(SEP) || null }, false)} className="w-[calc(50%-4px)] sm:w-[220px]" />
          <MultiSelect label="Бренд" allLabel="Бүх бренд" options={optBrands} selected={brSel} metric={P.mt}
            onChange={(v) => setP({ br: v.join(SEP) || null }, false)} className="w-[calc(50%-4px)] sm:w-[220px]" />
          {!!meta?.tags.length && (
            <MultiSelect label="Tag" allLabel="Бүх tag" options={optTags} selected={tagSel} metric={P.mt}
              onChange={(v) => setP({ tag: v.join(SEP) || null }, false)} className="w-[calc(50%-4px)] sm:w-[200px]" />
          )}
          <div className="relative min-w-[160px] flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Бараа: нэр, код…"
              className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-[12.5px] outline-none focus:border-blue-400" />
          </div>
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((c) => (
              <button key={c.k} onClick={() => setP(c.clear)} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-[11.5px] font-medium text-blue-800 hover:bg-blue-100">
                {c.label}<X size={12} />
              </button>
            ))}
            <button onClick={() => setP({ cat: null, br: null, tag: null, code: null, cn: null, q: null })} className="text-[11.5px] text-gray-500 underline">Бүгдийг цэвэрлэх</button>
          </div>
        )}
      </div>

      {err && <div className="rounded-xl bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{err}</div>}
      {!d && !err && <div className="rounded-2xl bg-white p-10 text-center text-[13px] text-gray-400 shadow-sm"><RefreshCw size={18} className="mx-auto mb-2 animate-spin" />Ачаалж байна…</div>}

      {d && kpi && (
        <div className={`flex flex-col gap-3 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {/* KPI */}
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <StatTile label="Нийт борлуулалт" value={`${compact(kpi.total)} ${unit(P.mt)}`} sub={`${monthsText(d.months)}-р сар · ${nf.format(kpi.products)} бараа`} spark={d.total_series} />
            <StatTile label="Сарын дундаж" value={`${compact(kpi.avg_month)} ${unit(P.mt)}`} sub={scope || "Бүх бараа"} />
            <StatTile label={`${lastM}-р сар`} value={`${compact(kpi.last)} ${unit(P.mt)}`} delta={kpi.mom} deltaSuffix="өмнөх сараас" />
            <StatTile label={d.trend_basis ? `${monthsText(d.trend_basis.recent)}-р сарын дундаж` : "Чиг хандлага"}
              value={d.trend_basis ? `${compact((d.total_series.slice(-d.trend_basis.recent.length).reduce((a, b) => a + (b || 0), 0)) / d.trend_basis.recent.length)} ${unit(P.mt)}` : "—"}
              delta={kpi.trend} deltaSuffix={d.trend_basis ? `${monthsText(d.trend_basis.base)}-тай` : undefined} />
          </div>

          {/* Сар бүрийн борлуулалт — байршлаар */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
            <div className="mb-2 flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-bold text-gray-900">Сар бүрийн борлуулалт{d.by_location.length > 1 ? " — байршлаар" : ` — ${d.by_location[0]?.label ?? ""}`}</div>
                <div className="truncate text-[11.5px] text-gray-500">{scope || "Бүх бараа"} · {P.mt === "amount" ? "₮, НӨАТ-тэй" : "ширхэг"}</div>
              </div>
              <button onClick={() => setTableView((v) => !v)} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11.5px] text-gray-600 hover:bg-gray-50">
                {tableView ? <><BarChart3 size={12} /> График</> : <><Table2 size={12} /> Хүснэгт</>}
              </button>
            </div>
            {d.by_location.length > 1 && (
              <div className="mb-1 flex flex-wrap gap-3 text-[11.5px] text-gray-600">
                {d.by_location.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: C.loc[s.key] }} />{s.label}
                    <span className="tabular-nums text-gray-400">{compact(s.total)}</span></span>
                ))}
              </div>
            )}
            {tableView ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead><tr className="border-b border-gray-100 text-left text-[11px] text-gray-500">
                    <th className="py-1.5 pr-3">Сар</th>
                    {d.by_location.map((s) => <th key={s.key} className="py-1.5 pr-3 text-right">{s.label}</th>)}
                    <th className="py-1.5 text-right">Нийт</th>
                  </tr></thead>
                  <tbody>
                    {d.months.map((m, i) => (
                      <tr key={m} className="border-b border-gray-50">
                        <td className="py-1 pr-3 text-gray-600">{m}-р сар</td>
                        {d.by_location.map((s) => <td key={s.key} className="py-1 pr-3 text-right tabular-nums">{full(s.series[i], P.mt)}</td>)}
                        <td className="py-1 text-right font-semibold tabular-nums">{full(d.total_series[i], P.mt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <StackedColumns months={d.months} series={d.by_location} metric={P.mt} />
            )}
          </div>

          {/* Өсөлт / бууралт */}
          {d.dim !== "location" && (d.movers.up.length > 0 || d.movers.down.length > 0) && d.trend_basis && (
            <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
              <div className="text-[14px] font-bold text-gray-900">Хамгийн их өссөн, буурсан — {DIM_LABEL[d.dim].toLowerCase()}</div>
              <div className="mb-2 text-[11.5px] text-gray-500">
                {monthsText(d.trend_basis.recent)}-р сарын дундаж {monthsText(d.trend_basis.base)}-р сарынхтай харьцуулахад · нийт борлуулалтын 0.1%-иас дээш · дарж задлана
              </div>
              <div className="mb-1.5 flex gap-4 text-[11.5px] text-gray-600">
                <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: C.up }} />Өссөн</span>
                <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: C.down }} />Буурсан</span>
              </div>
              <DivergingBars up={d.movers.up} down={d.movers.down} metric={P.mt} basis={d.trend_basis} onPick={(m) => drill(m.key, m.label)} />
            </div>
          )}

          {/* Эрэмбэ — хүснэгт (графикийн хүснэгтэн хувилбар) */}
          <div className="rounded-2xl border border-gray-100 bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2.5">
              <div className="flex rounded-lg bg-gray-100 p-0.5">
                {DIMS.map((dm) => (
                  <button key={dm} onClick={() => setP({ d: dm === "category" ? null : dm, s: null })}
                    className={`rounded-md px-2.5 py-1 text-[12px] font-semibold ${P.d === dm ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>{DIM_LABEL[dm]}</button>
                ))}
              </div>
              <div className="flex rounded-lg bg-gray-100 p-0.5">
                {([["total", "Нийтээр"], ["growth", "Өсөлтөөр"], ["decline", "Бууралтаар"]] as [Sort, string][]).map(([s, l]) => (
                  <button key={s} onClick={() => setP({ s: s === "total" ? null : s })}
                    className={`rounded-md px-2.5 py-1 text-[12px] font-semibold ${P.s === s ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>{l}</button>
                ))}
              </div>
              <span className="ml-auto text-[11.5px] text-gray-400">{nf.format(d.rows_total)} {DIM_LABEL[d.dim].toLowerCase()}{d.dim !== "location" ? " · мөр дээр дарж задлана" : ""}</span>
            </div>
            {d.rows.length === 0 ? (
              <div className="p-8 text-center text-[13px] text-gray-400">Сонгосон шүүлтэд борлуулалт алга.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-left text-[11px] text-gray-500">
                      <th className="w-8 px-3 py-2 text-right">#</th>
                      <th className="px-2 py-2">{DIM_LABEL[d.dim]}</th>
                      <th className="hidden px-2 py-2 sm:table-cell">{monthsText(d.months)}-р сар</th>
                      <th className="px-2 py-2 text-right">Нийт</th>
                      <th className="hidden px-2 py-2 text-right md:table-cell">Хувь</th>
                      <th className="hidden px-2 py-2 text-right md:table-cell">{lastM}-р сар</th>
                      <th className="hidden px-2 py-2 text-right lg:table-cell">Сарын өөрчлөлт</th>
                      <th className="px-3 py-2 text-right">{d.trend_basis ? `${monthsText(d.trend_basis.recent)} vs ${monthsText(d.trend_basis.base)}` : "Чиг"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r, i) => (
                      <tr key={r.key} onClick={() => drill(r.key, r.label)} tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter") drill(r.key, r.label); }}
                        className="cursor-pointer border-t border-gray-50 hover:bg-gray-50/80 focus:bg-gray-50 focus:outline-none">
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-400">{i + 1}</td>
                        <td className="max-w-[150px] px-2 py-1.5 sm:max-w-[260px]">
                          <div className="flex items-center gap-1.5">
                            {d.dim === "location" && <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: C.loc[r.key as Kind] }} />}
                            <span className="truncate font-medium text-gray-900">{r.label}</span>
                            {d.dim !== "location" && <ChevronRight size={12} className="shrink-0 text-gray-300" />}
                          </div>
                          {r.sub && <div className="truncate text-[10.5px] text-gray-400">{d.dim === "product" ? `${r.key} · ${r.sub}` : r.sub}</div>}
                        </td>
                        <td className="hidden px-2 py-1 sm:table-cell"><Sparkline values={r.series} /></td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums text-gray-900" title={full(r.total, P.mt)}>{compact(r.total)}</td>
                        <td className="hidden px-2 py-1.5 text-right tabular-nums text-gray-500 md:table-cell">{r.share == null ? "—" : `${nf1.format(r.share)}%`}</td>
                        <td className="hidden whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-gray-600 md:table-cell" title={full(r.last, P.mt)}>{compact(r.last)}</td>
                        <td className="hidden px-2 py-1.5 text-right lg:table-cell"><Delta v={r.mom} /></td>
                        <td className="px-3 py-1.5 text-right"><Delta v={r.trend} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.rows.length < d.rows_total && P.s === "total" && (
              <div className="border-t border-gray-100 p-2 text-center">
                <button onClick={() => setTop((t) => t + 50)} disabled={loading}
                  className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                  Цааш харах ({nf.format(d.rows.length)} / {nf.format(d.rows_total)})
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
