import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, ExternalLink, RefreshCw, UploadCloud } from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";

/* ═══════════════════════════════════════════════════════════════════════════
   Эрхэт рүү ERP Excel-ийг ШУУД импортлох — дундын hook + харагдац.
   basePath: "/receivings/12" гэх мэт; сервер дээр {basePath}/erkhet-import,
   {basePath}/erkhet-imports, {basePath}/erkhet-imports/{id}/refresh байх ёстой.
   Эрхэт импортыг «Ажлын захиалга» (queue)-д оруулдаг тул дуусах хүртэл 5 сек тутам шалгана.
   ═══════════════════════════════════════════════════════════════════════════ */

export type ErkhetLog = {
  id: number; brand: string; title: string; status: string; queue_id: number | null; erkhet_import_id: number | null;
  erkhet_status: string; doc_count: number; row_count: number; message: string; username: string; created_at: string | null;
};
export type ErkhetRes = ErkhetLog & { ok: boolean | null; errors: string[]; erkhet_url?: string; period?: number };

export const ERKHET_IMPORT_ROLES = ["admin", "accountant", "supervisor"];

const fmtWhen = (s: string | null) => {
  if (!s) return "";
  const d = new Date(s); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const erkhetStatusText = (x: ErkhetLog) =>
  x.status === "ok" ? `Амжилттай${x.erkhet_import_id ? ` · Эрхэт #${x.erkhet_import_id}` : ""}${x.doc_count ? ` · ${x.doc_count} баримт` : ""}`
  : x.status === "fail" ? `Алдаатай${x.message ? `: ${x.message}` : ""}`
  : x.status === "queued" ? `Эрхэтийн дараалалд${x.erkhet_status ? ` (${x.erkhet_status})` : ""}` : "Тодорхойгүй — Эрхэтээс шалгана уу";

export function useErkhetImport(basePath: string, brand: string) {
  const { role, baseRole } = useAuthStore();
  const allowed = ERKHET_IMPORT_ROLES.includes((baseRole || role || "") as string);
  const [prev, setPrev] = useState<ErkhetLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ErkhetRes | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPrev = useCallback(async () => {
    try { const r = await api.get(`${basePath}/erkhet-imports`, { params: { brand } }); setPrev(r.data); } catch { /* мэдээлэл л */ }
  }, [basePath, brand]);
  useEffect(() => { if (allowed) loadPrev(); }, [allowed, loadPrev]);

  // Queue-д хүлээгдэж байвал дуусах хүртэл 5 сек тутам шалгана (~10 мин)
  useEffect(() => {
    if (!res || (res.status !== "queued" && res.status !== "unknown")) return;
    let n = 0;
    const t = setInterval(async () => {
      n += 1;
      try {
        const r = await api.post(`${basePath}/erkhet-imports/${res.id}/refresh`);
        setRes((p) => p && ({ ...p, ...r.data, erkhet_url: p.erkhet_url, period: p.period }));
        if (r.data?.status === "ok" || r.data?.status === "fail") loadPrev();
      } catch { /* дараагийн удаа */ }
      if (n >= 120) clearInterval(t);
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res?.id, res?.status]);

  /** body — ERP Excel-ийн тохиргоо; summary — баталгаажуулах асуултад харуулах мөр. */
  const run = async (body: Record<string, unknown>, summary: string, force = false): Promise<void> => {
    setError(null); setRes(null);
    if (!force && !confirm(`Эрхэт → «Бараа материалын орлого» импорт руу ШУУД илгээх үү?\n\n${summary}\nГарчиг: ERP Excel-ийн файлын нэр\n\nИлгээмэгц Эрхэт дээр орлого бүртгэгдэнэ.`)) return;
    setBusy(true);
    try {
      const r = await api.post(`${basePath}/erkhet-import`, { ...body, force });
      setRes(r.data);
      loadPrev();
    } catch (e: any) {
      const d = e?.response?.data;
      if (e?.response?.status === 409 && Array.isArray(d?.previous)) {
        const lines = d.previous.map((x: ErkhetLog) => `• ${fmtWhen(x.created_at)} ${x.username} — ${erkhetStatusText(x)}`).join("\n");
        if (confirm(`⚠ ${d.detail}\n\n${lines}\n\nДахин импортлох уу? (Эрхэт дээр орлого ДАВХАР бүртгэгдэнэ)`)) {
          setBusy(false);
          return run(body, summary, true);
        }
      } else {
        setError(typeof d?.detail === "string" ? d.detail : "Эрхэт рүү импортлоход алдаа гарлаа");
      }
    } finally {
      setBusy(false);
    }
  };

  return { allowed, prev, busy, res, error, run };
}

/** Өмнөх импортын анхааруулга + үр дүн + алдаа. */
export function ErkhetImportStatus({ prev, res, error, subject }: {
  prev: ErkhetLog[]; res: ErkhetRes | null; error: string | null; subject: string;
}) {
  return (
    <>
      {prev.length > 0 && !res && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <div className="mb-1 font-semibold">Энэ {subject} Эрхэт рүү өмнө илгээсэн:</div>
          {prev.slice(0, 4).map((x) => <div key={x.id}>• {fmtWhen(x.created_at)} · {x.username} · {erkhetStatusText(x)}</div>)}
        </div>
      )}
      {res && (
        <div className={`rounded-lg px-3 py-2.5 text-sm ${res.ok === true ? "bg-emerald-50 text-emerald-800" : res.ok === false ? "bg-red-50 text-red-700" : res.status === "queued" ? "bg-sky-50 text-sky-800" : "bg-amber-50 text-amber-800"}`}>
          <div className="flex items-center gap-2 font-semibold">
            {res.ok === true ? <CheckCircle2 size={16} /> : res.status === "queued" ? <RefreshCw size={15} className="animate-spin" /> : <AlertCircle size={16} />}
            {res.ok === true ? "Эрхэтэд амжилттай импортлогдлоо"
              : res.ok === false ? "Эрхэт импортыг амжилтгүй болгосон — орлого бүртгэгдээгүй"
              : res.status === "queued" ? "Эрхэтийн «Ажлын захиалга»-д орсон — ажиллаж байна…"
              : "Үр дүн тодорхойгүй — Эрхэтийн «Ажлын захиалга»-аас шалгана уу"}
          </div>
          <div className="mt-1 text-xs">«{res.title}» · {res.row_count} мөр
            {res.erkhet_import_id ? ` · Эрхэт импорт #${res.erkhet_import_id}` : ""}{res.doc_count ? ` · ${res.doc_count} баримт` : ""}</div>
          {(res.queue_id || res.erkhet_status) && (
            <div className="mt-0.5 text-xs">Ажлын захиалга{res.queue_id ? ` #${res.queue_id}` : ""}{res.erkhet_status ? ` · ${res.erkhet_status}` : ""}{res.period ? ` · Тайлант үе ${res.period}` : ""}</div>
          )}
          {res.errors?.length > 0 && <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs">{res.errors.map((m, i) => <li key={i}>{m}</li>)}</ul>}
          {res.erkhet_url && (
            <a href={res.erkhet_url} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold underline">
              Эрхэтийн «Ажлын захиалга» <ExternalLink size={11} />
            </a>
          )}
        </div>
      )}
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 ring-1 ring-inset ring-red-200/60">{error}</div>}
    </>
  );
}

/** «Эрхэт рүү импортлох» товч. */
export function ErkhetImportButton({ onClick, busy, disabled, title, className = "" }: {
  onClick: () => void; busy: boolean; disabled?: boolean; title?: string; className?: string;
}) {
  return (
    <button onClick={onClick} disabled={busy || disabled} title={title}
      className={`inline-flex items-center justify-center gap-1.5 bg-violet-600 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-40 ${className}`}>
      {busy ? <RefreshCw size={13} className="animate-spin" /> : <UploadCloud size={13} />}
      {busy ? "Эрхэт рүү илгээж байна…" : "Эрхэт рүү импортлох"}
    </button>
  );
}
