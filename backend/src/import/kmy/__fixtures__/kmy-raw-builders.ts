import {
  KmyAccount,
  KmyCurrency,
  KmyInstitution,
  KmyPayee,
  KmyPrice,
  KmyRawFile,
  KmySchedule,
  KmySecurity,
  KmySplit,
  KmyTag,
  KmyTemplateSplit,
  KmyTransaction,
} from "../model/kmy-raw";
import { Rational, parseKmyNumber, ZERO } from "../model/kmy-rational";

/**
 * Plain-object builders for the raw KMyMoney model, so a mapper spec states
 * only what it is about. Nothing here reads XML (that is the reader's job):
 * every builder fills the defaults the reader would, and `rawFile` numbers the
 * ordinals the way the reader does (1-based, in the order given).
 */

/** A number as KMyMoney writes it (`"5000"`, `"-241/2"`, `"1.5"`); never an autoCalc. */
export function n(text: string): Rational {
  const parsed = parseKmyNumber(text);
  if (parsed.kind !== "value") {
    throw new Error(`not a plain KMyMoney number: ${text}`);
  }
  return parsed.value;
}

export const STANDARD_ROOT_IDS = [
  "AStd::Asset",
  "AStd::Liability",
  "AStd::Expense",
  "AStd::Income",
  "AStd::Equity",
] as const;

const STANDARD_ROOT_TYPE: Record<string, number> = {
  "AStd::Asset": 9,
  "AStd::Liability": 10,
  "AStd::Expense": 13,
  "AStd::Income": 12,
  "AStd::Equity": 16,
};

export interface AccountInit {
  id: string;
  name?: string;
  type?: number;
  /** Default: the standard root of the type's group. `null` is an empty parentaccount. */
  parentId?: string | null;
  currency?: string | null;
  institutionId?: string | null;
  number?: string;
  description?: string;
  kvp?: Record<string, string>;
  hasOnlineBanking?: boolean;
}

function defaultParent(type: number): string {
  if (type === 12) return "AStd::Income";
  if (type === 13) return "AStd::Expense";
  if (type === 16) return "AStd::Equity";
  if (type === 4 || type === 5 || type === 10) return "AStd::Liability";
  return "AStd::Asset";
}

export function rawAccount(init: AccountInit): KmyAccount {
  const type = init.type ?? 1;
  const isStandard = init.id.startsWith("AStd::");
  return {
    ordinal: 0,
    id: init.id,
    isStandard,
    parentId: isStandard
      ? null
      : init.parentId === undefined
        ? defaultParent(type)
        : init.parentId,
    name: init.name ?? init.id,
    type,
    currency: init.currency === undefined ? "USD" : init.currency,
    institutionId: init.institutionId ?? null,
    opened: null,
    lastReconciled: null,
    number: init.number ?? "",
    description: init.description ?? "",
    subaccountIds: [],
    reconciliations: [],
    kvp: new Map(Object.entries(init.kvp ?? {})),
    hasOnlineBanking: init.hasOnlineBanking ?? false,
  };
}

export function standardRoots(currency = "USD"): KmyAccount[] {
  return STANDARD_ROOT_IDS.map((id) =>
    rawAccount({
      id,
      name: id.slice(6),
      type: STANDARD_ROOT_TYPE[id],
      currency,
    }),
  );
}

export interface SplitInit {
  account: string;
  value: string;
  /** Default: `value`. */
  shares?: string;
  price?: string;
  payee?: string | null;
  action?: string;
  reconcileFlag?: number;
  reconcileDate?: string | null;
  memo?: string;
  number?: string;
  costCenter?: string | null;
  tags?: string[];
}

export function rawSplit(init: SplitInit): KmySplit {
  return {
    ordinal: 0,
    account: init.account,
    payee: init.payee ?? null,
    value: n(init.value),
    shares: n(init.shares ?? init.value),
    price: n(init.price ?? "1"),
    action: init.action ?? "",
    reconcileFlag: init.reconcileFlag ?? 0,
    reconcileDate: init.reconcileDate ?? null,
    memo: init.memo ?? "",
    number: init.number ?? "",
    bankId: "",
    costCenter: init.costCenter ?? null,
    tags: init.tags ?? [],
    hasMatchedTransaction: false,
  };
}

export interface TransactionInit {
  id?: string;
  postDate?: string | null;
  memo?: string;
  commodity?: string | null;
  splits: SplitInit[];
}

