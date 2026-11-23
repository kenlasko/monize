import { Injectable, Logger } from "@nestjs/common";
import type { ImportSourceFormat, KmyFileSummary } from "./model/import-source";
import {
  MnyDatabase,
  openDecryptedMnyFile,
  openMnyFile,
} from "./msisam/open-mny";
import {
  MnyTables,
  missingFields,
  missingTables,
  readMnyTables,
} from "./tables/read-mny-tables";
import {
  cashKeyByAccountKey,
  currencyCodesByHandle,
  mapAccounts,
  mapCategories,
  mapPayees,
} from "./map/map-reference";
import { mapTransactions } from "./map/map-transactions";
import { mapClassificationTags } from "./map/map-classifications";
import { mapSecurities, tradedSecurityHandles } from "./map/map-securities";
import { mapInvestments } from "./map/map-investments";
import { resolveExchangeRates } from "./writers/write-prices";
import {
  adoptCashLegTags,
  applyInvestmentCashSources,
  investmentWritesOwnCashRow,
  reconcileEmbeddedAccruedInterest,
  referencedTradeTags,
  tradesByHandle,
} from "./map/investment-cash";
import { billReferences, mapBills, selectedBills } from "./map/map-bills";
import { mapLoans } from "./map/map-loans";
import { crossCheckHoldings } from "./map/check-holdings";
import { MONEY99_ABSENT_FIELDS } from "./model/mny-money99";
import {
  MappedAccounts,
  MappedBills,
  MappedLoans,
  MappedCategories,
  MappedInvestments,
  MappedPayees,
  MappedSecurities,
  MappedTags,
  MappedTransactions,
  MnyHoldingCheck,
  MnyMarketRates,
  MnyNameFixes,
} from "./model/mny-import-model";
import {
  MnyImportOptions,
  resolveImportOptions,
} from "./model/mny-import-options";
import { MnyWarning } from "./model/mny-warnings";
import { MnyExchangeRate, MnySecurityPrice } from "./model/mny-rows";
import {
  isClassificationItem,
  isCurrencyPseudoSecurity,
} from "./model/mny-model";
import { TransactionStatus } from "../../transactions/entities/transaction.entity";
import {
  FIAT_MONEY_DECIMALS,
  fromScaledUnits,
  toScaledUnits,
} from "../../common/round.util";

/**
 * Decrypt -> read -> map, in one place.
 *
 * Called twice per import, on purpose: once for the wizard's preview and again
 * by the background job over the same staged bytes (design ADR-2). Parsing is
 * deterministic, so there is no serialized intermediate representation that can
 * drift from what the preview promised -- and the balances the preview shows are
 * the same numbers the verification report reconciles against.
 *
 * Nothing here touches the database.
 */

/** Which Money era a file was written by, inferred from its table/column set. */
export type MnyEra =
  "money99" | "money2001" | "money2002" | "moneyPlus" | "unknown";

export interface MnyParseInput {
  /** Still-encrypted file bytes, unless `alreadyDecrypted`. Ownership passes to the parser. */
  readonly buffer: Buffer;
  /** Money file password, when the file needs one. Never logged, never stored. */
  readonly password?: string;
  /**
   * True when `buffer` came from staging, which stores the **decrypted** file
   * so the password is spent once and never persisted (ADR-2, ADR-7).
   *
   * Decryption is in place and RC4 is symmetric, so running it again over those
   * bytes re-encrypts them. That was live for three phases: every integration
   * test staged raw fixture bytes, so the job's decrypt was the only decrypt,
   * and only the wizard's real upload-then-import path ever hit it.
   */
  readonly alreadyDecrypted?: boolean;
  readonly options?: Partial<MnyImportOptions>;
  /** Used as the base currency only when the file names none. */
  readonly userDefaultCurrency: string;
  /**
   * Rates for the cross-currency trades the file cannot convert, looked up by
   * `MnyMarketRateService` from a first parse's `investments.rateGaps`. The
   * parser itself never fetches one.
   */
  readonly marketRates?: MnyMarketRates;
  /**
   * Balance cut-off, `YYYY-MM-DD`. Future-dated transactions are excluded from
   * expected balances because Monize's own balance recalculation excludes them;
   * comparing against a total that included them would report a discrepancy on
   * every account holding a post-dated cheque.
   */
  readonly asOf?: string;
}

