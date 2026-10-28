import { createContext } from "react";
export type ReportingBasis = "cash" | "accrual";
export type Selection = ReportingBasis | "default";
export const BasisContext = createContext<{
  basis: ReportingBasis;
  viewChanged?: boolean;
  showDetails: (href: string) => boolean;
  selection: Selection;
  choose: (value: Selection) => void;
} | null>(null);
