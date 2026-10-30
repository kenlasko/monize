import { EntityManager } from "typeorm";
import {
  AccountSubType,
  AccountType,
} from "../../../accounts/entities/account.entity";
import {
  MappedAccount,
  MappedCategory,
  MappedPayee,
} from "../model/mny-import-model";
import {
  applyDeferredClosures,
  writeAccounts,
  writeCategories,
  writePayees,
} from "./write-reference";

/**
 * The reference writers are find-or-create by name, which is what makes a second
 * import merge instead of duplicating. Two behaviours here are not obvious from
 * reading the calls and both were real bugs: an investment pair's
 * `linked_account_id` needs a third pass (the column is a self-referencing FK
 * pointing both ways, so no insertion order satisfies it inline), and closure is
 * deferred to the very end because `updateBalance` refuses closed accounts.
 */

function repoDouble(existing: unknown[] = []) {
  return {
    find: jest.fn().mockResolvedValue(existing),
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as Record<string, jest.Mock>;
}

function managerFor(repo: Record<string, jest.Mock>): EntityManager {
  return { getRepository: jest.fn(() => repo) } as unknown as EntityManager;
}

function account(overrides: Partial<MappedAccount> = {}): MappedAccount {
  return {
    key: "acct-1",
    handle: 1,
    name: "Chequing",
    moneyName: "Chequing",
    accountType: AccountType.CHEQUING,
    accountSubType: null,
    currencyCode: "CAD",
    openingBalance: 100,
    creditLimit: null,
    closed: false,
    closedDate: null,
    favourite: false,
    excludeFromNetWorth: false,
    description: null,
    linkedKey: null,
    ...overrides,
  };
}

function category(overrides: Partial<MappedCategory> = {}): MappedCategory {
  return {
    handle: 10,
    parentName: null,
    name: "Groceries",
    fullName: "Groceries",
    isIncome: false,
    ...overrides,
  };
}

describe("writeAccounts", () => {
  it("inserts new accounts and reports how many were created", async () => {
    const repo = repoDouble();

    const written = await writeAccounts(managerFor(repo), "user-1", [
      account(),
      account({ key: "acct-2", handle: 2, name: "Visa" }),
    ]);

    expect(written.created).toBe(2);
    expect(written.reused).toBe(0);
    expect(repo.insert).toHaveBeenCalledTimes(2);
    expect(written.idByKey.get("acct-1")).toBeDefined();
    expect(written.idByKey.get("acct-2")).not.toBe(
      written.idByKey.get("acct-1"),
    );
  });

  it("reuses an account the user already has, matched case-insensitively", async () => {
    const repo = repoDouble([
      {
        id: "existing-1",
        name: "CHEQUING",
        currencyCode: "CAD",
        isClosed: false,
      },
    ]);

    const written = await writeAccounts(managerFor(repo), "user-1", [
      account(),
    ]);

    expect(written.reused).toBe(1);
    expect(written.created).toBe(0);
    expect(repo.insert).not.toHaveBeenCalled();
    expect(written.idByKey.get("acct-1")).toBe("existing-1");
  });

  it("reports the reused account ids", async () => {
    const repo = repoDouble([
      {
        id: "existing-1",
        name: "Chequing",
        currencyCode: "CAD",
        isClosed: false,
      },
    ]);

    const written = await writeAccounts(managerFor(repo), "user-1", [
      account(),
    ]);

    expect([...written.reusedIds]).toEqual(["existing-1"]);
  });

  it("refuses before any insert when a name-matched account has another currency", async () => {
    const repo = repoDouble([
      {
        id: "existing-1",
        name: "Savings",
        currencyCode: "EUR",
        isClosed: false,
      },
    ]);

    await expect(
      writeAccounts(managerFor(repo), "user-1", [
        account({ key: "acct-0", name: "Other" }),
        account({ name: "Savings", currencyCode: "USD" }),
      ]),
    ).rejects.toThrow(/"Savings" uses EUR.*uses USD/);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("refuses before any insert when a name-matched account is closed", async () => {
    const repo = repoDouble([
      {
        id: "existing-1",
        name: "Savings",
        currencyCode: "CAD",
        isClosed: true,
      },
    ]);

    await expect(
      writeAccounts(managerFor(repo), "user-1", [
        account({ key: "acct-0", name: "Other" }),
        account({ name: "Savings" }),
      ]),
    ).rejects.toThrow(/"Savings" is closed/);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("seeds current_balance from the opening balance and leaves the account open", async () => {
    const repo = repoDouble();

    await writeAccounts(managerFor(repo), "user-1", [
      account({
        openingBalance: 250.5,
        closed: true,
        closedDate: "2020-01-01",
      }),
    ]);

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        openingBalance: 250.5,
        currentBalance: 250.5,
        // Closure is applyDeferredClosures' job: a closed account cannot be
        // written to, and its transactions have not landed yet.
        isClosed: false,
        linkedAccountId: null,
      }),
    );
  });

  it("writes the mapped net-worth exclusion, so a watch account imports excluded", async () => {
    const repo = repoDouble();

    await writeAccounts(managerFor(repo), "user-1", [
      account({ excludeFromNetWorth: true }),
      account({ key: "acct-2", handle: 2, name: "Visa" }),
    ]);

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Chequing", excludeFromNetWorth: true }),
    );
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Visa", excludeFromNetWorth: false }),
    );
  });

  it("wires an investment pair both ways in a patch pass, not inline", async () => {
    const repo = repoDouble();

    const written = await writeAccounts(managerFor(repo), "user-1", [
      account({
        key: "acct-5",
        name: "Brokerage",
        accountType: AccountType.INVESTMENT,
        linkedKey: "acct-5-cash",
      }),
      account({
        key: "acct-5-cash",
        handle: null,
        name: "Brokerage - Cash",
        accountType: AccountType.CASH,
        accountSubType: AccountSubType.INVESTMENT_CASH,
        linkedKey: "acct-5",
      }),
    ]);

    // Every insert goes in unlinked -- inserting either half with its link set
    // would violate the self-referencing foreign key.
    for (const [row] of repo.insert.mock.calls) {
      expect(row.linkedAccountId).toBeNull();
    }
    expect(repo.update).toHaveBeenCalledTimes(2);
    expect(repo.update).toHaveBeenCalledWith(
      { id: written.idByKey.get("acct-5"), userId: "user-1" },
      { linkedAccountId: written.idByKey.get("acct-5-cash") },
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: written.idByKey.get("acct-5-cash"), userId: "user-1" },
      { linkedAccountId: written.idByKey.get("acct-5") },
    );
  });

  it("does not patch a link whose other half was never inserted", async () => {
    const repo = repoDouble();

    await writeAccounts(managerFor(repo), "user-1", [
      account({ linkedKey: "acct-missing" }),
    ]);

    expect(repo.update).not.toHaveBeenCalled();
  });

  it("does not re-link a reused account", async () => {
    const repo = repoDouble([
      {
        id: "existing-1",
        name: "Brokerage",
        currencyCode: "CAD",
        isClosed: false,
      },
    ]);

    await writeAccounts(managerFor(repo), "user-1", [
      account({ key: "acct-5", name: "Brokerage", linkedKey: "acct-5-cash" }),
      account({ key: "acct-5-cash", handle: null, name: "Brokerage - Cash" }),
    ]);

    const patched = repo.update.mock.calls.map((call) => call[0].id);
    expect(patched).not.toContain("existing-1");
  });
});

