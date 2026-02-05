export class BillPaymentItem {
  scheduledTransactionId: string;
  scheduledTransactionName: string;
  payeeName: string;
  totalPaid: number;
  paymentCount: number;
  averagePayment: number;
  lastPaymentDate: string | null;
}

export class MonthlyBillTotal {
  month: string;
  label: string;
  total: number;
}

export class BillPaymentSummary {
  totalPaid: number;
  totalPayments: number;
  uniqueBills: number;
  monthlyAverage: number;
}

export class BillPaymentHistoryResponse {
  billPayments: BillPaymentItem[];
  monthlyTotals: MonthlyBillTotal[];
  summary: BillPaymentSummary;
}
