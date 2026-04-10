import { create } from "zustand";

export type SupervisorLine = {
  orderId: number;
  warehouseTagId: number;
  brand: string;
  itemCode: string;
  name: string;
  unitWeight: number;
  orderQtyBox: number;
  orderQtyPcs: number;
  computedWeight: number;
};

export type SupplierGroup = {
  supplier_id: number;
  supplier_name: string;
  brands: { brand: string; weight: number; warehouses: Record<string, number> }[];
  total_weight: number;
  order_count: number;
};

type State = {
  lines: SupervisorLine[];
  brandOverride: Record<string, number>;
  // Supplier view
  supplierGroups: SupplierGroup[];
  unmappedBrands: { brand: string; weight: number; order_count: number }[];
  supplierFilter: number | null;

  setLines: (lines: SupervisorLine[]) => void;
  setBrandOverride: (brand: string, w: number) => void;
  setSupplierData: (
    groups: SupplierGroup[],
    unmapped: { brand: string; weight: number; order_count: number }[]
  ) => void;
  setSupplierFilter: (id: number | null) => void;
};

export const useSupervisorStore = create<State>((set) => ({
  lines: [],
  brandOverride: {},
  supplierGroups: [],
  unmappedBrands: [],
  supplierFilter: null,

  setLines: (lines) => set({ lines }),
  setBrandOverride: (brand, w) =>
    set((s) => ({ brandOverride: { ...s.brandOverride, [brand]: w } })),
  setSupplierData: (supplierGroups, unmappedBrands) =>
    set({ supplierGroups, unmappedBrands }),
  setSupplierFilter: (supplierFilter) => set({ supplierFilter }),
}));