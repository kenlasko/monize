import { NotFoundException, ForbiddenException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  lockAccountsForBalanceWrite,
  lockTransactionRows,
} from "../common/db/locks";
import { AccountsService } from "../accounts/accounts.service";
import { CurrenciesService } from "../currencies/currencies.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SharedFinanceService } from "./shared-finance.service";
import { requireSharedGroup } from "./shared-db";
import { readSharedJournal } from "./shared-journal";
import {
  sharedBankRows,
  sharedIntegration,
  sharedPostings,
  sharedPostingLinks,
} from "./shared-finance-read";
import { planSharedFinance } from "./shared-finance-plan";
import { writeSharedFinance, undoSharedPosting } from "./shared-finance-write";
import { sharedEntryFixture } from "./__fixtures__/shared-entry";
import {
  sharedBankFixture,
  sharedFinancePlanFixture,
  sharedGroup,
  sharedIntegrationFixture,
  sharedPostingFixture,
} from "./__fixtures__/shared-finance";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("../common/db/locks", () => ({
  lockAccountsForBalanceWrite: jest.fn(),
  lockTransactionRows: jest.fn(),
}));
jest.mock("./shared-db", () => ({
  ...jest.requireActual("./shared-db"),
  requireSharedGroup: jest.fn(),
  lockSharedGroup: jest.fn(),
  sharedCommand: jest.fn((_m, _user, _group, _operation, _dto, execute) =>
    execute(),
  ),
}));
jest.mock("./shared-journal", () => ({
  ...jest.requireActual("./shared-journal"),
  readSharedJournal: jest.fn(),
}));
jest.mock("./shared-finance-read", () => ({
  sharedBankRows: jest.fn(),
  sharedIntegration: jest.fn(),
  sharedPostings: jest.fn(),
  sharedPostingLinks: jest.fn(),
}));
jest.mock("./shared-finance-plan", () => ({ planSharedFinance: jest.fn() }));
jest.mock("./shared-finance-write", () => ({
  writeSharedFinance: jest.fn(),
  undoSharedPosting: jest.fn(),
}));
const command = { operationId: "operation", expectedRevision: 2 };

