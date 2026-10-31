import apiClient from './api';
import {
  Account,
  CreateAccountData,
  UpdateAccountData,
  AccountSummary,
  TransferCandidate,
  InvestmentAccountPair,
  LoanPreviewData,
  AmortizationPreview,
  MortgagePreviewData,
  MortgageAmortizationPreview,
  UpdateMortgageRateData,
  UpdateMortgageRateResponse,
  DetectedLoanPayment,
  DetectMortgageTypeData,
  MortgageTypeDetection,
  MortgageTypeHistoryDetection,
  SetupLoanPaymentsData,
  SetupLoanPaymentsResponse,
  PreviewLoanPaymentSetupData,
  PreviewLoanPaymentSetupResponse,
  AccountBalancesAsOfResponse,
  DailyBalanceTotalsResponse,
  LoanSettlementRow,
  PaymentMatching,
} from '@/types/account';
import type { TransactionRule } from '@/types/transaction-rule';
import { StatementCycle, InterestPaid } from '@/types/credit-card-detail';
import { BalanceForecast } from '@/types/banking-detail';
import {
  dedupe,
  invalidateCache,
  invalidateScheduledFxReadModel,
} from './apiCache';
import { invalidateTransactionRulesCache } from './transaction-rules-api';

// The Investments page reads its account list from its own cached endpoint
// (`investments:accounts`), not from `accounts:`. A write that adds, renames,
// closes, reopens or removes an account drops both, or the page keeps offering
// the pre-write list -- a just-created account missing from its selector.
function invalidateAccountLists(): void {
  invalidateCache('accounts:');
  invalidateCache('investments:accounts');
}

