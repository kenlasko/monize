import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ActionHistoryService } from "../action-history/action-history.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesService } from "./transaction-rules.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const RULE_ID = "e0000000-0000-4000-8000-000000000005";
const CAT = "c0000000-0000-4000-8000-000000000003";

function setup() {
  const rulesService = { getOwnedRule: jest.fn().mockResolvedValue({}) };
  const { manager, dataSource } = createScopedDbMocks([
    [TransactionRuleApplication, { createQueryBuilder: jest.fn() }],
  ]);
  const service = new TransactionRulesRunService(
    dataSource as unknown as DataSource,
    rulesService as unknown as TransactionRulesService,
    {} as TransactionRulesApplierService,
    {} as ActionHistoryService,
    {} as never,
  );
  return { service, manager, rulesService };
}

describe("TransactionRulesRunService.applications", () => {
  beforeEach(() => jest.clearAllMocks());

  function qbReturning(rows: unknown[]) {
    const qb: Record<string, jest.Mock> = {};
    for (const name of [
      "innerJoinAndSelect",
      "where",
      "andWhere",
      "orderBy",
      "addOrderBy",
      "take",
    ]) {
      qb[name] = jest.fn().mockReturnValue(qb);
    }
    qb.getMany = jest.fn().mockResolvedValue(rows);
    return qb;
  }

  it("returns the latest applications with the row's date, payee and amount, scoped to the user and rule", async () => {
    const s = setup();
    const applied = new Date("2026-03-11T10:00:00Z");
    const qb = qbReturning([
      {
        id: "ap1",
        transactionId: "t1",
        source: "manual",
        changes: { categoryId: { before: null, after: CAT } },
        appliedAt: applied,
        transaction: {
          transactionDate: "2026-03-10",
          payeeName: "SHOP 1",
          amount: "-12.5000",
          currencyCode: "PLN",
        },
      },
    ]);
    s.manager.getRepository.mockReturnValue({
      createQueryBuilder: () => qb,
    });

    const rows = await s.service.applications(USER, RULE_ID, 10);

    expect(rows).toEqual([
      {
        id: "ap1",
        transactionId: "t1",
        date: "2026-03-10",
        payeeName: "SHOP 1",
        amount: -12.5,
        currencyCode: "PLN",
        source: "manual",
        changes: { categoryId: { before: null, after: CAT } },
        appliedAt: applied,
      },
    ]);
    expect(qb.where).toHaveBeenCalledWith("application.userId = :userId", {
      userId: USER,
    });
    expect(qb.andWhere).toHaveBeenCalledWith("application.ruleId = :ruleId", {
      ruleId: RULE_ID,
    });
    expect(qb.take).toHaveBeenCalledWith(10);
    expect(s.rulesService.getOwnedRule).toHaveBeenCalled();
  });

  it("clamps the limit to 1..200 and defaults to 50", async () => {
    const s = setup();
    const qb = qbReturning([]);
    s.manager.getRepository.mockReturnValue({
      createQueryBuilder: () => qb,
    });
    await s.service.applications(USER, RULE_ID, 9999);
    await s.service.applications(USER, RULE_ID, 0);
    await s.service.applications(USER, RULE_ID);
    expect(qb.take.mock.calls.map((c) => c[0])).toEqual([200, 1, 50]);
  });

  it("404s a rule that is not the caller's", async () => {
    const s = setup();
    s.rulesService.getOwnedRule.mockRejectedValue(new NotFoundException("x"));
    await expect(s.service.applications(USER, RULE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("tolerates a row whose transaction was not joined", async () => {
    const s = setup();
    const qb = qbReturning([
      {
        id: "ap",
        transactionId: "t",
        source: "create",
        changes: {},
        appliedAt: new Date(0),
      },
    ]);
    s.manager.getRepository.mockReturnValue({
      createQueryBuilder: () => qb,
    });
    const [only] = await s.service.applications(USER, RULE_ID);
    expect(only).toMatchObject({
      date: "",
      payeeName: null,
      amount: 0,
      currencyCode: "",
    });
  });
});
