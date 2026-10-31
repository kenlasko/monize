import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { SharedEntriesService } from "./shared-entries.service";
import {
  requireSharedGroup,
  currencyPlaces,
  sharedActivity,
  advanceSharedRevision,
  sharedCommand,
} from "./shared-db";
import { readSharedJournal } from "./shared-journal";
import { planSharedEntry } from "./shared-entry-plan";
import { writeSharedEntry } from "./shared-entry-write";
import { sharedGroupFixture } from "./__fixtures__/shared-group";
import { sharedEntryFixture } from "./__fixtures__/shared-entry";
import type { SharedEntryDto } from "./dto/shared-entry.dto";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: () => "2026-10-26",
}));
jest.mock("./shared-db", () => ({
  ...jest.requireActual("./shared-db"),
  requireSharedGroup: jest.fn(),
  currencyPlaces: jest.fn(),
  sharedActivity: jest.fn(),
  lockSharedGroup: jest.fn(),
  advanceSharedRevision: jest.fn(),
  sharedCommand: jest.fn((_m, _u, _g, _id, _dto, work) => work()),
}));
jest.mock("./shared-journal", () => ({
  ...jest.requireActual("./shared-journal"),
  readSharedJournal: jest.fn(),
}));
jest.mock("./shared-entry-plan", () => ({
  ...jest.requireActual("./shared-entry-plan"),
  planSharedEntry: jest.fn(),
}));
jest.mock("./shared-entry-write", () => ({ writeSharedEntry: jest.fn() }));

