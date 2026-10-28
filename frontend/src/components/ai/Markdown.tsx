import type React from "react";

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

export default function Markdown({ text }: { text: string }) {
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
