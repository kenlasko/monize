import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateSecurityPriceDto } from "./create-security-price.dto";
import { CreateInvestmentTransactionDto } from "./create-investment-transaction.dto";
import { TransferSecurityDto } from "./transfer-security.dto";

/**
 * The API side of the sub-cent price fix (migration 116).
 *
 * Widening the columns to NUMERIC(24,10) achieved nothing on its own while the
 * DTOs still rejected anything past six decimal places: a crypto or penny price
 * could not be entered at all, so the extra room was unreachable. These tests
 * pin the two ends together -- what the validator admits, and what the column
 * can hold -- because they were changed in different files and nothing else
 * connects them.
 *
 * Money amounts are deliberately not included. Four places is already more than
 * any currency subdivides; only prices *per unit* need the extra room.
 */

/** A price with ten decimal places -- what a sub-cent instrument quotes at. */
const SUB_CENT_PRICE = 0.0001234568;

/** Eleven places: past what the column can store, so it must be refused. */
const TOO_PRECISE = 0.00012345678901;

async function errorsFor(dto: object): Promise<string[]> {
  const errors = await validate(dto);
  return errors.flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe("per-unit price decimal places", () => {
  describe("CreateSecurityPriceDto", () => {
    const dto = (partial: Record<string, unknown>) =>
      plainToInstance(CreateSecurityPriceDto, {
        priceDate: "2026-07-29",
        closePrice: 100,
        ...partial,
      });

    it("accepts a sub-cent close", async () => {
      expect(await errorsFor(dto({ closePrice: SUB_CENT_PRICE }))).toEqual([]);
    });

    it("accepts sub-cent open, high and low prices", async () => {
      expect(
        await errorsFor(
          dto({
            openPrice: SUB_CENT_PRICE,
            highPrice: SUB_CENT_PRICE,
            lowPrice: SUB_CENT_PRICE,
          }),
        ),
      ).toEqual([]);
    });

    it("refuses a close finer than the column can store", async () => {
      // Accepting it would silently truncate on write, which is the exact
      // failure mode this change exists to remove.
      expect(await errorsFor(dto({ closePrice: TOO_PRECISE }))).toContain(
        "hasMoneyAmountPlaces",
      );
    });
  });

  describe("CreateInvestmentTransactionDto", () => {
    it("accepts a sub-cent price per share", async () => {
      const dto = plainToInstance(CreateInvestmentTransactionDto, {
        accountId: "3f6c1a4e-0e5e-4b7a-8f1c-2d9b8a7c6e50",
        action: "BUY",
        transactionDate: "2026-07-29",
        quantity: 15000,
        price: SUB_CENT_PRICE,
      });
      // The transaction price is where the precision originates: average cost is
      // replayed from it, so a truncation here follows the position for good.
      expect(await errorsFor(dto)).toEqual([]);
    });
  });

  describe("TransferSecurityDto", () => {
    it("accepts a sub-cent cost per share", async () => {
      const dto = plainToInstance(TransferSecurityDto, {
        sourceAccountId: "3f6c1a4e-0e5e-4b7a-8f1c-2d9b8a7c6e50",
        destinationAccountId: "9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        securityId: "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081",
        transactionDate: "2026-07-29",
        quantity: 15000,
        costPerShare: SUB_CENT_PRICE,
      });
      // Carrying the cost basis across accounts must not round it away, or the
      // transfer itself would change the gain the reports show.
      expect(await errorsFor(dto)).not.toContain("hasMoneyAmountPlaces");
    });
  });
});
