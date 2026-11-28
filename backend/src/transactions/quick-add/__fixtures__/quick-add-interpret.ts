/**
 * The fixtures the `QuickAddInterpretService` specs share: a reader with two
 * CAD accounts and a JPY one, a few payees and categories, and a service
 * whose collaborators are mocks typed as the real ones.
 *
 * A spec using it mocks `src/common/db/scoped-db.ts` and the loaders of
 * `src/transactions/quick-add/quick-add-candidates.ts` itself (`jest.mock` is
 * hoisted per spec file) and hands the mocked loaders to
 * {@link buildQuickAddService}.
 */
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../../../test-helpers/scoped-db-testing";
import type { RuleEffectsPreview } from "../../../transaction-rules/transaction-rules-applier.service";
import {
  CreateTransactionPreview,
  TransactionsService,
} from "../../transactions.service";
import {
  CreateTransferPreview,
  TransactionTransferService,
} from "../../transaction-transfer.service";
import type * as candidatesModule from "../quick-add-candidates";
import type { QuickAddCandidates } from "../quick-add-candidates";
import { QuickAddInterpretDto } from "../dto/quick-add-interpret.dto";
import { QuickAddInterpretService } from "../quick-add-interpret.service";
import type { QuickAddPayeeHistory } from "../quick-add-fill-shared.util";
import type {
  QuickAddCandidateAccount,
  QuickAddCandidatePayee,
} from "../quick-add.types";

/** The suites' clock: local noon on a Friday, so `isTransactionInFuture` is pinned. */
export const SUITE_CLOCK = new Date("2026-11-20T12:00:00");
export const TODAY = "2026-11-20";
export const USER = "user-1";

// Ids are UUID-shaped only where a DTO would check them; the service does not.
export const CHQ = "acc-chq";
export const SAV = "acc-sav";
export const VISA_A = "acc-visa-a";
export const VISA_B = "acc-visa-b";
export const YEN = "acc-yen";

export const account = (
  id: string,
  name: string,
  currentBalance = 1000,
  currencyCode = "CAD",
): QuickAddCandidateAccount => ({ id, name, currencyCode, currentBalance });

export const LOBLAWS: QuickAddCandidatePayee = {
  id: "p-loblaws",
  name: "Loblaws",
  defaultCategoryId: "c-food",
  aliases: [],
};
export const EMPLOYER: QuickAddCandidatePayee = {
  id: "p-employer",
  name: "Acme Payroll",
  defaultCategoryId: null,
  aliases: [],
};

export function candidates(
  over: Partial<QuickAddCandidates> = {},
): QuickAddCandidates {
  return {
    accounts: [
      account(CHQ, "Chequing", 1000),
      account(SAV, "Savings", 5000),
      account(YEN, "Wallet", 20000, "JPY"),
    ],
    payees: [
      LOBLAWS,
      EMPLOYER,
      {
        id: "p-tim",
        name: "Tim Hortons",
        defaultCategoryId: null,
        aliases: [],
      },
      {
        id: "p-timbuktu",
        name: "Timbuktu",
        defaultCategoryId: null,
        aliases: [],
      },
    ],
    categories: [
      { id: "c-food", name: "Food", path: "Food", categoryType: "expense" },
      {
        id: "c-groc",
        name: "Groceries",
        path: "Food: Groceries",
        categoryType: "expense",
      },
      {
        id: "c-salary",
        name: "Salary",
        path: "Salary",
        categoryType: "income",
      },
    ],
    numberFormat: "en-US",
    dateFormat: "YYYY-MM-DD",
    currencies: [
      { code: "CAD", symbol: "$" },
      { code: "JPY", symbol: "¥" },
    ],
    currencyPlaces: new Map([
      ["CAD", 2],
      ["JPY", 0],
    ]),
    ...over,
  };
}

export const NO_HISTORY: QuickAddPayeeHistory = { recent: [], categoryIds: [] };

