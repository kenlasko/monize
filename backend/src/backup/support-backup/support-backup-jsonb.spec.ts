import { applyJsonbHandler } from "./support-backup-jsonb";

const M = 2;

describe("JSONB handlers", () => {
  it("transferRules masks pattern and account name, keeps type, drops foreign keys", () => {
    const out = applyJsonbHandler(
      "transferRules",
      [
        {
          type: "payee",
          pattern: "AMZ Marketplace",
          accountName: "Chequing",
          secret: "leak",
        },
      ],
      M,
    ) as Record<string, unknown>[];
    expect(out[0].type).toBe("payee");
    expect(out[0].pattern).toBe("AM***********ce");
    expect(out[0].accountName).toBe("Ch****ng");
    expect(out[0]).not.toHaveProperty("secret");
  });

  it("overrideSplits scales amount, keeps categoryId, drops memo and foreign keys", () => {
    const out = applyJsonbHandler(
      "overrideSplits",
      [{ categoryId: "cat-1", amount: 100, memo: "rent", extra: 1 }],
      M,
    ) as Record<string, unknown>[];
    expect(out[0].categoryId).toBe("cat-1");
    expect(out[0].amount).toBe(200);
    expect(out[0]).not.toHaveProperty("memo");
    expect(out[0]).not.toHaveProperty("extra");
  });

  it("lumpSums scales amount, keeps date and mode", () => {
    const out = applyJsonbHandler(
      "lumpSums",
      [
        {
          date: "2026-06-01",
          amount: 5000,
          mode: "SHORTEN_TERM",
          note: "bonus",
        },
      ],
      M,
    ) as Record<string, unknown>[];
    expect(out[0]).toEqual({
      date: "2026-06-01",
      amount: 10000,
      mode: "SHORTEN_TERM",
    });
  });

  it("reportFilters keeps id arrays, drops searchText and foreign keys", () => {
    const out = applyJsonbHandler(
      "reportFilters",
      {
        accountIds: ["a"],
        categoryIds: ["c"],
        payeeIds: ["p"],
        searchText: "salary",
        odd: 1,
      },
      M,
    ) as Record<string, unknown>;
    expect(out).toEqual({
      accountIds: ["a"],
      categoryIds: ["c"],
      payeeIds: ["p"],
    });
  });
});
