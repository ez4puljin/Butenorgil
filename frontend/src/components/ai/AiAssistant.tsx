import { useState } from "react";
import { useLocation } from "react-router-dom";
import { Sparkles } from "lucide-react";
import ChatView from "./ChatView";

/* Бүх цэсэнд баруун доод буланд гарах AI туслах. Асуулт бүрт одоогийн цэсний нэр, зам,
   URL дахь ID-г (жишээ /order/123 → 123) дагуулж илгээнэ. */

function urlIds(pathname: string, search: string): string[] {
  const ids = pathname.split("/").filter(s => /^\d+$/.test(s));
  new URLSearchParams(search).forEach((v, k) => { if (/id$/i.test(k) && v) ids.push(v); });
  return [...new Set(ids)].slice(0, 20);
}

export default function AiAssistant({ menu, raised }: { menu: string; raised?: boolean }) {
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  if (loc.pathname.startsWith("/ai-chat")) return null;
  const page = { menu, path: loc.pathname, ids: urlIds(loc.pathname, loc.search) };
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-white sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[min(640px,calc(100vh-2rem))] sm:w-[420px] sm:overflow-hidden sm:rounded-2xl sm:border sm:border-gray-200 sm:shadow-2xl">
          <ChatView compact page={page} onClose={() => setOpen(false)} />
        </div>
      )}
      {!open && (
        <button onClick={() => setOpen(true)} title="AI туслах"
          className={`fixed right-4 z-[55] grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-lg shadow-violet-500/30 transition-transform hover:scale-105 lg:bottom-5 ${raised ? "bottom-24" : "bottom-20"}`}>
          <Sparkles size={20} />
        </button>
      )}
    </>
  );
}
