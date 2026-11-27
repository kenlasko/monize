import type { MappedTransaction } from "../model/mny-import-model";
import { withOneCategoryPerTransfer } from "./map-transactions";

/**
 * One category per transfer on the Money path (INV-CATEGORY-002,
 * `docs/specs/transfer-categories.md` section 4.5): both legs of a linked
 * pair take the file's category, the outgoing leg's when the two differ.
 */
describe("withOneCategoryPerTransfer", () => {
  const leg = (
    id: string,
    amount: number,
    categoryHandle: number | null,
    linkedTransactionId: string | null,
    isTransfer = true,
  ): MappedTransaction =>
    ({
      id,
      handle: Number(id.replace(/\D/g, "")) || 1,
      accountKey: id,
      transactionDate: "2026-03-01",
      amount,
      currencyCode: "CAD",
      exchangeRate: 1,
      status: "UNRECONCILED",
      payeeHandle: null,
      categoryHandle,
      description: null,
      referenceNumber: null,
      isTransfer,
      linkedTransactionId,
      splits: [],
      tagHandles: [],
    }) as unknown as MappedTransaction;
  const categories = (rows: readonly MappedTransaction[]) =>
    rows.map((row) => row.categoryHandle);

  it("gives both legs the outgoing leg's category when the two differ", () => {
    expect(
      categories(
        withOneCategoryPerTransfer([
          leg("in1", 100, 7, "out1"),
          leg("out1", -100, 5, "in1"),
        ]),
      ),
    ).toEqual([5, 5]);
  });

  it("gives both legs the one category either names", () => {
    expect(
      categories(
        withOneCategoryPerTransfer([
          leg("out1", -100, null, "in1"),
          leg("in1", 100, 7, "out1"),
        ]),
      ),
    ).toEqual([7, 7]);
  });

  it("leaves a lone leg, an ordinary row and a pair that agrees as mapped", () => {
    const rows = [
      leg("out1", -100, 5, "missing"),
      leg("row2", -10, 3, null, false),
      leg("out3", -50, 4, "in3"),
      leg("in3", 50, 4, "out3"),
    ];
    const mapped = withOneCategoryPerTransfer(rows);
    expect(categories(mapped)).toEqual([5, 3, 4, 4]);
    // Nothing that already agrees is copied.
    mapped.forEach((row, i) => expect(row).toBe(rows[i]));
  });
});
