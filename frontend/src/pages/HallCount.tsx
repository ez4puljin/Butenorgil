import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ScanBarcode, Camera, Keyboard, Loader2, RefreshCw, Check, AlertCircle, X, Plus, Minus,
  Search, ClipboardCheck, Download, Smartphone, Trash2, ChevronDown, ChevronUp, History,
  Settings2, Upload, SkipForward, ScanLine, Lock, Users, FileSpreadsheet, RotateCcw, ListChecks,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import {
  getDeviceIdSync, ensureDeviceId, getDeviceLabel, setDeviceLabel, restoreDeviceLabel,
} from "../lib/deviceId";

/* ═══════════════════════════════════════════════════════════════════════════
   Заалны тооллого

   Утас (.apk): камер БАЙНГА ажиллана → баркод уншмагц тухайн барааны үлдэгдэл,
   өмнө нь тоолсон тоо харагдана → тоо оруулаад «Нэмэх». Олон хүн заалыг хувааж
   тоолдог тул тоо ХУРИМТЛАГДАНА (өөр төхөөрөмжийн тоон дээр нэмэгдэнэ).

   Компьютер: жагсаалт/шүүлт (таарсан, зөрүүтэй, 2+ төхөөрөмж…), батлах,
   зөрүүгээр Эрхэтийн орлого/зарлагын импорт Excel татах.

   Shell нь desktop/mobile хувилбарыг ЗЭРЭГ render хийдэг тул камер, poll-ийг
   зөвхөн ХАРАГДАЖ БАЙГАА хувилбар ажиллуулна (offsetParent шалгана).
   ═══════════════════════════════════════════════════════════════════════════ */

type Dev = { device_id: string; device_label: string; username: string; qty: number; scans: number };
type ItemStatus = "matched" | "diff" | "uncounted" | "not_in_list";
type Item = {
  id: number; code: string; name: string; balance_qty: number; unit_cost: number; in_list: boolean;
  counted_qty: number; scan_count: number; device_count: number; last_scanned_at: string | null;
  diff: number | null; diff_amount: number | null; status: ItemStatus; devices: Dev[];
};
type Scan = {
  id: number; item_id: number; code: string; qty: number; device_id: string; device_label: string;
  user_id: number; username: string; created_at: string;
};
type SessionInfo = {
  id: number; status: "open" | "confirmed"; created_at: string | null; created_by: string;
  source_filename: string; balance_uploaded_at: string | null; item_count: number;
  confirmed_at: string | null; confirmed_by: string; note: string; uncounted_as_zero: boolean;
  sum_counted_items: number; sum_diff_items: number; sum_surplus_amount: number; sum_shortage_amount: number;
};
type Counts = {
  total: number; in_list: number; counted: number; matched: number; diff: number;
  uncounted: number; multi_device: number; not_in_list: number;
};
type Summary = {
  counts: Counts; surplus_amount: number; shortage_amount: number;
  uncounted_balance_qty: number; uncounted_amount: number;
  scan_total: number; device_total: number; last_scan_at: string | null;
};
type SessDevice = { device_id: string; device_label: string; username: string; scans: number; items: number; last_at: string | null };
type Lookup = {
  query: string; found: boolean; item: Item | null; my_device_qty?: number;
  product: { code: string; name: string; barcode: string; warehouse_name: string; last_purchase_price: number } | null;
};
type Filter = "all" | "counted" | "matched" | "diff" | "uncounted" | "multi_device" | "not_in_list" | "mine";
type ErpCfg = { account: string; related_income: string; related_expense: string; location: string; date: string; note: string };
type ExportPreview = {
  income: { rows: number; pieces: number; amount: number; skipped_no_price: number; estimated_price_rows: number };
  expense: { rows: number; pieces: number; amount: number; no_price_rows: number; estimated_price_rows: number; uncounted_rows: number };
};

const FILTERS: { key: Filter; label: string; short: string; count?: keyof Counts }[] = [
  { key: "all",          label: "Бүгд",                short: "Бүгд",      count: "total" },
  { key: "counted",      label: "Тоолсон",             short: "Тоолсон",   count: "counted" },
  { key: "matched",      label: "Таарсан",             short: "Таарсан",   count: "matched" },
  { key: "diff",         label: "Зөрүүтэй",            short: "Зөрүү",     count: "diff" },
  { key: "uncounted",    label: "Тоолоогүй",           short: "Тоолоогүй", count: "uncounted" },
  { key: "multi_device", label: "2+ төхөөрөмж",        short: "2+ утас",   count: "multi_device" },
  { key: "not_in_list",  label: "Жагсаалтад байхгүй",  short: "Байхгүй",   count: "not_in_list" },
  { key: "mine",         label: "Энэ төхөөрөмж",       short: "Минийх" },
];

const NATIVE_FORMATS = ["ean_13", "ean_8", "code_128", "code_39", "code_93", "upc_a", "upc_e", "itf", "codabar"];
const REPEAT_MS = 1500;          // ижил баркодыг дахин уншихгүй хугацаа
const POLL_MS = 12000;
const PAGE = 300;
const ERP_LS_KEY = "hc_erp_cfg_v1";

