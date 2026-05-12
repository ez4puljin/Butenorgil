import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  LayoutGrid, Upload, ClipboardList, Shield, LogOut,
  FileText, Building2, Truck, X, CalendarDays, CheckSquare,
  BadgeCheck, Settings2, Sparkles, BarChart3, MoreHorizontal,
  ChevronRight, User, Menu, ClipboardCheck, Bot, PackageCheck, Landmark, History,
} from "lucide-react";
import { useAuthStore } from "../../store/authStore";

type NavItem = {
  to: string;
  label: string;
  icon: React.ElementType;
  pageKey: string;
};

const navItems: NavItem[] = [
  { to: "/order",               label: "Захиалга",            icon: ClipboardList, pageKey: "order" },
  { to: "/receivings",          label: "Бараа тулгаж авах",  icon: PackageCheck,  pageKey: "receivings" },
  { to: "/kpi/checklist",       label: "Өдрийн даалгавар",   icon: CheckSquare,   pageKey: "kpi_checklist" },
  { to: "/dashboard",           label: "Хянах самбар",        icon: LayoutGrid,    pageKey: "dashboard" },
  { to: "/kpi/approvals",       label: "KPI зөвшөөрөл",      icon: BadgeCheck,    pageKey: "kpi_approvals" },
  { to: "/reports",             label: "Тайлан",              icon: BarChart3,     pageKey: "reports" },
  { to: "/imports",             label: "Файл оруулалт",       icon: Upload,        pageKey: "imports" },
  { to: "/accounts-receivable", label: "Авлага",              icon: FileText,      pageKey: "accounts_receivable" },
  { to: "/suppliers",           label: "Нийлүүлэгч",         icon: Building2,     pageKey: "suppliers" },
  { to: "/logistics",           label: "Логистик",            icon: Truck,         pageKey: "logistics" },
  { to: "/calendar",            label: "Календар",            icon: CalendarDays,  pageKey: "calendar" },
  { to: "/admin",               label: "Удирдлага",           icon: Shield,        pageKey: "admin_panel" },
  { to: "/admin/min-stock",     label: "Доод үлдэгдэл",      icon: ClipboardCheck, pageKey: "min_stock" },
  { to: "/admin/audit-log",     label: "Үйлдлийн бүртгэл",  icon: History,        pageKey: "audit_log" },
  { to: "/kpi/admin",           label: "KPI тохиргоо",        icon: Settings2,     pageKey: "kpi_admin" },
  { to: "/new-product",         label: "Шинэ бараа",          icon: Sparkles,      pageKey: "new_product" },
  { to: "/sales-report-detail", label: "Борлуулалтын тайлан", icon: BarChart3,     pageKey: "sales_report" },
  { to: "/inventory-count",     label: "Тооллогоны тайлан",  icon: ClipboardCheck, pageKey: "inventory_count" },
  { to: "/erkhet-auto",         label: "Erkhet автомат",     icon: Bot,            pageKey: "erkhet_auto" },
  { to: "/bank-statements",    label: "Тооцоо хаах",        icon: Landmark,       pageKey: "bank_statements" },
];

const BOTTOM_NAV_MAX = 4;

