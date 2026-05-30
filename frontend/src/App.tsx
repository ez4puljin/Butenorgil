import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import Shell from "./components/layout/Shell";

// Эхний дэлгэцүүд (critical path) — eager. Бусад хуудсыг lazy-аар хувааж,
// анхны ачаалал хөнгөн, утсан дээр хурдан, RAM бага зарцуулна.
import Login from "./pages/Login";
import ServerConfig from "./pages/ServerConfig";

// ── Lazy pages (route бүр өөрийн chunk-той) + prefetch бүртгэл ──
// page() нь lazy component буцаахын зэрэгцээ тухайн import thunk-ийг
// _prefetchThunks-д бүртгэнэ. Апп нээгдсэний дараа бүх chunk-ийг background-д
// урьдчилан ачаалснаар цэс шилжихэд "Loading" гарахгүй, агшин зуурын болно.
const _prefetchThunks: Array<() => Promise<unknown>> = [];
function page<T>(thunk: () => Promise<T>) {
  _prefetchThunks.push(thunk);
  return lazy(thunk as any);
}

const Dashboard          = page(() => import("./pages/Dashboard"));
const Imports            = page(() => import("./pages/Imports"));
const Reports            = page(() => import("./pages/Reports"));
const Admin              = page(() => import("./pages/Admin"));
const AdminMinStock      = page(() => import("./pages/AdminMinStock"));
const AuditLogPage       = page(() => import("./pages/AuditLog"));
const OrderSupervisor    = page(() => import("./pages/OrderSupervisor"));
const AccountsReceivable = page(() => import("./pages/AccountsReceivable"));
const Suppliers          = page(() => import("./pages/Suppliers"));
const Logistics          = page(() => import("./pages/Logistics"));
const PurchaseOrderList   = page(() => import("./pages/PurchaseOrderList"));
const PurchaseOrderDetail = page(() => import("./pages/PurchaseOrderDetail"));
const CalendarPage       = page(() => import("./pages/Calendar"));
const KpiChecklist       = page(() => import("./pages/KpiChecklist"));
const KpiApprovals       = page(() => import("./pages/KpiApprovals"));
const KpiAdmin           = page(() => import("./pages/KpiAdmin"));
const NewProduct         = page(() => import("./pages/NewProduct"));
const SalesReportDetail  = page(() => import("./pages/SalesReportDetail"));
const InventoryCount     = page(() => import("./pages/InventoryCount"));
const OrderDashboard     = page(() => import("./pages/OrderDashboard"));
const ErkhetAuto         = page(() => import("./pages/ErkhetAuto"));
const ReceivingList      = page(() => import("./pages/ReceivingList"));
const ReceivingDetail    = page(() => import("./pages/ReceivingDetail"));
const BankStatement      = page(() => import("./pages/BankStatement"));
const ExpirationTracking = page(() => import("./pages/ExpirationTracking"));
const Documents          = page(() => import("./pages/Documents"));
const ProductSalesImport = page(() => import("./pages/ProductSalesImport"));
const Attendance         = page(() => import("./pages/Attendance"));
const AttendanceAdmin    = page(() => import("./pages/AttendanceAdmin"));

// Бүх хуудсыг сул зуур (idle) background-д урьдчилан ачаална.
// Нэг нэгээр нь ачаалж эхний хуудасны ачаалалтай өрсөлдөхгүй.
function prefetchAllPages() {
  let i = 0;
  const idle: (cb: () => void) => void =
    (window as any).requestIdleCallback
      ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 1000 })
      : (cb) => setTimeout(cb, 150);
  const warm = () => {
    if (i >= _prefetchThunks.length) return;
    const thunk = _prefetchThunks[i++];
    thunk().catch(() => {}).finally(() => idle(warm));
  };
  idle(warm);
}
import { isNativeApp, bootstrapServerUrlIntoLocalStorage, getServerUrlSync } from "./lib/serverConfig";
import { api, setApiBaseUrl } from "./lib/api";
import { registerBackButtonHandler } from "./lib/backButton";