export const accountsApi = {
  // Create account
  create: async (data: CreateAccountData): Promise<Account> => {
    const response = await apiClient.post<Account>('/accounts', data);
    invalidateAccountLists();
    return response.data;
  },

  // Create investment account pair (cash + brokerage)
  createInvestmentPair: async (data: CreateAccountData): Promise<InvestmentAccountPair> => {
    const response = await apiClient.post<InvestmentAccountPair>('/accounts', {
      ...data,
      createInvestmentPair: true,
    });
    invalidateAccountLists();
    return response.data;
  },

  // Get all accounts
  getAll: async (includeInactive: boolean = false): Promise<Account[]> => {
    const cacheKey = `accounts:all:${includeInactive}`;
    return dedupe(
      cacheKey,
      async () => {
        const response = await apiClient.get<Account[]>('/accounts', {
          params: { includeInactive },
        });
        return response.data;
      },
      120_000, // 2 min
    );
  },

  // Get all accounts, skipping the cache. For a re-read after a write this tab
  // did not make (another tab or device), which no invalidation here saw.
  getAllFresh: async (includeInactive: boolean = false): Promise<Account[]> => {
    invalidateCache(`accounts:all:${includeInactive}`);
    return accountsApi.getAll(includeInactive);
  },

  // Accounts the real user can use as the other side of a cross-owner
  // transfer (own context: shared to them; acting: their own accounts).
  getTransferCandidates: async (): Promise<TransferCandidate[]> => {
    const response = await apiClient.get<TransferCandidate[]>(
      '/accounts/transfer-candidates',
    );
    return response.data;
  },

  // Get account by ID
  getById: async (id: string): Promise<Account> => {
    const response = await apiClient.get<Account>(`/accounts/${id}`);
    return response.data;
  },

  // Get the current statement cycle for a credit card
  getStatementCycle: async (id: string): Promise<StatementCycle> => {
    const response = await apiClient.get<StatementCycle>(`/accounts/${id}/statement-cycle`);
    return response.data;
  },

  // Project the balance forward including scheduled transactions
  getBalanceForecast: async (id: string, days?: number): Promise<BalanceForecast> => {
    const response = await apiClient.get<BalanceForecast>(`/accounts/${id}/balance-forecast`, {
      params: days ? { days } : undefined,
    });
    return response.data;
  },

  // Get interest/fees charged to an account within a date range
  getInterestPaid: async (
    id: string,
    startDate: string,
    endDate: string,
  ): Promise<InterestPaid> => {
    const response = await apiClient.get<InterestPaid>(`/accounts/${id}/interest-paid`, {
      params: { startDate, endDate },
    });
    return response.data;
  },

  // Update account
  update: async (id: string, data: UpdateAccountData): Promise<Account> => {
    const response = await apiClient.patch<Account>(`/accounts/${id}`, data);
    invalidateAccountLists();
    // Issue #1167: a funding / linked-cash / brokerage account's currency is one
    // side of a scheduled investment's settlement pair, and the cached
    // scheduled-transaction read model holds server-derived FX fields resolved
    // against that pair. An account-currency edit makes that payload stale, so
    // force findAll() to resolve those fields again -- one semantic helper shared
    // with the security-update and rate-refresh paths.
    invalidateScheduledFxReadModel();
    return response.data;
  },

  // Close account
  close: async (id: string): Promise<Account> => {
    const response = await apiClient.post<Account>(`/accounts/${id}/close`);
    invalidateAccountLists();
    return response.data;
  },

  // Reopen account
  reopen: async (id: string): Promise<Account> => {
    const response = await apiClient.post<Account>(`/accounts/${id}/reopen`);
    invalidateAccountLists();
    return response.data;
  },

  // Reorder favourite accounts
  reorderFavourites: async (accountIds: string[]): Promise<void> => {
    await apiClient.patch('/accounts/reorder-favourites', { accountIds });
    invalidateCache('accounts:');
  },

  // Set the acting delegate's own favourite flag for an account. The
  // owner's accounts.is_favourite is never touched by this. Also serves a
  // grantee's native favourite on a joint account.
  setDelegateFavourite: async (
    id: string,
    isFavourite: boolean,
  ): Promise<void> => {
    await apiClient.put(`/accounts/${id}/favourite`, { isFavourite });
    invalidateCache('accounts:');
  },

  // A grantee's per-account "exclude this joint account from MY net worth"
  // toggle. Changes the union list payload, so the accounts cache clears.
  setNetWorthExclusion: async (
    id: string,
    excluded: boolean,
  ): Promise<void> => {
    await apiClient.put(`/accounts/${id}/net-worth-exclusion`, { excluded });
    invalidateCache('accounts:');
  },

  // Get account balance
  getBalance: async (id: string): Promise<{ balance: number }> => {
    const response = await apiClient.get<{ balance: number }>(`/accounts/${id}/balance`);
    return response.data;
  },

  // Get account summary
  getSummary: async (): Promise<AccountSummary> => {
    const response = await apiClient.get<AccountSummary>('/accounts/summary');
    return response.data;
  },

  // Get investment account pair
  getInvestmentPair: async (id: string): Promise<InvestmentAccountPair> => {
    const response = await apiClient.get<InvestmentAccountPair>(
      `/accounts/${id}/investment-pair`,
    );
    return response.data;
  },

  // Check if account can be deleted
  canDelete: async (id: string): Promise<{ transactionCount: number; investmentTransactionCount: number; canDelete: boolean }> => {
    const response = await apiClient.get<{ transactionCount: number; investmentTransactionCount: number; canDelete: boolean }>(
      `/accounts/${id}/can-delete`,
    );
    return response.data;
  },

  // Delete account (only if no transactions)
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/accounts/${id}`);
    invalidateAccountLists();
  },

  // Get daily running balances for accounts (per-account rows with currency)
  getDailyBalances: async (params?: {
    startDate?: string;
    endDate?: string;
    accountIds?: string;
    // Span the account's full history (from its earliest transaction) instead
    // of the backend's default one-year window. Only honoured when no
    // startDate is given.
    allTime?: boolean;
  }): Promise<Array<{ date: string; balance: number; accountId: string; currencyCode: string }>> => {
    // Dedupe so multiple components requesting the same range/accounts share
    // a single network call. Daily balances roll forward as transactions
    // change, so cache TTL is short.
    const cacheKey = `accounts:daily-balances:${params?.startDate ?? ''}:${params?.endDate ?? ''}:${params?.accountIds ?? ''}:${params?.allTime ? 'all' : ''}`;
    return dedupe(
      cacheKey,
      async () => {
        const response = await apiClient.get<Array<{ date: string; balance: number; accountId: string; currencyCode: string }>>(
          '/accounts/daily-balances',
          { params },
        );
        return response.data;
      },
      30_000, // 30 sec
    );
  },

  // The scope's end-of-day TOTAL per calendar day, in one currency: actual
  // through the server's today, projected after it (the calendar's Balances
  // layer). Distinct from getDailyBalances, which is per account, in each
  // account's own currency, and history only.
  //
  // Under the `accounts:` prefix on purpose: a transaction write moves these
  // figures, and that prefix is what invalidateBalanceCaches() drops.
  getDailyBalanceTotals: async (params: {
    startDate: string;
    endDate: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<DailyBalanceTotalsResponse> => {
    const cacheKey = `accounts:daily-balance-totals:${params.startDate}:${params.endDate}:${params.accountIds ?? ''}:${params.displayCurrency ?? ''}`;
    return dedupe(
      cacheKey,
      async () => {
        const response = await apiClient.get<DailyBalanceTotalsResponse>(
          '/accounts/daily-balance-totals',
          { params },
        );
        return response.data;
      },
      30_000, // 30 sec -- these move with every transaction write
    );
  },

  // Every account's balance measured at a single date (issue #1198). A balance
  // is a point-in-time figure, so the date is part of the request and the
  // response echoes it back -- the payload cannot be told from the previous
  // one otherwise.
  getBalancesAsOf: async (asOfDate: string): Promise<AccountBalancesAsOfResponse> => {
    const cacheKey = `accounts:balances-as-of:${asOfDate}`;
    return dedupe(
      cacheKey,
      async () => {
        const response = await apiClient.get<AccountBalancesAsOfResponse>(
          '/accounts/balances-as-of',
          { params: { asOfDate } },
        );
        return response.data;
      },
      30_000, // 30 sec -- these move with every transaction write
    );
  },

  // Preview loan amortization
  previewLoanAmortization: async (data: LoanPreviewData): Promise<AmortizationPreview> => {
    const response = await apiClient.post<AmortizationPreview>('/accounts/loan-preview', data);
    return response.data;
  },

  // Preview mortgage amortization
  previewMortgageAmortization: async (data: MortgagePreviewData): Promise<MortgageAmortizationPreview> => {
    const response = await apiClient.post<MortgageAmortizationPreview>('/accounts/mortgage-preview', data);
    return response.data;
  },

  // Update mortgage interest rate
  updateMortgageRate: async (id: string, data: UpdateMortgageRateData): Promise<UpdateMortgageRateResponse> => {
    const response = await apiClient.patch<UpdateMortgageRateResponse>(`/accounts/${id}/mortgage-rate`, data);
    invalidateCache('accounts:');
    return response.data;
  },

  // Detect loan payment patterns from transaction history
  detectLoanPayments: async (id: string): Promise<DetectedLoanPayment | null> => {
    const response = await apiClient.get<DetectedLoanPayment | null>(`/accounts/${id}/detect-loan-payments`);
    return response.data;
  },

  // Suggest a mortgage type from installments the user typed in. A
  // suggestion: the server reads and writes nothing, so no cache is
  // invalidated.
  detectMortgageType: async (data: DetectMortgageTypeData): Promise<MortgageTypeDetection> => {
    const response = await apiClient.post<MortgageTypeDetection>('/accounts/mortgage-type/detect', data);
    return response.data;
  },

  // Suggest a mortgage type from the loan's own posted installments. Writes
  // nothing: the account keeps its type until the user saves the edit form.
  detectMortgageTypeFromHistory: async (id: string): Promise<MortgageTypeHistoryDetection> => {
    const response = await apiClient.post<MortgageTypeHistoryDetection>(`/accounts/${id}/mortgage-type/detect`);
    return response.data;
  },

  // The first installment a LINEAR or INTEREST_ONLY mortgage's payment setup
  // would schedule, priced by the code the setup checks its payment against.
  // Writes nothing, so no cache is invalidated.
  previewLoanPaymentSetup: async (
    id: string,
    data: PreviewLoanPaymentSetupData,
  ): Promise<PreviewLoanPaymentSetupResponse> => {
    const response = await apiClient.post<PreviewLoanPaymentSetupResponse>(
      `/accounts/${id}/setup-loan-payments/preview`,
      data,
    );
    return response.data;
  },

  // Set up scheduled loan/mortgage payments
  setupLoanPayments: async (id: string, data: SetupLoanPaymentsData): Promise<SetupLoanPaymentsResponse> => {
    const response = await apiClient.post<SetupLoanPaymentsResponse>(`/accounts/${id}/setup-loan-payments`, data);
    invalidateCache('accounts:');
    return response.data;
  },

  // Create the "Payment matching" rule of a loan that has none: the rule, the
  // loan's pointer to it and the bill's auto-post turned off, in one server
  // transaction. Moves no money, so only the lists it changes are dropped.
  createPaymentMatchingRule: async (id: string, data: PaymentMatching): Promise<TransactionRule> => {
    try {
      const response = await apiClient.post<TransactionRule>(`/accounts/${id}/payment-matching-rule`, data);
      return response.data;
    } finally {
      invalidateCache('accounts:');
      invalidateCache('scheduled:');
      invalidateTransactionRulesCache();
    }
  },

  // The installments payment matching settled on a loan, newest first. Never
  // cached: Process history and every import change it.
  getLoanSettlements: async (id: string): Promise<LoanSettlementRow[]> => {
    const response = await apiClient.get<LoanSettlementRow[]>(`/accounts/${id}/loan-settlements`);
    return response.data;
  },

  // Export account transactions
  exportAccount: async (id: string, format: 'csv' | 'qif', options?: { expandSplits?: boolean; dateFormat?: string }): Promise<void> => {
    const params: Record<string, string> = { format };
    if (options?.expandSplits === false) {
      params.expandSplits = 'false';
    }
    if (options?.dateFormat) {
      params.dateFormat = options.dateFormat;
    }
    const response = await apiClient.get(`/accounts/${id}/export`, {
      params,
      responseType: 'blob',
    });
    const contentDisposition = String(
      response.headers['content-disposition'] ?? '',
    );
    const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
    const filename = filenameMatch ? filenameMatch[1] : `account.${format}`;

    const contentType = response.headers['content-type'];
    const blob = new Blob([response.data], {
      type: typeof contentType === 'string' ? contentType : undefined,
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  },
};
