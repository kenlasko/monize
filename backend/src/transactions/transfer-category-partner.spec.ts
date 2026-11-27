import { EntityManager } from "typeorm";
import {
  isCategoryPartnerRecord,
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
