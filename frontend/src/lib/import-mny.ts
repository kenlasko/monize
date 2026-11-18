import apiClient from './api';
import { clearAllCache } from './apiCache';
import { AccountType } from '@/types/account';

/**
 * Client for the Microsoft Money (`.mny`) import endpoints.
 *
 * Two things differ from the QIF/OFX/CSV client. The file goes up as multipart
 * binary rather than as text in a JSON body -- a `.mny` file is a Jet database
 * and reading it with `File.text()` would corrupt it. And the import is a
 * background job, so `start` returns a job to poll rather than a result.
 *
 * Timeouts are per call because the defaults cannot fit both: decrypting and
 * parsing a 200 MB file takes far longer than the shared 10 s, while a poll that
 * hangs for 10 s makes the progress bar feel broken.
 */

/** Upload + parse of a 200 MB-class file, including the round trip. */
const PARSE_TIMEOUT_MS = 300_000;
/**
 * Starting is normally an insert and a return -- except with "start fresh",
 * where the wipe runs **inside** this request on purpose, so its credentials
 * never reach the job row. Deleting a populated profile does not fit in the
 * shared 10 s, and timing out here is worse than slow: the server carries on
 * wiping and importing while the wizard reports a failed start.
 */
const START_TIMEOUT_MS = 120_000;
/** A poll is a single indexed row read; anything slower is a real problem. */
const POLL_TIMEOUT_MS = 10_000;

export type MnyEra =
  | 'money99'
  | 'money2001'
  | 'money2002'
  | 'moneyPlus'
  | 'unknown';

export type MnyImportPhase =
  | 'preparing'
  | 'reference'
  | 'transactions'
  | 'investments'
  | 'bills'
  | 'prices'
  | 'finalizing'
  | 'verifying';

export type MnyJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface MnyPreviewAccount {
  key: string;
  handle: number | null;
  name: string;
  moneyName: string;
  accountType: AccountType;
  accountSubType: 'INVESTMENT_CASH' | 'INVESTMENT_BROKERAGE' | null;
  currencyCode: string;
  transactionCount: number;
  /** Investment rows this account will receive; 0 outside a brokerage side. */
  investmentCount: number;
  openingBalance: number;
  finalBalance: number;
  closed: boolean;
  favourite: boolean;
  /**
   * True for Money's watch accounts, which import excluded from net worth.
   * Optional so a response from a backend predating the field reads as
   * "no information" rather than crashing; absent draws no badge.
   */
  excludeFromNetWorth?: boolean;
}

export type MnyFrequency =
  | 'ONCE'
  | 'DAILY'
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'EVERY4WEEKS'
  | 'SEMIMONTHLY'
  | 'MONTHLY'
  | 'EVERY2MONTHS'
  | 'QUARTERLY'
  | 'EVERY4MONTHS'
  | 'SEMIANNUAL'
  | 'YEARLY'
  | 'EVERY2YEARS';

/** One detected-active bill in the review step's checkbox list. */
export interface MnyPreviewBill {
  /** Representative `BILL.hbill` -- what `options.bills` carries. */
  handle: number;
  name: string;
  accountName: string;
  amount: number;
  currencyCode: string;
  frequency: MnyFrequency;
  /** True when the Money interval had no exact Monize frequency. */
  approximate: boolean;
  nextDueDate: string;
  isTransfer: boolean;
  isInvestment: boolean;
  splitCount: number;
  /** Raw `BILL.st`, surfaced for diagnosing real files. */
  status: number;
}

export interface MnyPreviewCounts {
  accountsIncluded: number;
  accountsInFile: number;
  payeesToCreate: number;
  payeesInFile: number;
  categoriesToCreate: number;
  categoriesInFile: number;
  /** Tags Money's classification items become; referenced items only. */
  tagsToCreate: number;
  /** Classification items in the file; 0 when it has no classifications. */
  tagsInFile: number;
  transactionsToCreate: number;
  transfersToLink: number;
  transactionsSkipped: number;
  securitiesToCreate: number;
  securitiesInFile: number;
  investmentsToCreate: number;
  investmentsSkipped: number;
  shareTransfersPaired: number;
  pricesToImport: number;
  exchangeRatesToImport: number;
  /** Detected-active bill series offered in the checkbox list. */
  billsDetected: number;
  /** Bill series the mapper could not use -- not unticked ones. */
  billsSkipped: number;
}