export default function Shell(props: { children: React.ReactNode }) {
  const loc = useLocation();
  const { role, baseRole, permissions, logout, username, nickname } = useAuthStore();
  const displayName = nickname || username;
  const effectiveRole = baseRole || role;

  // Desktop sidebar toggle — localStorage-т хадгалдаг
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState<boolean>(() => {
    return localStorage.getItem("sidebar_open") !== "0";
  });

  // Tablet drawer
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Tablet bottom nav auto-hide on scroll
  const [bottomNavVisible, setBottomNavVisible] = useState(true);
  const lastScrollY = useRef(0);
  const scrollTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onScroll = () => {
      const curr = window.scrollY;
      const diff = curr - lastScrollY.current;
      if (diff > 8) {
        setBottomNavVisible(false);   // доош scroll → нуух
      } else if (diff < -8) {
        setBottomNavVisible(true);    // дээш scroll → харуулах
      }
      lastScrollY.current = curr;

      // 3 секундын дараа автоматаар харуулах
      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
      scrollTimeout.current = setTimeout(() => setBottomNavVisible(true), 3000);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
    };
  }, []);

  function toggleDesktopSidebar() {
    setDesktopSidebarOpen(v => {
      const next = !v;
      localStorage.setItem("sidebar_open", next ? "1" : "0");
      return next;
    });
  }

  const roleLabel =
    effectiveRole === "admin"           ? "Админ" :
    effectiveRole === "supervisor"      ? "Хянагч" :
    effectiveRole === "manager"         ? "Менежер" :
    effectiveRole === "warehouse_clerk" ? "Агуулахын нярав" :
    effectiveRole === "accountant"      ? "Нягтлан" : (role ?? "-");

  const visible = navItems.filter(n => permissions.includes(n.pageKey));
  const bottomItems = visible.slice(0, BOTTOM_NAV_MAX);

  // Илүү өндөр specificity бүхий nav path байгаа бол (жишээ /admin/min-stock vs /admin)
  // богино path-ыг active гэж үзэхгүй.
  const isNavActive = (to: string) => {
    const path = loc.pathname;
    if (path === to) return true;
    if (!path.startsWith(to + "/")) return false;
    // Илүү гүн (deeper) тохирох өөр nav байвал энэ нь active биш
    const deeper = visible.some(x => x.to !== to && x.to.startsWith(to + "/") && (path === x.to || path.startsWith(x.to + "/")));
    return !deeper;
  };

  // Current page title for mobile top bar
  const currentNav = visible.find(n => isNavActive(n.to));
  const pageTitle = currentNav?.label ?? "Bto";

  // User initials for avatar
  const initials = (displayName || "U").trim().slice(0, 2).toUpperCase();

  // ── Slide-over Drawer (tablet / mobile) ────────────────────────────
  const Drawer = (
    <AnimatePresence>
      {drawerOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 bg-black/50 lg:hidden"
            onClick={() => setDrawerOpen(false)}
          />
          <motion.div
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="fixed inset-y-0 left-0 z-50 flex w-[86%] max-w-[320px] flex-col bg-white shadow-2xl lg:hidden"
            style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 shrink-0">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-gray-400">Дотоод нөөцийн систем</p>
                <p className="text-sm font-bold text-gray-900 truncate">Нэгтгэл ба захиалга</p>
              </div>
              <button onClick={() => setDrawerOpen(false)}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-gray-400 hover:bg-gray-100 active:bg-gray-200">
                <X size={20} />
              </button>
            </div>

            {/* User card */}
            <div className="mx-4 mt-3 rounded-2xl bg-gradient-to-br from-[#0071E3] to-[#004aad] px-4 py-3.5 shrink-0 shadow-sm shadow-blue-500/20">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-sm ring-1 ring-white/25">
                  <span className="text-sm font-bold text-white">{initials}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white truncate">{displayName}</p>
                  <p className="text-[11px] text-blue-100">{roleLabel}</p>
                </div>
              </div>
            </div>

            {/* Nav items */}
            <nav className="flex-1 overflow-y-auto overscroll-contain px-3 py-3 space-y-0.5">
              {visible.map(n => {
                const active = isNavActive(n.to);
                const Icon = n.icon;
                return (
                  <Link key={n.to} to={n.to} onClick={() => setDrawerOpen(false)}
                    className={`flex min-h-[48px] items-center justify-between rounded-xl px-4 text-sm font-medium transition-colors active:scale-[0.99] ${
                      active
                        ? "bg-[#0071E3] text-white shadow-sm shadow-blue-500/25"
                        : "text-gray-700 hover:bg-gray-100 active:bg-gray-200"
                    }`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon size={18} className="shrink-0"/>
                      <span className="truncate">{n.label}</span>
                    </div>
                    {active && <ChevronRight size={15} className="opacity-70 shrink-0" />}
                  </Link>
                );
              })}
            </nav>

            {/* Logout */}
            <div className="border-t border-gray-100 p-4 shrink-0">
              <button onClick={logout}
                className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50 active:bg-gray-100">
                <LogOut size={16} />
                Системээс гарах
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  return (
    <div className="min-h-screen bg-[#F5F5F7]">

      {/* ══ DESKTOP (lg+) ═══════════════════════════════════════════════ */}
      <div className="hidden lg:flex min-h-screen">

        {/* Sidebar — нуух/харуулах toggle-тай */}
        <div className={`relative shrink-0 transition-all duration-300 ${desktopSidebarOpen ? "w-64" : "w-0"}`}>
          <aside className={`sticky top-0 h-screen overflow-hidden transition-all duration-300 ${
            desktopSidebarOpen ? "w-64 opacity-100" : "w-0 opacity-0 pointer-events-none"
          }`}>
            <div className="h-full overflow-y-auto p-4">
              <div className="rounded-2xl bg-white p-4 shadow-sm min-h-full">
                {/* Sidebar header + close */}
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-xs text-gray-400">Дотоод нөөцийн систем</p>
                    <p className="text-base font-bold text-gray-900">Нэгтгэл ба захиалга</p>
                  </div>
                  <button onClick={toggleDesktopSidebar}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                    title="Цэс нуух">
                    <X size={16} />
                  </button>
                </div>

                {/* User */}
                <div className="rounded-xl bg-[#F5F5F7] px-3 py-2.5 mb-4">
                  <p className="text-xs text-gray-500">Хэрэглэгч</p>
                  <p className="text-sm font-semibold text-gray-900">{displayName}</p>
                  {nickname && nickname !== username && (
                    <p className="text-xs text-gray-400">@{username}</p>
                  )}
                  <p className="text-xs text-gray-500">{roleLabel}</p>
                </div>

                {/* Nav */}
                <nav className="space-y-0.5">
                  {visible.map(n => {
                    const active = isNavActive(n.to);
                    const Icon = n.icon;
                    return (
                      <Link key={n.to} to={n.to}
                        className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-all ${
                          active ? "bg-[#0071E3] text-white" : "text-gray-700 hover:bg-gray-100"
                        }`}>
                        <Icon size={16} />
                        {n.label}
                      </Link>
                    );
                  })}
                </nav>

                <button onClick={logout}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <LogOut size={16} />
                  Гарах
                </button>
              </div>
            </div>
          </aside>
        </div>

        {/* Desktop content */}
        <main className="min-w-0 flex-1 p-6 pb-8 relative">
          {/* Sidebar нуугдсан үед харуулах товч */}
          {!desktopSidebarOpen && (
            <button onClick={toggleDesktopSidebar}
              className="fixed top-4 left-4 z-50 flex h-10 w-10 items-center justify-center rounded-xl bg-white shadow-md border border-gray-100 text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition-all"
              title="Цэс харуулах">
              <Menu size={18} />
            </button>
          )}
          <div className={`transition-all duration-300 ${!desktopSidebarOpen ? "pl-12" : ""}`}>
            {props.children}
          </div>
        </main>
      </div>

      {/* ══ TABLET / MOBILE (below lg) ══════════════════════════════════ */}
      <div className="flex flex-col lg:hidden min-h-screen">
        {/* Top bar — compact page title + menu + avatar */}
        <header
          className="sticky top-0 z-30 flex items-center gap-2 border-b border-gray-100 bg-white/90 px-3 backdrop-blur-md"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))", paddingBottom: "0.5rem" }}
        >
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Цэс нээх"
            className="grid h-10 w-10 place-items-center rounded-xl text-gray-600 hover:bg-gray-100 active:bg-gray-200"
          >
            <Menu size={20}/>
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400 leading-tight">Bto</p>
            <h1 className="truncate text-sm font-semibold text-gray-900 leading-tight">{pageTitle}</h1>
          </div>
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Профайл"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#0071E3] to-[#004aad] text-[11px] font-bold text-white shadow-sm active:scale-95 transition-transform"
            title={displayName}
          >
            {initials}
          </button>
        </header>

        <main className="flex-1 overflow-x-hidden p-3 pb-[calc(76px+env(safe-area-inset-bottom))]">
          {props.children}
        </main>

        {/* ── Bottom Navigation — scroll хийхэд автоматаар нуугддаг ── */}
        <nav className={`fixed bottom-0 inset-x-0 z-40 flex items-stretch
          bg-white/95 border-t border-gray-100 shadow-[0_-4px_20px_rgba(0,0,0,0.06)] backdrop-blur-md
          transition-transform duration-300 ease-out
          ${bottomNavVisible ? "translate-y-0" : "translate-y-full"}`}
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>

          {bottomItems.map(n => {
            const active = isNavActive(n.to);
            const Icon = n.icon;
            return (
              <Link key={n.to} to={n.to}
                className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 min-h-[56px] py-1.5
                  transition-colors active:bg-gray-50 select-none
                  ${active ? "text-[#0071E3]" : "text-gray-400"}`}>
                {active && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full bg-[#0071E3]" />
                )}
                <Icon size={21} strokeWidth={active ? 2.4 : 1.8} />
                <span className="text-[10px] font-semibold leading-none tracking-tight">
                  {n.label.length > 6 ? n.label.slice(0, 6) + "…" : n.label}
                </span>
              </Link>
            );
          })}

          {/* Цэс товч */}
          <button onClick={() => setDrawerOpen(true)}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 min-h-[56px] py-1.5 text-gray-400 active:bg-gray-50 select-none">
            <MoreHorizontal size={21} strokeWidth={1.8} />
            <span className="text-[10px] font-semibold leading-none">Цэс</span>
          </button>
        </nav>

        {/* Bottom nav нуугдсан үед гарч ирэх жижиг товч */}
        {!bottomNavVisible && (
          <button
            onClick={() => setBottomNavVisible(true)}
            className="fixed bottom-4 right-4 z-50 grid h-12 w-12 place-items-center
              rounded-full bg-[#0071E3]/95 shadow-lg backdrop-blur-sm
              active:scale-95 transition-all"
            style={{ marginBottom: "env(safe-area-inset-bottom)" }}>
            <Menu size={20} className="text-white" />
          </button>
        )}
      </div>

      {/* Drawer */}
      {Drawer}
    </div>
  );
}
