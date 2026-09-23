/* Календарийн label-ийн өнгө/icon — Календарь хуудас болон нэвтрэх үеийн мэндчилгээний
   цонх хоёулаа ашиглана (Tailwind JIT-д класс нэрс энд бүтнээрээ бичигдсэн байх ёстой). */
import {
  Truck, ClipboardList, Package, Banknote, BarChart2, Users, Send, MoreHorizontal,
  CalendarDays, StickyNote, Plus, Settings, Check, Save,
} from "lucide-react";

// ── Color palette ─────────────────────────────────────────────────────────────
// Админ шинэ label үүсгэхэд сонгох боломжтой Tailwind өнгөний гэр бүлүүд.
export type ColorKey = "orange" | "blue" | "violet" | "emerald" | "indigo" | "pink" | "amber" | "gray" | "red" | "teal" | "sky" | "rose" | "lime" | "cyan" | "fuchsia";

export const COLOR_MAP: Record<string, { chip: string; dot: string; bg: string; preview: string }> = {
  orange:  { chip: "bg-orange-100 text-orange-700 border-orange-200",     dot: "bg-orange-400",  bg: "bg-orange-50",  preview: "bg-orange-400"  },
  blue:    { chip: "bg-blue-100 text-blue-700 border-blue-200",           dot: "bg-blue-400",    bg: "bg-blue-50",    preview: "bg-blue-400"    },
  violet:  { chip: "bg-violet-100 text-violet-700 border-violet-200",     dot: "bg-violet-400",  bg: "bg-violet-50",  preview: "bg-violet-400"  },
  emerald: { chip: "bg-emerald-100 text-emerald-700 border-emerald-200",  dot: "bg-emerald-400", bg: "bg-emerald-50", preview: "bg-emerald-400" },
  indigo:  { chip: "bg-indigo-100 text-indigo-700 border-indigo-200",     dot: "bg-indigo-400",  bg: "bg-indigo-50",  preview: "bg-indigo-400"  },
  pink:    { chip: "bg-pink-100 text-pink-700 border-pink-200",           dot: "bg-pink-400",    bg: "bg-pink-50",    preview: "bg-pink-400"    },
  amber:   { chip: "bg-amber-100 text-amber-700 border-amber-200",        dot: "bg-amber-400",   bg: "bg-amber-50",   preview: "bg-amber-400"   },
  gray:    { chip: "bg-gray-100 text-gray-600 border-gray-200",           dot: "bg-gray-400",    bg: "bg-gray-50",    preview: "bg-gray-400"    },
  red:     { chip: "bg-red-100 text-red-700 border-red-200",              dot: "bg-red-400",     bg: "bg-red-50",     preview: "bg-red-400"     },
  teal:    { chip: "bg-teal-100 text-teal-700 border-teal-200",           dot: "bg-teal-400",    bg: "bg-teal-50",    preview: "bg-teal-400"    },
  sky:     { chip: "bg-sky-100 text-sky-700 border-sky-200",              dot: "bg-sky-400",     bg: "bg-sky-50",     preview: "bg-sky-400"     },
  rose:    { chip: "bg-rose-100 text-rose-700 border-rose-200",           dot: "bg-rose-400",    bg: "bg-rose-50",    preview: "bg-rose-400"    },
  lime:    { chip: "bg-lime-100 text-lime-700 border-lime-200",           dot: "bg-lime-400",    bg: "bg-lime-50",    preview: "bg-lime-400"    },
  cyan:    { chip: "bg-cyan-100 text-cyan-700 border-cyan-200",           dot: "bg-cyan-400",    bg: "bg-cyan-50",    preview: "bg-cyan-400"    },
  fuchsia: { chip: "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200",  dot: "bg-fuchsia-400", bg: "bg-fuchsia-50", preview: "bg-fuchsia-400" },
};

export const COLOR_KEYS: ColorKey[] = ["orange","blue","violet","emerald","indigo","pink","amber","gray","red","teal","sky","rose","lime","cyan","fuchsia"];

// Icon registry — label тохируулахад сонгох боломжтой Lucide icon-ууд
export const ICON_MAP: Record<string, React.ElementType> = {
  Truck, ClipboardList, Package, Banknote, BarChart2, Users, Send, MoreHorizontal,
  CalendarDays, StickyNote, Plus, Settings, Check, Save,
};
export const ICON_KEYS = Object.keys(ICON_MAP);

export function taskStyle(color: string) {
  return COLOR_MAP[color] ?? COLOR_MAP.gray;
}
export function taskIcon(icon: string): React.ElementType {
  return ICON_MAP[icon] ?? MoreHorizontal;
}

