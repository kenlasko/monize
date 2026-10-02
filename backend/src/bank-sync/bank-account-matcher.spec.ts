import {
  matchBankAccounts,
  type MatchableAccount,
  type MatchableBankAccount,
} from "./bank-account-matcher";

const IBAN = "PL61109010140000071219812874";
const NRB = "61 1090 1014 0000 0712 1981 2874";
const NONE: ReadonlySet<string> = new Set();

const bank = (
  over: Partial<MatchableBankAccount> = {},
): MatchableBankAccount => ({
  id: "bank-1",
  accountIdentifier: IBAN,
  currencyCode: "PLN",
  ...over,
});

const account = (over: Partial<MatchableAccount> = {}): MatchableAccount => ({
  id: "acc-1",
  accountNumber: NRB,
  currencyCode: "PLN",
  isClosed: false,
  isInvestmentBrokerage: false,
  ...over,
});

describe("matchBankAccounts", () => {
  it("links the one account whose NRB is the bank's IBAN without its country prefix", () => {
    expect(matchBankAccounts([bank()], [account()], NONE)).toEqual({
      linked: [{ bankAccountId: "bank-1", accountId: "acc-1" }],
      suggestions: [],
    });
  });

  it("links an account written as the full IBAN, with spaces or dashes", () => {
    for (const written of [
      "PL61 1090 1014 0000 0712 1981 2874",
      "pl61-1090-1014-0000-0712-1981-2874",
      IBAN,
    ]) {
      expect(
        matchBankAccounts([bank()], [account({ accountNumber: written })], NONE)
          .linked,
      ).toEqual([{ bankAccountId: "bank-1", accountId: "acc-1" }]);
    }
  });

  it("links nothing when no account number names the identifier", () => {
    expect(
      matchBankAccounts(
        [bank()],
        [
          account({ accountNumber: "11 2222 3333" }),
          account({ id: "acc-2", accountNumber: null }),
        ],
        NONE,
      ),
    ).toEqual({ linked: [], suggestions: [] });
  });

  it("offers every candidate as a suggestion, linking none, when two or more match", () => {
    const result = matchBankAccounts(
      [bank()],
      [
        account(),
        account({ id: "acc-2", accountNumber: IBAN }),
        account({ id: "acc-3", accountNumber: "99" }),
      ],
      NONE,
    );
    expect(result).toEqual({
      linked: [],
      suggestions: [
        { bankAccountId: "bank-1", accountIds: ["acc-1", "acc-2"] },
      ],
    });
  });

  describe("which accounts are candidates", () => {
    it("skips a closed account", () => {
      expect(
        matchBankAccounts([bank()], [account({ isClosed: true })], NONE),
      ).toEqual({ linked: [], suggestions: [] });
    });

    it("skips an investment brokerage account", () => {
      expect(
        matchBankAccounts(
          [bank()],
          [account({ isInvestmentBrokerage: true })],
          NONE,
        ),
      ).toEqual({ linked: [], suggestions: [] });
    });

    it("skips an account already linked to a bank account, so the remaining one is unique", () => {
      const result = matchBankAccounts(
        [bank()],
        [account(), account({ id: "acc-2" })],
        new Set(["acc-1"]),
      );
      expect(result.linked).toEqual([
        { bankAccountId: "bank-1", accountId: "acc-2" },
      ]);
    });

    it("skips an account in another currency, comparing spellings alike", () => {
      expect(
        matchBankAccounts([bank()], [account({ currencyCode: "EUR" })], NONE),
      ).toEqual({ linked: [], suggestions: [] });
      expect(
        matchBankAccounts(
          [bank({ currencyCode: "pln" })],
          [account({ currencyCode: " PLN " })],
          NONE,
        ).linked,
      ).toHaveLength(1);
    });

    it("accepts any currency when the bank account's is unknown", () => {
      expect(
        matchBankAccounts(
          [bank({ currencyCode: null })],
          [account({ currencyCode: "EUR" })],
          NONE,
        ).linked,
      ).toEqual([{ bankAccountId: "bank-1", accountId: "acc-1" }]);
    });
  });

  it("ignores a bank account with no identifier", () => {
    expect(
      matchBankAccounts([bank({ accountIdentifier: null })], [account()], NONE),
    ).toEqual({ linked: [], suggestions: [] });
  });

  it("matches each bank account on its own identifier, in input order", () => {
    const result = matchBankAccounts(
      [
        bank({ id: "bank-1", accountIdentifier: IBAN }),
        bank({ id: "bank-2", accountIdentifier: "DE89370400440532013000" }),
      ],
      [
        account({ id: "acc-2", accountNumber: "DE89 3704 0044 0532 0130 00" }),
        account({ id: "acc-1" }),
      ],
      NONE,
    );
    expect(result.linked).toEqual([
      { bankAccountId: "bank-1", accountId: "acc-1" },
      { bankAccountId: "bank-2", accountId: "acc-2" },
    ]);
  });

  it("does not link one account to two bank accounts: both become suggestions", () => {
    // The same number in two currencies of one bank account would otherwise
    // link the first by order and fail the second.
    const result = matchBankAccounts(
      [
        bank({ id: "bank-1", currencyCode: null }),
        bank({ id: "bank-2", currencyCode: null }),
      ],
      [account()],
      NONE,
    );
    expect(result).toEqual({
      linked: [],
      suggestions: [
        { bankAccountId: "bank-1", accountIds: ["acc-1"] },
        { bankAccountId: "bank-2", accountIds: ["acc-1"] },
      ],
    });
  });

  it("does not mutate its inputs", () => {
    const banks = [bank()];
    const accounts = [account()];
    const linked = new Set<string>();
    matchBankAccounts(banks, accounts, linked);
    expect(banks).toEqual([bank()]);
    expect(accounts).toEqual([account()]);
    expect(linked.size).toBe(0);
  });
});
