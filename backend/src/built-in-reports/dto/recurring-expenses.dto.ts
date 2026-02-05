export class RecurringExpenseItem {
  payeeName: string;
  payeeId: string | null;
  occurrences: number;
  totalAmount: number;
  averageAmount: number;
  lastTransactionDate: string;
  frequency: string;
  categoryName: string;
}

export class RecurringSummary {
  totalRecurring: number;
  monthlyEstimate: number;
  uniquePayees: number;
}

export class RecurringExpensesResponse {
  data: RecurringExpenseItem[];
  summary: RecurringSummary;
}
