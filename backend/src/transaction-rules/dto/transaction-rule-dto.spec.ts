import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateTransactionRuleDto } from "./create-transaction-rule.dto";
import { UpdateTransactionRuleDto } from "./update-transaction-rule.dto";
import { ReorderTransactionRulesDto } from "./reorder-transaction-rules.dto";
import { SetTransactionRuleEnabledDto } from "./set-transaction-rule-enabled.dto";

const valid = () => ({
  name: "Groceries",
  triggers: ["create"],
  condition: { field: "hasSplits", op: "eq", value: true },
  actions: [{ type: "add_tags", tagIds: [] }],
});

// The app's ValidationPipe settings (main.ts): whitelist + forbidNonWhitelisted.
const check = async <T extends object>(cls: new () => T, plain: object) => {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, fields: errors.map((e) => e.property).sort() };
};

describe("CreateTransactionRuleDto", () => {
  it("accepts a well-shaped rule without judging its content", async () => {
    // tagIds: [] is refused by validateRuleDefinition, not by the DTO.
    expect((await check(CreateTransactionRuleDto, valid())).fields).toEqual([]);
  });

  it("trims the name and strips angle brackets", async () => {
    const { instance, fields } = await check(CreateTransactionRuleDto, {
      ...valid(),
      name: "  <b>Rent</b>  ",
    });
    expect(fields).toEqual([]);
    expect(instance.name).toBe("bRent/b");
  });

  it.each([
    ["empty after trimming", "   "],
    ["over 100 characters", "x".repeat(101)],
    ["not a string", 5],
  ])("refuses a name that is %s", async (_label, name) => {
    expect(
      (await check(CreateTransactionRuleDto, { ...valid(), name })).fields,
    ).toEqual(["name"]);
  });

  it("accepts a 100 character name", async () => {
    expect(
      (
        await check(CreateTransactionRuleDto, {
          ...valid(),
          name: "x".repeat(100),
        })
      ).fields,
    ).toEqual([]);
  });

  it.each([
    ["empty", []],
    ["unknown", ["manual"]],
    ["repeated", ["create", "create"]],
    ["too many", ["create", "import", "create"]],
    ["not an array", "create"],
  ])("refuses triggers that are %s", async (_label, triggers) => {
    expect(
      (await check(CreateTransactionRuleDto, { ...valid(), triggers })).fields,
    ).toEqual(["triggers"]);
  });

  it("accepts both triggers", async () => {
    expect(
      (
        await check(CreateTransactionRuleDto, {
          ...valid(),
          triggers: ["import", "create"],
        })
      ).fields,
    ).toEqual([]);
  });

  it.each([
    ["an array", []],
    ["a string", "all"],
    ["null", null],
  ])("refuses a condition that is %s", async (_label, condition) => {
    expect(
      (await check(CreateTransactionRuleDto, { ...valid(), condition })).fields,
    ).toEqual(["condition"]);
  });

  it("bounds the actions array", async () => {
    const eleven = Array.from({ length: 11 }, () => ({ type: "add_tags" }));
    expect(
      (await check(CreateTransactionRuleDto, { ...valid(), actions: eleven }))
        .fields,
    ).toEqual(["actions"]);
    expect(
      (await check(CreateTransactionRuleDto, { ...valid(), actions: "x" }))
        .fields,
    ).toEqual(["actions"]);
  });

  it("refuses an unknown property", async () => {
    expect(
      (await check(CreateTransactionRuleDto, { ...valid(), userId: "u2" }))
        .fields,
    ).toEqual(["userId"]);
  });

  it("checks the optional flags when present", async () => {
    expect(
      (
        await check(CreateTransactionRuleDto, {
          ...valid(),
          enabled: "yes",
          stopProcessing: 1,
        })
      ).fields,
    ).toEqual(["enabled", "stopProcessing"]);
  });
});

