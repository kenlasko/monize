import { NotFoundException } from "@nestjs/common";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);
jest.mock("./quick-add-candidates", () => ({
  ...jest.requireActual("./quick-add-candidates"),
  loadQuickAddCandidates: jest.fn(),
  loadOwnedPayee: jest.fn(),
  loadUsage: jest.fn(),
  loadPayeeHistory: jest.fn(),
  loadMostRecentAccountId: jest.fn(),
}));

import type { RuleEffectsPreview } from "../../transaction-rules/transaction-rules-applier.service";
import * as candidatesModule from "./quick-add-candidates";
import { QuickAddInterpretService } from "./quick-add-interpret.service";
import {
  QuickAddServiceHarness,
  QuickAddUsageTable,
  buildQuickAddService,
  useSuiteClock,
  CHQ,
  LOBLAWS,
  SAV,
  TODAY,
  USER,
  VISA_A,
  VISA_B,
  account,
  candidates,
  dto,
  preview,
} from "./__fixtures__/quick-add-interpret";

const loaders = jest.mocked(candidatesModule);

describe("QuickAddInterpretService", () => {
  let service: QuickAddInterpretService;
  let transactionsService: QuickAddServiceHarness["transactionsService"];
  let usage: QuickAddUsageTable;

  beforeEach(() => {
    useSuiteClock();
    jest.clearAllMocks();
    ({ service, transactionsService, usage } = buildQuickAddService(loaders));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("the plan's basic reading", () => {
    it("reads 84.37 loblaws groceries as a payment ready to save", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws groceries"),
      );

      expect(result.kind).toEqual({
        value: "payment",
        source: "default",
        ambiguous: false,
        alternatives: ["deposit", "transfer"],
      });
      expect(result.amount).toMatchObject({ value: 84.37, source: "typed" });
      expect(result.payee).toMatchObject({
        value: { id: LOBLAWS.id, name: "Loblaws" },
        source: "typed",
      });
      expect(result.category).toMatchObject({
        value: { id: "c-groc", name: "Food: Groceries" },
        source: "typed",
      });
      // No context and no history: the last-created transaction's account.
      expect(result.account).toMatchObject({
        value: { id: SAV, name: "Savings", currencyCode: "CAD" },
        source: "default",
      });
      expect(result.date).toMatchObject({ value: TODAY, source: "default" });
      expect(result.toAccount).toEqual({
        value: null,
        source: "none",
        ambiguous: false,
        alternatives: [],
      });
      expect(result.memo).toBeNull();
      expect(result.blockers).toEqual([]);
      expect(result.balance).toEqual({
        accountId: SAV,
        currencyCode: "CAD",
        current: 5000,
        after: 4915.63,
        movesOn: null,
      });
      expect(loaders.loadPayeeHistory).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        LOBLAWS.id,
      );
    });
  });

  describe("the account", () => {
    it("is the register's account when it is eligible", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws", { contextAccountId: CHQ }),
      );
      expect(result.account).toMatchObject({
        value: { id: CHQ },
        source: "default",
      });
      expect(result.account.alternatives.map((a) => a.id)).toEqual([SAV]);
    });

    it("ignores a context account the reader may not enter into", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws", { contextAccountId: "acc-joint" }),
      );
      expect(result.account.value?.id).toBe(SAV);
    });

    it("is the payee's last account, guessed, without a context", async () => {
      loaders.loadPayeeHistory.mockResolvedValue({
        recent: [
          { accountId: "acc-closed", amount: -10 },
          { accountId: CHQ, amount: -20 },
        ],
        categoryIds: [],
      });
      const result = await service.interpret(USER, dto("84.37 loblaws"));
      expect(result.account).toMatchObject({
        value: { id: CHQ },
        source: "inferred",
      });
    });

    it("is missing, blocking the save, when nothing gives one", async () => {
      loaders.loadMostRecentAccountId.mockResolvedValue(null);
      const result = await service.interpret(USER, dto("84.37 loblaws"));
      expect(result.account).toMatchObject({ value: null, source: "none" });
      expect(result.blockers).toEqual(["missingAccount"]);
      expect(result.balance).toBeNull();
      expect(transactionsService.previewCreate).not.toHaveBeenCalled();
    });

    it("is ambiguous when two accounts share the typed name; the most used wins", async () => {
      loaders.loadQuickAddCandidates.mockResolvedValue(
        candidates({
          accounts: [account(VISA_A, "Visa"), account(VISA_B, "Visa")],
        }),
      );
      usage.account_id = new Map([
        [VISA_A, 3],
        [VISA_B, 9],
      ]);
      const result = await service.interpret(USER, dto("84.37 loblaws visa"));
      expect(result.account).toMatchObject({
        value: { id: VISA_B },
        source: "typed",
        ambiguous: true,
      });
      expect(result.account.alternatives.map((a) => a.id)).toEqual([VISA_A]);
      expect(result.blockers).toEqual(["ambiguousAccount"]);
    });
  });

  describe("the category", () => {
    it("is the payee's most frequent recent category, guessed", async () => {
      loaders.loadPayeeHistory.mockResolvedValue({
        recent: [],
        categoryIds: ["c-food", "c-groc", null, "c-groc"],
      });
      const result = await service.interpret(USER, dto("84.37 loblaws"));
      expect(result.category).toMatchObject({
        value: { id: "c-groc", name: "Food: Groceries" },
        source: "inferred",
      });
      expect(result.category.alternatives.map((c) => c.id)).toEqual(["c-food"]);
    });

    it("breaks a tie on frequency with the most recent", async () => {
      loaders.loadPayeeHistory.mockResolvedValue({
        recent: [],
        categoryIds: ["c-groc", "c-food"],
      });
      const result = await service.interpret(USER, dto("84.37 loblaws"));
      expect(result.category.value?.id).toBe("c-groc");
    });

    it("is the payee's default category when its history has none", async () => {
      const result = await service.interpret(USER, dto("84.37 loblaws"));
      expect(result.category).toMatchObject({
        value: { id: "c-food", name: "Food" },
        source: "inferred",
      });
    });

    it("is not filled for a transfer", async () => {
      const result = await service.interpret(
        USER,
        dto("500 chequing to savings"),
      );
      expect(result.category).toMatchObject({ value: null, source: "none" });
    });
  });

  describe("the kind", () => {
    it("is a deposit, guessed, for an income category", async () => {
      const result = await service.interpret(USER, dto("2500 salary"));
      expect(result.kind).toMatchObject({
        value: "deposit",
        source: "inferred",
      });
      expect(result.balance?.after).toBe(7500);
    });

    it("is a deposit, guessed, when most of the payee's last rows are", async () => {
      loaders.loadPayeeHistory.mockResolvedValue({
        recent: [
          { accountId: CHQ, amount: 2000 },
          { accountId: CHQ, amount: 2000 },
          { accountId: CHQ, amount: -5 },
        ],
        categoryIds: [],
      });
      const result = await service.interpret(USER, dto("2000 acme payroll"));
      expect(result.kind).toMatchObject({
        value: "deposit",
        source: "inferred",
      });
      expect(result.balance).toMatchObject({ accountId: CHQ, after: 3000 });
    });

    it("is typed from the sign", async () => {
      const result = await service.interpret(USER, dto("+20 loblaws"));
      expect(result.kind).toMatchObject({ value: "deposit", source: "typed" });
    });
  });

  describe("the balance line", () => {
    it("moves the balance now for a date up to today", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws yesterday", { contextAccountId: CHQ }),
      );
      expect(result.balance).toEqual({
        accountId: CHQ,
        currencyCode: "CAD",
        current: 1000,
        after: 915.63,
        movesOn: null,
      });
    });

    it("says when a future-dated entry moves it instead", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws tomorrow", { contextAccountId: CHQ }),
      );
      expect(result.balance).toEqual({
        accountId: CHQ,
        currencyCode: "CAD",
        current: 1000,
        after: null,
        movesOn: "2026-11-21",
      });
    });
  });

  describe("blockers", () => {
    it.each([
      ["loblaws", ["missingAmount"]],
      ["0 loblaws", ["zeroAmount"]],
      ["12.34567 loblaws", ["amountPrecision"]],
      ["20 € cafe", ["foreignCurrency"]],
    ])("%s is refused with %j", async (text, blockers) => {
      const result = await service.interpret(USER, dto(text));
      expect(result.blockers).toEqual(blockers);
      expect(result.balance).toBeNull();
      expect(result.ruleEffects).toBeUndefined();
    });

    it("keeps four places for a fiat amount, the money precision", async () => {
      const result = await service.interpret(USER, dto("12.3456 loblaws"));
      expect(result.amount.value).toBe(12.3456);
      expect(result.blockers).toEqual([]);
    });

    it("drops the account's own currency", async () => {
      const result = await service.interpret(USER, dto("$20 loblaws"));
      expect(result.blockers).toEqual([]);
    });

    it("keeps a foreign entry's new payee for the full form", async () => {
      const result = await service.interpret(USER, dto("20 € cafe"));
      expect(result.payee).toMatchObject({
        value: { id: null, name: "cafe" },
        source: "typed",
      });
    });
  });

  describe("rule effects", () => {
    it("are the commit planner's, from previewCreate", async () => {
      const effects = { trace: [] } as unknown as RuleEffectsPreview;
      transactionsService.previewCreate.mockResolvedValue(preview(effects));
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws groceries weekly", { contextAccountId: CHQ }),
      );
      expect(result.ruleEffects).toBe(effects);
      expect(transactionsService.previewCreate).toHaveBeenCalledWith(USER, {
        accountId: CHQ,
        amount: -84.37,
        transactionDate: TODAY,
        payeeName: "Loblaws",
        categoryId: "c-groc",
        description: "weekly",
      });
    });

    it("are omitted when the preview throws, and the reading stands", async () => {
      transactionsService.previewCreate.mockRejectedValue(
        new NotFoundException("Category not found"),
      );
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws groceries"),
      );
      expect(result).not.toHaveProperty("ruleEffects");
      expect(result.blockers).toEqual([]);
      expect(result.payee.value?.id).toBe(LOBLAWS.id);
    });

    it("are omitted when no rule matched", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws groceries"),
      );
      expect(result).not.toHaveProperty("ruleEffects");
    });
  });

  it("reads every query on the one scoped transaction", async () => {
    const harness = buildQuickAddService(loaders);
    await harness.service.interpret(USER, dto("84.37 loblaws"));
    expect(harness.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(loaders.loadQuickAddCandidates).toHaveBeenCalledWith(
      expect.anything(),
      USER,
    );
  });
});