export interface MnyParsedFile {
  readonly era: MnyEra;
  readonly passwordProtected: boolean;
  readonly options: MnyImportOptions;
  readonly baseCurrency: string;
  /**
   * Every ISO code the import touches -- accounts, securities and exchange-rate
   * history -- so `ensureCurrencyForUser` runs once per code before any row that
   * references it is written.
   */
  readonly currencyCodes: readonly string[];
  readonly accounts: MappedAccounts;
  readonly transactions: MappedTransactions;
  readonly categories: MappedCategories;
  readonly payees: MappedPayees;
  /** Money's classification items, as the tags imported rows carry. */
  readonly tags: MappedTags;
  readonly securities: MappedSecurities;
  readonly investments: MappedInvestments;
  /**
   * Detected-active bill candidates. `options.bills` holds the selected
   * handles: the server default is every candidate, an explicit list (possibly
   * empty) is the wizard's choice, and only selected bills are written.
   */
  readonly bills: MappedBills;
  /**
   * Loan and mortgage terms inferred from the payments and bills that were
   * imported. Empty when the file has no loan accounts.
   */
  readonly loans: MappedLoans;
  /**
   * `SP` and `CRNC_EXCHG` rows, and the currency handle map, passed straight
   * through to the price and rate writers. These two tables are the largest
   * thing a real file carries (68,000 price rows in the maintainer's Money Plus
   * file) and there is nothing to map -- deduping and resolving handles happens
   * in the writer, so no second copy of them is materialized here.
   */
  readonly rawPrices: readonly MnySecurityPrice[];
  readonly rawExchangeRates: readonly MnyExchangeRate[];
  readonly currencyByHandle: ReadonlyMap<number, string>;
  /** Open-lot positions versus the action replay; empty when the file has no `LOT`. */
  readonly holdingChecks: readonly MnyHoldingCheck[];
  /** Account key -> final balance computed from the file itself. */
  readonly expectedBalances: ReadonlyMap<string, number>;
  /** Account key -> number of transactions this import will create. */
  readonly transactionCounts: ReadonlyMap<string, number>;
  /** Brokerage account key -> number of investment rows this import will create. */
  readonly investmentCounts: ReadonlyMap<string, number>;
  /** Raw file counts for the things Phase 1 does not import yet. */
  readonly fileCounts: MnyFileCounts;
  readonly missingTables: readonly string[];
  readonly missingFields: readonly string[];
  readonly warnings: readonly MnyWarning[];
  /** Absent means a Money file ("mny"). */
  readonly sourceFormat?: ImportSourceFormat;
  /**
   * Account key -> the file's own final balance (KMyMoney). Absent means
   * `expectedBalances` is the file's figure.
   */
  readonly fileBalances?: ReadonlyMap<string, number>;
  /**
   * Account key -> the places its balance is compared at and the exact
   * allowance per-row rounding at those places accounts for (KMyMoney). Absent
   * means the Money comparison: four places within `BALANCE_TOLERANCE`.
   */
  readonly balancePrecision?: ReadonlyMap<string, MnyBalancePrecision>;
  /**
   * Currency code -> the places its amounts are written at (KMyMoney, where a
   * coin keeps up to eight). Absent means every writer rounds at four.
   */
  readonly moneyPlaces?: ReadonlyMap<string, number>;
  /** KMyMoney container facts; absent for a Money file. */
  readonly kmyFile?: KmyFileSummary;
  /** Names too long for their column (KMyMoney); absent for a Money file. */
  readonly nameFixes?: MnyNameFixes;
}

export interface MnyBalancePrecision {
  readonly places: number;
  /** The largest |imported - file| that rounding each row at `places` explains. */
  readonly tolerance: number;
}

export interface MnyFileCounts {
  readonly accounts: number;
  readonly payees: number;
  readonly categories: number;
  /** Excludes Money's currency pseudo-securities. */
  readonly securities: number;
  readonly securityPrices: number;
  readonly exchangeRates: number;
  readonly bills: number;
  readonly transactions: number;
}

/** Today in the local calendar, as the repository's `YYYY-MM-DD` DATE strings. */
export function todayIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Which Money release wrote this file, from what the reader could resolve.
 *
 * Money 97-99 write a Jet 3 file, Money Plus renamed `TRN.hpay` to `lHpay`,
 * and `BILL` did not exist before Money 2002. Those three facts separate the
 * four vintages the fixtures cover.
 */
