import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  QUICK_ADD_TEXT_MAX_LENGTH,
  QuickAddInterpretDto,
} from "./quick-add-interpret.dto";
import { TRANSACTION_PAYEE_NAME_MAX_LENGTH } from "../../dto/create-transaction.dto";

const UUID = "3f2b8c1e-5a7d-4e2f-9b6c-1d2e3f4a5b6c";

async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(QuickAddInterpretDto, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flatten = (list: typeof errors, prefix = ""): string[] =>
    list.flatMap((e) => [
      ...(e.constraints ? [`${prefix}${e.property}`] : []),
      ...flatten(e.children ?? [], `${prefix}${e.property}.`),
    ]);
  return flatten(errors);
}

const valid = { text: "84.37 loblaws", today: "2026-11-20" };

describe("QuickAddInterpretDto", () => {
  it("accepts a line, an empty line and a line at the cap", async () => {
    expect(await errorsFor(valid)).toEqual([]);
    expect(await errorsFor({ ...valid, text: "" })).toEqual([]);
    expect(
      await errorsFor({
        ...valid,
        text: "x".repeat(QUICK_ADD_TEXT_MAX_LENGTH),
      }),
    ).toEqual([]);
  });

  it("refuses a line over the cap, a missing line and a non-string", async () => {
    expect(
      await errorsFor({
        ...valid,
        text: "x".repeat(QUICK_ADD_TEXT_MAX_LENGTH + 1),
      }),
    ).toEqual(["text"]);
    expect(await errorsFor({ today: valid.today })).toEqual(["text"]);
    expect(await errorsFor({ ...valid, text: ["a"] })).toEqual(["text"]);
  });

  it("holds the cap on the line as the reader normalizes it", async () => {
    // U+FDFA is one character sent and eighteen after NFKC.
    expect("\uFDFA".normalize("NFKC")).toHaveLength(18);
    expect(await errorsFor({ ...valid, text: "\uFDFA".repeat(11) })).toEqual(
      [],
    );
    expect(await errorsFor({ ...valid, text: "\uFDFA".repeat(12) })).toEqual([
      "text",
    ]);
    expect(
      await errorsFor({
        ...valid,
        text: "\uFDFA".repeat(QUICK_ADD_TEXT_MAX_LENGTH),
      }),
    ).toEqual(["text"]);
    // Full-width digits fold one for one; runs of spaces count as one.
    expect(
      await errorsFor({
        ...valid,
        text: "\uFF11".repeat(QUICK_ADD_TEXT_MAX_LENGTH),
      }),
    ).toEqual([]);
    expect(
      await errorsFor({
        ...valid,
        text: `12 ${" ".repeat(150)}${"x".repeat(40)}`,
      }),
    ).toEqual([]);
  });

  it("strips angle brackets from the line, as the save does", () => {
    const dto = plainToInstance(QuickAddInterpretDto, {
      ...valid,
      text: "12 <b>shop</b>",
    });
    expect(dto.text).toBe("12 bshop/b");
  });

  it("requires today to be a real calendar date", async () => {
    expect(await errorsFor({ text: "x" })).toEqual(["today"]);
    expect(await errorsFor({ ...valid, today: "2026-02-30" })).toEqual([
      "today",
    ]);
    expect(await errorsFor({ ...valid, today: "20/11/2026" })).toEqual([
      "today",
    ]);
  });

  it("takes a blank optional field as absent", async () => {
    expect(
      await errorsFor({
        ...valid,
        contextAccountId: "",
        pins: {
          kind: null,
          amount: "",
          date: "",
          accountId: null,
          toAccountId: "",
          payeeId: "",
          payeeName: "",
          categoryId: null,
        },
      }),
    ).toEqual([]);
  });

  it("validates each pin's format", async () => {
    expect(
      await errorsFor({
        ...valid,
        contextAccountId: "not-a-uuid",
        pins: {
          kind: "refund",
          date: "2026-13-01",
          accountId: "x",
          toAccountId: "x",
          payeeId: "x",
          categoryId: "x",
        },
      }),
    ).toEqual([
      "contextAccountId",
      "pins.kind",
      "pins.date",
      "pins.accountId",
      "pins.toAccountId",
      "pins.payeeId",
      "pins.categoryId",
    ]);
    expect(
      await errorsFor({
        ...valid,
        contextAccountId: UUID,
        pins: { kind: "transfer", accountId: UUID, toAccountId: UUID },
      }),
    ).toEqual([]);
  });

  it("bounds a pinned amount like a transaction amount, as a magnitude", async () => {
    const amount = async (value: unknown) =>
      errorsFor({ ...valid, pins: { amount: value } });
    expect(await amount(12.5)).toEqual([]);
    expect(await amount(0.00000005)).toEqual([]);
    expect(await amount(999999999999)).toEqual([]);
    expect(await amount(0)).toEqual(["pins.amount"]);
    expect(await amount(-5)).toEqual(["pins.amount"]);
    expect(await amount(1000000000000)).toEqual(["pins.amount"]);
    expect(await amount(1.123456789)).toEqual(["pins.amount"]);
  });

  it("bounds a pinned payee name like a transaction's", async () => {
    expect(
      await errorsFor({
        ...valid,
        pins: { payeeName: "x".repeat(TRANSACTION_PAYEE_NAME_MAX_LENGTH) },
      }),
    ).toEqual([]);
    expect(
      await errorsFor({
        ...valid,
        pins: { payeeName: "x".repeat(TRANSACTION_PAYEE_NAME_MAX_LENGTH + 1) },
      }),
    ).toEqual(["pins.payeeName"]);
  });

  it("takes the fields a reader cleared, each at most once in name", async () => {
    const clear = async (value: unknown) =>
      errorsFor({ ...valid, pins: { clear: value } });
    expect(await clear(["payee"])).toEqual([]);
    expect(await clear(["payee", "category"])).toEqual([]);
    expect(await clear([])).toEqual([]);
    expect(await clear(null)).toEqual([]);
    expect(await clear(["memo"])).toEqual(["pins.clear"]);
    expect(await clear(["payee", "category", "payee"])).toEqual(["pins.clear"]);
    expect(await clear("payee")).toEqual(["pins.clear"]);
    expect(await clear([["payee"]])).toEqual(["pins.clear"]);
  });

  it("refuses pins that are not one object", async () => {
    expect(
      await errorsFor({ ...valid, pins: [{ kind: "payment" }] }),
    ).toContain("pins");
    expect(await errorsFor({ ...valid, pins: "payment" })).toContain("pins");
    expect(await errorsFor({ ...valid, pins: {} })).toEqual([]);
    expect(await errorsFor({ ...valid, pins: null })).toEqual([]);
  });

  it("strips angle brackets from a pinned payee name, as the save does", () => {
    const dto = plainToInstance(QuickAddInterpretDto, {
      ...valid,
      pins: { payeeName: "<b>Corner</b> Store" },
    });
    expect(dto.pins?.payeeName).toBe("bCorner/b Store");
  });

  it("refuses a field it does not declare", async () => {
    expect(await errorsFor({ ...valid, userId: UUID })).toEqual(["userId"]);
    expect(await errorsFor({ ...valid, pins: { memo: "x" } })).toEqual([
      "pins.memo",
    ]);
  });
});
