import { describe, expect, it } from "vitest";
import {
  editSplitDraft,
  initialSplitDraft,
  resolveSplitDraft,
  splitRatios,
} from "./shared-split-editor";

const equal = (ids = ["a", "b", "c"]) =>
  initialSplitDraft({
    splitMode: "EQUAL",
    shares: ids.map((participantId) => ({ participantId })),
  });
describe("Unified split instructions", () => {
  it("preserves an unedited equal split instead of replacing the server's seeded remainder", () => {
    expect(resolveSplitDraft(equal(), "400", 2)).toMatchObject({
      splitMode: "EQUAL",
      shares: [
        { participantId: "a" },
        { participantId: "b" },
        { participantId: "c" },
      ],
    });
  });
  it.each([0, 2, 3, 4])(
    "pins coffee and assigns the remainder in currency precision %s",
    (places) => {
      const draft = editSplitDraft(equal(), "400", places, "EXACT", "a", "20");
      const result = resolveSplitDraft(draft, "400", places);
      expect(result.status.valid).toBe(true);
      expect(result.shares.map((row) => Number(row.value))).toEqual([
        20, 190, 190,
      ]);
      expect(draft.values).toEqual({ a: "20" });
    },
  );
  it("keeps fixed zero, excludes one person, and can release a pin", () => {
    const draft = {
      ...equal(["a", "b", "c", "d", "e"]),
      mode: "EXACT" as const,
      values: { a: "20", b: "0" },
    };
    expect(
      resolveSplitDraft(draft, "100", 2).shares.map((row) => row.value),
    ).toEqual(["20", "0", "26.67", "26.67", "26.66"]);
    expect(
      resolveSplitDraft(
        editSplitDraft(draft, "100", 2, "EXACT", "a", ""),
        "100",
        2,
      ).shares.map((row) => Number(row.value)),
    ).toEqual([25, 0, 25, 25, 25]);
  });
  it("fills only unspecified percentages and refuses fully pinned 99.99", () => {
    const draft = editSplitDraft(equal(), "400", 2, "PERCENT", "a", "40");
    expect(
      resolveSplitDraft(draft, "400", 2).shares.map((row) => row.value),
    ).toEqual(["40", "30.00", "30.00"]);
    expect(
      resolveSplitDraft(
        { ...draft, values: { a: "40", b: "30", c: "29.99" } },
        "400",
        2,
      ).status,
    ).toEqual({ valid: false, remaining: "0.01" });
  });
  it("does not clamp excess fixed amounts or turn zero weights into equal shares", () => {
    expect(
      resolveSplitDraft(
        editSplitDraft(equal(), "100", 2, "EXACT", "a", "120"),
        "100",
        2,
      ).status,
    ).toEqual({ valid: false, remaining: "-20.00" });
    const zero = initialSplitDraft({
      splitMode: "WEIGHT",
      shares: [{ participantId: "a", value: "0" }],
    });
    expect(resolveSplitDraft(zero, "100", 2).status.valid).toBe(false);
    expect(
      splitRatios(resolveSplitDraft(zero, "100", 2)).a.percent,
    ).toBeUndefined();
  });
  it("uses relative shares and preserves loaded decimal instructions", () => {
    const draft = editSplitDraft(equal(), "400", 2, "WEIGHT", "a", "2");
    expect(
      resolveSplitDraft(draft, "400", 2).shares.map((row) => row.value),
    ).toEqual(["2", "1", "1"]);
    expect(splitRatios(resolveSplitDraft(draft, "400", 2)).a.percent).toBe(50);
    const split = {
      splitMode: "EXACT" as const,
      shares: [
        { participantId: "a", value: "0.1234" },
        { participantId: "b", value: "0.8766" },
      ],
    };
    expect(resolveSplitDraft(initialSplitDraft(split), "1", 4)).toMatchObject(
      split,
    );
  });
  it("requires a cleared weight to be entered explicitly, rather than previewing an invalid empty instruction", () => {
    const draft = editSplitDraft(equal(), "100", 2, "WEIGHT", "a", "");
    expect(resolveSplitDraft(draft, "100", 2).status.valid).toBe(false);
  });
});
