import type { CountryCode } from "libphonenumber-js/max";
import { roundToDecimals } from "../../../common/round.util";
import { billReferences, selectedBills } from "../../mny/map/map-bills";
import { mapLoans } from "../../mny/map/map-loans";
import {
  MappedAccounts,
  MappedTransactions,
  MnyHoldingCheck,
} from "../../mny/model/mny-import-model";
import { QUANTITY_TOLERANCE } from "../../mny/model/mny-import-job";
import {
  MnyImportOptions,
  resolveImportOptions,
} from "../../mny/model/mny-import-options";
import {
  MnyParsedFile,
  computeExpectedBalances,
  todayIsoDate,
} from "../../mny/mny-parser.service";
import { KmyRawFile } from "../model/kmy-raw";
import { buildAccountTree } from "./kmy-account-tree";
import { QUANTITY_PLACES, amountPlaces } from "./kmy-amounts";
import { computeFileExpectationsSteps } from "./kmy-file-expectations";
import { applyKmyFileFixes } from "./kmy-file-fixes";
import {
  countByAccount,
  explainDifferences,
  fileCounts,
  mappedReplay,
  mappedTradeValues,
  readerWarnings,
  repeated,
  union,
} from "./kmy-file-summary";
import { mapKmyAccounts, withOpeningBalances } from "./kmy-map-accounts";
import { mapKmyCategories } from "./kmy-map-categories";
import { readKmyLoanTerms, withKmyLoanTerms } from "./kmy-loan-terms";
import { mapKmyInvestmentsSteps } from "./kmy-map-investments";
import {
  mapKmyPayees,
  mapKmyTags,
  payeeHandleById,
  tagHandleById,
  writtenPayees,
} from "./kmy-map-payees-tags";
import { resolvePayeeDefaults } from "./kmy-payee-details";
import { buildRateLookup, mapKmyPrices } from "./kmy-map-prices";
import { mapKmySchedules } from "./kmy-map-schedules";
import { mapKmySecurities } from "./kmy-map-securities";
import { mapKmyTransactionsSteps } from "./kmy-map-transactions";
import { Steps, runSteps, runStepsYielding } from "./kmy-steps";
import { foldOpeningBalances } from "./kmy-opening-balances";
import { KmyMapContext } from "./kmy-row-builder";

/**
 * Raw KMyMoney model to the shared import model (spec section 5), with the
 * file-computed expectations (6.1) and the two comparisons that explain a
 * difference before the import starts (6.3). Pure and synchronous: the same
 * raw model, options and `asOf` give the same handles, keys, names, amounts,
 * warnings and order (row UUIDs excepted).
 */

export interface KmyMapInput {
  readonly options?: Partial<MnyImportOptions>;
  readonly userDefaultCurrency: string;
  /** CRYPTO currency code -> its decimal places (`currencies.kind = 'CRYPTO'`). */
  readonly coinDecimals: ReadonlyMap<string, number>;
  /** Region a bare national payee phone number is read in; null names none (5.5.3). */
  readonly phoneRegion: CountryCode | null;
  /** YYYY-MM-DD. */
  readonly asOf: string;
}

export function mapKmyFile(
  file: KmyRawFile,
  input: KmyMapInput,
): MnyParsedFile {
  return runSteps(mapKmyFileSteps(file, input));
}

/**
 * `mapKmyFile` handing the event loop back as it goes (B2): the same steps,
 * driven by `runStepsYielding`, so a large file does not block every other
 * request while it maps. The parser service (preview and job) uses this one.
 */
export function mapKmyFileYielding(
  file: KmyRawFile,
  input: KmyMapInput,
): Promise<MnyParsedFile> {
  return runStepsYielding(mapKmyFileSteps(file, input));
}

