import { useEffect, useRef, useState } from "react";
import {
  Upload, Trash2, ChevronRight, RefreshCw, EyeOff, Eye,
  Landmark, X, Check, AlertCircle, FileText,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ──────────────────────────────────────────────────────────────────

interface Statement {
  id: number;
  account_number: string;
  currency: string;
  date_from: string | null;
  date_to: string | null;
  filename: string;
  uploaded_at: string;
  txn_count: number;
  total_credit: number;
  total_debit: number;
  filled_count: number;
}

interface Txn {
  id: number;
  txn_date: string | null;
  debit: number;
  credit: number;
  bank_description: string;
  bank_counterpart: string;
  is_fee: boolean;
  partner_name: string;
  partner_account: string;
  custom_description: string;
  action: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtMnt(n: number) {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}сая`;
  return n.toLocaleString("mn-MN");
}
function fmtDate(s: string | null) {
  if (!s) return "—";
  return s.replace("T", " ").slice(0, 16);
}
function fmtShort(s: string | null) {
  if (!s) return "—";
  return s.slice(0, 10);
}

// ── EditCell — inline editable text cell ───────────────────────────────────

function EditCell({
  value,
  placeholder,
  onSave,
  className = "",
}: {
  value: string;
  placeholder: string;
  onSave: (v: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== value) onSave(draft);
  }

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        className={`w-full rounded border border-blue-400 bg-white px-1.5 py-0.5 text-[11px] outline-none ring-2 ring-blue-200 ${className}`}
      />
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      title="Засах"
      className={`cursor-pointer rounded px-1.5 py-0.5 text-[11px] hover:bg-blue-50 hover:text-blue-700 min-h-[22px] ${
        value ? "text-gray-800" : "text-gray-300 italic"
      } ${className}`}
    >
      {value || placeholder}
    </div>
  );
}

// ── ActionSelect ────────────────────────────────────────────────────────────

function ActionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const colors: Record<string, string> = {
    close:  "bg-red-50   text-red-700   border-red-200",
    create: "bg-green-50 text-green-700 border-green-200",
    "":     "bg-gray-50  text-gray-400  border-gray-200",
  };
  const labels: Record<string, string> = {
    close: "Хаах", create: "Үүсгэх", "": "—",
  };
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={`rounded border px-1.5 py-0.5 text-[11px] font-medium outline-none focus:ring-2 focus:ring-blue-200 cursor-pointer ${
        colors[value] ?? colors[""]
      }`}
    >
      <option value="">—</option>
      <option value="close">Хаах</option>
      <option value="create">Үүсгэх</option>
    </select>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function BankStatementPage() {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [selected,   setSelected]   = useState<number | null>(null);
  const [txns,       setTxns]       = useState<Txn[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const [showFees,   setShowFees]   = useState(false);
  const [err,        setErr]        = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // ── Load list ────────────────────────────────────────────────────────────

  async function loadList() {
    try {
      const r = await api.get("/bank-statements/");
      setStatements(r.data);
    } catch {
      setErr("Жагсаалт ачаалах амжилтгүй");
    }
  }

  useEffect(() => { loadList(); }, []);

  // ── Select statement ─────────────────────────────────────────────────────

  async function selectStmt(id: number) {
    setSelected(id);
    setLoading(true);
    setErr("");
    try {
      const r = await api.get(`/bank-statements/${id}`);
      setTxns(r.data.transactions ?? []);
    } catch {
      setErr("Хуулга ачаалах амжилтгүй");
    } finally {
      setLoading(false);
    }
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setErr("");
    let lastId: number | null = null;
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        const r = await api.post("/bank-statements/upload", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        lastId = r.data.id;
      } catch (e: any) {
        setErr(`${f.name}: ${e?.response?.data?.detail ?? "алдаа"}`);
      }
    }
    await loadList();
    if (lastId) selectStmt(lastId);
    setUploading(false);
  }

  // ── Delete statement ─────────────────────────────────────────────────────

  async function deleteStmt(id: number) {
    if (!confirm("Энэ хуулгыг устгах уу?")) return;
    try {
      await api.delete(`/bank-statements/${id}`);
      if (selected === id) { setSelected(null); setTxns([]); }
      loadList();
    } catch {
      setErr("Устгах амжилтгүй");
    }
  }

  // ── Update transaction field ─────────────────────────────────────────────

  async function updateTxn(stmtId: number, txnId: number, patch: Partial<Txn>) {
    try {
      const r = await api.patch(`/bank-statements/${stmtId}/transactions/${txnId}`, patch);
      setTxns(prev => prev.map(t => t.id === txnId ? { ...t, ...r.data } : t));
      // Refresh statement summary in list
      setStatements(prev => prev.map(s => {
        if (s.id !== stmtId) return s;
        const updated = txns.map(t => t.id === txnId ? { ...t, ...r.data } : t);
        return { ...s, filled_count: updated.filter(t => t.partner_name || t.action).length };
      }));
    } catch {
      setErr("Хадгалах амжилтгүй");
    }
  }

  // ── Derived ──────────────────────────────────────────────────────────────

  const stmt = statements.find(s => s.id === selected) ?? null;
  const visibleTxns = showFees ? txns : txns.filter(t => !t.is_fee);
  const totalCredit = txns.filter(t => !t.is_fee).reduce((s, t) => s + t.credit, 0);
  const totalDebit  = txns.filter(t => !t.is_fee).reduce((s, t) => s + t.debit,  0);
  const filledCount = txns.filter(t => !t.is_fee && (t.partner_name || t.action)).length;
  const mainCount   = txns.filter(t => !t.is_fee).length;

  // ── Drag-drop handlers ───────────────────────────────────────────────────

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-3 overflow-hidden lg:h-[calc(100vh-2rem)]">

      {/* ── Left panel: statement list ──────────────────────────────────── */}
      <aside className="flex w-64 shrink-0 flex-col rounded-2xl bg-white shadow-sm">
        {/* Header */}
        <div className="border-b border-gray-100 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Landmark size={16} className="text-blue-500 shrink-0" />
            <span className="text-sm font-bold text-gray-900">Тооцоо хаах</span>
          </div>
          <p className="mt-0.5 text-[11px] text-gray-400">Хаанбанк хуулга</p>
        </div>

        {/* Upload button */}
        <div className="px-3 pt-3">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            multiple
            className="hidden"
            onChange={e => uploadFiles(e.target.files)}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0071E3] px-3 py-2.5 text-[12px] font-semibold text-white shadow-sm active:bg-blue-700 disabled:opacity-60"
          >
            {uploading
              ? <><RefreshCw size={13} className="animate-spin" /> Оруулж байна…</>
              : <><Upload size={13} /> Файл оруулах</>
            }
          </button>
        </div>

        {/* Statement list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1 mt-2">
          {statements.length === 0 && !uploading && (
            <div className="mt-6 px-3 text-center text-[12px] text-gray-400">
              Excel файл оруулаад эхэл
            </div>
          )}
          {statements.map(s => {
            const active = s.id === selected;
            const pct = s.txn_count > 0 ? Math.round((s.filled_count / s.txn_count) * 100) : 0;
            return (
              <div
                key={s.id}
                onClick={() => selectStmt(s.id)}
                className={`group relative cursor-pointer rounded-xl p-3 transition-colors ${
                  active ? "bg-[#0071E3] text-white" : "hover:bg-gray-50 text-gray-800"
                }`}
              >
                {/* Delete btn */}
                <button
                  onClick={e => { e.stopPropagation(); deleteStmt(s.id); }}
                  className={`absolute right-2 top-2 hidden rounded p-1 group-hover:flex ${
                    active ? "text-white/70 hover:bg-white/20" : "text-gray-400 hover:bg-red-50 hover:text-red-500"
                  }`}
                >
                  <Trash2 size={12} />
                </button>

                <div className={`text-[13px] font-bold ${active ? "text-white" : "text-gray-900"}`}>
                  {s.account_number}
                </div>
                <div className={`text-[11px] mt-0.5 ${active ? "text-blue-100" : "text-gray-400"}`}>
                  {fmtShort(s.date_from)} – {fmtShort(s.date_to)}
                </div>
                <div className={`mt-1 flex gap-3 text-[11px] ${active ? "text-blue-100" : "text-gray-500"}`}>
                  <span>↓ {fmtMnt(s.total_credit)}</span>
                  <span>↑ {fmtMnt(s.total_debit)}</span>
                </div>
                {/* Progress bar */}
                <div className={`mt-1.5 h-1 rounded-full ${active ? "bg-white/30" : "bg-gray-100"}`}>
                  <div
                    className={`h-1 rounded-full transition-all ${active ? "bg-white" : "bg-[#0071E3]"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className={`mt-0.5 text-[10px] ${active ? "text-blue-100" : "text-gray-400"}`}>
                  {s.filled_count}/{s.txn_count} бөглөсөн
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* ── Right panel: transaction table ─────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col rounded-2xl bg-white shadow-sm overflow-hidden">
        {/* Empty state / drop zone */}
        {!selected && (
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={`flex flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition-colors ${
              dragOver ? "border-blue-400 bg-blue-50" : "border-gray-200 hover:border-blue-300 hover:bg-gray-50"
            }`}
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50">
              <FileText size={28} className="text-blue-400" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-700">Excel файл оруулах</p>
              <p className="mt-0.5 text-[12px] text-gray-400">Чирж оруулах эсвэл дарж сонгоно уу</p>
              <p className="mt-1 text-[11px] text-gray-300">Statement_MNT_XXXXXXXXXX.xlsx формат</p>
            </div>
            {uploading && (
              <div className="flex items-center gap-2 text-[12px] text-blue-600">
                <RefreshCw size={13} className="animate-spin" /> Оруулж байна…
              </div>
            )}
          </div>
        )}

        {/* Statement loaded */}
        {selected && stmt && (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 shrink-0 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-bold text-gray-900">{stmt.account_number}</span>
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">{stmt.currency}</span>
                </div>
                <p className="text-[11px] text-gray-400">
                  {fmtShort(stmt.date_from)} – {fmtShort(stmt.date_to)}
                  &ensp;·&ensp;{stmt.filename}
                </p>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 text-[12px]">
                <div className="text-center">
                  <div className="font-bold text-green-600">{fmtMnt(totalCredit)}</div>
                  <div className="text-gray-400">Кредит</div>
                </div>
                <div className="text-center">
                  <div className="font-bold text-red-600">{fmtMnt(totalDebit)}</div>
                  <div className="text-gray-400">Дебит</div>
                </div>
                <div className="text-center">
                  <div className="font-bold text-gray-700">{filledCount}/{mainCount}</div>
                  <div className="text-gray-400">Бөглөсөн</div>
                </div>
              </div>

              {/* Toggle fee rows */}
              <button
                onClick={() => setShowFees(v => !v)}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[11px] font-medium transition-colors ${
                  showFees ? "border-amber-200 bg-amber-50 text-amber-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"
                }`}
              >
                {showFees ? <Eye size={12}/> : <EyeOff size={12}/>}
                {showFees ? "Шимтгэл харуулж байна" : "Шимтгэл нуусан"}
              </button>
            </div>

            {/* Error */}
            {err && (
              <div className="mx-4 mt-2 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 shrink-0">
                <AlertCircle size={14} className="shrink-0"/>
                {err}
                <button onClick={() => setErr("")} className="ml-auto"><X size={12}/></button>
              </div>
            )}

            {/* Loading */}
            {loading && (
              <div className="flex flex-1 items-center justify-center text-[13px] text-gray-400">
                <RefreshCw size={16} className="animate-spin mr-2" /> Ачаалж байна…
              </div>
            )}

            {/* Table */}
            {!loading && (
              <div className="flex-1 overflow-auto">
                <table className="w-full min-w-[900px] border-collapse text-[12px]">
                  <thead className="sticky top-0 z-10 bg-gray-50">
                    <tr>
                      <th className="w-8 border-b border-gray-100 px-2 py-2 text-center font-semibold text-gray-500">#</th>
                      <th className="border-b border-gray-100 px-2 py-2 text-left font-semibold text-gray-500 whitespace-nowrap">Огноо</th>
                      <th className="border-b border-gray-100 px-2 py-2 text-right font-semibold text-green-600 whitespace-nowrap">Кредит ₮</th>
                      <th className="border-b border-gray-100 px-2 py-2 text-right font-semibold text-red-500 whitespace-nowrap">Дебит ₮</th>
                      <th className="border-b border-gray-100 px-2 py-2 text-left font-semibold text-gray-500">Банкны утга</th>
                      <th className="border-b border-gray-100 px-2 py-2 text-left font-semibold text-gray-500 whitespace-nowrap">Харьцсан данс</th>
                      {/* Editable */}
                      <th className="border-b border-l border-gray-200 px-2 py-2 text-left font-semibold text-blue-600 whitespace-nowrap">Харилцагч</th>
                      <th className="border-b border-gray-100 px-2 py-2 text-left font-semibold text-blue-600 whitespace-nowrap">Данс</th>
                      <th className="border-b border-gray-100 px-2 py-2 text-left font-semibold text-blue-600">Тайлбар</th>
                      <th className="border-b border-gray-100 px-2 py-2 text-center font-semibold text-blue-600 whitespace-nowrap">Үйлдэл</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTxns.map((t, i) => {
                      const isFee = t.is_fee;
                      const isCredit = t.credit > 0;
                      const rowBg = isFee
                        ? "bg-gray-50/50 opacity-60"
                        : isCredit
                          ? "hover:bg-green-50/30"
                          : "hover:bg-red-50/20";
                      const filled = t.partner_name || t.action;
                      return (
                        <tr key={t.id} className={`border-b border-gray-50 transition-colors ${rowBg}`}>
                          {/* # */}
                          <td className="px-2 py-1.5 text-center text-[11px] text-gray-300">{i + 1}</td>
                          {/* Date */}
                          <td className="px-2 py-1.5 whitespace-nowrap text-[11px] text-gray-600">
                            {fmtDate(t.txn_date)}
                          </td>
                          {/* Credit */}
                          <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                            {t.credit > 0 ? (
                              <span className="text-green-600">{t.credit.toLocaleString("mn-MN")}</span>
                            ) : "—"}
                          </td>
                          {/* Debit */}
                          <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                            {t.debit > 0 ? (
                              <span className="text-red-500">{t.debit.toLocaleString("mn-MN")}</span>
                            ) : "—"}
                          </td>
                          {/* Bank description */}
                          <td className="max-w-[180px] px-2 py-1.5">
                            <div className="truncate text-gray-600" title={t.bank_description}>
                              {t.bank_description || "—"}
                            </div>
                          </td>
                          {/* Bank counterpart */}
                          <td className="px-2 py-1.5 whitespace-nowrap text-[11px] text-gray-500 font-mono">
                            {t.bank_counterpart || "—"}
                          </td>

                          {/* ── Editable columns ────────────────────────── */}
                          {/* Border separator */}
                          <td className="border-l border-gray-200 px-1 py-1.5 min-w-[120px]">
                            <EditCell
                              value={t.partner_name}
                              placeholder="Харилцагч…"
                              onSave={v => updateTxn(selected!, t.id, { partner_name: v })}
                            />
                          </td>
                          <td className="px-1 py-1.5 min-w-[90px]">
                            <EditCell
                              value={t.partner_account}
                              placeholder="Данс…"
                              onSave={v => updateTxn(selected!, t.id, { partner_account: v })}
                            />
                          </td>
                          <td className="px-1 py-1.5 min-w-[140px]">
                            <EditCell
                              value={t.custom_description}
                              placeholder="Тайлбар…"
                              onSave={v => updateTxn(selected!, t.id, { custom_description: v })}
                            />
                          </td>
                          {/* Action */}
                          <td className="px-2 py-1.5 text-center">
                            <ActionSelect
                              value={t.action}
                              onChange={v => updateTxn(selected!, t.id, { action: v })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {visibleTxns.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                    <Check size={32} className="mb-2 text-green-400" />
                    <p className="text-[13px]">Гүйлгээ байхгүй</p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
