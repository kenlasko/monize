import {
  AccountSubType,
  AccountType,
} from "../../../accounts/entities/account.entity";
import {
  brokerageSuffix,
  cashSuffix,
} from "../../../accounts/account-name.util";
import {
  MnyImportOptions,
  accountSelection,
} from "../../mny/model/mny-import-options";
import {
  MappedAccount,
  MappedAccounts,
} from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyAccount, KmyRawFile } from "../model/kmy-raw";
import { abs, parseKmyNumber } from "../model/kmy-rational";
import {
  AccountTree,
  KMY_TYPE,
  MONIZE_TYPE,
  isAssetOrLiability,
  isCategoryType,
} from "./kmy-account-tree";
import { amountNumber } from "./kmy-amounts";
import { accountWarnings } from "./kmy-account-warnings";
import { findBrokerageAccount } from "./kmy-brokerage";

/**
 * Spec 5.2: KMyMoney accounts to Monize accounts and investment pairs.
 *
 * Opening balances are left at 0 here; `kmy-opening-balances` folds them in
 * (spec 5.3) once it knows which Monize key each KMyMoney account maps to.
 */

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** One investment account and the two Monize accounts it becomes. */
export interface KmyPair {
  /** The type-7 account's id. */
  readonly investmentId: string;
  readonly brokerageKey: string;
  readonly cashKey: string;
  readonly currencyCode: string;
  /** The KMyMoney account that is the cash side, or null for a synthesized one. */
  readonly cashAccountId: string | null;
}

export interface KmyAccountMapping {
  /** Opening balances are 0 until `withOpeningBalances`. */
  readonly mapped: MappedAccounts;
  /**
   * KMyMoney account id -> the Monize key its splits' `shares` land in: an
   * ordinary account's own key, and a pair's cash key for the cash account
   * and for the type-7 account itself (spec 6.1). Absent for categories,
   * equity, stock accounts and accounts that do not import.
   */
  readonly keyById: ReadonlyMap<string, string>;
  /** Monize account key -> its currency (after the wizard's override). */
  readonly currencyByKey: ReadonlyMap<string, string>;
  /** Type-7 account id -> its pair. */
  readonly pairs: ReadonlyMap<string, KmyPair>;
  readonly baseCurrency: string;
}

export interface MapKmyAccountsInput {
  readonly raw: KmyRawFile;
  readonly tree: AccountTree;
  readonly options: MnyImportOptions;
  readonly baseCurrency: string;
  readonly coinDecimals: ReadonlyMap<string, number>;
}

