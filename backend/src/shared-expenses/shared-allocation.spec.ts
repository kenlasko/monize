import {
  allocateShares,
  apportion,
  convertAllocations,
} from "./shared-allocation";
import {
  convertSharedAmount,
  fixedUnits,
  ledgerAmount,
  moneyText,
  sharedAmount,
} from "./shared-money";

const people = ["a", "b", "c"];
const inputs = (values: string[]) =>
  values.map((value, i) => ({ participantId: people[i], value }));
const amounts = (rows: { amount: string }[]) => rows.map((row) => row.amount);

describe("shared expense allocation (SE-001, SE-012)", () => {
  it.each([
    ["EQUAL", "300", ["1", "1", "1"], ["100.0000", "100.0000", "100.0000"]],
    ["EXACT", "300", ["80", "110", "110"], ["80.0000", "110.0000", "110.0000"]],
    ["PERCENT", "300", ["50", "30", "20"], ["150.0000", "90.0000", "60.0000"]],
    ["WEIGHT", "480", ["2", "1", "1"], ["240.0000", "120.0000", "120.0000"]],
  ] as const)("allocates %s", (mode, total, values, expected) => {
    expect(
      amounts(allocateShares(total, 2, mode, inputs([...values]), "bill")),
    ).toEqual(expected);
  });

  it("keeps cents stable across input order and repeated reads", () => {
    const rows = inputs(["1", "1", "1"]);
    const original = allocateShares("100", 2, "EQUAL", rows, "bill");
    expect(
      allocateShares("100", 2, "EQUAL", [...rows].reverse(), "bill"),
    ).toEqual(original);
    expect(
      original.reduce((sum, row) => sum + fixedUnits(row.amount, 4), 0n),
    ).toBe(1_000_000n);
    expect(amounts(original).sort()).toEqual(["33.3300", "33.3300", "33.3400"]);
  });

  it.each([0, 2, 3, 4])(
    "conserves every small total at %i currency decimals",
    (places) => {
      for (let minor = 1; minor <= 61; minor++) {
        const total = BigInt(minor) * 10n ** BigInt(4 - places);
        const rows = apportion(
          total,
          people.map((participantId, i) => ({
            participantId,
            units: BigInt(i + 1),
          })),
          places,
          "bill",
        );
        expect(rows.reduce((sum, row) => sum + row.units, 0n)).toBe(total);
        expect(rows.every((row) => row.units >= 0n)).toBe(true);
      }
    },
  );

  it("rejects invalid exact and percent sums instead of rescaling them", () => {
    expect(() =>
      allocateShares("100", 2, "EXACT", inputs(["30", "30", "39"]), "bill"),
    ).toThrow();
    expect(() =>
      allocateShares(
        "100",
        2,
        "PERCENT",
        inputs(["33.33", "33.33", "33.33"]),
        "bill",
      ),
    ).toThrow();
    expect(() =>
      allocateShares("100", 2, "WEIGHT", inputs(["0", "0", "0"]), "bill"),
    ).toThrow();
  });

  it("refuses duplicate participants, no beneficiaries and unsupported modes", () => {
    expect(() => allocateShares("10", 2, "EQUAL", [], "bill")).toThrow();
    expect(() =>
      allocateShares(
        "10",
        2,
        "EQUAL",
        [{ participantId: "a" }, { participantId: "a" }],
        "bill",
      ),
    ).toThrow();
    expect(() =>
      allocateShares("10", 2, "BAD" as never, inputs(["1"]), "bill"),
    ).toThrow();
  });

  it("does not give a zero-share beneficiary an FX rounding cent", () => {
    const original = allocateShares(
      "0.01",
      2,
      "EXACT",
      inputs(["0.01", "0", "0"]),
      "bill",
    );
    const total = convertSharedAmount(100n, "4.3", 2);
    expect(total).toBe(400n);
    expect(amounts(convertAllocations(total, original, 2, "bill"))).toEqual([
      "0.0400",
      "0.0000",
      "0.0000",
    ]);
  });

  it("keeps zero when a real conversion rounds below the target minor unit", () => {
    expect(convertSharedAmount(100n, "0.001", 0)).toBe(0n);
  });

  it("preserves rate precision and rounds the converted total once", () => {
    expect(
      moneyText(convertSharedAmount(sharedAmount("60", 2), "4.3", 2)),
    ).toBe("258.0000");
    expect(convertSharedAmount(1_000_000_000n, "1.0000000001", 4)).toBe(
      1_000_000_000n,
    );
    expect(() => convertSharedAmount(100n, "0", 2)).toThrow();
    expect(() => convertSharedAmount(100n, "1.00000000001", 2)).toThrow();
  });

  it.each([
    "NaN",
    "Infinity",
    "1e2",
    " 1",
    "1,00",
    "-1",
    "0.00001",
    "1000000000000",
  ])("refuses malformed/out-of-range money %s", (value) => {
    expect(() => sharedAmount(value, 4)).toThrow();
  });

  it("handles exact 0.1 + 0.2, zero and the legacy ledger boundary", () => {
    expect(moneyText(fixedUnits("0.1", 4) + fixedUnits("0.2", 4))).toBe(
      "0.3000",
    );
    expect(ledgerAmount(-1n)).toBe(-0.0001);
    expect(ledgerAmount(0n)).toBe(0);
    expect(() => ledgerAmount(9_999_999_999_999_999n)).toThrow();
    expect(() => sharedAmount("0.1", 0)).toThrow();
    expect(() => sharedAmount("1", 5)).toThrow();
  });
});
