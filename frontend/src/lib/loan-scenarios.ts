import apiClient from './api';
import { dedupe, invalidateCache } from './apiCache';
import type { OverpaymentPlan } from '@/lib/loan-schedule';
import {
  LoanScenario,
  CreateLoanScenarioData,
  UpdateLoanScenarioData,
} from '@/types/loan-scenario';

const cachePrefix = (accountId: string) => `loan-scenarios:${accountId}`;

export const loanScenariosApi = {
  getAll: async (accountId: string): Promise<LoanScenario[]> => {
    return dedupe(
      `${cachePrefix(accountId)}:all`,
      async () => {
        const response = await apiClient.get<LoanScenario[]>(
          `/accounts/${accountId}/loan-scenarios`,
        );
        return response.data;
      },
      120_000, // 2 min
    );
  },

  create: async (accountId: string, data: CreateLoanScenarioData): Promise<LoanScenario> => {
    const response = await apiClient.post<LoanScenario>(
      `/accounts/${accountId}/loan-scenarios`,
      data,
    );
    invalidateCache(cachePrefix(accountId));
    return response.data;
  },

  update: async (
    accountId: string,
    id: string,
    data: UpdateLoanScenarioData,
  ): Promise<LoanScenario> => {
    const response = await apiClient.patch<LoanScenario>(
      `/accounts/${accountId}/loan-scenarios/${id}`,
      data,
    );
    invalidateCache(cachePrefix(accountId));
    return response.data;
  },

  delete: async (accountId: string, id: string): Promise<void> => {
    await apiClient.delete(`/accounts/${accountId}/loan-scenarios/${id}`);
    invalidateCache(cachePrefix(accountId));
  },
};

/** Convert a saved scenario's inputs to the simulator's plan shape */
export function scenarioToPlan(scenario: LoanScenario): OverpaymentPlan | null {
  const recurringExtra =
    scenario.recurringExtraAmount && scenario.recurringExtraAmount > 0
      ? {
          amount: scenario.recurringExtraAmount,
          ...(scenario.recurringExtraMode ? { mode: scenario.recurringExtraMode } : {}),
          ...(scenario.recurringExtraFrequency
            ? { frequency: scenario.recurringExtraFrequency }
            : {}),
          ...(scenario.recurringExtraStartDate
            ? { startDate: scenario.recurringExtraStartDate }
            : {}),
          ...(scenario.recurringExtraEndDate
            ? { endDate: scenario.recurringExtraEndDate }
            : {}),
        }
      : undefined;
  const lumpSums = scenario.lumpSums ?? [];
  const budget =
    scenario.targetMonthlyPayment && scenario.targetMonthlyPayment > 0
      ? {
          targetMonthlyPayment: scenario.targetMonthlyPayment,
          ...(scenario.targetMonthlyPaymentMode
            ? { targetMonthlyPaymentMode: scenario.targetMonthlyPaymentMode }
            : {}),
          ...(scenario.targetMonthlyPaymentStartDate
            ? { targetMonthlyPaymentStart: scenario.targetMonthlyPaymentStartDate }
            : {}),
          ...(scenario.targetMonthlyPaymentEndDate
            ? { targetMonthlyPaymentEnd: scenario.targetMonthlyPaymentEndDate }
            : {}),
        }
      : null;
  if (!recurringExtra && lumpSums.length === 0 && !budget) return null;
  return {
    ...(recurringExtra ? { recurringExtra } : {}),
    ...(lumpSums.length > 0 ? { lumpSums } : {}),
    ...(budget ?? {}),
  };
}

/** Convert the simulator's current plan to a create/update payload */
export function planToScenarioData(
  plan: OverpaymentPlan | null,
  name: string,
): CreateLoanScenarioData {
  return {
    name,
    recurringExtraAmount: plan?.recurringExtra?.amount ?? null,
    recurringExtraMode: plan?.recurringExtra?.mode ?? null,
    recurringExtraFrequency: plan?.recurringExtra?.frequency ?? null,
    recurringExtraStartDate: plan?.recurringExtra?.startDate ?? null,
    recurringExtraEndDate: plan?.recurringExtra?.endDate ?? null,
    targetMonthlyPayment: plan?.targetMonthlyPayment ?? null,
    targetMonthlyPaymentMode: plan?.targetMonthlyPaymentMode ?? null,
    targetMonthlyPaymentStartDate: plan?.targetMonthlyPaymentStart ?? null,
    targetMonthlyPaymentEndDate: plan?.targetMonthlyPaymentEnd ?? null,
    lumpSums: plan?.lumpSums ?? [],
  };
}
