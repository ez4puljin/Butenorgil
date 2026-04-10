import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Card } from "../components/ui/Card";
import { api } from "../lib/api";
import { Download, FileSpreadsheet, CheckCircle2, AlertCircle, Upload } from "lucide-react";

// ── Тайлангийн тодорхойлолт ───────────────────────────────────────────────────
type ReportCard = {
  key: string;
  title: string;
  scriptNote?: string;          // .py файлын нэр
  description: string;
  requiredTypes: number[];       // ямар upload type хэрэгтэй
};

const TYPE_LABEL: Record<number, string> = {
  1: "Эрхэт бараа",
  2: "Эрксэс бараа",
  3: "Орлого тайлан",
  4: "Хөдөлгөөний тайлан",
  5: "Үлдэгдэл тайлан",
  6: "Борлуулалт тайлан",
  7: "Дарагдсан барааны тайлан",
};

const REPORT_CARDS: ReportCard[] = [
  {
    key: "ulailt",
    title: "Улайлт тайлан",
    scriptNote: "done.py",
    description: "Өчигдрийн үлдэгдэл (type=5) ашиглан улайлт тайлан гаргана.",
    requiredTypes: [5],
  },
  {
    key: "no_movement",
    title: "Орлого байсан ч хөдөлгөөнгүй",
    description: "Орлого (type=3) байгаа мөртлөө хөдөлгөөн (type=4) байхгүй бараануд.",
    requiredTypes: [1, 2, 3, 4],
  },
  {
    key: "tag_vs_location",
    title: "Tag vs Байршил зөрүү",
    description: "Орлого авсан байршил ба tagIds-ийн хүлзэгдэж буй байршлыг зөрүүтэй эсэхийг шалгана.",
    requiredTypes: [1, 2, 3],
  },
  {
    key: "inventory_adj",
    title: "Дарагдсан барааны тайлан",
    description: "type=7 файлын tickUsed=False мөрүүдийг шүүж тайлан гаргана.",
    requiredTypes: [7],
  },
  {
    key: "last_purchase_price",
    title: "Барааны сүүлийн орлогоны тайлан",
    scriptNote: "last_purchase_price.py",
    description: "Орлого тайланаас (type=3) бараа бүрийн хамгийн сүүлийн орлогоны үнэ гаргана.",
    requiredTypes: [3],
  },
  {
    key: "inventory_check",
    title: "Өмнөх тооллогоны тохируулга шалгах",
    description: "Тооллогоны дараах үлдэгдэл болон Тооллогоны тайланг эксэл файлаар оруул.",
    requiredTypes: [],
  },
];

// ─────────────────────────────────────────────────────────────────────────────

