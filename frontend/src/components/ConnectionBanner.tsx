/**
 * Холболтын төлөв banner — дэлгэцийн дээд хэсэгт тогтмол харагдана.
 *
 *  - Утасны WiFi тасарсан      → улаан: "Утасны WiFi холболт тасарсан байна"
 *  - Сервер/router-т хүрэхгүй  → улбар шар: "Сервертэй холбогдож чадахгүй..."
 *  - Сэргэсэн                  → ногоон (3 секунд): "Холболт сэргэлээ — үйлдлүүд үргэлжилнэ"
 *
 * Тасарсан үед connection.ts 3с тутам автоматаар ping хийдэг тул хэрэглэгч
 * юу ч дарах шаардлагагүй — сэргэмэгц хүлээгдэж буй хадгалалтууд (PATCH/PUT)
 * автоматаар илгээгдэнэ.
 */
import { useEffect, useState } from "react";
import { WifiOff, ServerOff, CheckCircle2 } from "lucide-react";
import { getConnState, subscribe, type ConnState } from "../lib/connection";

export default function ConnectionBanner() {
  const [state, setState] = useState<ConnState>(getConnState());
  const [showRestored, setShowRestored] = useState(false);

  useEffect(() => {
    return subscribe((s) => {
      setState(s);
      if (s === "online") {
        setShowRestored(true);
        setTimeout(() => setShowRestored(false), 3500);
      }
    });
  }, []);

  if (state === "online" && !showRestored) return null;

  if (state === "online" && showRestored) {
    return (
      <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white shadow-md">
        <CheckCircle2 size={15} className="shrink-0" />
        Холболт сэргэлээ — хүлээгдэж байсан үйлдлүүд үргэлжилж байна
      </div>
    );
  }

  if (state === "wifi") {
    return (
      <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 bg-red-600 px-4 py-2 text-[13px] font-semibold text-white shadow-md">
        <WifiOff size={15} className="shrink-0 animate-pulse" />
        <span>Утасны WiFi холболт тасарсан байна — WiFi-гаа шалгана уу</span>
      </div>
    );
  }

  // state === "server"
  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-[13px] font-semibold text-white shadow-md">
      <ServerOff size={15} className="shrink-0 animate-pulse" />
      <span>Сервертэй холбогдож чадахгүй байна (сервер унтарсан эсвэл WiFi router-ийн асуудал) — автоматаар дахин холбогдоно...</span>
    </div>
  );
}
