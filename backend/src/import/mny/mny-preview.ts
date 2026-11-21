import {
  AccountSubType,
  AccountType,
} from "../../accounts/entities/account.entity";
import { FrequencyType } from "../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { MnyImportOptions } from "./model/mny-import-options";
import type { MnyNameFixes } from "./model/mny-import-model";
import type { KmyFileSummary } from "./model/import-source";
import {
  MnyWarningSummary,
  summarizeWarnings,
  warningLookup,
} from "./model/mny-warnings";
import { MnyEra, MnyFileCounts, MnyParsedFile } from "./mny-parser.service";

/**
 * What the wizard's review step gets: summaries only, never row data.
 *
 * A 200 MB file with 37,000 transactions must produce a preview measured in
 * kilobytes, because it travels through the Next proxy and is re-fetched on every
 * step change. Everything here is JSON-safe and free of English copy -- eras,
 * warning codes and account types are localized by the frontend.
 */

export interface MnyPreviewAccount {
  /** Import-local key; the wizard sends per-account options keyed by `handle`. */
  readonly key: string;
  /** `ACCT.hacct`, or null for the cash side Monize adds to an investment pair. */
  readonly handle: number | null;
  readonly name: string;
  /** Name as Money recorded it, so a renamed account is visible as such. */
  readonly moneyName: string;
  readonly accountType: AccountType;
  readonly accountSubType: AccountSubType | null;
  readonly currencyCode: string;
  readonly transactionCount: number;
  /** Investment rows this account will receive; 0 outside a brokerage side. */
  readonly investmentCount: number;
  readonly openingBalance: number;
  /** Final balance computed from the file -- the verification baseline. */
  readonly finalBalance: number;
  readonly closed: boolean;
  readonly favourite: boolean;
  /** True for Money's watch accounts, which import excluded from net worth. */
  readonly excludeFromNetWorth: boolean;
}

/**
 * One detected-active bill in the wizard's checkbox list. Selection travels
 * back as `options.bills` (the `handle` values the user kept ticked).
 */
export interface MnyPreviewBill {
  /** Representative `BILL.hbill` -- the selection key. */
  readonly handle: number;
  readonly name: string;
  /** Monize name of the account the bill posts from. */
  readonly accountName: string;
  readonly amount: number;
  readonly currencyCode: string;
  readonly frequency: FrequencyType;
  /** True when the Money interval had no exact Monize frequency. */
  readonly approximate: boolean;
  readonly nextDueDate: string;
  readonly isTransfer: boolean;
  readonly isInvestment: boolean;
  readonly splitCount: number;
  /** Raw `BILL.st`, surfaced for real-file diagnosis (open question 12.3). */
  readonly status: number;
}

export interface MnyPreviewCounts {
  readonly accountsIncluded: number;
  readonly accountsInFile: number;
  readonly payeesToCreate: number;
  readonly payeesInFile: number;
  readonly categoriesToCreate: number;
  readonly categoriesInFile: number;
  /** Tags Money's classification items become; referenced items only. */
  readonly tagsToCreate: number;
  /** Classification items the file defines. 0 for a file with no classifications. */
  readonly tagsInFile: number;
  readonly transactionsToCreate: number;
  readonly transfersToLink: number;
  readonly transactionsSkipped: number;
  readonly securitiesToCreate: number;
  /** Real securities in the file, currency pseudo-securities excluded. */
  readonly securitiesInFile: number;
  readonly investmentsToCreate: number;
  readonly investmentsSkipped: number;
  /** `act` 15/16 rows matched into linked TRANSFER_IN / TRANSFER_OUT pairs. */
  readonly shareTransfersPaired: number;
  /** Price rows after the `(security, date)` dedupe; 0 when the toggle is off. */
  readonly pricesToImport: number;
  /** Exchange-rate rows; 0 when the toggle is off. */
  readonly exchangeRatesToImport: number;
  /** Detected-active bill series offered in the checkbox list. */
  readonly billsDetected: number;
  /** Bill series the mapper could not use (no template, no usable date). */
  readonly billsSkipped: number;
  /** Payee aliases the KMyMoney rules become; set only for a KMyMoney file. */
  readonly payeeAliasesToCreate?: number;
  /** Payees that get a default category; set only for a KMyMoney file. */
  readonly payeeDefaultCategoriesToSet?: number;
}

