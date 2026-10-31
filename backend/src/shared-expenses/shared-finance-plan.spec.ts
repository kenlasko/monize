import { EntityManager } from "typeorm";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  lockAccountsForBalanceWrite,
  lockTransactionRows,
} from "../common/db/locks";
import { BookSharedEntryDto } from "./dto/shared-finance.dto";
import { planSharedFinance } from "./shared-finance-plan";
import {
  sharedBankRows,
  sharedIntegration,
  sharedPostingLinks,
  sharedPostings,
} from "./shared-finance-read";
import { SharedBankRow, SharedPosting } from "./shared-finance-types";
import { readSharedJournal } from "./shared-journal";
import { sharedEntryFixture } from "./__fixtures__/shared-entry";

jest.mock("./shared-journal", () => ({ readSharedJournal: jest.fn() }));
jest.mock("./shared-finance-read", () => ({
  sharedBankRows: jest.fn(),
  sharedIntegration: jest.fn(),
  sharedPostingLinks: jest.fn(),
  sharedPostings: jest.fn(),
}));
jest.mock("../common/db/locks", () => ({
  lockAccountsForBalanceWrite: jest.fn(),
  lockTransactionRows: jest.fn(),
}));
const sourceBank = (patch: Partial<SharedBankRow> = {}): SharedBankRow => ({
  id: "bank-row",
  accountId: "bank",
  date: "2026-01-01",
  amount: "-350.0000",
  currencyCode: "PLN",
  status: "UNRECONCILED",
  isSplit: false,
  isTransfer: false,
  linkedTransactionId: null,
  parentTransactionId: null,
  postingId: null,
  categoryId: "private",
  payeeId: null,
  payeeName: null,
  description: "Imported basket",
  externalId: "import-id",
  originalAmount: null,
  originalCurrencyCode: null,
  exchangeRate: "1",
  ...patch,
});
const dto = (patch: Partial<BookSharedEntryDto> = {}): BookSharedEntryDto => ({
  operationId: "operation",
  expectedRevision: 1,
  bankTransactionId: "bank-row",
  sharedBankAmount: "300",
  categoryId: "food",
  ...patch,
});
describe("Private finance planning before writing the bank register", () => {
  let manager: EntityManager;
  let query: jest.Mock;
  let rates: ExchangeRateService;
  let resolve: jest.Mock;
  let account: {
    currencyCode: string;
    decimalPlaces: number;
    accountType: string;
    managed: string | null;
    closed: boolean;
  } | null;
  let categories: { id: string; is_income: boolean }[];
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(sharedIntegration).mockResolvedValue({
      id: "integration",
      groupId: "group",
      participantId: "me",
      accountId: "clearing",
      currencyCode: "PLN",
      currentBalance: "0",
      active: true,
    });
    jest.mocked(sharedPostings).mockResolvedValue([]);
    jest.mocked(sharedPostingLinks).mockResolvedValue([]);
    jest.mocked(sharedBankRows).mockResolvedValue([sourceBank()]);
    jest.mocked(readSharedJournal).mockResolvedValue([sharedEntryFixture()]);
    account = {
      currencyCode: "PLN",
      decimalPlaces: 2,
      accountType: "CHEQUING",
      managed: null,
      closed: false,
    };
    categories = [
      { id: "food", is_income: false },
      { id: "private", is_income: false },
      { id: "fx", is_income: false },
    ];
    query = jest.fn(async (sql: string, args: unknown[]) => {
      if (sql.includes("AND is_closed")) return [];
      if (sql.includes("FROM currencies")) return [{ decimal_places: 2 }];
      if (sql.includes("FROM accounts a")) return account ? [account] : [];
      if (sql.includes("FROM categories"))
        return categories.filter((c) => (args[0] as string[]).includes(c.id));
      if (sql.includes("FROM payees")) return [];
      throw new Error(`Unexpected finance planner query: ${sql}`);
    });
    manager = { query } as unknown as EntityManager;
    resolve = jest.fn().mockResolvedValue({ rate: null, observedOn: null });
    rates = { resolveStoredRate: resolve } as unknown as ExchangeRateService;
  });
  const plan = (input = dto()) =>
    planSharedFinance(manager, rates, "owner", "group", "entry", input);
  it("preserves the imported row and previews a private remainder without writing", async () => {
    const result = await plan();
    expect(result.bank).toMatchObject({
      id: "bank-row",
      externalId: "import-id",
      amount: "-350.0000",
    });
    expect(result.effect).toMatchObject({
      cash: "-300.0000",
      personal: "-100.0000",
      position: "200.0000",
    });
    expect(result.breakdown).toMatchObject({
      privateRemainder: "-50.0000",
      fxDifference: "0.0000",
    });
    expect(result.privateCategoryId).toBe("private");
    expect(
      query.mock.calls.every(([sql]) => sql.trimStart().startsWith("SELECT")),
    ).toBe(true);
    expect(lockAccountsForBalanceWrite).toHaveBeenCalledWith(
      manager,
      ["clearing", "bank"],
      "owner",
    );
    expect(lockTransactionRows).toHaveBeenCalledWith(
      manager,
      ["bank-row"],
      "owner",
    );
  });
  it("detects an account move between discovery and locks", async () => {
    jest
      .mocked(sharedBankRows)
      .mockResolvedValueOnce([sourceBank()])
      .mockResolvedValueOnce([sourceBank({ accountId: "other" })]);
    await expect(plan()).rejects.toThrow("Refresh the preview");
  });
  it.each([
    { status: "VOID" },
    { status: "RECONCILED" },
    { isTransfer: true },
    { parentTransactionId: "parent" },
    { linkedTransactionId: "linked" },
    { postingId: "another-posting" },
  ])("refuses an ineligible imported bank movement %j", async (patch) => {
    jest.mocked(sharedBankRows).mockResolvedValue([sourceBank(patch)]);
    await expect(plan()).rejects.toThrow(
      "ordinary, unreconciled bank movement",
    );
  });
  it("requires selected category portions for an imported split movement", async () => {
    jest
      .mocked(sharedBankRows)
      .mockResolvedValue([sourceBank({ isSplit: true })]);
    await expect(plan()).rejects.toThrow(
      "Choose positive portions from this transaction's category splits",
    );
  });
  it.each([
    null,
    { closed: true },
    { managed: "SHARED_SETTLEMENT" },
    { accountType: "INVESTMENT" },
  ])("refuses an unavailable bank account %j", async (patch) => {
    account = patch === null ? null : { ...account!, ...patch };
    await expect(plan()).rejects.toThrow("bank or cash account");
  });
  it("withholds a draft instead of inventing a cash movement", async () => {
    jest.mocked(readSharedJournal).mockResolvedValue([
      sharedEntryFixture({
        state: "DRAFT",
        groupAmount: null,
        draftReason: "MISSING_RATE",
      }),
    ]);
    await expect(plan()).rejects.toThrow("Resolve this draft");
    expect(lockAccountsForBalanceWrite).not.toHaveBeenCalled();
  });
  it("rejects stale revisions before locking private accounts", async () => {
    await expect(plan(dto({ expectedRevision: 2 }))).rejects.toThrow(
      "changed while you were editing",
    );
    expect(lockAccountsForBalanceWrite).not.toHaveBeenCalled();
  });
  it("rejects disabled integration and an entry outside the group", async () => {
    jest.mocked(sharedIntegration).mockResolvedValueOnce(null);
    await expect(plan()).rejects.toThrow("Enable this group");
    jest.mocked(readSharedJournal).mockResolvedValueOnce([]);
    await expect(plan()).rejects.toThrow("unavailable");
  });
  it("requires exactly one bank source for a payer and none for a nonpayer", async () => {
    await expect(plan(dto({ bankAccountId: "bank" }))).rejects.toThrow(
      "bank or cash account",
    );
    await expect(plan(dto({ bankTransactionId: undefined }))).rejects.toThrow(
      "bank or cash account",
    );
    const entry = sharedEntryFixture();
    jest.mocked(readSharedJournal).mockResolvedValue([
      {
        ...entry,
        allocations: entry.allocations.filter((a) => a.kind === "SHARE"),
      },
    ]);
    await expect(plan()).rejects.toThrow("shared portion");
    const result = await plan(dto({ bankTransactionId: undefined }));
    expect(result.effect.position).toBe("-100.0000");
    expect(result.bank).toBeNull();
    expect(result.breakdown).toBeNull();
  });
  it("previews a new bank row and separates a bank exchange difference", async () => {
    jest.mocked(sharedBankRows).mockResolvedValue([]);
    const result = await plan(
      dto({
        bankTransactionId: undefined,
        bankAccountId: "bank",
        bankAmount: "310",
        sharedBankAmount: "310",
        fxCategoryId: "fx",
      }),
    );
    expect(result.bank).toBeNull();
    expect(result.bankAccountId).toBe("bank");
    expect(result.breakdown).toMatchObject({
      bankTotal: "-310.0000",
      fxDifference: "-10.0000",
    });
  });
  it("names the missing currency pair and date instead of silently using rate one", async () => {
    account = { ...account!, currencyCode: "EUR" };
    await expect(plan()).rejects.toThrow("PLN/EUR rate for 2026-01-01");
    expect(resolve).toHaveBeenCalledWith("PLN", "EUR", "2026-01-01");
    const result = await plan(
      dto({ bankRate: "0.25", sharedBankAmount: "75" }),
    );
    expect(result.breakdown).toMatchObject({
      agreedPortion: "-75.0000",
      privateRemainder: "-275.0000",
      fxDifference: "0.0000",
    });
  });
  it("uses the entry's original contribution when the bank is in its original currency", async () => {
    account = { ...account!, currencyCode: "EUR" };
    const entry = sharedEntryFixture({
      currencyCode: "EUR",
      originalAmount: "100",
    });
    jest.mocked(readSharedJournal).mockResolvedValue([
      {
        ...entry,
        allocations: entry.allocations.map((a) => ({
          ...a,
          originalAmount:
            a.kind === "CONTRIBUTION"
              ? "100"
              : a.participantId === "me"
                ? "40"
                : "60",
        })),
      },
    ]);
    const result = await plan(dto({ sharedBankAmount: "100" }));
    expect(result.breakdown).toMatchObject({ agreedPortion: "-100.0000" });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("rejects foreign categories, wrong income classification and a foreign payee", async () => {
    await expect(plan(dto({ categoryId: "someone-elses" }))).rejects.toThrow(
      "own category",
    );
    categories = categories.map((c) =>
      c.id === "food" ? { ...c, is_income: true } : c,
    );
    await expect(plan()).rejects.toThrow("own category");
    categories = categories.map((c) => ({ ...c, is_income: false }));
    await expect(plan(dto({ payeeId: "someone-elses" }))).rejects.toThrow(
      "own finances",
    );
  });
  it("requires separate categorization for a private remainder and exchange difference", async () => {
    jest
      .mocked(sharedBankRows)
      .mockResolvedValue([sourceBank({ categoryId: null })]);
    await expect(plan()).rejects.toThrow("own category");
    await expect(plan(dto({ sharedBankAmount: "350" }))).rejects.toThrow(
      "own category",
    );
    await expect(plan(dto({ sharedBankAmount: "351" }))).rejects.toThrow(
      "shared portion",
    );
  });
  it("reconstructs the imported source on a review and refuses reconciled accepted rows", async () => {
    const previous = {
      id: "posting",
      entryId: "entry",
      categoryId: "food",
      payeeId: null,
    } as SharedPosting;
    jest.mocked(sharedPostings).mockResolvedValue([previous]);
    jest.mocked(sharedPostingLinks).mockResolvedValue([
      {
        transactionId: "bank-row",
        kind: "BANK",
        created: false,
        before: sourceBank(),
      },
    ]);
    jest.mocked(sharedBankRows).mockResolvedValue([
      sourceBank({
        isSplit: true,
        postingId: "posting",
        description: "New bank memo",
      }),
    ]);
    const result = await plan();
    expect(result.bank).toMatchObject({
      isSplit: false,
      amount: "-350.0000",
      description: "New bank memo",
    });
    jest
      .mocked(sharedBankRows)
      .mockResolvedValue([sourceBank({ status: "RECONCILED" })]);
    await expect(plan()).rejects.toThrow("Remove their reconciliation");
    jest.mocked(sharedBankRows).mockResolvedValue([]);
    await expect(plan()).rejects.toThrow("Refresh the preview");
  });
  it("includes bank edits in the preview fingerprint", async () => {
    const before = await plan();
    jest
      .mocked(sharedBankRows)
      .mockResolvedValue([sourceBank({ amount: "-360" })]);
    const after = await plan();
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
  it("maps two own bank sources to one contribution without duplicating the personal cost", async () => {
    jest.mocked(sharedBankRows).mockResolvedValue([
      sourceBank({ amount: "-200" }),
      sourceBank({
        id: "second-row",
        accountId: "second-bank",
        amount: "-100",
      }),
    ]);
    const result = await plan(
      dto({
        bankTransactionId: undefined,
        sharedBankAmount: undefined,
        payments: [
          { bankTransactionId: "bank-row", contributionAmount: "200" },
          { bankTransactionId: "second-row", contributionAmount: "100" },
        ],
      }),
    );
    expect(result.payments.map((payment) => payment.cash)).toEqual([
      "-200.0000",
      "-100.0000",
    ]);
    expect(result.effect.personal).toBe("-100.0000");
    expect(result.effect.position).toBe("200.0000");
    expect(lockAccountsForBalanceWrite).toHaveBeenCalledWith(
      manager,
      ["clearing", "bank", "second-bank"],
      "owner",
    );
    expect(
      jest.mocked(lockAccountsForBalanceWrite).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(lockTransactionRows).mock.invocationCallOrder[0],
    );
    expect(result.breakdown).toBeNull();
  });
  it("refuses a duplicated bank row, an unallocated contribution and mixed single/multiple input", async () => {
    const base = dto({
      bankTransactionId: undefined,
      sharedBankAmount: undefined,
    });
    await expect(
      plan({
        ...base,
        payments: [
          { bankTransactionId: "bank-row", contributionAmount: "200" },
          { bankTransactionId: "bank-row", contributionAmount: "100" },
        ],
      }),
    ).rejects.toThrow("ordinary, unreconciled");
    await expect(
      plan({
        ...base,
        payments: [
          { bankTransactionId: "bank-row", contributionAmount: "200" },
        ],
      }),
    ).rejects.toThrow("entire contribution");
    await expect(
      plan({
        ...base,
        payments: [
          { bankTransactionId: "bank-row" },
          { bankAccountId: "second-bank", bankAmount: "100" },
        ],
      }),
    ).rejects.toThrow("entire contribution");
    await expect(
      plan({ ...dto(), payments: [{ bankTransactionId: "bank-row" }] }),
    ).rejects.toThrow("entire contribution");
  });
  it("allocates the accepted converted penny once across two original-currency payments", async () => {
    const original = sharedEntryFixture();
    jest.mocked(readSharedJournal).mockResolvedValue([
      {
        ...original,
        originalAmount: "0.03",
        groupAmount: "0.01",
        currencyCode: "EUR",
        fxRate: "0.3333333333",
        allocations: original.allocations.map((a) => ({
          ...a,
          originalAmount:
            a.kind === "CONTRIBUTION"
              ? "0.03"
              : a.participantId === "me"
                ? "0.01"
                : "0.02",
          groupAmount:
            a.kind === "CONTRIBUTION" || a.participantId === "anna"
              ? "0.01"
              : "0",
        })),
      },
    ]);
    account = { ...account!, currencyCode: "EUR" };
    jest.mocked(sharedBankRows).mockResolvedValue([
      sourceBank({ amount: "-0.01", currencyCode: "EUR" }),
      sourceBank({
        id: "second-row",
        accountId: "second-bank",
        amount: "-0.02",
        currencyCode: "EUR",
      }),
    ]);
    const result = await plan(
      dto({
        bankTransactionId: undefined,
        sharedBankAmount: undefined,
        payments: [
          { bankTransactionId: "bank-row", contributionAmount: "0.01" },
          { bankTransactionId: "second-row", contributionAmount: "0.02" },
        ],
      }),
    );
    expect(result.payments.map((payment) => payment.cash)).toEqual([
      "0.0000",
      "-0.0100",
    ]);
    expect(
      result.payments.map((payment) => payment.breakdown.agreedPortion),
    ).toEqual(["-0.0100", "-0.0200"]);
    expect(resolve).not.toHaveBeenCalled();
  });
});
