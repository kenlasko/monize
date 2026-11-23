import type { ParsedReceipt } from "../parsing/receipt-parser.types";
import {
  chooseComponents,
  loadLinkedComponents,
  toJoinParts,
  unitsOf,
  type ComponentRow,
} from "./component-lookup";

const parsedReceipt = (): ParsedReceipt =>
  ({ items: [], complete: true, reason: null }) as unknown as ParsedReceipt;

const row = (over: Partial<ComponentRow> = {}): ComponentRow => ({
  id: "b",
  linkKey: "L1",
  subject: "Order",
  effectiveDate: "2026-01-05",
  parsed: parsedReceipt(),
  parserId: "p1",
  ...over,
});

describe("chooseComponents", () => {
  it("takes the newest date first and reports how many were found", () => {
    const chosen = chooseComponents(
      ["L1"],
      [
        row({ id: "a", effectiveDate: "2026-01-01" }),
        row({ id: "b", effectiveDate: "2026-01-09" }),
        row({ id: "c", effectiveDate: "2026-01-05" }),
      ],
    );
    expect(chosen.get("L1")?.row.id).toBe("b");
    expect(chosen.get("L1")?.several).toBe(3);
  });

  it("breaks a tie on the date by the lower id", () => {
    const chosen = chooseComponents(
      ["L1"],
      [row({ id: "z" }), row({ id: "m" }), row({ id: "q" })],
    );
    expect(chosen.get("L1")?.row.id).toBe("m");
  });

  it("leaves a link value no component carries out of the map, and reads each key on its own", () => {
    const chosen = chooseComponents(
      ["L1", "L2", "L1"],
      [row({ id: "a" }), row({ id: "x", linkKey: "L3" })],
    );
    expect([...chosen.keys()]).toEqual(["L1"]);
    expect(chosen.get("L1")?.several).toBe(1);
  });
});

describe("chooseComponents with draft candidates", () => {
  it("lets a draft replace the stored row of the same receipt, whatever its date", () => {
    const chosen = chooseComponents(
      ["L1"],
      [row({ id: "a", effectiveDate: "2026-01-09", parserId: "p1" })],
      [row({ id: "a", effectiveDate: "2026-01-02", parserId: null })],
    );
    expect(chosen.get("L1")?.row).toMatchObject({
      id: "a",
      effectiveDate: "2026-01-02",
      parserId: null,
    });
    expect(chosen.get("L1")?.several).toBe(1);
  });

  it("chooses among stored and draft candidates with the same rule: newest date, then lower id", () => {
    const stored = [row({ id: "s", effectiveDate: "2026-01-05" })];
    const drafts = [
      row({ id: "d", effectiveDate: "2026-01-08", parserId: null }),
    ];
    const chosen = chooseComponents(["L1"], stored, drafts);
    expect(chosen.get("L1")?.row.id).toBe("d");
    expect(chosen.get("L1")?.several).toBe(2);
    const tie = chooseComponents(
      ["L1"],
      [row({ id: "z" })],
      [row({ id: "m", parserId: null })],
    );
    expect(tie.get("L1")?.row.id).toBe("m");
  });

  it("finds a link value only a draft carries, and is unchanged with no drafts", () => {
    const onlyDraft = chooseComponents(
      ["L9"],
      [row()],
      [row({ id: "d", linkKey: "L9" })],
    );
    expect(onlyDraft.get("L9")?.row.id).toBe("d");
    const none = chooseComponents(["L1"], [row({ id: "a" })], []);
    expect(none.get("L1")?.row.id).toBe("a");
  });
});

describe("toJoinParts", () => {
  it("gives one part per item: the component with its taken units and tag, or none", () => {
    const chosen = chooseComponents(["L1"], [row({ id: "a" })]);
    const parts = toJoinParts(
      [{ link: "L1" }, { link: "L9" }, {}],
      chosen,
      new Map([["a", 1000000]]),
      new Map([["p1", "Shop"]]),
    );
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({
      component: { receiptId: "a", tagName: "Shop" },
      several: 1,
      taken: 1000000,
    });
    expect(parts[1]).toEqual({ component: null, several: 0, taken: 0 });
    expect(parts[2]).toEqual({ component: null, several: 0, taken: 0 });
  });

  it("has no tag for a component whose profile is gone", () => {
    const chosen = chooseComponents(["L1"], [row({ parserId: null })]);
    const [part] = toJoinParts([{ link: "L1" }], chosen, new Map(), new Map());
    expect(part.component?.tagName).toBeNull();
  });
});

