import { useEffect, useRef, useState } from "react";
import {
  Sparkles, Send, RefreshCw, AlertCircle, X, Wrench, User as UserIcon, Copy, Check, MessageSquarePlus, Square,
} from "lucide-react";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/authStore";
import Markdown from "./Markdown";

/* AI туслахын чат (Claude) — хуудас (/ai-chat) болон баруун доод талын цонхонд хоёуланд нь.
   Хариулт /ai-chat/stream-ээс NDJSON-оор урсаж ирнэ (backend/app/ai/chat.py). */

export interface PageCtx { menu: string; path: string; ids: string[] }

interface Msg {
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  error?: boolean;
}

const SUGGESTIONS = [
  "Хугацаа нь 30 хоногийн дотор дуусах бараа хэд байна?",
  "Сүүлийн 14 хоногийн захиалгуудыг харуулаач",
  "Кока-Кола-гийн агуулахын үлдэгдэл хэд вэ?",
  "Энэ сарын Ebarimt дутуу шивсэн харилцагчид хэд вэ?",
];

// Түүх зөвхөн энэ төхөөрөмж дээр (хэрэглэгч бүрт тусдаа). Серверт зөвхөн сүүлийн 6 мессеж очно.
const HISTORY_MAX = 40;
const historyKey = (u: string | null) => `ai_chat_history:${u ?? ""}`;

function loadHistory(key: string): Msg[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.map((m: any) => ({ ...m, role: m.role === "model" ? "assistant" : m.role })).slice(-HISTORY_MAX) : [];
  } catch { return []; }
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* http / хуучин WebView */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } finally { document.body.removeChild(ta); }
}

/** NDJSON урсгалыг уншиж мөр бүрээр onEvent дуудна. CapacitorHttp (APK) үед body нэг дор ирнэ. */
async function streamAsk(body: object, onEvent: (e: any) => void, signal: AbortSignal) {
  const token = useAuthStore.getState().token;
  const r = await fetch(`${api.defaults.baseURL || ""}/ai-chat/stream`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).detail; } catch { /* */ }
    throw new Error(detail || `Алдаа гарлаа (${r.status})`);
  }
  const handle = (line: string) => { if (line.trim()) { try { onEvent(JSON.parse(line)); } catch { /* */ } } };
  if (!r.body) { (await r.text()).split("\n").forEach(handle); return; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  handle(buf);
}

