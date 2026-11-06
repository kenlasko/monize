import { EntityManager } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { retotalSplitParent } from "./split-parent-total";

describe("retotalSplitParent", () => {
  let m: { update: jest.Mock };
  let balances: {
    updateBalance: jest.Mock;
    recalculateCurrentBalance: jest.Mock;
  };

  const parent = {
    id: "parent-1",
    accountId: "chequing",
    amount: -100,
    status: TransactionStatus.UNRECONCILED as string,
    transactionDate: "2026-01-15",
  };

  beforeEach(() => {
    m = { update: jest.fn().mockResolvedValue(undefined) };
    balances = {
      updateBalance: jest.fn().mockResolvedValue(undefined),
      recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
    };
  });

  function retotal(row: typeof parent, newAmount: number, decimals = 4) {
    return retotalSplitParent(
      m as unknown as EntityManager,
      "user-1",
      row,
      newAmount,
      decimals,
      balances,
    );
  }

  it("writes the new amount and moves the account by the difference", async () => {
    // -100.00 less a -60.00 line: the parent holds -40.00 and 60.00 comes back.
    await expect(retotal(parent, -40)).resolves.toBe(true);

    expect(m.update).toHaveBeenCalledWith(Transaction, "parent-1", {
      amount: -40,
    });
    expect(balances.updateBalance).toHaveBeenCalledWith("chequing", 60);
    expect(balances.recalculateCurrentBalance).not.toHaveBeenCalled();
  });

  it("moves the account the other way when the parent grows", async () => {
    // A leg edit from 40.00 to 50.00: the parent goes to -110.00.
    await retotal(parent, -110);

    expect(balances.updateBalance).toHaveBeenCalledWith("chequing", -10);
  });

  it("rounds the difference to the stored precision", async () => {
    await retotal({ ...parent, amount: -0.3 }, -0.1);

    expect(m.update).toHaveBeenCalledWith(Transaction, "parent-1", {
      amount: -0.1,
    });
    expect(balances.updateBalance).toHaveBeenCalledWith("chequing", 0.2);
  });

  it("keeps a coin parent's satoshis at the currency's eight places", async () => {
    // A ₿0.01 parent loses a ₿0.00002500 fee line: four places would round
    // the line away and move nothing.
    await expect(
      retotal({ ...parent, amount: -0.01 }, -0.009975, 8),
    ).resolves.toBe(true);

    expect(m.update).toHaveBeenCalledWith(Transaction, "parent-1", {
      amount: -0.009975,
    });
    expect(balances.updateBalance).toHaveBeenCalledWith("chequing", 0.000025);
  });

  it("moves no balance for a VOID parent, but still writes the amount", async () => {
    await retotal({ ...parent, status: TransactionStatus.VOID }, -40);

    expect(m.update).toHaveBeenCalledWith(Transaction, "parent-1", {
      amount: -40,
    });
    expect(balances.updateBalance).not.toHaveBeenCalled();
    expect(balances.recalculateCurrentBalance).not.toHaveBeenCalled();
  });

  it("recomputes a future-dated parent's account instead of nudging it", async () => {
    await retotal({ ...parent, transactionDate: "2099-01-15" }, -40);

    expect(balances.updateBalance).not.toHaveBeenCalled();
    expect(balances.recalculateCurrentBalance).toHaveBeenCalledWith(
      "user-1",
      "chequing",
    );
  });

  it("writes nothing when the amount is unchanged", async () => {
    await expect(retotal(parent, -100.00001)).resolves.toBe(false);

    expect(m.update).not.toHaveBeenCalled();
    expect(balances.updateBalance).not.toHaveBeenCalled();
    expect(balances.recalculateCurrentBalance).not.toHaveBeenCalled();
  });
});