export function rawTransaction(init: TransactionInit): KmyTransaction {
  return {
    ordinal: 0,
    id: init.id ?? "T0",
    postDate: init.postDate === undefined ? "2024-01-01" : init.postDate,
    memo: init.memo ?? "",
    commodity: init.commodity === undefined ? "USD" : init.commodity,
    splits: init.splits.map((split, index) => ({
      ...rawSplit(split),
      ordinal: index + 1,
    })),
    kvp: new Map(),
  };
}

export interface TemplateSplitInit extends Omit<SplitInit, "value" | "shares"> {
  value: string | "autoCalc";
  shares?: string | "autoCalc";
}

export interface ScheduleInit {
  id?: string;
  name?: string;
  type?: number;
  occurrence?: number;
  multiplier?: number;
  startDate?: string | null;
  endDate?: string | null;
  lastPayment?: string | null;
  fixed?: boolean;
  autoEnter?: boolean;
  lastDayInMonth?: boolean;
  weekendOption?: number;
  /** `null` is a schedule with no template. */
  template?: {
    postDate?: string | null;
    memo?: string;
    commodity?: string | null;
    splits: TemplateSplitInit[];
  } | null;
}

export function rawSchedule(init: ScheduleInit): KmySchedule {
  const template = init.template;
  return {
    ordinal: 0,
    id: init.id ?? "SCH1",
    name: init.name ?? "Schedule",
    type: init.type ?? 1,
    occurrence: init.occurrence ?? 32,
    multiplier: init.multiplier ?? 1,
    paymentType: 0,
    startDate: init.startDate === undefined ? "2024-01-01" : init.startDate,
    endDate: init.endDate ?? null,
    lastPayment: init.lastPayment ?? null,
    fixed: init.fixed ?? true,
    autoEnter: init.autoEnter ?? false,
    lastDayInMonth: init.lastDayInMonth ?? false,
    weekendOption: init.weekendOption ?? 0,
    payments: [],
    template:
      template === null || template === undefined
        ? null
        : {
            postDate:
              template.postDate === undefined
                ? "2024-02-01"
                : template.postDate,
            memo: template.memo ?? "",
            commodity:
              template.commodity === undefined ? "USD" : template.commodity,
            splits: template.splits.map((split, index): KmyTemplateSplit => ({
              ...rawSplit({ ...split, value: "0", shares: "0" }),
              ordinal: index + 1,
              value: split.value === "autoCalc" ? "autoCalc" : n(split.value),
              shares:
                (split.shares ?? split.value) === "autoCalc"
                  ? "autoCalc"
                  : n((split.shares ?? split.value) as string),
            })),
          },
  };
}

export interface SecurityInit {
  id: string;
  name?: string;
  symbol?: string;
  type?: number;
  saf?: bigint;
  pp?: number;
  roundingMethod?: number;
  tradingCurrency?: string | null;
  kvp?: Record<string, string>;
}

export function rawSecurity(init: SecurityInit): KmySecurity {
  return {
    ordinal: 0,
    id: init.id,
    name: init.name ?? init.id,
    symbol: init.symbol ?? "",
    type: init.type ?? 0,
    saf: init.saf ?? 100n,
    pp: init.pp ?? 4,
    roundingMethod: init.roundingMethod ?? 7,
    tradingCurrency:
      init.tradingCurrency === undefined ? "USD" : init.tradingCurrency,
    tradingMarket: "",
    kvp: new Map(Object.entries(init.kvp ?? {})),
  };
}

export function rawCurrency(id: string, saf = 100n): KmyCurrency {
  return {
    ordinal: 0,
    id,
    name: id,
    symbol: id,
    saf,
    scf: saf,
    pp: 4,
    roundingMethod: 7,
  };
}

export function rawPrice(
  from: string,
  to: string,
  date: string,
  price: string,
): KmyPrice {
  return { ordinal: 0, from, to, date, price: n(price), source: "User" };
}

/** A payee with matching disabled and no details; `options` overrides any field. */
export function rawPayee(
  id: string,
  name: string,
  options: Partial<KmyPayee> = {},
): KmyPayee {
  return {
    ordinal: 0,
    id,
    name,
    match: { kind: "disabled", ignoreCase: false, keys: [] },
    defaultAccountId: null,
    notes: "",
    email: "",
    reference: "",
    address: { street: "", city: "", state: "", postcode: "", telephone: "" },
    hasIdentifiers: false,
    hasLinkPattern: false,
    ...options,
  };
}

export function rawTag(id: string, name: string): KmyTag {
  return { ordinal: 0, id, name, closed: false };
}

