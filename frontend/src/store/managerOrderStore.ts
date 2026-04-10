import { create } from "zustand";

export type MProduct = {
  id: number;
  item_code: string;
  name: string;
  brand: string;
  unit_weight: number;
  stock_qty: number;
  sales_qty: number;
  pack_ratio: number;
  warehouse_tag_id: number;
};

export type OrderSummary = {
  id: number;
  created_at: string;
  status: string;
  warehouse_tag_id: number;
  brand: string;
};

type State = {
  selectedTagId: number | null;
  selectedBrand: string;
  products: MProduct[];
  quantities: Record<number, number>; // product_id → qty_box
  currentOrderIds: Record<string, number>; // "brand_tagId" → order_id
  orders: OrderSummary[];

  setSelectedTagId: (id: number | null) => void;
  setSelectedBrand: (brand: string) => void;
  setProducts: (products: MProduct[]) => void;
  setQuantity: (productId: number, qty: number) => void;
  resetQuantities: () => void;
  applyQuantities: (qtys: Record<number, number>) => void;
  setOrderId: (key: string, id: number) => void;
  clearOrderId: (key: string) => void;
  setOrders: (orders: OrderSummary[]) => void;
};

const _loadOrderIds = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem("manager_order_ids") ?? "{}");
  } catch {
    return {};
  }
};

const _saveOrderIds = (ids: Record<string, number>) => {
  localStorage.setItem("manager_order_ids", JSON.stringify(ids));
};

export const useManagerOrderStore = create<State>((set) => ({
  selectedTagId: null,
  selectedBrand: "",
  products: [],
  quantities: {},
  currentOrderIds: _loadOrderIds(),
  orders: [],

  setSelectedTagId: (id) => set({ selectedTagId: id }),
  setSelectedBrand: (brand) => set({ selectedBrand: brand }),
  setProducts: (products) => set({ products }),
  setQuantity: (productId, qty) =>
    set((s) => ({ quantities: { ...s.quantities, [productId]: qty } })),
  resetQuantities: () => set({ quantities: {} }),
  applyQuantities: (qtys) => set({ quantities: qtys }),
  setOrderId: (key, id) =>
    set((s) => {
      const next = { ...s.currentOrderIds, [key]: id };
      _saveOrderIds(next);
      return { currentOrderIds: next };
    }),
  clearOrderId: (key) =>
    set((s) => {
      const next = { ...s.currentOrderIds };
      delete next[key];
      _saveOrderIds(next);
      return { currentOrderIds: next };
    }),
  setOrders: (orders) => set({ orders }),
}));
