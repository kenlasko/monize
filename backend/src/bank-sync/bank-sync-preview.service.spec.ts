import { ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { I18nService } from "nestjs-i18n";
import { DataSource } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { PayeesService } from "../payees/payees.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import type {
  RuleEffects,
  RuleTraceEntry,
} from "../transaction-rules/rule-effects";
import type { RuleEffectsLabels } from "../transaction-rules/transaction-rules-applier.service";
import { TransactionRulesApplierService } from "../transaction-rules/transaction-rules-applier.service";
import type { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NO_BANK_OPERATION } from "./bank-operation";
import { planFingerprint } from "./bank-sync-plan-fingerprint";
import { resolveProfile } from "./bank-sync-profiles";
import {
  BankSyncPreviewService,
  BuildBankSyncPreviewInput,
} from "./bank-sync-preview.service";
import {
  ACCOUNT_ID,
  BANK_ACCOUNT_ID,
  bankAccountRow,
  bankTransaction,
  USER_ID,
} from "./bank-sync-testing";
import { explainBankImport } from "./bank-transaction-planner";
import { BankSyncAccount } from "./entities/bank-sync-account.entity";
import type { BankTransaction } from "./providers/bank-sync-provider.interface";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const PKO_BP = resolveProfile("enable_banking", "PL", "PKO Bank Polski");

const CTX = {
  accountCurrencyCode: "PLN",
  syncFromDate: "2026-08-01",
  today: "2026-09-30",
};

