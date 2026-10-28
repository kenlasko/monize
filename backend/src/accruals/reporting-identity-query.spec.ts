import { DataSource, SelectQueryBuilder } from "typeorm";
import {
  reportingIdentityQuery,
  reportingIdentityPage,
} from "./reporting-identity-query";
const source = new DataSource({ type: "postgres" });
const builder = () =>
  source
    .createQueryBuilder()
    .from("transactions", "t")
    .leftJoin("transaction_splits", "sp", "sp.transaction_id=t.id")
    .leftJoin("categories", "category", "category.id=sp.category_id")
    .leftJoin("payees", "display_payee", "display_payee.id=t.payee_id")
    .where("t.user_id=:user", { user: "owner" });
describe("page identity query boundaries", () => {
  it("prunes display joins while preserving filter dependencies and the original builder", () => {
    const query = builder().andWhere("category.is_income=false");
    const lean = reportingIdentityQuery(query, false);
    expect(
      lean.expressionMap.joinAttributes.map((join) => join.alias.name),
    ).toEqual(["sp", "category"]);
    expect(query.expressionMap.joinAttributes).toHaveLength(3);
    expect(lean.getParameters()).toEqual({ user: "owner" });
  });
  it("keeps inner joins and quoted order dependencies only where needed", () => {
    const query = builder()
      .innerJoin("accounts", "account", "account.id=t.account_id")
      .orderBy('"display_payee"."name"');
    expect(
      reportingIdentityQuery(query, false).expressionMap.joinAttributes.map(
        (join) => join.alias.name,
      ),
    ).toEqual(["account"]);
    expect(
      reportingIdentityQuery(query, true).expressionMap.joinAttributes.map(
        (join) => join.alias.name,
      ),
    ).toEqual(["display_payee", "account"]);
  });
  it("uses SQL offset/limit for distinct joined identities", async () => {
    const query = builder().orderBy("t.transaction_date", "DESC");
    const raw = jest
      .spyOn(SelectQueryBuilder.prototype, "getRawMany")
      .mockImplementationOnce(async function (this: SelectQueryBuilder<any>) {
        expect(this.expressionMap.skip).toBeUndefined();
        expect(this.expressionMap.take).toBeUndefined();
        expect(this.expressionMap.offset).toBe(50);
        expect(this.expressionMap.limit).toBe(25);
        expect(this.getQuery()).toContain("SELECT DISTINCT t.id AS");
        return [{ id: "visible" }];
      });
    try {
      expect(await reportingIdentityPage(query, 50, 25)).toEqual([
        { id: "visible" },
      ]);
    } finally {
      raw.mockRestore();
    }
  });
});