export interface MnyPreview {
  /** Staged file the import will read. Empty until the controller fills it in. */
  readonly stagedFileId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly era: MnyEra;
  readonly passwordProtected: boolean;
  readonly baseCurrency: string;
  readonly accounts: readonly MnyPreviewAccount[];
  /**
   * Detected-active bills for the wizard's checkbox list. Empty both when the
   * file has none and when this Money version predates the `BILL` table --
   * `missingTables` tells those apart.
   */
  readonly bills: readonly MnyPreviewBill[];
  readonly counts: MnyPreviewCounts;
  /** Raw file counts, including the things Phase 1 does not import yet. */
  readonly fileCounts: MnyFileCounts;
  /** Tables this Money version does not have, e.g. `BILL` on a 2001 file. */
  readonly missingTables: readonly string[];
  /** Fields that fell back to a default because no source column existed. */
  readonly missingFields: readonly string[];
  readonly warnings: readonly MnyWarningSummary[];
  /** The option set the import will use, with server-computed defaults filled. */
  readonly options: MnyImportOptions;
  /** Set only for a KMyMoney file; absent means a Money file. */
  readonly sourceFormat?: "kmy";
  /** Set only for a KMyMoney file. */
  readonly kmyFile?: KmyFileSummary;
  /**
   * Names too long for their column, which the wizard offers to rename; the
   * names the import would use are in `options.renames`. Set only for a
   * KMyMoney file.
   */
  readonly nameFixes?: MnyNameFixes;
}

export interface BuildPreviewInput {
  readonly parsed: MnyParsedFile;
  readonly stagedFileId: string;
  readonly filename: string;
  readonly sizeBytes: number;
}

export function buildPreview(input: BuildPreviewInput): MnyPreview {
  const { parsed } = input;

  const accountNameByKey = new Map(
    parsed.accounts.accounts.map((account) => [account.key, account.name]),
  );
  const bills: MnyPreviewBill[] = parsed.bills.bills.map((bill) => ({
    handle: bill.handle,
    name: bill.name,
    accountName: accountNameByKey.get(bill.accountKey) ?? bill.accountKey,
    amount: bill.amount,
    currencyCode: bill.currencyCode,
    frequency: bill.frequency,
    approximate: bill.approximate,
    nextDueDate: bill.nextDueDate,
    isTransfer: bill.isTransfer,
    isInvestment: bill.investment !== null,
    splitCount: bill.splits.length,
    status: bill.status,
  }));

  const accounts: MnyPreviewAccount[] = parsed.accounts.accounts.map(
    (account) => ({
      key: account.key,
      handle: account.handle,
      name: account.name,
      moneyName: account.moneyName,
      accountType: account.accountType,
      accountSubType: account.accountSubType,
      currencyCode: account.currencyCode,
      transactionCount: parsed.transactionCounts.get(account.key) ?? 0,
      investmentCount: parsed.investmentCounts.get(account.key) ?? 0,
      openingBalance: account.openingBalance,
      finalBalance:
        (parsed.fileBalances ?? parsed.expectedBalances).get(account.key) ?? 0,
      closed: account.closed,
      favourite: account.favourite,
      excludeFromNetWorth: account.excludeFromNetWorth,
    }),
  );

  return {
    stagedFileId: input.stagedFileId,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    era: parsed.era,
    passwordProtected: parsed.passwordProtected,
    baseCurrency: parsed.baseCurrency,
    accounts,
    bills,
    counts: {
      accountsIncluded: accounts.length,
      accountsInFile: parsed.fileCounts.accounts,
      payeesToCreate: parsed.payees.payees.length,
      payeesInFile: parsed.fileCounts.payees,
      categoriesToCreate: parsed.categories.categories.length,
      categoriesInFile: parsed.fileCounts.categories,
      tagsToCreate: parsed.tags.tags.length,
      tagsInFile: parsed.tags.inFile,
      transactionsToCreate: parsed.transactions.transactions.length,
      transfersToLink: parsed.transactions.transfersLinked,
      transactionsSkipped: parsed.transactions.skipped,
      securitiesToCreate: parsed.securities.securities.length,
      securitiesInFile: parsed.fileCounts.securities,
      investmentsToCreate: parsed.investments.transactions.length,
      investmentsSkipped: parsed.investments.skipped,
      shareTransfersPaired: parsed.investments.transfersPaired,
      pricesToImport: parsed.options.importPrices
        ? parsed.fileCounts.securityPrices
        : 0,
      exchangeRatesToImport: parsed.options.importExchangeRates
        ? parsed.fileCounts.exchangeRates
        : 0,
      billsDetected: parsed.bills.bills.length,
      billsSkipped: parsed.bills.skipped,
      ...(parsed.sourceFormat === "kmy"
        ? {
            payeeAliasesToCreate: parsed.payees.payees.reduce(
              (total, payee) => total + (payee.aliases?.length ?? 0),
              0,
            ),
            payeeDefaultCategoriesToSet: parsed.payees.payees.filter(
              (payee) => (payee.defaultCategoryHandle ?? null) !== null,
            ).length,
          }
        : {}),
    },
    fileCounts: parsed.fileCounts,
    missingTables: parsed.missingTables,
    missingFields: parsed.missingFields,
    warnings: summarizeWarnings(
      parsed.warnings,
      warningLookup({
        accounts: parsed.accounts.accounts,
        payeeNameByHandle: parsed.payees.nameByHandle,
      }),
    ),
    options: parsed.options,
    ...(parsed.sourceFormat === "kmy" ? { sourceFormat: "kmy" as const } : {}),
    ...(parsed.kmyFile !== undefined ? { kmyFile: parsed.kmyFile } : {}),
    ...(parsed.nameFixes !== undefined ? { nameFixes: parsed.nameFixes } : {}),
  };
}
