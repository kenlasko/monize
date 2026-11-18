import { createBinaryImportClient } from './import-binary-client';
import { AccountType } from '@/types/account';

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
  /** Payee aliases a KMyMoney file's matching rules become; absent for Money. */
  payeeAliasesToCreate?: number;
  /** Payees that get a default category from a KMyMoney file; absent for Money. */
  payeeDefaultCategoriesToSet?: number;
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
  /** Payee aliases written; absent for a Money import. */
  payeeAliasesCreated?: number;
  /** Payees given a default category; absent for a Money import. */
  payeeDefaultCategoriesSet?: number;
  /** Payees given contact details; absent for a Money import. */
  payeeContactDetailsSet?: number;
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

/**
 * The calls the wizard makes to a binary-file import backend. Microsoft Money
 * and KMyMoney share the whole job machinery, so one hook drives either client;
 * see `createBinaryImportClient` for what each call does and why its timeout is
 * what it is.
 */
export interface BinaryImportClient {
  /**
   * Uploads the file, reads and previews it, and stages it for import. A
   * password is sent only on this call and is never stored server-side; only
   * the Money client uses one.
   */
  parse: (file: File, password?: string) => Promise<MnyPreview>;
  start: (
    stagedFileId: string,
    options?: MnyImportOptionsInput,
    wipeCredentials?: { password?: string; oidcIdToken?: string },
  ) => Promise<MnyImportJob>;
  getJob: (id: string) => Promise<MnyImportJob>;
  discardStagedFile: (id: string) => Promise<void>;
}

/** Client for the Microsoft Money (`.mny`) import endpoints. */
export const mnyImportApi: BinaryImportClient =
  createBinaryImportClient('/import/mny');
