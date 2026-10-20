import { useSearchParams } from "react-router-dom";
import { CalendarCheck, ShieldCheck } from "lucide-react";
import PosReconPage from "./PosRecon";
import ErkhetSyncCheck from "./ErkhetSyncCheck";

// «Sync хяналт» — Эрхэт рүү орж буй хоёр урсгалын хяналт нэг цэсэнд:
//   POS тулгалт — касс (локал 192.168.1.254) → erxes → Эрхэт, өдөр бүрийн календарь
//   Deal sync   — erxes борлуулалтын deal → Эрхэт авлага (debtAmount), дахин sync
const TABS = [
  { id: "pos", label: "POS тулгалт", icon: CalendarCheck },
  { id: "deal", label: "Deal sync", icon: ShieldCheck },
] as const;

export default function SyncControl() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "deal" ? "deal" : "pos";
  return (
    <div className="flex h-[calc(100vh-5rem)] flex-col gap-2 lg:h-[calc(100vh-2.5rem)]">
      <div className="inline-flex shrink-0 self-start rounded-xl bg-gray-100 p-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setParams(t.id === "pos" ? {} : { tab: t.id }, { replace: true })}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-semibold transition ${
              tab === t.id ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}>
            <t.icon size={14}/>{t.label}
          </button>
        ))}
      </div>
      {tab === "pos" ? <PosReconPage embedded/> : <div className="min-h-0 flex-1 overflow-auto"><ErkhetSyncCheck embedded/></div>}
    </div>
  );
}
