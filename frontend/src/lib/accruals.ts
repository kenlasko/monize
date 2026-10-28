import type { UpdateTransactionData } from "@/types/transaction";
import apiClient from "./api";
import { clearAllCache } from "./apiCache";

export type AccrualFamily = "expense" | "income";
export type AccrualPreset = "LTM" | "NTM" | "CUSTOM";
export type AccrualDateRule = "MONTH_END" | "FIRST_BUSINESS_DAY";
export interface AccrualInput {
  sourceTransactionId: string;
  sourceSplitId?: string | null;
  preset: AccrualPreset;
  startMonth?: string;
  monthCount?: number;
  family?: AccrualFamily;
  dateRule?: AccrualDateRule;
}
export interface AccrualPlan {
  startMonth: string;
  monthCount: number;
  amount: string;
  allocations: {
    periodIndex: number;
    recognitionDate: string;
    amount: string;
  }[];
}
export interface AccrualScheduleSummary {
  id: string;
  sourceSplitId: string | null;
  preset: AccrualPreset;
  dateRule?: AccrualDateRule;
  startMonth: string;
  monthCount: number;
  revision: number;
  family: AccrualFamily;
}
export interface AccrualSource {
  transactionId: string;
  splitId: string | null;
  amount: string;
  paymentDate: string;
  currencyCode: string;
  currencyDecimals: number;
}
export interface AccrualPreview {
  source: AccrualSource;
  family: AccrualFamily;
  plan: AccrualPlan;
  before: AccrualPlan | null;
  expectedScheduleId: string | null;
  expectedRevision: number | null;
  fingerprint: string;
  timingBalances: { asOf: string; amount: string }[];
}
export interface AccrualDetail {
  source: AccrualSource;
  schedule: AccrualScheduleSummary;
  plan: AccrualPlan;
  fingerprint: string;
}
export interface AccrualSourceImpact {
  fingerprint: string | null;
  impacts: {
    scheduleId: string;
    sourceSplitId: string | null;
    removed: boolean;
    before: AccrualPlan;
    after: AccrualPlan | null;
    familyBefore: AccrualFamily;
    familyAfter: AccrualFamily | null;
    currencyBefore: string;
    currencyAfter: string;
    paymentDateBefore: string;
    paymentDateAfter: string;
    timingBalances: { asOf: string; before: string; after: string }[];
  }[];
}
export interface AccrualSystemAccount {
  id: string;
  family: AccrualFamily;
  currencyCode: string;
  date: string;
  balance: string;
}
export interface AccrualSystemMovements {
  readOnly: true;
  basis: "accrual";
  account: { id: string; family: AccrualFamily; currencyCode: string };
  startDate: string;
  endDate: string;
  opening: string;
  closing: string;
  count: number;
  rows: {
    date: string;
    kind: "payment" | "recognition";
    amount: string;
    sourceTransactionId: string;
    sourceSplitId: string | null;
    scheduleId: string;
    accountId: string;
    cashDate: string;
  }[];
}
export const accrualsApi = {
  editorPreview: async (
    id: string,
    input: {
      patch: UpdateTransactionData;
      settings: (AccrualInput & { remove?: boolean })[];
    },
  ) => {
    const response = await apiClient.post(
      `/transactions/${id}/accrual-editor/preview`,
      input,
    );
    // The reviewed source is fresh; retire cached derived reads of its prior state.
    clearAllCache();
    return response.data;
  },
  editorSave: async (
    id: string,
    input: {
      patch: UpdateTransactionData;
      settings: (AccrualInput & { remove?: boolean })[];
      fingerprint: string;
    },
  ) => {
    const response = await apiClient.post(
      `/transactions/${id}/accrual-editor`,
      input,
    );
    clearAllCache();
    return response.data;
  },
  systemBalances: async (
    asOf: string,
  ): Promise<{
    basis: "accrual";
    asOf: string;
    accounts: AccrualSystemAccount[];
  }> => {
    const response = await apiClient.get("/accruals/system-balances", {
      params: { asOf },
    });
    return response.data;
  },
  systemMovements: async (
    id: string,
    startDate: string,
    endDate: string,
  ): Promise<AccrualSystemMovements> => {
    const response = await apiClient.get(
      `/accruals/system-accounts/${id}/movements`,
      { params: { startDate, endDate, limit: 2000 } },
    );
    return response.data;
  },
  sources: async (
    sourceTransactionIds: string[],
  ): Promise<{ sourceTransactionId: string; scheduleCount: number }[]> => {
    const response = await apiClient.post("/accruals/sources", {
      sourceTransactionIds,
    });
    return response.data;
  },
  sourcePreview: async (
    sourceTransactionId: string,
    patch: UpdateTransactionData,
  ): Promise<AccrualSourceImpact> => {
    const response = await apiClient.post<AccrualSourceImpact>(
      "/accruals/source-preview",
      { sourceTransactionId, patch },
    );
    return response.data;
  },
  sourceSchedules: async (
    sourceId: string,
  ): Promise<AccrualScheduleSummary[]> => {
    const response = await apiClient.get<AccrualScheduleSummary[]>(
      `/accruals/source/${sourceId}`,
    );
    return response.data;
  },
  detail: async (id: string): Promise<AccrualDetail> => {
    const response = await apiClient.get<AccrualDetail>(`/accruals/${id}`);
    return response.data;
  },
  preview: async (input: AccrualInput): Promise<AccrualPreview> => {
    const response = await apiClient.post<AccrualPreview>(
      "/accruals/preview",
      input,
    );
    return response.data;
  },
  save: async (input: AccrualInput, preview: AccrualPreview): Promise<void> => {
    await apiClient.post("/accruals", {
      ...input,
      fingerprint: preview.fingerprint,
      expectedScheduleId: preview.expectedScheduleId,
      expectedRevision: preview.expectedRevision,
    });
    clearAllCache();
  },
  remove: async (detail: AccrualDetail): Promise<void> => {
    await apiClient.delete(`/accruals/${detail.schedule.id}`, {
      data: {
        fingerprint: detail.fingerprint,
        expectedRevision: detail.schedule.revision,
      },
    });
    clearAllCache();
  },
};
