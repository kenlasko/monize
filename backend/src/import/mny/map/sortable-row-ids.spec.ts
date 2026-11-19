import { isUUID } from "class-validator";
import { sortableRowIds } from "./sortable-row-ids";

describe("sortableRowIds (S1)", () => {
  it("hands out valid version-7 UUIDs that sort in the order they were handed out", () => {
    const next = sortableRowIds(1_700_000_000_000);
    const ids = Array.from({ length: 5000 }, () => next());
    expect(ids.every((id) => isUUID(id, 7))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orders across the counter's byte boundaries", () => {
    const next = sortableRowIds(0);
    const ids = Array.from({ length: 70_000 }, () => next());
    for (const at of [255, 256, 65_535, 65_536]) {
      expect(ids[at] < ids[at + 1]).toBe(true);
    }
  });
});
