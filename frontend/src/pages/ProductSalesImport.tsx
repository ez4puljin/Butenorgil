import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  ArrowLeft, UploadCloud, RefreshCw, Check, AlertCircle, Warehouse, Store, Trash2, Calendar,
} from "lucide-react";

import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";


type SlotInfo = {
  year: number;
  month: number;
  count: number;
  has_warehouse: boolean;
  has_showroom: boolean;
};

type Kind = "warehouse" | "showroom";

const MN_MONTHS = ["1-р сар","2-р сар","3-р сар","4-р сар","5-р сар","6-р сар","7-р сар","8-р сар","9-р сар","10-р сар","11-р сар","12-р сар"];


export default function ProductSalesImport() {
  const now = new Date();
  const [year,  setYear]  = useState<number>(now.getFullYear());
  const [month, setMonth] = useState<number>(now.getMonth() + 1);

  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error,  setError]  = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  const loadSlots = async () => {
    setLoadingSlots(true);
    try {
      const r = await api.get("/product-monthly-sales/slots");
      setSlots(r.data ?? []);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Slot жагсаалт татаж чадсангүй.");
    } finally {
      setLoadingSlots(false);
    }
  };

  useEffect(() => { loadSlots(); }, []);

  // Тухайн (year, month)-ийн slot
  const currentSlot = useMemo(
    () => slots.find(s => s.year === year && s.month === month),
    [slots, year, month],
  );

  const onUpload = async (kind: Kind, file: File) => {
    setBusy(kind);
    setError(""); setNotice("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("year",  String(year));
      fd.append("month", String(month));
      fd.append("kind",  kind);
      const r = await api.post("/product-monthly-sales/import", fd);
      const d = r.data ?? {};
      setNotice(
        `${kind === "warehouse" ? "Агуулах" : "Заал"}: ${d.rows_upserted ?? 0} бараа хадгалагдлаа` +
        (d.rows_skipped ? `, ${d.rows_skipped} мөр алгассан.` : ""),
      );
      await loadSlots();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Файл оруулахад алдаа гарлаа.");
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (slot: SlotInfo, kind: Kind) => {
    if (!confirm(
      `${slot.year}-${String(slot.month).padStart(2,"0")} ${kind === "warehouse" ? "Агуулах" : "Заал"}-ийн борлуулалт устгах уу?`,
    )) return;
    try {
      await api.delete(`/product-monthly-sales/${slot.year}/${slot.month}/${kind}`);
      setNotice("Амжилттай устгалаа.");
      await loadSlots();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Устгахад алдаа гарлаа.");
    }
  };

  const years = useMemo(() => {
    const ys = new Set<number>([now.getFullYear(), now.getFullYear() - 1, now.getFullYear() + 1]);
    slots.forEach(s => ys.add(s.year));
    return [...ys].sort((a, b) => b - a);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots]);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="px-4 py-3 sm:px-6 sm:py-4">

      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Link to="/imports"
          className="grid h-10 w-10 place-items-center rounded-apple bg-[#F5F5F7] hover:bg-gray-100">
          <ArrowLeft size={18} className="text-gray-700"/>
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">Сарын борлуулалт</h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">
            Агуулах + Заалны сар бүрийн борлуулалтыг оруулна. Захиалга бэлдэх үед сүүлийн борлуулалтын статистик харагдана.
          </p>
        </div>
      </div>

      {/* ── Year/Month picker ───────────────────────────────────────── */}
      <Card className="mt-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Он</label>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))}
              className="mt-1 rounded-apple border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800 outline-none hover:border-gray-300 focus:border-[#0071E3] focus:ring-2 focus:ring-blue-100">
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Сар</label>
            <select value={month} onChange={e => setMonth(parseInt(e.target.value))}
              className="mt-1 rounded-apple border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800 outline-none hover:border-gray-300 focus:border-[#0071E3] focus:ring-2 focus:ring-blue-100">
              {MN_MONTHS.map((label, i) => <option key={i+1} value={i+1}>{label}</option>)}
            </select>
          </div>
          <div className="ml-auto flex items-center gap-2 text-[12px] text-gray-500">
            <Calendar size={14}/>
            <span>{year}-{String(month).padStart(2, "0")}</span>
            {currentSlot && (
              <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                {currentSlot.count} бараа бүртгэлтэй
              </span>
            )}
          </div>
        </div>

        {/* Notifications */}
        {(error || notice) && (
          <div className={`mt-3 flex items-center gap-2 rounded-apple border px-3 py-2 text-[12.5px] ${
            error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}>
            {error ? <AlertCircle size={14}/> : <Check size={14}/>}
            <span className="flex-1">{error || notice}</span>
            <button onClick={() => { setError(""); setNotice(""); }}
              className="text-[11px] underline hover:no-underline">хаах</button>
          </div>
        )}

        {/* Upload widgets — 2 талын файл */}
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          <UploadTile
            kind="warehouse"
            icon={<Warehouse size={18}/>}
            title="Агуулахын борлуулалт"
            color="blue"
            uploaded={!!currentSlot?.has_warehouse}
            busy={busy === "warehouse"}
            anyBusy={busy !== null}
            onPick={(f) => onUpload("warehouse", f)}
          />
          <UploadTile
            kind="showroom"
            icon={<Store size={18}/>}
            title="Заалны борлуулалт"
            color="violet"
            uploaded={!!currentSlot?.has_showroom}
            busy={busy === "showroom"}
            anyBusy={busy !== null}
            onPick={(f) => onUpload("showroom", f)}
          />
        </div>

        <div className="mt-3 rounded-apple bg-gray-50 px-3 py-2 text-[11.5px] leading-relaxed text-gray-600">
          <div className="font-semibold text-gray-700">Excel файлын формат:</div>
          A багана — Эрхэт <b>дотоод код (item_code)</b>, B багана — <b>тоо ширхэг</b> (qty).
          Эхний мөрөнд header (Код, Тоо ширхэг гэх мэт) байсан ч ажиллана. Нэг файлд нэг бараа олон удаа гарвал бүгдийг нийлүүлж нэг утгаар бүртгэнэ.
        </div>
      </Card>

      {/* ── Slot status grid (all months bookkeeping) ──────────────── */}
      <Card className="mt-4 p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-gray-900">Бүртгэгдсэн саруудын байдал</div>
            <div className="mt-0.5 text-[11px] text-gray-500">Аль сар, ямар талаас файл орсныг хяна. Click дарж сонгох.</div>
          </div>
          <Button variant="ghost" onClick={loadSlots} disabled={loadingSlots}>
            {loadingSlots ? <RefreshCw size={14} className="animate-spin"/> : <RefreshCw size={14}/>} Сэргээх
          </Button>
        </div>

        <div className="mt-3 overflow-x-auto">
          {slots.length === 0 ? (
            <div className="grid place-items-center py-12 text-gray-400">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gray-50">
                <Calendar size={20} className="opacity-40"/>
              </div>
              <p className="mt-2 text-[12px] font-medium">Одоохондоо ямар ч файл оруулаагүй</p>
              <p className="text-[11px] text-gray-300">Дээрх хэсгээс эхний файлаа орууулна уу.</p>
            </div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="bg-gray-50 text-left text-[10.5px] font-bold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-3 py-2.5">Сар</th>
                  <th className="px-3 py-2.5 text-center">Агуулах</th>
                  <th className="px-3 py-2.5 text-center">Заал</th>
                  <th className="px-3 py-2.5 text-right">Бараа</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {slots.map(s => {
                  const isActive = s.year === year && s.month === month;
                  return (
                    <tr key={`${s.year}-${s.month}`} className={isActive ? "bg-blue-50/60" : "hover:bg-gray-50/50"}>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => { setYear(s.year); setMonth(s.month); }}
                          className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-semibold ${
                            isActive ? "bg-[#0071E3] text-white" : "text-gray-800 hover:bg-blue-50 hover:text-blue-700"
                          }`}>
                          {s.year}-{String(s.month).padStart(2, "0")}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {s.has_warehouse
                          ? <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200"><Check size={10}/>Орсон</span>
                          : <span className="inline-flex items-center gap-1 text-[11px] text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {s.has_showroom
                          ? <span className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-200"><Check size={10}/>Орсон</span>
                          : <span className="inline-flex items-center gap-1 text-[11px] text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-800">{s.count}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          {s.has_warehouse && (
                            <button onClick={() => onDelete(s, "warehouse")} title="Агуулах устгах"
                              className="grid h-7 w-7 place-items-center rounded-md text-gray-400 hover:bg-blue-50 hover:text-blue-600">
                              <Trash2 size={12}/>
                            </button>
                          )}
                          {s.has_showroom && (
                            <button onClick={() => onDelete(s, "showroom")} title="Заал устгах"
                              className="grid h-7 w-7 place-items-center rounded-md text-gray-400 hover:bg-violet-50 hover:text-violet-600">
                              <Trash2 size={12}/>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </motion.div>
  );
}


// ── Upload tile component ────────────────────────────────────────────

function UploadTile(props: {
  kind: Kind;
  icon: React.ReactNode;
  title: string;
  color: "blue" | "violet";
  uploaded: boolean;
  busy: boolean;
  anyBusy: boolean;
  onPick: (f: File) => void;
}) {
  const { title, icon, color, uploaded, busy, anyBusy, onPick } = props;
  const colorMap = {
    blue:   { bg: "bg-blue-50",   tx: "text-blue-700",   ring: "ring-blue-200",   btn: "bg-[#0071E3] hover:bg-[#005BB5]" },
    violet: { bg: "bg-violet-50", tx: "text-violet-700", ring: "ring-violet-200", btn: "bg-[#7C3AED] hover:bg-[#6D28D9]" },
  }[color];

  return (
    <div className={`rounded-apple border ${uploaded ? colorMap.ring + " ring-1 " + colorMap.bg : "border-gray-200 bg-white"} p-4`}>
      <div className="flex items-center gap-2.5">
        <div className={`grid h-9 w-9 place-items-center rounded-lg ${colorMap.bg} ${colorMap.tx}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-gray-900">{title}</div>
          {uploaded
            ? <div className="mt-0.5 text-[11px] font-medium text-emerald-700">✓ Файл орсон</div>
            : <div className="mt-0.5 text-[11px] text-gray-400">Файл оруулаагүй</div>}
        </div>
      </div>
      <label className={`mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-apple px-4 text-[13px] font-semibold text-white shadow-sm transition-colors ${
        anyBusy ? "cursor-not-allowed bg-gray-400" : "cursor-pointer " + colorMap.btn
      }`}>
        {busy ? <><RefreshCw size={14} className="animate-spin"/>Оруулж байна…</> : <><UploadCloud size={14}/>{uploaded ? "Дахин оруулах" : "Файл оруулах"}</>}
        <input type="file" accept=".xlsx,.xls" className="hidden" disabled={anyBusy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.currentTarget.value = "";
          }}/>
      </label>
    </div>
  );
}
