import { mapWithConcurrency } from "./concurrency.util";

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const items = [30, 10, 20, 5];
    const result = await mapWithConcurrency(items, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(result).toEqual(["0:30", "1:10", "2:20", "3:5"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return item;
    });

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 15 }, (_, i) => i);
    const result = await mapWithConcurrency(items, 3, async (item) => {
      seen.push(item);
      return item * 2;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(result).toEqual(items.map((i) => i * 2));
  });

  it("returns an empty array for empty input without invoking the mapper", async () => {
    const mapper = jest.fn();
    const result = await mapWithConcurrency([], 4, mapper);
    expect(result).toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });

  it("handles a limit larger than the item count", async () => {
    const result = await mapWithConcurrency([1, 2, 3], 10, async (x) => x + 1);
    expect(result).toEqual([2, 3, 4]);
  });

  it("propagates the first rejection and stops scheduling new work", async () => {
    const started: number[] = [];
    const items = Array.from({ length: 10 }, (_, i) => i);

    await expect(
      mapWithConcurrency(items, 2, async (item) => {
        started.push(item);
        if (item === 1) {
          throw new Error("boom");
        }
        await new Promise((r) => setTimeout(r, 5));
        return item;
      }),
    ).rejects.toThrow("boom");

    // With a limit of 2, the failure on item 1 must stop the run well before
    // every item is scheduled.
    expect(started.length).toBeLessThan(items.length);
  });

  it("throws when the limit is less than 1", async () => {
    await expect(
      mapWithConcurrency([1], 0, async (x) => x),
    ).rejects.toThrow("limit must be at least 1");
  });
});
