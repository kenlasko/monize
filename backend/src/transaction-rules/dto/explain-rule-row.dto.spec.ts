import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { ExplainRuleRowDto } from "./explain-rule-row.dto";
import {
  MAX_EXPLAIN_ROW_PAYEE_LENGTH,
  MAX_EXPLAIN_ROW_REFERENCE_LENGTH,
  MAX_EXPLAIN_ROW_TAGS,
} from "../transaction-rules.limits";

// The app's ValidationPipe settings (main.ts): whitelist + forbidNonWhitelisted.
const problems = async (plain: object): Promise<string[]> => {
  const walk = (
    errors: Awaited<ReturnType<typeof validate>>,
    path = "",
  ): string[] =>
    errors.flatMap((e) => [
      ...(e.constraints ? [`${path}${e.property}`] : []),
      ...walk(e.children ?? [], `${path}${e.property}.`),
    ]);
  const errors = await validate(plainToInstance(ExplainRuleRowDto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return walk(errors).sort();
};

const UUID = "a0000000-0000-4000-8000-000000000001";
const UUID_2 = "a0000000-0000-4000-8000-000000000002";

const input = (over: object = {}) => ({
  accountId: UUID,
  currencyCode: "PLN",
  amount: "-12.3457",
  isTransfer: false,
  payeeId: null,
  payeeText: "Sklep",
  categoryId: null,
  description: null,
  tagIds: [],
  hasSplits: false,
  ...over,
});
const body = (over: object = {}, trigger = "import") => ({
  trigger,
  input: input(over),
});

describe("ExplainRuleRowDto", () => {
  it("accepts a minimal row and a full one", async () => {
    expect(await problems(body())).toEqual([]);
    expect(
      await problems(
        body({
          fromAccountId: UUID,
          toAccountId: UUID_2,
          payeeId: UUID,
          categoryId: UUID_2,
          tagIds: [UUID, UUID_2],
          referenceNumber: "REF-1",
          transactionDate: "2026-02-28",
          status: "CLEARED",
          hasAttachment: true,
          payeeName: "Sklep",
          amount: -12.5,
          description: "x".repeat(TRANSACTION_NOTE_MAX_LENGTH),
        }),
      ),
    ).toEqual([]);
  });

  it("accepts absent and null optional fields", async () => {
    expect(
      await problems(
        body({
          currencyCode: null,
          amount: null,
          fromAccountId: null,
          referenceNumber: null,
          transactionDate: null,
          status: null,
          payeeName: null,
        }),
      ),
    ).toEqual([]);
    expect(
      await problems({
        trigger: "create",
        input: {
          accountId: UUID,
          isTransfer: false,
          tagIds: [],
          hasSplits: false,
        },
      }),
    ).toEqual([]);
  });

  it.each(["import", "create"])("accepts the trigger %s", async (trigger) => {
    expect(await problems(body({}, trigger))).toEqual([]);
  });

  it.each(["manual", "", null, 1])(
    "refuses the trigger %p",
    async (trigger) => {
      expect(await problems(body({}, trigger as string))).toEqual(["trigger"]);
    },
  );

  it("refuses a missing or non-object input", async () => {
    expect(await problems({ trigger: "import" })).toEqual(["input"]);
    expect(await problems({ trigger: "import", input: null })).toEqual([
      "input",
    ]);
    expect(await problems({ trigger: "import", input: "x" })).toEqual([
      "input",
    ]);
    expect(await problems({ trigger: "import", input: [] })).not.toEqual([]);
  });

  it("refuses a property the row does not have, at either level", async () => {
    expect(await problems({ ...body(), userId: UUID })).toEqual(["userId"]);
    expect(await problems(body({ categoryAncestorIds: [UUID] }))).toEqual([
      "input.categoryAncestorIds",
    ]);
    expect(await problems(body({ userId: UUID }))).toEqual(["input.userId"]);
  });

  it.each([
    ["accountId", "not-a-uuid"],
    ["accountId", ""],
    ["accountId", 5],
    ["payeeId", "x"],
    ["payeeId", ""],
    ["categoryId", "x"],
    ["fromAccountId", "x"],
    ["toAccountId", ""],
  ])("refuses %s = %p", async (field, value) => {
    expect(await problems(body({ [field]: value }))).toEqual([
      `input.${field}`,
    ]);
  });

  it("bounds the tag list and refuses repeated or malformed ids", async () => {
    const ids = (n: number) =>
      Array.from(
        { length: n },
        (_v, i) => `a0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      );
    expect(await problems(body({ tagIds: ids(MAX_EXPLAIN_ROW_TAGS) }))).toEqual(
      [],
    );
    expect(
      await problems(body({ tagIds: ids(MAX_EXPLAIN_ROW_TAGS + 1) })),
    ).toEqual(["input.tagIds"]);
    expect(await problems(body({ tagIds: [UUID, UUID] }))).toEqual([
      "input.tagIds",
    ]);
    expect(await problems(body({ tagIds: ["x"] }))).toEqual(["input.tagIds"]);
    expect(await problems(body({ tagIds: "x" }))).toEqual(["input.tagIds"]);
    expect(await problems(body({ tagIds: undefined }))).toEqual([
      "input.tagIds",
    ]);
  });

  it("bounds every text field at its column's length", async () => {
    const long = (n: number) => "x".repeat(n);
    expect(
      await problems(body({ payeeText: long(MAX_EXPLAIN_ROW_PAYEE_LENGTH) })),
    ).toEqual([]);
    expect(
      await problems(
        body({ payeeText: long(MAX_EXPLAIN_ROW_PAYEE_LENGTH + 1) }),
      ),
    ).toEqual(["input.payeeText"]);
    expect(
      await problems(
        body({ payeeName: long(MAX_EXPLAIN_ROW_PAYEE_LENGTH + 1) }),
      ),
    ).toEqual(["input.payeeName"]);
    expect(
      await problems(
        body({ referenceNumber: long(MAX_EXPLAIN_ROW_REFERENCE_LENGTH + 1) }),
      ),
    ).toEqual(["input.referenceNumber"]);
    expect(
      await problems(
        body({ description: long(TRANSACTION_NOTE_MAX_LENGTH + 1) }),
      ),
    ).toEqual(["input.description"]);
    expect(await problems(body({ payeeText: 5 }))).toEqual(["input.payeeText"]);
  });

  it.each([
    ["-12.3457", true],
    ["0", true],
    ["1234567890123456.1234", true],
    [12.5, true],
    [-0.0001, true],
    [0, true],
    ["12345678901234567", false],
    ["1.12345", true],
    ["0.00002500", true],
    ["1.123456789", false],
    ["1e3", false],
    ["abc", false],
    ["", false],
    [" 1", false],
    [1e17, false],
    [1.00001, true],
    [0.000025, true],
    [1.123456789, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [true, false],
    [{}, false],
    [[1], false],
  ])("amount %p is accepted: %p", async (amount, ok) => {
    expect(await problems(body({ amount }))).toEqual(
      ok ? [] : ["input.amount"],
    );
  });

  it.each(["pln", "PL", "PLNN", "12A", 5, ""])(
    "refuses currencyCode %p",
    async (currencyCode) => {
      expect(await problems(body({ currencyCode }))).toEqual([
        "input.currencyCode",
      ]);
    },
  );

  it.each(["2026-02-30", "2026-2-3", "01/02/2026", "", 20260301])(
    "refuses transactionDate %p",
    async (transactionDate) => {
      expect(await problems(body({ transactionDate }))).toEqual([
        "input.transactionDate",
      ]);
    },
  );

  it.each(["UNRECONCILED", "CLEARED", "RECONCILED", "VOID"])(
    "accepts status %s and refuses any other",
    async (status) => {
      expect(await problems(body({ status }))).toEqual([]);
      expect(await problems(body({ status: "OPEN" }))).toEqual([
        "input.status",
      ]);
      expect(await problems(body({ status: "cleared" }))).toEqual([
        "input.status",
      ]);
    },
  );

  it("refuses a boolean that is not one", async () => {
    expect(await problems(body({ isTransfer: "yes" }))).toEqual([
      "input.isTransfer",
    ]);
    expect(await problems(body({ hasSplits: 1 }))).toEqual(["input.hasSplits"]);
    expect(await problems(body({ hasAttachment: "no" }))).toEqual([
      "input.hasAttachment",
    ]);
    expect(await problems(body({ isTransfer: undefined }))).toEqual([
      "input.isTransfer",
    ]);
  });
});
