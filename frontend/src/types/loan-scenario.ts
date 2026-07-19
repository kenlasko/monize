import { LumpSum, OverpaymentFrequency, OverpaymentMode } from '@/lib/loan-schedule';

/** A saved overpayment simulation for a loan/mortgage account */
export interface LoanScenario {
  id: string;
  userId: string;
  accountId: string;
  name: string;
  recurringExtraAmount: number | null;
  /** Whether the recurring overpayment shortens the term or lowers the installment */
  recurringExtraMode: OverpaymentMode | null;
  /** Cadence of the recurring overpayment; null means every loan payment */
  recurringExtraFrequency: OverpaymentFrequency | null;
  recurringExtraStartDate: string | null;
  recurringExtraEndDate: string | null;
  /** Fixed total spent on the loan each period (budget mode); null otherwise */
  targetMonthlyPayment: number | null;
  targetMonthlyPaymentMode: OverpaymentMode | null;
  targetMonthlyPaymentStartDate: string | null;
  targetMonthlyPaymentEndDate: string | null;
  lumpSums: LumpSum[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateLoanScenarioData {
  name: string;
  recurringExtraAmount?: number | null;
  recurringExtraMode?: OverpaymentMode | null;
  recurringExtraFrequency?: OverpaymentFrequency | null;
  recurringExtraStartDate?: string | null;
  recurringExtraEndDate?: string | null;
  targetMonthlyPayment?: number | null;
  targetMonthlyPaymentMode?: OverpaymentMode | null;
  targetMonthlyPaymentStartDate?: string | null;
  targetMonthlyPaymentEndDate?: string | null;
  lumpSums?: LumpSum[];
}

export type UpdateLoanScenarioData = Partial<CreateLoanScenarioData>;