export interface MnyFileCounts {
  accounts: number;
  payees: number;
  categories: number;
  securities: number;
  securityPrices: number;
  exchangeRates: number;
  bills: number;
  transactions: number;
}

/**
 * One transaction a warning flagged, with enough of Money's own detail -- date,
 * account, payee, amount, cheque number -- for the user to find it in Money and
 * fix it there before importing.
 */
export interface MnyFlaggedRow {
  /** `TRN.htrn`. Shown only when nothing else identifies the row. */
  handle: number;
  accountName: string | null;
  date: string | null;
  amount: number | null;
  currencyCode: string | null;
  payeeName: string | null;
  reference: string | null;
  memo: string | null;
  /** This occurrence's specifics, e.g. `legs 1832.07 vs total 1750.44`. */
  detail: string | null;
}

export interface MnyWarningSummary {
  code: string;
  count: number;
  samples: string[];
  /**
   * The flagged transactions, capped server-side. Empty for warnings that are
   * not about a transaction, and absent on a report from an older backend.
   */
  rows?: MnyFlaggedRow[];
  /** True when this code flagged more transactions than `rows` carries. */
  rowsTruncated?: boolean;
}

export interface MnyImportOptions {
  wipeExistingData: boolean;
  referencedOnlyPayees: boolean;
  referencedOnlyCategories: boolean;
  importClosedAccounts: boolean;
  importPrices: boolean;
  importExchangeRates: boolean;
  accounts: Array<{
    handle: number;
    include: boolean;
    currencyOverride: string | null;
  }>;
  bills: number[];
}

/** Container facts of a KMyMoney file; mirrors the backend `KmyFileSummary`. */
export interface KmyFileSummary {
  container: 'gzip' | 'xml';
  /** Decoded FIXVERSION; 12 is current. */
  fixVersion: number;
  appVersion: string | null;
  lastModified: string | null;
}

export interface MnyPreview {
  stagedFileId: string;
  filename: string;
  sizeBytes: number;
  era: MnyEra;
  passwordProtected: boolean;
  baseCurrency: string;
  accounts: MnyPreviewAccount[];
  /** Detected-active bills; empty when the file has none or has no BILL table. */
  bills: MnyPreviewBill[];
  counts: MnyPreviewCounts;
  fileCounts: MnyFileCounts;
  missingTables: string[];
  missingFields: string[];
  warnings: MnyWarningSummary[];
  options: MnyImportOptions;
  /** Set only for a KMyMoney file; absent means a Money file. */
  sourceFormat?: 'kmy';
  kmyFile?: KmyFileSummary;
}

export interface MnyAccountVerification {
  accountName: string;
  /** So a delta on a loan or mortgage can be called out as such. */
  accountType: string;
  accountId: string | null;
  expectedBalance: number;
  importedBalance: number;
  delta: number;
  transactionCount: number;
  matches: boolean;
  /** KMyMoney only: what the import's own rows sum to; `expectedBalance` is then the file's figure. */
  mappedBalance?: number;
}

export interface MnyHoldingVerification {
  accountName: string;
  symbol: string;
  /** Shares Money's open tax lots claim -- the authoritative reading. */
  lotQuantity: number;
  /** Shares replaying the mapped investment actions produces. */
  replayQuantity: number;
  /** Shares Monize holds after the import. */
  importedQuantity: number;
  /** `importedQuantity - lotQuantity`. */
  delta: number;
  matches: boolean;
}

