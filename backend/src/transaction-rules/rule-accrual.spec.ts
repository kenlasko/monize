import type { EntityManager } from "typeorm";
import {
  accruedRuleSources,
  assertAutomaticRuleSources,
  assertRuleAccrualHistory,
  assertRuleAccrualWrite,
  captureRuleAccrualHistory,
  planRuleAccruals,
  refreshRuleAccrualHistory,
  ruleAccrualFingerprint,
  type RuleAccrualImpact,
} from "./rule-accrual";
import type { PlannedUnit, RowSnapshot } from "./rule-run-snapshot";
import type { RuleEffects } from "./rule-effects";
import { Transaction } from "../transactions/entities/transaction.entity";

jest.mock("../common/db/locks", () => ({
  lockTransactionRows: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock("../accruals/accrual-source", () => ({
  requireAccrualOwner: jest.fn(),
}));
jest.mock("../accruals/accrual-source-edit", () => ({
  resolveSourceAccrualEdit: jest.fn(),
  canonical: (value: unknown) => value,
}));
jest.mock("../accruals/accrual-history-snapshot", () => ({
  readAccrualHistoryState: jest.fn().mockResolvedValue({ state: "read" }),
  assertAccrualHistoryState: jest.fn(),
  restoreAccrualHistoryState: jest.fn(),
}));

import { lockTransactionRows } from "../common/db/locks";
import { requireAccrualOwner } from "../accruals/accrual-source";
import { resolveSourceAccrualEdit } from "../accruals/accrual-source-edit";
import {
  assertAccrualHistoryState,
  readAccrualHistoryState,
  restoreAccrualHistoryState,
} from "../accruals/accrual-history-snapshot";

const USER = "user-1";

/**
 * A single `m.query` mock that answers every raw SQL call this module makes,
 * keyed by a substring of the statement rather than call order -- the
 * functions under test issue a different number of queries depending on
 * which rows are accrued, so pinning to order would make the fixtures
 * fragile to read, not just to write.
 */
function harness(
  options: {
    accruedIds?: readonly string[];
    payeeIds?: readonly string[];
    categoryIds?: readonly string[];
    sourceSnapshots?: Record<string, string>;
  } = {},
) {
  const {
    accruedIds = [],
    payeeIds = [],
    categoryIds = [],
    sourceSnapshots = {},
  } = options;
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM accrual_schedules")) {
      const requested = (params?.[1] as string[]) ?? [];
      return requested
        .filter((id) => accruedIds.includes(id))
        .sort()
        .map((id) => ({ id }));
    }
    if (sql.includes("FROM payees")) {
      const requested = (params?.[1] as string[]) ?? [];
      return requested
        .filter((id) => payeeIds.includes(id))
        .map((id) => ({ id, name: `Payee ${id}`, snapshot: `{"id":"${id}"}` }));
    }
    if (sql.includes("FROM categories")) {
      const requested = (params?.[1] as string[]) ?? [];
      return requested
        .filter((id) => categoryIds.includes(id))
        .map((id) => ({ id, snapshot: `{"id":"${id}"}` }));
    }
    if (sql.includes("jsonb_build_object")) {
      const id = params?.[0] as string;
      if (!(id in sourceSnapshots)) return [];
      return [{ snapshot: sourceSnapshots[id] }];
    }
    throw new Error(`harness: unrecognized query: ${sql}`);
  });
  return { query, m: { query } as unknown as EntityManager };
}

function leg(id: string): Transaction {
  return { id } as unknown as Transaction;
}

function effects(changes: Partial<RuleEffects["changes"]> = {}): RuleEffects {
  return {
    changes: { addTagIds: [], removeTagIds: [], ...changes },
    trace: [],
    aiReviewRequests: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (readAccrualHistoryState as jest.Mock).mockResolvedValue({ state: "read" });
});

describe("accruedRuleSources", () => {
  it("returns an empty set without querying for an empty input", async () => {
    const { query, m } = harness();
    expect(await accruedRuleSources(m, USER, [])).toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });

  it("returns only the ids with a schedule, deduplicated", async () => {
    const { m } = harness({ accruedIds: ["t1", "t2"] });
    const result = await accruedRuleSources(m, USER, ["t1", "t1", "t3"]);
    expect(result).toEqual(new Set(["t1"]));
  });
});

describe("ruleAccrualFingerprint", () => {
  it("returns the base fingerprint when there are no impacts", () => {
    expect(ruleAccrualFingerprint("base-fp", [])).toBe("base-fp");
  });

  it("derives a different, deterministic digest when impacts are present", () => {
    const impacts: RuleAccrualImpact[] = [
      {
        transactionId: "t1",
        fingerprint: "fp1",
        schedules: [],
        references: { payees: [], categories: [] },
      },
    ];
    const first = ruleAccrualFingerprint("base-fp", impacts);
    const second = ruleAccrualFingerprint("base-fp", impacts);
    expect(first).not.toBe("base-fp");
    expect(first).toBe(second);
    expect(ruleAccrualFingerprint("different-base", impacts)).not.toBe(first);
  });
});

