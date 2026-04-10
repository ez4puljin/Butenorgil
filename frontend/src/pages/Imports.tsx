import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { api } from "../lib/api";
import { UploadCloud, Info, Play, Pencil, Plus, Trash2 } from "lucide-react";

type ImportCard = {
  id: string;
  key?: string;
  action?: "upload" | "run";
  title: string;
  instruction: string[];
  logo: "erkhet" | "erxes" | "none";
};

type ImportLogRow = {
  id: number;
  created_at: string;
  import_key: string;
  username?: string;
  filename: string;
  status: string;
  message: string;
};

type ModalState = {
  open: boolean;
  title: string;
  importKey: string;
  lines: string[];
};

const importCards: ImportCard[] = [
  {
    id: "erkhet_stock",
    key: "erkhet_stock",
    title: "Эрхэт бараа",
    logo: "erkhet",
    instruction: [
      "Эрхэт системээс үлдэгдлийн тайланг Эксел файлаар экспортлоно.",
      "Агуулах болон огнооны нөхцөлийг тохируулна.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
  {
    id: "erxes_sales",
    key: "erxes_sales",
    title: "Эрксэс бараа",
    logo: "erxes",
    instruction: [
      "Эрксэс системээс борлуулалтын тайланг Эксел файлаар экспортлоно.",
      "Огнооны муж сонгоод файл үүсгэнэ.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
  {
    id: "master_merge",
    key: "master_merge",
    action: "run",
    title: "Мастер нэгтгэл",
    logo: "none",
    instruction: [
      "Эрхэт болон Эрксэс бараа хоёуланг нь импортолсон байх ёстой.",
      "Нэгтгэх товч дарахад хамгийн сүүлийн файлуудыг ашиглан мастер шинэчлэгдэнэ.",
      "Захиалгын модуль хамгийн сүүлийн нэгтгэлийг ашиглана.",
    ],
  },
  {
    id: "returns",
    key: "returns",
    title: "Орлого тайлан",
    logo: "erkhet",
    instruction: [
      "Орлогын тайланг Эксел файлаар экспортлоно.",
      "Оруулсны дараа тайлан нэгтгэх скрипт ажиллана.",
    ],
  },
  {
    id: "purchase_inbound",
    key: "purchase_inbound",
    title: "Хөдөлгөөний тайлан",
    logo: "erkhet",
    instruction: [
      "Эрхэт системээс хөдөлгөөний тайланг Эксел файлаар экспортлоно.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
  {
    id: "sales_plan",
    key: "sales_plan",
    title: "Борлуулалт тайлан",
    logo: "erkhet",
    instruction: [
      "Эрхэт системээс борлуулалтын тайланг Эксел файлаар экспортлоно.",
      "Огнооны муж сонгоод файл үүсгэнэ.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
  {
    id: "transfer_order",
    key: "transfer_order",
    title: "Үлдэгдэл тайлан",
    logo: "erkhet",
    instruction: [
      "Эрхэт системээс үлдэгдлийн тайланг Эксел файлаар экспортлоно.",
      "Агуулах болон огнооны нөхцөлийг тохируулна.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
  {
    id: "inventory_adjustment",
    key: "inventory_adjustment",
    title: "Дарагдсан барааны тайлан",
    logo: "erxes",
    instruction: [
      "Эрксэс системээс дарагдсан барааны тайланг Эксел файлаар экспортлоно.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
  {
    id: "accounts_receivable",
    key: "accounts_receivable",
    title: "Авлага өглөгө тайлан",
    logo: "erkhet",
    instruction: [
      "Эрхэт системээс авлага өглөгийн тайланг Эксел файлаар экспортлоно.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
  {
    id: "purchase_prices",
    key: "purchase_prices",
    title: "Үнийн тайлан",
    logo: "erkhet",
    instruction: [
      "ERP-ээс орлого авсан тайланг Excel (.xlsx) форматаар экспортлоно.",
      "Файлыг дараах 4 баганатай болго: A=Код, B=Нэр (лавлах), C=Огноо, D=Нэгж үнэ.",
      "Нэг бараа олон мөр байвал хамгийн сүүлийн огноотой мөрийн үнийг хадгална.",
      "Зөвхөн системийн барааны код (item_code) тохирох бараанууд шинэчлэгдэнэ.",
    ],
  },
  {
    id: "customer_info",
    key: "customer_info",
    title: "Харилцагчдын мэдээлэл",
    logo: "erkhet",
    instruction: [
      "Эрхэт системд нэвтэрч Лавлах → Харилцагч руу орно.",
      "Бүх харилцагчдын жагсаалтыг Excel (.xlsx) форматаар экспортолно.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
];

function ErpLogoBadge(props: { logo: ImportCard["logo"] }) {
  if (props.logo === "none") return null;
  if (props.logo === "erxes") {
    return (
      <div className="absolute right-3 top-3 rounded-lg bg-[#5B2DBD] px-2 py-1 text-[10px] font-semibold tracking-wide text-white">
        Эрксэс
      </div>
    );
  }
  return (
    <div className="absolute right-3 top-3 rounded-lg bg-[#E8B12A] px-2 py-1 text-[10px] font-semibold tracking-wide text-gray-900">
      Эрхэт
    </div>
  );
}

export default function Imports() {
  const isAdmin = localStorage.getItem("role") === "admin";

  const [modal, setModal] = useState<ModalState>({
    open: false,
    title: "",
    importKey: "",
    lines: [],
  });
  const [editMode, setEditMode] = useState(false);
  const [editLines, setEditLines] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [instructions, setInstructions] = useState<Record<string, string[]>>({});
  const [logs, setLogs] = useState<ImportLogRow[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const keyLabel: Record<string, string> = {
    erkhet_stock:         "Эрхэт бараа",
    erxes_sales:          "Эрксэс бараа",
    master_merge:         "Мастер нэгтгэл",
    returns:              "Орлого тайлан",
    purchase_inbound:     "Хөдөлгөөний тайлан",
    sales_plan:           "Борлуулалт тайлан",
    transfer_order:       "Үлдэгдэл тайлан",
    inventory_adjustment: "Дарагдсан барааны тайлан",
    accounts_receivable:  "Авлага өглөгө тайлан",
    customer_info:        "Харилцагчдын мэдээлэл",
    purchase_prices:      "Үнийн тайлан",
  };

  const loadLogs = async () => {
    const res = await api.get("/imports/logs");
    setLogs(res.data);
  };

  const loadInstructions = async () => {
    try {
      const res = await api.get("/imports/instructions");
      setInstructions(res.data);
    } catch {
      // fallback: hardcoded values
    }
  };

  const getLines = (card: ImportCard): string[] =>
    (card.key && instructions[card.key]?.length) ? instructions[card.key] : card.instruction;

  const openModal = (card: ImportCard) => {
    const lines = getLines(card);
    setModal({ open: true, title: `${card.title} заавар`, importKey: card.key ?? "", lines });
    setEditMode(false);
    setEditLines([]);
  };

  const closeModal = () => {
    setModal({ open: false, title: "", importKey: "", lines: [] });
    setEditMode(false);
    setEditLines([]);
  };

  const startEdit = () => {
    setEditLines([...modal.lines]);
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditLines([]);
  };

  const saveInstructions = async () => {
    if (!modal.importKey) return;
    setSaving(true);
    try {
      await api.put(`/imports/instructions/${modal.importKey}`, { lines: editLines });
      const updated = editLines.filter((l) => l.trim());
      setInstructions((prev) => ({ ...prev, [modal.importKey]: updated }));
      setModal((prev) => ({ ...prev, lines: updated }));
      setEditMode(false);
    } catch {
      alert("Хадгалахад алдаа гарлаа");
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (iso: string) => {
    if (!iso) return "-";
    const d = new Date(`${iso}Z`);
    if (Number.isNaN(d.getTime())) return String(iso).replace("T", " ").slice(0, 19);
    return d.toLocaleString("mn-MN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  };

  const latestByKey = useMemo(() => {
    const out: Record<string, ImportLogRow> = {};
    for (const row of logs) {
      if (!out[row.import_key]) out[row.import_key] = row;
    }
    return out;
  }, [logs]);

  useEffect(() => {
    loadLogs();
    loadInstructions();
  }, []);

  const onUpload = async (key: string, file: File) => {
    setBusyKey(key);
    try {
      const fd = new FormData();
      fd.append("f", file);
      await api.post(`/imports/${key}`, fd);
      await loadLogs();
      alert("Файл амжилттай орууллаа");
    } catch (e: any) {
      alert(e?.response?.data?.detail ?? "Файл оруулахад алдаа гарлаа");
    } finally {
      setBusyKey(null);
    }
  };

  const onRunMaster = async () => {
    setBusyKey("master_merge");
    try {
      await api.post("/imports/master_merge/run");
      await loadLogs();
      alert("Мастер нэгтгэл амжилттай дууслаа");
    } catch (e: any) {
      alert(e?.response?.data?.detail ?? "Мастер нэгтгэлд алдаа гарлаа");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="text-2xl font-semibold text-gray-900">Файл оруулалт</div>
      <div className="mt-1 text-sm text-gray-500">Эксел файл оруулах, скрипт ажиллуулах, мастер шинэчлэх</div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {importCards.map((c) => (
          <Card key={c.id} className="relative p-6">
            <ErpLogoBadge logo={c.logo} />
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-semibold text-gray-900">{c.title}</div>
                <div className="mt-1 text-sm text-gray-500">{c.key ? "Идэвхтэй импорт" : "Тун удахгүй идэвхжинэ"}</div>
                {c.key && latestByKey[c.key] && (
                  <>
                    <div className="mt-1 text-xs text-gray-500">Хэрэглэгч: {(latestByKey[c.key].username || "").replace(/\?/g, "").trim() || "Тодорхойгүй"}</div>
                    <div className="text-xs text-gray-500">Сүүлийн оруулсан огноо: {formatDate(latestByKey[c.key].created_at)}</div>
                  </>
                )}
              </div>
              <button
                className="rounded-apple bg-[#F5F5F7] p-3 hover:bg-gray-100"
                onClick={() => openModal(c)}
              >
                <Info size={18} className="text-gray-700" />
              </button>
            </div>

            <div className="mt-4 flex items-center gap-3">
              {c.action === "run" ? (
                <button
                  className={`inline-flex items-center gap-2 rounded-apple px-4 py-2 text-white shadow-sm ${
                    busyKey !== null ? "cursor-not-allowed bg-gray-400" : "cursor-pointer bg-[#34C759] hover:opacity-95"
                  }`}
                  disabled={busyKey !== null}
                  onClick={onRunMaster}
                >
                  <Play size={18} />
                  {busyKey === "master_merge" ? "Нэгтгэж байна..." : "Нэгтгэх"}
                </button>
              ) : (
                <label
                  className={`inline-flex items-center gap-2 rounded-apple px-4 py-2 text-white shadow-sm ${
                    c.key ? "cursor-pointer bg-[#0071E3] hover:opacity-95" : "cursor-not-allowed bg-gray-400"
                  }`}
                >
                  <UploadCloud size={18} />
                  {!c.key ? "Удахгүй" : busyKey === c.key ? "Оруулж байна..." : "Файл оруулах"}
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    className="hidden"
                    disabled={busyKey !== null || !c.key}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f && c.key) onUpload(c.key, f);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              )}
              <Button variant="ghost" onClick={loadLogs}>
                Лог шинэчлэх
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {/* Лог хүснэгт */}
      <div className="mt-8 rounded-apple bg-white p-6 shadow-sm">
        <div className="text-lg font-semibold text-gray-900">Сүүлийн 50 шинэчлэл</div>
        <div className="mt-3 max-h-[420px] overflow-auto rounded-apple border border-gray-100">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white shadow-sm">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3">Огноо</th>
                <th className="px-4 py-3">Төрөл</th>
                <th className="px-4 py-3">Хэрэглэгч</th>
                <th className="px-4 py-3">Файл</th>
                <th className="px-4 py-3">Төлөв</th>
                <th className="px-4 py-3">Тайлбар</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3">{formatDate(l.created_at)}</td>
                  <td className="px-4 py-3">{keyLabel[l.import_key] ?? "Тусгай төрөл"}</td>
                  <td className="px-4 py-3">{(l.username || "").replace(/\?/g, "").trim() || "Тодорхойгүй"}</td>
                  <td className="px-4 py-3">{l.filename}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-3 py-1 text-xs ${l.status === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                      {l.status === "ok" ? "Амжилттай" : "Алдаатай"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Заавар modal */}
      <Modal open={modal.open} title={modal.title} onClose={closeModal}>
        {!editMode ? (
          <>
            <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
              {modal.lines.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ol>
            {isAdmin && modal.importKey && (
              <div className="mt-5 flex justify-end">
                <button
                  className="inline-flex items-center gap-2 rounded-apple bg-[#F5F5F7] px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
                  onClick={startEdit}
                >
                  <Pencil size={14} />
                  Заавар засах
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="space-y-2">
              {editLines.map((line, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-right text-xs text-gray-400">{i + 1}.</span>
                  <input
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0071E3] focus:outline-none"
                    value={line}
                    onChange={(e) => {
                      const next = [...editLines];
                      next[i] = e.target.value;
                      setEditLines(next);
                    }}
                  />
                  <button
                    className="shrink-0 text-gray-400 hover:text-red-500"
                    onClick={() => setEditLines(editLines.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>

            <button
              className="mt-3 inline-flex items-center gap-1 text-sm text-[#0071E3] hover:underline"
              onClick={() => setEditLines([...editLines, ""])}
            >
              <Plus size={14} /> Мөр нэмэх
            </button>

            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                onClick={cancelEdit}
              >
                Болих
              </button>
              <button
                className="rounded-apple bg-[#0071E3] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-60"
                disabled={saving}
                onClick={saveInstructions}
              >
                {saving ? "Хадгалж байна..." : "Хадгалах"}
              </button>
            </div>
          </>
        )}
      </Modal>
    </motion.div>
  );
}
