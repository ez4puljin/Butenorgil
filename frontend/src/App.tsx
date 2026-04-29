import { Navigate, Route, Routes } from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import Shell from "./components/layout/Shell";

import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Imports from "./pages/Imports";
import Reports from "./pages/Reports";
import Admin from "./pages/Admin";
import AdminMinStock from "./pages/AdminMinStock";
import ManagerOrders from "./pages/ManagerOrders";
import OrderSupervisor from "./pages/OrderSupervisor";
import AccountsReceivable from "./pages/AccountsReceivable";
import Suppliers from "./pages/Suppliers";
import Logistics from "./pages/Logistics";
import PurchaseOrderList from "./pages/PurchaseOrderList";
import PurchaseOrderDetail from "./pages/PurchaseOrderDetail";
import CalendarPage from "./pages/Calendar";
import KpiChecklist from "./pages/KpiChecklist";
import KpiApprovals from "./pages/KpiApprovals";
import KpiAdmin from "./pages/KpiAdmin";
import NewProduct from "./pages/NewProduct";
import SalesReportDetail from "./pages/SalesReportDetail";
import InventoryCount from "./pages/InventoryCount";
import OrderDashboard from "./pages/OrderDashboard";
import ErkhetAuto from "./pages/ErkhetAuto";
import ReceivingList from "./pages/ReceivingList";
import ReceivingDetail from "./pages/ReceivingDetail";
import BankStatement from "./pages/BankStatement";
import ServerConfig from "./pages/ServerConfig";
import { useEffect, useState } from "react";
import { isNativeApp, bootstrapServerUrlIntoLocalStorage, getServerUrlSync } from "./lib/serverConfig";
import { setApiBaseUrl } from "./lib/api";

// Permissions → route mapping (Shell-ийн navItems-тай дараалал таарна)
export const PAGE_ROUTES: { key: string; path: string }[] = [
  { key: "dashboard",           path: "/dashboard" },
  { key: "imports",             path: "/imports" },
  { key: "reports",             path: "/reports" },
  { key: "accounts_receivable", path: "/accounts-receivable" },
  { key: "order",               path: "/order" },
  { key: "suppliers",           path: "/suppliers" },
  { key: "logistics",           path: "/logistics" },
  { key: "calendar",            path: "/calendar" },
  { key: "admin_panel",         path: "/admin" },
  { key: "kpi_checklist",       path: "/kpi/checklist" },
  { key: "kpi_approvals",       path: "/kpi/approvals" },
  { key: "kpi_admin",           path: "/kpi/admin" },
  { key: "new_product",         path: "/new-product" },
  { key: "sales_report",        path: "/sales-report-detail" },
  { key: "inventory_count",     path: "/inventory-count" },
  { key: "erkhet_auto",         path: "/erkhet-auto" },
  { key: "bank_statements",     path: "/bank-statements" },
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

// Permissions-д тулгуурласан smart redirect
function DefaultRedirect() {
  const permissions = useAuthStore((s) => s.permissions);
  return <Navigate to={firstPermittedPath(permissions)} replace />;
}

export default function App() {
  const { role, baseRole, permissions } = useAuthStore();
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

  // Page access: permissions array (from role DB) эсвэл baseRole fallback (хуучин session)
  const can = (pageKey: string) => {
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
              <Routes>
                <Route
                  path="/dashboard"
                  element={can("dashboard") ? <Dashboard /> : <DefaultRedirect />}
                />
                <Route path="/imports" element={<Imports />} />
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
                <Route path="/receivings" element={<ReceivingList />} />
                <Route path="/receivings/:id" element={<ReceivingDetail />} />
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
                  element={can("admin_panel") ? <AdminMinStock /> : <DefaultRedirect />}
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
                <Route path="*" element={<DefaultRedirect />} />
              </Routes>
            </Shell>
          </Protected>
        }
      />
    </Routes>
  );
}