export function dto(
  text: string,
  over: Partial<QuickAddInterpretDto> = {},
): QuickAddInterpretDto {
  return Object.assign(new QuickAddInterpretDto(), {
    text,
    today: TODAY,
    ...over,
  });
}

export function preview(
  ruleEffects?: RuleEffectsPreview,
): CreateTransactionPreview {
  return {
    accountId: CHQ,
    accountName: "Chequing",
    amount: -84.37,
    transactionDate: TODAY,
    payeeId: LOBLAWS.id,
    payeeName: LOBLAWS.name,
    payeeMatched: true,
    payeeWillBeCreated: false,
    categoryId: "c-groc",
    categoryName: "Groceries",
    description: null,
    currencyCode: "CAD",
    ...(ruleEffects ? { ruleEffects } : {}),
  };
}

export function transferPreview(): CreateTransferPreview {
  return {
    fromAccountId: CHQ,
    fromAccountName: "Chequing",
    fromCurrencyCode: "CAD",
    toAccountId: SAV,
    toAccountName: "Savings",
    toCurrencyCode: "CAD",
    amount: 500,
    toAmount: 500,
    exchangeRate: 1,
    transactionDate: TODAY,
    description: null,
    payeeId: null,
    payeeName: null,
    payeeMatched: false,
    payeeWillBeCreated: false,
    categoryId: null,
    categoryName: null,
  };
}

export type QuickAddLoaders = jest.Mocked<typeof candidatesModule>;

/** Transaction counts per id, by the column `loadUsage` is asked for. */
export type QuickAddUsageTable = Record<
  "payee_id" | "category_id" | "account_id",
  Map<string, number>
>;

export interface QuickAddServiceHarness {
  readonly service: QuickAddInterpretService;
  readonly transactionsService: Pick<
    jest.Mocked<TransactionsService>,
    "previewCreate"
  >;
  readonly transferService: Pick<
    jest.Mocked<TransactionTransferService>,
    "previewCreateTransfer"
  >;
  readonly dataSource: ReturnType<typeof createScopedDbMocks>["dataSource"];
  /** Read by the `loadUsage` mock at call time: replace a column to rank. */
  readonly usage: QuickAddUsageTable;
}

/** Pins the clock to {@link SUITE_CLOCK}; pair with `jest.useRealTimers()`. */
export function useSuiteClock(): void {
  jest.useFakeTimers({
    doNotFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "nextTick",
      "queueMicrotask",
      "performance",
    ],
  });
  jest.setSystemTime(SUITE_CLOCK);
}

/**
 * A service over the default candidates, no payee history, Savings as the
 * account of the reader's last created row, and previews that match no rule.
 */
export function buildQuickAddService(
  loaders: QuickAddLoaders,
): QuickAddServiceHarness {
  const usage: QuickAddUsageTable = {
    payee_id: new Map(),
    category_id: new Map(),
    account_id: new Map(),
  };
  loaders.loadQuickAddCandidates.mockResolvedValue(candidates());
  loaders.loadOwnedPayee.mockResolvedValue(null);
  loaders.loadUsage.mockImplementation(async (_m, _u, column) => usage[column]);
  loaders.loadPayeeHistory.mockResolvedValue(NO_HISTORY);
  loaders.loadMostRecentAccountId.mockResolvedValue(SAV);
  const transactionsService = {
    previewCreate: jest.fn().mockResolvedValue(preview()),
  } as QuickAddServiceHarness["transactionsService"];
  const transferService = {
    previewCreateTransfer: jest.fn().mockResolvedValue(transferPreview()),
  } as QuickAddServiceHarness["transferService"];
  const { dataSource } = createScopedDbMocks();
  const service = new QuickAddInterpretService(
    dataSource as unknown as DataSource,
    transactionsService as unknown as TransactionsService,
    transferService as unknown as TransactionTransferService,
  );
  return { service, transactionsService, transferService, dataSource, usage };
}
