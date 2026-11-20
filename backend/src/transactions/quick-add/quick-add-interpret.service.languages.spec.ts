import { I18nContext } from "nestjs-i18n";

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

import * as candidatesModule from "./quick-add-candidates";
import { QUICK_ADD_TEXT_MAX_LENGTH } from "./dto/quick-add-interpret.dto";
import { QuickAddInterpretService } from "./quick-add-interpret.service";
import type { QuickAddCandidatePayee } from "./quick-add.types";
import {
  CHQ,
  QuickAddServiceHarness,
  SAV,
  TODAY,
  USER,
  YEN,
  buildQuickAddService,
  candidates,
  dto,
  useSuiteClock,
} from "./__fixtures__/quick-add-interpret";

const loaders = jest.mocked(candidatesModule);

const LAWSON: QuickAddCandidatePayee = {
  id: "p-lawson",
  name: "ローソン",
  defaultCategoryId: null,
  aliases: [],
};
const SEVEN_ELEVEN: QuickAddCandidatePayee = {
  id: "p-711",
  name: "7-Eleven",
  defaultCategoryId: null,
  aliases: [],
};

const YESTERDAY = "2026-11-19";

/**
 * The reader's language and scripts, through the request locale `tr()` reads
 * (`currentRequestLocale`) and the number and date formats of their
 * preferences, as the plan's "What should be observed" names them.
 */
