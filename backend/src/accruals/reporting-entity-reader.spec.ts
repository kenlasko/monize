import { DataSource, EntityManager, SelectQueryBuilder } from "typeorm";
import { ReportingTransaction } from "./entities/reporting-transaction.entity";
import { readReportingEntities } from "./reporting-entity-reader";

// Build the shipping relation graph without connecting to PostgreSQL. The
// integration suites separately exercise SQL, RLS and financial lifecycle.
const source = new DataSource({
  type: "postgres",
  entities: [__dirname + "/../**/*.entity.ts"],
});
beforeAll(async () => {
  await (
    source as unknown as { buildMetadatas(): Promise<void> }
  ).buildMetadatas();
});
const fact = (id: string, date: string) => ({
  id,
  sourceId: "payment",
  effectiveDate: date,
  cashDate: "2026-10-15",
  amount: "100",
  sourceAmount: "1200",
  isRecognition: true,
});
function query() {
  return source
    .getRepository(ReportingTransaction)
    .createQueryBuilder("t")
    .leftJoinAndSelect("t.splits", "splits")
    .leftJoinAndSelect("t.payee", "payee")
    .where("t.userId=:user", { user: "owner" })
    .andWhere("t.transaction_date >= :start", { start: "2026-11-01" })
    .orderBy("t.transactionDate", "ASC");
}
describe("recognition page hydration", () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([false, true])(
    "hydrates one cash source into independent visible months (%s)",
    async (preserve) => {
      const qb = query();
      const cash = {
        id: "payment",
        amount: "1200",
        transactionDate: "2026-10-15",
        splits: [{ id: "source-split", amount: "1200" }],
      };
      jest
        .spyOn(SelectQueryBuilder.prototype, "getRawMany")
        .mockImplementationOnce(async function (this: SelectQueryBuilder<any>) {
          expect(this.getQuery()).not.toContain('JOIN "payees"');
          expect(this.getQuery()).toContain('"t"."transaction_date" >=');
          return [fact("nov", "2026-11-30"), fact("dec", "2026-12-31")];
        });
      const hydrate = jest
        .spyOn(SelectQueryBuilder.prototype, "getMany")
        .mockImplementationOnce(async function (this: SelectQueryBuilder<any>) {
          expect(this.expressionMap.mainAlias!.metadata.tableName).toBe(
            "transactions",
          );
          expect(this.getParameters().__recognitionSourceIds).toEqual([
            "payment",
          ]);
          expect(this.getQuery()).not.toContain('"t"."transaction_date" >=');
          return [cash];
        });
      const execute = jest.fn().mockResolvedValue([
        {
          parentId: "nov",
          id: "split-nov",
          sourceId: "source-split",
          amount: "100",
          sourceAmount: "1200",
          cashDate: "2026-10-15",
          scheduleId: "schedule",
        },
        {
          parentId: "dec",
          id: "split-dec",
          sourceId: "source-split",
          amount: "100",
          sourceAmount: "1200",
          cashDate: "2026-10-15",
          scheduleId: "schedule",
        },
      ]);
      const rows = await readReportingEntities(
        { query: execute } as unknown as EntityManager,
        qb,
        preserve,
      );
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(rows.map((row) => row.id)).toEqual(
        preserve ? ["nov", "dec"] : ["payment", "payment"],
      );
      expect(rows.map((row) => row.transactionDate)).toEqual([
        "2026-11-30",
        "2026-12-31",
      ]);
      expect(rows[0].splits![0].amount).toBe("100");
      expect(rows[0].splits![0]).not.toBe(rows[1].splits![0]);
      expect(cash.amount).toBe("1200");
      expect(cash.splits[0].amount).toBe("1200");
      expect(qb.expressionMap.mainAlias!.metadata.tableName).toBe(
        "accrual_reporting_transactions",
      );
      expect(execute.mock.calls[0][0]).toContain(
        "recognition_page AS MATERIALIZED",
      );
      expect(execute.mock.calls[0][0]).not.toContain(
        "SELECT * FROM public.accrual_reporting_transactions",
      );
      expect(execute.mock.calls[0][0]).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE)\b/,
      );
    },
  );
  it("does not hydrate or load split facts for an empty page", async () => {
    jest
      .spyOn(SelectQueryBuilder.prototype, "getRawMany")
      .mockResolvedValueOnce([]);
    const hydrate = jest.spyOn(SelectQueryBuilder.prototype, "getMany");
    const execute = jest.fn();
    expect(
      await readReportingEntities(
        { query: execute } as unknown as EntityManager,
        query(),
      ),
    ).toEqual([]);
    expect(hydrate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it("skips split projection for ordinary sources and omits sources removed before hydration", async () => {
    jest
      .spyOn(SelectQueryBuilder.prototype, "getRawMany")
      .mockResolvedValueOnce([
        fact("nov", "2026-11-30"),
        { ...fact("gone", "2026-12-31"), sourceId: "deleted" },
      ]);
    jest
      .spyOn(SelectQueryBuilder.prototype, "getMany")
      .mockResolvedValueOnce([{ id: "payment", amount: "1200", splits: [] }]);
    const execute = jest.fn();
    const rows = await readReportingEntities(
      { query: execute } as unknown as EntityManager,
      query(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("payment");
    expect(execute).not.toHaveBeenCalled();
  });
});
