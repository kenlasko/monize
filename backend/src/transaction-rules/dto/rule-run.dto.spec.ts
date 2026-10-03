import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  PreviewDraftRuleDto,
  RuleRunFiltersDto,
  RunTransactionRuleDto,
} from "./rule-run.dto";

// The app's ValidationPipe settings (main.ts): whitelist + forbidNonWhitelisted.
const check = async <T extends object>(cls: new () => T, plain: object) => {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property).sort();
};

const UUID = "a0000000-0000-4000-8000-000000000001";

describe("RuleRunFiltersDto", () => {
  it("accepts no filter at all and a full one", async () => {
    expect(await check(RuleRunFiltersDto, {})).toEqual([]);
    expect(
      await check(RuleRunFiltersDto, {
        accountIds: [UUID],
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        limit: 1000,
      }),
    ).toEqual([]);
  });

  it.each([0, 1001, 1.5, "10"])("refuses limit %p", async (limit) => {
    expect(await check(RuleRunFiltersDto, { limit })).toEqual(["limit"]);
  });

  it("refuses ids that are not UUIDs, repeated ids and too many ids", async () => {
    expect(await check(RuleRunFiltersDto, { accountIds: ["x"] })).toEqual([
      "accountIds",
    ]);
    expect(
      await check(RuleRunFiltersDto, { accountIds: [UUID, UUID] }),
    ).toEqual(["accountIds"]);
    const many = Array.from(
      { length: 101 },
      (_, i) => `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(await check(RuleRunFiltersDto, { accountIds: many })).toEqual([
      "accountIds",
    ]);
  });

  it("refuses a date that is not a calendar day", async () => {
    expect(
      await check(RuleRunFiltersDto, {
        startDate: "2026-02-30",
        endDate: "tomorrow",
      }),
    ).toEqual(["endDate", "startDate"]);
  });

  it("refuses a field that is not part of the contract", async () => {
    expect(await check(RuleRunFiltersDto, { userId: UUID })).toEqual([
      "userId",
    ]);
  });
});

describe("RunTransactionRuleDto", () => {
  it("needs the fingerprint of the preview, as 64 hex characters", async () => {
    expect(await check(RunTransactionRuleDto, {})).toEqual(["fingerprint"]);
    expect(await check(RunTransactionRuleDto, { fingerprint: "abc" })).toEqual([
      "fingerprint",
    ]);
    expect(
      await check(RunTransactionRuleDto, { fingerprint: "A".repeat(64) }),
    ).toEqual(["fingerprint"]);
    expect(
      await check(RunTransactionRuleDto, {
        fingerprint: "a1".repeat(32),
        limit: 10,
      }),
    ).toEqual([]);
  });
});

describe("PreviewDraftRuleDto", () => {
  const draft = () => ({ condition: {}, actions: [] });

  it("checks the shape only; the content is the service's", async () => {
    expect(await check(PreviewDraftRuleDto, draft())).toEqual([]);
    expect(
      await check(PreviewDraftRuleDto, {
        ...draft(),
        filters: { limit: 5 },
      }),
    ).toEqual([]);
  });

  it("refuses a missing condition, a non-array of actions and too many actions", async () => {
    expect(await check(PreviewDraftRuleDto, { actions: [] })).toEqual([
      "condition",
    ]);
    expect(
      await check(PreviewDraftRuleDto, { condition: {}, actions: {} }),
    ).toEqual(["actions"]);
    expect(
      await check(PreviewDraftRuleDto, {
        condition: {},
        actions: Array.from({ length: 11 }, () => ({})),
      }),
    ).toEqual(["actions"]);
  });

  it("validates the nested filters", async () => {
    expect(
      await check(PreviewDraftRuleDto, { ...draft(), filters: { limit: 0 } }),
    ).toEqual(["filters"]);
  });

  it("accepts the draft's active window as real dates, null or blank", async () => {
    for (const window of [
      { activeFrom: "2026-10-01" },
      { activeTo: "2026-12-31" },
      { activeFrom: null, activeTo: null },
      { activeFrom: "", activeTo: "" },
    ]) {
      expect(
        await check(PreviewDraftRuleDto, { ...draft(), ...window }),
      ).toEqual([]);
    }
  });

  it.each(["2026-02-31", "10/01/2026", 5])(
    "refuses the window side %p",
    async (bad) => {
      expect(
        await check(PreviewDraftRuleDto, { ...draft(), activeFrom: bad }),
      ).toEqual(["activeFrom"]);
      expect(
        await check(PreviewDraftRuleDto, { ...draft(), activeTo: bad }),
      ).toEqual(["activeTo"]);
    },
  );
});
