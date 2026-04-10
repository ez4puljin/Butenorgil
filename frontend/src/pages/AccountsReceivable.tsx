import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { api } from "../lib/api";
import {
  RefreshCw, MessageSquare, Settings, CheckCircle2, XCircle, X,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

type CardDef = {
  id: string;
  title: string;
  logo: "erkhet" | "erxes" | "none";
  instruction: string[];
};

type ImportLogRow = {
  id: number;
  created_at: string;
  import_key: string;
  username?: string;
  filename: string;
  status: string;
  message: string;
};

type MergedRow = {
  code: string;
  name: string | null;
  phone: string | null;
  balance: number | null;
};

type MergedResult = {
  rows: MergedRow[];
  ar_file: string;
  ci_file: string;
  count: number;
};

type SmsConfig = {
  gateway_url: string;
  username: string;
  password: string;
};

type SendResult = {
  phone: string;
  name: string | null;
  ok: boolean;
  error?: string;
  status?: number;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const PAGE_KEYS = ["accounts_receivable", "customer_info"];

const cards: CardDef[] = [
  {
    id: "accounts_receivable",
    title: "Авлага өглөгө тайлан",
    logo: "erkhet",
    instruction: [
      "Эрхэт системээс авлага өглөгийн тайланг Эксел файлаар экспортлоно.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
  {
    id: "customer_info",
    title: "Харилцагчдын мэдээлэл",
    logo: "erkhet",
    instruction: [
      "Эрхэт системээс харилцагчдын мэдээллийг Эксел файлаар экспортлоно.",
      "Гарсан файлыг энд оруулна.",
    ],
  },
];

// ── Small components ───────────────────────────────────────────────────────────

function ErpLogoBadge({ logo }: { logo: CardDef["logo"] }) {
  if (logo === "none") return null;
  if (logo === "erxes") {
    return (
      <div className="absolute right-3 top-3 rounded-lg bg-[#5B2DBD] px-2 py-1 text-[10px] font-semibold tracking-wide text-white">
        Эрксэс
      </div>
    );
  }
  return (
    <div className="absolute right-3 top-3 rounded-lg bg-[#E8B12A] px-2 py-1 text-[10px] font-semibold tracking-wide text-gray-900">
      Эрхэт
    </div>
  );
}

function fmtBalance(val: number | null): string {
  if (val === null || val === undefined) return "-";
  return val.toLocaleString("mn-MN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AccountsReceivable() {
  const role     = localStorage.getItem("role");
  const isAdmin  = role === "admin";

  // Import logs (status display only)
  const [logs, setLogs] = useState<ImportLogRow[]>([]);

  // Merged table
  const [merged, setMerged]             = useState<MergedResult | null>(null);
  const [mergedLoading, setMergedLoading] = useState(false);
  const [mergedError, setMergedError]   = useState<string | null>(null);
  const [search, setSearch]             = useState("");

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // SMS config
  const [smsConfig, setSmsConfig]           = useState<SmsConfig>({ gateway_url: "", username: "", password: "" });
  const [smsConfigOpen, setSmsConfigOpen]   = useState(false);
  const [smsConfigDraft, setSmsConfigDraft] = useState<SmsConfig>({ gateway_url: "", username: "", password: "" });
  const [savingConfig, setSavingConfig]     = useState(false);

  // SMS-ийн тэмдэглэл — backend-д хадгалагдана (бүх PC-с харагдана)
  const [smsSent, setSmsSent] = useState<Set<string>>(new Set());

  // SMS compose
  const [composeOpen, setComposeOpen]       = useState(false);
  const [messageTemplate, setMessageTemplate] = useState("");
  const [sending, setSending]               = useState(false);
  const [sendResults, setSendResults]       = useState<SendResult[] | null>(null);

  // Indeterminate checkbox ref
  const selectAllRef = useRef<HTMLInputElement>(null);

  // ── Computed ───────────────────────────────────────────────────────────────

  const filteredRows = useMemo(() => {
    if (!merged) return [];
    const q = search.toLowerCase().trim();
    if (!q) return merged.rows;
    return merged.rows.filter(
      (r) =>
        (r.code  ?? "").toLowerCase().includes(q) ||
        (r.name  ?? "").toLowerCase().includes(q) ||
        (r.phone ?? "").toLowerCase().includes(q),
    );
  }, [merged, search]);

  const filteredWithPhone = useMemo(() => filteredRows.filter((r) => r.phone), [filteredRows]);

  const allFilteredChecked =
    filteredWithPhone.length > 0 && filteredWithPhone.every((r) => selected.has(r.code));
  const someFilteredChecked =
    !allFilteredChecked && filteredWithPhone.some((r) => selected.has(r.code));

  // All selected rows that actually have a phone (for sending)
  const selectedRecipients = useMemo(() => {
    if (!merged) return [];
    return merged.rows.filter((r) => selected.has(r.code) && r.phone);
  }, [merged, selected]);

  const previewMessage = useMemo(() => {
    if (!messageTemplate || selectedRecipients.length === 0) return "";
    const r = selectedRecipients[0];
    const balStr =
      r.balance !== null && r.balance !== undefined
        ? r.balance.toLocaleString("mn-MN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
        : "";
    return messageTemplate
      .replace(/\{Харилцагч_нэр\}/g, r.name || "")
      .replace(/\{нэр\}/g,             r.name || "")
      .replace(/\{код\}/g,             r.code || "")
      .replace(/\{Эцсийн_үлдэгдэл\}/g, balStr);
  }, [messageTemplate, selectedRecipients]);

  // Sync indeterminate state
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someFilteredChecked;
    }
  }, [someFilteredChecked]);

  // ── Data loaders ───────────────────────────────────────────────────────────

  const loadLogs = async () => {
    try {
      const res = await api.get("/imports/logs");
      setLogs((res.data as ImportLogRow[]).filter((r) => PAGE_KEYS.includes(r.import_key)));
    } catch { /* ignore */ }
  };

  const loadMerged = async () => {
    setMergedLoading(true);
    setMergedError(null);
    setSelected(new Set());
    try {
      const res = await api.get("/accounts-receivable/merged");
      setMerged(res.data);
    } catch (e: any) {
      setMergedError(e?.response?.data?.detail ?? "Мэдээлэл нэгтгэхэд алдаа гарлаа");
      setMerged(null);
    } finally {
      setMergedLoading(false);
    }
  };

  const loadSmsConfig = async () => {
    try {
      const res = await api.get("/accounts-receivable/sms-config");
      setSmsConfig(res.data);
    } catch { /* ignore */ }
  };

  const loadSmsSent = async () => {
    try {
      const res = await api.get("/accounts-receivable/sms-sent");
      setSmsSent(new Set<string>(res.data.codes));
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadLogs();
    loadMerged();
    loadSmsConfig();
    loadSmsSent();
  }, []);

  // ── Selection handlers ─────────────────────────────────────────────────────

  const toggleSelectAll = () => {
    if (allFilteredChecked) {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredWithPhone.forEach((r) => next.delete(r.code));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredWithPhone.forEach((r) => next.add(r.code));
        return next;
      });
    }
  };

  const toggleRow = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  // ── SMS Config handlers ────────────────────────────────────────────────────

  const openSmsConfig = () => {
    setSmsConfigDraft({ ...smsConfig });
    setSmsConfigOpen(true);
  };

  const saveSmsConfig = async () => {
    setSavingConfig(true);
    try {
      await api.put("/accounts-receivable/sms-config", smsConfigDraft);
      setSmsConfig({ ...smsConfigDraft });
      setSmsConfigOpen(false);
    } catch (e: any) {
      alert(e?.response?.data?.detail ?? "Хадгалахад алдаа гарлаа");
    } finally {
      setSavingConfig(false);
    }
  };

  // ── SMS Send handler ───────────────────────────────────────────────────────

  const sendSms = async () => {
    if (!messageTemplate.trim()) { alert("Мессеж бичнэ үү"); return; }
    if (selectedRecipients.length === 0) { alert("Утасны дугаартай харилцагч сонгоогүй байна"); return; }
    setSending(true);
    try {
      const res = await api.post("/accounts-receivable/send-sms", {
        recipients:       selectedRecipients.map((r) => ({ phone: r.phone, name: r.name, code: r.code, balance: r.balance })),
        message_template: messageTemplate,
        config:           smsConfig,
      });
      setSendResults(res.data.results);

      // Амжилттай илгээсэн харилцагчдыг backend-д тэмдэглэнэ
      const phoneToCode = new Map(selectedRecipients.map((r) => [r.phone, r.code]));
      const sentCodes: string[] = [];
      (res.data.results as SendResult[]).forEach((r) => {
        if (r.ok) {
          const code = phoneToCode.get(r.phone);
          if (code) sentCodes.push(code);
        }
      });
      if (sentCodes.length > 0) {
        await api.post("/accounts-receivable/sms-sent", { codes: sentCodes });
        setSmsSent((prev) => new Set([...prev, ...sentCodes]));
      }
    } catch (e: any) {
      alert(e?.response?.data?.detail ?? "SMS илгээхэд алдаа гарлаа");
    } finally {
      setSending(false);
    }
  };

  // ── Other helpers ──────────────────────────────────────────────────────────

  const latestByKey = useMemo(() => {
    const out: Record<string, ImportLogRow> = {};
    for (const row of logs) {
      if (!out[row.import_key]) out[row.import_key] = row;
    }
    return out;
  }, [logs]);

  const formatDate = (iso: string) => {
    if (!iso) return "-";
    const d = new Date(`${iso}Z`);
    if (Number.isNaN(d.getTime())) return String(iso).replace("T", " ").slice(0, 19);
    return d.toLocaleString("mn-MN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="text-xl font-semibold text-gray-900 sm:text-2xl">Авлага тайлан</div>
      <div className="mt-1 text-sm text-gray-500">Авлага өглөгө болон харилцагчдын мэдээлэл оруулах</div>

      {/* ── Import status (файлуудыг "Файл оруулалт" хуудсаас оруулна) ── */}
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {cards.map((c) => {
          const latest = latestByKey[c.id];
          return (
            <Card key={c.id} className="relative p-5">
              <ErpLogoBadge logo={c.logo} />
              <div className="text-base font-semibold text-gray-900">{c.title}</div>
              {latest ? (
                <div className="mt-3 flex items-start gap-2">
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-500" />
                  <div>
                    <div className="text-xs font-medium text-emerald-700">Файл оруулагдсан</div>
                    <div className="mt-0.5 text-xs text-gray-500 truncate max-w-[220px]">{latest.filename}</div>
                    <div className="text-xs text-gray-400">
                      {formatDate(latest.created_at)} · {(latest.username || "").replace(/\?/g, "").trim() || "Тодорхойгүй"}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex items-start gap-2">
                  <XCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                  <div className="text-xs text-red-600">
                    Файл оруулаагүй байна.{" "}
                    <a href="/imports" className="underline hover:text-red-800">
                      "Файл оруулалт"
                    </a>{" "}
                    хуудас руу орж оруулна уу.
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* ── Merged table ── */}
      <div className="mt-6 rounded-apple bg-white shadow-sm">
        {/* Toolbar */}
        <div className="flex flex-col gap-2 border-b border-gray-100 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:p-6">
          <div>
            <div className="text-base font-semibold text-gray-900 sm:text-lg">Нэгтгэсэн жагсаалт</div>
            {merged && (
              <div className="mt-0.5 text-xs text-gray-400 leading-tight">
                {merged.count} харилцагч · {merged.ar_file}
                <br className="sm:hidden" />
                <span className="hidden sm:inline"> + </span>
                {merged.ci_file}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Search — full width on mobile */}
            <input
              type="text"
              placeholder="Код, нэр, утас хайх..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-apple border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3] sm:w-52"
            />
            {/* Action buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={loadMerged}
                disabled={mergedLoading}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-apple border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 sm:flex-none"
              >
                <RefreshCw size={14} className={mergedLoading ? "animate-spin" : ""} />
                Шинэчлэх
              </button>
              {smsSent.size > 0 && (
                <button
                  onClick={async () => {
                    await api.delete("/accounts-receivable/sms-sent");
                    setSmsSent(new Set());
                  }}
                  title="SMS илгээсэн тэмдэглэл арилгах"
                  className="inline-flex items-center gap-1.5 rounded-apple border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 hover:bg-green-100"
                >
                  <X size={13} />
                  SMS ({smsSent.size})
                </button>
              )}
              <button
                onClick={openSmsConfig}
                title="SMS Gateway тохиргоо"
                className="inline-flex items-center gap-1.5 rounded-apple border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                <Settings size={14} />
              </button>
            </div>
          </div>
        </div>

        {mergedError && (
          <div className="mx-4 mt-3 rounded-apple bg-amber-50 px-4 py-3 text-sm text-amber-700">
            {mergedError}
          </div>
        )}

        {/* ── Mobile card view ── */}
        <div className="md:hidden">
          {/* Select all row */}
          {filteredWithPhone.length > 0 && (
            <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-2.5 text-xs text-gray-500">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allFilteredChecked}
                onChange={toggleSelectAll}
                className="h-4 w-4 rounded cursor-pointer accent-[#0071E3]"
              />
              <span>Бүгдийг сонгох ({filteredWithPhone.length} утастай)</span>
            </div>
          )}

          {mergedLoading ? (
            <div className="px-4 py-10 text-center text-sm text-gray-400">Уншиж байна...</div>
          ) : filteredRows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-gray-400">
              {merged
                ? "Хайлтад тохирох мэдээлэл олдсонгүй"
                : "Хоёр файлыг оруулсны дараа нэгтгэсэн мэдээлэл харагдана"}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredRows.map((r, i) => {
                const hasPhone  = !!r.phone;
                const isChecked = selected.has(r.code);
                const isSent    = smsSent.has(r.code);
                return (
                  <div
                    key={i}
                    onClick={() => hasPhone && toggleRow(r.code)}
                    className={`flex items-center gap-3 px-4 py-3 ${
                      isChecked ? "bg-blue-50" : isSent ? "bg-green-50" : ""
                    } ${hasPhone ? "cursor-pointer active:bg-gray-100" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={!hasPhone}
                      onChange={() => toggleRow(r.code)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 shrink-0 cursor-pointer rounded accent-[#0071E3] disabled:opacity-25"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className="line-clamp-1 text-sm font-medium text-gray-900">
                          {r.name ?? "-"}
                        </span>
                        <span className={`shrink-0 text-sm font-semibold tabular-nums ${
                          r.balance !== null && r.balance < 0 ? "text-red-600" : "text-gray-800"
                        }`}>
                          {fmtBalance(r.balance)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                        <span className="font-mono">{r.code}</span>
                        {r.phone && (
                          <>
                            <span>·</span>
                            <span className="font-mono">{r.phone}</span>
                            {isSent && <MessageSquare size={10} className="text-green-500" />}
                          </>
                        )}
                        {!r.phone && <span className="text-gray-300">утас байхгүй</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Desktop table view ── */}
        <div className="hidden md:block">
          <div className="max-h-[520px] overflow-auto rounded-b-apple border-t border-gray-100">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white shadow-sm">
                <tr className="text-left text-gray-500">
                  <th className="w-10 px-4 py-3">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allFilteredChecked}
                      onChange={toggleSelectAll}
                      disabled={filteredWithPhone.length === 0}
                      className="h-4 w-4 cursor-pointer rounded accent-[#0071E3] disabled:cursor-not-allowed disabled:opacity-30"
                    />
                  </th>
                  <th className="w-8 px-4 py-3">#</th>
                  <th className="px-4 py-3">Код</th>
                  <th className="px-4 py-3">Нэр</th>
                  <th className="px-4 py-3">Утасны дугаар</th>
                  <th className="px-4 py-3 text-right">Эцсийн үлдэгдэл</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {mergedLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-400">
                      Уншиж байна...
                    </td>
                  </tr>
                ) : filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-400">
                      {merged
                        ? "Хайлтад тохирох мэдээлэл олдсонгүй"
                        : "Хоёр файлыг оруулсны дараа нэгтгэсэн мэдээлэл харагдана"}
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((r, i) => {
                    const hasPhone  = !!r.phone;
                    const isChecked = selected.has(r.code);
                    return (
                      <tr
                        key={i}
                        className={`transition-colors ${
                          isChecked
                            ? "bg-blue-50 hover:bg-blue-100"
                            : smsSent.has(r.code)
                            ? "bg-green-50 hover:bg-green-100"
                            : "hover:bg-[#F5F5F7]"
                        } ${hasPhone ? "cursor-pointer" : ""}`}
                        onClick={() => hasPhone && toggleRow(r.code)}
                      >
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={!hasPhone}
                            onChange={() => toggleRow(r.code)}
                            className="h-4 w-4 cursor-pointer rounded accent-[#0071E3] disabled:cursor-not-allowed disabled:opacity-25"
                          />
                        </td>
                        <td className="px-4 py-3 text-gray-400">{i + 1}</td>
                        <td className="px-4 py-3 font-mono text-xs">{r.code}</td>
                        <td className="px-4 py-3">{r.name ?? "-"}</td>
                        <td className="px-4 py-3">
                          {r.phone ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs">{r.phone}</span>
                              {smsSent.has(r.code) && (
                                <MessageSquare size={11} className="shrink-0 text-green-500" />
                              )}
                            </div>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className={`px-4 py-3 text-right font-medium tabular-nums ${
                          r.balance !== null && r.balance < 0 ? "text-red-600" : "text-gray-800"
                        }`}>
                          {fmtBalance(r.balance)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Floating SMS action bar ── */}
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center justify-between gap-2 rounded-2xl bg-gray-900 px-5 py-3 text-white shadow-2xl sm:bottom-6 sm:w-auto sm:max-w-none sm:gap-3 sm:rounded-full sm:px-6">
          <span className="text-sm font-medium">
            {selected.size} сонгогдлоо
            {selected.size !== selectedRecipients.length && (
              <span className="ml-1.5 text-xs text-gray-400">
                ({selectedRecipients.length} утастай)
              </span>
            )}
          </span>
          <button
            onClick={() => { setSendResults(null); setComposeOpen(true); }}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#0071E3] px-4 py-1.5 text-sm font-medium hover:bg-blue-500 transition-colors"
          >
            <MessageSquare size={14} />
            SMS илгээх
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Цуцлах
          </button>
        </div>
      )}

      {/* ── SMS Config modal ── */}
      <Modal
        open={smsConfigOpen}
        title="SMS Gateway тохиргоо"
        onClose={() => setSmsConfigOpen(false)}
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Gateway URL</label>
            <input
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0071E3] focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
              placeholder="http://10.0.2.16:8080"
              value={isAdmin ? smsConfigDraft.gateway_url : smsConfig.gateway_url}
              disabled={!isAdmin}
              onChange={(e) => setSmsConfigDraft((p) => ({ ...p, gateway_url: e.target.value }))}
            />
            <p className="mt-1 text-xs text-gray-400">
              Android SMS Gateway апп суусан утасны IP хаяг
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Нэвтрэх нэр</label>
            <input
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0071E3] focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
              placeholder="sms"
              value={isAdmin ? smsConfigDraft.username : smsConfig.username}
              disabled={!isAdmin}
              onChange={(e) => setSmsConfigDraft((p) => ({ ...p, username: e.target.value }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Нууц үг</label>
            <input
              type="password"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0071E3] focus:outline-none disabled:bg-gray-50"
              placeholder="••••••••"
              value={isAdmin ? smsConfigDraft.password : smsConfig.password}
              disabled={!isAdmin}
              onChange={(e) => setSmsConfigDraft((p) => ({ ...p, password: e.target.value }))}
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
            onClick={() => setSmsConfigOpen(false)}
          >
            {isAdmin ? "Болих" : "Хаах"}
          </button>
          {isAdmin && (
            <button
              className="rounded-apple bg-[#0071E3] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-60"
              disabled={savingConfig}
              onClick={saveSmsConfig}
            >
              {savingConfig ? "Хадгалж байна..." : "Хадгалах"}
            </button>
          )}
        </div>
      </Modal>

      {/* ── SMS Compose modal ── */}
      <Modal
        open={composeOpen}
        title={sendResults ? "SMS илгээх — Үр дүн" : "SMS илгээх"}
        onClose={() => { setComposeOpen(false); setSendResults(null); }}
      >
        {sendResults ? (
          /* Results view */
          <>
            <div className="mb-4 flex gap-4">
              <div className="flex items-center gap-1.5 text-sm font-medium text-green-600">
                <CheckCircle2 size={16} />
                {sendResults.filter((r) => r.ok).length} амжилттай
              </div>
              <div className="flex items-center gap-1.5 text-sm font-medium text-red-500">
                <XCircle size={16} />
                {sendResults.filter((r) => !r.ok).length} амжилтгүй
              </div>
            </div>
            <div className="max-h-80 space-y-1.5 overflow-auto">
              {sendResults.map((r, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${
                    r.ok ? "bg-green-50" : "bg-red-50"
                  }`}
                >
                  {r.ok
                    ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-green-500" />
                    : <XCircle     size={15} className="mt-0.5 shrink-0 text-red-500" />}
                  <div>
                    <span className="font-mono text-xs">{r.phone}</span>
                    {r.name && <span className="ml-2 text-gray-600">{r.name}</span>}
                    {!r.ok && r.error && (
                      <div className="mt-0.5 text-xs text-red-400">{r.error}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end">
              <button
                className="rounded-apple bg-[#0071E3] px-5 py-2 text-sm text-white hover:opacity-90"
                onClick={() => {
                  setComposeOpen(false);
                  setSendResults(null);
                  setSelected(new Set());
                }}
              >
                Хаах
              </button>
            </div>
          </>
        ) : (
          /* Compose view */
          <>
            {/* Recipient summary */}
            <div className="mb-4 rounded-lg bg-[#F5F5F7] px-4 py-3 text-sm">
              <span className="font-medium text-gray-800">{selectedRecipients.length} харилцагч</span>
              <span className="text-gray-500"> руу SMS илгээгдэнэ</span>
              {selected.size > selectedRecipients.length && (
                <div className="mt-1 text-xs text-amber-600">
                  ⚠ {selected.size - selectedRecipients.length} харилцагч утасны дугааргүй тул илгээгдэхгүй
                </div>
              )}
            </div>

            {/* Message template */}
            <div className="mb-3">
              <label className="mb-1 block text-sm font-medium text-gray-700">Мессеж</label>
              <textarea
                rows={4}
                className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0071E3] focus:outline-none"
                placeholder="Мессеж бичнэ үү..."
                value={messageTemplate}
                onChange={(e) => setMessageTemplate(e.target.value)}
              />
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs text-gray-500">
                <span className="text-gray-400">💡 Хувьсагчид:</span>
                {["{нэр}", "{код}", "{Эцсийн_үлдэгдэл}", "{Харилцагч_нэр}"].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setMessageTemplate((t) => t + v)}
                    className="rounded bg-gray-100 px-1.5 py-0.5 font-mono hover:bg-blue-50 hover:text-[#0071E3] transition-colors"
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* Preview */}
            {messageTemplate && selectedRecipients.length > 0 && (
              <div className="mb-4">
                <div className="mb-1 text-xs font-medium text-gray-500">
                  Урьдчилан харах ({selectedRecipients[0].name ?? selectedRecipients[0].phone})
                </div>
                <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap">
                  {previewMessage}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                onClick={() => setComposeOpen(false)}
                disabled={sending}
              >
                Болих
              </button>
              <button
                className="inline-flex items-center gap-2 rounded-apple bg-[#0071E3] px-5 py-2 text-sm text-white hover:opacity-90 disabled:opacity-60"
                disabled={sending || selectedRecipients.length === 0 || !messageTemplate.trim()}
                onClick={sendSms}
              >
                <MessageSquare size={14} />
                {sending
                  ? "Илгээж байна..."
                  : `SMS илгээх (${selectedRecipients.length})`}
              </button>
            </div>
          </>
        )}
      </Modal>
    </motion.div>
  );
}