function isYes(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() === "yes";
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) {
    taken.add(base.toLowerCase());
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/** The account's own currency id, the base currency when it names none. */
export function rawCurrencyOf(
  account: KmyAccount,
  baseCurrency: string,
): string {
  const id = account.currency?.trim();
  return id ? id : baseCurrency;
}

export function mapKmyAccounts(input: MapKmyAccountsInput): KmyAccountMapping {
  const { raw, tree, options, baseCurrency, coinDecimals } = input;
  const warnings: MnyWarning[] = [];
  const definedCurrencies = new Set([
    ...raw.currencies.map((currency) => currency.id),
    ...coinDecimals.keys(),
  ]);

  // Pass 1: which accounts are candidates at all.
  const valid = new Map<string, KmyAccount>();
  let skipped = 0;
  for (const account of raw.accounts) {
    if (
      account.isStandard ||
      account.type === KMY_TYPE.STOCK ||
      isCategoryType(account.type) ||
      account.type === KMY_TYPE.EQUITY
    ) {
      continue;
    }
    if (!isAssetOrLiability(account.type)) {
      skipped += 1;
      warnings.push({
        code: "unknownAccountType",
        subject: account.name,
        detail: `type=${account.type}`,
      });
      continue;
    }
    if (!tree.reachable(account.id)) {
      skipped += 1;
      warnings.push({
        code: "unknownAccountType",
        subject: account.name,
        detail: "unreachable",
      });
      continue;
    }
    const currency = rawCurrencyOf(account, baseCurrency);
    if (!CURRENCY_CODE.test(currency)) {
      skipped += 1;
      warnings.push({
        code: "unsupportedCurrencyCode",
        subject: account.name,
        detail: currency,
      });
      continue;
    }
    valid.set(account.id, account);
  }

  // Pass 2: cash accounts of the investment accounts, first by ordinal.
  const candidates = raw.accounts.filter((account) => valid.has(account.id));
  const claimed = new Set<string>();
  const cashOf = new Map<string, KmyAccount | null>();
  for (const account of candidates) {
    if (account.type !== KMY_TYPE.INVESTMENT) {
      continue;
    }
    const found = findBrokerageAccount(account, candidates, tree, claimed);
    if (found === null || !valid.has(found.id)) {
      cashOf.set(account.id, null);
      warnings.push({
        code: "brokerageAccountNotFound",
        subject: account.name,
      });
      continue;
    }
    if (
      rawCurrencyOf(found, baseCurrency) !==
      rawCurrencyOf(account, baseCurrency)
    ) {
      cashOf.set(account.id, null);
      warnings.push({
        code: "brokerageCurrencyMismatch",
        subject: account.name,
        detail: found.name,
      });
      continue;
    }
    claimed.add(found.id);
    cashOf.set(account.id, found);
  }

  // Pass 3: the mapped accounts, in file order.
  const taken = new Set<string>();
  const mapped: MappedAccount[] = [];
  const keyById = new Map<string, string>();
  const currencyByKey = new Map<string, string>();
  const pairs = new Map<string, KmyPair>();
  const keyByHandle = new Map<number, string>();
  const currencyByHandle = new Map<number, string>();
  const imported: KmyAccount[] = [];

  const institutionName = (account: KmyAccount | null): string | null =>
    account?.institutionId
      ? (raw.institutions.find((entry) => entry.id === account.institutionId)
          ?.name ?? null)
      : null;

  for (const account of candidates) {
    if (claimed.has(account.id)) {
      // Imported (or left out) with its investment account.
      continue;
    }

    const closed = isYes(account.kvp.get("mm-closed"));
    const selection = accountSelection(options, account.ordinal, closed);
    if (!selection.include) {
      skipped += 1;
      continue;
    }
    const currencyCode = (
      selection.currencyOverride ?? rawCurrencyOf(account, baseCurrency)
    ).toUpperCase();
    const moneyName = account.name;
    const isCrypto = coinDecimals.has(currencyCode);

    if (account.type === KMY_TYPE.INVESTMENT && !isCrypto) {
      const cash = cashOf.get(account.id) ?? null;
      const base = account.name.trim() || "Account";
      const cashKey = cash
        ? `acct-${cash.ordinal}`
        : `acct-${account.ordinal}-cash`;
      const brokerageKey = `acct-${account.ordinal}`;
      // m10: closed only when both halves are. A closed cash account beside
      // an investment that still holds shares must not hide the holding.
      const pairClosed =
        closed && (cash ? isYes(cash.kvp.get("mm-closed")) : true);
      const shared = {
        accountType: AccountType.INVESTMENT,
        currencyCode,
        creditLimit: null,
        closed: pairClosed,
        closedDate: pairClosed
          ? (account.kvp.get("mm-closed-date") ??
              cash?.kvp.get("mm-closed-date") ??
              null) ||
            null
          : null,
        favourite:
          isYes(account.kvp.get("PreferredAccount")) ||
          (cash ? isYes(cash.kvp.get("PreferredAccount")) : false),
        excludeFromNetWorth: false,
        description: account.description || null,
        institutionName: institutionName(account) ?? institutionName(cash),
        openingBalance: 0,
      };
      mapped.push(
        {
          ...shared,
          key: cashKey,
          handle: cash ? cash.ordinal : null,
          name: uniqueName(`${base} - ${cashSuffix()}`, taken),
          moneyName: cash ? cash.name : moneyName,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          linkedKey: brokerageKey,
        },
        {
          ...shared,
          key: brokerageKey,
          handle: account.ordinal,
          name: uniqueName(`${base} - ${brokerageSuffix()}`, taken),
          moneyName,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedKey: cashKey,
        },
      );
      const pair: KmyPair = {
        investmentId: account.id,
        brokerageKey,
        cashKey,
        currencyCode,
        cashAccountId: cash?.id ?? null,
      };
      pairs.set(account.id, pair);
      keyById.set(account.id, cashKey);
      if (cash) {
        keyById.set(cash.id, cashKey);
        keyByHandle.set(cash.ordinal, cashKey);
        currencyByHandle.set(cash.ordinal, currencyCode);
        imported.push(cash);
      }
      keyByHandle.set(account.ordinal, brokerageKey);
      currencyByHandle.set(account.ordinal, currencyCode);
      currencyByKey.set(cashKey, currencyCode);
      currencyByKey.set(brokerageKey, currencyCode);
      imported.push(account);
      continue;
    }

    const accountType = isCrypto
      ? AccountType.CRYPTO
      : (MONIZE_TYPE.get(account.type) as AccountType);
    const requested = account.name.trim() || "Account";
    const name = uniqueName(requested, taken);
    if (name !== requested) {
      warnings.push({
        code: "duplicateAccountName",
        subject: requested,
        detail: name,
      });
    }
    const key = `acct-${account.ordinal}`;
    mapped.push({
      key,
      handle: account.ordinal,
      name,
      moneyName,
      accountType,
      accountSubType: null,
      currencyCode,
      institutionName: institutionName(account),
      openingBalance: 0,
      creditLimit:
        account.type === KMY_TYPE.CREDIT_CARD
          ? creditLimit(account, currencyCode, coinDecimals)
          : null,
      closed,
      closedDate: closed ? account.kvp.get("mm-closed-date") || null : null,
      favourite: isYes(account.kvp.get("PreferredAccount")),
      excludeFromNetWorth: false,
      description: account.description || null,
      linkedKey: null,
    });
    keyById.set(account.id, key);
    keyByHandle.set(account.ordinal, key);
    currencyByHandle.set(account.ordinal, currencyCode);
    currencyByKey.set(key, currencyCode);
    imported.push(account);
  }

  for (const account of imported) {
    accountWarnings(account, tree, definedCurrencies, baseCurrency, warnings);
  }

  return {
    mapped: {
      baseCurrency,
      currencyCodes: [
        ...new Set([
          baseCurrency,
          ...mapped.map((entry) => entry.currencyCode),
        ]),
      ],
      accounts: mapped,
      keyByHandle,
      currencyByHandle,
      skipped,
      warnings,
    },
    keyById,
    currencyByKey,
    pairs,
    baseCurrency,
  };
}

function creditLimit(
  account: KmyAccount,
  currencyCode: string,
  coinDecimals: ReadonlyMap<string, number>,
): number | null {
  const text = account.kvp.get("maxCreditAbsolute");
  if (!text) {
    return null;
  }
  const parsed = parseKmyNumber(text);
  if (parsed.kind !== "value") {
    return null;
  }
  const limit = amountNumber(abs(parsed.value), currencyCode, coinDecimals);
  return limit > 0 ? limit : null;
}

/** Opening balances folded in by `kmy-opening-balances`, by account key. */
export function withOpeningBalances(
  accounts: MappedAccounts,
  balances: ReadonlyMap<string, number>,
): MappedAccounts {
  return {
    ...accounts,
    accounts: accounts.accounts.map((account) => ({
      ...account,
      openingBalance: balances.get(account.key) ?? account.openingBalance,
    })),
  };
}