export default function Reports() {
  const [files, setFiles] = useState<any[]>([]);
  const [availableTypes, setAvailableTypes] = useState<number[]>([]);
  const [running, setRunning] = useState<string | null>(null);

  // "inventory_check" тусгай карт — 2 файл upload
  const [afterFile, setAfterFile] = useState<File | null>(null);
  const [countedFile, setCountedFile] = useState<File | null>(null);
  const afterRef = useRef<HTMLInputElement>(null);
  const countedRef = useRef<HTMLInputElement>(null);

  const loadStatus = async () => {
    try {
      const res = await api.get("/reports/status");
      setAvailableTypes(res.data.available_types ?? []);
    } catch {
      // status endpoint алдаа гарвал хоосон
    }
  };

  const loadFiles = async () => {
    const res = await api.get("/reports/files");
    setFiles(res.data.files);
  };

  useEffect(() => {
    loadStatus();
    loadFiles();
  }, []);

  const download = async (name: string) => {
    const res = await api.get(`/reports/download/${name}`, { responseType: "blob" });
    const url = window.URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const runReport = async (card: ReportCard) => {
    setRunning(card.key);
    try {
      let res;

      if (card.key === "inventory_check") {
        // 2 файл multipart upload
        const form = new FormData();
        form.append("after_file", afterFile!);
        form.append("counted_file", countedFile!);
        res = await api.post(`/reports/run/inventory_check`, form, {
          responseType: "blob",
          headers: { "Content-Type": "multipart/form-data" },
        });
        // Upload-дсны дараа файл сонголтыг цэвэрлэх
        setAfterFile(null);
        setCountedFile(null);
        if (afterRef.current) afterRef.current.value = "";
        if (countedRef.current) countedRef.current.value = "";
      } else {
        res = await api.post(`/reports/run/${card.key}`, {}, { responseType: "blob" });
      }

      const cd = res.headers["content-disposition"] ?? "";
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? `${card.key}.xlsx`;
      const url = window.URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      window.URL.revokeObjectURL(url);
      await loadFiles();
    } catch (e: any) {
      const text = await e?.response?.data?.text?.();
      let detail = "Тайлан гаргахад алдаа гарлаа";
      try {
        const parsed = JSON.parse(text ?? "");
        detail = parsed.detail ?? detail;
      } catch {}
      alert(detail);
    } finally {
      setRunning(null);
    }
  };

  // Карт бэлэн эсэхийг шалгах
  const isReady = (card: ReportCard) => {
    if (card.requiredTypes.length === 0) return null; // тусгай төрөл
    return card.requiredTypes.every((t) => availableTypes.includes(t));
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="text-2xl font-semibold text-gray-900">Тайлан</div>
      <div className="mt-1 text-sm text-gray-500">
        Тайлан боловсруулж эксэл файлаар экспорт хийх
      </div>

      {/* ── Тайлангийн карт grid ────────────────────────────────────────────── */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {REPORT_CARDS.map((card) => {
          const ready = isReady(card);
          const isRunning = running === card.key;
          const missingTypes = card.requiredTypes.filter((t) => !availableTypes.includes(t));

          return (
            <div
              key={card.key}
              className="flex flex-col rounded-apple bg-white p-5 shadow-sm border border-gray-100"
            >
              {/* Карт толгой */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet size={16} className="mt-0.5 shrink-0 text-emerald-500" />
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{card.title}</div>
                    {card.scriptNote && (
                      <div className="mt-0.5 font-mono text-[10px] text-gray-400">
                        {card.scriptNote}
                      </div>
                    )}
                  </div>
                </div>

                {/* Бэлэн / Дутуу badge */}
                {ready === true && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    <CheckCircle2 size={11} />
                    Бэлэн
                  </span>
                )}
                {ready === false && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    <AlertCircle size={11} />
                    Дутуу
                  </span>
                )}
                {ready === null && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                    Нээх
                  </span>
                )}
              </div>

              {/* Тайлбар */}
              <p className="mt-3 text-xs leading-relaxed text-gray-500">{card.description}</p>

              {/* Шаардлагатай файлууд */}
              {card.requiredTypes.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                    Шаардлагатай файлууд
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {card.requiredTypes.map((t) => {
                      const has = availableTypes.includes(t);
                      return (
                        <span
                          key={t}
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            has
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-gray-100 text-gray-400"
                          }`}
                        >
                          {has ? "✓ " : ""}
                          {TYPE_LABEL[t] ?? `type=${t}`}
                        </span>
                      );
                    })}
                  </div>
                  {missingTypes.length > 0 && (
                    <div className="mt-1.5 text-[10px] text-amber-600">
                      Импортын хэсгээс дутуу файлуудаа оруулна уу.
                    </div>
                  )}
                </div>
              )}

              {/* inventory_check: 2 файл upload */}
              {card.key === "inventory_check" && (
                <div className="mt-3 space-y-2">
                  {/* After-adjustment файл */}
                  <div>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                      Тохируулгын дараах тайлан (I багана = тоо)
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 rounded-apple border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-500 hover:border-gray-400 hover:bg-gray-50">
                      <Upload size={12} className="shrink-0 text-gray-400" />
                      <span className="truncate">
                        {afterFile ? afterFile.name : "Файл сонгох..."}
                      </span>
                      <input
                        ref={afterRef}
                        type="file"
                        accept=".xlsx,.xls,.xlsm"
                        className="hidden"
                        onChange={(e) => setAfterFile(e.target.files?.[0] ?? null)}
                      />
                    </label>
                  </div>
                  {/* Counted файл */}
                  <div>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                      Тооллогын тайлан (D багана = тоо)
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 rounded-apple border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-500 hover:border-gray-400 hover:bg-gray-50">
                      <Upload size={12} className="shrink-0 text-gray-400" />
                      <span className="truncate">
                        {countedFile ? countedFile.name : "Файл сонгох..."}
                      </span>
                      <input
                        ref={countedRef}
                        type="file"
                        accept=".xlsx,.xls,.xlsm"
                        className="hidden"
                        onChange={(e) => setCountedFile(e.target.files?.[0] ?? null)}
                      />
                    </label>
                  </div>
                </div>
              )}

              {/* Татах товч */}
              <div className="mt-auto pt-4">
                <button
                  onClick={() => runReport(card)}
                  disabled={
                    isRunning ||
                    ready === false ||
                    (card.key === "inventory_check" && (!afterFile || !countedFile))
                  }
                  className="inline-flex w-full items-center justify-center gap-2 rounded-apple bg-gray-900 px-4 py-2 text-xs font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isRunning ? (
                    <>
                      <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                      Боловсруулж байна...
                    </>
                  ) : (
                    <>
                      <Download size={13} />
                      Татах
                    </>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Гаралтын файлуудын жагсаалт ───────────────────────────────────── */}
      <div className="mt-8">
        <Card className="p-6">
          <div className="text-lg font-semibold text-gray-900">Гаралтын файлууд</div>
          <div className="mt-3 max-h-[520px] overflow-auto rounded-apple border border-gray-100">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white shadow-sm">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3">Нэр</th>
                  <th className="px-4 py-3">Хэмжээ</th>
                  <th className="px-4 py-3">Үйлдэл</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {files.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-sm text-gray-400">
                      Гаралтын файл байхгүй байна
                    </td>
                  </tr>
                )}
                {files.map((f) => (
                  <tr key={f.name}>
                    <td className="px-4 py-3">{f.name}</td>
                    <td className="px-4 py-3">{Math.round(f.size / 1024)} КБ</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => download(f.name)}
                        className="inline-flex items-center gap-2 rounded-apple border border-gray-200 bg-white px-3 py-2 text-sm hover:bg-gray-50"
                      >
                        <Download size={16} />
                        Татах
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </motion.div>
  );
}
