import { BadRequestException, Type } from "@nestjs/common";
import { createGlobalValidationPipe } from "../../common/pipes/global-validation.pipe";
import { CreateTransactionDto } from "./create-transaction.dto";
import { UpdateTransactionDto } from "./update-transaction.dto";
import { CreateTransferDto } from "./create-transfer.dto";
import { UpdateTransferDto } from "./update-transfer.dto";
import { ConvertToTransferDto } from "./convert-to-transfer.dto";
import { BulkUpdateDto } from "./bulk-update.dto";
import { BulkCreateTransactionsDto } from "./bulk-create.dto";
import { UpdateSplitsDto } from "./update-splits.dto";

/**
 * Design P2 of docs/future-plans/provisional-amounts.md: whether an amount is
 * provisional is never accepted from a request body. Only the importer sets
 * the flag, and only the confirm action, a transfer edit that restates the
 * leg's amount and the paths that end a leg's life clear it. Each body below
 * passes the pipe `main.ts` installs on its own and is refused with the field
 * added, so the refusal is the field's and not the fixture's.
 */
describe("amountIsProvisional is refused from every transaction body (design P2)", () => {
  const pipe = createGlobalValidationPipe();
  const ACCOUNT = "11111111-1111-4111-8111-111111111111";
  const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";
  const ROW = "33333333-3333-4333-8333-333333333333";

  const transaction = {
    accountId: ACCOUNT,
    transactionDate: "2026-01-15",
    amount: -80,
    currencyCode: "EUR",
  };
  const transfer = {
    fromAccountId: ACCOUNT,
    toAccountId: OTHER_ACCOUNT,
    transactionDate: "2026-01-15",
    amount: 100,
    fromCurrencyCode: "USD",
  };
  const transferLine = { transferAccountId: OTHER_ACCOUNT, amount: -80 };

  const bodies: [string, Type<unknown>, Record<string, unknown>][] = [
    ["create transaction", CreateTransactionDto, transaction],
    ["update transaction", UpdateTransactionDto, { description: "Edited" }],
    ["create transfer", CreateTransferDto, transfer],
    ["update transfer", UpdateTransferDto, { toAmount: 90 }],
    ["convert to transfer", ConvertToTransferDto, transfer],
    [
      "bulk update",
      BulkUpdateDto,
      { mode: "ids", transactionIds: [ROW], description: "Edited" },
    ],
  ];

  it.each(bodies)("%s", async (_label, metatype, body) => {
    const metadata = { type: "body" as const, metatype, data: "" };

    await expect(pipe.transform(body, metadata)).resolves.toBeDefined();
    for (const value of [true, false]) {
      await expect(
        pipe.transform({ ...body, amountIsProvisional: value }, metadata),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  // The flag belongs to a row, and a nested row or line is a body too.
  const nested: [string, Type<unknown>, (extra: object) => object][] = [
    [
      "bulk create, on a row",
      BulkCreateTransactionsDto,
      (extra) => ({ items: [{ transaction: { ...transaction, ...extra } }] }),
    ],
    [
      "bulk create, on a transfer",
      BulkCreateTransactionsDto,
      (extra) => ({ items: [{ transfer: { ...transfer, ...extra } }] }),
    ],
    [
      "create transaction, on a split line",
      CreateTransactionDto,
      (extra) => ({ ...transaction, splits: [{ ...transferLine, ...extra }] }),
    ],
    [
      "update splits, on a line",
      UpdateSplitsDto,
      (extra) => ({ splits: [{ ...transferLine, ...extra }] }),
    ],
  ];

  it.each(nested)("%s", async (_label, metatype, build) => {
    const metadata = { type: "body" as const, metatype, data: "" };

    await expect(pipe.transform(build({}), metadata)).resolves.toBeDefined();
    await expect(
      pipe.transform(build({ amountIsProvisional: true }), metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