export function detectEra(tables: MnyTables, db: MnyDatabase): MnyEra {
  const transactionTable = tables.availability.find(
    (entry) => entry.table === "TRN",
  );
  if (!transactionTable?.present) {
    return "unknown";
  }
  if (db.format === "jet3") {
    return "money99";
  }
  if (transactionTable.resolvedColumns.payee === "lHpay") {
    return "moneyPlus";
  }
  return db.hasTable("BILL") ? "money2002" : "money2001";
}

/**
 * Per-account final balances, computed from the file the same way Monize
 * computes `current_balance`: opening balance plus every non-void transaction
 * dated on or before the cut-off. This is the verification report's baseline, so
 * it must mirror `postImportProcessing`'s query exactly rather than being a
 * second, subtly different definition of "balance".
 */
export function computeExpectedBalances(
  accounts: MappedAccounts,
  transactions: MappedTransactions,
  asOf: string,
  investments?: MappedInvestments,
  /**
   * Account key -> the decimal places its amounts are kept at. A source whose
   * accounts can be coins (KMyMoney) passes it; absent, every account sums at
   * the fiat four places, which is the Money behaviour.
   */
  placesByKey?: ReadonlyMap<string, number>,
): Map<string, number> {
  const placesOf = (key: string): number =>
    placesByKey?.get(key) ?? FIAT_MONEY_DECIMALS;
  // Each amount shifted on its decimal digits, never `Math.round(x * 10 **
  // places)`, which misreads a large amount (Discussion #2343).
  const unitsOf = (key: string, amount: number): bigint =>
    toScaledUnits(amount, placesOf(key));
  const totals = new Map<string, bigint>(
    accounts.accounts.map((account) => [
      account.key,
      unitsOf(account.key, account.openingBalance),
    ]),
  );

  // Integer minor units throughout, in a BigInt: 37,000 float additions drift,
  // and a coin's eight places pass 2^53 above 90 million.
  const add = (key: string | null, amount: number, date: string): void => {
    if (key === null || date > asOf) {
      return;
    }
    const current = totals.get(key);
    if (current === undefined) {
      return;
    }
    totals.set(key, current + unitsOf(key, amount));
  };

  for (const transaction of transactions.transactions) {
    if (transaction.status === TransactionStatus.VOID) {
      continue;
    }
    add(
      transaction.accountKey,
      transaction.amount,
      transaction.transactionDate,
    );
  }

  // An investment's cash leg lands in the sleeve, so the sleeve's expected
  // balance has to know about it or every brokerage cash account reports a
  // discrepancy the size of its trading history. Only the legs the investment
  // writer creates: a trade whose cash a banking row already records was
  // counted above, from that row, and adding it again would double it.
  for (const investment of investments?.transactions ?? []) {
    if (
      investment.status === TransactionStatus.VOID ||
      !investmentWritesOwnCashRow(investment)
    ) {
      continue;
    }
    add(
      investment.cashAccountKey,
      investment.cashAmount,
      investment.transactionDate,
    );
  }

  return new Map(
    [...totals].map(([key, minorUnits]) => [
      key,
      fromScaledUnits(minorUnits, placesOf(key)),
    ]),
  );
}

function countTransactionsByAccount(
  transactions: MappedTransactions,
  investments: MappedInvestments,
): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string | null): void => {
    if (key !== null) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  };

  for (const transaction of transactions.transactions) {
    bump(transaction.accountKey);
  }
  // The cash leg is a row in the sleeve like any other, so it counts there --
  // when the investment writer is the one creating it. An adopted funding row
  // or an embedded split leg was already counted with its own transaction.
  for (const investment of investments.transactions) {
    if (investmentWritesOwnCashRow(investment)) {
      bump(investment.cashAccountKey);
    }
  }

  return counts;
}

function countInvestmentsByAccount(
  investments: MappedInvestments,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const investment of investments.transactions) {
    counts.set(
      investment.accountKey,
      (counts.get(investment.accountKey) ?? 0) + 1,
    );
  }
  return counts;
}

/** Union of two referenced-handle sets, for the referenced-only filters. */
function union(
  first: ReadonlySet<number>,
  second: ReadonlySet<number>,
): Set<number> {
  return new Set([...first, ...second]);
}

