import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2, PlugZap, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";

/* AI зарцуулалт (admin) — Claude API-ийн зардал: өнөөдөр / энэ сар, feature-ээр, хэрэглэгчээр.
   Сарын нийт нь chat-ийн хязгаарт (AI_MONTHLY_BUDGET_USD) хүрвэл chat зогсоно, падаан
   AI_INVOICE_BUDGET_USD хүртэл үргэлжилнэ (backend/app/ai). */

interface Group { key: string; calls: number; cost: number; in_tokens: number; out_tokens: number }
interface Summary {
  configured: boolean;
  models: { chat: string; invoice: string };
  budget: { chat: number; invoice: number; daily_questions: number };
  month: { from: string; cost: number; chat_blocked: boolean; all_blocked: boolean };
  today: { cost: number; questions: number };
  by_feature_today: Group[]; by_feature_month: Group[]; by_user_month: Group[]; by_model_month: Group[];
  daily: { date: string; calls: number; cost: number }[];
  errors_month: number;
  recent: { at: string; user: string; feature: string; model: string; in: number; out: number; cache_read: number;
            cache_write: number; cost: number; ok: boolean; error: string }[];
}

const FEATURE: Record<string, string> = { chat: "AI туслах", invoice: "Падаан AI", new_product: "Шинэ бараа", test: "Шалгалт" };
const usd = (v: number) => `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
const num = (v: number) => v.toLocaleString("en-US");
const ub = (iso: string) => new Date(iso).toLocaleString("mn-MN", { timeZone: "Asia/Ulaanbaatar", hour12: false });

export default function AiUsage() {
  const [d, setD] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [test, setTest] = useState<{ busy: boolean; msg: string; ok?: boolean }>({ busy: false, msg: "" });

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setD((await api.get("/ai-usage/summary")).data); }
    catch (e: any) { setErr(e?.response?.data?.detail ?? "Ачаалж чадсангүй"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function runTest() {
    setTest({ busy: true, msg: "" });
    try {
      const r = (await api.post("/ai-usage/test")).data;
      setTest({ busy: false, ok: true, msg: `«${r.reply}» — ${r.model}, ${r.in}+${r.out} токен, ${usd(r.cost)}` });
      load();
    } catch (e: any) {
      setTest({ busy: false, ok: false, msg: e?.response?.data?.detail ?? "Алдаа" });
      load();
    }
  }

  const pct = d ? Math.min(100, (d.month.cost / d.budget.invoice) * 100) : 0;
  const chatMark = d ? (d.budget.chat / d.budget.invoice) * 100 : 0;

  return (
    <div className="mx-auto max-w-6xl p-3 md:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold text-gray-900">AI зарцуулалт</h1>
        <div className="ml-auto flex gap-2">
          <button onClick={runTest} disabled={test.busy}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 disabled:opacity-50">
            {test.busy ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}Холболт шалгах
          </button>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />Шинэчлэх
          </button>
        </div>
      </div>

      {test.msg && (
        <div className={`mb-3 flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${test.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>
          {test.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
          <span>{test.msg}</span>
        </div>
      )}
      {err && <div className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}

      {d && (
        <>
          {!d.configured && (
            <div className="mb-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>AI тохируулагдаагүй: <b>backend/.env</b> файлд <code>ANTHROPIC_API_KEY=...</code> мөр нэмээд серверийг дахин асаана уу.</span>
            </div>
          )}
          {d.month.chat_blocked && (
            <div className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">
              Сарын хязгаар ${d.budget.chat}-д хүрсэн — AI туслах зогссон.
              {d.month.all_blocked ? " Падаан ч зогссон." : ` Падаан $${d.budget.invoice} хүртэл ажиллана.`}
            </div>
          )}

          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Өнөөдөр" value={usd(d.today.cost)} sub={`${d.today.questions} асуулт`} />
            <Tile label={`Энэ сар (${d.month.from}-аас)`} value={usd(d.month.cost)}
              sub={`хязгаар: chat $${d.budget.chat} · падаан $${d.budget.invoice}`} />
            <Tile label="Загвар" value={d.models.chat} sub={`падаан: ${d.models.invoice}`} small />
            <Tile label="Энэ сарын алдаа" value={String(d.errors_month)}
              sub={`өдөрт хүн бүр ${d.budget.daily_questions} асуулт`} />
          </div>

          <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
            <div className="mb-1 flex justify-between text-[11px] text-gray-500">
              <span>Сарын зарцуулалт</span><span>{usd(d.month.cost)} / ${d.budget.invoice}</span>
            </div>
            <div className="relative h-2.5 overflow-hidden rounded-full bg-gray-100">
              <div className={`h-full ${d.month.chat_blocked ? "bg-rose-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${pct}%` }} />
              <div className="absolute top-0 h-full w-px bg-gray-500" style={{ left: `${chatMark}%` }} title="chat-ийн хязгаар" />
            </div>
          </div>

          <div className="mb-4 grid gap-3 lg:grid-cols-3">
            <GroupTable title="Өнөөдөр — төрлөөр" rows={d.by_feature_today} label={k => FEATURE[k] ?? k} />
            <GroupTable title="Энэ сар — төрлөөр" rows={d.by_feature_month} label={k => FEATURE[k] ?? k} />
            <GroupTable title="Энэ сар — хэрэглэгчээр" rows={d.by_user_month} label={k => k} />
          </div>

          <div className="mb-4 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-gray-200 bg-white p-3 lg:col-span-1">
              <div className="mb-2 text-xs font-semibold text-gray-700">Өдрөөр (энэ сар)</div>
              {d.daily.length === 0 ? <Empty /> : (
                <table className="w-full text-xs">
                  <tbody>
                    {d.daily.map(r => (
                      <tr key={r.date} className="border-t border-gray-50">
                        <td className="py-1 text-gray-600">{r.date}</td>
                        <td className="py-1 text-right text-gray-500">{num(r.calls)}</td>
                        <td className="py-1 text-right font-medium">{usd(r.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white p-3 lg:col-span-2">
              <div className="mb-2 text-xs font-semibold text-gray-700">Сүүлийн 50 дуудлага</div>
              {d.recent.length === 0 ? <Empty /> : (
                <table className="w-full min-w-[560px] text-xs">
                  <thead>
                    <tr className="text-left text-[11px] text-gray-400">
                      <th className="py-1 font-medium">Цаг</th><th className="font-medium">Хэн</th><th className="font-medium">Төрөл</th>
                      <th className="text-right font-medium">Оролт</th><th className="text-right font-medium">Cache</th>
                      <th className="text-right font-medium">Гаралт</th><th className="text-right font-medium">$</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.recent.map((r, i) => (
                      <tr key={i} className="border-t border-gray-50 align-top">
                        <td className="whitespace-nowrap py-1 text-gray-500">{ub(r.at)}</td>
                        <td className="py-1">{r.user}</td>
                        <td className="py-1">
                          {FEATURE[r.feature] ?? r.feature}
                          {!r.ok && <div className="text-[11px] text-rose-600">{r.error}</div>}
                        </td>
                        <td className="py-1 text-right">{num(r.in)}</td>
                        <td className="py-1 text-right text-gray-400">{r.cache_read ? num(r.cache_read) : ""}</td>
                        <td className="py-1 text-right">{num(r.out)}</td>
                        <td className="py-1 text-right font-medium">{usd(r.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, small }: { label: string; value: string; sub?: string; small?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`font-bold text-gray-900 ${small ? "text-sm" : "text-xl"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-gray-400">{sub}</div>}
    </div>
  );
}

function GroupTable({ title, rows, label }: { title: string; rows: Group[]; label: (k: string) => string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="mb-2 text-xs font-semibold text-gray-700">{title}</div>
      {rows.length === 0 ? <Empty /> : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[11px] text-gray-400">
              <th className="py-1 font-medium" /><th className="text-right font-medium">Дуудлага</th>
              <th className="text-right font-medium">Токен</th><th className="text-right font-medium">$</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key} className="border-t border-gray-50">
                <td className="py-1">{label(r.key)}</td>
                <td className="py-1 text-right text-gray-500">{num(r.calls)}</td>
                <td className="py-1 text-right text-gray-500">{num(r.in_tokens + r.out_tokens)}</td>
                <td className="py-1 text-right font-medium">{usd(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Empty() {
  return <div className="py-3 text-center text-xs text-gray-400">Одоогоор дуудлага алга</div>;
}
