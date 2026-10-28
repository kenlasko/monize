jest.mock("./rule-accrual", () => ({
  planRuleAccruals: async () => [],
  ruleAccrualFingerprint: (base: string) => base,
  captureRuleAccrualHistory: async () => undefined,
  assertRuleAccrualWrite: async () => false,
  assertAutomaticRuleSources: async () => undefined,
}));
import { DataSource } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { ActionHistoryService } from "../action-history/action-history.service";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { ExplainRuleRowDto } from "./dto/explain-rule-row.dto";
import { RuleRowExplanation } from "./rule-row-explain";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesService } from "./transaction-rules.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const MINE = "a0000000-0000-4000-8000-000000000001";
const FOREIGN = "a0000000-0000-4000-8000-000000000099";

const dto = (accountId: string): ExplainRuleRowDto =>
  ({
    trigger: "import",
    input: {
      accountId,
      currencyCode: "PLN",
      amount: "-5.0000",
      isTransfer: false,
      payeeId: null,
      payeeText: "Sklep",
      categoryId: null,
      description: null,
      tagIds: [],
      hasSplits: false,
    },
  }) as ExplainRuleRowDto;

function setup() {
  const mine = new Set([MINE]);
  const find = jest.fn(async (opts: { where: { id: { value: string[] } } }) =>
    opts.where.id.value.filter((id) => mine.has(id)).map((id) => ({ id })),
  );
  const findOne = jest.fn(async (opts: { where: { id: string } }) =>
    mine.has(opts.where.id) ? { id: opts.where.id, currencyCode: "PLN" } : null,
  );
  const { manager, dataSource } = createScopedDbMocks([
    [Account, { find, findOne }],
    [Payee, { find }],
    [Category, { find }],
    [Tag, { find }],
  ]);
  const explanation: RuleRowExplanation = {
    rules: [],
    labels: { accounts: {}, payees: {}, categories: {}, tags: {} },
  };
  const applier = {
    explainRow: jest.fn().mockResolvedValue(explanation),
  } as unknown as TransactionRulesApplierService;
  const service = new TransactionRulesRunService(
    dataSource as unknown as DataSource,
    {} as unknown as TransactionRulesService,
    applier,
    {} as unknown as ActionHistoryService,
    {} as never,
  );
  return { service, manager, dataSource, applier, explanation };
}

describe("TransactionRulesRunService.explainRow", () => {
  it("checks the row against the caller's data, then hands the applier the checked input and the trigger, in one scoped transaction", async () => {
    const h = setup();

    const result = await h.service.explainRow(USER, dto(MINE));

    expect(result).toBe(h.explanation);
    expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(h.applier.explainRow).toHaveBeenCalledWith(
      h.manager,
      USER,
      expect.objectContaining({
        accountId: MINE,
        currencyCode: "PLN",
        payeeText: "Sklep",
      }),
      "import",
    );
  });

  it("refuses an account that is not the caller's, and the applier is never reached", async () => {
    const h = setup();

    await expect(
      h.service.explainRow(USER, dto(FOREIGN)),
    ).rejects.toMatchObject({ status: 400 });

    expect(h.applier.explainRow).not.toHaveBeenCalled();
    expect(h.manager.update).not.toHaveBeenCalled();
    expect(h.manager.save).not.toHaveBeenCalled();
  });
});