/**
 * Every currency the import will reference.
 *
 * `exchange_rates` has a foreign key to `currencies` on both sides, so a rate
 * between two currencies no account happens to use still needs both codes to
 * exist -- and a security can be denominated in a currency none of the accounts
 * are. Rate currencies are only collected when rates are actually being
 * imported, so unticking that box does not create currencies for nothing.
 */
function importedCurrencyCodes(
  accounts: MappedAccounts,
  securities: MappedSecurities,
  tables: MnyTables,
  currencyByHandle: ReadonlyMap<number, string>,
  options: MnyImportOptions,
): string[] {
  const codes = new Set<string>([
    ...accounts.currencyCodes,
    ...securities.securities.map((security) => security.currencyCode),
  ]);

  if (options.importExchangeRates) {
    for (const rate of tables.reference.exchangeRates) {
      for (const handle of [rate.fromCurrency, rate.toCurrency]) {
        const code = handle === null ? undefined : currencyByHandle.get(handle);
        if (code) {
          codes.add(code);
        }
      }
    }
  }

  return [...codes];
}

function fileCounts(tables: MnyTables): MnyFileCounts {
  return {
    accounts: tables.reference.accounts.length,
    payees: tables.reference.payees.length,
    // Money's two structural roots are not categories, and neither are the
    // items of a classification, which share the table.
    categories: tables.reference.categories.filter(
      (category) => category.level > 0 && !isClassificationItem(category),
    ).length,
    securities: tables.investments.securities.filter(
      (security) => !isCurrencyPseudoSecurity(security.symbol),
    ).length,
    securityPrices: tables.investments.prices.length,
    exchangeRates: tables.reference.exchangeRates.length,
    bills: tables.bills.bills.length,
    transactions: tables.transactions.transactions.length,
  };
}

@Injectable()
export class MnyParserService {
  private readonly logger = new Logger(MnyParserService.name);

