import { QueryFailedError } from "typeorm";
import { insertPayeeAliasIgnoringDuplicate } from "./insert-payee-alias.util";
import { PayeeAlias } from "./entities/payee-alias.entity";

function makeQueryRunner(save: jest.Mock) {
  return {
    query: jest.fn().mockResolvedValue(undefined),
    manager: { save },
  } as never;
}

const alias = { alias: "*LIDL*" } as PayeeAlias;

describe("insertPayeeAliasIgnoringDuplicate", () => {
  it("saves the alias and releases the savepoint, returning true", async () => {
    const save = jest.fn().mockResolvedValue(alias);
    const qr = makeQueryRunner(save);

    const created = await insertPayeeAliasIgnoringDuplicate(qr, alias, "sp");

    expect(created).toBe(true);
    expect(save).toHaveBeenCalledWith(alias);
    expect((qr as unknown as { query: jest.Mock }).query.mock.calls).toEqual([
      ["SAVEPOINT sp"],
      ["RELEASE SAVEPOINT sp"],
    ]);
  });

  it("rolls back to the savepoint and returns false on a unique violation", async () => {
    const save = jest.fn().mockRejectedValue(
      new QueryFailedError("insert", undefined, {
        code: "23505",
      } as unknown as Error),
    );
    const qr = makeQueryRunner(save);

    const created = await insertPayeeAliasIgnoringDuplicate(qr, alias, "sp");

    expect(created).toBe(false);
    expect((qr as unknown as { query: jest.Mock }).query).toHaveBeenCalledWith(
      "ROLLBACK TO SAVEPOINT sp",
    );
  });

  it("rethrows a non-unique database error after rolling back", async () => {
    const save = jest.fn().mockRejectedValue(
      new QueryFailedError("insert", undefined, {
        code: "23503",
      } as unknown as Error),
    );
    const qr = makeQueryRunner(save);

    await expect(
      insertPayeeAliasIgnoringDuplicate(qr, alias, "sp"),
    ).rejects.toBeInstanceOf(QueryFailedError);
    expect((qr as unknown as { query: jest.Mock }).query).toHaveBeenCalledWith(
      "ROLLBACK TO SAVEPOINT sp",
    );
  });

  it("rethrows non-QueryFailedError errors", async () => {
    const save = jest.fn().mockRejectedValue(new Error("connection lost"));
    const qr = makeQueryRunner(save);

    await expect(
      insertPayeeAliasIgnoringDuplicate(qr, alias, "sp"),
    ).rejects.toThrow("connection lost");
  });
});
