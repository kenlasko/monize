import { EntityManager } from "typeorm";
import { writeSharedFinance, undoSharedPosting } from "./shared-finance-write";
import {
  sharedBankFixture,
  sharedFinancePlanFixture,
  sharedPostingFixture,
} from "./__fixtures__/shared-finance";
import { SharedFinancePlan } from "./shared-finance-types";

describe("Shared ledger effects and original bank preservation", () => {
  let query: jest.Mock;
  let manager: EntityManager;
  let updateBalance: jest.Mock;
  beforeEach(() => {
    query = jest.fn(async (sql: string) =>
      sql.startsWith("SELECT currency_code") ? [{ currency_code: "PLN" }] : [],
    );
    manager = { query } as unknown as EntityManager;
    updateBalance = jest.fn().mockResolvedValue(undefined);
  });
  const rows = (query: jest.Mock) =>
    query.mock.calls
      .filter(([sql]) => sql.startsWith("INSERT INTO transactions"))
      .map(([, parameters]) => parameters);
  it("reuses an imported debit, records one own cost and returns every affected account for invalidation", async () => {
    const result = await writeSharedFinance(
      manager,
      { updateBalance },
      "owner",
      sharedFinancePlanFixture(),
      {},
    );
    expect(rows(query).map((p) => [p[2], p[4], p[9]])).toEqual([
      ["settlement", "300.0000", true],
      ["settlement", "-100.0000", false],
    ]);
    expect(updateBalance.mock.calls).toEqual([
      ["settlement", 300],
      ["settlement", -100],
    ]);
    expect(result.affectedAccountIds).toEqual(["bank", "settlement"]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE transactions SET is_transfer"),
      ["bank-row", "owner", true, false, expect.any(String), result.id],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO shared_ledger_links"),
      [
        "owner",
        result.id,
        "bank-row",
        "BANK",
        false,
        JSON.stringify(sharedBankFixture()),
        "-300.0000",
      ],
    );
  });
  it("creates a new mixed payment once, preserving its private remainder as a category split", async () => {
    const plan = sharedFinancePlanFixture();
    plan.payments = [
      {
        ...plan.payments[0],
        bank: null,
        privateCategoryId: "personal",
        breakdown: {
          ...plan.payments[0].breakdown,
          bankTotal: "-350.0000",
          privateRemainder: "-50.0000",
        },
      },
    ];
    await writeSharedFinance(manager, { updateBalance }, "owner", plan, {});
    expect(rows(query).map((p) => [p[2], p[4]])).toEqual([
      ["bank", "-350.0000"],
      ["settlement", "300.0000"],
      ["settlement", "-100.0000"],
    ]);
    expect(updateBalance.mock.calls).toEqual([
      ["bank", -350],
      ["settlement", 300],
      ["settlement", -100],
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("VALUES ($1,'category'"),
      [expect.any(String), "personal", "-50.0000"],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("VALUES ($1,'transfer'"),
      [expect.any(String), "settlement", expect.any(String), "-300.0000"],
    );
  });
  it("keeps several bank facts separate while writing the personal cost only once", async () => {
    const plan = sharedFinancePlanFixture();
    plan.payments = ["200.0000", "100.0000"].map((amount, index) => ({
      ...plan.payments[0],
      bank: sharedBankFixture({ id: `bank-${index}`, amount: `-${amount}` }),
      cash: `-${amount}`,
      originalCash: `-${amount}`,
      breakdown: {
        bankTotal: `-${amount}`,
        sharedPortion: `-${amount}`,
        agreedPortion: `-${amount}`,
        privateRemainder: "0.0000",
        fxDifference: "0.0000",
      },
    }));
    await writeSharedFinance(manager, { updateBalance }, "owner", plan, {});
    expect(rows(query).map((p) => p[4])).toEqual([
      "200.0000",
      "100.0000",
      "-100.0000",
    ]);
    expect(rows(query).filter((p) => p[7] === "food")).toHaveLength(1);
    expect(
      updateBalance.mock.calls.every(([account]) => account === "settlement"),
    ).toBe(true);
  });
  it("records a repayment entirely as a transfer and never creates an income category", async () => {
    const plan = sharedFinancePlanFixture();
    plan.effect = {
      ...plan.effect,
      type: "REPAYMENT",
      personal: "0.0000",
      cash: "100.0000",
      originalCash: "100.0000",
      position: "-100.0000",
    };
    plan.entry = { ...plan.entry, type: "REPAYMENT" };
    plan.payments = [
      {
        ...plan.payments[0],
        bank: null,
        cash: "100.0000",
        originalCash: "100.0000",
        breakdown: {
          bankTotal: "100.0000",
          sharedPortion: "100.0000",
          agreedPortion: "100.0000",
          privateRemainder: "0.0000",
          fxDifference: "0.0000",
        },
      },
    ];
    await writeSharedFinance(manager, { updateBalance }, "owner", plan, {});
    expect(rows(query).map((p) => [p[2], p[4], p[7]])).toEqual([
      ["bank", "100.0000", null],
      ["settlement", "-100.0000", null],
    ]);
    expect(updateBalance.mock.calls).toEqual([
      ["bank", 100],
      ["settlement", -100],
    ]);
  });
  const oldPlan = (
    created: boolean,
    status = "UNRECONCILED",
  ): Pick<SharedFinancePlan, "existing" | "sourceLinks" | "sourceRows"> => ({
    existing: sharedPostingFixture(),
    sourceLinks: [
      {
        transactionId: "bank-row",
        kind: "BANK",
        created,
        before: sharedBankFixture(),
      },
      { transactionId: "cost", kind: "COST", created: true, before: null },
    ],
    sourceRows: [
      sharedBankFixture({ status }),
      sharedBankFixture({
        id: "cost",
        accountId: "settlement",
        amount: "-100.0000",
        status,
      }),
    ],
  });
  it("restores an imported category and deletes only the bridge-created cost", async () => {
    const affected = await undoSharedPosting(
      manager,
      { updateBalance },
      "owner",
      oldPlan(false),
    );
    expect(affected).toEqual(["bank", "settlement"]);
    expect(updateBalance.mock.calls).toEqual([["settlement", 100]]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE transactions SET is_split"),
      ["bank-row", "owner", "food", false],
    );
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM transactions WHERE id = $1 AND user_id = $2",
      ["cost", "owner"],
    );
    expect(query).not.toHaveBeenCalledWith(
      "DELETE FROM transactions WHERE id = $1 AND user_id = $2",
      ["bank-row", "owner"],
    );
  });
  it("preserves a created bank row when replacing a posting, but reverses it on unlink", async () => {
    await undoSharedPosting(
      manager,
      { updateBalance },
      "owner",
      oldPlan(true),
      ["bank-row"],
    );
    expect(updateBalance.mock.calls).toEqual([["settlement", 100]]);
    updateBalance.mockClear();
    await undoSharedPosting(manager, { updateBalance }, "owner", oldPlan(true));
    expect(updateBalance.mock.calls).toEqual([
      ["bank", 300],
      ["settlement", 100],
    ]);
  });
  it("does not reverse a balance effect for VOID rows or an absent posting", async () => {
    await undoSharedPosting(
      manager,
      { updateBalance },
      "owner",
      oldPlan(true, "VOID"),
    );
    expect(updateBalance).not.toHaveBeenCalled();
    query.mockClear();
    expect(
      await undoSharedPosting(manager, { updateBalance }, "owner", {
        existing: null,
        sourceLinks: [],
        sourceRows: [],
      }),
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
