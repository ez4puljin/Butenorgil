import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Loader2, CheckCircle2, AlertTriangle, ChevronDown, Layers } from "lucide-react";
import { api } from "../lib/api";

/* Хянах самбар → Барааны мэдээлэл: erxes ↔ Эрхэт идэвхтэй барааны тулгалт.
   Өгөгдлийг сервер өдөрт 3 удаа (06/12/18) автоматаар татаж мастер нэгтгэлийг шинэчилдэг —
   «Master»-ын гар ажил (хоёр экспорт + оруулалт + нэгтгэл). Энд гараар шууд ажиллуулж ч болно. */

interface Result {
  checked_at: string; source: string; erkhet_active: number; erkhet_inactive: number;
  erxes_active: number; erxes_deleted: number; both_active: number; issues: number;
  counts: Record<string, number>; groups: Record<string, any[]>;
  master?: { erkhet_file: string; erxes_file: string; erkhet_rows: number; erxes_rows: number };
}
interface Status { running: boolean; step: string; error: string; kind: string; finished_at: string | null }

const ORDER = ["erkhet_only", "erxes_deleted", "erxes_only", "erkhet_inactive", "name_diff", "price_diff", "barcode_diff"];

function ub(iso?: string | null) {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function money(n: number) { return `${Math.round(n).toLocaleString("en-US")}₮`; }

export default function ProductSyncCard() {
  const [res, setRes] = useState<Result | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [open, setOpen] = useState("");
  const [err, setErr] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get("/product-master/compare");
      setRes(r.data.result); setSt(r.data.status); setLabels(r.data.labels);
      return r.data.status as Status;
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "Ачаалж чадсангүй");
      return null;
    }
  }, []);

  const watch = useCallback(() => {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      const s = await load();
      if (!s?.running && poll.current) { clearInterval(poll.current); poll.current = null; }
    }, 3000);
  }, [load]);

  useEffect(() => {
    load().then(s => { if (s?.running) watch(); });
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [load, watch]);

  async function run(kind: "compare" | "master") {
    if (kind === "master" && !confirm("Эрхэт, erxes-ээс барааны жагсаалтыг татаж Мастер нэгтгэлийг шинэчлэх үү?")) return;
    setErr("");
    await api.post(kind === "master" ? "/product-master/master-auto/run" : "/product-master/compare/run");
    setSt(s => ({ ...(s as Status), running: true, step: "Эхэлж байна…" }));
    watch();
  }

  const bad = !!res && res.issues > 0;
  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900 sm:text-lg">Барааны мэдээлэл: erxes ↔ Эрхэт</h2>
        <div className="ml-auto flex gap-2">
          <button onClick={() => run("compare")} disabled={st?.running}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw size={12} className={st?.running && st.kind === "compare" ? "animate-spin" : ""}/>Тулгах
          </button>
          <button onClick={() => run("master")} disabled={st?.running}
            title="Эрхэт + erxes барааны жагсаалтыг татаж слотод хадгалаад Мастер нэгтгэл хийнэ (Master-ын гар ажил)"
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
            <Layers size={12}/>Мастер шинэчлэх
          </button>
        </div>
      </div>

      {st?.running && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-800">
          <Loader2 size={13} className="animate-spin"/>{st.step}
        </div>
      )}
      {(err || (st && !st.running && st.error)) && (
        <div className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{err || st?.error}</div>
      )}

      {!res ? (
        <div className="rounded-apple bg-white p-4 text-sm text-gray-500 shadow-sm">Тулгалт хараахан хийгдээгүй — «Тулгах» дарна уу.</div>
      ) : (
        <div className="rounded-apple bg-white p-4 shadow-sm">
          <div className="mb-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            <Stat label="Эрхэт идэвхтэй" v={res.erkhet_active} sub={`идэвхгүй ${res.erkhet_inactive.toLocaleString()}`}/>
            <Stat label="erxes идэвхтэй" v={res.erxes_active} sub={`устгагдсан ${res.erxes_deleted.toLocaleString()}`}/>
            <Stat label="Хоёуланд идэвхтэй" v={res.both_active}/>
            <Stat label="Зөрүү" v={res.issues} bad={bad}/>
          </div>
          <div className={`mb-2 flex items-center gap-1.5 text-xs ${bad ? "text-amber-700" : "text-emerald-700"}`}>
            {bad ? <AlertTriangle size={13}/> : <CheckCircle2 size={13}/>}
            {bad ? "Зөрүүтэй бараа байна — доорх бүлгийг дарж харна уу." : "Бүрэн таарсан."}
            <span className="ml-auto text-gray-400">
              {ub(res.checked_at)} · {res.source === "master" ? "мастер нэгтгэлтэй" : "зөвхөн тулгалт"}
            </span>
          </div>
          <div className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {ORDER.map(k => {
              const n = res.counts[k] ?? 0;
              const rows = res.groups[k] ?? [];
              return (
                <div key={k}>
                  <button disabled={!n} onClick={() => setOpen(o => o === k ? "" : k)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent">
                    <span className={`inline-block h-2 w-2 rounded-full ${n ? "bg-amber-400" : "bg-emerald-400"}`}/>
                    <span className={n ? "text-gray-900" : "text-gray-400"}>{labels[k] ?? k}</span>
                    <span className={`ml-auto font-mono text-xs font-semibold ${n ? "text-amber-700" : "text-gray-300"}`}>{n}</span>
                    {n > 0 && <ChevronDown size={13} className={`text-gray-400 transition ${open === k ? "rotate-180" : ""}`}/>}
                  </button>
                  {open === k && n > 0 && (
                    <div className="max-h-72 overflow-auto bg-gray-50/60 px-3 pb-2">
                      <table className="w-full text-xs">
                        <tbody>
                          {rows.slice(0, 300).map((r: any) => (
                            <tr key={r.code} className="border-t border-gray-100">
                              <td className="whitespace-nowrap py-1 pr-2 font-mono text-gray-600">{r.code}</td>
                              {"erkhet" in r ? (
                                <>
                                  <td className="py-1 pr-2 text-gray-700">{r.name ?? ""}</td>
                                  <td className="py-1 pr-2 text-gray-500">Эрхэт: <b>{typeof r.erkhet === "number" ? money(r.erkhet) : r.erkhet || "—"}</b></td>
                                  <td className="py-1 text-gray-500">erxes: <b>{typeof r.erxes === "number" ? money(r.erxes) : r.erxes || "—"}</b></td>
                                </>
                              ) : (
                                <>
                                  <td className="py-1 pr-2 text-gray-700">{r.name}</td>
                                  <td className="py-1 pr-2 text-gray-500">{r.category}</td>
                                  <td className="whitespace-nowrap py-1 text-right font-mono text-gray-600">{money(r.price || 0)}</td>
                                </>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {rows.length > 300 && <p className="pt-1 text-[11px] text-gray-400">Эхний 300 / {rows.length}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-gray-400">
            Сервер өдөрт 3 удаа (06:00, 12:00, 18:00) Эрхэт, erxes-ээс барааны жагсаалтыг автоматаар татаж Мастер нэгтгэлийг шинэчилнэ.
            {res.master && ` Сүүлд: ${res.master.erkhet_rows.toLocaleString()} Эрхэт + ${res.master.erxes_rows.toLocaleString()} erxes мөр.`}
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, v, sub, bad }: { label: string; v: number; sub?: string; bad?: boolean }) {
  return (
    <div className={`rounded-xl border p-2 ${bad ? "border-amber-200 bg-amber-50" : "border-gray-100 bg-gray-50/50"}`}>
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`text-lg font-bold ${bad ? "text-amber-700" : "text-gray-900"}`}>{v.toLocaleString()}</div>
      {sub && <div className="text-[10.5px] text-gray-400">{sub}</div>}
    </div>
  );
}