export function rawInstitution(
  id: string,
  name: string,
  accountIds: string[] = [],
): KmyInstitution {
  return { ordinal: 0, id, name, accountIds };
}

export interface RawFileInit {
  fixVersion?: number;
  baseCurrency?: string | null;
  institutions?: KmyInstitution[];
  payees?: KmyPayee[];
  tags?: KmyTag[];
  accounts?: KmyAccount[];
  transactions?: KmyTransaction[];
  schedules?: KmySchedule[];
  securities?: KmySecurity[];
  currencies?: KmyCurrency[];
  prices?: KmyPrice[];
  counts?: Partial<KmyRawFile["counts"]>;
  readerWarnings?: KmyRawFile["readerWarnings"];
}

function numbered<T extends { ordinal: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ ...item, ordinal: index + 1 }));
}

/**
 * A complete raw file. Accounts default to the five standard roots plus the
 * ones given; ordinals are assigned in order. Pass `accounts` containing the
 * roots yourself to control their positions.
 */
export function rawFile(init: RawFileInit = {}): KmyRawFile {
  const given = init.accounts ?? [];
  const hasRoots = given.some((account) => account.isStandard);
  return {
    fileInfo: {
      container: "xml",
      fixVersion: init.fixVersion ?? 12,
      appVersion: null,
      creationDate: null,
      lastModified: null,
    },
    baseCurrency: init.baseCurrency === undefined ? "USD" : init.baseCurrency,
    institutions: numbered(init.institutions ?? []),
    payees: numbered(init.payees ?? []),
    tags: numbered(init.tags ?? []),
    costCenters: [],
    accounts: numbered(hasRoots ? given : [...standardRoots(), ...given]),
    transactions: numbered(init.transactions ?? []),
    schedules: numbered(init.schedules ?? []),
    securities: numbered(init.securities ?? []),
    currencies: numbered(
      init.currencies ?? [rawCurrency("USD"), rawCurrency("EUR")],
    ),
    prices: numbered(init.prices ?? []),
    counts: {
      reports: 0,
      budgets: 0,
      onlineJobs: 0,
      matchedTransactions: 0,
      onlineBankingAccounts: 0,
      ...init.counts,
    },
    readerWarnings: init.readerWarnings ?? [],
  };
}

/** Rational zero, for a spec that needs one without importing the model. */
export const ZERO_AMOUNT: Rational = ZERO;

/**
 * The reference's section 18 file (`docs/kmymoney-data-model.md`), as the
 * reader would return it: the plan's ground-truth table is written against it.
 * Account ordinals follow the file's order (five roots, then A000001 as 6).
 */