describe("BankSyncPreviewService", () => {
  const linkRepo = { findOne: jest.fn() };
  const accountRepo = { findOne: jest.fn() };
  const preferenceRepo = { findOne: jest.fn() };
  const { manager, dataSource } = createScopedDbMocks([
    [BankSyncAccount, linkRepo],
    [Account, accountRepo],
    [UserPreference, preferenceRepo],
  ]);
  const rulesApplier: jest.Mocked<
    Pick<
      TransactionRulesApplierService,
      "loadRulesFor" | "planForRow" | "labelsFor"
    >
  > = { loadRulesFor: jest.fn(), planForRow: jest.fn(), labelsFor: jest.fn() };
  const payees: jest.Mocked<
    Pick<PayeesService, "findByName" | "findPayeeByAlias" | "getAllAliases">
  > = {
    findByName: jest.fn(),
    findPayeeByAlias: jest.fn(),
    getAllAliases: jest.fn(),
  };
  /** Answers `<language>:<English>`, so a label is seen to come from the catalogue. */
  const i18n = {
    translate: jest.fn(
      (
        _key: string,
        options?: { lang?: string; defaultValue?: string },
      ): string => `${options?.lang}:${options?.defaultValue}`,
    ),
  };

  let service: BankSyncPreviewService;

  const account = (over: Partial<Account> = {}): Account =>
    ({
      id: ACCOUNT_ID,
      userId: USER_ID,
      currencyCode: "PLN",
      currentBalance: 1000,
      isClosed: false,
      accountSubType: null,
      ...over,
    }) as Account;

  const rows = (): BankTransaction[] => [
    bankTransaction({
      entryReference: "r1",
      amount: "50.00",
      direction: "debit",
      counterpartyName: "Biedronka",
    }),
    bankTransaction({
      entryReference: "r2",
      amount: "1200.1234",
      direction: "credit",
      counterpartyName: "Employer",
      remittance: ["Salary"],
    }),
    bankTransaction({ entryReference: "r3", currencyCode: "EUR" }),
    bankTransaction({ entryReference: "r4", booked: false }),
    bankTransaction({ entryReference: "r5", bookingDate: "2026-07-01" }),
  ];

  const input = (
    over: Partial<BuildBankSyncPreviewInput> = {},
    bankRows: BankTransaction[] = rows(),
  ): BuildBankSyncPreviewInput => ({
    userId: USER_ID,
    bankAccountId: BANK_ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    plannedSyncFromDate: "2026-08-01",
    plannedCurrencyCode: "PLN",
    explained: explainBankImport(bankRows, CTX),
    balance: null,
    tagOperationType: true,
    profile: PKO_BP,
    ...over,
  });

  /**
   * The ledger SELECT answers with `held`, `excepted` of them being exceptions;
   * a tag lookup answers from `tags` (lower-cased name to id).
   */
  function ledgerHolding(
    held: string[] = [],
    excepted: string[] = [],
    tags: Record<string, string> = {},
  ) {
    manager.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        const text = String(sql);
        if (text.includes("SELECT external_key")) {
          return [...held, ...excepted].map((external_key) => ({
            external_key,
            excluded: excepted.includes(external_key),
          }));
        }
        if (text.includes("FROM tags")) {
          const id = tags[String(params![1]).toLowerCase()];
          return id === undefined ? [] : [{ id }];
        }
        return [];
      },
    );
  }

  const NO_EFFECTS: RuleEffects = {
    changes: { addTagIds: [], removeTagIds: [] },
    trace: [],
    aiReviewRequests: [],
  };
  const NO_LABELS: RuleEffectsLabels = {
    categories: {},
    payees: {},
    tags: {},
    rules: {},
  };

  const writes = () =>
    manager.query.mock.calls.filter(
      (call) => !/^\s*SELECT/i.test(String(call[0])),
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    linkRepo.findOne.mockResolvedValue(bankAccountRow());
    accountRepo.findOne.mockResolvedValue(account());
    rulesApplier.loadRulesFor.mockResolvedValue([]);
    rulesApplier.planForRow.mockResolvedValue(NO_EFFECTS);
    rulesApplier.labelsFor.mockResolvedValue(NO_LABELS);
    payees.findByName.mockResolvedValue(null);
    payees.findPayeeByAlias.mockResolvedValue(null);
    payees.getAllAliases.mockResolvedValue([]);
    preferenceRepo.findOne.mockResolvedValue({ language: "pl" });
    ledgerHolding();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankSyncPreviewService,
        { provide: DataSource, useValue: dataSource },
        { provide: TransactionRulesApplierService, useValue: rulesApplier },
        { provide: PayeesService, useValue: payees },
        { provide: I18nService, useValue: i18n },
      ],
    }).compile();
    service = module.get(BankSyncPreviewService);
  });

  describe("the rows", () => {
    it("lists every provider row once with its outcome, in the provider's order", async () => {
      const view = await service.build(input());
      expect(view.rows.map((r) => r.outcome)).toEqual([
        "new",
        "new",
        "refused",
        "pending",
        "before_cutoff",
      ]);
      expect(view.rows[2].refusalReason).toBe("currency_mismatch");
      expect(view.rows[0].refusalReason).toBeNull();
    });

    it("gives a new row the planner's own date, signed money, currency and text", async () => {
      const [first, second] = (await service.build(input())).rows;
      expect(first).toMatchObject({
        transactionDate: "2026-09-10",
        amount: "-50.0000",
        currencyCode: "PLN",
        payeeText: "Biedronka",
        description: "Groceries",
        referenceNumber: null,
      });
      expect(second).toMatchObject({
        amount: "1200.1234",
        payeeText: "Employer",
        description: "Salary",
      });
    });

    it("lists a row the ledger holds as a duplicate, with nothing resolved for it", async () => {
      ledgerHolding(["ref:r1"]);
      const view = await service.build(input());
      expect(view.rows[0]).toMatchObject({
        outcome: "duplicate",
        externalKey: "ref:r1",
        payeeText: "Biedronka",
        payeeName: null,
        categoryName: null,
        tagNames: [],
        payee: null,
        rules: [],
        operationTag: null,
      });
      expect(view.rows[1].outcome).toBe("new");
      // The payee lookup is for new rows only.
      expect(payees.findByName).not.toHaveBeenCalledWith(USER_ID, "Biedronka");
    });

    it("shows a refused row as the bank sent it, a foreign amount in its own currency", async () => {
      const view = await service.build(input());
      expect(view.rows[2]).toMatchObject({
        outcome: "refused",
        currencyCode: "EUR",
        amount: "-12.3400",
        payeeName: null,
      });
    });

    it("shows an amount it cannot read as unknown, not zero", async () => {
      const view = await service.build(
        input({}, [bankTransaction({ entryReference: "x", amount: "abc" })]),
      );
      expect(view.rows[0]).toMatchObject({ outcome: "refused", amount: null });
    });
  });

  describe("the summary and the balances", () => {
    it("counts every outcome", async () => {
      ledgerHolding(["ref:r1"]);
      const { summary } = await service.build(input());
      expect(summary).toEqual({
        new: 1,
        duplicate: 1,
        excluded: 0,
        refused: 1,
        refusedByReason: {
          missing_date: 0,
          future_date: 0,
          invalid_amount: 0,
          unknown_direction: 0,
          currency_mismatch: 1,
        },
        pending: 1,
        beforeCutoff: 1,
      });
    });

    it("answers the current balance and the balance after the new rows, added in scaled integers", async () => {
      accountRepo.findOne.mockResolvedValue(account({ currentBalance: 0.1 }));
      const view = await service.build(
        input({}, [
          bankTransaction({
            entryReference: "a",
            amount: "0.2",
            direction: "credit",
          }),
          bankTransaction({
            entryReference: "b",
            amount: "0.0001",
            direction: "credit",
          }),
        ]),
      );
      expect(view.monizeBalance).toBe("0.1000");
      // 0.1 + 0.2 + 0.0001 with no float residue.
      expect(view.balanceAfter).toBe("0.3001");
    });

    it("does not count a duplicate, a refused, a pending or a before-cutoff row in the balance after", async () => {
      ledgerHolding(["ref:r1"]);
      const view = await service.build(input());
      // 1000 + 1200.1234: r1 is a duplicate, r3 refused, r4 pending, r5 early.
      expect(view.balanceAfter).toBe("2200.1234");
    });

    it("answers the bank's balance and the difference to the balance after, when the currencies agree", async () => {
      const view = await service.build(
        input({
          balance: {
            amount: 2300.1234,
            currencyCode: "PLN",
            referenceDate: "2026-09-29",
          },
        }),
      );
      expect(view.bankBalance).toEqual({
        amount: "2300.1234",
        currencyCode: "PLN",
        referenceDate: "2026-09-29",
      });
      // 2300.1234 - (1000 - 50 + 1200.1234)
      expect(view.difference).toBe("150.0000");
    });

    it("answers no difference, but still the bank's balance, when the currencies differ", async () => {
      const view = await service.build(
        input({
          balance: { amount: 10, currencyCode: "EUR", referenceDate: null },
        }),
      );
      expect(view.bankBalance).toMatchObject({ currencyCode: "EUR" });
      expect(view.difference).toBeNull();
    });

    it("answers a null bank balance and a null difference when the bank reported none", async () => {
      const view = await service.build(input());
      expect(view.bankBalance).toBeNull();
      expect(view.difference).toBeNull();
    });

    it("keeps a zero difference as a number: it reconciles", async () => {
      const view = await service.build(
        input({
          balance: {
            amount: 2150.1234,
            currencyCode: "pln",
            referenceDate: null,
          },
        }),
      );
      expect(view.difference).toBe("0.0000");
    });
  });

  describe("the fingerprint", () => {
    it("is the fingerprint of the new rows only, so a duplicate does not move it", async () => {
      const everything = await service.build(input());
      ledgerHolding(["ref:r1"]);
      const withoutDuplicate = await service.build(input());
      const planned = input().explained.plan.planned;
      expect(everything.planFingerprint).toBe(planFingerprint(planned));
      expect(withoutDuplicate.planFingerprint).toBe(
        planFingerprint([planned[1]]),
      );
      expect(withoutDuplicate.planFingerprint).not.toBe(
        everything.planFingerprint,
      );
    });
  });

  describe("it writes nothing", () => {
    it("issues only SELECTs and takes no lock", async () => {
      ledgerHolding(["ref:r1"]);
      await service.build(input());
      expect(writes()).toEqual([]);
      for (const call of manager.query.mock.calls) {
        expect(String(call[0])).not.toMatch(/FOR UPDATE|INSERT|UPDATE|DELETE/);
      }
      for (const repo of [linkRepo, accountRepo]) {
        expect(repo.findOne.mock.calls.every((c) => !c[0]?.lock)).toBe(true);
      }
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.create).not.toHaveBeenCalled();
    });

    it("reads the caller's own rows", async () => {
      await service.build(input());
      expect(linkRepo.findOne).toHaveBeenCalledWith({
        where: { id: BANK_ACCOUNT_ID, userId: USER_ID },
      });
      expect(accountRepo.findOne).toHaveBeenCalledWith({
        where: { id: ACCOUNT_ID, userId: USER_ID },
      });
      const [, params] = manager.query.mock.calls[0];
      expect(params).toEqual([ACCOUNT_ID, USER_ID, expect.any(Array)]);
    });
  });

  describe("the payee and the import rules", () => {
    it("resolves an existing payee by name, and shows its default category", async () => {
      payees.findByName.mockImplementation(async (_user, name) =>
        name === "Biedronka"
          ? ({
              id: "payee-1",
              name: "Biedronka",
              defaultCategoryId: "cat-1",
              defaultCategory: { name: "Groceries" },
            } as never)
          : null,
      );
      const [first, second] = (await service.build(input())).rows;
      expect(first).toMatchObject({
        payeeName: "Biedronka",
        categoryName: "Groceries",
      });
      // No payee yet: the sync would create one named after the counterparty.
      expect(second).toMatchObject({
        payeeName: "Employer",
        categoryName: null,
      });
    });

    it("resolves by alias the way the sync does, showing the canonical name", async () => {
      payees.findPayeeByAlias.mockResolvedValue({
        id: "payee-2",
        name: "Biedronka S.A.",
        defaultCategoryId: null,
        defaultCategory: null,
      } as never);
      const [first] = (await service.build(input())).rows;
      expect(first.payeeName).toBe("Biedronka S.A.");
      expect(first.categoryName).toBeNull();
    });

    it("looks each counterparty up once", async () => {
      await service.build(
        input({}, [
          bankTransaction({ entryReference: "a" }),
          bankTransaction({ entryReference: "b" }),
        ]),
      );
      expect(payees.findByName).toHaveBeenCalledTimes(1);
    });

    it("shows no payee for a row with no counterparty", async () => {
      const view = await service.build(
        input({}, [
          bankTransaction({
            entryReference: "n",
            counterpartyName: null,
            remittance: [],
          }),
        ]),
      );
      expect(view.rows[0]).toMatchObject({ payeeText: null, payeeName: null });
      expect(payees.findByName).not.toHaveBeenCalled();
    });

    describe("with import rules", () => {
      /** A trace entry of a rule that matched and set a category. */
      const matchedTrace = (
        over: Partial<RuleTraceEntry> = {},
      ): RuleTraceEntry => ({
        ruleId: "rule-1",
        matched: true,
        applied: [{ type: "set_category" }],
        skipped: [],
        changes: { categoryId: { before: null, after: "cat-9" } },
        stopped: false,
        ...over,
      });
      const effects = (
        changes: Partial<RuleEffects["changes"]> = {},
        trace: RuleTraceEntry[] = [matchedTrace()],
      ): RuleEffects => ({
        changes: { addTagIds: [], removeTagIds: [], ...changes },
        trace,
        aiReviewRequests: [],
      });
      const labels = (
        over: Partial<RuleEffectsLabels> = {},
      ): RuleEffectsLabels => ({
        ...NO_LABELS,
        ...over,
      });
      const RULES = [{ id: "rule-1" }, { id: "rule-2" }] as TransactionRule[];

      beforeEach(() => {
        rulesApplier.loadRulesFor.mockResolvedValue(RULES);
      });

      it("loads the rules once, then plans each new row through planForRow with the facts the write would give it", async () => {
        await service.build(input());
        expect(rulesApplier.loadRulesFor).toHaveBeenCalledTimes(1);
        expect(rulesApplier.loadRulesFor).toHaveBeenCalledWith(
          manager,
          USER_ID,
          "import",
        );
        expect(rulesApplier.planForRow).toHaveBeenCalledTimes(2);
        const [m, userId, facts, rules] = rulesApplier.planForRow.mock.calls[0];
        expect(m).toBe(manager);
        expect(userId).toBe(USER_ID);
        expect(rules).toBe(RULES);
        expect(facts).toMatchObject({
          accountId: ACCOUNT_ID,
          currencyCode: "PLN",
          amount: -50,
          isTransfer: false,
          payeeText: "Biedronka",
          description: "Groceries",
          status: "CLEARED",
          transactionDate: "2026-09-10",
          tagIds: [],
          hasSplits: false,
        });
      });

      it("loads the rules once however many rows there are", async () => {
        const many = Array.from({ length: 25 }, (_, i) =>
          bankTransaction({ entryReference: `m${i}`, amount: `${i + 1}.00` }),
        );
        await service.build(input({}, many));
        expect(rulesApplier.loadRulesFor).toHaveBeenCalledTimes(1);
        expect(rulesApplier.planForRow).toHaveBeenCalledTimes(25);
      });

      it("does not plan a duplicate, an exception or a refused row", async () => {
        ledgerHolding(["ref:r1"], ["ref:r2"]);
        await service.build(input());
        expect(rulesApplier.planForRow).not.toHaveBeenCalled();
      });

      it("shows the category, tags and payee the rules would set, by name", async () => {
        rulesApplier.planForRow
          .mockResolvedValueOnce(
            effects({
              categoryId: "cat-9",
              addTagIds: ["tag-1", "tag-2"],
              removeTagIds: ["tag-2"],
              payeeId: "payee-9",
            }),
          )
          .mockResolvedValueOnce(NO_EFFECTS);
        rulesApplier.labelsFor.mockResolvedValueOnce(
          labels({
            categories: { "cat-9": "Food" },
            tags: { "tag-1": "Weekly", "tag-2": "Gone" },
            payees: { "payee-9": "Biedronka S.A." },
            rules: { "rule-1": "Food rule" },
          }),
        );
        const [first, second] = (await service.build(input())).rows;
        expect(first).toMatchObject({
          categoryName: "Food",
          tagNames: ["Weekly"],
          payeeName: "Biedronka S.A.",
        });
        expect(second).toMatchObject({
          categoryName: null,
          tagNames: [],
          payeeName: "Employer",
        });
      });

      it("shows a payee a rule would create, and a category a rule clears", async () => {
        payees.findByName.mockResolvedValue({
          id: "payee-1",
          name: "Biedronka",
          defaultCategoryId: "cat-1",
          defaultCategory: { name: "Groceries" },
        } as never);
        rulesApplier.planForRow.mockResolvedValue(
          effects({ createPayee: "Shop (rule)", categoryId: null }),
        );
        const [first] = (await service.build(input())).rows;
        expect(first).toMatchObject({
          payeeName: "Shop (rule)",
          categoryName: null,
        });
        expect(first.payee).toMatchObject({
          name: "Shop (rule)",
          via: "rule",
          payeeId: null,
          aliasPattern: null,
        });
      });

      it("keeps the payee's default category when the rules leave it alone", async () => {
        payees.findByName.mockResolvedValue({
          id: "payee-1",
          name: "Biedronka",
          defaultCategoryId: "cat-1",
          defaultCategory: { name: "Groceries" },
        } as never);
        rulesApplier.planForRow.mockResolvedValue(
          effects({ addTagIds: ["t"] }),
        );
        rulesApplier.labelsFor.mockResolvedValue(
          labels({ tags: { t: "Tag" } }),
        );
        const [first] = (await service.build(input())).rows;
        expect(first).toMatchObject({
          categoryName: "Groceries",
          tagNames: ["Tag"],
        });
      });

      describe("the trace of each rule that matched (spec section 7b)", () => {
        it("lists the matched rules by name with what they changed, applied and skipped, and leaves the unmatched out", async () => {
          rulesApplier.planForRow.mockResolvedValueOnce(
            effects({ categoryId: "cat-9", addTagIds: ["tag-1"] }, [
              matchedTrace({
                skipped: [
                  { type: "set_payee_from_text", reason: "payee_not_found" },
                ],
              }),
              {
                ruleId: "rule-2",
                matched: false,
                applied: [],
                skipped: [],
                changes: {},
                stopped: false,
              },
              matchedTrace({
                ruleId: "rule-3",
                applied: [{ type: "add_tags" }],
                changes: { tagIds: { before: [], after: ["tag-1"] } },
                stopped: true,
              }),
            ]),
          );
          rulesApplier.labelsFor.mockResolvedValueOnce(
            labels({
              categories: { "cat-9": "Food" },
              tags: { "tag-1": "Weekly" },
              rules: { "rule-1": "Food rule", "rule-3": "Weekly rule" },
            }),
          );

          const view = await service.build(input());

          expect(view.rows[0].rules).toEqual([
            {
              ruleId: "rule-1",
              ruleName: "Food rule",
              changes: { categoryId: { before: null, after: "cat-9" } },
              applied: [{ type: "set_category" }],
              skipped: [
                { type: "set_payee_from_text", reason: "payee_not_found" },
              ],
              stopped: false,
            },
            {
              ruleId: "rule-3",
              ruleName: "Weekly rule",
              changes: { tagIds: { before: [], after: ["tag-1"] } },
              applied: [{ type: "add_tags" }],
              skipped: [],
              stopped: true,
            },
          ]);
          expect(view.rows[1].rules).toEqual([]);
          // Names for the ids the changes mention travel with the preview.
          expect(view.labels).toEqual({
            categories: { "cat-9": "Food" },
            payees: {},
            tags: { "tag-1": "Weekly" },
          });
        });

        it("asks for names only for a row where a rule matched, and merges them across rows", async () => {
          rulesApplier.planForRow
            .mockResolvedValueOnce(effects({ categoryId: "cat-9" }))
            .mockResolvedValueOnce(
              effects({}, [
                matchedTrace({
                  ruleId: "rule-2",
                  changes: { payeeId: { before: null, after: "payee-7" } },
                }),
              ]),
            );
          rulesApplier.labelsFor
            .mockResolvedValueOnce(
              labels({
                categories: { "cat-9": "Food" },
                rules: { "rule-1": "A" },
              }),
            )
            .mockResolvedValueOnce(
              labels({
                payees: { "payee-7": "Shop" },
                rules: { "rule-2": "B" },
              }),
            );
          const view = await service.build(input());
          expect(rulesApplier.labelsFor).toHaveBeenCalledTimes(2);
          expect(view.labels).toEqual({
            categories: { "cat-9": "Food" },
            payees: { "payee-7": "Shop" },
            tags: {},
          });
        });

        it("skips the name lookup when no rule matched", async () => {
          rulesApplier.planForRow.mockResolvedValue(
            effects({}, [
              {
                ruleId: "rule-1",
                matched: false,
                applied: [],
                skipped: [],
                changes: {},
                stopped: false,
              },
            ]),
          );
          const view = await service.build(input());
          expect(rulesApplier.labelsFor).not.toHaveBeenCalled();
          expect(view.rows[0].rules).toEqual([]);
        });

        it("names a rule it has no name for as null, never by its id", async () => {
          rulesApplier.planForRow.mockResolvedValueOnce(effects());
          const view = await service.build(input());
          expect(view.rows[0].rules[0].ruleName).toBeNull();
        });

        it("returns the changes as plain copies of the trace", async () => {
          const trace = matchedTrace({
            changes: {
              description: { before: "a", after: "b" },
              payeeName: { before: null, after: "Shop" },
              payeeCreated: true,
            },
          });
          rulesApplier.planForRow.mockResolvedValueOnce(effects({}, [trace]));
          const view = await service.build(input());
          expect(view.rows[0].rules[0].changes).toEqual({
            description: { before: "a", after: "b" },
            payeeName: { before: null, after: "Shop" },
            payeeCreated: true,
          });
          expect(view.rows[0].rules[0].changes).not.toBe(trace.changes);
        });
      });
    });

    it("plans no rules for a user who has none", async () => {
      await service.build(input());
      expect(rulesApplier.loadRulesFor).toHaveBeenCalledWith(
        manager,
        USER_ID,
        "import",
      );
      expect(rulesApplier.planForRow).not.toHaveBeenCalled();
      expect(rulesApplier.labelsFor).not.toHaveBeenCalled();
    });
  });

  describe("how the payee resolves (spec section 7b)", () => {
    const first = async (over: Partial<BuildBankSyncPreviewInput> = {}) =>
      (await service.build(input(over))).rows[0];

    it("is `name` for an existing payee of exactly that name, with its id", async () => {
      payees.findByName.mockResolvedValue({
        id: "payee-1",
        name: "Biedronka",
        defaultCategoryId: null,
        defaultCategory: null,
      } as never);
      expect((await first()).payee).toEqual({
        original: "Biedronka",
        name: "Biedronka",
        via: "name",
        aliasPattern: null,
        payeeId: "payee-1",
      });
      expect(payees.getAllAliases).not.toHaveBeenCalled();
    });

    it("is `alias` with the pattern that matched, the canonical name and the payee's id", async () => {
      payees.findPayeeByAlias.mockResolvedValue({
        id: "payee-2",
        name: "Biedronka S.A.",
        defaultCategoryId: null,
        defaultCategory: null,
      } as never);
      payees.getAllAliases.mockResolvedValue([
        { payeeId: "payee-9", alias: "BIED*" },
        { payeeId: "payee-2", alias: "NOPE*" },
        { payeeId: "payee-2", alias: "BIEDRONKA*" },
      ] as never);
      expect((await first()).payee).toEqual({
        original: "Biedronka",
        name: "Biedronka S.A.",
        via: "alias",
        aliasPattern: "BIEDRONKA*",
        payeeId: "payee-2",
      });
    });

    it("reads the aliases once for the whole preview", async () => {
      payees.findPayeeByAlias.mockResolvedValue({
        id: "payee-2",
        name: "Shop",
        defaultCategoryId: null,
        defaultCategory: null,
      } as never);
      payees.getAllAliases.mockResolvedValue([
        { payeeId: "payee-2", alias: "*" },
      ] as never);
      await service.build(input());
      expect(payees.getAllAliases).toHaveBeenCalledTimes(1);
    });

    it("has no pattern, and says nothing it does not know, when none of the payee's aliases matches", async () => {
      payees.findPayeeByAlias.mockResolvedValue({
        id: "payee-2",
        name: "Shop",
        defaultCategoryId: null,
        defaultCategory: null,
      } as never);
      expect((await first()).payee).toMatchObject({
        via: "alias",
        aliasPattern: null,
        payeeId: "payee-2",
      });
    });

    it("is `new` when the sync would create the payee, named after the bank's text and with no id", async () => {
      expect((await first()).payee).toEqual({
        original: "Biedronka",
        name: "Biedronka",
        via: "new",
        aliasPattern: null,
        payeeId: null,
      });
    });

    it("is `none` when the bank gave no counterparty", async () => {
      const row = (
        await service.build(
          input({}, [
            bankTransaction({
              entryReference: "n",
              counterpartyName: null,
              remittance: [],
            }),
          ]),
        )
      ).rows[0];
      expect(row.payee).toEqual({
        original: null,
        name: null,
        via: "none",
        aliasPattern: null,
        payeeId: null,
      });
    });

    it("is `rule` with the rule's payee and id when an import rule sets one, and keeps the bank's own text as the original", async () => {
      rulesApplier.loadRulesFor.mockResolvedValue([
        { id: "rule-1" },
      ] as TransactionRule[]);
      rulesApplier.planForRow.mockResolvedValue({
        changes: { addTagIds: [], removeTagIds: [], payeeId: "payee-9" },
        trace: [
          {
            ruleId: "rule-1",
            matched: true,
            applied: [{ type: "set_payee" }],
            skipped: [],
            changes: { payeeId: { before: null, after: "payee-9" } },
            stopped: false,
          },
        ],
        aiReviewRequests: [],
      });
      rulesApplier.labelsFor.mockResolvedValue({
        ...NO_LABELS,
        payees: { "payee-9": "Biedronka S.A." },
      });
      expect((await first()).payee).toEqual({
        original: "Biedronka",
        name: "Biedronka S.A.",
        via: "rule",
        aliasPattern: null,
        payeeId: "payee-9",
      });
    });

    it("is `rule` with no payee when a rule clears it", async () => {
      rulesApplier.loadRulesFor.mockResolvedValue([
        { id: "rule-1" },
      ] as TransactionRule[]);
      rulesApplier.planForRow.mockResolvedValue({
        changes: { addTagIds: [], removeTagIds: [], payeeId: null },
        trace: [
          {
            ruleId: "rule-1",
            matched: true,
            applied: [{ type: "set_payee" }],
            skipped: [],
            changes: { payeeId: { before: null, after: null } },
            stopped: false,
          },
        ],
        aiReviewRequests: [],
      });
      const row = await first();
      expect(row.payeeName).toBeNull();
      expect(row.payee).toMatchObject({
        name: null,
        via: "rule",
        payeeId: null,
      });
    });
  });

  describe("the operation-type tag (spec section 7b)", () => {
    const card = () =>
      bankTransaction({
        entryReference: "c1",
        operation: { ...NO_BANK_OPERATION, remittanceCode: "CARD-PAYMENT" },
      });

    it("shows the tag the sync would add, in the user's language, among the tags", async () => {
      const [row] = (await service.build(input({}, [card()]))).rows;
      expect(row.operationTag).toBe("pl:Card payment");
      expect(row.tagNames).toEqual(["pl:Card payment"]);
      expect(preferenceRepo.findOne).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
    });

    it("names the tag by the profile it is given: another bank's CARD-PAYMENT is its own raw tag", async () => {
      const profile = resolveProfile("enable_banking", "PL", "Some Other Bank");
      const [row] = (await service.build(input({ profile }, [card()]))).rows;
      expect(row.operationTag).toBe("CARD-PAYMENT");
      expect(row.tagNames).toEqual(["CARD-PAYMENT"]);
    });

    it("names an unknown code after itself", async () => {
      const [row] = (
        await service.build(
          input({}, [
            bankTransaction({
              entryReference: "u1",
              operation: { ...NO_BANK_OPERATION, code: "DIRECT-DEBIT" },
            }),
          ]),
        )
      ).rows;
      expect(row.operationTag).toBe("DIRECT-DEBIT");
    });

    it("reads a bare TRANSFER by the row's direction", async () => {
      const transfer = (
        entryReference: string,
        direction: "credit" | "debit",
      ) =>
        bankTransaction({
          entryReference,
          direction,
          operation: { ...NO_BANK_OPERATION, remittanceCode: "TRANSFER" },
        });
      const rows = (
        await service.build(
          input({}, [transfer("t1", "credit"), transfer("t2", "debit")]),
        )
      ).rows;
      expect(rows.map((row) => row.operationTag)).toEqual([
        "pl:Incoming transfer",
        "pl:Outgoing transfer",
      ]);
    });

    it("shows the description the writer will write, without the line that is only the operation code", async () => {
      const wire = bankTransaction({
        entryReference: "c2",
        counterpartyName: null,
        remittance: ["SOMECITYSHOP NAME  10PL", "CARD-PAYMENT"],
        operation: { ...NO_BANK_OPERATION, remittanceCode: "CARD-PAYMENT" },
      });
      const built = input({}, [wire]);
      const [row] = (await service.build(built)).rows;
      expect(row.description).toBe("SOMECITYSHOP NAME  10PL");
      expect(row.description).toBe(built.explained.plan.planned[0].description);
    });

    it("shows no tag, and reads no tag or language, when the connection does not tag", async () => {
      const [row] = (
        await service.build(input({ tagOperationType: false }, [card()]))
      ).rows;
      expect(row.operationTag).toBeNull();
      expect(row.tagNames).toEqual([]);
      expect(preferenceRepo.findOne).not.toHaveBeenCalled();
      expect(
        manager.query.mock.calls.some((call) =>
          String(call[0]).includes("FROM tags"),
        ),
      ).toBe(false);
    });

    it("shows no tag for a row whose bank named no operation", async () => {
      const [row] = (await service.build(input())).rows;
      expect(row.operationTag).toBeNull();
    });

    it("never creates the tag: a preview writes nothing", async () => {
      await service.build(input({}, [card()]));
      for (const call of manager.query.mock.calls) {
        expect(String(call[0])).not.toMatch(/INSERT|UPDATE|DELETE/);
      }
    });

    it("gives the rules a row that already carries the tag when it exists, as the write does", async () => {
      ledgerHolding([], [], { "pl:card payment": "tag-77" });
      rulesApplier.loadRulesFor.mockResolvedValue([
        { id: "rule-1" },
      ] as TransactionRule[]);
      await service.build(input({}, [card()]));
      expect(rulesApplier.planForRow.mock.calls[0][2]).toMatchObject({
        tagIds: ["tag-77"],
      });
    });

    it("gives the rules an empty tag set when the tag does not exist yet: it has no id to name", async () => {
      rulesApplier.loadRulesFor.mockResolvedValue([
        { id: "rule-1" },
      ] as TransactionRule[]);
      await service.build(input({}, [card()]));
      expect(rulesApplier.planForRow.mock.calls[0][2]).toMatchObject({
        tagIds: [],
      });
    });

    it("drops the tag a rule removes, and does not list a tag twice", async () => {
      ledgerHolding([], [], { "pl:card payment": "tag-77" });
      rulesApplier.loadRulesFor.mockResolvedValue([
        { id: "rule-1" },
      ] as TransactionRule[]);
      const removing: RuleEffects = {
        changes: { addTagIds: [], removeTagIds: ["tag-77"] },
        trace: [
          {
            ruleId: "rule-1",
            matched: true,
            applied: [{ type: "remove_tags" }],
            skipped: [],
            changes: { tagIds: { before: ["tag-77"], after: [] } },
            stopped: false,
          },
        ],
        aiReviewRequests: [],
      };
      rulesApplier.planForRow.mockResolvedValueOnce(removing);
      rulesApplier.labelsFor.mockResolvedValue({
        ...NO_LABELS,
        tags: { "tag-77": "pl:Card payment" },
      });
      const [dropped] = (await service.build(input({}, [card()]))).rows;
      expect(dropped.tagNames).toEqual([]);

      rulesApplier.planForRow.mockResolvedValueOnce({
        changes: { addTagIds: ["tag-77"], removeTagIds: [] },
        trace: removing.trace,
        aiReviewRequests: [],
      });
      const [once] = (await service.build(input({}, [card()]))).rows;
      expect(once.tagNames).toEqual(["pl:Card payment"]);
    });
  });

  describe("exceptions and keys (spec section 7b)", () => {
    it("lists a ledger row that is an exception as `excluded`, apart from `duplicate`", async () => {
      ledgerHolding(["ref:r1"], ["ref:r2"]);
      const view = await service.build(input());
      expect(view.rows.map((r) => r.outcome)).toEqual([
        "duplicate",
        "excluded",
        "refused",
        "pending",
        "before_cutoff",
      ]);
      expect(view.rows[1]).toMatchObject({
        externalKey: "ref:r2",
        payeeText: "Employer",
        payee: null,
        rules: [],
      });
      expect(view.summary).toMatchObject({ new: 0, duplicate: 1, excluded: 1 });
    });

    it("does not count an exception in the balance after or in the fingerprint: it is not new", async () => {
      ledgerHolding([], ["ref:r1"]);
      const view = await service.build(input());
      const planned = input().explained.plan.planned;
      expect(view.balanceAfter).toBe("2200.1234");
      expect(view.planFingerprint).toBe(planFingerprint([planned[1]]));
    });

    it("carries the key of every planned row, and none for a row it did not plan", async () => {
      const view = await service.build(input());
      expect(view.rows.map((r) => r.externalKey)).toEqual([
        "ref:r1",
        "ref:r2",
        null,
        null,
        null,
      ]);
    });

    it("asks the ledger once, for every planned key, in the caller's own account", async () => {
      await service.build(input());
      const ledgerQueries = manager.query.mock.calls.filter((call) =>
        String(call[0]).includes("SELECT external_key"),
      );
      expect(ledgerQueries).toHaveLength(1);
      expect(String(ledgerQueries[0][0])).toContain("excluded_at IS NOT NULL");
      expect(ledgerQueries[0][1]).toEqual([
        ACCOUNT_ID,
        USER_ID,
        ["ref:r1", "ref:r2"],
      ]);
    });
  });

  describe("a plan that no longer describes the link", () => {
    it("is 409 when the bank account was re-linked during the fetch", async () => {
      linkRepo.findOne.mockResolvedValue(
        bankAccountRow({ accountId: "a0a0a0a0-0000-4000-8000-000000000002" }),
      );
      await expect(service.build(input())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("is 409 when the link or the account is gone", async () => {
      linkRepo.findOne.mockResolvedValue(null);
      await expect(service.build(input())).rejects.toBeInstanceOf(
        ConflictException,
      );
      linkRepo.findOne.mockResolvedValue(bankAccountRow());
      accountRepo.findOne.mockResolvedValue(null);
      await expect(service.build(input())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("is 409 when the cut-off changed during the fetch", async () => {
      await expect(
        service.build(input({ plannedSyncFromDate: "2026-01-01" })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("is 409 when the account's currency changed during the fetch", async () => {
      accountRepo.findOne.mockResolvedValue(account({ currencyCode: "EUR" }));
      await expect(service.build(input())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("compares currencies case-insensitively", async () => {
      accountRepo.findOne.mockResolvedValue(account({ currencyCode: "pln" }));
      await expect(
        service.build(input({ plannedCurrencyCode: " PLN " })),
      ).resolves.toBeDefined();
    });
  });
});