function isEnter(e: { key: string; keyCode?: number; code?: string }) {
  return e.key === "Enter" || e.key === "Return" || e.keyCode === 13 || e.code === "Enter" || e.code === "NumpadEnter";
}
function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? r.toLocaleString("mn-MN") : r.toLocaleString("mn-MN", { maximumFractionDigits: 3 });
}
function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString("mn-MN") + "₮";
}
function signed(n: number | null | undefined): string {
  if (n == null) return "—";
  return (n > 0 ? "+" : "") + fmt(n);
}
function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "саяхан";
  if (s < 3600) return `${Math.floor(s / 60)} мин өмнө`;
  if (s < 86400) return `${Math.floor(s / 3600)} цаг өмнө`;
  return d.toLocaleString("mn-MN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function dt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("mn-MN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function devName(d: { device_label?: string; username?: string; device_id?: string }): string {
  return d.device_label || d.username || (d.device_id || "").slice(0, 6) || "?";
}
function errMsg(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x: any) => x?.msg || JSON.stringify(x)).join("; ");
  return e?.message || fallback;
}
function loadErp(): ErpCfg {
  const base: ErpCfg = { account: "150101", related_income: "", related_expense: "", location: "", date: today(), note: "" };
  try {
    const raw = localStorage.getItem(ERP_LS_KEY);
    if (raw) return { ...base, ...JSON.parse(raw), date: today() };
  } catch { /* ignore */ }
  return base;
}
async function downloadXlsx(url: string, params: Record<string, string>, fallback: string) {
  const r = await api.get(url, { params, responseType: "blob", timeout: 120000 });
  let name = fallback;
  const cd: string = r.headers?.["content-disposition"] || "";
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename=([^;]+)/i.exec(cd);
  if (m) { try { name = decodeURIComponent(m[1].replace(/"/g, "")); } catch { name = m[1]; } }
  const blobUrl = URL.createObjectURL(new Blob([r.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = blobUrl; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
}

/* Shell-ийн нуугдсан хувилбар (display:none) эсэхийг мэдэх */
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

const STATUS_STYLE: Record<ItemStatus, { label: string; cls: string }> = {
  matched:     { label: "Таарсан",              cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  diff:        { label: "Зөрүүтэй",             cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  uncounted:   { label: "Тоолоогүй",            cls: "bg-gray-100 text-gray-500 ring-gray-200" },
  not_in_list: { label: "Жагсаалтад байхгүй",   cls: "bg-amber-50 text-amber-700 ring-amber-200" },
};

export default function HallCountPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = useVisible(rootRef);
  const { username, nickname, userId } = useAuthStore();
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 1024);
  useEffect(() => {
    const on = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // ── Session ──
  const [sess, setSess] = useState<SessionInfo | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [devices, setDevices] = useState<SessDevice[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [balanceFile, setBalanceFile] = useState<{ filename: string; uploaded_at: string | null } | null>(null);
  const [sessLoaded, setSessLoaded] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((kind: "ok" | "err", msg: string, ms = 3500) => {
    setToast({ kind, msg });
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(null), ms);
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const r = await api.get("/hall-count/session");
      setSess(r.data?.session ?? null);
      setSummary(r.data?.summary ?? null);
      setDevices(r.data?.devices ?? []);
      setCanManage(!!r.data?.can_manage);
      setBalanceFile(r.data?.balance_file ?? null);
    } catch (e: any) {
      flash("err", errMsg(e, "Тооллогын мэдээлэл татаж чадсангүй"));
    } finally { setSessLoaded(true); }
  }, [flash]);

  useEffect(() => {
    if (!visible) return;
    loadSession();
    const t = setInterval(loadSession, POLL_MS);
    return () => clearInterval(t);
  }, [visible, loadSession]);

  // ── Төхөөрөмж ──
  const [deviceId, setDeviceId] = useState(getDeviceIdSync());
  const [deviceLabel, setDeviceLabelState] = useState(getDeviceLabel());
  const [editLabel, setEditLabel] = useState(false);
  useEffect(() => {
    ensureDeviceId().then(setDeviceId).catch(() => {});
    restoreDeviceLabel().then((v) => { if (v) setDeviceLabelState(v); }).catch(() => {});
  }, []);
  const myName = nickname || username || "";
  const effectiveLabel = deviceLabel || myName;

  // ── Mobile tab ──
  const [tab, setTab] = useState<"scan" | "list">("scan");

  /* ═══════════════ Скáн ═══════════════ */
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const qrRef = useRef<any>(null);
  const camIdRef = useRef(`hc-cam-${Math.random().toString(36).slice(2, 8)}`);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const bufRef = useRef<{ s: string; at: number }>({ s: "", at: 0 });
  const pendingRef = useRef<Lookup | null>(null);
  // Камерын уншилтыг ЗОГСООХ уу: бараа сонгогдсон ч тоо нь ороогүй үед л зогсооно.
  // Нэмсний дараа шууд дараагийн баркодыг уншина (карт үлдэж, дахин нэмж ч болно).
  const pausedRef = useRef(false);
  const qtyRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const [camOn, setCamOn] = useState(false);
  const [camErr, setCamErr] = useState("");
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState("");
  const [manual, setManual] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Lookup | null>(null);
  const [qty, setQty] = useState("");
  const [adding, setAdding] = useState(false);
  const [lastAdd, setLastAdd] = useState<{ code: string; qty: number; total: number } | null>(null);
  const [recent, setRecent] = useState<{ scan: Scan; item: Item }[]>([]);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { pausedRef.current = !!pending?.found && !lastAdd; }, [pending, lastAdd]);

  const lookup = useCallback(async (raw: string, force = false) => {
    const c = (raw || "").trim();
    if (!c) return;
    const now = Date.now();
    if (!force && c === lastRef.current.code && now - lastRef.current.at < REPEAT_MS) return;
    // Картан дээр байгаа бараа камерт хэвээр харагдаж байвал дахин ачаалахгүй
    // (нэмсний дараах «+N нэмэгдлээ» мэдээлэл алга болохгүй; дахин нэмж болно).
    const cur = pendingRef.current;
    if (!force && cur?.found && (cur.query === c || cur.item?.code === c || cur.product?.code === c)) {
      lastRef.current = { code: c, at: now };
      return;
    }
    lastRef.current = { code: c, at: now };
    try { navigator.vibrate?.(50); } catch { /* ignore */ }
    setBusy(true);
    try {
      const r = await api.get("/hall-count/lookup", { params: { q: c, device_id: deviceId }, timeout: 20000 });
      setPending(r.data);
      setQty("");
      setLastAdd(null);
      if (r.data?.found) setTimeout(() => {
        qtyRef.current?.focus();
        cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 50);
    } catch (e: any) {
      if (e?.response?.status === 409) {
        flash("err", errMsg(e, "Нээлттэй тооллого алга"));
        setPending(null);
      } else {
        setPending({ query: c, found: false, item: null, product: null });
      }
    } finally { setBusy(false); }
  }, [deviceId, flash]);

  const clearPending = useCallback(() => {
    setPending(null); setQty(""); setLastAdd(null);
    lastRef.current = { code: "", at: 0 };
  }, []);

  const addScan = useCallback(async (q?: number) => {
    const p = pendingRef.current;
    if (!p || !p.found) return;
    const code = p.item?.code || p.product?.code || p.query;
    const typed = (qty || "").trim();
    if (q == null && /^\d{8,}$/.test(typed)) {
      // USB скáннер тооны талбарт баркод бичсэн — тоо биш, шинэ бараа гэж үзнэ
      setQty("");
      lookup(typed, true);
      return;
    }
    const n = q != null ? q : parseFloat(typed.replace(",", "."));
    if (!Number.isFinite(n) || n === 0) { flash("err", "Тоо оруулна уу"); qtyRef.current?.focus(); return; }
    setAdding(true);
    try {
      const r = await api.post("/hall-count/scan", { code, qty: n, device_id: deviceId, device_label: effectiveLabel });
      const item: Item = r.data.item;
      setPending((prev) => (prev ? { ...prev, item, my_device_qty: r.data.my_device_qty } : prev));
      setLastAdd({ code: item.code, qty: n, total: item.counted_qty });
      setRecent((prev) => [{ scan: r.data.scan, item }, ...prev].slice(0, 30));
      setQty("");
      try { navigator.vibrate?.([30, 40, 30]); } catch { /* ignore */ }
      loadSession();
    } catch (e: any) {
      flash("err", errMsg(e, "Нэмэхэд алдаа гарлаа"));
    } finally { setAdding(false); }
  }, [qty, deviceId, effectiveLabel, flash, loadSession, lookup]);

  // ── Камер ──
  const stopCam = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (qrRef.current) {
      try { qrRef.current.stop(); } catch { /* аль хэдийн зогссон */ }
      try { qrRef.current.clear(); } catch { /* ignore */ }
      qrRef.current = null;
    }
    setCamOn(false); setMode("");
  }, []);

  const detectLoop = useCallback(async () => {
    if (videoRef.current && detectorRef.current) {
      // Бараа сонгогдсон (тоо хүлээж байгаа) үед уншихгүй — өөр баркод санамсаргүй
      // орж ирээд тоог буруу бараанд нэмэхээс сэргийлнэ.
      if (!pausedRef.current) {
        try {
          const codes = await detectorRef.current.detect(videoRef.current);
          const raw = codes?.[0]?.rawValue || codes?.[0]?.value;
          if (raw) lookup(raw);
        } catch { /* нэг кадр уншигдаагүй */ }
      }
    }
    rafRef.current = requestAnimationFrame(detectLoop);
  }, [lookup]);

  const startCam = useCallback(async () => {
    setCamErr(""); setStarting(true);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Камерын API байхгүй байна.");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      streamRef.current = stream;
      if ("BarcodeDetector" in window) {
        const D = (window as any).BarcodeDetector;
        const sup = await D.getSupportedFormats().catch(() => NATIVE_FORMATS);
        const fmts = NATIVE_FORMATS.filter((f) => sup.includes(f));
        detectorRef.current = new D({ formats: fmts.length ? fmts : NATIVE_FORMATS });
        const v = videoRef.current!;
        v.srcObject = stream;
        v.setAttribute("playsinline", "true");
        await v.play().catch(() => {});
        setMode("native"); setStarting(false); setCamOn(true);
        rafRef.current = requestAnimationFrame(detectLoop);
        return;
      }
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const { Html5Qrcode } = await import("html5-qrcode");
      const devs = await Html5Qrcode.getCameras();
      if (!devs?.length) throw new Error("Камер олдсонгүй");
      const back = devs.find((d: any) => /back|rear|environment/i.test(d.label || ""));
      const qr = new Html5Qrcode(camIdRef.current, false);
      qrRef.current = qr;
      await qr.start((back || devs[0]).id,
        { fps: 10, qrbox: { width: 280, height: 180 }, aspectRatio: 1.4 },
        (decoded: string) => { if (!pausedRef.current) lookup(decoded); }, () => {});
      setMode("html5"); setStarting(false); setCamOn(true);
    } catch (e: any) {
      const n = e?.name || "";
      setCamErr(
        n === "NotAllowedError" ? "Камер зөвшөөрөгдөөгүй — Тохиргоо → Апп → Bto → Permissions → Камер."
        : n === "NotFoundError" ? "Камер олдсонгүй."
        : n === "NotReadableError" ? "Камерыг өөр програм ашиглаж байна."
        : (e?.message || "Камер нээгдсэнгүй"));
      setStarting(false); stopCam();
    }
  }, [detectLoop, lookup, stopCam]);

  // Утсан дээр (харагдаж байгаа хувилбар, скáн таб) камер автоматаар асна
  useEffect(() => {
    if (!visible || !isMobile || tab !== "scan" || !sess) { return; }
    const t = setTimeout(startCam, 150);
    return () => { clearTimeout(t); stopCam(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, isMobile, tab, !!sess]);
  useEffect(() => () => stopCam(), [stopCam]);

  // USB/Bluetooth скáннер — гар шиг бичээд Enter дардаг
  useEffect(() => {
    if (!visible) return;
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
  }, [visible, lookup]);

  /* ═══════════════ Жагсаалт ═══════════════ */
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  useEffect(() => { const t = setTimeout(() => setQDeb(q), 300); return () => clearTimeout(t); }, [q]);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [scans, setScans] = useState<Record<number, Scan[]>>({});
  const listReq = useRef(0);

  const sessId = sess?.id ?? null;
  const loadItems = useCallback(async (offset = 0, append = false) => {
    if (!sessId) { setItems([]); setTotal(0); return; }
    const id = ++listReq.current;
    setListLoading(true);
    try {
      const r = await api.get("/hall-count/items", {
        params: { filter, q: qDeb, device_id: deviceId, limit: PAGE, offset },
      });
      if (id !== listReq.current) return;
      setTotal(r.data.total);
      setItems((prev) => (append ? [...prev, ...r.data.items] : r.data.items));
    } catch (e: any) {
      if (e?.response?.status !== 409) flash("err", errMsg(e, "Жагсаалт татаж чадсангүй"));
    } finally { if (id === listReq.current) setListLoading(false); }
  }, [sessId, filter, qDeb, deviceId, flash]);

  const listActive = visible && (!isMobile || tab === "list");
  useEffect(() => {
    if (!listActive) return;
    loadItems(0);
    const t = setInterval(() => loadItems(0), POLL_MS);
    return () => clearInterval(t);
  }, [listActive, loadItems]);

  const openScans = async (it: Item) => {
    if (expanded === it.id) { setExpanded(null); return; }
    setExpanded(it.id);
    try {
      const r = await api.get(`/hall-count/items/${it.id}/scans`);
      setScans((p) => ({ ...p, [it.id]: r.data.scans }));
    } catch (e: any) { flash("err", errMsg(e, "Уншилтын түүх татагдсангүй")); }
  };
  const deleteScan = async (s: Scan) => {
    if (!confirm(`${s.code} — ${signed(s.qty)} (${devName(s)}) уншилтыг устгах уу?`)) return;
    try {
      const r = await api.delete(`/hall-count/scans/${s.id}`);
      setScans((p) => ({ ...p, [s.item_id]: (p[s.item_id] || []).filter((x) => x.id !== s.id) }));
      const it: Item | null = r.data.item;
      setItems((prev) => (it ? prev.map((x) => (x.id === it.id ? { ...it, devices: it.devices } : x)) : prev.filter((x) => x.id !== s.item_id)));
      setRecent((prev) => prev.filter((x) => x.scan.id !== s.id));
      if (pendingRef.current?.item?.id === s.item_id) {
        setPending((p) => (p ? { ...p, item: it } : p));
      }
      flash("ok", "Уншилт устгагдлаа");
      loadSession();
    } catch (e: any) { flash("err", errMsg(e, "Устгаж чадсангүй")); }
  };

  /* ═══════════════ Удирдлага ═══════════════ */
  const [showConfirm, setShowConfirm] = useState(false);
  const [uncountedZero, setUncountedZero] = useState(true);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState<SessionInfo[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [previews, setPreviews] = useState<Record<number, ExportPreview>>({});
  const [erp, setErp] = useState<ErpCfg>(loadErp);
  const [showErp, setShowErp] = useState(false);
  const [dl, setDl] = useState("");
  useEffect(() => { try { localStorage.setItem(ERP_LS_KEY, JSON.stringify(erp)); } catch { /* ignore */ } }, [erp]);

  const loadHistory = useCallback(async () => {
    try { const r = await api.get("/hall-count/sessions"); setHistory(r.data || []); } catch { /* ignore */ }
  }, []);
  useEffect(() => { if (visible && canManage) loadHistory(); }, [visible, canManage, loadHistory]);

  const loadPreview = async (sid: number) => {
    try {
      const r = await api.get(`/hall-count/sessions/${sid}/export-preview`);
      setPreviews((p) => ({ ...p, [sid]: r.data.preview }));
    } catch (e: any) { flash("err", errMsg(e, "Урьдчилсан дүн татагдсангүй")); }
  };

  const startSession = async () => {
    try {
      const r = await api.post("/hall-count/session/start");
      flash("ok", `Тооллого эхэллээ — ${r.data.session.item_count} бараа`);
      await loadSession();
    } catch (e: any) { flash("err", errMsg(e, "Эхлүүлж чадсангүй"), 6000); }
  };
  const resetSession = async () => {
    if (!confirm("Бүх уншилтыг устгаж 0-ээс эхлүүлэх үү? Үлдэгдэл хэвээр үлдэнэ.")) return;
    try {
      const r = await api.post("/hall-count/session/reset");
      flash("ok", `${r.data.scans_removed} уншилт устгагдлаа`);
      setRecent([]); clearPending();
      await loadSession(); loadItems(0);
    } catch (e: any) { flash("err", errMsg(e, "Алдаа")); }
  };
  const discardSession = async () => {
    if (!confirm("Нээлттэй тооллогыг БҮРМӨСӨН устгах уу? (үлдэгдэл, уншилт бүгд устна)")) return;
    try {
      await api.delete("/hall-count/session");
      flash("ok", "Тооллого устгагдлаа"); setRecent([]); clearPending();
      await loadSession();
    } catch (e: any) { flash("err", errMsg(e, "Алдаа")); }
  };
  const confirmSession = async () => {
    setConfirming(true);
    try {
      const r = await api.post("/hall-count/session/confirm", { uncounted_as_zero: uncountedZero, note });
      const s: SessionInfo = r.data.session;
      setPreviews((p) => ({ ...p, [s.id]: r.data.export_preview }));
      setShowConfirm(false);
      flash("ok", `Тооллого #${s.id} батлагдлаа — доороос орлого/зарлагын файл татна уу`, 6000);
      setShowHistory(true);
      await loadSession(); await loadHistory();
    } catch (e: any) { flash("err", errMsg(e, "Батлахад алдаа"), 6000); }
    finally { setConfirming(false); }
  };
  const reopen = async (sid: number) => {
    if (!confirm(`#${sid} тооллогыг буцааж нээх үү? (Аль хэдийн Эрхэт рүү импортолсон бол давхар бүртгэл үүсэх эрсдэлтэй)`)) return;
    try { await api.post(`/hall-count/sessions/${sid}/reopen`); flash("ok", "Нээгдлээ"); await loadSession(); await loadHistory(); }
    catch (e: any) { flash("err", errMsg(e, "Алдаа")); }
  };
  const exportFile = async (sid: number, kind: "income" | "expense" | "report") => {
    const key = `${sid}-${kind}`;
    setDl(key);
    try {
      const params: Record<string, string> = { kind };
      if (kind !== "report") {
        if (!erp.location.trim()) { setShowErp(true); flash("err", "Эрхэтийн тохиргоонд «Барааны байршил» (заалны код) оруулна уу"); return; }
        params.date = erp.date; params.account = erp.account; params.location = erp.location;
        params.related_account = kind === "income" ? erp.related_income : erp.related_expense;
        params.note = erp.note;
      }
      await downloadXlsx(`/hall-count/sessions/${sid}/export`, params, `hall_count_${sid}_${kind}.xlsx`);
    } catch (e: any) {
      // blob алдааны detail JSON дотор
      let msg = "Татахад алдаа";
      try {
        const txt = await (e?.response?.data as Blob)?.text?.();
        if (txt) msg = JSON.parse(txt)?.detail || msg;
      } catch { msg = errMsg(e, msg); }
      flash("err", msg, 7000);
    } finally { setDl(""); }
  };

  /* ═══════════════ Render helpers ═══════════════ */
  const c = summary?.counts;
  const pct = c && c.in_list > 0 ? Math.round((c.counted / c.in_list) * 100) : 0;
  const pItem = pending?.item ?? null;
  const pProd = pending?.product ?? null;

  const renderDevBadges = (devs: Dev[], big?: boolean) => (
    <div className="flex flex-wrap gap-1">
      {devs.map((d) => (
        <span key={d.device_id}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ${
            d.device_id === deviceId ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-gray-50 text-gray-600 ring-gray-200"
          } ${big ? "text-[12px]" : "text-[10.5px]"}`}>
          <Smartphone size={big ? 12 : 10} />{devName(d)}: <b>{fmt(d.qty)}</b>
        </span>
      ))}
    </div>
  );

  const ScanPanel = (
    <div className="flex flex-col gap-3">
      {/* Камер — бараа сонгогдсон үед (утсан дээр) нам болгож тооны картыг дэлгэцэнд багтаана */}
      <div className={`relative w-full overflow-hidden rounded-2xl bg-black transition-all duration-300 ${
        pending?.found && isMobile ? "h-24" : "aspect-[4/3]"}`}>
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay />
        <div id={camIdRef.current} className="absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover" />
        {!camOn && !starting && !camErr && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-900 text-white">
            <Camera size={28} className="text-emerald-400" />
            <button onClick={startCam} className="rounded-xl bg-emerald-600 px-4 py-2 text-[13px] font-semibold hover:bg-emerald-700">
              Камер асаах
            </button>
            <span className="text-[11px] text-white/60">эсвэл USB скáннер / гараар оруулах</span>
          </div>
        )}
        {starting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white">
            <Loader2 size={24} className="animate-spin" /><span className="text-[12px]">Камер нээгдэж байна…</span>
          </div>
        )}
        {camErr && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-5 text-center">
            <Camera size={26} className="text-rose-400" />
            <p className="text-[13px] font-semibold text-gray-800">Камер нээгдсэнгүй</p>
            <p className="max-w-xs text-[11.5px] leading-relaxed text-gray-600">{camErr}</p>
            <div className="flex gap-2">
              <button onClick={startCam} className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white"><RefreshCw size={12} />Дахин</button>
              <button onClick={() => setShowManual(true)} className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-1.5 text-[12px] text-gray-700"><Keyboard size={12} />Гараар</button>
            </div>
          </div>
        )}
        {camOn && (
          <>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className={`h-36 w-64 max-w-[80%] rounded-2xl border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] ${
                pending?.found && !lastAdd ? "border-amber-400" : "border-emerald-400"}`} />
            </div>
            <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1.5 text-[11px] text-white/85">
              {pending?.found && !lastAdd ? <><Lock size={11} />Тоо оруулсны дараа дараагийнхыг уншина</> : <><ScanLine size={12} />Баркодыг рамкан дотор барина</>}
              {mode && <span className="text-white/30">· {mode}</span>}
            </div>
            <button onClick={stopCam} title="Камер унтраах"
              className="absolute right-2 top-2 rounded-full bg-black/50 p-1.5 text-white/80 hover:bg-black/70"><X size={14} /></button>
          </>
        )}
        {busy && <div className="absolute left-2 top-2 rounded-full bg-white/90 p-1.5"><Loader2 size={14} className="animate-spin text-emerald-600" /></div>}
      </div>

      {/* Гараар */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Keyboard size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={manual} onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => { if (isEnter(e)) { lookup(manual, true); setManual(""); } }}
            inputMode="search" placeholder="Баркод эсвэл код…"
            className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-8 pr-3 text-[13px] outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" />
        </div>
        <button onClick={() => { lookup(manual, true); setManual(""); }} disabled={!manual.trim()}
          className="rounded-xl bg-gray-900 px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40">Хайх</button>
      </div>

      {/* Сонгосон бараа */}
      {pending && !pending.found && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-center">
          <p className="text-[14px] font-bold text-gray-800">Бараа олдсонгүй</p>
          <p className="mt-0.5 font-mono text-[12px] text-gray-500">{pending.query}</p>
          <p className="mt-1 text-[11px] text-gray-500">Баркод бүртгэлгүй байж болно — барааны кодыг гараар оруулна уу.</p>
          <button onClick={clearPending} className="mt-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12px]">Хаах</button>
        </div>
      )}
      {pending?.found && (
        <div ref={cardRef} className={`rounded-2xl border p-4 ${pItem && !pItem.in_list ? "border-amber-200 bg-amber-50/40" : "border-emerald-200 bg-emerald-50/40"}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] font-bold leading-snug text-gray-900">{pItem?.name || pProd?.name || "—"}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-gray-500">
                <span className="rounded-full bg-white px-2 py-0.5 font-mono font-semibold text-gray-700 shadow-sm">{pItem?.code || pProd?.code}</span>
                {pItem && !pItem.in_list && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">Жагсаалтад байхгүй</span>}
                {!pItem && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">Жагсаалтад байхгүй — нэмвэл үлдэгдэл 0</span>}
              </div>
            </div>
            <button onClick={clearPending} title="Дараагийн бараа" className="shrink-0 rounded-lg border border-gray-200 bg-white p-2 text-gray-500 hover:bg-gray-50">
              <SkipForward size={15} />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-white p-2 shadow-sm">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Үлдэгдэл</div>
              <div className="text-[22px] font-black text-gray-800">{fmt(pItem?.balance_qty ?? 0)}</div>
            </div>
            <div className="rounded-xl bg-white p-2 shadow-sm">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Тоолсон</div>
              <div className="text-[22px] font-black text-emerald-700">{fmt(pItem?.counted_qty ?? 0)}</div>
              <div className="text-[10px] text-gray-400">энэ утас {fmt(pending.my_device_qty ?? 0)}</div>
            </div>
            <div className="rounded-xl bg-white p-2 shadow-sm">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Зөрүү</div>
              {(() => { const d = (pItem?.counted_qty ?? 0) - (pItem?.balance_qty ?? 0); const nc = !pItem || pItem.scan_count === 0;
                return <div className={`text-[22px] font-black ${nc ? "text-gray-300" : Math.abs(d) < 1e-6 ? "text-emerald-600" : d > 0 ? "text-amber-600" : "text-rose-600"}`}>{nc ? "—" : signed(d)}</div>; })()}
            </div>
          </div>
          {pItem && pItem.devices.length > 0 && <div className="mt-2">{renderDevBadges(pItem.devices)}</div>}

          {lastAdd && (
            <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12.5px] font-semibold text-white">
              <Check size={14} /> {signed(lastAdd.qty)} нэмэгдлээ · нийт {fmt(lastAdd.total)}
            </div>
          )}

          {/* Тоо оруулах */}
          <div className="mt-3 flex items-stretch gap-2">
            <button onClick={() => setQty((v) => String(Math.max(0, (parseFloat(v) || 0) - 1)))}
              className="grid w-12 place-items-center rounded-xl border border-gray-200 bg-white text-gray-600 active:bg-gray-100"><Minus size={18} /></button>
            <input ref={qtyRef} value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.,-]/g, ""))}
              onKeyDown={(e) => { if (isEnter(e)) { e.preventDefault(); addScan(); } }}
              inputMode="decimal" placeholder="Тоо"
              className="min-w-0 flex-1 rounded-xl border-2 border-emerald-300 bg-white px-3 text-center text-[26px] font-black text-gray-900 outline-none focus:border-emerald-500" />
            <button onClick={() => setQty((v) => String((parseFloat(v) || 0) + 1))}
              className="grid w-12 place-items-center rounded-xl border border-gray-200 bg-white text-gray-600 active:bg-gray-100"><Plus size={18} /></button>
          </div>
          <div className="mt-2 flex gap-2">
            <button onClick={() => addScan(1)} disabled={adding}
              className="rounded-xl border border-emerald-300 bg-white px-3 py-3 text-[13px] font-bold text-emerald-700 active:bg-emerald-50 disabled:opacity-50">+1</button>
            <button onClick={() => addScan()} disabled={adding || !qty}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-[15px] font-bold text-white shadow-sm active:bg-emerald-700 disabled:opacity-40">
              {adding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Нэмэх
            </button>
          </div>
          <p className="mt-1.5 text-center text-[10.5px] text-gray-400">Өөр хүний тоолсон дээр НЭМЭГДЭНЭ. Буруу оруулсан бол сөрөг тоо (жишээ −3) оруулж засна.</p>
        </div>
      )}

      {/* Энэ төхөөрөмжийн сүүлийн уншилтууд */}
      {recent.length > 0 && (
        <div className="rounded-2xl border border-gray-100 bg-white">
          <div className="flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            <span>Сүүлийн уншилтууд</span><span>{recent.length}</span>
          </div>
          <div className="max-h-56 overflow-auto">
            {recent.map(({ scan, item }) => (
              <div key={scan.id} className="flex items-center gap-2 border-t border-gray-50 px-3 py-1.5 text-[12px]">
                <span className="font-mono text-gray-400">{scan.code}</span>
                <span className="min-w-0 flex-1 truncate text-gray-700">{item.name}</span>
                <span className={`font-bold ${scan.qty > 0 ? "text-emerald-700" : "text-rose-600"}`}>{signed(scan.qty)}</span>
                <button onClick={() => deleteScan(scan)} className="p-1 text-gray-300 hover:text-rose-500" title="Устгах"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const FilterBar = (
    <div className="flex flex-col gap-2">
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {FILTERS.map((f) => {
          const n = f.count && c ? c[f.count] : undefined;
          const on = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold ring-1 transition ${
                on ? "bg-gray-900 text-white ring-gray-900" : "bg-white text-gray-600 ring-gray-200 hover:bg-gray-50"}`}>
              {isMobile ? f.short : f.label}
              {n != null && <span className={`rounded-full px-1.5 text-[10px] ${on ? "bg-white/20" : "bg-gray-100 text-gray-500"}`}>{n}</span>}
            </button>
          );
        })}
      </div>
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Код эсвэл нэрээр хайх…"
          className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-8 pr-8 text-[13px] outline-none focus:border-gray-400" />
        {q && <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400"><X size={13} /></button>}
      </div>
    </div>
  );

  const renderScanHistory = (it: Item) => {
    const list = scans[it.id];
    return (
      <div className="rounded-xl bg-gray-50 p-3">
        {it.devices.length > 0 && <div className="mb-2">{renderDevBadges(it.devices, true)}</div>}
        {!list ? <div className="text-[11px] text-gray-400"><Loader2 size={12} className="mr-1 inline animate-spin" />Уншилтын түүх…</div>
        : list.length === 0 ? <div className="text-[11px] text-gray-400">Уншилт алга</div>
        : (
          <table className="w-full text-[11.5px]">
            <tbody>
              {list.map((s) => {
                const own = s.user_id === userId;
                return (
                  <tr key={s.id} className="border-t border-gray-100">
                    <td className="py-1 pr-2 text-gray-500">{dt(s.created_at)}</td>
                    <td className="py-1 pr-2"><span className="inline-flex items-center gap-1 text-gray-700"><Smartphone size={10} />{devName(s)}</span></td>
                    <td className="py-1 pr-2 text-gray-500">{s.username}</td>
                    <td className={`py-1 pr-2 text-right font-bold ${s.qty > 0 ? "text-emerald-700" : "text-rose-600"}`}>{signed(s.qty)}</td>
                    <td className="py-1 text-right">
                      {(canManage || own) && sess?.status === "open" && (
                        <button onClick={() => deleteScan(s)} className="p-1 text-gray-300 hover:text-rose-500" title="Устгах"><Trash2 size={12} /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  const ListPanel = (
    <div className="flex flex-col gap-3">
      {FilterBar}
      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span>{total} мөр{listLoading && <Loader2 size={11} className="ml-1 inline animate-spin" />}</span>
        <button onClick={() => loadItems(0)} className="inline-flex items-center gap-1 hover:text-gray-800"><RefreshCw size={11} />Сэргээх</button>
      </div>

      {/* Mobile cards */}
      <div className="flex flex-col gap-1.5 lg:hidden">
        {items.map((it) => {
          const st = STATUS_STYLE[it.status];
          return (
            <div key={it.id} className="rounded-xl border border-gray-100 bg-white">
              <button onClick={() => openScans(it)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-gray-800">{it.name}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-gray-400">
                    <span className="font-mono">{it.code}</span>
                    <span className={`rounded-full px-1.5 py-px font-semibold ring-1 ${st.cls}`}>{st.label}</span>
                    {it.device_count >= 2 && <span className="inline-flex items-center gap-0.5 text-blue-600"><Smartphone size={10} />{it.device_count}</span>}
                  </div>
                </div>
                <div className="grid shrink-0 grid-cols-3 gap-2 text-center text-[12px]">
                  <div><div className="text-[9px] text-gray-400">Үлд</div><div className="font-bold text-gray-700">{fmt(it.balance_qty)}</div></div>
                  <div><div className="text-[9px] text-gray-400">Тоол</div><div className="font-bold text-emerald-700">{it.scan_count > 0 ? fmt(it.counted_qty) : "—"}</div></div>
                  <div><div className="text-[9px] text-gray-400">Зөрүү</div>
                    <div className={`font-bold ${it.diff == null ? "text-gray-300" : Math.abs(it.diff) < 1e-6 ? "text-emerald-600" : it.diff > 0 ? "text-amber-600" : "text-rose-600"}`}>{it.diff == null ? "—" : signed(it.diff)}</div></div>
                </div>
                {expanded === it.id ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
              </button>
              {expanded === it.id && <div className="px-2 pb-2">{renderScanHistory(it)}</div>}
            </div>
          );
        })}
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-2xl border border-gray-100 bg-white lg:block">
        <table className="w-full min-w-[860px] text-[12.5px]">
          <thead className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">Код</th>
              <th className="px-3 py-2 text-left">Нэр</th>
              <th className="px-3 py-2 text-right">Үлдэгдэл</th>
              <th className="px-3 py-2 text-right">Тоолсон</th>
              <th className="px-3 py-2 text-right">Зөрүү</th>
              <th className="px-3 py-2 text-right">Дүн ₮</th>
              <th className="px-3 py-2 text-left">Төлөв</th>
              <th className="px-3 py-2 text-left">Хэн хэдийг</th>
              <th className="px-3 py-2 text-right">Сүүлд</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !listLoading && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400">Мөр алга</td></tr>
            )}
            {items.map((it) => {
              const st = STATUS_STYLE[it.status];
              const open = expanded === it.id;
              return (
                <Fragment key={it.id}>
                  <tr onClick={() => openScans(it)}
                    className={`cursor-pointer border-t border-gray-50 hover:bg-gray-50/60 ${open ? "bg-gray-50" : ""}`}>
                    <td className="px-3 py-1.5 font-mono text-gray-500">{it.code}</td>
                    <td className="max-w-[360px] truncate px-3 py-1.5 font-medium text-gray-800">{it.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{fmt(it.balance_qty)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-emerald-700">{it.scan_count > 0 ? fmt(it.counted_qty) : <span className="text-gray-300">—</span>}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${it.diff == null ? "text-gray-300" : Math.abs(it.diff) < 1e-6 ? "text-emerald-600" : it.diff > 0 ? "text-amber-600" : "text-rose-600"}`}>{it.diff == null ? "—" : signed(it.diff)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{it.diff_amount == null || Math.abs(it.diff_amount) < 0.5 ? "" : money(it.diff_amount)}</td>
                    <td className="px-3 py-1.5"><span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 ${st.cls}`}>{st.label}</span></td>
                    <td className="px-3 py-1.5">{renderDevBadges(it.devices)}</td>
                    <td className="px-3 py-1.5 text-right text-[11px] text-gray-400">{ago(it.last_scanned_at)}</td>
                  </tr>
                  {open && <tr><td colSpan={9} className="px-3 pb-2">{renderScanHistory(it)}</td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {items.length < total && (
        <button onClick={() => loadItems(items.length, true)} disabled={listLoading}
          className="rounded-xl border border-gray-200 bg-white py-2 text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          Дараагийн {Math.min(PAGE, total - items.length)} мөр ({items.length}/{total})
        </button>
      )}
    </div>
  );

  const SummaryCards = summary && c && (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      {[
        { l: "Жагсаалт", v: fmt(c.in_list), sub: sess?.source_filename },
        { l: "Тоолсон", v: `${fmt(c.counted)}`, sub: `${pct}%`, cls: "text-emerald-700" },
        { l: "Таарсан", v: fmt(c.matched), cls: "text-emerald-700" },
        { l: "Зөрүүтэй", v: fmt(c.diff), cls: "text-rose-600" },
        { l: "Тоолоогүй", v: fmt(c.uncounted), cls: "text-gray-500" },
        { l: "2+ төхөөрөмж", v: fmt(c.multi_device), cls: "text-blue-600" },
        { l: "Илүүдэл", v: money(summary.surplus_amount), cls: "text-amber-600" },
        { l: "Дутагдал", v: money(summary.shortage_amount), cls: "text-rose-600" },
      ].map((k) => (
        <div key={k.l} className="rounded-xl border border-gray-100 bg-white px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{k.l}</div>
          <div className={`truncate text-[18px] font-black ${k.cls || "text-gray-800"}`}>{k.v}</div>
          {k.sub && <div className="truncate text-[10px] text-gray-400" title={k.sub}>{k.sub}</div>}
        </div>
      ))}
    </div>
  );

  const DevicesStrip = devices.length > 0 && (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <Users size={12} className="text-gray-400" />
      {devices.map((d) => (
        <span key={d.device_id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ${
          d.device_id === deviceId ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-white text-gray-600 ring-gray-200"}`}>
          <Smartphone size={10} />{devName(d)} · {d.items} бараа · {ago(d.last_at)}
        </span>
      ))}
    </div>
  );

  const ErpSettings = (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-gray-800"><Settings2 size={14} />Эрхэтийн импортын тохиргоо</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {([
          ["date", "Огноо", "YYYY-MM-DD"],
          ["account", "Данс", "150101"],
          ["location", "Барааны байршил (заалны код) *", "жишээ 02"],
          ["related_income", "Харьцсан данс — орлого (илүүдэл)", ""],
          ["related_expense", "Харьцсан данс — зарлага (дутагдал)", ""],
          ["note", "Гүйлгээний утга", "хоосон бол автоматаар"],
        ] as [keyof ErpCfg, string, string][]).map(([k, l, ph]) => (
          <label key={k} className="text-[11px] text-gray-500">
            {l}
            <input value={erp[k]} onChange={(e) => setErp((p) => ({ ...p, [k]: e.target.value }))} placeholder={ph}
              className="mt-0.5 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12.5px] text-gray-800 outline-none focus:border-gray-400" />
          </label>
        ))}
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-gray-400">
        Орлого = тоолсон &gt; үлдэгдэл, Зарлага = тоолсон &lt; үлдэгдэл. Нэгж үнэ нь үлдэгдлийн файлын нэгж өртөг (байхгүй бол сүүлийн авсан үнэ).
        Үнэгүй илүүдэл мөр орлогын файлд ОРОХГҮЙ (Тайлбар хуудсанд жагсаана). Файл бүрийг Эрхэт рүү нэг л удаа импортлоно.
      </p>
    </div>
  );

  const renderHistoryRow = (s: SessionInfo) => {
    const pv = previews[s.id];
    const busyK = (k: string) => dl === `${s.id}-${k}`;
    return (
      <div key={s.id} className="rounded-xl border border-gray-100 bg-white p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <span className="font-bold text-gray-800">#{s.id}</span>
          <span className="text-gray-600">{dt(s.confirmed_at)}</span>
          <span className="text-gray-400">{s.confirmed_by}</span>
          <span className="text-gray-500">тоолсон {s.sum_counted_items} · зөрүү {s.sum_diff_items}</span>
          <span className="text-amber-600">илүүдэл {money(s.sum_surplus_amount)}</span>
          <span className="text-rose-600">дутагдал {money(s.sum_shortage_amount)}</span>
          {!s.uncounted_as_zero && <span className="rounded-full bg-gray-100 px-2 text-[10px] text-gray-500">тоолоогүйг хассан</span>}
          {s.note && <span className="text-gray-400">«{s.note}»</span>}
        </div>
        {pv && (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-gray-500">
            <span>Орлого: <b>{pv.income.rows}</b> мөр · {fmt(pv.income.pieces)} ш · {money(pv.income.amount)}{pv.income.skipped_no_price > 0 && <span className="text-rose-500"> · {pv.income.skipped_no_price} мөр үнэгүй тул хасагдана</span>}</span>
            <span>Зарлага: <b>{pv.expense.rows}</b> мөр · {fmt(pv.expense.pieces)} ш · {money(pv.expense.amount)}{pv.expense.uncounted_rows > 0 && <span className="text-gray-400"> · {pv.expense.uncounted_rows} нь тоолоогүй</span>}</span>
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {!pv && <button onClick={() => loadPreview(s.id)} className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11.5px] text-gray-600 hover:bg-gray-50">Дүн харах</button>}
          <button onClick={() => exportFile(s.id, "income")} disabled={!!dl}
            className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1.5 text-[11.5px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
            {busyK("income") ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}Орлогын импорт
          </button>
          <button onClick={() => exportFile(s.id, "expense")} disabled={!!dl}
            className="inline-flex items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-1.5 text-[11.5px] font-semibold text-white hover:bg-rose-600 disabled:opacity-50">
            {busyK("expense") ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}Зарлагын импорт
          </button>
          <button onClick={() => exportFile(s.id, "report")} disabled={!!dl}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11.5px] text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {busyK("report") ? <Loader2 size={12} className="animate-spin" /> : <FileSpreadsheet size={12} />}Тайлан
          </button>
          {!sess && <button onClick={() => reopen(s.id)} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11.5px] text-gray-500 hover:bg-gray-50"><RotateCcw size={12} />Буцааж нээх</button>}
        </div>
      </div>
    );
  };

  /* ═══════════════ Layout ═══════════════ */
  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      {toast && (
        <div className={`fixed left-3 right-3 top-3 z-[70] flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg sm:left-auto sm:right-5 sm:max-w-md ${toast.kind === "err" ? "bg-red-600" : "bg-emerald-600"}`}>
          {toast.kind === "err" ? <AlertCircle size={15} /> : <Check size={15} />}
          <span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}

      {/* Толгой */}
      <div className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm"><ScanBarcode size={16} /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold leading-tight text-gray-900">Заалны тооллого</h1>
          <p className="truncate text-[11px] text-gray-500">
            {sess ? <>#{sess.id} · {sess.item_count} бараа · үлдэгдэл {dt(sess.balance_uploaded_at)}{summary?.last_scan_at && <> · сүүлийн уншилт {ago(summary.last_scan_at)}</>}</>
                  : "Нээлттэй тооллого алга"}
          </p>
        </div>
        <button onClick={() => setEditLabel((v) => !v)} title="Төхөөрөмжийн нэр"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-200 px-2 py-1.5 text-[11px] text-gray-600 hover:bg-gray-50">
          <Smartphone size={12} /><span className="max-w-[90px] truncate">{effectiveLabel || "Төхөөрөмж"}</span>
        </button>
      </div>
      {editLabel && (
        <div className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 shadow-sm">
          <span className="text-[12px] text-gray-500">Энэ төхөөрөмжийн нэр:</span>
          <input value={deviceLabel} onChange={(e) => setDeviceLabelState(e.target.value)} placeholder={myName || "жишээ Утас 1"}
            onKeyDown={(e) => { if (isEnter(e)) { setDeviceLabel(deviceLabel); setEditLabel(false); } }}
            className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] outline-none focus:border-emerald-400" />
          <button onClick={() => { setDeviceLabel(deviceLabel); setEditLabel(false); }} className="rounded-lg bg-gray-900 px-3 py-1.5 text-[12px] font-semibold text-white">Хадгалах</button>
          <span className="font-mono text-[10px] text-gray-300">{deviceId.slice(0, 6)}</span>
        </div>
      )}

      {/* Нээлттэй тооллого байхгүй */}
      {sessLoaded && !sess && (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center">
          <ClipboardCheck size={30} className="mx-auto text-gray-300" />
          <p className="mt-2 text-[14px] font-semibold text-gray-700">Нээлттэй тооллого алга</p>
          {canManage ? (
            <>
              <p className="mt-1 text-[12px] text-gray-500">
                {balanceFile ? <>Сүүлд оруулсан үлдэгдэл: <b>{balanceFile.filename}</b> ({dt(balanceFile.uploaded_at)})</>
                             : "Эхлээд «Заалны тоолох барааны үлдэгдэл» Excel оруулна уу."}
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Link to="/imports/balance-file" className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-emerald-700"><Upload size={13} />Үлдэгдэл оруулах</Link>
                {balanceFile && <button onClick={startSession} className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2 text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50"><RefreshCw size={13} />Сүүлийн файлаар эхлүүлэх</button>}
              </div>
            </>
          ) : <p className="mt-1 text-[12px] text-gray-500">Менежер үлдэгдлийн файл оруулсны дараа тооллого эхэлнэ.</p>}
        </div>
      )}

      {/* ScanPanel-ийг нэг instance дотор ГАНЦ удаа render хийнэ (refs, camera id
          давхцахгүй) — mobile/desktop блокийг isMobile-аар сонгоно. */}
      {sess && isMobile && (
        <>
          {/* Mobile: tab */}
          <div className="flex rounded-xl bg-white p-1 shadow-sm lg:hidden">
            {([["scan", "Скáн", ScanLine], ["list", "Жагсаалт", ListChecks]] as const).map(([k, l, I]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] font-semibold ${tab === k ? "bg-gray-900 text-white" : "text-gray-500"}`}>
                <I size={14} />{l}{k === "list" && c && <span className="text-[10px] opacity-70">{c.counted}/{c.in_list}</span>}
              </button>
            ))}
          </div>
          <div className="lg:hidden">
            {tab === "scan" ? ScanPanel : (
              <div className="flex flex-col gap-3">
                {SummaryCards}
                {DevicesStrip}
                {ListPanel}
              </div>
            )}
          </div>
        </>
      )}

      {sess && !isMobile && (
        <>
          {/* Desktop */}
          <div className="hidden flex-col gap-3 lg:flex">
            {SummaryCards}
            <div className="flex flex-wrap items-center gap-2">
              {DevicesStrip}
              <div className="ml-auto flex flex-wrap gap-1.5">
                {canManage && (
                  <>
                    <button onClick={() => exportFile(sess.id, "report")} disabled={!!dl}
                      className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      {dl === `${sess.id}-report` ? <Loader2 size={12} className="animate-spin" /> : <FileSpreadsheet size={12} />}Тайлан
                    </button>
                    <button onClick={resetSession} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50"><RotateCcw size={12} />Дахин эхлүүлэх</button>
                    <button onClick={discardSession} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-rose-600 hover:bg-rose-50"><Trash2 size={12} />Устгах</button>
                    <button onClick={() => { setUncountedZero(true); setNote(""); setShowConfirm(true); }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-[12.5px] font-bold text-white shadow-sm hover:bg-emerald-700"><Check size={13} />Тооллого батлах</button>
                  </>
                )}
              </div>
            </div>
            <div className="grid min-w-0 grid-cols-[340px_minmax(0,1fr)] gap-3 xl:grid-cols-[380px_minmax(0,1fr)]">
              <div className="rounded-2xl bg-white p-3 shadow-sm">{ScanPanel}</div>
              <div className="min-w-0">{ListPanel}</div>
            </div>
          </div>
        </>
      )}

      {/* Түүх / экспорт (менежер) */}
      {canManage && (history.length > 0 || sess) && (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <button onClick={() => setShowHistory((v) => !v)} className="flex w-full items-center gap-2 text-[13px] font-semibold text-gray-800">
            <History size={14} />Батлагдсан тооллогууд ({history.length}) — орлого/зарлагын импорт
            {showHistory ? <ChevronUp size={14} className="ml-auto text-gray-400" /> : <ChevronDown size={14} className="ml-auto text-gray-400" />}
          </button>
          {showHistory && (
            <div className="mt-3 flex flex-col gap-2">
              <button onClick={() => setShowErp((v) => !v)} className="self-start text-[11.5px] font-medium text-gray-500 hover:text-gray-800">
                <Settings2 size={11} className="mr-1 inline" />{showErp ? "Тохиргоо нуух" : "Эрхэтийн тохиргоо (данс, байршил)"}
              </button>
              {showErp && ErpSettings}
              {history.length === 0 && <p className="text-[12px] text-gray-400">Батлагдсан тооллого алга.</p>}
              {history.map(renderHistoryRow)}
            </div>
          )}
        </div>
      )}

      {/* Батлах modal */}
      {showConfirm && sess && summary && c && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => !confirming && setShowConfirm(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold text-gray-900">Тооллого #{sess.id} батлах</h3>
              <button onClick={() => setShowConfirm(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[12px]">
              <div className="rounded-xl bg-emerald-50 p-2"><div className="text-[10px] text-emerald-600">Таарсан</div><div className="text-[20px] font-black text-emerald-700">{c.matched}</div></div>
              <div className="rounded-xl bg-rose-50 p-2"><div className="text-[10px] text-rose-600">Зөрүүтэй</div><div className="text-[20px] font-black text-rose-700">{c.diff}</div></div>
              <div className="rounded-xl bg-gray-100 p-2"><div className="text-[10px] text-gray-500">Тоолоогүй</div><div className="text-[20px] font-black text-gray-700">{c.uncounted}</div></div>
            </div>
            <div className="mt-2 flex justify-between text-[12px] text-gray-600">
              <span>Илүүдэл <b className="text-amber-600">{money(summary.surplus_amount)}</b></span>
              <span>Дутагдал <b className="text-rose-600">{money(summary.shortage_amount)}</b></span>
            </div>
            {c.uncounted > 0 && (
              <label className={`mt-3 flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-[12px] ${uncountedZero ? "border-rose-200 bg-rose-50/60" : "border-gray-200"}`}>
                <input type="checkbox" checked={uncountedZero} onChange={(e) => setUncountedZero(e.target.checked)} className="mt-0.5" />
                <span>
                  <b>Тоолоогүй {c.uncounted} барааг 0 гэж тооцох</b> — үлдэгдэл {fmt(summary.uncounted_balance_qty)} ш ({money(summary.uncounted_amount)}) бүхэлдээ <b>дутагдал (зарлага)</b> болно.
                  <span className="mt-1 block text-gray-500">Заалны бүх барааг тоолсон бол сонгоно. Зарим хэсгийг тоолоогүй бол сонгохгүй — тоолоогүй бараа зөрүүнээс хасагдана.</span>
                </span>
              </label>
            )}
            {c.multi_device > 0 && (
              <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-[11.5px] text-blue-700">
                <Smartphone size={11} className="mr-1 inline" />{c.multi_device} барааг 2+ төхөөрөмжөөс тоолсон — нэг барааг хоёр хүн давхар тоолсон эсэхийг «2+ төхөөрөмж» шүүлтээр шалгаарай.
              </p>
            )}
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Тэмдэглэл (заавал биш)"
              className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-[12.5px] outline-none focus:border-gray-400" />
            <p className="mt-2 text-[11px] text-gray-400">Батласны дараа уншилт нэмэх боломжгүй. Дараа нь орлого/зарлагын импорт файл татна.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowConfirm(false)} className="rounded-lg border border-gray-200 px-4 py-2 text-[12.5px] text-gray-700">Болих</button>
              <button onClick={confirmSession} disabled={confirming}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-[12.5px] font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
                {confirming ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}Батлах
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
