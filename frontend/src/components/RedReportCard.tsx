import { useState } from "react";
import { Download, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";

/* Хянах самбар → Улайлтын тайлан: Эрхэтэд сөрөг үлдэгдэлтэй бараа. Өгөгдлийг RedBlockedSection татна —
   хэрэглэгч байршлаа сонгоод «Татах» дарахад л (байршил бүрийг ТУСАД НЬ, нэг тайланд олон байршил асуухад
   Эрхэт 5 мин боловсруулаад унасан тул). */

export interface Item {
  location: string; location_name: string; code: string; name: string; qty: number; amount: number;
  unit_cost: number; begin_qty: number; in_qty: number; out_qty: number;
}
export interface Result {
  checked_at: string; day: string; seconds: number; locations: { code: string; name: string }[];
  count: number; amount: number; by_location: Record<string, number>; items: Item[]; errors?: Record<string, string>;
}

function ub(iso?: string) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function n(v: number) { return v.toLocaleString("en-US", { maximumFractionDigits: 2 }); }

export default function RedReportCard({ res, loading, err }: { res: Result | null; loading: boolean; err: string }) {
  const [loc, setLoc] = useState("");
  const [dlErr, setDlErr] = useState("");

  async function download() {
    if (!res) return;
    setDlErr("");
    try {
      const r = await api.get("/red-report/xlsx", {
        params: { locations: res.locations.map(l => l.code).join(",") }, responseType: "blob", timeout: 60000,
      });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url; a.download = `Улайлт_тайлан_${(ub(res.checked_at) || "").replace(/[: ]/g, "-")}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
    } catch { setDlErr("Excel татаж чадсангүй"); }
  }

  const items = (res?.items ?? []).filter(i => !loc || i.location === loc);
  const bad = !!res && res.count > 0;
  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900 sm:text-base">Улайлтын тайлан</h3>
        {res && <span className="text-xs text-gray-400">{ub(res.checked_at)}-ийн байдлаар</span>}
        <button onClick={download} disabled={!res || !res.locations.length}
          className="ml-auto flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          <Download size={12}/>Excel
        </button>
      </div>

      {(err || dlErr) && <div className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{err || dlErr}</div>}

      {!res ? (
        <div className="rounded-apple bg-white p-4 text-sm text-gray-500 shadow-sm">
          {loading ? "Эрхэтээс байршил бүрээр татаж байна…" : "Улайлтын мэдээлэл алга."}
        </div>
      ) : (
        <div className="rounded-apple bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <button onClick={() => setLoc("")}
              className={`rounded-lg border px-2.5 py-1 text-xs ${!loc ? "border-gray-800 bg-gray-800 text-white" : "border-gray-200 text-gray-600"}`}>
              Бүгд <b>{res.count}</b>
            </button>
            {res.locations.map(l => (
              <button key={l.code} onClick={() => setLoc(l.code)}
                className={`rounded-lg border px-2.5 py-1 text-xs ${loc === l.code ? "border-rose-600 bg-rose-600 text-white"
                  : res.by_location[l.code] ? "border-rose-200 bg-rose-50 text-rose-700" : "border-gray-200 text-gray-500"}`}>
                {l.name} <b>{res.by_location[l.code] ?? 0}</b>
              </button>
            ))}
            <span className={`ml-auto flex items-center gap-1 text-xs ${bad ? "text-rose-600" : "text-emerald-600"}`}>
              {bad ? <AlertTriangle size={12}/> : <CheckCircle2 size={12}/>}{bad ? `${res.count} бараа улайсан` : "Улайсан бараа алга"}
            </span>
          </div>
          {res.errors && Object.keys(res.errors).length > 0 && (
            <p className="mb-2 text-[11px] text-amber-700">Татаж чадаагүй байршил: {Object.keys(res.errors).join(", ")}</p>
          )}
          {items.length > 0 && (
            <div className="max-h-96 overflow-auto rounded-xl border border-gray-100">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 text-[10.5px] uppercase text-gray-500">
                  <tr>
                    {["Байршил", "Код", "Нэр", "Эхний", "Орлого", "Зарлага", "Үлдэгдэл"].map((h, i) => (
                      <th key={h} className={`px-2 py-1.5 ${i >= 3 ? "text-right" : "text-left"}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map(i => (
                    <tr key={i.location + i.code} className="border-t border-gray-100">
                      <td className="px-2 py-1 text-gray-500">{i.location_name}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">{i.code}</td>
                      <td className="px-2 py-1 text-gray-800">{i.name}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-gray-500">{n(i.begin_qty)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-gray-500">{n(i.in_qty)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-gray-500">{n(i.out_qty)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono font-bold text-rose-600">{n(i.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
