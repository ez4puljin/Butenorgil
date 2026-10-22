import { startHtml5Scanner, cameraBlockedReason } from "./html5Scanner";
import { useCallback, useEffect, useRef, useState } from "react";

const NATIVE_FORMATS = ["ean_13", "ean_8", "code_128", "code_39", "code_93", "upc_a", "upc_e", "itf", "codabar"];

/**
 * Тасралтгүй баркод уншигч (утасны арын камер).
 *
 * Android Chrome/WebView-д BarcodeDetector (хурдан, native), бусад үед html5-qrcode.
 * `pausedRef.current === true` үед уншсан кодыг алгасна — тоо оруулж байх үед өөр баркод
 * санамсаргүй орж ирээд буруу бараанд тоологдохоос сэргийлнэ.
 *
 * Хэрэглээ: <video ref={videoRef}/> (native) болон <div id={boxId}/> (html5-qrcode) хоёуланг
 * нэг хайрцагт давхарлаж байрлуулна.
 */
export function useBarcodeCamera(onCode: (code: string) => void, pausedRef: React.MutableRefObject<boolean>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxId = useRef(`bc-cam-${Math.random().toString(36).slice(2, 8)}`).current;
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const qrRef = useRef<any>(null);
  const onCodeRef = useRef(onCode);
  useEffect(() => { onCodeRef.current = onCode; }, [onCode]);

  const [camOn, setCamOn] = useState(false);
  const [camErr, setCamErr] = useState("");
  const [starting, setStarting] = useState(false);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (qrRef.current) {
      try { qrRef.current.stop(); } catch { /* аль хэдийн зогссон */ }
      try { qrRef.current.clear(); } catch { /* ignore */ }
      qrRef.current = null;
    }
    setCamOn(false);
  }, []);

  const loop = useCallback(async () => {
    if (videoRef.current && detectorRef.current && !pausedRef.current) {
      try {
        const codes = await detectorRef.current.detect(videoRef.current);
        const raw = codes?.[0]?.rawValue || codes?.[0]?.value;
        if (raw) onCodeRef.current(String(raw));
      } catch { /* нэг кадр уншигдаагүй */ }
    }
    if (streamRef.current) rafRef.current = requestAnimationFrame(loop);
  }, [pausedRef]);

  const start = useCallback(async () => {
    setCamErr(""); setStarting(true);
    stop();
    try {
      const blocked = cameraBlockedReason();
      if (blocked) throw new Error(blocked);
      // iPhone/Safari: BarcodeDetector байхгүй — камерыг хоёр дахин нээхгүй, шууд html5-qrcode
      if (!("BarcodeDetector" in window)) {
        qrRef.current = await startHtml5Scanner(boxId, (decoded: string) => { if (!pausedRef.current) onCodeRef.current(decoded); });
        setStarting(false); setCamOn(true);
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      if ("BarcodeDetector" in window) {
        const D = (window as any).BarcodeDetector;
        const sup = await D.getSupportedFormats().catch(() => NATIVE_FORMATS);
        const fmts = NATIVE_FORMATS.filter((f) => sup.includes(f));
        detectorRef.current = new D({ formats: fmts.length ? fmts : NATIVE_FORMATS });
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        v.setAttribute("playsinline", "true");
        await v.play().catch(() => {});
        setStarting(false); setCamOn(true);
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      stream.getTracks().forEach((t) => t.stop());
      qrRef.current = await startHtml5Scanner(boxId, (decoded: string) => { if (!pausedRef.current) onCodeRef.current(decoded); });
      setStarting(false); setCamOn(true);
    } catch (e: any) {
      const n = e?.name || "";
      setCamErr(
        n === "NotAllowedError" ? "Камер зөвшөөрөгдөөгүй — Тохиргоо → Апп → Bto → Permissions → Камер."
        : n === "NotFoundError" ? "Камер олдсонгүй."
        : n === "NotReadableError" ? "Камерыг өөр програм ашиглаж байна."
        : (e?.message || "Камер нээгдсэнгүй"));
      setStarting(false);
      stop();
    }
  }, [boxId, loop, stop, pausedRef]);

  useEffect(() => () => stop(), [stop]);

  return { videoRef, boxId, camOn, camErr, starting, start, stop };
}
