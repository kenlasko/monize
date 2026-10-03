import { DataSource } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionRulesService } from "./transaction-rules.service";

export const USER_ID = "user-1";
export const ACCOUNT_ID = "a0000000-0000-4000-8000-000000000001";
export const PAYEE_ID = "b0000000-0000-4000-8000-000000000002";
export const CATEGORY_ID = "c0000000-0000-4000-8000-000000000003";
export const TAG_ID = "d0000000-0000-4000-8000-000000000004";
export const RULE_ID = "e0000000-0000-4000-8000-000000000005";

export const VALID_CONDITION: RuleConditionNode = {
  all: [
    { field: "accountId", op: "eq", value: ACCOUNT_ID },
    { field: "payeeId", op: "eq", value: PAYEE_ID },
  ],
};

export const VALID_ACTIONS: RuleAction[] = [
  { type: "set_category", categoryId: CATEGORY_ID, onlyIfEmpty: true },
  { type: "add_tags", tagIds: [TAG_ID] },
];

export function storedRule(
  over: Partial<TransactionRule> = {},
): TransactionRule {
  return {
    id: RULE_ID,
    userId: USER_ID,
    name: "Groceries",
    enabled: true,
    position: 0,
    triggers: ["create", "import"],
    condition: VALID_CONDITION,
    actions: VALID_ACTIONS,
    stopProcessing: false,
    activeFrom: null,
    activeTo: null,
    revision: 3,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

type Repo = Record<string, jest.Mock>;

/** A reference table that knows only `existing` ids; ids are matched as `In(...)` lists. */
function referenceRepo(existing: Set<string>): Repo {
  return {
    find: jest.fn(async (opts: { where: { id: { value: string[] } } }) =>
      opts.where.id.value
        .filter((id) => existing.has(id))
        .map((id) => ({ id })),
    ),
  };
}

/**
 * The service over mocked repositories. `existing` is the set of ids that
 * belong to the user across the four referenced tables (ids are unique per
 * kind in the fixtures); everything else is foreign or missing.
 */
export function buildHarness(
  existing: string[] = [ACCOUNT_ID, PAYEE_ID, CATEGORY_ID, TAG_ID],
) {
  const known = new Set(existing);
  const rules: Repo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((row: object) => ({ ...row })),
    save: jest.fn(async (row: object) => ({
      id: RULE_ID,
      revision: 1,
      createdAt: new Date("2026-09-28T00:00:00Z"),
      updatedAt: new Date("2026-09-28T00:00:00Z"),
      ...row,
    })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const rawMax = jest.fn().mockResolvedValue({ max: null });
  rules.createQueryBuilder = jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: rawMax,
  }));
  const refs = {
    accounts: referenceRepo(known),
    payees: referenceRepo(known),
    categories: referenceRepo(known),
    tags: referenceRepo(known),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [TransactionRule, rules],
    [Account, refs.accounts],
    [Payee, refs.payees],
    [Category, refs.categories],
    [Tag, refs.tags],
  ]);
  manager.query.mockResolvedValue([]);
  const service = new TransactionRulesService(
    dataSource as unknown as DataSource,
  );
  /** Statements that changed the database: nothing but the lock may run on a refusal. */
  const writes = (): string[] => [
    ...rules.save.mock.calls.map(() => "save"),
    ...rules.update.mock.calls.map(() => "update"),
    ...rules.delete.mock.calls.map(() => "delete"),
    ...manager.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => !sql.includes("pg_advisory_xact_lock")),
  ];
  return { service, manager, rules, refs, rawMax, writes };
}

export const FOREIGN_ID = "f0000000-0000-4000-8000-00000000000f";

/** The error a promise rejects with; fails if it resolves. */
export async function thrown(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}
