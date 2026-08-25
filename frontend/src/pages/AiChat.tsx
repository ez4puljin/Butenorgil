import { useEffect, useRef, useState } from "react";
import {
  Sparkles, Send, RefreshCw, AlertCircle, X, Wrench, User as UserIcon, Trash2,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ──────────────────────────────────────────────────────────────────

interface Msg {
  role: "user" | "model";
  text: string;
  tools?: string[];
}

// Эхлэхэд санал болгох асуултууд
const SUGGESTIONS = [
  "Хугацаа нь 30 хоногийн дотор дуусах бараа хэд байна?",
  "Сүүлийн 14 хоногийн захиалгуудыг харуулаач",
  "Кока-Кола-гийн агуулахын үлдэгдэл хэд вэ?",
  "2026 оны 6-р сард Ebarimt дутуу шивсэн харилцагчид хэд вэ?",
];

// ── Жижиг markdown renderer (нэмэлт сан ашиглахгүй) ────────────────────────
// AI-ийн гаргадаг дэд олонлогийг дэмжинэ: гарчиг, тод, хүснэгт, жагсаалт.

function inline(text: string): React.ReactNode[] {
  // **тод** ба `код`-ыг таньж хуваана
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**"))
      return <strong key={i} className="font-semibold text-gray-900">{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`"))
      return <code key={i} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] text-gray-800">{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Хүснэгт: | a | b |  дараагийн мөр нь | --- | --- |
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      out.push(
        <div key={out.length} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                {head.map((h, k) => (
                  <th key={k} className="px-2 py-1.5 text-left font-semibold text-gray-600 whitespace-nowrap">{inline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/60">
                  {r.map((c, j) => (
                    <td key={j} className="px-2 py-1.5 text-gray-700 whitespace-nowrap">{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Гарчиг
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(<div key={out.length} className={`mt-2.5 mb-1 font-bold text-gray-900 ${h[1].length <= 2 ? "text-[14px]" : "text-[12.5px]"}`}>{inline(h[2])}</div>);
      i++; continue;
    }

    // Тусгаарлагч
    if (/^\s*(---|===)\s*$/.test(line)) {
      out.push(<hr key={out.length} className="my-2 border-gray-100"/>); i++; continue;
    }

    // Жагсаалт
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      out.push(
        <ul key={out.length} className="my-1 ml-1 space-y-0.5">
          {items.map((it, k) => (
            <li key={k} className="flex gap-1.5"><span className="text-gray-300">•</span><span>{inline(it)}</span></li>
          ))}
        </ul>
      );
      continue;
    }

    // Хоосон мөр
    if (!line.trim()) { i++; continue; }

    out.push(<p key={out.length} className="my-1 leading-relaxed">{inline(line)}</p>);
    i++;
  }
  return <div className="text-[12.5px] text-gray-800">{out}</div>;
}

// ── Main ───────────────────────────────────────────────────────────────────

export default function AiChatPage() {
  const [msgs, setMsgs]       = useState<Msg[]>([]);
  const [input, setInput]     = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr]         = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [model, setModel]     = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.get("/ai-chat/status")
      .then(r => { setEnabled(!!r.data.enabled); setModel(r.data.model || ""); })
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, sending]);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || sending) return;
    setInput("");
    setErr("");
    const history = msgs.map(m => ({ role: m.role, text: m.text }));
    setMsgs(prev => [...prev, { role: "user", text: q }]);
    setSending(true);
    try {
      const r = await api.post("/ai-chat/ask", { question: q, history });
      setMsgs(prev => [...prev, { role: "model", text: r.data.answer, tools: r.data.tools_used ?? [] }]);
    } catch (e: any) {
      const detail = e?.response?.data?.detail ?? "Хариулт авахад алдаа гарлаа";
      setErr(detail);
      // Асуултыг буцааж оруулж, дахин илгээх боломж өгнө
      setMsgs(prev => prev.slice(0, -1));
      setInput(q);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  return (
    <div className="flex h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-2xl bg-white shadow-sm lg:h-[calc(100vh-2.5rem)]">

      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-4 py-3 sm:px-5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-sm shadow-violet-500/30">
          <Sparkles size={16}/>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold tracking-tight text-gray-900 leading-tight">AI туслах</h1>
          <p className="text-[11px] text-gray-500 leading-tight">
            ERP-ийн өгөгдлөөс асуултад хариулна{model ? ` · ${model}` : ""}
          </p>
        </div>
        {msgs.length > 0 && (
          <button onClick={() => { setMsgs([]); setErr(""); }}
            title="Харилцааг цэвэрлэх"
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
            <Trash2 size={13}/>Цэвэрлэх
          </button>
        )}
      </div>

      {/* Error */}
      {err && (
        <div className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          <AlertCircle size={13} className="shrink-0"/>
          <span className="min-w-0 flex-1">{err}</span>
          <button onClick={() => setErr("")}><X size={12}/></button>
        </div>
      )}

      {/* API key тохируулаагүй */}
      {enabled === false && (
        <div className="mx-4 mt-2 flex shrink-0 items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <AlertCircle size={13} className="mt-0.5 shrink-0"/>
          <span>Gemini API key тохируулаагүй байна. <code className="font-mono">backend/.env</code>-д <code className="font-mono">GEMINI_API_KEY</code> нэмнэ үү (aistudio.google.com-оос үнэгүй авна).</span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        {msgs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-violet-50 to-fuchsia-50">
              <Sparkles size={28} className="text-violet-400"/>
            </div>
            <div>
              <p className="text-[14px] font-semibold text-gray-700">Юу асуухыг хүсэж байна?</p>
              <p className="mt-0.5 text-[12px] text-gray-400">Үлдэгдэл, борлуулалт, захиалга, Ebarimt, хугацааны хяналт…</p>
            </div>
            <div className="flex max-w-xl flex-wrap justify-center gap-2">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => send(s)} disabled={sending || enabled === false}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-[11.5px] text-gray-600 hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 disabled:opacity-50 transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mx-auto max-w-3xl space-y-4">
          {msgs.map((m, i) => (
            <div key={i} className={`flex gap-2.5 ${m.role === "user" ? "justify-end" : ""}`}>
              {m.role === "model" && (
                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white">
                  <Sparkles size={13}/>
                </div>
              )}
              <div className={`min-w-0 ${m.role === "user" ? "max-w-[80%]" : "flex-1"}`}>
                {m.role === "user" ? (
                  <div className="rounded-2xl rounded-tr-sm bg-[#0071E3] px-3.5 py-2 text-[12.5px] text-white whitespace-pre-wrap">
                    {m.text}
                  </div>
                ) : (
                  <div className="rounded-2xl rounded-tl-sm border border-gray-100 bg-gray-50/60 px-3.5 py-2.5">
                    <Markdown text={m.text}/>
                    {m.tools && m.tools.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-gray-100 pt-1.5">
                        <Wrench size={9} className="text-gray-400"/>
                        {m.tools.map((t, k) => (
                          <span key={k} title="Ашигласан өгөгдлийн эх сурвалж"
                            className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[9.5px] text-gray-500 ring-1 ring-gray-200">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {m.role === "user" && (
                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gray-100 text-gray-500">
                  <UserIcon size={13}/>
                </div>
              )}
            </div>
          ))}

          {sending && (
            <div className="flex gap-2.5">
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white">
                <Sparkles size={13}/>
              </div>
              <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-gray-100 bg-gray-50/60 px-3.5 py-2.5 text-[12px] text-gray-400">
                <RefreshCw size={12} className="animate-spin"/>Өгөгдөл шалгаж байна…
              </div>
            </div>
          )}
          <div ref={bottomRef}/>
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-gray-100 px-4 py-3 sm:px-5">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending || enabled === false}
            rows={1}
            placeholder="Асуултаа бичнэ үү…  (Enter — илгээх, Shift+Enter — шинэ мөр)"
            className="max-h-32 min-h-[42px] flex-1 resize-none rounded-2xl border border-gray-200 bg-white px-3.5 py-2.5 text-[12.5px] outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 disabled:bg-gray-50 placeholder:text-gray-300"
          />
          <button onClick={() => send()} disabled={sending || !input.trim() || enabled === false}
            className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-2xl bg-[#0071E3] text-white hover:bg-blue-600 disabled:opacity-40 transition-colors shadow-sm shadow-blue-500/25">
            {sending ? <RefreshCw size={16} className="animate-spin"/> : <Send size={16}/>}
          </button>
        </div>
        <p className="mx-auto mt-1.5 max-w-3xl text-center text-[10px] text-gray-400">
          AI алдаа гаргаж болзошгүй — чухал тоог эх цэсээс баталгаажуулна уу.
        </p>
      </div>
    </div>
  );
}
