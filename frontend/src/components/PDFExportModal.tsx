import { useEffect, useRef, useState } from "react";
import { X, FileDown, RefreshCw } from "lucide-react";
import { api } from "../lib/api";

interface PDFHeader {
  company_name: string;
  address: string;
  phone: string;
  truck_location: string;
  driver: string;
  extra_note: string;
}

const TEMPLATE_KEYS = ["buten_orgil", "orgil_khorum"] as const;
type TemplateKey = (typeof TEMPLATE_KEYS)[number];

const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  buten_orgil: "Бүтэн-Оргил ХХК",
  orgil_khorum: "Оргил-Хорум ХХК",
};

interface Props {
  orderId: number;
  orderDate: string;
  brands: string[];
  onClose: () => void;
}

const STORAGE_KEY = "pdf_export_v1";

function loadSaved(): { template: TemplateKey; header: PDFHeader } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function PDFExportModal({ orderId, orderDate, brands, onClose }: Props) {
  const [templates, setTemplates] = useState<Record<TemplateKey, PDFHeader> | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateKey>("buten_orgil");
  const [header, setHeader] = useState<PDFHeader>({
    company_name: "",
    address: "",
    phone: "",
    truck_location: "",
    driver: "",
    extra_note: "",
  });
  const [selectedBrand, setSelectedBrand] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Load templates then restore saved state (or use template defaults)
  useEffect(() => {
    api.get("/purchase-orders/pdf-templates").then((res) => {
      setTemplates(res.data);
      const saved = loadSaved();
      if (saved?.header?.company_name) {
        // Restore last used values
        setSelectedTemplate(saved.template ?? "buten_orgil");
        setHeader(saved.header);
      } else {
        // First time: use default template
        const tpl = res.data["buten_orgil"] as PDFHeader;
        if (tpl) setHeader({ ...tpl, truck_location: "", driver: "", extra_note: "" });
      }
      setReady(true);
    });
  }, []);

  // Persist to localStorage whenever values change (after initial load)
  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: selectedTemplate, header }));
  }, [header, selectedTemplate, ready]);

  // When template button clicked: update company/address/phone, keep truck/driver/note
  const handleTemplateChange = (key: TemplateKey) => {
    setSelectedTemplate(key);
    if (!templates) return;
    const tpl = templates[key];
    setHeader((prev) => ({
      ...prev,
      company_name: tpl.company_name,
      address: tpl.address,
      phone: tpl.phone,
    }));
  };

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post(`/purchase-orders/${orderId}/export-pdf`, { ...header, brand_filter: selectedBrand }, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `order_${orderDate.replaceAll("/", "")}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 500);
      onClose();
    } catch (e: any) {
      // If blob response contains JSON error, decode it
      try {
        const text = await e?.response?.data?.text?.();
        const json = JSON.parse(text ?? "");
        setError(json?.detail ?? "PDF үүсгэхэд алдаа гарлаа");
      } catch {
        setError("PDF үүсгэхэд алдаа гарлаа");
      }
    } finally {
      setLoading(false);
    }
  };

  const field = (label: string, key: keyof PDFHeader, placeholder = "") => (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-gray-600">{label}</label>
      <input
        type="text"
        value={header[key]}
        placeholder={placeholder}
        onChange={(e) => setHeader((h) => ({ ...h, [key]: e.target.value }))}
        className="rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
      />
    </div>
  );

  return (
    <div
      ref={backdropRef}
      onClick={(e) => e.target === backdropRef.current && onClose()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <FileDown size={18} className="text-[#0071E3]" />
            <h2 className="text-base font-semibold text-gray-900">PDF татах — {orderDate}</h2>
          </div>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-gray-100">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          {/* Brand selector */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-600">Брэнд сонгох</label>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setSelectedBrand("")}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  selectedBrand === ""
                    ? "border-[#0071E3] bg-[#0071E3] text-white"
                    : "border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                Бүгд
              </button>
              {brands.map((b) => (
                <button
                  key={b}
                  onClick={() => setSelectedBrand(b === selectedBrand ? "" : b)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    selectedBrand === b
                      ? "border-[#0071E3] bg-[#0071E3] text-white"
                      : "border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          {/* Template selector */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-600">Template</label>
            <div className="flex gap-2">
              {TEMPLATE_KEYS.map((k) => (
                <button
                  key={k}
                  onClick={() => handleTemplateChange(k)}
                  className={`flex-1 rounded-apple border py-2 text-sm font-medium transition-colors ${
                    selectedTemplate === k
                      ? "border-[#0071E3] bg-[#0071E3] text-white"
                      : "border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {TEMPLATE_LABELS[k]}
                </button>
              ))}
            </div>
          </div>

          {/* Editable header fields */}
          <div className="grid grid-cols-1 gap-3">
            {field("Компанийн нэр", "company_name")}
            {field("Хаяг", "address")}
            {field("Утас", "phone")}
            {field("Ачигдах машины байршил", "truck_location", "жишээ: Замчид, 3-р хороо")}
            {field("Жолооч / Машин", "driver", "жишээ: Б.Болд — 1234 УНА")}
            {field("Нэмэлт тэмдэглэл", "extra_note")}
          </div>
        </div>

        {/* Footer */}
        {error && (
          <div className="mx-6 mb-2 rounded-apple bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Болих
          </button>
          <button
            onClick={handleExport}
            disabled={loading || !header.company_name}
            className="inline-flex items-center gap-2 rounded-apple bg-[#0071E3] px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {loading ? <RefreshCw size={14} className="animate-spin" /> : <FileDown size={14} />}
            PDF татах
          </button>
        </div>
      </div>
    </div>
  );
}
