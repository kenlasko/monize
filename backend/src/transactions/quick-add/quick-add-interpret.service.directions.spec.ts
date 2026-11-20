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
import { QuickAddInterpretService } from "./quick-add-interpret.service";
import {
  CHQ,
  QuickAddServiceHarness,
  SAV,
  USER,
  VISA_A,
  account,
  buildQuickAddService,
  candidates,
  dto,
  useSuiteClock,
} from "./__fixtures__/quick-add-interpret";

const loaders = jest.mocked(candidatesModule);

/**
 * A payment or deposit word never outranks the accounts' directions
 * (`docs/future-plans/quick-add.md`, "Filling what was not typed"): `paid 500
 * to visa` moves money into Visa, so it is a transfer, not a payment made on
 * Visa. Two named accounts, a `to` account on a payment or a `from` account on
 * a deposit make the kind a transfer unless the kind is pinned.
 */
describe("QuickAddInterpretService: a typed kind and the accounts' directions", () => {
  let service: QuickAddInterpretService;
  let transactionsService: QuickAddServiceHarness["transactionsService"];
  let transferService: QuickAddServiceHarness["transferService"];
  let locale: jest.SpyInstance | null = null;

  beforeEach(() => {
    useSuiteClock();
    jest.clearAllMocks();
    ({ service, transactionsService, transferService } =
      buildQuickAddService(loaders));
    const base = candidates();
    loaders.loadQuickAddCandidates.mockResolvedValue(
      candidates({
        accounts: [...base.accounts, account(VISA_A, "Visa", -300)],
      }),
    );
  });

  afterEach(() => {
    locale?.mockRestore();
    locale = null;
    jest.useRealTimers();
  });

  const transferOf = (
    result: Awaited<ReturnType<QuickAddInterpretService["interpret"]>>,
  ) => ({
    kind: result.kind.value,
    kindSource: result.kind.source,
    from: result.account.value?.id,
    to: result.toAccount.value?.id,
    blockers: result.blockers,
  });

  describe("a payment word with a to account is a transfer into it", () => {
    it.each([
      ["paid 500 to visa", "en"],
      ["pay 500 to visa", "en"],
      ["payment 500 to visa", "en"],
      ["bezahlt 500 an visa", "de"],
    ])(
      "%s (%s) moves 500 from the default account to Visa",
      async (text, lang) => {
        locale = jest
          .spyOn(I18nContext, "current")
          .mockReturnValue({ lang } as unknown as I18nContext);
        const result = await service.interpret(
          USER,
          dto(text, { contextAccountId: CHQ }),
        );
        expect(transferOf(result)).toEqual({
          kind: "transfer",
          kindSource: "inferred",
          from: CHQ,
          to: VISA_A,
          blockers: [],
        });
        expect(result.category).toMatchObject({ value: null, source: "none" });
        expect(result.balance).toMatchObject({ accountId: CHQ, after: 500 });
        expect(transferService.previewCreateTransfer).toHaveBeenCalledWith(
          USER,
          expect.objectContaining({
            fromAccountId: CHQ,
            toAccountId: VISA_A,
            amount: 500,
          }),
        );
        expect(transactionsService.previewCreate).not.toHaveBeenCalled();
      },
    );

    it.each([
      "paid 500 to visa from chequing",
      "paid 500 from chequing to visa",
    ])("%s moves 500 from Chequing to Visa", async (text) => {
      const result = await service.interpret(USER, dto(text));
      expect(transferOf(result)).toEqual({
        kind: "transfer",
        kindSource: "inferred",
        from: CHQ,
        to: VISA_A,
        blockers: [],
      });
    });
  });

  it("reads a deposit word with a from account as a transfer out of it", async () => {
    const result = await service.interpret(
      USER,
      dto("received 100 from savings", { contextAccountId: CHQ }),
    );
    expect(transferOf(result)).toEqual({
      kind: "transfer",
      kindSource: "inferred",
      from: SAV,
      to: CHQ,
      blockers: [],
    });
  });

  describe("the directions a typed kind owns", () => {
    it("keeps 500 to visa a transfer from the default account", async () => {
      const result = await service.interpret(
        USER,
        dto("500 to visa", { contextAccountId: CHQ }),
      );
      expect(transferOf(result)).toMatchObject({
        kind: "transfer",
        from: CHQ,
        to: VISA_A,
      });
    });

    it("keeps spent 20 from savings a payment from Savings", async () => {
      const result = await service.interpret(
        USER,
        dto("spent 20 from savings", { contextAccountId: CHQ }),
      );
      expect(result.kind).toMatchObject({ value: "payment", source: "typed" });
      expect(result.account).toMatchObject({
        value: { id: SAV },
        source: "typed",
      });
      expect(result.toAccount.value).toBeNull();
      expect(result.balance).toMatchObject({ accountId: SAV, after: 4980 });
    });

    it("keeps received 100 to savings a deposit into Savings", async () => {
      const result = await service.interpret(
        USER,
        dto("received 100 to savings", { contextAccountId: CHQ }),
      );
      expect(result.kind).toMatchObject({ value: "deposit", source: "typed" });
      expect(result.account).toMatchObject({
        value: { id: SAV },
        source: "typed",
      });
      expect(result.toAccount.value).toBeNull();
      expect(result.balance).toMatchObject({ accountId: SAV, after: 5100 });
    });

    it("keeps a leading minus with a to account a transfer, like a payment word", async () => {
      const result = await service.interpret(
        USER,
        dto("-500 to visa", { contextAccountId: CHQ }),
      );
      expect(transferOf(result)).toMatchObject({
        kind: "transfer",
        from: CHQ,
        to: VISA_A,
      });
    });
  });

  describe("a pinned payment or deposit", () => {
    it("stays as pinned, and two named accounts make the account ambiguous", async () => {
      const result = await service.interpret(
        USER,
        dto("500 chequing to visa", { pins: { kind: "payment" } }),
      );
      expect(result.kind).toMatchObject({ value: "payment", source: "pinned" });
      // A payment is made from an account: the `to` one is offered instead.
      expect(result.account).toMatchObject({
        value: { id: CHQ },
        source: "typed",
        ambiguous: true,
      });
      expect(result.account.alternatives.map((a) => a.id)).toEqual([VISA_A]);
      expect(result.toAccount.value).toBeNull();
      expect(result.blockers).toEqual(["ambiguousAccount"]);
      expect(transactionsService.previewCreate).not.toHaveBeenCalled();
      expect(transferService.previewCreateTransfer).not.toHaveBeenCalled();
    });

    it("prefers the to account of a pinned deposit, still ambiguous", async () => {
      const result = await service.interpret(
        USER,
        dto("500 from chequing to visa", { pins: { kind: "deposit" } }),
      );
      expect(result.account).toMatchObject({
        value: { id: VISA_A },
        ambiguous: true,
      });
      expect(result.blockers).toEqual(["ambiguousAccount"]);
    });

    it("is not ambiguous with the account pinned too", async () => {
      const result = await service.interpret(
        USER,
        dto("500 chequing to visa", {
          pins: { kind: "payment", accountId: VISA_A },
        }),
      );
      expect(result.account).toMatchObject({
        value: { id: VISA_A },
        source: "pinned",
        ambiguous: false,
      });
      expect(result.blockers).toEqual([]);
    });

    it("keeps one named account its own: a pinned deposit from savings", async () => {
      const result = await service.interpret(
        USER,
        dto("received 100 from savings", {
          contextAccountId: CHQ,
          pins: { kind: "deposit" },
        }),
      );
      expect(result.kind).toMatchObject({ value: "deposit", source: "pinned" });
      expect(result.account).toMatchObject({
        value: { id: SAV },
        ambiguous: false,
      });
      expect(result.blockers).toEqual([]);
    });
  });
});
