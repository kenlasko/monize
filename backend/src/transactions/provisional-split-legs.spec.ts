import { EntityManager } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import {
  carryProvisionalSplitLegs,
  readProvisionalSplitLegs,
} from "./provisional-split-legs";

/**
 * A split write deletes and recreates each transfer line's counterpart; the
 * flag follows the amount across that replacement (design P2 of
 * docs/specs/provisional-amounts.md).
 */
describe("provisional split legs across a replacement", () => {
  const line = (leg: Record<string, unknown> | null) => ({
    linkedTransaction: leg,
  });
  const managerWith = (lines: unknown) => {
    const m = {
      find: jest.fn().mockResolvedValue(lines),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    return m as typeof m & EntityManager;
  };

  it("reads only the counterparts that are provisional", async () => {
    const m = managerWith([
      line(null),
      line({
        accountId: "eur",
        amount: "35.50000000",
        amountIsProvisional: true,
      }),
      line({ accountId: "gbp", amount: "10", amountIsProvisional: false }),
    ]);

    expect(await readProvisionalSplitLegs(m, "parent")).toEqual([
      { accountId: "eur", amount: 35.5 },
    ]);
  });

  it("reads nothing from a parent with no lines", async () => {
    expect(
      await readProvisionalSplitLegs(managerWith(undefined), "parent"),
    ).toEqual([]);
  });

  it("carries the flag onto a recreated counterpart in the same account with the same amount, once per recorded leg", async () => {
    const m = managerWith([
      line(null),
      line({ id: "new-1", accountId: "eur", amount: 35.5 }),
      // A second, identical new line is not the recorded one twice.
      line({ id: "new-2", accountId: "eur", amount: 35.5 }),
      line({ id: "new-3", accountId: "gbp", amount: 35.5 }),
    ]);

    await carryProvisionalSplitLegs(m, "parent", [
      { accountId: "eur", amount: 35.5 },
    ]);

    expect(m.update.mock.calls).toEqual([
      [Transaction, { id: "new-1" }, { amountIsProvisional: true }],
    ]);
  });

  it("leaves a counterpart whose amount was restated or repriced as written", async () => {
    const m = managerWith([
      line({ id: "new-1", accountId: "eur", amount: 36 }),
    ]);

    await carryProvisionalSplitLegs(m, "parent", [
      { accountId: "eur", amount: 35.5 },
    ]);

    expect(m.update).not.toHaveBeenCalled();
  });

  it("reads and writes nothing when no counterpart was provisional", async () => {
    const m = managerWith([line({ id: "new-1", accountId: "eur", amount: 1 })]);

    await carryProvisionalSplitLegs(m, "parent", []);

    expect(m.find).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });
});
