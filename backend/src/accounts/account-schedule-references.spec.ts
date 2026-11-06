import { EntityManager } from "typeorm";
import { countSchedulesReferencingAccounts } from "./account-schedule-references";

describe("countSchedulesReferencingAccounts", () => {
  const managerAnswering = (rows: unknown[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { m: { query } as unknown as EntityManager, query };
  };

  it("asks nothing for no accounts", async () => {
    const { m, query } = managerAnswering([]);

    const counts = await countSchedulesReferencingAccounts(m, []);

    expect(counts.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("counts by account, as numbers, leaving an unnamed account absent", async () => {
    const { m } = managerAnswering([
      { accountId: "a", cnt: "3" },
      { accountId: "b", cnt: 1 },
    ]);

    const counts = await countSchedulesReferencingAccounts(m, ["a", "b", "c"]);

    expect(counts.get("a")).toBe(3);
    expect(counts.get("b")).toBe(1);
    expect(counts.has("c")).toBe(false);
  });

  it("reads every column that names the account and spares a loan's own schedule", async () => {
    const { m, query } = managerAnswering([]);

    await countSchedulesReferencingAccounts(m, ["a"]);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("st.account_id = ids.id");
    expect(sql).toContain("st.transfer_account_id = ids.id");
    expect(sql).toContain("st.investment_funding_account_id = ids.id");
    expect(sql).toContain("sts.transfer_account_id = ids.id");
    expect(sql).toContain("scheduled_transaction_overrides sto");
    expect(sql).toContain("lower(line->>'transferAccountId') = ids.id::text");
    expect(sql).toContain("sto.is_split IS NOT FALSE");
    expect(sql).toContain("COUNT(DISTINCT refs.schedule_id)");
    expect(sql).toContain("a.scheduled_transaction_id");
    expect(params).toEqual([["a"], ["LOAN", "MORTGAGE"]]);
  });
});