describe("Shared journal review and financial revision boundaries", () => {
  let service: SharedEntriesService;
  let query: jest.Mock;
  let fetchRate: jest.Mock;
  const dto = (patch: Partial<SharedEntryDto> = {}): SharedEntryDto => ({
    operationId: "operation",
    expectedRevision: 0,
    type: "EXPENSE",
    title: "Dinner",
    amount: "300",
    currencyCode: "PLN",
    date: "2026-01-01",
    splitMode: "EXACT",
    shares: [
      { participantId: "me", value: "100" },
      { participantId: "anna", value: "200" },
    ],
    contributions: [{ participantId: "me", value: "300" }],
    ...patch,
  });
  const plan = (patch: Parameters<typeof sharedEntryFixture>[0] = {}) => {
    const entry = sharedEntryFixture(patch);
    return { entry, allocations: entry.allocations };
  };
  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue([]);
    fetchRate = jest.fn().mockResolvedValue(4.3);
    jest
      .mocked(withScopedDb)
      .mockImplementation((_s, work) =>
        work({ query } as unknown as EntityManager),
      );
    jest.mocked(requireSharedGroup).mockResolvedValue(sharedGroupFixture());
    jest.mocked(currencyPlaces).mockResolvedValue(2);
    jest.mocked(readSharedJournal).mockResolvedValue([]);
    jest.mocked(planSharedEntry).mockResolvedValue(plan());
    service = new SharedEntriesService(
      {} as DataSource,
      { getRateForDate: fetchRate } as unknown as ExchangeRateService,
    );
  });
  const expectNoWrite = () => {
    expect(writeSharedEntry).not.toHaveBeenCalled();
    expect(sharedActivity).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  };
  it("reads a public entry and own effect without exposing the author's user ID", async () => {
    jest.mocked(readSharedJournal).mockResolvedValue([sharedEntryFixture()]);
    const result = await service.get("owner", "group", "entry");
    expect(result).not.toHaveProperty("createdByUserId");
    expect(result).toMatchObject({
      id: "entry",
      canEdit: true,
      ownEffect: { personal: "-100.0000" },
    });
    expect(withScopedDb).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      "REPEATABLE READ",
    );
  });
  it("does not reveal a missing entry", async () => {
    await expect(
      service.get("owner", "group", "missing"),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("previews the same plan without a command receipt, activity or financial write", async () => {
    const result = await service.preview("owner", "group", dto());
    expect(result).toMatchObject({
      preview: true,
      revision: 1,
      financialRevision: 1,
    });
    expect(result.previewFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(sharedCommand).not.toHaveBeenCalled();
    expectNoWrite();
  });
  it("saves the accepted preview and names all affected participants", async () => {
    const preview = await service.preview(
      "owner",
      "group",
      dto(),
      undefined,
      true,
    );
    const result = await service.save(
      "owner",
      "group",
      dto({ previewFingerprint: preview.previewFingerprint }),
      undefined,
      true,
    );
    expect(result).toMatchObject({
      preview: false,
      revision: 1,
      financialRevision: 1,
    });
    expect(writeSharedEntry).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      expect.anything(),
      false,
      true,
    );
    expect(sharedActivity).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "group",
      "ENTRY_CREATED",
      expect.objectContaining({
        affectedParticipantIds: ["me", "anna"],
        previous: null,
      }),
      "entry",
    );
  });
  it("rejects a changed preview before writing", async () => {
    await expect(
      service.save(
        "owner",
        "group",
        dto({ previewFingerprint: "0".repeat(64) }),
        undefined,
        true,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expectNoWrite();
  });
  it.each(["missing", "reversed", "other-author", "stale"])(
    "refuses a %s edit before planning or writing",
    async (kind) => {
      jest
        .mocked(requireSharedGroup)
        .mockResolvedValue(sharedGroupFixture({ role: "EDITOR" }));
      jest.mocked(readSharedJournal).mockResolvedValue(
        kind === "missing"
          ? []
          : [
              sharedEntryFixture({
                state: kind === "reversed" ? "REVERSED" : "POSTED",
                createdByUserId: kind === "other-author" ? "other" : "owner",
              }),
            ],
      );
      await expect(
        service.save(
          "owner",
          "group",
          dto({ expectedRevision: kind === "stale" ? 0 : 1 }),
          "entry",
          true,
        ),
      ).rejects.toThrow();
      expect(planSharedEntry).not.toHaveBeenCalled();
      expectNoWrite();
    },
  );
  it("keeps the financial revision on note-only edits, even after a refund", async () => {
    jest.mocked(readSharedJournal).mockResolvedValue([
      sharedEntryFixture(),
      sharedEntryFixture({
        id: "refund",
        type: "REFUND",
        sourceEntryId: "entry",
      }),
    ]);
    jest
      .mocked(planSharedEntry)
      .mockResolvedValue(plan({ note: "Receipt note" }));
    const result = await service.save(
      "owner",
      "group",
      dto({ expectedRevision: 1, note: "Receipt note" }),
      "entry",
      true,
    );
    expect(result).toMatchObject({ revision: 2, financialRevision: 1 });
    expect(writeSharedEntry).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      expect.anything(),
      true,
      false,
    );
    expect(advanceSharedRevision).toHaveBeenCalledWith(
      expect.anything(),
      "group",
      false,
    );
    expect(sharedActivity).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "group",
      "ENTRY_UPDATED",
      expect.objectContaining({
        previous: expect.objectContaining({ title: "Dinner" }),
      }),
      "entry",
    );
  });
  it("refuses financial edits of a refunded source but permits them after refund reversal", async () => {
    const refund = sharedEntryFixture({
      id: "refund",
      type: "REFUND",
      sourceEntryId: "entry",
    });
    jest
      .mocked(readSharedJournal)
      .mockResolvedValue([sharedEntryFixture(), refund]);
    jest
      .mocked(planSharedEntry)
      .mockResolvedValue(plan({ date: "2026-01-02" }));
    await expect(
      service.save(
        "owner",
        "group",
        dto({ expectedRevision: 1 }),
        "entry",
        true,
      ),
    ).rejects.toThrow();
    expectNoWrite();
    jest
      .mocked(readSharedJournal)
      .mockResolvedValue([
        sharedEntryFixture(),
        { ...refund, state: "REVERSED" },
      ]);
    expect(
      await service.save(
        "owner",
        "group",
        dto({ expectedRevision: 1 }),
        "entry",
        true,
      ),
    ).toMatchObject({ financialRevision: 2 });
  });
  it.each([
    { fxRate: "4.3", currencyCode: "EUR" },
    { sourceEntryId: "source", type: "REFUND" as const },
    { date: "2026-10-27" },
    { currencyCode: "PLN" },
  ])(
    "does not fetch a provider rate for an explicit, refund, future or same-currency tuple: %j",
    async (patch) => {
      await service.prepareRates("owner", "group", dto(patch));
      expect(fetchRate).not.toHaveBeenCalled();
    },
  );
  it("keeps an accepted foreign rate when only notes change", async () => {
    jest
      .mocked(readSharedJournal)
      .mockResolvedValue([
        sharedEntryFixture({ currencyCode: "EUR", fxRate: "4.3" }),
      ]);
    await service.prepareRates(
      "owner",
      "group",
      dto({ currencyCode: "EUR", note: "Changed" }),
      "entry",
    );
    expect(fetchRate).not.toHaveBeenCalled();
  });
  it("fetches only the requested pair and date when a foreign tuple changes", async () => {
    jest
      .mocked(readSharedJournal)
      .mockResolvedValue([
        sharedEntryFixture({ currencyCode: "EUR", fxRate: "4.3" }),
      ]);
    await service.prepareRates(
      "owner",
      "group",
      dto({ currencyCode: "EUR", amount: "301" }),
      "entry",
    );
    expect(fetchRate).toHaveBeenCalledWith("EUR", "PLN", "2026-01-01");
  });
  it.each([
    "missing",
    "reversed",
    "other-author",
    "stale",
    "empty-reason",
    "refunded",
  ])("refuses a %s reversal before any write", async (kind) => {
    jest
      .mocked(requireSharedGroup)
      .mockResolvedValue(sharedGroupFixture({ role: "EDITOR" }));
    const entry = sharedEntryFixture({
      state: kind === "reversed" ? "REVERSED" : "POSTED",
      createdByUserId: kind === "other-author" ? "other" : "owner",
    });
    jest.mocked(readSharedJournal).mockResolvedValue(
      kind === "missing"
        ? []
        : [
            entry,
            ...(kind === "refunded"
              ? [
                  sharedEntryFixture({
                    id: "refund",
                    sourceEntryId: "entry",
                    type: "REFUND",
                  }),
                ]
              : []),
          ],
    );
    await expect(
      service.reverse("owner", "group", "entry", {
        operationId: "reverse",
        expectedRevision: kind === "stale" ? 0 : 1,
        reason: kind === "empty-reason" ? "  " : "Duplicate",
      }),
    ).rejects.toThrow();
    expectNoWrite();
  });
  it("reverses with a reason, keeps the entry and includes both repayment participants in the activity", async () => {
    jest.mocked(readSharedJournal).mockResolvedValue([
      sharedEntryFixture({
        type: "REPAYMENT",
        fromParticipantId: "anna",
        toParticipantId: "me",
        allocations: [],
      }),
    ]);
    expect(
      await service.reverse("owner", "group", "entry", {
        operationId: "reverse",
        expectedRevision: 1,
        reason: " Duplicate ",
      }),
    ).toEqual({ id: "entry", revision: 2 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("state = 'REVERSED'"),
      ["entry", "group", "Duplicate"],
    );
    expect(sharedActivity).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "group",
      "ENTRY_REVERSED",
      expect.objectContaining({ affectedParticipantIds: ["anna", "me"] }),
      "entry",
    );
    expect(advanceSharedRevision).toHaveBeenCalledWith(
      expect.anything(),
      "group",
      true,
    );
  });
});
