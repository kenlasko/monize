import { rawFile, rawPayee, rawTag } from "../__fixtures__/kmy-raw-builders";
import {
  mapKmyPayees,
  mapKmyTags,
  payeeHandleById,
  tagHandleById,
} from "./kmy-map-payees-tags";

describe("mapKmyPayees (spec 5.5)", () => {
  const raw = rawFile({
    payees: [
      rawPayee("P1", " Corner Market "),
      rawPayee("P2", "City Power", { email: "a@example.invalid" }),
      rawPayee("P3", "corner market"),
      rawPayee("P4", "   "),
    ],
  });

  it("indexes payees and tags by their ordinal", () => {
    expect(payeeHandleById(raw).get("P2")).toBe(2);
    expect(
      tagHandleById(rawFile({ tags: [rawTag("G1", "x")] })).get("G1"),
    ).toBe(1);
  });

  it("imports every payee when nothing filters, unique by name case-insensitively", () => {
    const result = mapKmyPayees(raw, null);
    expect(result.payees).toEqual([
      { handle: 1, name: "Corner Market" },
      { handle: 2, name: "City Power" },
    ]);
    expect(result.nameByHandle.get(3)).toBe("corner market");
    expect(result.skipped).toBe(1);
  });

  it("imports only referenced payees and warns once per imported payee with details", () => {
    const result = mapKmyPayees(raw, new Set([2]));
    expect(result.payees).toEqual([{ handle: 2, name: "City Power" }]);
    expect(result.skipped).toBe(3);
    expect(result.warnings).toEqual([
      { code: "payeeDetailsNotImported", subject: "City Power" },
    ]);
    expect(mapKmyPayees(raw, new Set([1])).warnings).toEqual([]);
  });
});

describe("mapKmyTags (spec 5.5)", () => {
  const raw = rawFile({
    tags: [
      rawTag("G1", "household"),
      rawTag("G2", "Household"),
      rawTag("G3", "x".repeat(150)),
      rawTag("G4", "unused"),
      rawTag("G5", " "),
    ],
  });

  it("creates only referenced tags, truncates to 100 characters and merges case variants", () => {
    const result = mapKmyTags(raw, new Set([1, 2, 3, 5]));
    expect(result.tags.map((t) => t.name)).toEqual([
      "household",
      "x".repeat(100),
    ]);
    expect(result.byHandle.get(2)).toBe(result.byHandle.get(1));
    expect(result.inFile).toBe(5);
    expect(result.skipped).toBe(2);
    expect(result.warnings).toEqual([]);
  });
});