describe("applyDeferredClosures", () => {
  it("closes only the accounts Money had closed", async () => {
    const repo = repoDouble();
    const idByKey = new Map([
      ["acct-1", "id-1"],
      ["acct-2", "id-2"],
    ]);

    const closed = await applyDeferredClosures(
      managerFor(repo),
      "user-1",
      [
        account(),
        account({
          key: "acct-2",
          closed: true,
          closedDate: "2019-06-30",
        }),
      ],
      idByKey,
    );

    expect(closed).toBe(1);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(
      { id: "id-2", userId: "user-1" },
      { isClosed: true, closedDate: "2019-06-30" },
    );
  });

  it("closes an account Money gave no closing date", async () => {
    const repo = repoDouble();

    await applyDeferredClosures(
      managerFor(repo),
      "user-1",
      [account({ closed: true, closedDate: null })],
      new Map([["acct-1", "id-1"]]),
    );

    expect(repo.update).toHaveBeenCalledWith(
      { id: "id-1", userId: "user-1" },
      { isClosed: true, closedDate: null },
    );
  });

  it("touches nothing when no account was closed", async () => {
    const repo = repoDouble();

    expect(
      await applyDeferredClosures(
        managerFor(repo),
        "user-1",
        [account()],
        new Map(),
      ),
    ).toBe(0);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("skips a closed account that never got an id", async () => {
    const repo = repoDouble();

    expect(
      await applyDeferredClosures(
        managerFor(repo),
        "user-1",
        [account({ closed: true })],
        new Map(),
      ),
    ).toBe(1);
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe("writeCategories", () => {
  /**
   * A manager whose `INSERT ... ON CONFLICT DO NOTHING RETURNING id` returns a
   * fresh id, or no row for a `name|parentId` already in `taken` -- the shape
   * PostgreSQL gives a losing insert -- and whose `findOne` then finds the
   * winner.
   */
  function categoryManager(
    repo: Record<string, jest.Mock>,
    taken: ReadonlyMap<string, string> = new Map(),
  ) {
    let next = 0;
    const query = jest.fn(async (_sql: string, params: unknown[]) => {
      if (taken.has(`${String(params[1])}|${String(params[2] ?? "")}`)) {
        return [];
      }
      next += 1;
      return [{ id: `new-${next}` }];
    });
    const findOne = jest.fn(
      async (
        _entity: unknown,
        options: { where: { name: string; parentId: unknown } },
      ) => {
        const parent =
          typeof options.where.parentId === "string"
            ? options.where.parentId
            : "";
        const id = taken.get(`${options.where.name}|${parent}`);
        return id === undefined ? null : { id };
      },
    );
    const manager = {
      getRepository: jest.fn(() => repo),
      query,
      findOne,
    } as unknown as EntityManager;
    return { manager, query, findOne };
  }

  /** The `[userId, name, parentId, isIncome]` of every category INSERT. */
  const inserts = (query: jest.Mock) =>
    query.mock.calls.map((call) => call[1] as unknown[]);

  it("creates parents before children and hangs the child off its parent", async () => {
    const { manager, query } = categoryManager(repoDouble());

    const written = await writeCategories(manager, "user-1", [
      category({ handle: 1, name: "Utilities", fullName: "Utilities" }),
      category({
        handle: 2,
        parentName: "Utilities",
        name: "Gas",
        fullName: "Utilities:Gas",
      }),
    ]);

    expect(written.created).toBe(2);
    const parentId = written.idByFullName.get("Utilities");
    expect(inserts(query)[1]).toEqual(["user-1", "Gas", parentId, false]);
    expect(String(query.mock.calls[0][0])).toContain("ON CONFLICT DO NOTHING");
  });

  it("keeps Money's income flag", async () => {
    const { manager, query } = categoryManager(repoDouble());

    await writeCategories(manager, "user-1", [
      category({ name: "Salary", fullName: "Salary", isIncome: true }),
    ]);

    expect(inserts(query)[0]).toEqual(["user-1", "Salary", null, true]);
  });

  it("reuses an existing category matched on name and parent", async () => {
    const { manager, query } = categoryManager(
      repoDouble([{ id: "existing-1", name: "groceries", parentId: null }]),
    );

    const written = await writeCategories(manager, "user-1", [category()]);

    expect(written.created).toBe(0);
    expect(written.idByFullName.get("Groceries")).toBe("existing-1");
    expect(query).not.toHaveBeenCalled();
  });

  it("adopts a category another transaction created since the read (INV-IMPORT-003)", async () => {
    // Not in the read the writer started from, but committed by the time its
    // INSERT runs: the insert loses and the winner's id is used, instead of a
    // unique violation that aborted the whole import.
    const { manager, findOne } = categoryManager(
      repoDouble([{ id: "auto-id", name: "auto", parentId: null }]),
      new Map([["Fuel|auto-id", "fuel-by-hand"]]),
    );

    const written = await writeCategories(manager, "user-1", [
      category({ handle: 1, name: "Auto", fullName: "Auto" }),
      category({
        handle: 2,
        parentName: "Auto",
        name: "Fuel",
        fullName: "Auto:Fuel",
      }),
    ]);

    expect(written.idByFullName.get("Auto:Fuel")).toBe("fuel-by-hand");
    expect(written.created).toBe(0);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it("treats the same child name under different parents as different categories", async () => {
    const { manager } = categoryManager(
      repoDouble([
        { id: "existing-gas", name: "gas", parentId: "utilities-id" },
      ]),
    );

    const written = await writeCategories(manager, "user-1", [
      category({ name: "Gas", fullName: "Gas" }),
    ]);

    // The existing row is a child of Utilities; a top-level "Gas" is not it.
    expect(written.created).toBe(1);
    expect(written.idByFullName.get("Gas")).not.toBe("existing-gas");
  });

  it("does not insert the same category twice within one import", async () => {
    const { manager, query } = categoryManager(repoDouble());

    const written = await writeCategories(manager, "user-1", [
      category(),
      category({ handle: 11 }),
    ]);

    expect(written.created).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("treats an unresolvable parent as top level rather than failing", async () => {
    const { manager, query } = categoryManager(repoDouble());

    const written = await writeCategories(manager, "user-1", [
      category({
        parentName: "Never Mapped",
        name: "Orphan",
        fullName: "Never Mapped:Orphan",
      }),
    ]);

    expect(written.created).toBe(1);
    expect(inserts(query)[0]).toEqual(["user-1", "Orphan", null, false]);
  });
});

describe("writePayees", () => {
  const payee = (overrides: Partial<MappedPayee> = {}): MappedPayee => ({
    handle: 1,
    name: "Loblaws",
    ...overrides,
  });

  it("creates payees as active and keys them by name", async () => {
    const repo = repoDouble();

    const written = await writePayees(managerFor(repo), "user-1", [payee()]);

    expect(written.created).toBe(1);
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        name: "Loblaws",
        isActive: true,
      }),
    );
    expect(written.idByName.get("Loblaws")).toBeDefined();
  });

  it("reuses an existing payee case-insensitively", async () => {
    const repo = repoDouble([{ id: "existing-1", name: "LOBLAWS" }]);

    const written = await writePayees(managerFor(repo), "user-1", [payee()]);

    expect(written.created).toBe(0);
    expect(written.idByName.get("Loblaws")).toBe("existing-1");
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("inserts a name only once even when the file repeats it", async () => {
    const repo = repoDouble();

    const written = await writePayees(managerFor(repo), "user-1", [
      payee(),
      payee({ handle: 2 }),
    ]);

    expect(written.created).toBe(1);
    expect(repo.insert).toHaveBeenCalledTimes(1);
  });
});