describe("Private shared-finance lifecycle", () => {
  let service: SharedFinanceService;
  let query: jest.Mock;
  let activeTransactions: number;
  let recalc: jest.Mock;
  let fetchRate: jest.Mock;
  let ensureCurrency: jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    activeTransactions = 0;
    query = jest.fn().mockResolvedValue([]);
    const manager = { query } as unknown as EntityManager;
    jest.mocked(withScopedDb).mockImplementation(async (_source, work) => {
      activeTransactions++;
      try {
        return await work(manager);
      } finally {
        activeTransactions--;
      }
    });
    recalc = jest.fn(() => expect(activeTransactions).toBe(0));
    fetchRate = jest.fn().mockResolvedValue(null);
    ensureCurrency = jest.fn().mockResolvedValue(undefined);
    service = new SharedFinanceService(
      {} as DataSource,
      {} as AccountsService,
      { ensureCurrencyForUser: ensureCurrency } as unknown as CurrenciesService,
      { getRateForDate: fetchRate } as unknown as ExchangeRateService,
      { triggerDebouncedRecalc: recalc } as unknown as NetWorthService,
    );
    jest.mocked(requireSharedGroup).mockResolvedValue(sharedGroup());
    jest
      .mocked(sharedIntegration)
      .mockResolvedValue(sharedIntegrationFixture());
    jest.mocked(sharedPostings).mockResolvedValue([]);
    jest.mocked(readSharedJournal).mockResolvedValue([sharedEntryFixture()]);
    jest.mocked(sharedBankRows).mockResolvedValue([sharedBankFixture()]);
    jest.mocked(sharedPostingLinks).mockResolvedValue([
      {
        transactionId: "bank-row",
        kind: "BANK",
        created: false,
        before: sharedBankFixture(),
      },
    ]);
    jest
      .mocked(planSharedFinance)
      .mockResolvedValue(sharedFinancePlanFixture());
    jest.mocked(writeSharedFinance).mockResolvedValue({
      id: "posting",
      affectedAccountIds: ["bank", "settlement"],
    });
    jest.mocked(undoSharedPosting).mockResolvedValue(["bank", "settlement"]);
  });
  it("enables only a claimed person and reuses their existing settlement account", async () => {
    expect(
      await service.enable("owner", "group", {
        ...command,
        accountName: "Trip",
      }),
    ).toEqual({ id: "integration", accountId: "settlement" });
    expect(query).not.toHaveBeenCalled();
    expect(recalc).toHaveBeenCalledWith("settlement", "owner");
    jest
      .mocked(requireSharedGroup)
      .mockResolvedValue({ ...sharedGroup(), myParticipantId: null });
    await expect(
      service.enable("owner", "group", { ...command, accountName: "Trip" }),
    ).rejects.toThrow("claimed participant");
    expect(query).not.toHaveBeenCalled();
  });
  it("creates a zero-balance managed account in the group currency without booking journal entries", async () => {
    jest.mocked(sharedIntegration).mockResolvedValue(null);
    const result = await service.enable("owner", "group", {
      ...command,
      accountName: " Trip ",
    });
    expect(ensureCurrency).toHaveBeenCalledWith("owner", "PLN");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("'SHARED_SETTLEMENT'"),
      [result.accountId, "owner", "Trip", "PLN", "group"],
    );
    expect(writeSharedFinance).not.toHaveBeenCalled();
    expect(recalc).toHaveBeenCalledWith(result.accountId, "owner");
  });
  it("rejects stale activation and an empty account name before writing", async () => {
    await expect(
      service.enable("owner", "group", {
        ...command,
        expectedRevision: 1,
        accountName: "Trip",
      }),
    ).rejects.toThrow("changed while");
    await expect(
      service.enable("owner", "group", { ...command, accountName: " " }),
    ).rejects.toThrow("bank or cash");
    expect(query).not.toHaveBeenCalled();
    expect(recalc).not.toHaveBeenCalled();
  });
  it("marks only changed personal economics for review, including a newly missing rate", async () => {
    jest.mocked(sharedPostings).mockResolvedValue([sharedPostingFixture()]);
    expect((await service.overview("owner", "group")).pendingCount).toBe(0);
    jest
      .mocked(readSharedJournal)
      .mockResolvedValue([
        sharedEntryFixture({ note: "New note", revision: 2 }),
      ]);
    expect((await service.overview("owner", "group")).pendingCount).toBe(0);
    jest
      .mocked(readSharedJournal)
      .mockResolvedValue([
        sharedEntryFixture({ state: "DRAFT", draftReason: "MISSING_RATE" }),
      ]);
    expect((await service.overview("owner", "group")).entries[0]).toMatchObject(
      { effect: null, needsReview: true },
    );
    expect(writeSharedFinance).not.toHaveBeenCalled();
  });
  it("keeps unbooked own costs optional, including in an already connected group", async () => {
    expect((await service.overview("owner", "group")).pendingCount).toBe(0);
    jest.mocked(sharedIntegration).mockResolvedValue(null);
    expect(await service.overview("owner", "group")).toEqual({
      integration: null,
      entries: [],
      pendingCount: 0,
      accessRevoked: false,
    });
  });
  it("keeps accepted private history after revoked access without reading the live journal", async () => {
    jest.mocked(requireSharedGroup).mockRejectedValue(new NotFoundException());
    jest.mocked(sharedPostings).mockResolvedValue([sharedPostingFixture()]);
    const result = await service.overview("owner", "group");
    expect(result).toMatchObject({
      accessRevoked: true,
      pendingCount: 0,
      entries: [{ title: "Dinner", needsReview: false }],
    });
    expect(readSharedJournal).not.toHaveBeenCalled();
    jest.mocked(requireSharedGroup).mockRejectedValue(new ForbiddenException());
    await expect(service.overview("owner", "group")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it("shares the resolved preview, refuses changed acceptance and invalidates balances after commit", async () => {
    const preview = await service.preview("owner", "group", "entry", command);
    expect(preview).toMatchObject({
      fingerprint: "accepted-plan",
      sourceTransactionId: "bank-row",
      settlementCurrency: "PLN",
      effect: { personal: "-100.0000", position: "200.0000" },
    });
    expect(writeSharedFinance).not.toHaveBeenCalled();
    await expect(
      service.book("owner", "group", "entry", {
        ...command,
        previewFingerprint: "old-plan",
      }),
    ).rejects.toThrow("Refresh the preview");
    expect(writeSharedFinance).not.toHaveBeenCalled();
    await expect(
      service.book("owner", "group", "entry", {
        ...command,
        previewFingerprint: preview.fingerprint,
      }),
    ).resolves.toEqual({ id: "posting" });
    expect(recalc.mock.calls).toEqual([
      ["bank", "owner"],
      ["settlement", "owner"],
    ]);
  });
  it.each(["missing", "moved", "reconciled"] as const)(
    "refuses unlink when a source is %s after locking",
    async (failure) => {
      jest.mocked(sharedPostings).mockResolvedValue([sharedPostingFixture()]);
      jest
        .mocked(sharedBankRows)
        .mockResolvedValueOnce([sharedBankFixture()])
        .mockResolvedValueOnce(
          failure === "missing"
            ? []
            : [
                sharedBankFixture(
                  failure === "moved"
                    ? { accountId: "other-bank" }
                    : { status: "RECONCILED" },
                ),
              ],
        );
      await expect(
        service.unlink("owner", "group", "entry", {
          ...command,
          expectedRevision: 1,
        }),
      ).rejects.toThrow();
      expect(undoSharedPosting).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(recalc).not.toHaveBeenCalled();
    },
  );
  it("unlinks private postings after access revocation, locking accounts before transactions", async () => {
    jest.mocked(sharedPostings).mockResolvedValue([sharedPostingFixture()]);
    expect(
      await service.unlink("owner", "group", "entry", {
        ...command,
        expectedRevision: 1,
      }),
    ).toEqual({ id: "posting" });
    expect(requireSharedGroup).not.toHaveBeenCalled();
    expect(
      jest.mocked(lockAccountsForBalanceWrite).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(lockTransactionRows).mock.invocationCallOrder[0],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM shared_postings"),
      ["posting", "owner"],
    );
    expect(recalc).toHaveBeenCalledTimes(2);
  });
  it("refuses an unknown private posting and scopes navigation queries to the caller", async () => {
    await expect(service.postingLocation("owner", "missing")).rejects.toThrow(
      "unavailable",
    );
    query.mockResolvedValue([{ groupId: "group", entryId: "entry" }]);
    expect(await service.postingLocation("owner", "posting")).toEqual({
      groupId: "group",
      entryId: "entry",
    });
    await service.privateGroups("owner");
    expect(
      query.mock.calls.every(([, parameters]) => parameters.includes("owner")),
    ).toBe(true);
  });
  it("fetches third-currency observations outside a scoped transaction, using each bank date", async () => {
    query.mockResolvedValue([{ currency_code: "USD" }]);
    jest
      .mocked(sharedBankRows)
      .mockResolvedValue([
        sharedBankFixture({ currencyCode: "USD", date: "2026-01-02" }),
      ]);
    fetchRate.mockImplementation(async () => {
      expect(activeTransactions).toBe(0);
      return null;
    });
    await service.prepareBankRates("owner", "group", "entry", {
      ...command,
      payments: [
        { bankTransactionId: "bank-row" },
        { bankAccountId: "cash" },
        { bankAccountId: "manual", bankRate: "4.3" },
      ],
    });
    expect(fetchRate.mock.calls).toEqual([
      ["PLN", "USD", "2026-01-02"],
      ["PLN", "USD", "2026-01-01"],
    ]);
    query.mockResolvedValue([{ currency_code: "PLN" }]);
    await service.prepareBankRates("owner", "group", "entry", {
      ...command,
      bankAccountId: "bank",
    });
    expect(fetchRate).toHaveBeenCalledTimes(2);
  });
});