describe("planRuleAccruals", () => {
  it("returns nothing when no leg in the run has a schedule", async () => {
    const { m } = harness({ accruedIds: [] });
    const units: PlannedUnit[] = [
      { unit: { legs: [leg("t1")] } as never, effects: effects() },
    ];
    expect(await planRuleAccruals(m, USER, units, new Map())).toEqual([]);
    expect(requireAccrualOwner).not.toHaveBeenCalled();
  });

  it("requires ownership and refuses a structural change once any leg is accrued", async () => {
    const { m } = harness({ accruedIds: ["t1"] });
    const units: PlannedUnit[] = [
      {
        unit: { legs: [leg("t1")] } as never,
        effects: effects({ structure: { kind: "split" } as never }),
      },
    ];
    await expect(planRuleAccruals(m, USER, units, new Map())).rejects.toThrow();
    expect(requireAccrualOwner).toHaveBeenCalledWith(USER);
  });

  it("refuses an unsupported change (structure/createPayee) on an accrued leg", async () => {
    const { m } = harness({ accruedIds: ["t1"] });
    (resolveSourceAccrualEdit as jest.Mock).mockResolvedValue({
      fingerprint: null,
      impacts: [],
    });
    const units: PlannedUnit[] = [
      {
        unit: { legs: [leg("t1")] } as never,
        effects: effects({ createPayee: "New Payee" }),
      },
    ];
    await expect(planRuleAccruals(m, USER, units, new Map())).rejects.toThrow();
  });

  it("throws when a referenced payee or category no longer exists", async () => {
    const { m } = harness({ accruedIds: ["t1"], payeeIds: [] });
    const units: PlannedUnit[] = [
      {
        unit: { legs: [leg("t1")] } as never,
        effects: effects({ payeeId: "missing-payee" }),
      },
    ];
    await expect(planRuleAccruals(m, USER, units, new Map())).rejects.toThrow();
  });

  it("resolves a payee/category/tag patch for each accrued leg and sorts the result", async () => {
    const { m } = harness({
      accruedIds: ["t2", "t1"],
      payeeIds: ["p1"],
      categoryIds: ["c1"],
    });
    (resolveSourceAccrualEdit as jest.Mock).mockImplementation(
      async (_m, _user, id) => ({
        fingerprint: `fp-${id}`,
        impacts: [],
      }),
    );
    const units: PlannedUnit[] = [
      {
        unit: { legs: [leg("t1")] } as never,
        effects: effects({ payeeId: "p1", categoryId: "c1" }),
      },
      {
        unit: { legs: [leg("t2")] } as never,
        effects: effects({ addTagIds: ["tag-a"], removeTagIds: [] }),
      },
    ];
    const result = await planRuleAccruals(
      m,
      USER,
      units,
      new Map([["t2", ["tag-b"]]]),
    );
    expect(result.map((r) => r.transactionId)).toEqual(["t1", "t2"]);
    expect(resolveSourceAccrualEdit).toHaveBeenNthCalledWith(
      1,
      m,
      USER,
      "t1",
      expect.objectContaining({
        payeeId: "p1",
        payeeName: "Payee p1",
        categoryId: "c1",
      }),
    );
    expect(resolveSourceAccrualEdit).toHaveBeenNthCalledWith(
      2,
      m,
      USER,
      "t2",
      expect.objectContaining({ tagIds: ["tag-a", "tag-b"] }),
    );
  });
});

describe("assertRuleAccrualWrite", () => {
  it("returns false and never checks ownership when the source is not accrued", async () => {
    const { m } = harness({ accruedIds: [] });
    expect(
      await assertRuleAccrualWrite(m, USER, "t1", effects(), "manual"),
    ).toBe(false);
    expect(requireAccrualOwner).not.toHaveBeenCalled();
  });

  it("requires ownership and refuses an automatic write to an accrued source", async () => {
    const { m } = harness({ accruedIds: ["t1"] });
    await expect(
      assertRuleAccrualWrite(m, USER, "t1", effects(), "automatic"),
    ).rejects.toThrow();
    expect(requireAccrualOwner).toHaveBeenCalledWith(USER);
  });

  it("allows a supported manual write to an accrued source", async () => {
    const { m } = harness({ accruedIds: ["t1"] });
    expect(
      await assertRuleAccrualWrite(m, USER, "t1", effects(), "manual"),
    ).toBe(true);
  });

  it("still refuses an unsupported change on a manual write", async () => {
    const { m } = harness({ accruedIds: ["t1"] });
    await expect(
      assertRuleAccrualWrite(
        m,
        USER,
        "t1",
        effects({ createPayee: "New" }),
        "manual",
      ),
    ).rejects.toThrow();
  });
});

