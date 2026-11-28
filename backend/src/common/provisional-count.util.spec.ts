import { EntityManager } from "typeorm";

import { PROVISIONAL_COUNTS_AS_OF_DATES_SQL } from "./ledger-balance.sql";
import {
  ProvisionalCounts,
  loadProvisionalCounts,
} from "./provisional-count.util";

describe("provisional counts", () => {
  const managerAnswering = (rows: unknown[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { manager: { query } as unknown as EntityManager, query };
  };

  it("reads every account at every date in one statement", async () => {
    const { manager, query } = managerAnswering([
      { as_of: "2026-03-01", account_id: "a", count: "2" },
      { as_of: "2026-03-31", account_id: "a", count: "3" },
      { as_of: "2026-03-31", account_id: "b", count: "1" },
    ]);

    const counts = await loadProvisionalCounts(
      manager,
      ["a", "b", "a"],
      ["2026-03-01", "2026-03-31", "2026-03-31"],
    );

    expect(query).toHaveBeenCalledTimes(1);
    // Each id and date once: a repeated one is one balance, not two.
    expect(query).toHaveBeenCalledWith(PROVISIONAL_COUNTS_AS_OF_DATES_SQL, [
      ["a", "b"],
      ["2026-03-01", "2026-03-31"],
      null,
    ]);
    expect(counts.of("a", "2026-03-01")).toBe(2);
    expect(counts.of("a", "2026-03-31")).toBe(3);
    expect(counts.of("b", "2026-03-31")).toBe(1);
  });

  it("bounds the dates at the given day when told to", async () => {
    const { manager, query } = managerAnswering([]);

    await loadProvisionalCounts(manager, ["a"], ["2026-03-31"], {
      notAfter: "2026-03-15",
    });

    expect(query).toHaveBeenCalledWith(PROVISIONAL_COUNTS_AS_OF_DATES_SQL, [
      ["a"],
      ["2026-03-31"],
      "2026-03-15",
    ]);
  });

  it("answers zero for an account or a date with no provisional leg", async () => {
    const { manager } = managerAnswering([
      { as_of: "2026-03-31", account_id: "a", count: "1" },
    ]);

    const counts = await loadProvisionalCounts(
      manager,
      ["a", "b"],
      ["2026-03-01", "2026-03-31"],
    );

    expect(counts.of("b", "2026-03-31")).toBe(0);
    expect(counts.of("a", "2026-03-01")).toBe(0);
  });

  it("asks the database nothing when there is no account or no date", async () => {
    const { manager, query } = managerAnswering([]);

    expect(await loadProvisionalCounts(manager, [], ["2026-03-01"])).toBe(
      ProvisionalCounts.NONE,
    );
    expect(await loadProvisionalCounts(manager, ["a"], [])).toBe(
      ProvisionalCounts.NONE,
    );
    expect(query).not.toHaveBeenCalled();
    expect(ProvisionalCounts.NONE.of("a", "2026-03-01")).toBe(0);
  });
});