// Permissions → route mapping (Shell-ийн navItems-тай дараалал таарна)
export const PAGE_ROUTES: { key: string; path: string }[] = [
  { key: "dashboard",           path: "/dashboard" },
  { key: "imports",             path: "/imports" },
  { key: "reports",             path: "/reports" },
  { key: "accounts_receivable", path: "/accounts-receivable" },
  { key: "order",               path: "/order" },
  { key: "receivings",          path: "/receivings" },
  { key: "suppliers",           path: "/suppliers" },
  { key: "logistics",           path: "/logistics" },
  { key: "calendar",            path: "/calendar" },
  { key: "admin_panel",         path: "/admin" },
  { key: "min_stock",           path: "/admin/min-stock" },
  { key: "audit_log",           path: "/admin/audit-log" },
  { key: "kpi_checklist",       path: "/kpi/checklist" },
  { key: "kpi_approvals",       path: "/kpi/approvals" },
  { key: "kpi_admin",           path: "/kpi/admin" },
  { key: "new_product",         path: "/new-product" },
  { key: "sales_report",        path: "/sales-report-detail" },
  { key: "inventory_count",     path: "/inventory-count" },
  { key: "erkhet_auto",         path: "/erkhet-auto" },
  { key: "bank_statements",     path: "/bank-statements" },
  { key: "expiration_tracking", path: "/expiration" },
  { key: "documents",           path: "/documents" },
  { key: "attendance",          path: "/attendance" },
  { key: "attendance_admin",    path: "/attendance/admin" },
];

// Permissions-аас эхний зөвшөөрөгдсөн хуудасны замыг олно
export function firstPermittedPath(permissions: string[]): string {
  if (permissions.length === 0) return "/dashboard"; // хуучин session fallback
  return PAGE_ROUTES.find((p) => permissions.includes(p.key))?.path ?? "/dashboard";
}

function Protected(props: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{props.children}</>;
}