  /**
   * Parses a Money file into the import model.
   *
   * @throws MnyImportError subclasses -- truncated, not a Money file, Jet 3,
   *   password required, password incorrect, unreadable
   */
  parse(input: MnyParseInput): MnyParsedFile {
    const options = resolveImportOptions(input.options);
    const db = input.alreadyDecrypted
      ? openDecryptedMnyFile(input.buffer)
      : openMnyFile(input.buffer, input.password);
    const tables = readMnyTables(db);
    const era = detectEra(tables, db);

    const accounts = mapAccounts(
      tables.reference,
      options,
      input.userDefaultCurrency,
    );
    const currencyByHandle = currencyCodesByHandle(tables.reference);
    const securities = mapSecurities({
      securities: tables.investments.securities,
      currencyByHandle,
      baseCurrency: accounts.baseCurrency,
      activeHandles: tradedSecurityHandles(
        tables.transactions.transactions,
        tables.investments.lots,
      ),
    });
    // Investments first, then banking, then the cash sources banking found fed
    // back into the trades. A banking row Money paired with a trade is that
    // trade's cash side, so the transaction mapper has to know which trades
    // this import actually writes before it can decide what the row is -- and
    // the trade cannot know which row it adopted until that decision is made.
    // Neither mapper can answer alone; the loop is closed by running them in
    // this order rather than by either guessing.
    const mappedInvestments = mapInvestments({
      transactions: tables.transactions,
      investments: tables.investments,
      accounts,
      securities,
      bills: tables.bills.bills,
      exchangeRates: resolveExchangeRates(
        tables.reference.exchangeRates,
        currencyByHandle,
      ),
      marketRates: input.marketRates,
    });
    const transactions = mapTransactions({
      transactions: tables.transactions,
      accountKeyByHandle: accounts.keyByHandle,
      currencyByHandle: accounts.currencyByHandle,
      bills: tables.bills.bills,
      cashKeyByAccountKey: cashKeyByAccountKey(accounts),
      tradesByHandle: tradesByHandle(mappedInvestments),
    });
    const investments = adoptCashLegTags(
      reconcileEmbeddedAccruedInterest(
        applyInvestmentCashSources(
          mappedInvestments,
          transactions.investmentCashSources,
        ),
      ),
      transactions.tradeCashLegTagHandles,
    );
    const holdings = crossCheckHoldings({
      transactions: investments.transactions,
      lots: tables.investments.lots,
      accounts,
      securities,
    });

    const asOf = input.asOf ?? todayIsoDate();
    const bills = mapBills({
      bills: tables.bills,
      transactions: tables.transactions,
      investments: tables.investments,
      accounts,
      securities,
      payees: tables.reference.payees,
      asOf,
    });
    // An absent `bills` option means "every detected-active candidate" -- the
    // server default the preview echoes. An explicit list, including an empty
    // one, is the wizard's selection and is only narrowed to real candidates.
    const candidateHandles = new Set(bills.bills.map((bill) => bill.handle));
    const selectedBillHandles =
      input.options?.bills === undefined
        ? [...candidateHandles]
        : options.bills.filter((handle) => candidateHandles.has(handle));
    const resolvedOptions: MnyImportOptions = {
      ...options,
      bills: selectedBillHandles,
    };
    const billRefs = billReferences(selectedBills(bills, selectedBillHandles));
    const loans = mapLoans({
      accounts,
      transactions,
      bills: selectedBills(bills, selectedBillHandles),
    });

    // Referenced-only filtering has to see every pipeline: a payee or category
    // only a dividend or a selected bill uses is still referenced.
    const categories = mapCategories(
      tables.reference,
      options.referencedOnlyCategories
        ? union(
            union(
              transactions.referencedCategories,
              investments.referencedCategories,
            ),
            billRefs.categories,
          )
        : null,
    );
    const payees = mapPayees(
      tables.reference.payees,
      options.referencedOnlyPayees
        ? union(
            union(transactions.referencedPayees, investments.referencedPayees),
            billRefs.payees,
          )
        : null,
    );
    // A classification is referenced by a banking row or split leg, by a
    // selected bill's template, or by a trade whose cash leg this import
    // writes itself (a trade funded from a banking row left the tag on that
    // row). Nothing else gets a tag, so there is no "all items" option: a
    // classification is a handful of values, not Money's seeded category tree.
    const tags = mapClassificationTags(
      tables.reference,
      union(
        union(transactions.referencedTags, referencedTradeTags(investments)),
        billRefs.tags,
      ),
    );

    const absentTables = missingTables(tables);
    const defaultedFields = missingFields(tables);

    this.logger.log(
      `Parsed ${era} file: ${accounts.accounts.length} accounts, ` +
        `${transactions.transactions.length} transactions, ` +
        `${securities.securities.length} securities, ` +
        `${investments.transactions.length} investment rows, ` +
        `${transactions.tradeCashLegs} cash rows written by their trade, ` +
        `${transactions.investmentCashSources.size} trades whose cash a banking row already records`,
    );

    return {
      era,
      passwordProtected: db.passwordProtected,
      options: resolvedOptions,
      baseCurrency: accounts.baseCurrency,
      currencyCodes: importedCurrencyCodes(
        accounts,
        securities,
        tables,
        currencyByHandle,
        options,
      ),
      accounts,
      transactions,
      categories,
      payees,
      tags,
      securities,
      investments,
      bills,
      loans,
      rawPrices: tables.investments.prices,
      rawExchangeRates: tables.reference.exchangeRates,
      currencyByHandle,
      holdingChecks: holdings.checks,
      expectedBalances: computeExpectedBalances(
        accounts,
        transactions,
        asOf,
        investments,
      ),
      transactionCounts: countTransactionsByAccount(transactions, investments),
      investmentCounts: countInvestmentsByAccount(investments),
      fileCounts: fileCounts(tables),
      missingTables: absentTables,
      missingFields: defaultedFields,
      warnings: [
        ...absentTables.map((table) => ({
          code: "missingTable" as const,
          subject: table,
        })),
        // A column Money 99 never had is not news to its user; the field list
        // above still names it for `mny:inspect`.
        ...defaultedFields
          .filter(
            (field) =>
              db.format !== "jet3" || !MONEY99_ABSENT_FIELDS.has(field),
          )
          .map((field) => ({
            code: "missingField" as const,
            subject: field,
          })),
        ...accounts.warnings,
        ...transactions.warnings,
        ...securities.warnings,
        ...investments.warnings,
        ...holdings.warnings,
        ...bills.warnings,
        ...loans.warnings,
        ...categories.warnings,
        ...payees.warnings,
        ...tags.warnings,
      ],
    };
  }
}
