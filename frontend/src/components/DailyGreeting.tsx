import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { CalendarDays, Check, Shuffle, X } from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { taskIcon, taskStyle } from "../lib/calendarStyle";

/* ═══════════════════════════════════════════════════════════════════════════
   Нэвтрэх үеийн мэндчилгээ — өнөөдрийн календарт төлөвлөсөн ажлуудыг сануулж,
   ажлын амжилт хүссэн урмын үгийг (санамсаргүй) харуулна.
   Хэрэглэгч бүрт өдөрт НЭГ удаа (нэвтрэхэд — logout localStorage-ийг цэвэрлэдэг тул
   дахин нэвтрэхэд ч гарна).
   ═══════════════════════════════════════════════════════════════════════════ */

type TodayEvent = { id: number; task_type: string; label: string; short: string; color: string; icon: string; notes: string; is_done: boolean };
type Today = { date: string; weekday: string; events: TodayEvent[]; total: number; done: number };

const QUOTES = [
  "Өнөөдөр бол гайхалтай зүйл эхлэх өдөр! 🌟",
  "Жижиг алхам бүр том амжилтын эхлэл 🚀",
  "Хамтдаа бол бид чадна! 🤝💪",
  "Инээмсэглэл бол хамгийн сайхан эхлэл 😊",
  "Таны хичээл зүтгэл заавал үр дүнгээ өгнө 🌱➡️🌳",
  "Өнөөдрийн ажилд чинь өндөр амжилт хүсье! 🎯",
  "Эрч хүчтэй, өнгөлөг өдөр болоорой! 🌈",
  "Нэг нэгээр нь, алхам алхмаар — бүгдийг амжуулна 🧩",
  "Эерэг бодол — эерэг үр дүн ✨",
  "Таны оролцоо манай багт үнэтэй 💎",
  "Өнөөдөр ч гэсэн шилдэг хувилбараараа байгаарай 🏆",
  "Кофеэ уугаад, урагшаа! ☕🚀",
  "Амжилт бэлтгэлтэй хүнийг хайдаг 📋✅",
  "Нарлаг сэтгэл, бүтээлч өдөр ☀️🎨",
  "Завсарлага авахаа бүү мартаарай — хүч чинь хэрэгтэй 🌿",
  "Алдаа бол суралцах боломж 📚💡",
  "Та чадна! Бид танд итгэж байна 🙌",
  "Өчигдрөөсөө нэг алхам урагш — хангалттай 👣",
  "Сайн ажил сайхан сэтгэлээс эхэлдэг 💖",
  "Цаг бол алт — өнөөдрийг үнэ цэнэтэй өнгөрүүлээрэй ⏰✨",
  "Багаараа бол уул ч нам 🏔️🤝",
  "Үйлчлүүлэгчийн инээмсэглэл бол бидний шагнал 😊🛒",
  "Эмх цэгцтэй агуулах — хурдан хүргэлт 📦⚡",
  "Өнөөдөр шинэ дээд амжилт тогтоох боломжтой 📈",
  "Тууштай байдал ялалт авчирдаг 🐎💨",
  "Сэтгэл хангалуун өдөр, амжилттай ажил 🌻",
  "Та бол манай багийн од ⭐",
  "Итгэл + хичээл + хамтын ажиллагаа = амжилт 🧠💪🤝",
  "Өдрөө инээмсэглэлээр эхлүүлээрэй 😄🌅",
  "Бүх зүйл санаснаар бүтэх болтугай! 🍀",
  "Өнөөдрийн хөдөлмөр маргаашийн бахархал 🥇",
  "Эрүүл мэнд, эрч хүч, амжилт хамт байх болтугай 💚⚡",
];
const HERO = ["🌞", "🌟", "🚀", "💪", "🎯", "🌈", "🍀", "✨", "🌻", "🏆", "😊", "🎉"];
const pick = <T,>(arr: T[], not?: T) => {
  if (arr.length < 2) return arr[0];
  let v = arr[Math.floor(Math.random() * arr.length)];
  while (v === not) v = arr[Math.floor(Math.random() * arr.length)];
  return v;
};
const greetingNow = () => {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return { text: "Өглөөний мэнд", emoji: "🌅" };
  if (h >= 11 && h < 17) return { text: "Өдрийн мэнд", emoji: "☀️" };
  if (h >= 17 && h < 22) return { text: "Оройн мэнд", emoji: "🌆" };
  return { text: "Сайн байна уу", emoji: "🌙" };
};
const localDate = () => {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export default function DailyGreeting() {
  const { token, userId, username, nickname } = useAuthStore();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState<Today | null>(null);
  const [quote, setQuote] = useState(() => pick(QUOTES));
  const hero = useMemo(() => pick(HERO), []);
  const greet = useMemo(greetingNow, []);
  const seenKey = `daily_greeting:${userId ?? username ?? ""}`;

  useEffect(() => {
    if (!token) return;
    let seen = "";
    try { seen = localStorage.getItem(seenKey) ?? ""; } catch { /* private mode */ }
    if (seen === localDate()) return;
    let dead = false;
    (async () => {
      try {
        const r = await api.get("/calendar/today");
        if (dead) return;
        setToday(r.data);
      } catch { /* календарь уншигдахгүй ч мэндчилгээ гарна */ }
      if (dead) return;
      setOpen(true);
      try { localStorage.setItem(seenKey, localDate()); } catch { /* ignore */ }
    })();
    return () => { dead = true; };
  }, [token, seenKey]);

  const name = (nickname || username || "").trim();
  const events = today?.events ?? [];
  const open_n = events.filter((e) => !e.is_done).length;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-end justify-center bg-black/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={() => setOpen(false)}
        >
          <motion.div
            className="relative w-full max-w-md overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
            initial={{ y: 40, scale: 0.96, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Толгой — градиент + том эможи */}
            <div className="relative overflow-hidden bg-gradient-to-br from-sky-500 via-indigo-500 to-fuchsia-500 px-6 pb-6 pt-7 text-white">
              <div className="pointer-events-none absolute -right-6 -top-8 h-32 w-32 rounded-full bg-white/15" />
              <div className="pointer-events-none absolute -bottom-10 -left-8 h-28 w-28 rounded-full bg-white/10" />
              <button onClick={() => setOpen(false)} className="absolute right-3 top-3 rounded-full p-1.5 text-white/80 hover:bg-white/15" aria-label="Хаах"><X size={16} /></button>
              <motion.div className="text-5xl" initial={{ rotate: -12, scale: 0.6 }} animate={{ rotate: [0, -8, 8, 0], scale: 1 }} transition={{ duration: 0.9 }}>{hero}</motion.div>
              <div className="mt-2 text-[20px] font-bold leading-tight">{greet.text}{name ? `, ${name}` : ""}! {greet.emoji}</div>
              <div className="mt-0.5 text-[12.5px] text-white/85">
                {today ? `${today.date.split("-").join("/")} · ${today.weekday} гараг` : ""}
              </div>
            </div>

            {/* Урмын үг */}
            <div className="px-6 pt-4">
              <div className="flex items-start gap-2 rounded-2xl bg-gradient-to-r from-amber-50 to-rose-50 px-4 py-3 ring-1 ring-inset ring-amber-100">
                <AnimatePresence mode="wait">
                  <motion.p key={quote} className="flex-1 text-[14px] font-semibold leading-snug text-gray-800"
                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
                    {quote}
                  </motion.p>
                </AnimatePresence>
                <button onClick={() => setQuote((q) => pick(QUOTES, q))} title="Өөр үг" className="shrink-0 rounded-lg p-1.5 text-amber-600 hover:bg-amber-100"><Shuffle size={14} /></button>
              </div>
            </div>

            {/* Өнөөдрийн төлөвлөгөө */}
            <div className="px-6 pb-2 pt-4">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-gray-500">
                <CalendarDays size={13} /> Өнөөдрийн төлөвлөгөө
                {events.length > 0 && <span className="ml-auto text-[11px] font-semibold normal-case tracking-normal text-gray-400">{open_n} хийх · {events.length - open_n} дууссан</span>}
              </div>
              {events.length === 0 ? (
                <div className="rounded-2xl bg-gray-50 px-4 py-4 text-center text-[13px] text-gray-500">
                  Өнөөдөр календарт төлөвлөсөн ажил алга 🎈<br />
                  <span className="text-[12px] text-gray-400">Өөрийн зорилгоо тавиад, амжилттай өдөр болгоорой!</span>
                </div>
              ) : (
                <div className="max-h-[38vh] space-y-1.5 overflow-y-auto pr-1">
                  {events.map((e) => {
                    const st = taskStyle(e.color);
                    const Icon = taskIcon(e.icon);
                    return (
                      <div key={e.id} className={`flex items-start gap-2.5 rounded-xl border px-3 py-2 ${e.is_done ? "border-gray-100 bg-gray-50/70" : `${st.bg} border-transparent`}`}>
                        <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${e.is_done ? "bg-emerald-100 text-emerald-600" : `${st.chip} border`}`}>
                          {e.is_done ? <Check size={14} /> : <Icon size={14} />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[13px] font-semibold ${e.is_done ? "text-gray-400 line-through" : "text-gray-800"}`}>{e.label}</div>
                          {e.notes && <div className={`text-[12px] leading-snug ${e.is_done ? "text-gray-300 line-through" : "text-gray-600"}`}>{e.notes}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex gap-2 px-6 pb-[max(20px,env(safe-area-inset-bottom))] pt-3">
              <button onClick={() => { setOpen(false); navigate("/calendar"); }}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-[13px] font-semibold text-gray-700 hover:bg-gray-50">
                <CalendarDays size={14} /> Календарь
              </button>
              <button onClick={() => setOpen(false)}
                className="flex-1 rounded-xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-4 py-2.5 text-[14px] font-bold text-white shadow-md shadow-indigo-500/25 hover:opacity-95 active:scale-[0.99]">
                Ажилдаа амжилт! 💪
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