export default function ChatView({ page, compact, onClose }: { page?: PageCtx; compact?: boolean; onClose?: () => void }) {
  const username = useAuthStore(s => s.username);
  const key = historyKey(username);
  const [msgs, setMsgs] = useState<Msg[]>(() => loadHistory(key));
  const [top, setTop] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const [status, setStatus] = useState<{ enabled: boolean; allowed: boolean; model: string } | null>(null);
  const [copied, setCopied] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.get("/ai-chat/status").then(r => setStatus(r.data)).catch(() => setStatus({ enabled: false, allowed: false, model: "" }));
    api.get("/ai-chat/log", { params: { limit: 6 } })
      .then(r => setTop((r.data.top ?? []).map((x: any) => x.question).slice(0, 4))).catch(() => {});
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(msgs.filter(m => !m.error).slice(-HISTORY_MAX))); } catch { /* дүүрсэн */ }
  }, [msgs, key]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, step]);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || sending) return;
    setInput(""); setErr(""); setStep("Бодож байна…");
    const history = msgs.filter(m => !m.error && m.text.trim()).slice(-6).map(m => ({ role: m.role, text: m.text }));
    setMsgs(prev => [...prev, { role: "user", text: q }, { role: "assistant", text: "", tools: [] }]);
    setSending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const patch = (f: (m: Msg) => Msg) => setMsgs(prev => [...prev.slice(0, -1), f(prev[prev.length - 1])]);
    try {
      await streamAsk({ question: q, history, page }, e => {
        if (e.t === "text") { setStep(""); patch(m => ({ ...m, text: m.text + e.v })); }
        else if (e.t === "tool") { setStep(`${e.label}…`); patch(m => ({ ...m, tools: [...(m.tools ?? []), e.label] })); }
        else if (e.t === "error") { setErr(e.message); patch(m => ({ ...m, error: !m.text })); }
      }, ctrl.signal);
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setErr(e?.message || "Хариулт авахад алдаа гарлаа");
        setMsgs(prev => prev.slice(0, -2));
        setInput(q);
      }
    } finally {
      setSending(false); setStep(""); abortRef.current = null;
      setMsgs(prev => prev.filter((m, i) => !(i === prev.length - 1 && m.role === "assistant" && !m.text.trim())));
      inputRef.current?.focus();
    }
  }

  function newChat() {
    abortRef.current?.abort();
    setMsgs([]); setErr("");
    try { localStorage.removeItem(key); } catch { /* */ }
  }

  const disabled = status !== null && (!status.enabled || !status.allowed);
  const pad = compact ? "px-3" : "px-4 sm:px-5";

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className={`flex shrink-0 items-center gap-2.5 border-b border-gray-100 py-2.5 ${pad}`}>
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white">
          <Sparkles size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-bold leading-tight text-gray-900">AI туслах</div>
          <div className="truncate text-[10.5px] leading-tight text-gray-500">
            {page?.menu ? `Одоо: ${page.menu}` : "ERP-ийн өгөгдлөөс хариулна"}
          </div>
        </div>
        {msgs.length > 0 && (
          <button onClick={newChat} title="Шинэ яриа"
            className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1.5 text-[11.5px] font-semibold text-gray-600 hover:bg-gray-50">
            <MessageSquarePlus size={13} />Шинэ яриа
          </button>
        )}
        {onClose && (
          <button onClick={onClose} title="Хаах" className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <X size={16} />
          </button>
        )}
      </div>

      {err && (
        <div className="mx-3 mt-2 flex shrink-0 items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{err}</span>
          <button onClick={() => setErr("")}><X size={12} /></button>
        </div>
      )}
      {status && !status.enabled && (
        <div className="mx-3 mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          AI тохируулагдаагүй байна — админд хандана уу.
        </div>
      )}
      {status && status.enabled && !status.allowed && (
        <div className="mx-3 mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Танд «AI туслах» ашиглах эрх алга.
        </div>
      )}

      <div ref={scrollRef} className={`flex-1 overflow-y-auto py-3 ${pad}`}>
        {msgs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Sparkles size={26} className="text-violet-300" />
            <div>
              <p className="text-[13.5px] font-semibold text-gray-700">Юу асуух вэ?</p>
              <p className="mt-0.5 text-[11.5px] text-gray-400">Үлдэгдэл, борлуулалт, захиалга, тулгалт, Ebarimt, хугацаа…</p>
            </div>
            <div className="flex max-w-xl flex-wrap justify-center gap-1.5">
              {(top.length ? top : SUGGESTIONS).map(s => (
                <button key={s} onClick={() => send(s)} disabled={sending || disabled}
                  className="rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-[11.5px] text-gray-600 hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 disabled:opacity-50">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mx-auto max-w-3xl space-y-3">
          {msgs.map((m, i) => {
            const last = i === msgs.length - 1;
            if (m.role === "user") return (
              <div key={i} className="flex justify-end gap-2">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-[#0071E3] px-3 py-2 text-[12.5px] text-white">{m.text}</div>
                {!compact && <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gray-100 text-gray-500"><UserIcon size={13} /></div>}
              </div>
            );
            if (!m.text && !(sending && last)) return null;
            return (
              <div key={i} className="group min-w-0 rounded-2xl rounded-tl-sm border border-gray-100 bg-gray-50/60 px-3 py-2">
                {m.text ? <Markdown text={m.text} /> : null}
                {sending && last && step && (
                  <div className="flex items-center gap-2 py-0.5 text-[12px] text-gray-400">
                    <RefreshCw size={12} className="animate-spin" />{step}
                  </div>
                )}
                {!(sending && last) && m.text && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-gray-100 pt-1.5">
                    {(m.tools ?? []).length > 0 && <Wrench size={9} className="text-gray-400" />}
                    {[...new Set(m.tools ?? [])].map(t => (
                      <span key={t} className="rounded-md bg-white px-1.5 py-0.5 text-[9.5px] text-gray-500 ring-1 ring-gray-200">{t}</span>
                    ))}
                    <button onClick={() => copyText(m.text).then(() => { setCopied(i); setTimeout(() => setCopied(-1), 1500); })}
                      className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-gray-500 hover:bg-white hover:text-gray-800">
                      {copied === i ? <><Check size={11} />Хуулсан</> : <><Copy size={11} />Хуулах</>}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className={`shrink-0 border-t border-gray-100 py-2.5 ${pad}`}>
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea ref={inputRef} value={input} rows={1}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={disabled}
            placeholder="Асуултаа бичнэ үү…"
            className="max-h-32 min-h-[40px] flex-1 resize-none rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-[12.5px] outline-none placeholder:text-gray-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100 disabled:bg-gray-50" />
          {sending ? (
            <button onClick={() => abortRef.current?.abort()} title="Зогсоох"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gray-800 text-white">
              <Square size={14} />
            </button>
          ) : (
            <button onClick={() => send()} disabled={!input.trim() || disabled}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#0071E3] text-white hover:bg-blue-600 disabled:opacity-40">
              <Send size={15} />
            </button>
          )}
        </div>
        <p className="mx-auto mt-1 max-w-3xl text-center text-[10px] text-gray-400">
          AI алдаа гаргаж болзошгүй — чухал тоог эх цэсээс шалгана уу.
        </p>
      </div>
    </div>
  );
}