describe("QuickAddInterpretService: languages, scripts and line length", () => {
  let service: QuickAddInterpretService;
  let transactionsService: QuickAddServiceHarness["transactionsService"];
  let locale: jest.SpyInstance | null = null;

  /** The request's locale, as nestjs-i18n resolves it. */
  const readerSpeaks = (lang: string) => {
    locale = jest
      .spyOn(I18nContext, "current")
      .mockReturnValue({ lang } as unknown as I18nContext);
  };

  beforeEach(() => {
    useSuiteClock();
    jest.clearAllMocks();
    ({ service, transactionsService } = buildQuickAddService(loaders));
    const base = candidates();
    loaders.loadQuickAddCandidates.mockResolvedValue(
      candidates({ payees: [...base.payees, LAWSON, SEVEN_ELEVEN] }),
    );
  });

  afterEach(() => {
    locale?.mockRestore();
    locale = null;
    jest.useRealTimers();
  });

  describe("Han, kana and Hangul text without spaces", () => {
    it("reads ローソンで500円 against a yen account, its 円 dropped", async () => {
      readerSpeaks("ja");
      const result = await service.interpret(
        USER,
        dto("ローソンで500円", { contextAccountId: YEN }),
      );
      expect(result.payee).toMatchObject({
        value: { id: LAWSON.id, name: "ローソン" },
        source: "typed",
      });
      expect(result.amount).toMatchObject({ value: 500, source: "typed" });
      expect(result.account).toMatchObject({
        value: { id: YEN, currencyCode: "JPY" },
        source: "default",
      });
      expect(result.memo).toBeNull();
      expect(result.blockers).toEqual([]);
      expect(result.balance).toEqual({
        accountId: YEN,
        currencyCode: "JPY",
        current: 20000,
        after: 19500,
        movesOn: null,
      });
      expect(transactionsService.previewCreate).toHaveBeenCalledWith(USER, {
        accountId: YEN,
        amount: -500,
        transactionDate: TODAY,
        payeeId: LAWSON.id,
        payeeName: "ローソン",
        categoryId: undefined,
        description: undefined,
      });
    });

    it("refuses the same line against a CAD account as a foreign amount", async () => {
      readerSpeaks("ja");
      const result = await service.interpret(
        USER,
        dto("ローソンで500円", { contextAccountId: CHQ }),
      );
      expect(result.payee.value?.id).toBe(LAWSON.id);
      expect(result.blockers).toEqual(["foreignCurrency"]);
      expect(result.balance).toBeNull();
      expect(transactionsService.previewCreate).not.toHaveBeenCalled();
    });
  });

  describe("the reader's number and date formats", () => {
    it("reads a German 12,50 bäckerei gestern as 12.50 yesterday", async () => {
      readerSpeaks("de");
      loaders.loadQuickAddCandidates.mockResolvedValue(
        candidates({ numberFormat: "de-DE", dateFormat: "DD.MM.YYYY" }),
      );
      const result = await service.interpret(
        USER,
        dto("12,50 bäckerei gestern"),
      );
      expect(result.amount).toMatchObject({ value: 12.5, source: "typed" });
      expect(result.date).toMatchObject({ value: YESTERDAY, source: "typed" });
      expect(result.payee).toMatchObject({
        value: { id: null, name: "bäckerei" },
        source: "typed",
      });
      expect(result.blockers).toEqual([]);
      expect(result.balance).toMatchObject({ accountId: SAV, after: 4987.5 });
    });

    it("reads a regional locale in its base language (pt-BR reads ontem)", async () => {
      readerSpeaks("pt-BR");
      loaders.loadQuickAddCandidates.mockResolvedValue(
        candidates({ numberFormat: "pt-BR", dateFormat: "DD/MM/YYYY" }),
      );
      const result = await service.interpret(USER, dto("12,50 padaria ontem"));
      expect(result.amount.value).toBe(12.5);
      expect(result.date.value).toBe(YESTERDAY);
      expect(result.payee.value).toEqual({ id: null, name: "padaria" });
    });

    it("understands English words in another language", async () => {
      readerSpeaks("de");
      const result = await service.interpret(
        USER,
        dto("500 chequing to savings yesterday"),
      );
      expect(result.kind).toMatchObject({
        value: "transfer",
        source: "inferred",
      });
      expect(result.account.value?.id).toBe(CHQ);
      expect(result.toAccount.value?.id).toBe(SAV);
      expect(result.date.value).toBe(YESTERDAY);
    });
  });

  it("reads a payee holding digits as the payee, not the amount (7-Eleven)", async () => {
    const result = await service.interpret(USER, dto("7-eleven 12.50"));
    expect(result.payee).toMatchObject({
      value: { id: SEVEN_ELEVEN.id, name: "7-Eleven" },
      source: "typed",
    });
    expect(result.amount.value).toBe(12.5);
    expect(result.memo).toBeNull();
  });

  describe("the line's length", () => {
    it("reads an empty line as nothing typed, Save refused for the amount", async () => {
      const result = await service.interpret(USER, dto(""));
      expect(result).toEqual({
        kind: {
          value: "payment",
          source: "default",
          ambiguous: false,
          alternatives: ["deposit", "transfer"],
        },
        amount: {
          value: null,
          source: "none",
          ambiguous: false,
          alternatives: [],
        },
        date: {
          value: TODAY,
          source: "default",
          ambiguous: false,
          alternatives: [],
        },
        account: {
          value: { id: SAV, name: "Savings", currencyCode: "CAD" },
          source: "default",
          ambiguous: false,
          alternatives: [],
        },
        toAccount: {
          value: null,
          source: "none",
          ambiguous: false,
          alternatives: [],
        },
        payee: {
          value: null,
          source: "none",
          ambiguous: false,
          alternatives: [],
        },
        category: {
          value: null,
          source: "none",
          ambiguous: false,
          alternatives: [],
        },
        memo: null,
        blockers: ["missingAmount"],
        balance: null,
        foreignAmount: null,
      });
      expect(loaders.loadPayeeHistory).not.toHaveBeenCalled();
      expect(transactionsService.previewCreate).not.toHaveBeenCalled();
    });

    it("reads a line at the 200-character cap", async () => {
      const words = Array.from({ length: 60 }, (_v, i) => `w${i}`).join(" ");
      const text = `84.37 loblaws ${words}`.slice(0, QUICK_ADD_TEXT_MAX_LENGTH);
      expect(text).toHaveLength(QUICK_ADD_TEXT_MAX_LENGTH);
      const result = await service.interpret(USER, dto(text));
      expect(result.amount.value).toBe(84.37);
      expect(result.payee.value?.name).toBe("Loblaws");
      expect(result.memo?.startsWith("w0 w1 w2")).toBe(true);
      expect(result.blockers).toEqual([]);
    });
  });
});
