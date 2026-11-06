import "reflect-metadata";
import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { UpdateScheduledTransactionOverrideDto } from "./scheduled-transaction-override.dto";

// Issue #1167 R8: an override investment split's source identity must be a real
// server UUID (R8-F1) -- a synthetic React key like `override-0` must never reach
// the API -- and a new line may carry `rateExplicit` (R8-F2). These run the
// payload through the ACTUAL production ValidationPipe (whitelist +
// forbidNonWhitelisted + transform), the same config main.ts installs.
describe("UpdateScheduledTransactionOverrideDto — split identity contract (R8)", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const metadata = {
    type: "body" as const,
    metatype: UpdateScheduledTransactionOverrideDto,
    data: "",
  };
  const UUID = "11111111-2222-4333-8444-555555555555";

  const base = (split: Record<string, unknown>) => ({
    isSplit: true,
    amount: -100,
    splits: [split, { splitKind: "category", categoryId: UUID, amount: 0 }],
  });

  it("accepts a continuing line naming a UUID sourceSplitId", async () => {
    await expect(
      pipe.transform(
        base({
          splitKind: "category",
          categoryId: UUID,
          amount: -100,
          sourceSplitId: UUID,
        }),
        metadata,
      ),
    ).resolves.toBeDefined();
  });

  it("accepts a new line carrying rateExplicit and no sourceSplitId", async () => {
    await expect(
      pipe.transform(
        base({
          splitKind: "category",
          categoryId: UUID,
          amount: -100,
          rateExplicit: true,
        }),
        metadata,
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a synthetic non-UUID sourceSplitId (a pre-migration override-N key)", async () => {
    await expect(
      pipe.transform(
        base({
          splitKind: "category",
          categoryId: UUID,
          amount: -100,
          sourceSplitId: "override-0",
        }),
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a non-boolean rateExplicit", async () => {
    await expect(
      pipe.transform(
        base({
          splitKind: "category",
          categoryId: UUID,
          amount: -100,
          rateExplicit: "yes",
        }),
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// INV-MONEY-001: the DTO admits an amount up to the column scale (eight
// places); whether its currency carries that many is the service's question
// (`assertAmountPrecision`), so a BTC override at eight places passes here and
// a CAD one at five is refused by the service, not the pipe.
describe("UpdateScheduledTransactionOverrideDto — amount places", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const metadata = {
    type: "body" as const,
    metatype: UpdateScheduledTransactionOverrideDto,
    data: "",
  };

  it("accepts an eight-place amount and split line", async () => {
    await expect(
      pipe.transform(
        {
          isSplit: true,
          amount: -0.005025,
          splits: [
            { splitKind: "category", amount: -0.005 },
            { splitKind: "category", amount: -0.000025 },
          ],
        },
        metadata,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses an amount with more places than any currency carries", async () => {
    await expect(
      pipe.transform({ amount: -0.123456789 }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
