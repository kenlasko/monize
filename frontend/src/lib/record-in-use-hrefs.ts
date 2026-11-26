import type { RecordInUseEntry } from './errors';

// Where the items of one kind that still use a record can be seen, for the
// RECORD_IN_USE refusal of a delete. undefined when no page lists them, so the
// notice renders the kind unlinked. The payee version is `payeeInUseHref`.

const firstOrList = (entry: RecordInUseEntry) =>
  entry.ids?.length === 1 ? `/accounts/${entry.ids[0]}` : '/accounts';

export function categoryInUseHref(categoryId: string, entry: RecordInUseEntry): string | undefined {
  switch (entry.kind) {
    case 'subcategories':
      return `/categories/${categoryId}`;
    case 'transactions':
      return `/transactions?categoryId=${categoryId}`;
    case 'scheduledTransactions':
      return '/bills';
    case 'budgets':
    case 'budgetLines':
    case 'budgetPeriods':
    case 'payrollDeductionRules':
      return '/budgets';
    case 'rules':
      return '/rules';
    case 'customReports':
      return '/reports';
    case 'sharedPostings':
      return '/shared-expenses';
    default:
      return undefined;
  }
}

export function accountInUseHref(accountId: string, entry: RecordInUseEntry): string | undefined {
  switch (entry.kind) {
    case 'transactions':
      return `/transactions?accountId=${accountId}`;
    case 'holdings':
    case 'investmentTransactions':
      return `/accounts/${accountId}`;
    case 'scheduledTransactions':
      return '/bills';
    case 'loanAccounts':
    case 'linkedAccounts':
      return firstOrList(entry);
    case 'budgets':
    case 'budgetLines':
      return '/budgets';
    case 'rules':
      return '/rules';
    default:
      return undefined;
  }
}

export function scheduledInUseHref(_scheduleId: string, entry: RecordInUseEntry): string | undefined {
  switch (entry.kind) {
    case 'loanFees':
    case 'loanAccounts':
      return firstOrList(entry);
    case 'budgetLines':
    case 'budgets':
      return '/budgets';
    case 'rules':
      return '/rules';
    default:
      return undefined;
  }
}

export function securityInUseHref(securityId: string, entry: RecordInUseEntry): string | undefined {
  switch (entry.kind) {
    case 'holdings':
    case 'investmentTransactions':
    case 'transactions':
    case 'securityDocuments':
      return `/securities/${securityId}`;
    case 'gemStrategies':
      return '/reports/gem-strategy';
    default:
      return undefined;
  }
}
