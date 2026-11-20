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
  account,
  candidates,
  dto,
  transferPreview,
} from "./__fixtures__/quick-add-interpret";

const loaders = jest.mocked(candidatesModule);

describe("QuickAddInterpretService: pins, transfers and the payee", () => {
  let service: QuickAddInterpretService;
  let transactionsService: QuickAddServiceHarness["transactionsService"];
  let transferService: QuickAddServiceHarness["transferService"];
  let usage: QuickAddUsageTable;

  beforeEach(() => {
    useSuiteClock();
    jest.clearAllMocks();
    ({ service, transactionsService, transferService, usage } =
      buildQuickAddService(loaders));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("pins", () => {
    it("win over the text and are never re-read from it", async () => {
      loaders.loadOwnedPayee.mockResolvedValue({
        id: "p-old",
        name: "Old Corner Store",
        defaultCategoryId: null,
        aliases: [],
      });
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws tim", {
          pins: {
            kind: "deposit",
            amount: 12.5,
            date: "2026-11-02",
            accountId: CHQ,
            payeeId: "p-old",
            categoryId: "c-salary",
          },
        }),
      );
      expect(result.kind).toMatchObject({ value: "deposit", source: "pinned" });
      expect(result.amount).toMatchObject({ value: 12.5, source: "pinned" });
      expect(result.date).toMatchObject({
        value: "2026-11-02",
        source: "pinned",
      });
      expect(result.account).toMatchObject({
        value: { id: CHQ },
        source: "pinned",
      });
      expect(result.payee).toMatchObject({
        value: { id: "p-old", name: "Old Corner Store" },
        source: "pinned",
      });
      expect(result.category).toMatchObject({
        value: { id: "c-salary" },
        source: "pinned",
      });
      // The pinned payee leaves the unread word for the memo, not a partial match.
      expect(result.memo).toBe("tim");
      expect(loaders.loadPayeeHistory).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        "p-old",
      );
    });

    it("read a blank pin as absent", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws", {
          pins: { amount: null, accountId: "", payeeName: "", kind: null },
        }),
      );
      expect(result.amount).toMatchObject({ value: 84.37, source: "typed" });
      expect(result.payee.source).toBe("typed");
    });

    it("take a new payee's name", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 weekly shop", { pins: { payeeName: "Farmers Market" } }),
      );
      expect(result.payee).toMatchObject({
        value: { id: null, name: "Farmers Market" },
        source: "pinned",
      });
      expect(result.memo).toBe("weekly shop");
    });

    it.each([
      ["accountId", { accountId: "acc-not-mine" }],
      ["toAccountId", { toAccountId: "acc-not-mine" }],
      ["payeeId", { payeeId: "p-not-mine" }],
      ["categoryId", { categoryId: "c-not-mine" }],
    ])("refuse a %s the caller does not own with 404", async (_name, pins) => {
      await expect(
        service.interpret(USER, dto("84.37 loblaws", { pins })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(transactionsService.previewCreate).not.toHaveBeenCalled();
    });
  });

  describe("transfers", () => {
    it("reads two accounts as a transfer and previews it", async () => {
      const effects = { trace: [] } as unknown as RuleEffectsPreview;
      transferService.previewCreateTransfer.mockResolvedValue({
        ...transferPreview(),
        ruleEffects: effects,
      });
      const result = await service.interpret(
        USER,
        dto("500 chequing to savings"),
      );
      expect(result.kind).toMatchObject({
        value: "transfer",
        source: "inferred",
      });
      expect(result.account).toMatchObject({
        value: { id: CHQ },
        source: "typed",
      });
      expect(result.toAccount).toMatchObject({
        value: { id: SAV },
        source: "typed",
      });
      expect(result.blockers).toEqual([]);
      expect(result.balance).toMatchObject({ accountId: CHQ, after: 500 });
      expect(result.ruleEffects).toBe(effects);
      expect(transferService.previewCreateTransfer).toHaveBeenCalledWith(USER, {
        fromAccountId: CHQ,
        toAccountId: SAV,
        amount: 500,
        transactionDate: TODAY,
        payeeName: undefined,
        description: undefined,
      });
    });

    it("takes the other side of a one-account transfer from the defaults", async () => {
      const result = await service.interpret(
        USER,
        dto("500 to savings", { contextAccountId: CHQ }),
      );
      expect(result.account).toMatchObject({
        value: { id: CHQ },
        source: "default",
      });
      expect(result.toAccount).toMatchObject({
        value: { id: SAV },
        source: "typed",
      });
    });

    it("never defaults the other side onto the named account", async () => {
      loaders.loadMostRecentAccountId.mockResolvedValue(CHQ);
      const result = await service.interpret(
        USER,
        dto("500 to savings", { contextAccountId: SAV }),
      );
      expect(result.account.value?.id).toBe(CHQ);
      expect(result.blockers).toEqual([]);
    });

    it("fills the to side from the defaults for 500 from savings", async () => {
      const result = await service.interpret(
        USER,
        dto("500 from savings", { contextAccountId: CHQ }),
      );
      expect(result.account).toMatchObject({
        value: { id: SAV },
        source: "typed",
      });
      expect(result.toAccount).toMatchObject({
        value: { id: CHQ },
        source: "default",
      });
    });

    it("refuses a transfer between currencies and one to the same account", async () => {
      const cross = await service.interpret(
        USER,
        dto("500 chequing to wallet"),
      );
      expect(cross.blockers).toEqual(["crossCurrencyTransfer"]);
      const same = await service.interpret(
        USER,
        dto("500 chequing", {
          pins: { kind: "transfer", toAccountId: CHQ },
        }),
      );
      expect(same.blockers).toEqual(["sameAccount"]);
    });

    it("is missing its to account when none is named", async () => {
      const result = await service.interpret(
        USER,
        dto("500", { pins: { kind: "transfer" } }),
      );
      expect(result.toAccount).toMatchObject({ value: null, source: "none" });
      expect(result.blockers).toEqual(["missingToAccount"]);
    });
  });

  describe("the payee", () => {
    it("is guessed from a partial word, the most used first", async () => {
      usage.payee_id = new Map([
        ["p-tim", 7],
        ["p-timbuktu", 2],
      ]);
      const result = await service.interpret(USER, dto("4 tim"));
      expect(result.payee).toMatchObject({
        value: { id: "p-tim", name: "Tim Hortons" },
        source: "inferred",
        ambiguous: false,
        alternatives: [{ id: "p-timbuktu", name: "Timbuktu" }],
      });
    });

    it("is ambiguous on a tie in use", async () => {
      const result = await service.interpret(USER, dto("4 tim"));
      expect(result.payee.ambiguous).toBe(true);
    });

    it("is the leftover words as a new payee when none matched", async () => {
      const result = await service.interpret(USER, dto("12 corner store"));
      expect(result.payee).toMatchObject({
        value: { id: null, name: "corner store" },
        source: "typed",
      });
      expect(result.memo).toBeNull();
      expect(loaders.loadPayeeHistory).not.toHaveBeenCalled();
    });

    it("cuts a new payee's name at a word to what a save accepts, the rest the memo", async () => {
      const words = Array.from({ length: 30 }, (_v, i) => `word${i}`);
      const result = await service.interpret(
        USER,
        dto(`12 ${words.join(" ")}`),
      );
      const name = result.payee.value?.name ?? "";
      expect(name.length).toBeLessThanOrEqual(100);
      expect(name.length).toBeGreaterThan(90);
      expect(name.endsWith(" ")).toBe(false);
      expect(`${name} ${result.memo}`).toBe(words.join(" "));
    });

    it("leaves the leftover words as the memo when a payee matched", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws weekly shop"),
      );
      expect(result.memo).toBe("weekly shop");
    });
  });

  describe("a name two kinds of thing share", () => {
    const AMEX_ACCOUNT = "acc-amex";
    const AMEX_PAYEE = "p-amex";
    const COSTCO_CATEGORY = "c-costco";

    beforeEach(() => {
      const base = candidates();
      loaders.loadQuickAddCandidates.mockResolvedValue(
        candidates({
          accounts: [...base.accounts, account(AMEX_ACCOUNT, "Amex", -250)],
          payees: [
            ...base.payees,
            {
              id: AMEX_PAYEE,
              name: "Amex",
              defaultCategoryId: null,
              aliases: [],
            },
            {
              id: "p-costco",
              name: "Costco",
              defaultCategoryId: null,
              aliases: [],
            },
          ],
          categories: [
            ...base.categories,
            {
              id: COSTCO_CATEGORY,
              name: "Costco",
              path: "Costco",
              isIncome: false,
            },
          ],
        }),
      );
    });

    it("is the payee without a connector, the account ranked among the alternatives", async () => {
      usage.account_id = new Map([[AMEX_ACCOUNT, 4]]);
      const result = await service.interpret(USER, dto("50 amex"));
      expect(result.payee).toMatchObject({
        value: { id: AMEX_PAYEE, name: "Amex" },
        source: "typed",
      });
      expect(result.account).toMatchObject({
        value: { id: SAV },
        source: "default",
      });
      expect(result.account.alternatives.map((a) => a.id)).toEqual([
        AMEX_ACCOUNT,
      ]);
      expect(loaders.loadUsage).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        "account_id",
        [AMEX_ACCOUNT],
      );
    });

    it("is the account after a connector, the payee offered instead", async () => {
      const result = await service.interpret(USER, dto("50 loblaws on amex"));
      expect(result.account).toMatchObject({
        value: { id: AMEX_ACCOUNT, name: "Amex" },
        source: "typed",
      });
      expect(result.payee).toMatchObject({
        value: { id: LOBLAWS.id },
        source: "typed",
        alternatives: [{ id: AMEX_PAYEE, name: "Amex" }],
      });
      expect(result.balance).toMatchObject({
        accountId: AMEX_ACCOUNT,
        current: -250,
        after: -300,
      });
      expect(loaders.loadUsage).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        "payee_id",
        [LOBLAWS.id, AMEX_PAYEE],
      );
    });

    it("offers the category a payee's name also names", async () => {
      const result = await service.interpret(USER, dto("120 costco"));
      expect(result.payee.value?.id).toBe("p-costco");
      expect(result.category).toMatchObject({ value: null, source: "none" });
      expect(result.category.alternatives).toEqual([
        { id: COSTCO_CATEGORY, name: "Costco" },
      ]);
      expect(loaders.loadUsage).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        "category_id",
        [COSTCO_CATEGORY],
      );
    });
  });
});
