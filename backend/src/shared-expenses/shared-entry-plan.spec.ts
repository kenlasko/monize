import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { SharedEntryDto } from "./dto/shared-entry.dto";
import { planSharedEntry, sharedFinancialShape } from "./shared-entry-plan";
import { readSharedJournal, SharedJournalEntry } from "./shared-journal";
import { SharedGroup, SharedParticipant } from "./shared-types";
import { fixedUnits } from "./shared-money";
import { unchangedAllocationInstructions } from "./shared-unchanged-allocation";

jest.mock("./shared-journal", () => ({
  ...jest.requireActual("./shared-journal"),
  readSharedJournal: jest.fn(),
}));
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: () => "2026-10-25",
}));
const read = jest.mocked(readSharedJournal);
const group: SharedGroup = {
  id: "group",
  ownerUserId: "owner",
  name: "Trip",
  description: null,
  currencyCode: "PLN",
  decimalPlaces: 2,
  revision: 1,
  financialRevision: 1,
  role: "OWNER",
  archivedAt: null,
  myParticipantId: "a",
};
const input = (patch: Partial<SharedEntryDto> = {}): SharedEntryDto => ({
  operationId: "command",
  expectedRevision: 0,
  type: "EXPENSE",
  title: "Dinner",
  amount: "100",
  currencyCode: "PLN",
  date: "2026-01-10",
  splitMode: "EQUAL",
  shares: ["a", "b", "c"].map((participantId) => ({ participantId })),
  contributions: [{ participantId: "a", value: "100" }],
  ...patch,
});
describe("Shared entry planning before any journal mutation", () => {
  let participants: SharedParticipant[];
  let query: jest.Mock;
  let manager: EntityManager;
  let resolve: jest.Mock;
  let rates: ExchangeRateService;
  beforeEach(() => {
    participants = ["a", "b", "c"].map((id) => ({
      id,
      name: id,
      isActive: true,
      connected: false,
      role: null,
    }));
    query = jest.fn(async (sql: string, args: string[]) => {
      if (sql.includes("FROM shared_participants")) return participants;
      if (sql.includes("FROM currencies"))
        return [
          {
            decimal_places:
              ({ JPY: 0, KWD: 3, XTS: 4 } as Record<string, number>)[args[0]] ??
              2,
          },
        ];
      throw new Error(`Unexpected query in planner: ${sql}`);
    });
    manager = { query } as unknown as EntityManager;
    resolve = jest.fn().mockResolvedValue({ rate: null, observedOn: null });
    rates = { resolveStoredRate: resolve } as unknown as ExchangeRateService;
    read.mockReset().mockResolvedValue([]);
  });
  const plan = (dto: SharedEntryDto, previous?: SharedJournalEntry) =>
    planSharedEntry(manager, rates, group, dto, "entry", previous);
  async function accepted(dto = input()): Promise<SharedJournalEntry> {
    const result = await plan(dto);
    return {
      ...result.entry,
      allocations: result.allocations,
      revision: 1,
      financialRevision: 1,
      createdByUserId: "owner",
    };
  }
  it.each(["EQUAL", "WEIGHT", "PERCENT", "EXACT"] as const)(
    "preserves both sums for %s, including a payer outside the split",
    async (splitMode) => {
      const shares =
        splitMode === "EQUAL"
          ? [{ participantId: "b" }, { participantId: "c" }]
          : [
              {
                participantId: "b",
                value: splitMode === "WEIGHT" ? "1" : "25",
              },
              {
                participantId: "c",
                value: splitMode === "WEIGHT" ? "3" : "75",
              },
            ];
      const result = await plan(input({ splitMode, shares }));
      for (const kind of ["SHARE", "CONTRIBUTION"])
        expect(
          result.allocations
            .filter((a) => a.kind === kind)
            .reduce((sum, a) => sum + fixedUnits(a.originalAmount, 4), 0n),
        ).toBe(1000000n);
      expect(result.entry.groupAmount).toBe("100.0000");
      expect(
        result.allocations
          .filter((a) => a.kind === "SHARE")
          .some((a) => a.participantId === "a"),
      ).toBe(false);
      expect(
        query.mock.calls.every(([sql]) => sql.trimStart().startsWith("SELECT")),
      ).toBe(true);
    },
  );
  it.each([
    ["JPY", "100"],
    ["KWD", "1.001"],
    ["XTS", "1.0001"],
  ])("uses %s precision before conversion", async (currencyCode, amount) => {
    const result = await plan(
      input({
        amount,
        currencyCode,
        fxRate: "4.3",
        contributions: [{ participantId: "a", value: amount }],
      }),
    );
    expect(result.entry.fxRate).toBe("4.3000000000");
    expect(
      result.allocations
        .filter((a) => a.kind === "SHARE")
        .reduce((sum, a) => sum + fixedUnits(a.originalAmount, 4), 0n),
    ).toBe(fixedUnits(amount, 4));
  });
  it("keeps missing rates unknown and future entries out of posted balances", async () => {
    const unknown = await plan(input({ currencyCode: "EUR" }));
    expect(unknown.entry).toMatchObject({
      state: "DRAFT",
      draftReason: "MISSING_RATE",
      groupAmount: null,
      fxRate: null,
    });
    expect(unknown.allocations.every((a) => a.groupAmount === null)).toBe(true);
    const future = await plan(input({ date: "2099-01-01" }));
    expect(future.entry).toMatchObject({
      state: "DRAFT",
      draftReason: "FUTURE_DATE",
      groupAmount: "100.0000",
    });
  });
  it("preserves accepted pennies and FX provenance on a note edit despite a newer observed rate", async () => {
    const previous = await accepted(
      input({ currencyCode: "EUR", fxRate: "4.3" }),
    );
    resolve.mockResolvedValue({ rate: 5, observedOn: "2026-01-10" });
    // The accepted rows can have been restored under new IDs, so recalculating
    // even an equal split could choose a different recipient of the last cent.
    const dto = input({
      currencyCode: "EUR",
      note: "New note",
      shares: [...input().shares].reverse(),
    });
    const updated = await plan(dto, previous);
    expect(updated.allocations).toEqual(previous.allocations);
    expect(updated.entry).toMatchObject({
      fxRate: "4.3000000000",
      fxSource: "MANUAL",
      note: "New note",
    });
    expect(sharedFinancialShape(updated)).toEqual(
      sharedFinancialShape({
        entry: previous,
        allocations: previous.allocations,
      }),
    );
  });
  it("detects changed instructions without mistaking decimal formatting for a financial change", async () => {
    const dto = input({
      splitMode: "EXACT",
      shares: [{ participantId: "a", value: "100" }],
    });
    const previous = await accepted(dto);
    expect(
      unchangedAllocationInstructions(
        { ...dto, shares: [{ participantId: "a", value: "100.0000" }] },
        previous,
      ),
    ).toBe(true);
    expect(
      unchangedAllocationInstructions(
        { ...dto, shares: [{ participantId: "b", value: "100" }] },
        previous,
      ),
    ).toBe(false);
    expect(
      unchangedAllocationInstructions(
        { ...dto, shares: [dto.shares[0], dto.shares[0]] },
        previous,
      ),
    ).toBe(false);
    expect(
      unchangedAllocationInstructions({ ...dto, splitMode: "EQUAL" }, previous),
    ).toBe(false);
  });
  it("retains inactive participants on existing entries but refuses them on a new bill", async () => {
    const previous = await accepted();
    participants = participants.map((p) => ({ ...p, isActive: p.id !== "c" }));
    await expect(plan(input())).rejects.toBeInstanceOf(BadRequestException);
    expect(
      (await plan(input({ note: "Old receipt" }), previous)).allocations,
    ).toEqual(previous.allocations);
  });
  it.each([
    { title: " " },
    { shares: [{ participantId: "outsider" }] },
    { sourceEntryId: "source" },
    { fromParticipantId: "a" },
  ])("refuses malformed journal semantics: %j", async (patch) => {
    await expect(plan(input(patch))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it("refuses changing an entry's type or refund source", async () => {
    const previous = await accepted();
    await expect(plan(input({ type: "INCOME" }), previous)).rejects.toThrow(
      "permission",
    );
  });
  it("keeps refunds tied to the expense's frozen rate and remaining participant cap", async () => {
    const original = await accepted(
      input({ currencyCode: "EUR", fxRate: "4.3" }),
    );
    read.mockResolvedValue([{ ...original, id: "original" }]);
    const dto = input({
      type: "REFUND",
      sourceEntryId: "original",
      currencyCode: "EUR",
      fxRate: "9",
      amount: "10",
      shares: [{ participantId: "b" }],
      contributions: [{ participantId: "a", value: "10" }],
    });
    const result = await plan(dto);
    expect(result.entry).toMatchObject({
      groupAmount: "43.0000",
      fxRate: "4.3000000000",
      fxSource: "ORIGINAL_REFUND",
    });
    await expect(
      plan({
        ...dto,
        amount: "90",
        contributions: [{ participantId: "a", value: "90" }],
      }),
    ).rejects.toThrow("refund");
    await expect(plan({ ...dto, date: "2025-01-01" })).rejects.toThrow(
      "posted expense",
    );
  });
  it("checks the current settlement revision and requires explicit overpayment acknowledgement", async () => {
    read.mockResolvedValue([{ ...(await accepted()), id: "original-expense" }]);
    const dto = input({
      type: "REPAYMENT",
      amount: "10",
      shares: [],
      contributions: [],
      fromParticipantId: "b",
      toParticipantId: "a",
      expectedGroupRevision: 1,
    });
    expect((await plan(dto)).allocations).toEqual([]);
    await expect(plan({ ...dto, expectedGroupRevision: 0 })).rejects.toThrow(
      "Balances changed",
    );
    await expect(plan({ ...dto, amount: "100" })).rejects.toThrow(
      "Balances changed",
    );
    expect(
      (await plan({ ...dto, amount: "100", acknowledgeOverpayment: true }))
        .entry.groupAmount,
    ).toBe("100.0000");
    await expect(plan({ ...dto, fromParticipantId: "a" })).rejects.toThrow(
      "different participants",
    );
    read.mockResolvedValue([
      {
        ...(await accepted(input({ currencyCode: "EUR" }))),
        id: "missing-expense",
      },
    ]);
    await expect(plan(dto)).rejects.toThrow("missing rates");
  });
});
