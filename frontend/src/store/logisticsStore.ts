import { create } from "zustand";

export type Vehicle = {
  id: number;
  name: string;
  plate: string;
  capacity_kg: number;
  driver_name: string;
  driver_phone: string;
  is_active: boolean;
  trip_count?: number;
  total_weight_kg?: number;
  total_weight_ton?: number;
  rank?: number;
};

export type ShipmentAssignment = {
  brand: string;
  allocated_weight: number;
  supplier_id: number | null;
};

export type Shipment = {
  id: number;
  created_at: string;
  vehicle_id: number;
  vehicle_name: string;
  vehicle_plate: string;
  capacity_kg: number;
  status: string;
  notes: string;
  total_weight: number;
  fill_pct: number;
  assignments: ShipmentAssignment[];
};

export type OptVehicleResult = {
  vehicle_id: number;
  vehicle_name: string;
  vehicle_plate: string;
  capacity_kg: number;
  brands: { brand: string; weight: number }[];
  total_weight: number;
  fill_pct: number;
};

export type OptimizationResult = {
  vehicles: OptVehicleResult[];
  unassigned_brands: { brand: string; weight: number }[];
};

type State = {
  vehicles: Vehicle[];
  shipments: Shipment[];
  optimizationResult: OptimizationResult | null;
  brandWeights: Record<string, number>;
  pendingAssignments: Record<string, number | null>; // brand → vehicle_id

  setVehicles: (vehicles: Vehicle[]) => void;
  setShipments: (shipments: Shipment[]) => void;
  setOptimizationResult: (result: OptimizationResult | null) => void;
  setBrandWeights: (weights: Record<string, number>) => void;
  setPendingAssignment: (brand: string, vehicleId: number | null) => void;
  applyOptResult: (result: OptimizationResult) => void;
};

export const useLogisticsStore = create<State>((set) => ({
  vehicles: [],
  shipments: [],
  optimizationResult: null,
  brandWeights: {},
  pendingAssignments: {},

  setVehicles: (vehicles) => set({ vehicles }),
  setShipments: (shipments) => set({ shipments }),
  setOptimizationResult: (result) => set({ optimizationResult: result }),
  setBrandWeights: (weights) => set({ brandWeights: weights }),
  setPendingAssignment: (brand, vehicleId) =>
    set((s) => ({
      pendingAssignments: { ...s.pendingAssignments, [brand]: vehicleId },
    })),
  applyOptResult: (result) => {
    const assignments: Record<string, number | null> = {};
    for (const v of result.vehicles) {
      for (const b of v.brands) {
        assignments[b.brand] = v.vehicle_id;
      }
    }
    for (const b of result.unassigned_brands) {
      assignments[b.brand] = null;
    }
    set({ optimizationResult: result, pendingAssignments: assignments });
  },
}));
