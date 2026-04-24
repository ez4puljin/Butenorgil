import { create } from "zustand";

export type POSummary = {
  id: number;
  order_date: string;
  status: string;
  status_label: string;
  created_by_username: string;
  line_count: number;
  total_boxes: number;
  total_weight: number;
  created_at: string;
  vehicle_id: number | null;
  vehicle_name: string | null;
  is_archived?: boolean;
  notes?: string;
};

export type POLine = {
  line_id: number;
  product_id: number;
  item_code: string;
  name: string;
  brand: string;
  warehouse_tag_id: number;
  warehouse_name: string;
  unit_weight: number;
  pack_ratio: number;
  stock_qty: number;
  sales_qty: number;
  price_tag?: string;
  needs_reorder?: boolean;
  min_stock_box?: number;
  order_qty_box: number;
  order_qty_pcs: number;
  computed_weight: number;
  supplier_qty_box: number;
  loaded_qty_box: number;
  received_qty_box: number;
  received_qty_extra_pcs?: number;
  difference: number;
  unit_price: number;
  last_purchase_price: number;
  remark: string;
};

export type POExtraLine = {
  id: number;
  brand: string;
  name: string;
  item_code: string;
  warehouse_name: string;
  unit_weight: number;
  pack_ratio: number;
  qty_box: number;
  computed_weight: number;
};

export type BrandVehicle = {
  brand: string;
  vehicle_id: number | null;
  vehicle_name: string | null;
};

export type PODetail = POSummary & {
  notes: string;
  lines: POLine[];
  extra_lines: POExtraLine[];
  next_status: string | null;
  next_status_label: string;
  brand_vehicles: BrandVehicle[];
};

type State = {
  orders: POSummary[];
  currentOrder: PODetail | null;
  quantities: Record<number, number>; // product_id → qty_box (edit buffer)
  masterExists: boolean | null;
  masterUpdatedAt: string | null;

  setOrders: (orders: POSummary[]) => void;
  setCurrentOrder: (order: PODetail | null) => void;
  setQuantity: (productId: number, qty: number) => void;
  initQuantities: (lines: POLine[]) => void;
  setMasterStatus: (exists: boolean, updatedAt: string | null) => void;
};

export const usePurchaseOrderStore = create<State>((set) => ({
  orders: [],
  currentOrder: null,
  quantities: {},
  masterExists: null,
  masterUpdatedAt: null,

  setOrders: (orders) => set({ orders }),
  setCurrentOrder: (order) => set({ currentOrder: order }),
  setQuantity: (productId, qty) =>
    set((s) => ({ quantities: { ...s.quantities, [productId]: qty } })),
  initQuantities: (lines) => {
    const qtys: Record<number, number> = {};
    for (const l of lines) qtys[l.product_id] = l.order_qty_box;
    set({ quantities: qtys });
  },
  setMasterStatus: (masterExists, masterUpdatedAt) =>
    set({ masterExists, masterUpdatedAt }),
}));

export const STATUS_SEQUENCE = [
  "preparing",
  "reviewing",
  "sending",
  "loading",
  "transit",
  "arrived",
  "accounting",
  "confirmed",
  "received",
] as const;

export const STATUS_LABEL: Record<string, string> = {
  preparing: "Захиалга бэлдэж байна",
  reviewing: "Хянаж байна",
  sending: "Захиалга илгээж байна",
  loading: "Ачигдаж байна",
  transit: "Замд явж байна",
  arrived: "Ачаа ирсэн",
  accounting: "Нягтлан шалгаж байна",
  confirmed: "Нягтлан Баталгаажсан",
  received: "Орлого авагдсан",
};

export const STATUS_COLOR: Record<string, string> = {
  preparing: "bg-amber-50 text-amber-700",
  reviewing: "bg-blue-50 text-blue-700",
  sending: "bg-violet-50 text-violet-700",
  loading: "bg-orange-50 text-orange-700",
  transit: "bg-sky-50 text-sky-700",
  arrived: "bg-teal-50 text-teal-700",
  accounting: "bg-purple-50 text-purple-700",
  confirmed: "bg-emerald-50 text-emerald-700",
  received: "bg-green-50 text-green-700",
};