// Lazy хуудас татагдах хооронд харагдах хөнгөн spinner (Suspense fallback)
function PageLoader() {
  return (
    <div className="flex items-center justify-center py-24 text-gray-400">
      <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-gray-200 border-t-[#0071E3]" />
    </div>
  );
}

// Permissions-д тулгуурласан smart redirect
function DefaultRedirect() {
  const permissions = useAuthStore((s) => s.permissions);
  return <Navigate to={firstPermittedPath(permissions)} replace />;
}

export default function App() {
  const { role, baseRole, permissions, universalPages, token, setAuth } = useAuthStore();
  const br = baseRole ?? role ?? "";

  // Native app (APK) — localStorage-г sync уншина. Background-т Preferences-ээс survive-ийг шалгана.
  const native = (() => { try { return isNativeApp(); } catch { return false; } })();
  const [hasServer, setHasServer] = useState<boolean>(!!getServerUrlSync());

  useEffect(() => {
    // Axios baseURL synchronously suulgah (if have saved URL)
    const saved = getServerUrlSync();
    if (saved) {
      try { setApiBaseUrl(saved); } catch {}
    }
    if (!native) return;
    // Android back товчны history-aware handler бүртгэх
    registerBackButtonHandler();
    // Preferences (reinstall survival) background check — non-blocking
    (async () => {
      try {
        const url = await bootstrapServerUrlIntoLocalStorage();
        if (url && !saved) {
          try { setApiBaseUrl(url); } catch {}
          setHasServer(true);
        }
      } catch (e) {
        console.error("bootstrap error", e);
      }
    })();
  }, [native]);

  // Permissions-ыг DB-аас шинэчлэх — login шаардлагагүйгээр шинэ эрхүүд нэн даруй харагдана
  useEffect(() => {
    if (!token) return;
    api.get("/auth/me").then(r => {
      const d = r.data;
      setAuth({
        token: d.access_token,
        username: d.username,
        nickname: d.nickname,
        role: d.role,
        base_role: d.base_role,
        permissions: d.permissions ?? [],
        universalPages: d.universal_pages ?? ["expiration_tracking", "attendance"],
        tagIds: d.tag_ids ?? [],
        userId: d.user_id,
      });
    }).catch(() => { /* token хүчингүй болсон → logout дуудаад Login хуудас харуулна */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Нэвтэрсэн үед бүх хуудсыг background-д урьдчилан ачаална → цэс шилжихэд
  // "Loading" гарахгүй, агшин зуурын болно (chunk аль хэдийн RAM-д байна).
  useEffect(() => {
    if (!token) return;
    const t = setTimeout(prefetchAllPages, 500);
    return () => clearTimeout(t);
  }, [token]);

  // Page access: permissions array (from role DB) эсвэл baseRole fallback (хуучин session)
  const can = (pageKey: string) => {
    // Universal цэс — role/permission-аас үл хамааран бүх хэрэглэгчид нээлттэй
    if (universalPages.includes(pageKey)) return true;
    if (permissions.length > 0) return permissions.includes(pageKey);
    // Permissions байхгүй (хуучин session) → baseRole-оор fallback
    const fallback: Record<string, string[]> = {
      dashboard:    ["admin", "supervisor", "manager", "accountant"],
      admin_panel:  ["admin"],
      kpi_admin:    ["admin"],
      suppliers:    ["admin", "supervisor"],
      logistics:    ["admin", "supervisor", "manager"],
      new_product:  ["admin", "supervisor", "manager"],
      sales_report:    ["admin", "supervisor", "manager", "accountant"],
      inventory_count: ["admin", "supervisor", "manager"],
      erkhet_auto:     ["admin", "supervisor"],
      kpi_checklist:["admin", "supervisor", "manager", "warehouse_clerk", "accountant"],
      kpi_approvals:["admin", "supervisor", "manager", "warehouse_clerk", "accountant"],
    };
    return fallback[pageKey]?.includes(br) ?? true;
  };

  // Native app дотор server URL байхгүй бол → ServerConfig
  if (native && !hasServer) {
    return (
      <Routes>
        <Route path="*" element={<ServerConfig />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/server-config" element={<ServerConfig />} />
      <Route path="/login" element={<Login />} />

      <Route
        path="/*"
        element={
          <Protected>
            <Shell>
              <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route
                  path="/dashboard"
                  element={can("dashboard") ? <Dashboard /> : <DefaultRedirect />}
                />
                <Route path="/imports" element={<Imports />} />
                <Route path="/imports/product-monthly-sales" element={<ProductSalesImport />} />
                <Route path="/reports" element={<Reports />} />
                <Route
                  path="/order"
                  element={
                    (baseRole ?? role) === "supervisor"
                      ? <OrderSupervisor />
                      : <PurchaseOrderList />
                  }
                />
                <Route path="/order/:id/dashboard" element={<OrderDashboard />} />
                <Route path="/order/:id" element={<PurchaseOrderDetail />} />
                <Route
                  path="/receivings"
                  element={can("receivings") ? <ReceivingList /> : <DefaultRedirect />}
                />
                <Route
                  path="/receivings/:id"
                  element={can("receivings") ? <ReceivingDetail /> : <DefaultRedirect />}
                />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/accounts-receivable" element={<AccountsReceivable />} />
                <Route
                  path="/suppliers"
                  element={can("suppliers") ? <Suppliers /> : <DefaultRedirect />}
                />
                <Route
                  path="/logistics"
                  element={can("logistics") ? <Logistics /> : <DefaultRedirect />}
                />
                <Route
                  path="/admin"
                  element={can("admin_panel") ? <Admin /> : <DefaultRedirect />}
                />
                <Route
                  path="/admin/min-stock"
                  element={can("min_stock") ? <AdminMinStock /> : <DefaultRedirect />}
                />
                <Route
                  path="/admin/audit-log"
                  element={can("audit_log") ? <AuditLogPage /> : <DefaultRedirect />}
                />
                <Route
                  path="/kpi/checklist"
                  element={can("kpi_checklist") ? <KpiChecklist /> : <DefaultRedirect />}
                />
                <Route path="/kpi/approvals" element={<KpiApprovals />} />
                <Route
                  path="/kpi/admin"
                  element={can("kpi_admin") ? <KpiAdmin /> : <DefaultRedirect />}
                />
                <Route
                  path="/new-product"
                  element={can("new_product") ? <NewProduct /> : <DefaultRedirect />}
                />
                <Route
                  path="/sales-report-detail"
                  element={can("sales_report") ? <SalesReportDetail /> : <DefaultRedirect />}
                />
                <Route
                  path="/inventory-count"
                  element={can("inventory_count") ? <InventoryCount /> : <DefaultRedirect />}
                />
                <Route
                  path="/erkhet-auto"
                  element={can("erkhet_auto") ? <ErkhetAuto /> : <DefaultRedirect />}
                />
                <Route
                  path="/bank-statements"
                  element={can("bank_statements") ? <BankStatement /> : <DefaultRedirect />}
                />
                <Route
                  path="/expiration"
                  element={<ExpirationTracking />}
                />
                <Route
                  path="/attendance"
                  element={<Attendance />}
                />
                <Route
                  path="/attendance/admin"
                  element={can("attendance_admin") ? <AttendanceAdmin /> : <DefaultRedirect />}
                />
                <Route
                  path="/documents"
                  element={can("documents") ? <Documents /> : <DefaultRedirect />}
                />
                <Route path="*" element={<DefaultRedirect />} />
              </Routes>
              </Suspense>
            </Shell>
          </Protected>
        }
      />
    </Routes>
  );
}
