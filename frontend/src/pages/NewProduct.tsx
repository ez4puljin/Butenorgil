import { useRef, useState } from "react";
import {
  Camera, CheckCircle2, Download, Loader2,
  Plus, RefreshCw, Trash2, X, Sparkles, ImageOff, Edit3,
} from "lucide-react";
// Note: Camera capture uses <input type="file" capture="environment"> for HTTP compatibility
import { api } from "../lib/api";

// ─── Types ────────────────────────────────────────────────────
type ProductDraft = {
  id: string;
  photos: string[];       // base64 jpeg
  brand: string;
  pack_ratio: number;
};

type AnalysisResult = {
  processed_image_b64: string;
  name: string;
  barcode: string;
  weight_kg: number;
  category: string;
  suggested_code: string;
  brand: string;
  pack_ratio: number;
};

type ProductReviewed = ProductDraft & {
  result: AnalysisResult;
  edited: {
    name: string;
    barcode: string;
    weight_kg: string;
    category: string;
    item_code: string;
  };
};

// ─── base64 → Blob ────────────────────────────────────────────
function b64ToBlob(b64: string, mime = "image/jpeg"): Blob {
  const data = b64.includes(",") ? b64.split(",")[1] : b64;
  const bytes = atob(data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ─── Compress image via Canvas (HTTP-safe, no memory crash) ──
function compressImage(file: File, maxPx = 1024, quality = 0.78): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(""); };
    img.src = url;
  });
}