export interface MnyImportResult {
  accountsCreated: number;
  payeesCreated: number;
  categoriesCreated: number;
  /** Tags created for Money's classification items; a reused tag is not counted. */
  tagsCreated: number;
  /** Tag links written onto transactions and split legs, new tags or reused. */
  tagLinksApplied: number;
  transactionsCreated: number;
  splitsCreated: number;
  transfersLinked: number;
  securitiesCreated: number;
  investmentTransactionsCreated: number;
  /**
   * Imported share acquisitions of a bond-program security stored without a
   * series (the file names none and none was on sale on the date): the bond
   * lots report such a row until its series is chosen. Absent when zero.
   */
  bondRowsWithoutSeries?: number;
  pricesImported: number;
  exchangeRatesImported: number;
  billsCreated: number;
  skipped: {
    accounts: number;
    payees: number;
    categories: number;
    /** Classification items no imported row references. */
    tags: number;
    transactions: number;
    /** Bill series with no usable template or date -- not unticked ones. */
    bills: number;
  };
  existingDataRemoved: boolean;
  verification: MnyAccountVerification[];
  /** Empty when the file has no `LOT` table or the import created no holdings. */
  holdings: MnyHoldingVerification[];
  warnings: MnyWarningSummary[];
}

export interface MnyImportJob {
  id: string;
  status: MnyJobStatus;
  progress: {
    phase: MnyImportPhase;
    processed: number;
    total: number;
  } | null;
  result: MnyImportResult | null;
  errorKey: string | null;
  retryable: boolean;
  /**
   * True once the import's rows reached the ledger, so a failure after it is
   * not "nothing saved" and the file must not be imported again. Absent on an
   * older backend: no information, so read it as `=== true`.
   */
  dataCommitted?: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

/** Options the wizard sends; every field is optional and server-defaulted. */
export type MnyImportOptionsInput = Partial<
  Omit<MnyImportOptions, 'accounts' | 'bills'>
> & {
  accounts?: MnyImportOptions['accounts'];
  bills?: number[];
};

export const mnyImportApi = {
  /**
   * Uploads the file, decrypts and previews it, and stages it for import.
   * The password is sent only on this call and is never stored server-side.
   */
  parse: async (file: File, password?: string): Promise<MnyPreview> => {
    const formData = new FormData();
    formData.append('file', file);
    if (password) {
      formData.append('password', password);
    }
    const response = await apiClient.post<MnyPreview>(
      '/import/mny/parse',
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: PARSE_TIMEOUT_MS,
      },
    );
    return response.data;
  },

  start: async (
    stagedFileId: string,
    options?: MnyImportOptionsInput,
    wipeCredentials?: { password?: string; oidcIdToken?: string },
  ): Promise<MnyImportJob> => {
    const response = await apiClient.post<MnyImportJob>(
      '/import/mny/start',
      {
        stagedFileId,
        ...(options ? { options } : {}),
        ...(wipeCredentials?.password
          ? { wipePassword: wipeCredentials.password }
          : {}),
        ...(wipeCredentials?.oidcIdToken
          ? { wipeOidcIdToken: wipeCredentials.oidcIdToken }
          : {}),
      },
      { timeout: START_TIMEOUT_MS },
    );
    return response.data;
  },

  getJob: async (id: string): Promise<MnyImportJob> => {
    const response = await apiClient.get<MnyImportJob>(
      `/import/mny/jobs/${id}`,
      { timeout: POLL_TIMEOUT_MS },
    );
    // The import runs server-side after `start` returns, so the write lands
    // here rather than at a mutation call. A failed job can still have written
    // rows before it stopped, so both terminal states invalidate. An MNY import
    // writes accounts, categories, payees, tags, securities and schedules, and a
    // wipe deletes them, so no prefix is narrow enough.
    if (response.data.status === 'completed' || response.data.status === 'failed') {
      clearAllCache();
    }
    return response.data;
  },

  discardStagedFile: async (id: string): Promise<void> => {
    await apiClient.delete(`/import/mny/staged/${id}`);
  },
};