describe("captureRuleAccrualHistory", () => {
  it("only stamps ruleAccrual on rows that are actually accrued", async () => {
    const { m } = harness({
      accruedIds: ["t1"],
      sourceSnapshots: { t1: "snapshot-1" },
    });
    const rows: RowSnapshot[] = [{ id: "t1" }, { id: "t2" }];
    await captureRuleAccrualHistory(m, USER, rows);
    expect(rows[0].ruleAccrual).toEqual({
      state: { state: "read" },
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(rows[1].ruleAccrual).toBeUndefined();
    expect(requireAccrualOwner).toHaveBeenCalledTimes(1);
  });

  it("refuses to hash a source that no longer exists", async () => {
    const { m } = harness({ accruedIds: ["t1"], sourceSnapshots: {} });
    await expect(
      captureRuleAccrualHistory(m, USER, [{ id: "t1" }]),
    ).rejects.toThrow();
  });
});

describe("assertRuleAccrualHistory", () => {
  it("passes through a row that is neither accrued nor previously captured", async () => {
    const { m } = harness({ accruedIds: [] });
    const refresh = await assertRuleAccrualHistory(
      m,
      USER,
      [{ id: "t1" }],
      [{ id: "t1" }],
    );
    expect(refresh).toEqual([]);
    expect(assertAccrualHistoryState).not.toHaveBeenCalled();
  });

  it("throws when the prior capture or the target's own ruleAccrual is missing", async () => {
    const { m } = harness({ accruedIds: ["t1"] });
    await expect(
      assertRuleAccrualHistory(m, USER, [{ id: "t1" }], [{ id: "t1" }]),
    ).rejects.toThrow();
  });

  it("throws on a payee/category reference that no longer exists", async () => {
    const { m } = harness({ accruedIds: ["t1"], payeeIds: [] });
    const target: RowSnapshot = {
      id: "t1",
      payeeId: "missing-payee",
      ruleAccrual: { state: {}, sourceHash: "irrelevant" },
    };
    await expect(
      assertRuleAccrualHistory(m, USER, [target], [target]),
    ).rejects.toThrow();
  });

  it("detects a stale source hash as a conflict", async () => {
    const { m } = harness({
      accruedIds: ["t1"],
      sourceSnapshots: { t1: "current-snapshot" },
    });
    const target: RowSnapshot = {
      id: "t1",
      ruleAccrual: { state: {}, sourceHash: "0".repeat(64) },
    };
    await expect(
      assertRuleAccrualHistory(m, USER, [target], [target]),
    ).rejects.toThrow();
    expect(assertAccrualHistoryState).toHaveBeenCalledWith(m, USER, "t1", {});
  });

  it("refreshes a target whose captured hash still matches its current source", async () => {
    const { createHash } = await import("node:crypto");
    const snapshot = "unchanged-snapshot";
    const hash = createHash("sha256").update(snapshot).digest("hex");
    const { m } = harness({
      accruedIds: ["t1"],
      sourceSnapshots: { t1: snapshot },
    });
    const target: RowSnapshot = {
      id: "t1",
      ruleAccrual: { state: {}, sourceHash: hash },
    };
    const refresh = await assertRuleAccrualHistory(m, USER, [target], [target]);
    expect(refresh).toEqual(["t1"]);
  });
});

describe("refreshRuleAccrualHistory", () => {
  it("throws for an id with no captured ruleAccrual state", async () => {
    const { m } = harness();
    await expect(
      refreshRuleAccrualHistory(m, USER, ["t1"], [{ id: "t1" }]),
    ).rejects.toThrow();
  });

  it("restores history for each id and recaptures only the refreshed targets", async () => {
    const { m } = harness({
      accruedIds: ["t1"],
      sourceSnapshots: { t1: "snap" },
    });
    const targets: RowSnapshot[] = [
      { id: "t1", ruleAccrual: { state: { restored: true } } },
      { id: "t2", ruleAccrual: { state: { restored: true } } },
    ];
    await refreshRuleAccrualHistory(m, USER, ["t1"], targets);
    expect(restoreAccrualHistoryState).toHaveBeenCalledWith(m, USER, "t1", {
      restored: true,
    });
    expect(restoreAccrualHistoryState).toHaveBeenCalledTimes(1);
    expect(targets[0].ruleAccrual).toEqual({
      state: { state: "read" },
      sourceHash: expect.any(String),
    });
    expect(targets[1].ruleAccrual).toEqual({ state: { restored: true } });
  });
});

describe("assertAutomaticRuleSources", () => {
  it("locks the rows before checking, and passes when none are accrued", async () => {
    const { m } = harness({ accruedIds: [] });
    await assertAutomaticRuleSources(m, USER, ["t1"]);
    expect(lockTransactionRows).toHaveBeenCalledWith(m, ["t1"], USER);
  });

  it("refuses an automatic batch that includes an accrued source", async () => {
    const { m } = harness({ accruedIds: ["t1"] });
    await expect(assertAutomaticRuleSources(m, USER, ["t1"])).rejects.toThrow();
  });
});
