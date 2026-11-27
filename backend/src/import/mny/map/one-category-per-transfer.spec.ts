import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import type { MappedSplit, MappedTransaction } from "../model/mny-import-model";
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

  it("makes one choice from either leg when the signs are not opposite", () => {
    // A zero leg beside a positive one: each leg used to pick the other as
    // outgoing, and the two categories swapped instead of agreeing.
    expect(
      categories(
        withOneCategoryPerTransfer([
          leg("r1", 0, 7, "p1"),
          leg("p1", 100, 5, "r1"),
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

  describe("a split's transfer line and the row it links", () => {
    const line = (
      id: string,
      amount: number,
      categoryHandle: number | null,
      linkedTransactionId: string | null,
    ): MappedSplit =>
      ({
        id,
        kind: SplitKind.TRANSFER,
        categoryHandle,
        transferAccountKey: "savings",
        linkedTransactionId,
        investmentHandle: null,
        amount,
        memo: null,
        tagHandles: [],
      }) as unknown as MappedSplit;
    const parentWith = (...lines: MappedSplit[]): MappedTransaction =>
      ({
        ...leg("parent1", -150, null, null, false),
        splits: lines,
      }) as MappedTransaction;

    it("gives the line the category Money records on the linked row", () => {
      const mapped = withOneCategoryPerTransfer([
        parentWith(line("s1", -100, null, "far1")),
        leg("far1", 100, 7, "parent1"),
      ]);
      expect(mapped[0].splits[0].categoryHandle).toBe(7);
      expect(mapped[1].categoryHandle).toBe(7);
    });

    it("keeps the outgoing line's category on both when the two differ", () => {
      const mapped = withOneCategoryPerTransfer([
        parentWith(line("s1", -100, 5, "far1")),
        leg("far1", 100, 7, "parent1"),
      ]);
      expect(mapped[0].splits[0].categoryHandle).toBe(5);
      expect(mapped[1].categoryHandle).toBe(5);
    });

    it("leaves a line whose row does not link back as mapped", () => {
      const rows = [
        parentWith(line("s1", -100, null, "far1")),
        leg("far1", 100, 7, "elsewhere"),
      ];
      const mapped = withOneCategoryPerTransfer(rows);
      mapped.forEach((row, i) => expect(row).toBe(rows[i]));
    });
  });
});