function* mapKmyFileSteps(
  file: KmyRawFile,
  input: KmyMapInput,
): Steps<MnyParsedFile> {
  const options = resolveImportOptions(input.options);
  const asOf = input.asOf ?? todayIsoDate();
  const baseCurrency = file.baseCurrency?.trim() || input.userDefaultCurrency;
  // What KMyMoney shows once it has opened the file (spec 5.1).
  const raw = applyKmyFileFixes(file, baseCurrency);
  const tree = buildAccountTree(raw.accounts);

  const drafted = mapKmyAccounts({
    raw,
    tree,
    options,
    baseCurrency,
    coinDecimals: input.coinDecimals,
  });
  const opening = foldOpeningBalances(
    raw,
    tree,
    drafted,
    asOf,
    input.coinDecimals,
  );
  const mapping = {
    ...drafted,
    mapped: withOpeningBalances(drafted.mapped, opening.balances),
  };
  const accounts: MappedAccounts = mapping.mapped;

  const context: KmyMapContext = {
    raw,
    tree,
    mapping,
    coinDecimals: input.coinDecimals,
    payeeHandleById: payeeHandleById(raw),
    tagHandleById: tagHandleById(raw),
    rateLookup: buildRateLookup(raw),
  };

  const securities = mapKmySecurities({
    raw,
    tree,
    mapping,
    baseCurrency,
    coinDecimals: input.coinDecimals,
  });
  yield;
  const banking = yield* mapKmyTransactionsSteps(context, opening.folded);
  const trading = yield* mapKmyInvestmentsSteps(
    { ...context, securities },
    opening.folded,
  );
  const investments = trading.investments;
  const transactions: MappedTransactions = {
    ...banking.transactions,
    transactions: [...banking.transactions.transactions, ...trading.cashRows],
    referencedPayees: union(
      banking.transactions.referencedPayees,
      trading.cashReferences.payees,
    ),
    referencedCategories: union(
      banking.transactions.referencedCategories,
      trading.cashReferences.categories,
    ),
    referencedTags: union(
      banking.transactions.referencedTags,
      trading.cashReferences.tags,
    ),
  };

  yield;
  const bills = mapKmySchedules(context, asOf);
  const candidates = new Set(bills.bills.map((bill) => bill.handle));
  const selectedHandles =
    input.options?.bills === undefined
      ? [...candidates]
      : options.bills.filter((handle) => candidates.has(handle));
  const chosen = selectedBills(bills, selectedHandles);
  const billRefs = billReferences(chosen);
  const statedLoanTerms = readKmyLoanTerms({
    raw,
    mapping,
    coinDecimals: input.coinDecimals,
  });
  const loans = withKmyLoanTerms(
    mapLoans({ accounts, transactions, bills: chosen }),
    statedLoanTerms.terms,
  );

  const referencedPayees = options.referencedOnlyPayees
    ? union(
        transactions.referencedPayees,
        investments.referencedPayees,
        billRefs.payees,
      )
    : null;
  // A written payee's default category is a reference: its category (and the
  // ancestors) are written even under referencedOnlyCategories (5.5.2).
  const payeeDefaults = resolvePayeeDefaults(
    writtenPayees(raw, referencedPayees),
    raw.accounts,
  );
  const categories = mapKmyCategories({
    raw,
    tree,
    referenced: options.referencedOnlyCategories
      ? union(
          transactions.referencedCategories,
          investments.referencedCategories,
          billRefs.categories,
          payeeDefaults.categoryHandles,
        )
      : null,
    equityUsed: union(
      banking.equityUsed,
      trading.equityUsed,
      payeeDefaults.equityHandles,
    ),
  });
  const payees = mapKmyPayees(raw, referencedPayees, {
    defaults: payeeDefaults,
    phoneRegion: input.phoneRegion,
  });
  const tags = mapKmyTags(
    raw,
    union(transactions.referencedTags, billRefs.tags),
  );

  const usedCurrencies = new Set([
    ...accounts.currencyCodes,
    ...securities.securities.securities.map(
      (security) => security.currencyCode,
    ),
  ]);
  const prices = mapKmyPrices({ raw, securities, options, usedCurrencies });

  yield;
  const expectations = yield* computeFileExpectationsSteps({
    raw,
    tree,
    mapping,
    securities,
    coinDecimals: input.coinDecimals,
    asOf,
  });
  // Each account at its own currency's places: a coin keeps eight (M3).
  const placesByKey = new Map(
    [...expectations.balancePrecision].map(([key, rule]) => [key, rule.places]),
  );
  yield;
  const expectedBalances = computeExpectedBalances(
    accounts,
    transactions,
    asOf,
    investments,
    placesByKey,
  );

  yield;
  const replay = mappedReplay(investments, asOf);
  const checks: MnyHoldingCheck[] = expectations.holdings.map((holding) => {
    const replayQuantity = roundToDecimals(
      replay.get(`${holding.accountKey}|${holding.securityHandle}`) ?? 0,
      QUANTITY_PLACES,
    );
    const delta = roundToDecimals(
      replayQuantity - holding.quantity,
      QUANTITY_PLACES,
    );
    return {
      accountKey: holding.accountKey,
      securityHandle: holding.securityHandle,
      symbol: holding.symbol,
      lotQuantity: holding.quantity,
      replayQuantity,
      delta,
      matches: Math.abs(delta) <= QUANTITY_TOLERANCE,
    };
  });

  const comparisons = explainDifferences({
    accounts,
    expectations,
    expectedBalances,
    checks,
    mappedTrades: mappedTradeValues(
      investments,
      asOf,
      expectations.otherCurrencyTrades,
      (code) => amountPlaces(code, input.coinDecimals),
    ),
  });

  const costCenters = raw.transactions.reduce(
    (total, transaction) =>
      total + transaction.splits.filter((split) => split.costCenter).length,
    0,
  );
  const counts = countByAccount(transactions, investments);
  const rateCodes = new Set(prices.currencyByHandle.values());

  return {
    era: "unknown",
    passwordProtected: false,
    options: { ...options, bills: selectedHandles },
    baseCurrency: accounts.baseCurrency,
    currencyCodes: [
      ...new Set([
        ...accounts.currencyCodes,
        ...securities.securities.securities.map(
          (security) => security.currencyCode,
        ),
        ...(options.importExchangeRates ? rateCodes : []),
      ]),
    ],
    accounts,
    transactions,
    categories,
    payees,
    tags,
    securities: securities.securities,
    investments,
    bills,
    loans,
    rawPrices: prices.rawPrices,
    rawExchangeRates: prices.rawExchangeRates,
    currencyByHandle: prices.currencyByHandle,
    holdingChecks: checks,
    expectedBalances,
    transactionCounts: counts.transactions,
    investmentCounts: counts.investments,
    fileCounts: fileCounts(
      raw,
      prices.rawPrices.length,
      prices.rawExchangeRates.length,
    ),
    missingTables: [],
    missingFields: [],
    warnings: [
      ...readerWarnings(raw, context),
      ...accounts.warnings,
      ...transactions.warnings,
      ...investments.warnings,
      ...securities.securities.warnings,
      ...prices.warnings,
      ...bills.warnings,
      ...loans.warnings,
      ...statedLoanTerms.warnings,
      ...payees.warnings,
      ...repeated("costCentersNotImported", costCenters),
      ...repeated("budgetsNotImported", raw.counts.budgets),
      ...repeated("reportsNotImported", raw.counts.reports),
      ...repeated("onlineJobsNotImported", raw.counts.onlineJobs),
      ...comparisons,
    ],
    sourceFormat: "kmy",
    fileBalances: expectations.fileBalances,
    balancePrecision: expectations.balancePrecision,
    moneyPlaces: new Map(
      [...new Set([...accounts.currencyCodes, ...usedCurrencies])].map(
        (code) => [code, amountPlaces(code, input.coinDecimals)],
      ),
    ),
    kmyFile: {
      container: raw.fileInfo.container,
      fixVersion: raw.fileInfo.fixVersion,
      appVersion: raw.fileInfo.appVersion,
      lastModified: raw.fileInfo.lastModified,
      asOf,
    },
  };
}
