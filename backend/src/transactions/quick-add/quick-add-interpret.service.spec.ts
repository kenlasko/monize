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
import * as parseModule from "./quick-add-parse.util";
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
  YEN,
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

    it("is the account most of the payee's last rows were on, not merely the latest", async () => {
      loaders.loadPayeeHistory.mockResolvedValue({
        recent: [
          { accountId: CHQ, amount: -10 },
          { accountId: SAV, amount: -20 },
          { accountId: "acc-closed", amount: -5 },
          { accountId: SAV, amount: -30 },
          { accountId: "acc-closed", amount: -5 },
          { accountId: "acc-closed", amount: -5 },
        ],
        categoryIds: [],
      });
      loaders.loadMostRecentAccountId.mockResolvedValue(CHQ);
      const result = await service.interpret(USER, dto("43.55 loblaws"));
      // A closed account is not a candidate, however often it was used.
      expect(result.account).toMatchObject({
        value: { id: SAV },
        source: "inferred",
      });
      expect(result.account.alternatives.map((a) => a.id)).toEqual([CHQ]);
    });

    it("breaks a tie on account frequency with the most recent", async () => {
      loaders.loadPayeeHistory.mockResolvedValue({
        recent: [
          { accountId: CHQ, amount: -10 },
          { accountId: SAV, amount: -20 },
          { accountId: SAV, amount: -30 },
          { accountId: CHQ, amount: -10 },
        ],
        categoryIds: [],
      });
      loaders.loadMostRecentAccountId.mockResolvedValue(SAV);
      const result = await service.interpret(USER, dto("43.55 loblaws"));
      expect(result.account.value?.id).toBe(CHQ);
      expect(result.account.alternatives.map((a) => a.id)).toEqual([SAV]);
    });

    it("keeps the register's account ahead of the payee's usual one", async () => {
      loaders.loadPayeeHistory.mockResolvedValue({
        recent: [
          { accountId: SAV, amount: -20 },
          { accountId: SAV, amount: -30 },
        ],
        categoryIds: [],
      });
      const result = await service.interpret(
        USER,
        dto("43.55 loblaws", { contextAccountId: CHQ }),
      );
      expect(result.account).toMatchObject({
        value: { id: CHQ },
        source: "default",
      });
      expect(result.account.alternatives.map((a) => a.id)).toEqual([SAV]);
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

    it("refuses more places than the account currency's decimal_places", async () => {
      // CAD carries 2: the entry places the full form's CurrencyInput rounds
      // to, not the 4 a fiat amount is stored at.
      const cad = await service.interpret(USER, dto("12.345 loblaws"));
      expect(cad.blockers).toEqual(["amountPrecision"]);
      expect(cad.amount.value).toBe(12.345);
      expect(cad.balance).toBeNull();
      const fourPlaces = await service.interpret(USER, dto("12.3456 loblaws"));
      expect(fourPlaces.blockers).toEqual(["amountPrecision"]);
      const twoPlaces = await service.interpret(USER, dto("12.34 loblaws"));
      expect(twoPlaces.blockers).toEqual([]);
      expect(twoPlaces.amount.value).toBe(12.34);
    });

    it("holds a yen account to whole yen and a coin to its own places", async () => {
      const yen = await service.interpret(
        USER,
        dto("12.5 loblaws", { contextAccountId: YEN }),
      );
      expect(yen.blockers).toEqual(["amountPrecision"]);
      loaders.loadQuickAddCandidates.mockResolvedValue(
        candidates({
          accounts: [account("acc-btc", "Cold Wallet", 1, "BTC")],
          currencies: [{ code: "BTC", symbol: "₿" }],
          currencyPlaces: new Map([["BTC", 8]]),
        }),
      );
      const eight = await service.interpret(
        USER,
        dto("0.00012345 loblaws", { contextAccountId: "acc-btc" }),
      );
      expect(eight.blockers).toEqual([]);
      expect(eight.amount.value).toBe(0.00012345);
      const nine = await service.interpret(
        USER,
        dto("0.000123456 loblaws", { contextAccountId: "acc-btc" }),
      );
      expect(nine.blockers).toEqual(["amountPrecision"]);
    });

    it("refuses an amount above the create DTO's maximum magnitude", async () => {
      const result = await service.interpret(
        USER,
        dto("1000000000000 loblaws"),
      );
      expect(result.blockers).toEqual(["amountTooLarge"]);
      expect(result.amount.value).toBe(1000000000000);
      expect(result.balance).toBeNull();
      expect(transactionsService.previewCreate).not.toHaveBeenCalled();
      const atMax = await service.interpret(USER, dto("999999999999 loblaws"));
      expect(atMax.blockers).toEqual([]);
      const pinned = await service.interpret(
        USER,
        dto("1e13 loblaws", { pins: { amount: 12.5 } }),
      );
      expect(pinned.blockers).toEqual([]);
    });

    it("says what a foreign figure was, with its code when the spelling names one", async () => {
      const euro = await service.interpret(USER, dto("20 € cafe"));
      expect(euro.foreignAmount).toEqual({ currencyCode: "EUR", amount: 20 });
      // Its places are the full form's to check, in the euro, not CAD's.
      const places = await service.interpret(USER, dto("12.345 EUR cafe"));
      expect(places.blockers).toEqual(["foreignCurrency"]);
      expect(places.foreignAmount).toEqual({
        currencyCode: "EUR",
        amount: 12.345,
      });
      // `$` names a dozen dollars, none of them the yen.
      const dollar = await service.interpret(
        USER,
        dto("$20 loblaws", { contextAccountId: YEN }),
      );
      expect(dollar.blockers).toEqual(["foreignCurrency"]);
      expect(dollar.foreignAmount).toEqual({ currencyCode: null, amount: 20 });
    });

    it("keeps a typed currency's figure while no account is known to compare it with", async () => {
      // No context, no payee history, no prior row: no account at all.
      loaders.loadMostRecentAccountId.mockResolvedValue(null);
      const euro = await service.interpret(USER, dto("20 € cafe"));
      expect(euro.account.value).toBeNull();
      expect(euro.amount).toMatchObject({ value: 20, source: "typed" });
      expect(euro.foreignAmount).toEqual({ currencyCode: "EUR", amount: 20 });
      // Nothing to call it foreign to yet: only the account is missing.
      expect(euro.blockers).toEqual(["missingAccount"]);
      expect(euro.balance).toBeNull();
      const places = await service.interpret(USER, dto("12.345 EUR cafe"));
      expect(places.foreignAmount).toEqual({
        currencyCode: "EUR",
        amount: 12.345,
      });
      expect(places.blockers).toEqual(["missingAccount"]);
      const dollar = await service.interpret(USER, dto("$20 cafe"));
      expect(dollar.foreignAmount).toEqual({ currencyCode: null, amount: 20 });
      const plain = await service.interpret(USER, dto("20 cafe"));
      expect(plain.foreignAmount).toBeNull();
      const pinned = await service.interpret(
        USER,
        dto("20 € cafe", { pins: { amount: 30 } }),
      );
      expect(pinned.foreignAmount).toBeNull();
    });

    it("has no foreign figure without the foreignCurrency blocker", async () => {
      for (const text of ["$20 loblaws", "20 loblaws", "20 CAD loblaws"]) {
        const result = await service.interpret(USER, dto(text));
        expect(result.blockers).not.toContain("foreignCurrency");
        expect(result.foreignAmount).toBeNull();
      }
      const pinned = await service.interpret(
        USER,
        dto("20 € cafe", { pins: { amount: 30 } }),
      );
      expect(pinned.blockers).toEqual([]);
      expect(pinned.foreignAmount).toBeNull();
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
        payeeId: LOBLAWS.id,
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

  it("loads in two short scoped reads and reads the text between them", async () => {
    const harness = buildQuickAddService(loaders);
    const open: string[] = [];
    const run = harness.dataSource.transaction.getMockImplementation()!;
    harness.dataSource.transaction.mockImplementation(async (...args) => {
      open.push("open");
      try {
        return await run(...args);
      } finally {
        open.pop();
      }
    });
    const readsInTransaction: boolean[] = [];
    const read = parseModule.readQuickAddText;
    const reader = jest
      .spyOn(parseModule, "readQuickAddText")
      .mockImplementation((input) => {
        readsInTransaction.push(open.length > 0);
        return read(input);
      });
    try {
      await harness.service.interpret(USER, dto("84.37 loblaws"));
    } finally {
      reader.mockRestore();
    }
    expect(harness.dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(readsInTransaction).toEqual([false]);
    expect(loaders.loadQuickAddCandidates).toHaveBeenCalledWith(
      expect.anything(),
      USER,
    );
    expect(loaders.loadPayeeHistory).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      LOBLAWS.id,
    );
  });
});
