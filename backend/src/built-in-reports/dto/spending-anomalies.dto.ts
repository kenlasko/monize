export type AnomalyType =
  | "large_transaction"
  | "category_spike"
  | "unusual_payee";
export type AnomalySeverity = "high" | "medium" | "low";

export class SpendingAnomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  title: string;
  description: string;
  amount?: number;
  transactionId?: string;
  transactionDate?: string;
  payeeName?: string;
  categoryId?: string;
  categoryName?: string;
  currentPeriodAmount?: number;
  previousPeriodAmount?: number;
  percentChange?: number;
}

export class AnomalyStatistics {
  mean: number;
  stdDev: number;
}

export class AnomalyCounts {
  high: number;
  medium: number;
  low: number;
}

export class SpendingAnomaliesResponse {
  statistics: AnomalyStatistics;
  anomalies: SpendingAnomaly[];
  counts: AnomalyCounts;
}
