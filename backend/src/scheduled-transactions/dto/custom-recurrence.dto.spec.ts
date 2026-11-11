import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { CreateScheduledTransactionDto } from "./create-scheduled-transaction.dto";
import { UpdateScheduledTransactionDto } from "./update-scheduled-transaction.dto";

/**
 * The rule is a plain object, which `whitelist` and `forbidNonWhitelisted` do
 * not descend into, so `@IsCustomRecurrence` is what bounds it. These run the
 * same pipe options as `main.ts`.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const base = {
  accountId: "6f1c0c1e-2b6a-4a57-9d0e-0b3c1f4b7a10",
  name: "Gym",
  amount: -20,
  currencyCode: "CAD",
  frequency: "CUSTOM",
  nextDueDate: "2026-11-16",
};

function run(
  metatype: new () => object,
  body: Record<string, unknown>,
): Promise<unknown> {
  return pipe.transform(body, { type: "body", metatype });
}

describe.each([
  ["CreateScheduledTransactionDto", CreateScheduledTransactionDto],
  ["UpdateScheduledTransactionDto", UpdateScheduledTransactionDto],
])("%s customRecurrence", (_name, dto) => {
  it("accepts a rule and keeps it as sent", async () => {
    const rule = { unit: "WEEK", interval: 1, weekdays: [5, 1, 3] };
    const out = (await run(dto, { ...base, customRecurrence: rule })) as {
      customRecurrence: unknown;
    };
    expect(out.customRecurrence).toEqual(rule);
  });

  it("accepts null, which clears the rule", async () => {
    await expect(
      run(dto, { ...base, frequency: "MONTHLY", customRecurrence: null }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["a nested extra key", { unit: "WEEK", weekdays: [1], extra: { a: 1 } }],
    ["another unit's field", { unit: "WEEK", weekdays: [1], monthDays: [1] }],
    [
      "an unbounded array",
      { unit: "YEAR", dates: new Array(367).fill("01-01") },
    ],
    ["a day February never has", { unit: "YEAR", dates: ["02-30"] }],
    ["a string", "every monday"],
    ["an array", [1, 3, 5]],
  ])("refuses %s", async (_label, customRecurrence) => {
    await expect(
      run(dto, { ...base, customRecurrence }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

it("offers CUSTOM as a frequency", async () => {
  await expect(
    run(CreateScheduledTransactionDto, {
      ...base,
      customRecurrence: { unit: "MONTH", monthDays: [-1] },
    }),
  ).resolves.toBeDefined();
});