// ─── Photo capture modal (file input based, HTTP-compatible) ──
function CameraModal({
  onDone,
  onCancel,
}: {
  onDone: (photos: string[]) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setLoading(true);
    const b64s = await Promise.all(files.map((f) => compressImage(f)));
    setPhotos((p) => [...p, ...b64s]);
    setLoading(false);
    // input reset хийхгүй бол дараагийн дарахад onChange дуудагдахгүй
    if (inputRef.current) inputRef.current.value = "";
  };

  const removePhoto = (i: number) =>
    setPhotos((p) => p.filter((_, idx) => idx !== i));

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b">
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
          <span className="text-sm font-semibold text-gray-700">
            {photos.length === 0 ? "Зураг нэмэх" : `${photos.length} зураг`}
          </span>
          <button
            onClick={() => onDone(photos)}
            disabled={photos.length === 0}
            className="rounded-lg bg-purple-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            Болсон
          </button>
        </div>

        {/* Photo grid */}
        <div className="p-4 min-h-[120px]">
          {photos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center text-gray-400">
              <Camera size={36} className="mb-2 opacity-40" />
              <p className="text-sm">Доорх товчоор камераа нэм эсвэл галерейгаас сонго</p>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {photos.map((p, i) => (
                <div key={i} className="relative group">
                  <img src={p} alt="" className="w-full aspect-square rounded-xl object-cover border border-gray-100" />
                  <button
                    onClick={() => removePhoto(i)}
                    className="absolute top-0.5 right-0.5 bg-red-500 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={10} className="text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-4 pb-4 flex gap-3">
          {/* Камераар авах */}
          <label className="flex-1 cursor-pointer">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={handleFiles}
            />
            <div className="flex items-center justify-center gap-2 rounded-xl bg-purple-600 py-3 text-sm font-semibold text-white hover:bg-purple-700 transition-colors">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
              Камер
            </div>
          </label>

          {/* Галерейгаас сонгох */}
          <label className="flex-1 cursor-pointer">
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFiles}
            />
            <div className="flex items-center justify-center gap-2 rounded-xl border border-purple-200 bg-purple-50 py-3 text-sm font-semibold text-purple-700 hover:bg-purple-100 transition-colors">
              <Plus size={16} />
              Галерей
            </div>
          </label>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function NewProduct() {
  const [drafts, setDrafts] = useState<ProductDraft[]>([]);
  const [reviewed, setReviewed] = useState<ProductReviewed[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [phase, setPhase] = useState<"draft" | "review">("draft");

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  };

  // ── Camera done ──
  const handleCameraDone = (photos: string[]) => {
    setShowCamera(false);
    if (photos.length === 0) return;
    setDrafts((d) => [
      ...d,
      { id: crypto.randomUUID(), photos, brand: "", pack_ratio: 1 },
    ]);
  };

  const removeDraft = (id: string) => setDrafts((d) => d.filter((x) => x.id !== id));

  const updateDraft = (id: string, key: "brand" | "pack_ratio", val: string | number) =>
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, [key]: val } : x)));

  // ── AI Analysis ──
  const analyzeAll = async () => {
    if (drafts.length === 0) return;
    setAnalyzing(true);
    setAnalyzeProgress(0);
    const results: ProductReviewed[] = [];

    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i];
      setAnalyzeProgress(Math.round(((i) / drafts.length) * 100));
      try {
        const form = new FormData();
        draft.photos.forEach((b64, idx) => {
          const blob = b64ToBlob(b64);
          form.append("photos", blob, `photo_${idx}.jpg`);
        });
        form.append("brand", draft.brand);
        form.append("pack_ratio", String(draft.pack_ratio));

        const res = await api.post<AnalysisResult>("/new-product/analyze", form, {
          headers: { "Content-Type": "multipart/form-data" },
        });

        results.push({
          ...draft,
          result: res.data,
          edited: {
            name: res.data.name,
            barcode: res.data.barcode,
            weight_kg: String(res.data.weight_kg),
            category: res.data.category,
            item_code: res.data.suggested_code,
          },
        });
      } catch (e: any) {
        flash(`Бараа ${i + 1}: ${e?.response?.data?.detail ?? "Алдаа гарлаа"}`, false);
        results.push({
          ...draft,
          result: {
            processed_image_b64: draft.photos[0] ?? "",
            name: "",
            barcode: "",
            weight_kg: 0,
            category: "",
            suggested_code: "",
            brand: draft.brand,
            pack_ratio: draft.pack_ratio,
          },
          edited: {
            name: "",
            barcode: "",
            weight_kg: "0",
            category: "",
            item_code: "",
          },
        });
      }
    }

    setAnalyzeProgress(100);
    setReviewed(results);
    setPhase("review");
    setAnalyzing(false);
  };

  // ── Update reviewed field ──
  const updateReviewed = (id: string, key: keyof ProductReviewed["edited"], val: string) =>
    setReviewed((r) =>
      r.map((x) => (x.id === id ? { ...x, edited: { ...x.edited, [key]: val } } : x))
    );

  const removeReviewed = (id: string) => setReviewed((r) => r.filter((x) => x.id !== id));

  // ── Download Excel ──
  const downloadExcel = async () => {
    setDownloading(true);
    try {
      const products = reviewed.map((r) => ({
        item_code: r.edited.item_code,
        name: r.edited.name,
        category: r.edited.category,
        weight_kg: parseFloat(r.edited.weight_kg) || 0,
        pack_ratio: r.pack_ratio,
        brand: r.brand || r.result.brand,
        barcode: r.edited.barcode,
        processed_image_b64: r.result.processed_image_b64,
      }));

      const res = await api.post("/new-product/generate-excel", { products }, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `new_products_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      flash("Excel амжилттай татагдлаа");
    } catch {
      flash("Excel үүсгэхэд алдаа гарлаа", false);
    } finally {
      setDownloading(false);
    }
  };

  // ── Reset ──
  const resetAll = () => {
    setDrafts([]);
    setReviewed([]);
    setPhase("draft");
  };

  return (
    <div className="min-h-screen">
      {/* Camera modal */}
      {showCamera && (
        <CameraModal onDone={handleCameraDone} onCancel={() => setShowCamera(false)} />
      )}

      {/* Flash message */}
      {msg && (
        <div className={`fixed top-4 right-4 z-50 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${
          msg.ok ? "bg-green-500 text-white" : "bg-red-500 text-white"
        }`}>
          {msg.text}
        </div>
      )}

      {/* ── Header ── */}
      <div className="rounded-2xl bg-white shadow-sm p-5 mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 p-2.5">
              <Sparkles size={20} className="text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900">Шинэ бараа таниулах</h1>
              <p className="text-xs text-gray-500">AI ашиглан бараа бүртгэх</p>
            </div>
          </div>
          {phase === "review" && (
            <button
              onClick={resetAll}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              <RefreshCw size={13} /> Дахин эхлэх
            </button>
          )}
        </div>
      </div>

      {/* ── DRAFT PHASE ── */}
      {phase === "draft" && (
        <div className="space-y-4">
          {/* Empty state */}
          {drafts.length === 0 && (
            <div className="rounded-2xl bg-white shadow-sm p-12 flex flex-col items-center gap-4 text-center">
              <div className="rounded-full bg-purple-50 p-5">
                <Camera size={32} className="text-purple-500" />
              </div>
              <div>
                <p className="font-semibold text-gray-800">Бараа нэмэгдээгүй байна</p>
                <p className="text-sm text-gray-500 mt-1">
                  "Бараа нэмэх" товч дарж камераар зураг аваарай
                </p>
              </div>
              <button
                onClick={() => setShowCamera(true)}
                className="flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-purple-700"
              >
                <Plus size={16} /> Бараа нэмэх
              </button>
            </div>
          )}

          {/* Draft cards */}
          {drafts.map((draft, idx) => (
            <div key={draft.id} className="rounded-2xl bg-white shadow-sm p-4">
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-semibold text-gray-700">
                  Бараа {idx + 1}
                  <span className="ml-2 text-xs text-gray-400">{draft.photos.length} зураг</span>
                </span>
                <button onClick={() => removeDraft(draft.id)} className="text-red-400 hover:text-red-600">
                  <Trash2 size={16} />
                </button>
              </div>

              {/* Photo thumbnails */}
              <div className="flex gap-2 overflow-x-auto mb-4 pb-1">
                {draft.photos.map((p, i) => (
                  <img
                    key={i}
                    src={p}
                    alt=""
                    className="h-20 w-20 rounded-xl object-cover border border-gray-100 flex-shrink-0"
                  />
                ))}
                <button
                  onClick={() => setShowCamera(true)}
                  className="h-20 w-20 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center flex-shrink-0 hover:border-purple-300 hover:bg-purple-50 transition-colors"
                >
                  <Plus size={20} className="text-gray-400" />
                </button>
              </div>

              {/* Brand + pack_ratio */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Бренд нэр</label>
                  <input
                    value={draft.brand}
                    onChange={(e) => updateDraft(draft.id, "brand", e.target.value)}
                    placeholder="JACOBS КОФЕ"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-purple-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Хайрцагны тоо</label>
                  <input
                    type="number"
                    value={draft.pack_ratio}
                    onChange={(e) => updateDraft(draft.id, "pack_ratio", Number(e.target.value))}
                    min={1}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-purple-400 focus:outline-none"
                  />
                </div>
              </div>
            </div>
          ))}

          {/* Bottom actions */}
          {drafts.length > 0 && (
            <div className="flex gap-3">
              <button
                onClick={() => setShowCamera(true)}
                className="flex items-center gap-2 rounded-xl border border-purple-200 bg-purple-50 px-4 py-2.5 text-sm font-medium text-purple-700 hover:bg-purple-100"
              >
                <Plus size={15} /> Бараа нэмэх
              </button>
              <button
                onClick={analyzeAll}
                disabled={analyzing}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow hover:opacity-90 disabled:opacity-50"
              >
                {analyzing ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    Шинжилж байна... {analyzeProgress}%
                  </>
                ) : (
                  <>
                    <Sparkles size={15} /> Шинээр үүсгэх (AI)
                  </>
                )}
              </button>
            </div>
          )}

          {/* Progress bar */}
          {analyzing && (
            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className="h-2 bg-gradient-to-r from-purple-500 to-indigo-500 transition-all duration-300"
                style={{ width: `${analyzeProgress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── REVIEW PHASE ── */}
      {phase === "review" && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 flex items-center gap-3">
            <CheckCircle2 size={20} className="text-emerald-600 flex-shrink-0" />
            <p className="text-sm text-emerald-800">
              <strong>{reviewed.length}</strong> бараанд AI шинжилгээ хийгдлээ. Мэдээллийг шалгаж, засаарай.
            </p>
          </div>

          {reviewed.map((r, idx) => (
            <div key={r.id} className="rounded-2xl bg-white shadow-sm overflow-hidden">
              {/* Card header */}
              <div className="bg-gradient-to-r from-purple-50 to-indigo-50 px-4 py-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">Бараа {idx + 1}</span>
                <button onClick={() => removeReviewed(r.id)} className="text-red-400 hover:text-red-600">
                  <Trash2 size={15} />
                </button>
              </div>

              <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Processed image */}
                <div className="flex flex-col items-center gap-2">
                  {r.result.processed_image_b64 ? (
                    <div className="relative">
                      <img
                        src={r.result.processed_image_b64}
                        alt="Боловсруулсан зураг"
                        className="w-40 h-40 object-contain rounded-xl border border-gray-100 bg-[#f0f0f0]"
                        style={{ backgroundImage: "repeating-conic-gradient(#ccc 0% 25%, white 0% 50%)", backgroundSize: "12px 12px" }}
                      />
                      <span className="absolute bottom-1 left-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
                        Фон устгасан
                      </span>
                    </div>
                  ) : (
                    <div className="w-40 h-40 rounded-xl bg-gray-100 flex items-center justify-center">
                      <ImageOff size={32} className="text-gray-300" />
                    </div>
                  )}
                  {/* Original photos */}
                  <div className="flex gap-1">
                    {r.photos.slice(0, 4).map((p, i) => (
                      <img key={i} src={p} alt="" className="w-9 h-9 rounded-lg object-cover border border-gray-100" />
                    ))}
                  </div>
                </div>

                {/* Editable fields */}
                <div className="md:col-span-2 grid grid-cols-2 gap-3">
                  {/* Нэр */}
                  <div className="col-span-2">
                    <label className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                      <Edit3 size={11} /> Нэр
                    </label>
                    <input
                      value={r.edited.name}
                      onChange={(e) => updateReviewed(r.id, "name", e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-purple-400 focus:outline-none"
                    />
                  </div>

                  {/* Код */}
                  <div>
                    <label className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                      <Edit3 size={11} /> Барааны код
                    </label>
                    <input
                      value={r.edited.item_code}
                      onChange={(e) => updateReviewed(r.id, "item_code", e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono focus:border-purple-400 focus:outline-none"
                    />
                  </div>

                  {/* Ангилал */}
                  <div>
                    <label className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                      <Edit3 size={11} /> Ангилал
                    </label>
                    <input
                      value={r.edited.category}
                      onChange={(e) => updateReviewed(r.id, "category", e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-purple-400 focus:outline-none"
                    />
                  </div>

                  {/* Жин */}
                  <div>
                    <label className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                      <Edit3 size={11} /> Жин (кг)
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      value={r.edited.weight_kg}
                      onChange={(e) => updateReviewed(r.id, "weight_kg", e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-purple-400 focus:outline-none"
                    />
                  </div>

                  {/* Баркод */}
                  <div>
                    <label className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                      <Edit3 size={11} /> Баркод
                    </label>
                    <input
                      value={r.edited.barcode}
                      onChange={(e) => updateReviewed(r.id, "barcode", e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono focus:border-purple-400 focus:outline-none"
                    />
                  </div>

                  {/* Бренд (read-only display) */}
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Бренд</label>
                    <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700 border border-gray-100">
                      {r.brand || "—"}
                    </div>
                  </div>

                  {/* Хайрцагны тоо (read-only display) */}
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Хайрцагны тоо</label>
                    <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700 border border-gray-100">
                      {r.pack_ratio}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {/* Download button */}
          {reviewed.length > 0 && (
            <button
              onClick={downloadExcel}
              disabled={downloading}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-3.5 text-sm font-semibold text-white shadow hover:opacity-90 disabled:opacity-50"
            >
              {downloading ? (
                <><Loader2 size={16} className="animate-spin" /> Үүсгэж байна...</>
              ) : (
                <><Download size={16} /> Excel татах ({reviewed.length} бараа)</>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
