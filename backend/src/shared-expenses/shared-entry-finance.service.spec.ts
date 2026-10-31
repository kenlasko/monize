import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { AccountsService } from "../accounts/accounts.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SharedEntriesService } from "./shared-entries.service";
import { SharedFinanceService } from "./shared-finance.service";
import { SharedEntryFinanceService } from "./shared-entry-finance.service";
import { SaveSharedEntryFinanceDto } from "./dto/shared-entry-finance.dto";
import { requireSharedGroup, sharedFingerprint } from "./shared-db";
import { publicSharedEntry } from "./shared-journal";
import { planSharedFinance } from "./shared-finance-plan";
import { writeSharedFinance } from "./shared-finance-write";
import { sharedEntryFixture } from "./__fixtures__/shared-entry";
import {
  sharedFinancePlanFixture,
  sharedGroup,
} from "./__fixtures__/shared-finance";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("./shared-db", () => ({
  ...jest.requireActual("./shared-db"),
  requireSharedGroup: jest.fn(),
  lockSharedGroup: jest.fn(),
  sharedCommand: jest.fn((_m, _user, _group, _operation, _dto, execute) =>
    execute(),
  ),
}));
jest.mock("./shared-finance-plan", () => ({ planSharedFinance: jest.fn() }));
jest.mock("./shared-finance-write", () => ({ writeSharedFinance: jest.fn() }));
const entry = {
  ...publicSharedEntry(sharedEntryFixture(), "owner", true, "me"),
  previewFingerprint: "entry-preview",
};
const fingerprint = sharedFingerprint({
  entry: entry.previewFingerprint,
  finance: "accepted-plan",
});
const input = (): SaveSharedEntryFinanceDto => ({
  operationId: "root-operation",
  expectedRevision: 2,
  previewFingerprint: fingerprint,
  entry: {
    operationId: "entry-operation",
    expectedRevision: 0,
    type: "EXPENSE",
    title: "Dinner",
    amount: "300",
    date: "2026-01-01",
    currencyCode: "PLN",
    splitMode: "EQUAL",
    shares: [{ participantId: "me" }, { participantId: "anna" }],
    contributions: [{ participantId: "me", value: "300" }],
  },
  finance: {
    operationId: "finance-operation",
    expectedRevision: 1,
    categoryId: "food",
    bankTransactionId: "bank-row",
  },
});

describe("Combined entry and own-ledger command", () => {
  let service: SharedEntryFinanceService;
  let entries: jest.Mocked<Pick<SharedEntriesService, "preview" | "save">>;
  let finance: jest.Mocked<Pick<SharedFinanceService, "prepareBankRates">>;
  let recalc: jest.Mock;
  let query: jest.Mock;
  let activeTransactions: number;
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
    entries = {
      preview: jest.fn().mockResolvedValue(entry),
      save: jest.fn().mockResolvedValue(entry),
    };
    finance = { prepareBankRates: jest.fn().mockResolvedValue(undefined) };
    recalc = jest.fn(() => expect(activeTransactions).toBe(0));
    service = new SharedEntryFinanceService(
      {} as DataSource,
      entries as unknown as SharedEntriesService,
      finance as unknown as SharedFinanceService,
      {} as ExchangeRateService,
      {} as AccountsService,
      { triggerDebouncedRecalc: recalc } as unknown as NetWorthService,
    );
    jest.mocked(requireSharedGroup).mockResolvedValue(sharedGroup());
    jest
      .mocked(planSharedFinance)
      .mockResolvedValue(sharedFinancePlanFixture());
    jest.mocked(writeSharedFinance).mockResolvedValue({
      id: "posting",
      affectedAccountIds: ["bank", "settlement"],
    });
  });
  it("previews both operations without writing and commits the fingerprint of both accepted plans", async () => {
    const dto = input();
    const preview = await service.preview("owner", "group", dto);
    expect(preview.fingerprint).toBe(fingerprint);
    expect(preview.finance.effect.position).toBe("200.0000");
    expect(entries.save).not.toHaveBeenCalled();
    expect(writeSharedFinance).not.toHaveBeenCalled();
    expect(await service.save("owner", "group", dto)).toEqual({
      entry,
      postingId: "posting",
    });
    expect(entries.save).toHaveBeenCalledWith(
      "owner",
      "group",
      dto.entry,
      undefined,
      true,
    );
    expect(entries.save.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(writeSharedFinance).mock.invocationCallOrder[0],
    );
    expect(recalc.mock.calls).toEqual([
      ["bank", "owner"],
      ["settlement", "owner"],
    ]);
  });
  it.each(["group", "preview", "entry-command"] as const)(
    "rejects a changed %s before either financial write",
    async (changed) => {
      const dto = input();
      if (changed === "group") dto.expectedRevision = 1;
      if (changed === "preview") dto.previewFingerprint = "old";
      if (changed === "entry-command")
        query
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: "entry-operation" }]);
      await expect(service.save("owner", "group", dto)).rejects.toThrow();
      expect(entries.save).not.toHaveBeenCalled();
      expect(writeSharedFinance).not.toHaveBeenCalled();
      expect(recalc).not.toHaveBeenCalled();
    },
  );
  it("requires distinct command IDs before even fetching a proposal", async () => {
    const dto = input();
    dto.operationId = dto.entry.operationId;
    await expect(service.preview("owner", "group", dto)).rejects.toThrow(
      "different data",
    );
    expect(entries.preview).not.toHaveBeenCalled();
    expect(finance.prepareBankRates).not.toHaveBeenCalled();
  });
  it("returns a committed response after a lost reply without fetching rates or posting again", async () => {
    const dto = input();
    query.mockResolvedValue([
      {
        payload_hash: sharedFingerprint({
          ...dto,
          action: "ENTRY_AND_FINANCE",
        }),
        result: { entry, id: "posting", affectedAccountIds: ["bank"] },
      },
    ]);
    expect(await service.save("owner", "group", dto)).toEqual({
      entry,
      postingId: "posting",
    });
    expect(entries.preview).not.toHaveBeenCalled();
    expect(entries.save).not.toHaveBeenCalled();
    expect(finance.prepareBankRates).not.toHaveBeenCalled();
    expect(writeSharedFinance).not.toHaveBeenCalled();
    expect(recalc).toHaveBeenCalledWith("bank", "owner");
  });
  it("rejects the same root operation with changed payload instead of replaying unrelated results", async () => {
    query.mockResolvedValue([
      {
        payload_hash: "another-command",
        result: { entry, id: "posting", affectedAccountIds: [] },
      },
    ]);
    await expect(service.save("owner", "group", input())).rejects.toThrow(
      "different data",
    );
    expect(entries.preview).not.toHaveBeenCalled();
    expect(writeSharedFinance).not.toHaveBeenCalled();
  });
  it("does not dispatch cached balances when the posting fails inside the outer transaction", async () => {
    jest
      .mocked(writeSharedFinance)
      .mockRejectedValue(new Error("write failed"));
    await expect(service.save("owner", "group", input())).rejects.toThrow(
      "write failed",
    );
    expect(recalc).not.toHaveBeenCalled();
  });
});
