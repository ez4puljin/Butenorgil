/**
 * KPI Admin — Config tab redesign (per Claude Design handoff
 * "KPI Admin Redesign", chat 2026-05-12 04:32 UTC).
 *
 * Pain point fixed: "Ажилтан эсвэл нэг ажилтан ямар ямар kpi даалгавар
 * байгааг харахад төвөгтэй." Solved with a 2-pane layout — templates
 * on the left, assignment matrix on the right with 3 sub-views:
 *   - Матриц: full employees × templates checkbox grid (the killer view)
 *   - Ажилтнаар: pick employee → manage their tasks
 *   - Тушаалаар: bulk-assign a template to every member of a role
 *
 * All backend calls (`/kpi/templates`, `/kpi/groups`,
 * `/kpi/configs/all`, `/kpi/configs`, `/admin/users`, `/admin/roles`)
 * use the existing endpoints unchanged.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Plus, Pencil, Trash2, X, Check, AlertCircle, CheckCircle, Search,
  Settings as SettingsIcon, Layers, Users, Link as LinkIcon,
  ChevronDown, List, User as UserIcon,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ────────────────────────────────────────────────────────────────
interface TaskGroup {
  id: number;
  name: string;
  sort_order: number;
  is_active: boolean;
}
interface Template {
  id: number;
  name: string;
  description: string;
  monetary_value: number;
  weight_points: number;
  task_category: string;        // "daily" | "inventory"
  group_id: number | null;
  group_name: string | null;
  period: string;               // "daily" | "weekly" | "monthly"
  day_of_week: number | null;
  day_of_month: number | null;
  is_active: boolean;
}
interface Config {
  id: number;
  employee_id: number;
  employee_username: string;
  template_id: number;
  template_name: string;
  template_monetary_value: number;
  approver_id: number;
  approver_username: string;
  is_active: boolean;
  sort_order: number;
}
interface UserOption {
  id: number;
  username: string;
  nickname?: string;
  role: string;
}

interface RoleOption {
  value: string;
  label: string;
  base_role: string;
  is_system?: boolean;
}

// Fallback (хэрэв /admin/roles ачааллахгүй бол)
const FALLBACK_LABELS: Record<string, string> = {
  admin: "Админ",
  supervisor: "Хянагч",
  manager: "Менежер",
  warehouse_clerk: "Агуулахын нярав",
  accountant: "Нягтлан",
};
// base_role-ын дарааллын приоритет (admin биш бүх албан тушаалд)
const BASE_PRIORITY: Record<string, number> = {
  manager: 0, supervisor: 1, warehouse_clerk: 2, accountant: 3,
};

const MON_FULL = ["Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням"];

const dispName = (u?: UserOption) => (u?.nickname?.trim() || u?.username || "—");
const fmtMoney = (n: number) => (n || 0).toLocaleString("en-US");
const palette: [string, string][] = [
  ["bg-blue-100", "text-blue-700"], ["bg-emerald-100", "text-emerald-700"],
  ["bg-amber-100", "text-amber-700"], ["bg-violet-100", "text-violet-700"],
  ["bg-pink-100", "text-pink-700"], ["bg-cyan-100", "text-cyan-700"],
  ["bg-orange-100", "text-orange-700"],
];

// ── Tiny shared bits ─────────────────────────────────────────────────────
function Avatar({ user, size = 28 }: { user: UserOption | undefined; size?: number }) {
  if (!user) return null;
  const initials = (user.nickname || user.username || "?").trim().slice(0, 1).toUpperCase();
  const [bg, fg] = palette[user.id % palette.length];
  return (
    <div className={`shrink-0 rounded-full grid place-items-center font-semibold ${bg} ${fg}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>{initials}</div>
  );
}

function Toast({ toast }: { toast: { msg: string; ok: boolean } | null }) {
  if (!toast) return null;
  return (
    <div className="fixed top-5 right-5 z-[100] flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-medium shadow-xl backdrop-blur text-white"
      style={{ background: toast.ok ? "rgba(16,185,129,.96)" : "rgba(239,68,68,.96)" }}>
      {toast.ok ? <CheckCircle size={15}/> : <AlertCircle size={15}/>}
      <span>{toast.msg}</span>
    </div>
  );
}

function PeriodBadge({ t }: { t: Template }) {
  if (!t || t.period === "daily") return null;
  const cls = t.period === "weekly"
    ? "bg-violet-50 text-violet-700 ring-1 ring-violet-100"
    : "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  const txt = t.period === "weekly"
    ? (t.day_of_week != null ? MON_FULL[t.day_of_week] : "7 хоног")
    : (t.day_of_month != null ? `${t.day_of_month}-нд` : "Сар бүр");
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{txt}</span>;
}

function FilterPill<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  const isDefault = value === ("" as T) || value === ("all" as T);
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value as T)}
        className={`appearance-none rounded-full pl-2.5 pr-7 py-1 text-[11px] font-semibold transition cursor-pointer ${
          isDefault
            ? "bg-white border border-gray-200 text-gray-600 hover:border-gray-300"
            : "bg-[#0071E3] text-white border border-[#0071E3]"
        }`}>
        {options.map(o => <option key={o.value} value={o.value}>{label}: {o.label}</option>)}
      </select>
      <ChevronDown size={11} className={`absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none ${isDefault ? "text-gray-400" : "text-white/80"}`}/>
    </div>
  );
}

function EmptyState({ icon: Icon, title, desc, action }: {
  icon: React.ElementType; title: string; desc?: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-400">
        <Icon size={26}/>
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-800">{title}</p>
        {desc && <p className="mt-1 text-xs text-gray-500 max-w-[340px]">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

// ── Stats row ────────────────────────────────────────────────────────────
function StatsRow({ templates, groups, users, configs, onManageGroups }: {
  templates: Template[]; groups: TaskGroup[]; users: UserOption[];
  configs: Config[]; onManageGroups: () => void;
}) {
  const employees = users.filter(u => u.role !== "admin");
  const activeTpl = templates.filter(t => t.is_active).length;
  const avg = configs.length / Math.max(1, employees.length);
  const cells = [
    { label: "Идэвхтэй загвар", value: `${activeTpl}`, sub: `/${templates.length} нийт`, icon: SettingsIcon, tone: "bg-blue-50 text-blue-600" },
    { label: "Ажлын бүлэг", value: `${groups.length}`, sub: "ангилал", icon: Layers, tone: "bg-violet-50 text-violet-600", action: true },
    { label: "Ажилтан", value: `${employees.length}`, sub: "хүн", icon: Users, tone: "bg-emerald-50 text-emerald-600" },
    { label: "Хуваарилалт", value: `${configs.length}`, sub: `~${avg.toFixed(1)}/хүн`, icon: LinkIcon, tone: "bg-amber-50 text-amber-600" },
  ];
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cells.map((c, i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl bg-white border border-gray-100 px-4 py-3 shadow-sm">
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${c.tone}`}>
            <c.icon size={18}/>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">{c.label}</p>
            <p className="text-xl font-semibold text-gray-900 leading-tight" style={{ fontVariantNumeric: "tabular-nums" }}>
              {c.value} <span className="text-xs font-medium text-gray-400">{c.sub}</span>
            </p>
          </div>
          {c.action && (
            <button onClick={onManageGroups}
              className="rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition">
              Удирдах
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Templates panel (left) ──────────────────────────────────────────────
function TemplatePanel({
  templates, groups, configs, search, setSearch,
  fGroup, setFGroup, fCat, setFCat, fPeriod, setFPeriod, fActive, setFActive,
  highlightedTpl, setHighlightedTpl,
  onCreate, onEdit, onDelete,
}: {
  templates: Template[]; groups: TaskGroup[]; configs: Config[];
  search: string; setSearch: (v: string) => void;
  fGroup: string; setFGroup: (v: string) => void;
  fCat: string; setFCat: (v: string) => void;
  fPeriod: string; setFPeriod: (v: string) => void;
  fActive: string; setFActive: (v: string) => void;
  highlightedTpl: number | null; setHighlightedTpl: (v: number | null) => void;
  onCreate: () => void; onEdit: (t: Template) => void; onDelete: (t: Template) => void;
}) {
  const hasFilters = !!(fGroup || fCat || fPeriod || fActive !== "all" || search);
  const filtered = templates.filter(t => {
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (fGroup && String(t.group_id) !== fGroup) return false;
    if (fCat && t.task_category !== fCat) return false;
    if (fPeriod && t.period !== fPeriod) return false;
    if (fActive === "active" && !t.is_active) return false;
    if (fActive === "inactive" && t.is_active) return false;
    return true;
  });
  const usageByTpl = useMemo(() => {
    const m = new Map<number, number>();
    configs.forEach(c => m.set(c.template_id, (m.get(c.template_id) || 0) + 1));
    return m;
  }, [configs]);
  const grouped = useMemo(() => {
    const out: { id: number | null; name: string; items: Template[] }[] = [];
    groups.forEach(g => {
      const items = filtered.filter(t => t.group_id === g.id);
      if (items.length) out.push({ id: g.id, name: g.name, items });
    });
    const ung = filtered.filter(t => t.group_id == null);
    if (ung.length) out.push({ id: null, name: "Бүлэггүй", items: ung });
    return out;
  }, [filtered, groups]);

  return (
    <div className="flex flex-col rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden h-[640px]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
        <SettingsIcon size={15} className="text-gray-400"/>
        <h2 className="text-sm font-semibold text-gray-900">Ажлын загвар</h2>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500" style={{ fontVariantNumeric: "tabular-nums" }}>
          {hasFilters ? `${filtered.length}/${templates.length}` : templates.length}
        </span>
        <button onClick={onCreate}
          className="ml-auto flex items-center gap-1 rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600 transition-colors">
          <Plus size={13}/> Шинэ загвар
        </button>
      </div>

      {/* Search + filter chips */}
      <div className="border-b border-gray-100 px-4 py-3 space-y-2 bg-gray-50/30">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Загвар хайх..."
            className="w-full rounded-xl border border-gray-200 bg-gray-50 pl-9 pr-8 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15 transition-all"/>
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600"><X size={11}/></button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterPill label="Бүлэг" value={fGroup} onChange={setFGroup}
            options={[{ value: "", label: "Бүгд" }, ...groups.map(g => ({ value: String(g.id), label: g.name }))]}/>
          <FilterPill label="Ангилал" value={fCat} onChange={setFCat}
            options={[{ value: "", label: "Бүгд" }, { value: "daily", label: "Өдөр тутмын" }, { value: "inventory", label: "Нэмэлт ажил" }]}/>
          <FilterPill label="Давтамж" value={fPeriod} onChange={setFPeriod}
            options={[{ value: "", label: "Бүгд" }, { value: "daily", label: "Өдөр бүр" }, { value: "weekly", label: "7 хоног" }, { value: "monthly", label: "Сар" }]}/>
          <FilterPill label="Төлөв" value={fActive} onChange={setFActive}
            options={[{ value: "all", label: "Бүгд" }, { value: "active", label: "Идэвхтэй" }, { value: "inactive", label: "Идэвхгүй" }]}/>
          {hasFilters && (
            <button onClick={() => { setSearch(""); setFGroup(""); setFCat(""); setFPeriod(""); setFActive("all"); }}
              className="text-[11px] font-semibold text-gray-400 hover:text-gray-600 ml-auto">Цэвэрлэх</button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {grouped.length === 0 ? (
          <EmptyState icon={Search} title="Илэрц олдсонгүй" desc="Хайлт эсвэл шүүлтүүрээ өөрчилнө үү"/>
        ) : grouped.map(g => (
          <div key={g.id ?? "ung"}>
            <div className="sticky top-0 z-10 bg-gray-50/95 backdrop-blur px-4 py-1.5 border-b border-gray-100 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{g.name}</span>
              <span className="text-[10px] font-medium text-gray-400" style={{ fontVariantNumeric: "tabular-nums" }}>{g.items.length}</span>
            </div>
            {g.items.map(t => {
              const usage = usageByTpl.get(t.id) || 0;
              const isDaily = t.task_category === "daily";
              const active = highlightedTpl === t.id;
              return (
                <div key={t.id} onClick={() => setHighlightedTpl(active ? null : t.id)}
                  className={`group flex items-stretch border-b border-gray-50 transition-colors cursor-pointer ${active ? "bg-blue-50/60" : "hover:bg-gray-50/60"} ${!t.is_active ? "opacity-50" : ""}`}>
                  <div className={`w-[3px] shrink-0 ${isDaily ? "bg-blue-500" : "bg-amber-400"}`}/>
                  <div className="flex flex-1 items-center gap-3 px-4 py-2.5 min-w-0">
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium leading-snug line-clamp-1 ${active ? "text-blue-900" : "text-gray-900"}`}>{t.name}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {isDaily ? (
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10.5px] font-semibold text-blue-700" style={{ fontVariantNumeric: "tabular-nums" }}>{t.weight_points} оноо</span>
                        ) : (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMoney(t.monetary_value)}₮</span>
                        )}
                        {!isDaily && <span className="rounded-full bg-amber-100/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">Нэмэлт</span>}
                        <PeriodBadge t={t}/>
                        {!t.is_active && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Идэвхгүй</span>}
                        <span className={`ml-auto flex items-center gap-0.5 text-[10.5px] ${usage > 0 ? "text-gray-500" : "text-gray-300"}`} style={{ fontVariantNumeric: "tabular-nums" }}>
                          <Users size={10}/> {usage}
                        </span>
                      </div>
                    </div>
                    <div className={`flex shrink-0 gap-0.5 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}>
                      <button onClick={(e) => { e.stopPropagation(); onEdit(t); }}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700"><Pencil size={13}/></button>
                      <button onClick={(e) => { e.stopPropagation(); onDelete(t); }}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={13}/></button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Assignment panel (right) ─────────────────────────────────────────────
type View = "matrix" | "employee" | "role";

function AssignmentPanel({
  templates, groups, configs, users, visibleRoles, roleLabel, roleSortIndex,
  view, setView,
  roleFilter, setRoleFilter, groupFilter, setGroupFilter, search, setSearch,
  highlightedTpl, setHighlightedTpl, highlightedEmp, setHighlightedEmp,
  onToggle, onRemove, onBulkAssignRole, onBulkRemoveRole, onChangeApprover,
}: {
  templates: Template[]; groups: TaskGroup[]; configs: Config[]; users: UserOption[];
  visibleRoles: RoleOption[];
  roleLabel: (v: string) => string;
  roleSortIndex: Map<string, number>;
  view: View; setView: (v: View) => void;
  roleFilter: string; setRoleFilter: (v: string) => void;
  groupFilter: string; setGroupFilter: (v: string) => void;
  search: string; setSearch: (v: string) => void;
  highlightedTpl: number | null; setHighlightedTpl: (v: number | null) => void;
  highlightedEmp: number | null; setHighlightedEmp: (v: number | null) => void;
  onToggle: (empId: number, tplId: number) => Promise<void>;
  onRemove: (cfgId: number) => Promise<void>;
  onBulkAssignRole: (tplId: number, role: string) => Promise<void>;
  onBulkRemoveRole: (tplId: number, role: string) => Promise<void>;
  onChangeApprover: (cfgId: number, approverId: number) => Promise<void>;
}) {
  const highlightedTplObj = templates.find(t => t.id === highlightedTpl);
  return (
    <div className="flex flex-col rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden h-[640px]">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
        <LinkIcon size={15} className="text-gray-400"/>
        <h2 className="text-sm font-semibold text-gray-900">Хуваарилалт</h2>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500" style={{ fontVariantNumeric: "tabular-nums" }}>{configs.length}</span>
        <div className="ml-auto inline-flex rounded-xl bg-gray-100 p-1">
          {([
            { v: "matrix" as const, label: "Матриц" },
            { v: "employee" as const, label: "Ажилтнаар" },
            { v: "role" as const, label: "Тушаалаар" },
          ]).map(o => (
            <button key={o.v} onClick={() => setView(o.v)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${view === o.v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Sub-toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2.5 bg-gray-50/30">
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}
          className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 focus:border-[#0071E3] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15">
          <option value="all">Бүх тушаал</option>
          {visibleRoles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        {/* Зөвхөн матриц/тушаалаар view-д бүлгийн шүүлтүүр хэрэгтэй (ажилтнаар view-д баруун талын карт бүлгээр харагдаж байгаа тул шаардлагагүй) */}
        {(view === "matrix" || view === "role") && (
          <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)}
            className={`rounded-lg border px-2.5 py-1 text-xs font-semibold focus:border-[#0071E3] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15 ${
              groupFilter === "all"
                ? "border-gray-200 bg-white text-gray-700"
                : "border-[#0071E3] bg-[#0071E3] text-white"
            }`}>
            <option value="all">Бүх бүлэг</option>
            <option value="ung">Бүлэггүй</option>
            {groups.filter(g => g.is_active).map(g => (
              <option key={g.id} value={String(g.id)}>{g.name}</option>
            ))}
          </select>
        )}
        <div className="relative flex-1 max-w-[280px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={view === "matrix" ? "Ажилтны нэрээр шүүх..." : view === "employee" ? "Ажилтан хайх..." : "Тушаал хайх..."}
            className="w-full rounded-xl border border-gray-200 bg-gray-50 pl-9 pr-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15 transition-all"/>
        </div>
        {highlightedTpl && highlightedTplObj && (
          <div className="flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 ring-1 ring-blue-100">
            <span className="inline-block h-2 w-2 rounded-full bg-blue-500"/>
            {highlightedTplObj.name}
            <button onClick={() => setHighlightedTpl(null)} className="ml-1 text-blue-400 hover:text-blue-600"><X size={11}/></button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 text-[10.5px] text-gray-400">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-blue-500"/>Хуваарилагдсан</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full border border-gray-300"/>Хуваарилаагүй</span>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {view === "matrix" && (
          <MatrixView templates={templates} groups={groups} configs={configs} users={users}
            roleLabel={roleLabel} roleSortIndex={roleSortIndex}
            roleFilter={roleFilter} groupFilter={groupFilter} search={search}
            highlightedTpl={highlightedTpl} setHighlightedTpl={setHighlightedTpl}
            highlightedEmp={highlightedEmp} setHighlightedEmp={setHighlightedEmp}
            onToggle={onToggle}/>
        )}
        {view === "employee" && (
          <EmployeeView templates={templates} groups={groups} configs={configs} users={users}
            roleLabel={roleLabel} roleSortIndex={roleSortIndex}
            roleFilter={roleFilter} search={search}
            highlightedEmp={highlightedEmp} setHighlightedEmp={setHighlightedEmp}
            onToggle={onToggle} onRemove={onRemove} onChangeApprover={onChangeApprover}/>
        )}
        {view === "role" && (
          <RoleView templates={templates} groups={groups} configs={configs} users={users}
            visibleRoles={visibleRoles}
            roleFilter={roleFilter} setRoleFilter={setRoleFilter}
            groupFilter={groupFilter} search={search}
            onBulkAssign={onBulkAssignRole} onBulkRemove={onBulkRemoveRole}/>
        )}
      </div>
    </div>
  );
}

// ── Matrix view ─────────────────────────────────────────────────────────
function MatrixView({
  templates, groups, configs, users, roleLabel, roleSortIndex,
  roleFilter, groupFilter, search,
  highlightedTpl, setHighlightedTpl, highlightedEmp, setHighlightedEmp,
  onToggle,
}: {
  templates: Template[]; groups: TaskGroup[]; configs: Config[]; users: UserOption[];
  roleLabel: (v: string) => string;
  roleSortIndex: Map<string, number>;
  roleFilter: string;
  /** "all" | "ung" | "<groupId>" */
  groupFilter: string;
  search: string;
  highlightedTpl: number | null; setHighlightedTpl: (v: number | null) => void;
  highlightedEmp: number | null; setHighlightedEmp: (v: number | null) => void;
  onToggle: (empId: number, tplId: number) => Promise<void>;
}) {
  const employees = users.filter(u => u.role !== "admin")
    .filter(u => roleFilter === "all" || u.role === roleFilter)
    .filter(u => !search || dispName(u).toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const ra = roleSortIndex.get(a.role) ?? 99;
      const rb = roleSortIndex.get(b.role) ?? 99;
      if (ra !== rb) return ra - rb;
      return dispName(a).localeCompare(dispName(b));
    });

  const tplOrdered = useMemo(() => {
    const out: (Template & { _group: string })[] = [];
    // groupFilter: "all" → бүх бүлэг, "ung" → зөвхөн бүлэггүй, эсвэл group_id-ээр шүүх
    const wantUng = groupFilter === "ung";
    const wantGroupId = groupFilter !== "all" && groupFilter !== "ung" ? Number(groupFilter) : null;
    if (!wantUng) {
      groups.forEach(g => {
        if (wantGroupId !== null && g.id !== wantGroupId) return;
        templates.filter(t => t.group_id === g.id && t.is_active)
          .forEach(t => out.push({ ...t, _group: g.name }));
      });
    }
    if (wantUng || groupFilter === "all") {
      templates.filter(t => t.group_id == null && t.is_active)
        .forEach(t => out.push({ ...t, _group: "Бүлэггүй" }));
    }
    return out;
  }, [templates, groups, groupFilter]);

  const has = (eid: number, tid: number) => configs.some(c => c.employee_id === eid && c.template_id === tid);
  const rowCount = (eid: number) => configs.filter(c => c.employee_id === eid).length;
  const colCount = (tid: number) => configs.filter(c => c.template_id === tid).length;
  const cellW = 36;

  if (employees.length === 0) {
    return <EmptyState icon={Search} title="Ажилтан олдсонгүй" desc="Шүүлтүүрийг өөрчилнө үү"/>;
  }
  if (tplOrdered.length === 0) {
    return <EmptyState icon={SettingsIcon} title="Идэвхтэй загвар алга" desc="Эхлээд зүүн талаас загвар үүсгэнэ үү"/>;
  }

  const groupBreaks: { idx: number; name: string }[] = [];
  let lastG: string | null = null;
  tplOrdered.forEach((t, i) => { if (t._group !== lastG) { groupBreaks.push({ idx: i, name: t._group }); lastG = t._group; }});

  // Build rows with role separators
  const rows: React.ReactNode[] = [];
  let lastRole: string | null = null;
  employees.forEach(u => {
    if (u.role !== lastRole) {
      rows.push(
        <tr key={`r-${u.role}`}>
          <td className="sticky left-0 z-10 bg-gray-50 border-b border-r border-gray-100 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">
            {roleLabel(u.role)} <span className="ml-1 text-gray-400">· {employees.filter(e => e.role === u.role).length}</span>
          </td>
          <td colSpan={tplOrdered.length + 1} className="bg-gray-50 border-b border-gray-100"/>
        </tr>
      );
      lastRole = u.role;
    }
    const isHL = highlightedEmp === u.id;
    rows.push(
      <tr key={u.id} className={isHL ? "bg-blue-50/40" : ""}>
        <td onClick={() => setHighlightedEmp(isHL ? null : u.id)}
          className={`sticky left-0 z-10 border-b border-r border-gray-100 px-3 py-2 cursor-pointer transition-colors ${isHL ? "bg-blue-50" : "bg-white hover:bg-gray-50"}`}>
          <div className="flex items-center gap-2">
            <Avatar user={u} size={26}/>
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold text-gray-900 truncate">{dispName(u)}</p>
              <p className="text-[10px] text-gray-400 truncate">@{u.username}</p>
            </div>
          </div>
        </td>
        {tplOrdered.map(t => {
          const v = has(u.id, t.id);
          const colHL = highlightedTpl === t.id;
          return (
            <td key={t.id} onClick={() => onToggle(u.id, t.id)}
              className={`border-b border-r border-gray-100 text-center cursor-pointer transition-colors ${colHL ? "bg-blue-50/40" : "hover:bg-gray-50"}`}
              style={{ width: cellW, height: 38 }}>
              {v ? (
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#0071E3] text-white">
                  <Check size={11} strokeWidth={3}/>
                </span>
              ) : (
                <span className="inline-block h-3 w-3 rounded-full border border-gray-200 hover:border-blue-400"/>
              )}
            </td>
          );
        })}
        <td className="border-b border-gray-100 text-center text-[11.5px] font-semibold text-gray-700" style={{ fontVariantNumeric: "tabular-nums" }}>
          {rowCount(u.id)}
        </td>
      </tr>
    );
  });

  return (
    <div className="h-full overflow-auto relative">
      <table className="border-separate" style={{ borderSpacing: 0 }}>
        <thead>
          {/* Group row */}
          <tr>
            <th className="sticky left-0 top-0 z-30 bg-white border-b border-r border-gray-100" style={{ minWidth: 220 }}/>
            {tplOrdered.map((t, i) => {
              const isFirst = groupBreaks.find(b => b.idx === i);
              if (!isFirst) return null;
              const next = groupBreaks.find(b => b.idx > i);
              const span = (next ? next.idx : tplOrdered.length) - i;
              return (
                <th key={`g-${i}`} colSpan={span}
                  className="sticky top-0 z-20 bg-gray-50/95 backdrop-blur border-b border-r border-gray-100 px-2 py-1 text-left">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{t._group}</span>
                </th>
              );
            })}
          </tr>
          {/* Template header */}
          <tr>
            <th className="sticky left-0 top-[26px] z-30 bg-white border-b border-r border-gray-100 px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-gray-500" style={{ minWidth: 220 }}>
              Ажилтан / Загвар
            </th>
            {tplOrdered.map(t => {
              const cls = highlightedTpl === t.id ? "bg-blue-50" : "bg-white hover:bg-gray-50";
              const isDaily = t.task_category === "daily";
              return (
                <th key={t.id}
                  onClick={() => setHighlightedTpl(highlightedTpl === t.id ? null : t.id)}
                  className={`sticky top-[26px] z-20 border-b border-r border-gray-100 ${cls} cursor-pointer transition-colors relative`}
                  style={{ width: cellW, minWidth: cellW, height: 140 }}
                  title={t.name}>
                  <div className="flex flex-col items-center justify-end h-full pb-1.5">
                    <div className="origin-bottom-left translate-y-[-6px] translate-x-[14px] -rotate-[55deg] whitespace-nowrap text-[11px] font-medium text-gray-700" style={{ width: 130 }}>
                      <span className="line-clamp-1">{t.name}</span>
                    </div>
                    <div className={`absolute bottom-1 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full ${isDaily ? "bg-blue-500" : "bg-amber-400"}`}/>
                  </div>
                </th>
              );
            })}
            <th className="sticky top-[26px] right-0 z-20 bg-white border-b border-gray-100 px-3 text-center text-[10px] font-bold uppercase tracking-wider text-gray-500" style={{ width: 60, height: 140 }}>
              <div className="flex flex-col items-center justify-end h-full pb-1.5">
                <div className="-rotate-[55deg] whitespace-nowrap">Нийт</div>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows}
          {/* Totals row */}
          <tr>
            <td className="sticky left-0 z-10 bg-gray-50 border-r border-gray-100 px-3 py-2 text-[10.5px] font-bold uppercase tracking-wider text-gray-500">
              Нийт хуваарилалт
            </td>
            {tplOrdered.map(t => (
              <td key={t.id} className="bg-gray-50 text-center text-[11.5px] font-semibold text-gray-700 border-r border-gray-100" style={{ fontVariantNumeric: "tabular-nums" }}>
                {colCount(t.id)}
              </td>
            ))}
            <td className="bg-gray-50 text-center text-[11.5px] font-bold text-blue-700" style={{ fontVariantNumeric: "tabular-nums" }}>
              {configs.length}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Employee view ───────────────────────────────────────────────────────
function EmployeeView({
  templates, groups, configs, users, roleLabel, roleSortIndex, roleFilter, search,
  highlightedEmp, setHighlightedEmp, onToggle, onRemove, onChangeApprover,
}: {
  templates: Template[]; groups: TaskGroup[]; configs: Config[]; users: UserOption[];
  roleLabel: (v: string) => string;
  roleSortIndex: Map<string, number>;
  roleFilter: string; search: string;
  highlightedEmp: number | null; setHighlightedEmp: (v: number | null) => void;
  onToggle: (empId: number, tplId: number) => Promise<void>;
  onRemove: (cfgId: number) => Promise<void>;
  onChangeApprover: (cfgId: number, approverId: number) => Promise<void>;
}) {
  const employees = users.filter(u => u.role !== "admin")
    .filter(u => roleFilter === "all" || u.role === roleFilter)
    .filter(u => !search || dispName(u).toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const ra = roleSortIndex.get(a.role) ?? 99;
      const rb = roleSortIndex.get(b.role) ?? 99;
      if (ra !== rb) return ra - rb;
      return dispName(a).localeCompare(dispName(b));
    });
  const sel = employees.find(u => u.id === highlightedEmp) || employees[0];
  const [addMode, setAddMode] = useState(false);
  const [addSearch, setAddSearch] = useState("");

  if (employees.length === 0) {
    return <EmptyState icon={Users} title="Ажилтан олдсонгүй"/>;
  }

  const myCfgs = sel ? configs.filter(c => c.employee_id === sel.id) : [];
  const myTplIds = new Set(myCfgs.map(c => c.template_id));
  const dailyPts = myCfgs.reduce((s, c) => {
    const t = templates.find(x => x.id === c.template_id);
    return s + (t?.task_category === "daily" ? (t?.weight_points || 0) : 0);
  }, 0);
  const invBudget = myCfgs.reduce((s, c) => {
    const t = templates.find(x => x.id === c.template_id);
    return s + (t?.task_category === "inventory" ? (t?.monetary_value || 0) : 0);
  }, 0);

  const empListItems: React.ReactNode[] = [];
  let lastRole: string | null = null;
  employees.forEach(u => {
    if (u.role !== lastRole) {
      empListItems.push(
        <div key={`r-${u.role}`} className="sticky top-0 z-10 bg-gray-50/95 backdrop-blur px-4 py-1.5 border-b border-gray-100">
          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{roleLabel(u.role)}</span>
        </div>
      );
      lastRole = u.role;
    }
    const active = sel?.id === u.id;
    const count = configs.filter(c => c.employee_id === u.id).length;
    empListItems.push(
      <button key={u.id} onClick={() => { setHighlightedEmp(u.id); setAddMode(false); }}
        className={`w-full flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-50 text-left transition-colors ${active ? "bg-blue-50" : "hover:bg-gray-50"}`}>
        <Avatar user={u} size={28}/>
        <div className="min-w-0 flex-1">
          <p className={`text-[12.5px] font-semibold truncate ${active ? "text-blue-900" : "text-gray-900"}`}>{dispName(u)}</p>
          <p className="text-[10px] text-gray-400 truncate">@{u.username}</p>
        </div>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${count > 0 ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-400"}`} style={{ fontVariantNumeric: "tabular-nums" }}>{count}</span>
      </button>
    );
  });

  const groupedCfgs = groups.map(g => ({
    name: g.name,
    items: myCfgs.map(c => ({ c, t: templates.find(x => x.id === c.template_id)! })).filter(x => x.t && x.t.group_id === g.id),
  })).filter(x => x.items.length > 0);
  const ungCfgs = myCfgs.map(c => ({ c, t: templates.find(x => x.id === c.template_id)! })).filter(x => x.t && x.t.group_id == null);
  const sections = [...groupedCfgs, ...(ungCfgs.length ? [{ name: "Бүлэггүй", items: ungCfgs }] : [])];

  const availableTpls = templates.filter(t => t.is_active && !myTplIds.has(t.id))
    .filter(t => !addSearch || t.name.toLowerCase().includes(addSearch.toLowerCase()));
  const availableGrouped = groups.map(g => ({ name: g.name, items: availableTpls.filter(t => t.group_id === g.id) })).filter(g => g.items.length);
  const availableUng = availableTpls.filter(t => t.group_id == null);
  const availableSections = [...availableGrouped, ...(availableUng.length ? [{ name: "Бүлэггүй", items: availableUng }] : [])];

  return (
    <div className="h-full grid" style={{ gridTemplateColumns: "240px 1fr" }}>
      <div className="overflow-y-auto border-r border-gray-100">{empListItems}</div>
      {sel ? (
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-3">
            <Avatar user={sel} size={40}/>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-gray-900 truncate">{dispName(sel)}</p>
              <p className="text-xs text-gray-500">{roleLabel(sel.role)} · @{sel.username}</p>
            </div>
            <div className="flex items-center gap-3 text-[11px]">
              <div className="text-right">
                <p className="text-gray-400">Нийт оноо</p>
                <p className="text-sm font-bold text-blue-700" style={{ fontVariantNumeric: "tabular-nums" }}>{dailyPts}</p>
              </div>
              <div className="h-8 w-px bg-gray-100"/>
              <div className="text-right">
                <p className="text-gray-400">Нэмэлт ажил</p>
                <p className="text-sm font-bold text-amber-700" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMoney(invBudget)}₮</p>
              </div>
            </div>
            <button onClick={() => setAddMode(v => !v)}
              className={`ml-2 flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${addMode ? "bg-gray-100 text-gray-700" : "bg-[#0071E3] text-white hover:bg-blue-600"}`}>
              {addMode ? <><X size={12}/> Болих</> : <><Plus size={13}/> Ажил нэмэх</>}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {addMode ? (
              <div>
                <div className="sticky top-0 z-10 px-5 py-3 bg-white border-b border-gray-100">
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/>
                    <input value={addSearch} onChange={e => setAddSearch(e.target.value)} placeholder="Нэмэх ажлаа хайх..."
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 pl-9 pr-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15 transition-all"/>
                  </div>
                </div>
                {availableTpls.length === 0 ? (
                  <EmptyState icon={CheckCircle} title="Бүх ажил хуваарилагдсан" desc="Нэмэх боломжтой загвар үлдсэнгүй"/>
                ) : availableSections.map((sec, si) => (
                  <div key={si}>
                    <div className="sticky top-[60px] bg-gray-50/95 backdrop-blur px-5 py-1.5 border-b border-gray-100">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{sec.name}</span>
                    </div>
                    {sec.items.map(t => {
                      const isDaily = t.task_category === "daily";
                      return (
                        <button key={t.id} onClick={() => onToggle(sel.id, t.id)}
                          className="w-full group flex items-stretch border-b border-gray-50 hover:bg-blue-50/30 transition-colors text-left">
                          <div className={`w-[3px] shrink-0 ${isDaily ? "bg-blue-500" : "bg-amber-400"}`}/>
                          <div className="flex flex-1 items-center gap-3 px-5 py-2.5 min-w-0">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 leading-snug line-clamp-1">{t.name}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                {isDaily
                                  ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10.5px] font-semibold text-blue-700" style={{ fontVariantNumeric: "tabular-nums" }}>{t.weight_points} оноо</span>
                                  : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMoney(t.monetary_value)}₮</span>}
                                <PeriodBadge t={t}/>
                              </div>
                            </div>
                            <span className="rounded-lg bg-[#0071E3] px-2.5 py-1 text-[11px] font-semibold text-white opacity-0 group-hover:opacity-100 transition-opacity">+ Нэмэх</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : myCfgs.length === 0 ? (
              <EmptyState icon={List} title="Ажил хуваарилаагүй байна"
                desc="Энэ ажилтанд KPI ажил хараахан хуваарилаагүй байна."
                action={<button onClick={() => setAddMode(true)} className="rounded-lg bg-[#0071E3] px-4 py-2 text-xs font-semibold text-white hover:bg-blue-600 transition-colors flex items-center gap-1.5"><Plus size={13}/> Эхний ажил нэмэх</button>}/>
            ) : (
              <div>
                {sections.map((sec, si) => (
                  <div key={si}>
                    <div className="sticky top-0 bg-gray-50/95 backdrop-blur px-5 py-1.5 border-b border-gray-100 flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{sec.name}</span>
                      <span className="text-[10px] font-medium text-gray-400" style={{ fontVariantNumeric: "tabular-nums" }}>{sec.items.length}</span>
                    </div>
                    {sec.items.map(({ c, t }) => {
                      const isDaily = t.task_category === "daily";
                      return (
                        <div key={c.id} className="group flex items-stretch border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                          <div className={`w-[3px] shrink-0 ${isDaily ? "bg-blue-500" : "bg-amber-400"}`}/>
                          <div className="flex flex-1 items-center gap-3 px-5 py-2.5 min-w-0">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 leading-snug line-clamp-1">{t.name}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                {isDaily
                                  ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10.5px] font-semibold text-blue-700" style={{ fontVariantNumeric: "tabular-nums" }}>{t.weight_points} оноо</span>
                                  : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMoney(t.monetary_value)}₮</span>}
                                <PeriodBadge t={t}/>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] text-gray-400">Зөвш:</span>
                              <select value={c.approver_id} onChange={(e) => onChangeApprover(c.id, parseInt(e.target.value))}
                                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11.5px] font-medium text-gray-700 focus:border-[#0071E3] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15">
                                {users.map(u => <option key={u.id} value={u.id}>{dispName(u)}</option>)}
                              </select>
                            </div>
                            <button onClick={() => onRemove(c.id)}
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                              <Trash2 size={13}/>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <EmptyState icon={UserIcon} title="Ажилтан сонгоно уу"/>
      )}
    </div>
  );
}

// ── Role view ───────────────────────────────────────────────────────────
function RoleView({
  templates, groups, configs, users, visibleRoles, roleFilter, setRoleFilter,
  groupFilter, search,
  onBulkAssign, onBulkRemove,
}: {
  templates: Template[]; groups: TaskGroup[]; configs: Config[]; users: UserOption[];
  visibleRoles: RoleOption[];
  roleFilter: string; setRoleFilter: (v: string) => void;
  /** "all" | "ung" | "<groupId>" */
  groupFilter: string;
  search: string;
  onBulkAssign: (tplId: number, role: string) => Promise<void>;
  onBulkRemove: (tplId: number, role: string) => Promise<void>;
}) {
  // "all" эсвэл байхгүй тушаал бол эхний жинхэнэ тушаал руу унах
  const effectiveRole = (roleFilter !== "all" && visibleRoles.some(r => r.value === roleFilter))
    ? roleFilter
    : (visibleRoles[0]?.value ?? "");
  const targets = users.filter(u => u.role === effectiveRole);
  const filtered = templates.filter(t => t.is_active && (!search || t.name.toLowerCase().includes(search.toLowerCase())));
  const wantUng = groupFilter === "ung";
  const wantGroupId = groupFilter !== "all" && groupFilter !== "ung" ? Number(groupFilter) : null;
  const grouped = wantUng
    ? []
    : groups
        .filter(g => wantGroupId === null || g.id === wantGroupId)
        .map(g => ({ name: g.name, items: filtered.filter(t => t.group_id === g.id) }))
        .filter(g => g.items.length);
  const ung = (groupFilter === "all" || wantUng) ? filtered.filter(t => t.group_id == null) : [];
  const sections = [...grouped, ...(ung.length ? [{ name: "Бүлэггүй", items: ung }] : [])];

  return (
    <div className="h-full overflow-y-auto">
      {/* Role chip strip */}
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-100 px-5 py-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-gray-500">Тушаал:</span>
        {visibleRoles.map(r => {
          const active = effectiveRole === r.value;
          const cnt = users.filter(u => u.role === r.value).length;
          return (
            <button key={r.value} onClick={() => setRoleFilter(r.value)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${active ? "bg-[#0071E3] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              {r.label} <span className={active ? "text-white/70" : "text-gray-400"}>· {cnt}</span>
            </button>
          );
        })}
      </div>

      {sections.length === 0 ? (
        <EmptyState icon={Search} title="Загвар олдсонгүй"/>
      ) : sections.map((sec, si) => (
        <div key={si}>
          <div className="bg-gray-50/95 backdrop-blur px-5 py-1.5 border-b border-gray-100">
            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{sec.name}</span>
          </div>
          {sec.items.map(t => {
            const cfgs = configs.filter(c => c.template_id === t.id && targets.some(u => u.id === c.employee_id));
            const assigned = cfgs.length;
            const total = targets.length;
            const fully = total > 0 && assigned === total;
            const partial = assigned > 0 && assigned < total;
            const isDaily = t.task_category === "daily";
            return (
              <div key={t.id} className="flex items-stretch border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                <div className={`w-[3px] shrink-0 ${isDaily ? "bg-blue-500" : "bg-amber-400"}`}/>
                <div className="flex flex-1 items-center gap-3 px-5 py-3">
                  <div className={`h-2 w-2 shrink-0 rounded-full ${fully ? "bg-emerald-500" : partial ? "bg-amber-400" : "bg-gray-200"}`}/>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{t.name}</p>
                    <p className="mt-0.5 text-[11px] text-gray-500">
                      {fully
                        ? <span className="text-emerald-700 font-semibold">Бүгдэд хуваарилагдсан ({total}/{total})</span>
                        : partial
                          ? <span className="text-amber-700 font-semibold">{assigned}/{total} ажилтанд</span>
                          : <span className="text-gray-400">Хуваарилаагүй</span>}
                    </p>
                  </div>
                  <div className="w-24 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                    <div className={`h-full transition-all ${fully ? "bg-emerald-500" : partial ? "bg-amber-400" : "bg-gray-300"}`}
                      style={{ width: `${total > 0 ? (assigned / total) * 100 : 0}%` }}/>
                  </div>
                  {fully ? (
                    <button onClick={() => onBulkRemove(t.id, effectiveRole)}
                      className="flex items-center gap-1 rounded-lg bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition-colors">
                      <X size={11}/> Бүгдээс хасах
                    </button>
                  ) : (
                    <button onClick={() => onBulkAssign(t.id, effectiveRole)}
                      className="flex items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 transition-colors">
                      <Plus size={11}/> {partial ? `+${total - assigned} нэмэх` : "Бүгдэд нэмэх"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Template Editor modal ───────────────────────────────────────────────
function TemplateEditor({ open, editTpl, groups, onClose, onSave }: {
  open: boolean; editTpl: Template | null; groups: TaskGroup[];
  onClose: () => void;
  onSave: (payload: any) => Promise<void>;
}) {
  const [name, setName] = useState(editTpl?.name ?? "");
  const [groupId, setGroupId] = useState(editTpl?.group_id ? String(editTpl.group_id) : "");
  const [cat, setCat] = useState(editTpl?.task_category ?? "daily");
  const [pts, setPts] = useState(String(editTpl?.weight_points ?? ""));
  const [amt, setAmt] = useState(String(editTpl?.monetary_value ?? ""));
  const [period, setPeriod] = useState(editTpl?.period ?? "daily");
  const [dow, setDow] = useState(editTpl?.day_of_week != null ? String(editTpl.day_of_week) : "");
  const [dom, setDom] = useState(editTpl?.day_of_month != null ? String(editTpl.day_of_month) : "");
  const [active, setActive] = useState(editTpl?.is_active ?? true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editTpl?.name ?? "");
    setGroupId(editTpl?.group_id ? String(editTpl.group_id) : "");
    setCat(editTpl?.task_category ?? "daily");
    setPts(String(editTpl?.weight_points ?? ""));
    setAmt(String(editTpl?.monetary_value ?? ""));
    setPeriod(editTpl?.period ?? "daily");
    setDow(editTpl?.day_of_week != null ? String(editTpl.day_of_week) : "");
    setDom(editTpl?.day_of_month != null ? String(editTpl.day_of_month) : "");
    setActive(editTpl?.is_active ?? true);
  }, [open, editTpl]);

  if (!open) return null;
  const canSave = !!name.trim() && (cat === "daily" ? pts !== "" : amt !== "");
  const inp = "w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#0071E3] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15 transition-all";

  async function submit() {
    setSaving(true);
    try {
      await onSave({
        id: editTpl?.id,
        name: name.trim(),
        description: "",
        group_id: groupId ? parseInt(groupId) : null,
        task_category: cat,
        weight_points: cat === "daily" ? parseFloat(pts || "0") : 0,
        monetary_value: cat === "inventory" ? parseFloat(amt || "0") : 0,
        period,
        day_of_week: period === "weekly" && dow !== "" ? parseInt(dow) : null,
        day_of_month: period === "monthly" && dom !== "" ? parseInt(dom) : null,
        is_active: active,
      });
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{editTpl ? "Загвар засварлах" : "Шинэ загвар үүсгэх"}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Ажилтнуудад хуваарилах KPI ажлын загвар</p>
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"><X size={16}/></button>
        </div>
        <div className="px-6 py-5 max-h-[70vh] overflow-y-auto space-y-4">
          <div className="grid grid-cols-2 gap-2 p-1 bg-gray-100 rounded-xl">
            {[
              { v: "daily", label: "Өдөр тутмын ажил", desc: "Оноогоор дүгнэнэ", icon: List, color: "blue" as const },
              { v: "inventory", label: "Нэмэлт ажил", desc: "Мөнгөн дүнтэй", icon: Layers, color: "amber" as const },
            ].map(o => (
              <button key={o.v} onClick={() => setCat(o.v)}
                className={`flex items-start gap-2 p-2.5 rounded-lg text-left transition-all ${cat === o.v ? "bg-white shadow-sm" : "hover:bg-white/40"}`}>
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${cat === o.v ? (o.color === "blue" ? "bg-blue-100 text-blue-600" : "bg-amber-100 text-amber-600") : "bg-gray-200 text-gray-400"}`}>
                  <o.icon size={15}/>
                </div>
                <div>
                  <p className={`text-xs font-semibold ${cat === o.v ? "text-gray-900" : "text-gray-500"}`}>{o.label}</p>
                  <p className="text-[10.5px] text-gray-400 mt-0.5">{o.desc}</p>
                </div>
              </button>
            ))}
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Ажлын нэр *</label>
            <textarea value={name} onChange={e => setName(e.target.value)} rows={2}
              className={inp + " resize-none leading-relaxed"} placeholder="Жишээ нь: Өглөөний хяналт..."/>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Бүлэг</label>
              <select value={groupId} onChange={e => setGroupId(e.target.value)} className={inp}>
                <option value="">— Бүлэггүй —</option>
                {groups.filter(g => g.is_active).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Давтамж</label>
              <select value={period} onChange={e => { setPeriod(e.target.value); setDow(""); setDom(""); }} className={inp}>
                <option value="daily">Өдөр бүр</option>
                <option value="weekly">7 хоног бүр</option>
                <option value="monthly">Сар бүр</option>
              </select>
            </div>
          </div>
          {period === "weekly" && (
            <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-3">
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-violet-700">Гариг</label>
              <select value={dow} onChange={e => setDow(e.target.value)} className="w-full rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300">
                <option value="">Аль ч өдөр</option>
                {MON_FULL.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
          )}
          {period === "monthly" && (
            <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-3">
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-amber-700">Сарын өдөр</label>
              <select value={dom} onChange={e => setDom(e.target.value)} className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300">
                <option value="">Аль ч өдөр</option>
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}-нд</option>)}
              </select>
            </div>
          )}
          {cat === "daily" ? (
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-gray-500">Оноо (жин) *</label>
              <input type="number" value={pts} onChange={e => setPts(e.target.value)} className={inp} placeholder="жишээ нь 10"/>
              <p className="mt-1 text-xs text-gray-400">Энэ ажил бусдаас хичнээн чухал вэ? Их оноо = их жин</p>
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-amber-700">Мөнгөн дүн (₮) *</label>
              <div className="relative">
                <input type="number" value={amt} onChange={e => setAmt(e.target.value)} className={inp + " pr-8"} placeholder="0"/>
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-amber-400">₮</span>
              </div>
            </div>
          )}
          <label className="flex cursor-pointer items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">Идэвхтэй</p>
              <p className="text-[11px] text-gray-500">Хаасан загварыг ажилтанд хуваарилах боломжгүй болно</p>
            </div>
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="h-5 w-5 accent-[#0071E3]"/>
          </label>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 bg-gray-50/60">
          <button onClick={onClose} className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm text-gray-700 hover:bg-gray-100 transition">Болих</button>
          <button onClick={submit} disabled={!canSave || saving}
            className="flex-1 rounded-xl bg-[#0071E3] py-2.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-40 transition">
            {saving ? "Хадгалж байна..." : (editTpl ? "Шинэчлэх" : "Үүсгэх")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Group manager modal ────────────────────────────────────────────────
function GroupManager({ open, groups, onClose, onCreate, onRename, onDelete, notify }: {
  open: boolean; groups: TaskGroup[]; onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (g: TaskGroup, name: string) => Promise<void>;
  onDelete: (g: TaskGroup) => Promise<void>;
  notify: (m: string, ok?: boolean) => void;
}) {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Ажлын бүлэг удирдах</h2>
            <p className="text-xs text-gray-500 mt-0.5">Загваруудыг ангилахад хэрэглэнэ</p>
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-gray-400 hover:bg-gray-100"><X size={16}/></button>
        </div>
        <div className="px-6 py-5 space-y-3 max-h-[60vh] overflow-y-auto">
          <div className="flex gap-2">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Шинэ бүлгийн нэр..."
              className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-[#0071E3] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/15"
              onKeyDown={async e => { if (e.key === "Enter" && newName.trim()) { await onCreate(newName.trim()); setNewName(""); }}}/>
            <button onClick={async () => { if (newName.trim()) { await onCreate(newName.trim()); setNewName(""); }}}
              disabled={!newName.trim()}
              className="rounded-xl bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-40 transition">
              Нэмэх
            </button>
          </div>
          <div className="space-y-1.5">
            {groups.map(g => (
              <div key={g.id} className="flex items-center gap-2 rounded-xl border border-gray-100 px-3 py-2">
                {editingId === g.id ? (
                  <>
                    <input value={editName} onChange={e => setEditName(e.target.value)} autoFocus
                      className="flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm focus:border-[#0071E3] focus:outline-none"/>
                    <button onClick={async () => { await onRename(g, editName); setEditingId(null); }}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-700">Хадгалах</button>
                    <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:text-gray-600">Болих</button>
                  </>
                ) : (
                  <>
                    <Layers size={14} className="text-gray-400"/>
                    <p className="flex-1 text-sm text-gray-800">{g.name}</p>
                    <button onClick={() => { setEditingId(g.id); setEditName(g.name); }}
                      className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"><Pencil size={12}/></button>
                    <button onClick={async () => {
                      if (confirm(`"${g.name}" бүлгийг устгах уу? Энэ бүлэгт байгаа загвар "Бүлэггүй" болно.`)) {
                        await onDelete(g);
                      }
                    }} className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={12}/></button>
                  </>
                )}
              </div>
            ))}
            {groups.length === 0 && (
              <p className="text-center text-xs text-gray-400 py-4">Бүлэг үүсээгүй байна</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────
export default function KpiAdminConfig() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [configs, setConfigs] = useState<Config[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Template editor
  const [tplModal, setTplModal] = useState(false);
  const [editTpl, setEditTpl] = useState<Template | null>(null);
  const [confirmDel, setConfirmDel] = useState<Template | null>(null);

  // Group manager
  const [grpModal, setGrpModal] = useState(false);

  // Template filters
  const [tplSearch, setTplSearch] = useState("");
  const [fGroup, setFGroup] = useState("");
  const [fCat, setFCat] = useState("");
  const [fPeriod, setFPeriod] = useState("");
  const [fActive, setFActive] = useState("all");

  // Highlights
  const [highlightedTpl, setHighlightedTpl] = useState<number | null>(null);
  const [highlightedEmp, setHighlightedEmp] = useState<number | null>(null);

  // Assignment panel
  const [view, setView] = useState<View>("matrix");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [aSearch, setASearch] = useState("");

  function notify(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 2500);
  }

  async function loadAll() {
    try {
      const [tplRes, grpRes, userRes, cfgRes, roleRes] = await Promise.all([
        api.get("/kpi/templates"),
        api.get("/kpi/groups"),
        api.get("/admin/users"),
        api.get("/kpi/configs/all"),
        api.get("/admin/roles"),
      ]);
      setTemplates(tplRes.data);
      setGroups(grpRes.data);
      setUsers(userRes.data);
      setConfigs(cfgRes.data);
      setRoles(roleRes.data || []);
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Ачааллахад алдаа гарлаа", false);
    }
  }
  useEffect(() => { loadAll(); }, []);

  // Динамик role label + order — custom role-уудыг (cashier, hudaldagch гэх мэт) автоматаар хамруулна
  // admin-ийг бүх дропдаунаас хасна
  const visibleRoles = useMemo(() => {
    const r = roles.filter(r => r.value !== "admin" && r.base_role !== "admin");
    return r.sort((a, b) => {
      const pa = BASE_PRIORITY[a.base_role] ?? 99;
      const pb = BASE_PRIORITY[b.base_role] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.label.localeCompare(b.label, "mn");
    });
  }, [roles]);
  const roleLabel = useMemo(() => {
    const m = new Map<string, string>();
    roles.forEach(r => m.set(r.value, r.label));
    return (v: string) => m.get(v) ?? FALLBACK_LABELS[v] ?? v;
  }, [roles]);
  // Хэрэглэгчдийг тушаалаар эрэмбэлэх индекс (matrix/employee view-ийн дотоод эрэмбэлэлтэд)
  const roleSortIndex = useMemo(() => {
    const m = new Map<string, number>();
    visibleRoles.forEach((r, i) => m.set(r.value, i));
    return m;
  }, [visibleRoles]);

  // ── Operations ────────────────────────────────────────────────────────
  async function toggleAssignment(empId: number, tplId: number) {
    const existing = configs.find(c => c.employee_id === empId && c.template_id === tplId);
    try {
      if (existing) {
        await api.delete(`/kpi/configs/${existing.id}`);
      } else {
        // Default approver: admin user
        const admin = users.find(u => u.role === "admin") || users[0];
        await api.post("/kpi/configs", {
          employee_id: empId, template_id: tplId, approver_id: admin?.id ?? empId,
        });
      }
      await reloadConfigs();
    } catch (e: any) {
      notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  }
  async function removeAssignment(cfgId: number) {
    try { await api.delete(`/kpi/configs/${cfgId}`); await reloadConfigs(); notify("Хуваарилалт устгагдлаа"); }
    catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }
  async function changeApprover(cfgId: number, approverId: number) {
    try { await api.put(`/kpi/configs/${cfgId}`, { approver_id: approverId }); await reloadConfigs(); }
    catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }
  async function bulkAssignRole(tplId: number, role: string) {
    const targets = users.filter(u => u.role === role);
    const admin = users.find(u => u.role === "admin") || users[0];
    const adminId = admin?.id ?? 1;
    const existing = new Set(configs.filter(c => c.template_id === tplId).map(c => c.employee_id));
    const toAdd = targets.filter(u => !existing.has(u.id));
    try {
      await Promise.all(toAdd.map(u =>
        api.post("/kpi/configs", { employee_id: u.id, template_id: tplId, approver_id: adminId })
          .catch(() => {})));
      await reloadConfigs();
      notify(`${toAdd.length} ажилтанд нэмэгдлээ`);
    } catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }
  async function bulkRemoveRole(tplId: number, role: string) {
    const targets = new Set(users.filter(u => u.role === role).map(u => u.id));
    const toRemove = configs.filter(c => c.template_id === tplId && targets.has(c.employee_id));
    try {
      await Promise.all(toRemove.map(c => api.delete(`/kpi/configs/${c.id}`).catch(() => {})));
      await reloadConfigs();
      notify(`${toRemove.length} ажилтнаас хасагдлаа`);
    } catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }
  async function reloadConfigs() {
    const res = await api.get("/kpi/configs/all");
    setConfigs(res.data);
  }
  async function saveTemplate(payload: any) {
    try {
      if (payload.id) {
        await api.put(`/kpi/templates/${payload.id}`, payload);
      } else {
        await api.post("/kpi/templates", payload);
      }
      const tplRes = await api.get("/kpi/templates");
      setTemplates(tplRes.data);
      setTplModal(false);
      notify(payload.id ? "Засварлагдлаа" : "Үүсгэгдлээ");
    } catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }
  async function deleteTemplate(t: Template) {
    try {
      await api.delete(`/kpi/templates/${t.id}`);
      const [tplRes, cfgRes] = await Promise.all([api.get("/kpi/templates"), api.get("/kpi/configs/all")]);
      setTemplates(tplRes.data);
      setConfigs(cfgRes.data);
      setConfirmDel(null);
      notify("Загвар устгагдлаа");
    } catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }
  async function createGroup(name: string) {
    try {
      await api.post("/kpi/groups", { name, sort_order: groups.length });
      const r = await api.get("/kpi/groups"); setGroups(r.data);
      notify("Бүлэг нэмэгдлээ");
    } catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }
  async function renameGroup(g: TaskGroup, name: string) {
    try {
      await api.put(`/kpi/groups/${g.id}`, { name, sort_order: g.sort_order, is_active: g.is_active });
      const r = await api.get("/kpi/groups"); setGroups(r.data);
      notify("Засагдлаа");
    } catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }
  async function deleteGroup(g: TaskGroup) {
    try {
      await api.delete(`/kpi/groups/${g.id}`);
      const r = await api.get("/kpi/groups"); setGroups(r.data);
      notify("Бүлэг устгагдлаа");
    } catch (e: any) { notify(e?.response?.data?.detail ?? "Алдаа гарлаа", false); }
  }

  return (
    <div className="space-y-4">
      <Toast toast={toast}/>
      <StatsRow templates={templates} groups={groups} users={users} configs={configs}
        onManageGroups={() => setGrpModal(true)}/>

      <div className="grid gap-4" style={{ gridTemplateColumns: "420px 1fr" }}>
        <TemplatePanel
          templates={templates} groups={groups} configs={configs}
          search={tplSearch} setSearch={setTplSearch}
          fGroup={fGroup} setFGroup={setFGroup}
          fCat={fCat} setFCat={setFCat}
          fPeriod={fPeriod} setFPeriod={setFPeriod}
          fActive={fActive} setFActive={setFActive}
          highlightedTpl={highlightedTpl} setHighlightedTpl={setHighlightedTpl}
          onCreate={() => { setEditTpl(null); setTplModal(true); }}
          onEdit={(t) => { setEditTpl(t); setTplModal(true); }}
          onDelete={(t) => setConfirmDel(t)}
        />
        <AssignmentPanel
          templates={templates} groups={groups} configs={configs} users={users}
          visibleRoles={visibleRoles} roleLabel={roleLabel} roleSortIndex={roleSortIndex}
          view={view} setView={setView}
          roleFilter={roleFilter} setRoleFilter={setRoleFilter}
          groupFilter={groupFilter} setGroupFilter={setGroupFilter}
          search={aSearch} setSearch={setASearch}
          highlightedTpl={highlightedTpl} setHighlightedTpl={setHighlightedTpl}
          highlightedEmp={highlightedEmp} setHighlightedEmp={setHighlightedEmp}
          onToggle={toggleAssignment}
          onRemove={removeAssignment}
          onBulkAssignRole={bulkAssignRole}
          onBulkRemoveRole={bulkRemoveRole}
          onChangeApprover={changeApprover}
        />
      </div>

      <TemplateEditor open={tplModal} editTpl={editTpl} groups={groups}
        onClose={() => setTplModal(false)} onSave={saveTemplate}/>

      <GroupManager open={grpModal} groups={groups}
        onClose={() => setGrpModal(false)}
        onCreate={createGroup} onRename={renameGroup} onDelete={deleteGroup}
        notify={notify}/>

      {confirmDel && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setConfirmDel(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50">
                <Trash2 size={18} className="text-red-500"/>
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900">Загвар устгах уу?</h2>
                <p className="text-xs text-gray-500 mt-0.5">"{confirmDel.name}" — {configs.filter(c => c.template_id === confirmDel.id).length} хуваарилалт мөн устана</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setConfirmDel(null)} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Болих</button>
              <button onClick={() => deleteTemplate(confirmDel)} className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600">Устгах</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