export function syntheticKmyFile(): KmyRawFile {
  const t = (
    id: string,
    postDate: string,
    splits: SplitInit[],
    memo = "",
  ): KmyTransaction =>
    rawTransaction({ id: `T${id.padStart(18, "0")}`, postDate, splits, memo });
  return rawFile({
    baseCurrency: "USD",
    institutions: [
      rawInstitution("I000001", "Example Bank", ["A000001", "A000013"]),
    ],
    payees: [
      rawPayee("P000001", "Corner Market"),
      rawPayee("P000002", "City Power", {
        match: { kind: "key", ignoreCase: true, keys: ["CITY POWER"] },
        defaultAccountId: "A000008",
      }),
    ],
    tags: [rawTag("G000001", "household")],
    accounts: [
      ...standardRoots(),
      rawAccount({
        id: "A000001",
        name: "Checking",
        type: 1,
        institutionId: "I000001",
        number: "000123",
        description: "Main account\nsecond line of notes",
        kvp: { iban: "XX00EXAMPLE0000000000000" },
      }),
      rawAccount({
        id: "A000003",
        name: "EUR Savings",
        type: 2,
        currency: "EUR",
      }),
      rawAccount({ id: "A000004", name: "Brokerage Account", type: 7 }),
      rawAccount({
        id: "A000005",
        name: "Brokerage Account (Brokerage)",
        type: 1,
      }),
      rawAccount({
        id: "A000006",
        name: "Example Corp",
        type: 15,
        parentId: "A000004",
        currency: "E000001",
      }),
      rawAccount({ id: "A000007", name: "Utilities", type: 13 }),
      rawAccount({
        id: "A000008",
        name: "Electricity",
        type: 13,
        parentId: "A000007",
      }),
      rawAccount({ id: "A000009", name: "Groceries", type: 13 }),
      rawAccount({ id: "A000010", name: "Bank Fees", type: 13 }),
      rawAccount({ id: "A000011", name: "Dividends", type: 12 }),
      rawAccount({
        id: "A000012",
        name: "Opening Balances",
        type: 16,
        kvp: { OpeningBalanceAccount: "Yes" },
      }),
      rawAccount({
        id: "A000013",
        name: "Old Savings",
        type: 2,
        institutionId: "I000001",
        kvp: { "mm-closed": "yes", "mm-closed-date": "2024-01-10" },
      }),
    ],
    transactions: [
      t("1", "2024-01-01", [
        {
          account: "A000001",
          value: "5000",
          reconcileFlag: 2,
          reconcileDate: "2024-01-31",
        },
        { account: "A000012", value: "-5000" },
      ]),
      t("2", "2024-01-01", [
        { account: "A000013", value: "100" },
        { account: "A000012", value: "-100" },
      ]),
      t("3", "2024-01-05", [
        {
          account: "A000001",
          value: "-241/2",
          payee: "P000001",
          reconcileFlag: 2,
          reconcileDate: "2024-01-31",
          memo: "Weekly shop",
        },
        {
          account: "A000009",
          value: "201/2",
          payee: "P000001",
          memo: "Food",
          tags: ["G000001"],
        },
        {
          account: "A000010",
          value: "20",
          payee: "P000001",
          memo: "Card surcharge",
        },
      ]),
      t("4", "2024-01-10", [
        { account: "A000013", value: "-100", memo: "Close account" },
        {
          account: "A000001",
          value: "100",
          memo: "Close account",
          reconcileFlag: 2,
          reconcileDate: "2024-01-31",
        },
      ]),
      t("5", "2024-01-15", [
        {
          account: "A000001",
          value: "-1100",
          memo: "To EUR savings",
          reconcileFlag: 2,
          reconcileDate: "2024-01-31",
        },
        {
          account: "A000003",
          value: "1100",
          shares: "1000",
          price: "11/10",
          memo: "To EUR savings",
        },
      ]),
      t("6", "2024-02-01", [
        {
          account: "A000001",
          value: "-75",
          payee: "P000002",
          reconcileFlag: 1,
          memo: "February",
        },
        { account: "A000008", value: "75", payee: "P000002", memo: "February" },
      ]),
      t("7", "2024-02-05", [
        { account: "A000001", value: "-1000" },
        { account: "A000005", value: "1000" },
      ]),
      t("8", "2024-02-10", [
        { account: "A000005", value: "-505", price: "0", memo: "Buy EXC" },
        {
          account: "A000006",
          value: "500",
          shares: "10",
          price: "50",
          action: "Buy",
          memo: "Buy EXC",
        },
        { account: "A000010", value: "5" },
      ]),
      t("9", "2024-03-15", [
        { account: "A000005", value: "15/2", price: "0", memo: "Dividend" },
        {
          account: "A000006",
          value: "0",
          price: "0",
          action: "Dividend",
          memo: "Dividend",
        },
        { account: "A000011", value: "-15/2" },
      ]),
      t("10", "2024-04-01", [
        {
          account: "A000006",
          value: "0",
          shares: "2",
          price: "0",
          action: "Split",
          memo: "2:1 split",
        },
      ]),
      t("11", "2024-05-01", [
        { account: "A000005", value: "145", price: "0", memo: "Sell EXC" },
        {
          account: "A000006",
          value: "-150",
          shares: "-5",
          price: "30",
          action: "Buy",
          memo: "Sell EXC",
        },
        { account: "A000010", value: "5" },
      ]),
    ],
    schedules: [
      rawSchedule({
        id: "SCH000001",
        name: "Electricity",
        type: 1,
        occurrence: 32,
        multiplier: 1,
        startDate: "2024-02-01",
        lastPayment: "2024-02-01",
        fixed: false,
        weekendOption: 1,
        template: {
          postDate: "2024-03-01",
          splits: [
            { account: "A000001", value: "-75", payee: "P000002" },
            { account: "A000008", value: "75", payee: "P000002" },
          ],
        },
      }),
    ],
    securities: [
      rawSecurity({
        id: "E000001",
        name: "Example Corp",
        symbol: "EXC",
        type: 0,
        saf: 1000n,
        tradingCurrency: "USD",
      }),
    ],
    prices: [
      rawPrice("E000001", "USD", "2024-02-10", "50"),
      rawPrice("E000001", "USD", "2024-05-01", "30"),
      rawPrice("EUR", "USD", "2024-01-15", "11/10"),
    ],
    counts: { budgets: 1 },
  });
}
