import { EntityManager } from "typeorm";
import {
  isCategoryPartnerRecord,
  lockRowsWithCategoryPartners,
  undoCategoryPartner,
  writeCategoryPartner,
} from "./transfer-category-partner";

/** INV-CATEGORY-002: the other side of a transfer, written and undone. */
describe("transfer category partner", () => {
  const managerAnswering = (held: string | null, reconciled = false) => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT category_id")) return [{ category_id: held }];
      if (sql.includes("status = $3")) {
        return reconciled ? [{ status: "RECONCILED" }] : [];
      }
      return [];
    });
    const m = {
      query,
      getRepository: () => ({
        findOne: jest
          .fn()
          .mockResolvedValue({ lockReconciledTransactions: true }),
      }),
    } as unknown as EntityManager;
    return { m, query };
  };
  const updates = (query: jest.Mock) =>
    query.mock.calls.filter(([sql]: [string]) => sql.startsWith("UPDATE"));

  it("writes the other leg only when it holds another category, and records both values", async () => {
    const { m, query } = managerAnswering("cat-old");
    const written = await writeCategoryPartner(
      m,
      "user-1",
      { kind: "leg", id: "leg-2" },
      "cat-new",
    );
    expect(written).toEqual({
      before: { kind: "leg", id: "leg-2", categoryId: "cat-old" },
      after: { kind: "leg", id: "leg-2", categoryId: "cat-new" },
    });
    expect(updates(query)).toHaveLength(1);

    const same = managerAnswering("cat-new");
    await expect(
      writeCategoryPartner(
        same.m,
        "user-1",
        { kind: "leg", id: "leg-2" },
        "cat-new",
      ),
    ).resolves.toBeNull();
    expect(updates(same.query)).toHaveLength(0);
  });

  it("refuses an undo that would rewrite a reconciled other side, writing nothing", async () => {
    const { m, query } = managerAnswering("cat-new", true);
    await expect(
      undoCategoryPartner(m, "user-1", {
        kind: "line",
        id: "line-1",
        parentId: "parent-1",
        categoryId: "cat-old",
      }),
    ).rejects.toThrow();
    expect(updates(query)).toHaveLength(0);
  });

  it("locks a partner line's split parent before the rows, and the other legs ascending with them", async () => {
    // The order the forward write took them (`common/db/locks.ts`), so an
    // undo and an edit of the other side cannot deadlock.
    const query = jest.fn(async (_sql: string, params: unknown[]) =>
      (params[0] as string[]).map((id) => ({ id })),
    );
    const m = { query } as unknown as EntityManager;
    const locked = await lockRowsWithCategoryPartners(
      m,
      "user-1",
      ["row-b"],
      [
        { kind: "line", id: "line-1", parentId: "parent-1", categoryId: null },
        { kind: "leg", id: "leg-a", categoryId: null },
      ],
    );
    const locks = query.mock.calls
      .filter(([sql]) => sql.includes("FOR UPDATE"))
      .map(([, params]) => params[0]);
    expect(locks).toEqual([["parent-1"], ["leg-a", "row-b"]]);
    expect([...locked.keys()]).toEqual(["leg-a", "row-b"]);
  });

  it("reads only a well-formed record from a history snapshot", () => {
    expect(
      isCategoryPartnerRecord({ kind: "leg", id: "x", categoryId: null }),
    ).toBe(true);
    expect(
      isCategoryPartnerRecord({ kind: "row", id: "x", categoryId: null }),
    ).toBe(false);
    expect(isCategoryPartnerRecord(undefined)).toBe(false);
  });
});