describe("the active window on create and update", () => {
  it.each([CreateTransactionRuleDto, UpdateTransactionRuleDto])(
    "%p accepts real dates, null and an absent window",
    async (cls) => {
      const base = cls === UpdateTransactionRuleDto ? { revision: 1 } : {};
      for (const window of [
        {},
        { activeFrom: "2026-10-01" },
        { activeTo: "2026-12-31" },
        { activeFrom: "2026-10-01", activeTo: "2026-10-01" },
        { activeFrom: null, activeTo: null },
        { activeFrom: "", activeTo: "" },
        { activeFrom: "2024-02-29" },
      ]) {
        expect(
          (await check(cls as never, { ...valid(), ...base, ...window }))
            .fields,
        ).toEqual([]);
      }
    },
  );

  it.each([
    ["not a real day", "2026-02-31"],
    ["a month 13", "2026-13-01"],
    ["the wrong shape", "01.10.2026"],
    ["a timestamp", "2026-10-01T00:00:00Z"],
    ["a number", 20261001],
  ])("refuses a side that is %s", async (_label, bad) => {
    for (const field of ["activeFrom", "activeTo"]) {
      expect(
        (await check(CreateTransactionRuleDto, { ...valid(), [field]: bad }))
          .fields,
      ).toEqual([field]);
      expect(
        (
          await check(UpdateTransactionRuleDto, {
            ...valid(),
            revision: 1,
            [field]: bad,
          })
        ).fields,
      ).toEqual([field]);
    }
  });

  it("leaves the order of the two sides to the service, which holds the stored side too", async () => {
    expect(
      (
        await check(CreateTransactionRuleDto, {
          ...valid(),
          activeFrom: "2026-12-31",
          activeTo: "2026-10-01",
        })
      ).fields,
    ).toEqual([]);
  });
});

describe("UpdateTransactionRuleDto", () => {
  it("requires the revision", async () => {
    expect(
      (await check(UpdateTransactionRuleDto, { name: "x" })).fields,
    ).toEqual(["revision"]);
  });

  it.each([0, -1, 1.5, "abc", 2147483648])(
    "refuses revision %p",
    async (revision) => {
      expect(
        (await check(UpdateTransactionRuleDto, { revision })).fields,
      ).toEqual(["revision"]);
    },
  );

  it("accepts any subset of the create fields with a revision", async () => {
    expect(
      (await check(UpdateTransactionRuleDto, { revision: 2, enabled: false }))
        .fields,
    ).toEqual([]);
  });

  it("still applies the create rules to the fields it carries", async () => {
    expect(
      (
        await check(UpdateTransactionRuleDto, {
          revision: 2,
          name: "",
          triggers: [],
        })
      ).fields,
    ).toEqual(["name", "triggers"]);
  });
});

describe("ReorderTransactionRulesDto", () => {
  const id = (n: number) =>
    `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("accepts up to 200 distinct uuids", async () => {
    const ids = Array.from({ length: 200 }, (_v, i) => id(i));
    expect((await check(ReorderTransactionRulesDto, { ids })).fields).toEqual(
      [],
    );
  });

  it.each([
    ["201 ids", Array.from({ length: 201 }, (_v, i) => id(i))],
    ["a repeated id", [id(1), id(1)]],
    ["a non-uuid", ["nope"]],
    ["a non-array", "x"],
  ])("refuses %s", async (_label, ids) => {
    expect((await check(ReorderTransactionRulesDto, { ids })).fields).toEqual([
      "ids",
    ]);
  });
});

describe("SetTransactionRuleEnabledDto", () => {
  it("needs a boolean", async () => {
    expect(
      (await check(SetTransactionRuleEnabledDto, { enabled: true })).fields,
    ).toEqual([]);
    expect(
      (await check(SetTransactionRuleEnabledDto, { enabled: "true" })).fields,
    ).toEqual(["enabled"]);
    expect((await check(SetTransactionRuleEnabledDto, {})).fields).toEqual([
      "enabled",
    ]);
  });
});
