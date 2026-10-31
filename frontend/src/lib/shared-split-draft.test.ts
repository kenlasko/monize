import { describe, expect, it } from "vitest";
import {
  assignRemainder,
  extrasThenEqual,
  splitRemainderEqually,
} from "./shared-split-draft";

describe("shared expense split drafts", () => {
  it("keeps the coffee's final 20 and shares only the other 80, unlike extras", () => {
    const rows = Object.freeze([
      Object.freeze({ participantId: "a", value: "20" }),
      Object.freeze({ participantId: "b", value: "" }),
      Object.freeze({ participantId: "c" }),
      Object.freeze({ participantId: "d", value: "0" }),
    ] as const);
    expect(splitRemainderEqually("100", rows, 2)).toEqual([
      rows[0],
      { participantId: "b", value: "40.00" },
      { participantId: "c", value: "40.00" },
      rows[3],
    ]);
    expect(rows[1].value).toBe("");
  });
  it.each([
    [0, "101", "41", "40"],
    [2, "100.01", "40.01", "40.00"],
    [3, "100.001", "40.001", "40.000"],
    [4, "100.0001", "40.0001", "40.0000"],
  ] as const)(
    "keeps the remainder deterministic at %i decimal places",
    (places, amount, first, second) => {
      const rows = [
        { participantId: "c", value: "" },
        { participantId: "a", value: "20" },
        { participantId: "b", value: "" },
      ];
      const expected = [
        { participantId: "c", value: second },
        rows[1],
        { participantId: "b", value: first },
      ];
      expect(splitRemainderEqually(amount, rows, places)).toEqual(expected);
      expect(
        splitRemainderEqually(amount, [...rows].reverse(), places).reverse(),
      ).toEqual(expected);
    },
  );
  it("preserves the final cent above safe fractional float precision", () => {
    expect(
      splitRemainderEqually(
        "999999999999.99",
        [
          { participantId: "a", value: "999999999999.98" },
          { participantId: "b" },
          { participantId: "c" },
        ],
        2,
      ),
    ).toEqual([
      { participantId: "a", value: "999999999999.98" },
      { participantId: "b", value: "0.01" },
      { participantId: "c", value: "0.00" },
    ]);
  });
  it.each(["101", "-1", "0.001", "invalid"])(
    "refuses an invalid fixed amount %s",
    (value) => {
      expect(() =>
        splitRemainderEqually(
          "100",
          [{ participantId: "a", value }, { participantId: "b" }],
          2,
        ),
      ).toThrow();
    },
  );
  it("requires an unfilled recipient instead of overwriting a fixed zero", () => {
    expect(() => splitRemainderEqually("100", [], 2)).toThrow();
    expect(() =>
      splitRemainderEqually(
        "100",
        [
          { participantId: "a", value: "20" },
          { participantId: "b", value: "0" },
        ],
        2,
      ),
    ).toThrow();
  });
  it("assigns only the missing amount and preserves the entered amounts", () => {
    const rows = [
      { participantId: "a", value: "24.99" },
      { participantId: "b", value: "0" },
      { participantId: "c", value: "10" },
    ];
    expect(assignRemainder("100", rows, "b", 2)).toEqual([
      rows[0],
      { participantId: "b", value: "65.01" },
      rows[2],
    ]);
    expect(rows[1].value).toBe("0");
  });
  it("does not hide an over-allocation or unrepresentable currency precision", () => {
    expect(() =>
      assignRemainder(
        "10",
        [{ participantId: "a", value: "11" }, { participantId: "b" }],
        "b",
        2,
      ),
    ).toThrow();
    expect(() =>
      assignRemainder(
        "10",
        [{ participantId: "a", value: "0.001" }, { participantId: "b" }],
        "b",
        2,
      ),
    ).toThrow();
  });
  it.each([0, 2, 3, 4])(
    "distributes extras and the remaining units exactly with %i decimals",
    (places) => {
      const rows = [
        { participantId: "c", value: "2" },
        { participantId: "a", value: "0" },
        { participantId: "b", value: "1" },
      ];
      const result = extrasThenEqual("10", rows, places);
      const scale = 10 ** places;
      expect(
        result.reduce(
          (sum, row) => sum + Math.round(Number(row.value) * scale),
          0,
        ),
      ).toBe(10 * scale);
      expect(
        extrasThenEqual("10", [...rows].reverse(), places).reverse(),
      ).toEqual(result);
      expect(
        Math.round(Number(result[0].value) * scale) -
          Math.round(Number(result[1].value) * scale),
      ).toBe(2 * scale - 1);
    },
  );
  it("keeps the last cent for an explicit split of a value above safe fractional float precision", () => {
    const result = assignRemainder(
      "999999999999.99",
      [
        { participantId: "a", value: "999999999999.98" },
        { participantId: "b" },
      ],
      "b",
      2,
    );
    expect(result[1].value).toBe("0.01");
  });
  it("rejects empty or excessive extras without replacing the draft", () => {
    expect(() => extrasThenEqual("10", [], 2)).toThrow();
    expect(() =>
      extrasThenEqual("10", [{ participantId: "a", value: "11" }], 2),
    ).toThrow();
  });
});