describe("unitsOf", () => {
  it("reads a numeric string as 1/10000 units, rounded once", () => {
    expect(unitsOf("163.0000")).toBe(1630000);
    expect(unitsOf("0.0001")).toBe(1);
    expect(unitsOf(null)).toBe(0);
    expect(unitsOf(12.5)).toBe(125000);
  });

  it("scales a large amount to the units it denotes (Discussion #2343)", () => {
    // 300000000000.03 * 10000 is 3000000000000300.5 in doubles.
    expect(unitsOf("300000000000.03")).toBe(3_000_000_000_000_300);
    expect(unitsOf("-300000000000.03")).toBe(-3_000_000_000_000_300);
  });
});

describe("loadLinkedComponents", () => {
  const found = (id: string, parserId = "p1") => ({
    id,
    link_key: "L1",
    subject: "Order",
    effective_date: "2026-01-05",
    parsed: parsedReceipt(),
    parser_id: parserId,
  });

  const manager = (rows: unknown[]) => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM email_receipts r")) return rows;
      if (sql.includes("AS taken")) {
        return [{ component_receipt_id: "a", taken: "100.0000" }];
      }
      if (sql.includes("definition->>'tag'")) {
        return [{ id: "p1", tag: "Shop", name: "Shop purchases" }];
      }
      return [];
    });
    return { m: { query } as never, query };
  };

  it("reads the components in one query, window and domains as parameters, locked when asked", async () => {
    const { m, query } = manager([found("a")]);
    const parts = await loadLinkedComponents(
      m,
      "u1",
      { id: "s1", effectiveDate: "2026-02-01" },
      ["L1", null],
      { fromDomains: ["shop.example.com"], daysBefore: 10 },
      true,
    );
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("FOR UPDATE OF r");
    expect(sql).toContain("ORDER BY r.id");
    expect(params).toEqual([
      "u1",
      ["L1"],
      "s1",
      ["shop.example.com"],
      "2026-01-22",
      "2026-02-08",
    ]);
    expect(parts[0]).toMatchObject({
      component: {
        receiptId: "a",
        tagName: "Shop",
        subject: "Order",
        effectiveDate: "2026-01-05",
        profileName: "Shop purchases",
      },
      taken: 1000000,
    });
    expect(parts[1].component).toBeNull();
  });

  it("uses 120 days before and any sender by default, and takes no lock for a preview", async () => {
    const { m, query } = manager([found("a")]);
    await loadLinkedComponents(
      m,
      "u1",
      { id: "s1", effectiveDate: "2026-06-01" },
      ["L1"],
      {},
      false,
    );
    const [sql, params = []] = query.mock.calls[0];
    expect(sql).not.toContain("FOR UPDATE");
    expect(params[3]).toBeNull();
    expect(params[4]).toBe("2026-02-01");
    expect(params[5]).toBe("2026-06-08");
  });

  it("asks nothing when no part has a link value", async () => {
    const { m, query } = manager([]);
    const parts = await loadLinkedComponents(
      m,
      "u1",
      { id: "s1", effectiveDate: "2026-06-01" },
      [null],
      {},
      true,
    );
    expect(query).not.toHaveBeenCalled();
    expect(parts).toEqual([{ component: null, several: 0, taken: 0 }]);
  });

  it("reports a part whose link no component carries as none", async () => {
    const { m, query } = manager([]);
    const parts = await loadLinkedComponents(
      m,
      "u1",
      { id: "s1", effectiveDate: "2026-06-01" },
      ["L1"],
      {},
      true,
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(parts[0].component).toBeNull();
  });
});
