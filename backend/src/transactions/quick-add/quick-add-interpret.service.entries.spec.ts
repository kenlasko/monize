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
      // `loblaws` produced the text's payee, which the pin replaces, so it is
      // not the memo; `tim` is a word nothing used, as beside a typed payee.
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

    it("take a new payee's name, in place of the words that named one", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 weekly shop", { pins: { payeeName: "Farmers Market" } }),
      );
      expect(result.payee).toMatchObject({
        value: { id: null, name: "Farmers Market" },
        source: "pinned",
      });
      // `weekly shop` was the text's new payee; the pin replaced it.
      expect(result.memo).toBeNull();
    });

    describe("a pinned payee replaces the words that produced the text's payee", () => {
      it.each([
        // A new payee's name: picking Starbucks for a misspelling.
        ["20 starbuks", null],
        // A partial match: picking a payee over the guess `tim` made.
        ["84.37 tim", null],
        ["84.37 tim coffee", "coffee"],
        // A whole name: what is left beside it stays the memo.
        ["84.37 loblaws weekly", "weekly"],
      ])("%s with a picked payee has the memo %j", async (text, memo) => {
        const result = await service.interpret(
          USER,
          dto(text, { pins: { payeeId: LOBLAWS.id } }),
        );
        expect(result.payee).toMatchObject({
          value: { id: LOBLAWS.id },
          source: "pinned",
        });
        expect(result.memo).toBe(memo);
      });

      it("has no leftover memo once a payee name's cap exceeds the line's own", async () => {
        // A new payee's name is cut to what a transaction create accepts
        // (255), which is now longer than a Quick Add line can ever be (200),
        // so the leftover always fits whole and nothing is left for the memo.
        const words = Array.from({ length: 25 }, (_v, i) => `word${i}`);
        const unpinned = await service.interpret(
          USER,
          dto(`12 ${words.join(" ")}`),
        );
        const pinned = await service.interpret(
          USER,
          dto(`12 ${words.join(" ")}`, { pins: { payeeName: "Market" } }),
        );
        expect(unpinned.memo).toBeNull();
        expect(pinned.memo).toBe(unpinned.memo);
      });

      it("previews the picked payee's id, not the text's name", async () => {
        await service.interpret(
          USER,
          dto("84.37 tim", {
            contextAccountId: CHQ,
            pins: { payeeId: LOBLAWS.id },
          }),
        );
        expect(transactionsService.previewCreate).toHaveBeenCalledWith(
          USER,
          expect.objectContaining({
            payeeId: LOBLAWS.id,
            payeeName: "Loblaws",
            description: undefined,
          }),
        );
      });
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

  describe("cleared fields", () => {
    const CLEARED = {
      value: null,
      source: "pinned",
      ambiguous: false,
      alternatives: [],
    };

    it("answer a cleared payee as none and guess nothing from it", async () => {
      loaders.loadPayeeHistory.mockResolvedValue({
        recent: [
          { accountId: CHQ, amount: 50 },
          { accountId: CHQ, amount: 50 },
        ],
        categoryIds: ["c-groc"],
      });
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws", { pins: { clear: ["payee"] } }),
      );
      expect(result.payee).toEqual(CLEARED);
      expect(loaders.loadPayeeHistory).not.toHaveBeenCalled();
      // No category from the payee's history or its default (c-food), no
      // deposit from its history, no account from it.
      expect(result.category).toMatchObject({ value: null, source: "none" });
      expect(result.kind).toMatchObject({
        value: "payment",
        source: "default",
      });
      expect(result.account.value?.id).toBe(SAV);
      expect(result.memo).toBeNull();
      expect(transactionsService.previewCreate).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ payeeId: null, payeeName: undefined }),
      );
    });

    it("answer a cleared payee as none for a line that named a new one", async () => {
      const result = await service.interpret(
        USER,
        dto("12 corner store", { pins: { clear: ["payee"] } }),
      );
      expect(result.payee).toEqual(CLEARED);
      expect(result.memo).toBeNull();
    });

    // The save sends no category and `create()` adopts the linked payee's
    // default, so a cleared category answers with what the save will write.
    const ADOPTED_FOOD = {
      value: { id: "c-food", name: "Food" },
      source: "default",
      ambiguous: false,
      alternatives: [],
    };

    it("answer a cleared category with the payee's default the save adopts, never from history or the text", async () => {
      loaders.loadPayeeHistory.mockResolvedValue({
        recent: [],
        categoryIds: ["c-groc", "c-groc"],
      });
      const fromHistory = await service.interpret(
        USER,
        dto("84.37 loblaws", { pins: { clear: ["category"] } }),
      );
      expect(fromHistory.category).toEqual(ADOPTED_FOOD);
      expect(fromHistory.payee.value?.id).toBe(LOBLAWS.id);
      const typed = await service.interpret(
        USER,
        dto("84.37 loblaws groceries", { pins: { clear: ["category"] } }),
      );
      expect(typed.category).toEqual(ADOPTED_FOOD);
      // The rule preview runs over the category the chip shows.
      expect(transactionsService.previewCreate).toHaveBeenLastCalledWith(
        USER,
        expect.objectContaining({ payeeId: LOBLAWS.id, categoryId: "c-food" }),
      );
      const pinnedPayee = await service.interpret(
        USER,
        dto("84.37 coffee", {
          pins: { payeeId: LOBLAWS.id, clear: ["category"] },
        }),
      );
      expect(pinnedPayee.category).toEqual(ADOPTED_FOOD);
    });

    it("answer a cleared category as none when the save adopts nothing", async () => {
      // Tim Hortons has no default category; a new payee has none yet.
      for (const text of ["12 tim hortons", "12 corner store"]) {
        transactionsService.previewCreate.mockClear();
        const result = await service.interpret(
          USER,
          dto(text, { pins: { clear: ["category"] } }),
        );
        expect(result.category).toEqual(CLEARED);
        expect(transactionsService.previewCreate).toHaveBeenCalledWith(
          USER,
          expect.objectContaining({ categoryId: undefined }),
        );
      }
    });

    it("never make an income category's deposit of a cleared one", async () => {
      const result = await service.interpret(
        USER,
        dto("2500 salary", { pins: { clear: ["category"] } }),
      );
      expect(result.category).toEqual(CLEARED);
      expect(result.kind).toMatchObject({
        value: "payment",
        source: "default",
      });
    });

    it("clear both fields at once", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws", { pins: { clear: ["payee", "category"] } }),
      );
      expect(result.payee).toEqual(CLEARED);
      expect(result.category).toEqual(CLEARED);
    });

    it("give way to a value pinned for the same field", async () => {
      const result = await service.interpret(
        USER,
        dto("84.37 loblaws", {
          pins: {
            payeeId: LOBLAWS.id,
            categoryId: "c-groc",
            clear: ["payee", "category"],
          },
        }),
      );
      expect(result.payee).toMatchObject({
        value: { id: LOBLAWS.id },
        source: "pinned",
      });
      expect(result.category).toMatchObject({
        value: { id: "c-groc" },
        source: "pinned",
      });
    });

    it("leave a transfer's category not applicable", async () => {
      const result = await service.interpret(
        USER,
        dto("500 chequing to savings", { pins: { clear: ["category"] } }),
      );
      expect(result.category).toMatchObject({ value: null, source: "none" });
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
        payeeId: null,
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

    it("keeps a long typed name whole, within both the line's cap and a payee name's", async () => {
      // 167 characters: within the line's cap (200) and, since a payee
      // name's own cap (255) is now the larger of the two, within that as
      // well -- so nothing is cut to a memo.
      const words = Array.from({ length: 25 }, (_v, i) => `word${i}`);
      const result = await service.interpret(
        USER,
        dto(`12 ${words.join(" ")}`),
      );
      const name = result.payee.value?.name ?? "";
      expect(name).toBe(words.join(" "));
      expect(result.memo).toBeNull();
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
              categoryType: "expense",
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
