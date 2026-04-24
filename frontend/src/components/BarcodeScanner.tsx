import { useEffect, useRef, useState, Component, type ReactNode } from "react";
import { X, Loader2, Camera, RefreshCw, Keyboard } from "lucide-react";

type Props = {
  onDetected: (code: string) => void;
  onClose: () => void;
};

/* ── Error boundary ─────────────────────────────────────────────────────────
   Scanner дотор хаана ч JS алдаа гарсан тохиолдолд цагаан дэлгэц болохоос
   сэргийлж, тухайн алдаа болон fallback (гараар оруулах) товч харуулна. */
class ErrorBoundary extends Component<{ onManual: () => void; onClose: () => void; children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error("BarcodeScanner error:", err); }
  render() {
    if (this.state.err) {
      return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-900">Баркод алдаа</span>
              <button onClick={this.props.onClose} className="text-gray-400 hover:text-gray-600"><X size={16}/></button>
            </div>
            <div className="mb-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">
              {this.state.err?.message || String(this.state.err)}
            </div>
            <button onClick={this.props.onManual}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#0071E3] py-2 text-xs font-semibold text-white hover:bg-[#005BB5]">
              <Keyboard size={12}/> Гараар оруулах
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Supported barcode formats (for native BarcodeDetector)
const NATIVE_FORMATS = ["ean_13", "ean_8", "code_128", "code_39", "code_93", "upc_a", "upc_e", "qr_code", "itf", "codabar", "pdf417"];

function ScannerInner({ onDetected, onClose, initialManual }: Props & { initialManual?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const qrcodeRef = useRef<any>(null);

  const [starting, setStarting] = useState(!initialManual);
  const [error, setError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState(!!initialManual);
  const [manualCode, setManualCode] = useState("");
  const [mode, setMode] = useState<"native" | "html5" | "">("");

  const stopAll = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (qrcodeRef.current) {
      try { qrcodeRef.current.stop(); } catch {}
      try { qrcodeRef.current.clear(); } catch {}
      qrcodeRef.current = null;
    }
  };

  const detect = async () => {
    if (!videoRef.current || !detectorRef.current) return;
    try {
      const codes = await detectorRef.current.detect(videoRef.current);
      if (codes && codes.length > 0) {
        const raw = codes[0].rawValue || codes[0].value || "";
        if (raw) {
          stopAll();
          onDetected(raw);
          return;
        }
      }
    } catch { /* frame scan fail — continue */ }
    rafRef.current = requestAnimationFrame(detect);
  };

  const startNative = async (stream: MediaStream) => {
    const Detector = (window as any).BarcodeDetector;
    const supported = await Detector.getSupportedFormats().catch(() => NATIVE_FORMATS);
    const formats = NATIVE_FORMATS.filter(f => supported.includes(f));
    detectorRef.current = new Detector({ formats: formats.length > 0 ? formats : NATIVE_FORMATS });
    const v = videoRef.current!;
    v.srcObject = stream;
    v.setAttribute("playsinline", "true");
    v.setAttribute("muted", "true");
    await v.play().catch(() => {});
    setMode("native");
    setStarting(false);
    rafRef.current = requestAnimationFrame(detect);
  };

  const startHtml5 = async (stream: MediaStream) => {
    // html5-qrcode fallback. Stream-ийг зогсооно, уг сан нь өөрийн stream үүсгэнэ.
    stream.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    const mod: any = await import("html5-qrcode");
    const { Html5Qrcode } = mod;
    const devices = await Html5Qrcode.getCameras();
    if (!devices?.length) throw new Error("Камер олдсонгүй");
    const sorted = [
      ...devices.filter((d: any) => /back|rear|environment/i.test(d.label || "")),
      ...devices.filter((d: any) => !/back|rear|environment/i.test(d.label || "")),
    ];
    const targetId = sorted[0].id;

    const containerId = "bscan-container";
    const qr = new Html5Qrcode(containerId, false);
    qrcodeRef.current = qr;
    await qr.start(
      targetId,
      { fps: 10, qrbox: { width: 260, height: 160 }, aspectRatio: 1.5 },
      (decoded: string) => {
        stopAll();
        onDetected(decoded);
      },
      () => {}
    );
    setMode("html5");
    setStarting(false);
  };

  const start = async () => {
    setError(null);
    setStarting(true);
    stopAll();
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Энэ WebView дотор камер API байхгүй байна.");
      }

      // Permission + stream
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (e1: any) {
        // Retry without facingMode
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (e2: any) {
          const name = e2?.name || e1?.name || "";
          if (name === "NotAllowedError" || name === "PermissionDeniedError") {
            throw new Error("Камер зөвшөөрөгдөөгүй. Тохиргоо → Апп → Bto → Permissions → Камер.");
          }
          if (name === "NotFoundError") throw new Error("Камер олдсонгүй");
          if (name === "NotReadableError") throw new Error("Камер өөр апп ашиглаж байна");
          throw new Error(`Камер: ${name || "тодорхойгүй"} — ${e2?.message || e1?.message || ""}`);
        }
      }
      streamRef.current = stream;

      // Native BarcodeDetector байвал түрүүнд
      if ("BarcodeDetector" in window) {
        try {
          await startNative(stream);
          return;
        } catch (e) {
          console.warn("Native BarcodeDetector failed, falling back", e);
        }
      }

      // Fallback: html5-qrcode
      await startHtml5(stream);
    } catch (e: any) {
      console.error("Scanner start error:", e);
      setError(e?.message || String(e) || "Үл мэдэгдэх алдаа");
      setStarting(false);
      stopAll();
    }
  };

  useEffect(() => {
    if (!manualInput) {
      const t = setTimeout(() => start(), 100);
      return () => { clearTimeout(t); stopAll(); };
    }
    return () => stopAll();
    // eslint-disable-next-line
  }, [manualInput]);

  const submitManual = () => {
    const c = manualCode.trim();
    if (c) { stopAll(); onDetected(c); }
  };

  // Always visible header
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Camera size={15} className="text-[#0071E3]"/>
            <h3 className="text-sm font-semibold text-gray-900">Баркод скан</h3>
            {mode && <span className="text-[9px] text-gray-300">{mode}</span>}
          </div>
          <button onClick={() => { stopAll(); onClose(); }} className="rounded p-1.5 text-gray-400 hover:bg-gray-100">
            <X size={16}/>
          </button>
        </div>

        {!manualInput && (
          <>
            <div className="relative aspect-[4/3] w-full bg-black">
              {/* Native video tag (for BarcodeDetector fallback) */}
              <video ref={videoRef}
                     className="absolute inset-0 h-full w-full object-cover"
                     playsInline muted autoPlay />
              {/* html5-qrcode target container */}
              <div id="bscan-container"
                   className="absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover"/>

              {starting && !error && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white">
                  <Loader2 size={22} className="animate-spin"/>
                  <span className="text-xs">Камер нээгдэж байна...</span>
                </div>
              )}

              {error && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-5 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-xl">⚠</div>
                  <div className="text-sm font-semibold text-gray-800">Камер нээгдсэнгүй</div>
                  <div className="whitespace-pre-wrap text-[11px] text-gray-600 leading-relaxed">{error}</div>
                  <div className="flex items-center gap-2">
                    <button onClick={start}
                            className="inline-flex items-center gap-1 rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs text-white hover:bg-[#005BB5]">
                      <RefreshCw size={12}/> Дахин
                    </button>
                    <button onClick={() => { setError(null); setManualInput(true); }}
                            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                      <Keyboard size={12}/> Гараар
                    </button>
                  </div>
                </div>
              )}

              {!starting && !error && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-32 w-64 rounded-lg border-2 border-[#0071E3] shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"/>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2">
              <span className="text-[11px] text-gray-500">Баркодыг рамкан дотор оруулна</span>
              <button onClick={() => setManualInput(true)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[#0071E3] hover:underline">
                <Keyboard size={11}/> Гараар
              </button>
            </div>
          </>
        )}

        {manualInput && (
          <div className="space-y-3 p-5">
            <div className="flex items-center gap-2">
              <Keyboard size={14} className="text-gray-500"/>
              <span className="text-sm font-semibold text-gray-800">Гараар оруулах</span>
            </div>
            <input
              autoFocus
              value={manualCode}
              onChange={e => setManualCode(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submitManual(); }}
              placeholder="Баркод эсвэл барааны код..."
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
            />
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => { setManualInput(false); }}
                      className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                Камер
              </button>
              <button onClick={submitManual} disabled={!manualCode.trim()}
                      className="rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#005BB5] disabled:opacity-50">
                Хайх
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function BarcodeScanner(props: Props) {
  const [forceManual, setForceManual] = useState(false);
  return (
    <ErrorBoundary
      onManual={() => setForceManual(true)}
      onClose={props.onClose}
    >
      <ScannerInner {...props} initialManual={forceManual}/>
    </ErrorBoundary>
  );
}
