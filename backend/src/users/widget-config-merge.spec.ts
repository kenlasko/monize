import type { EntityManager } from "typeorm";
import {
  dropInvisibleAccountIds,
  restoreAccountIdInWidgetConfig,
  stripAccountIdsFromWidgetConfig,
} from "./widget-config-merge";

const managerWith = (...answers: unknown[]) => {
  const query = jest.fn();
  for (const answer of answers) query.mockResolvedValueOnce(answer);
  query.mockResolvedValue([]);
  return { query, manager: { query } as unknown as EntityManager };
};

describe("stripAccountIdsFromWidgetConfig", () => {
  it("does not write when no array names the account", async () => {
    const { query, manager } = managerWith([]);
    expect(await stripAccountIdsFromWidgetConfig(manager, "u", ["a"])).toEqual(
      [],
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns the index and the array it left, keeping null elements", async () => {
    const { manager } = managerWith([
      { widget_id: "w", key: "accountIds", arr: [null, "b", "a"] },
    ]);
    expect(await stripAccountIdsFromWidgetConfig(manager, "u", ["a"])).toEqual([
      { widgetId: "w", key: "accountIds", index: 2, after: [null, "b"] },
    ]);
  });
});

describe("restoreAccountIdInWidgetConfig", () => {
  const ref = { widgetId: "w", key: "accountIds", index: 1, after: ["b", "c"] };

  it("inserts the id at its old index, guarded by the array the delete left", async () => {
    const { query, manager } = managerWith();
    await restoreAccountIdInWidgetConfig(manager, "u", "a", [ref]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("= $4::jsonb");
    expect(params).toEqual([
      "u",
      "w",
      "accountIds",
      JSON.stringify(["b", "c"]),
      JSON.stringify(["b", "a", "c"]),
    ]);
  });

  it("skips a reference without a usable index or stored array", async () => {
    const { query, manager } = managerWith();
    await restoreAccountIdInWidgetConfig(manager, "u", "a", [
      { widgetId: "w", key: "k" } as never,
      { ...ref, index: -1 },
    ]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("dropInvisibleAccountIds", () => {
  it("keeps own and joint ids, drops the rest, and skips the lookup when nothing names an account", async () => {
    const none = managerWith();
    const sent = { w: { range: "1y" } };
    expect(
      await dropInvisibleAccountIds(none.manager, "u", sent, async () => []),
    ).toBe(sent);
    expect(none.query).not.toHaveBeenCalled();

    const { manager } = managerWith([{ id: "own" }]);
    const jointIds = jest.fn().mockResolvedValue(["joint"]);
    expect(
      await dropInvisibleAccountIds(
        manager,
        "u",
        {
          w: { accountIds: ["own", "joint", "gone"], range: "1y" },
          hero: { portfolioAccountIds: ["gone", "own"] },
          layout: null,
        },
        jointIds,
      ),
    ).toEqual({
      w: { accountIds: ["own", "joint"], range: "1y" },
      hero: { portfolioAccountIds: ["own"] },
      layout: null,
    });
  });

  it("does not ask for joint accounts when every id is the user's own", async () => {
    const { manager } = managerWith([{ id: "own" }]);
    const jointIds = jest.fn();
    await dropInvisibleAccountIds(
      manager,
      "u",
      { w: { accountIds: ["own"] } },
      jointIds,
    );
    expect(jointIds).not.toHaveBeenCalled();
  });
});
