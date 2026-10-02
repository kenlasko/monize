import {
  ACCOUNT_IDENTIFIER_MAX_LENGTH,
  accountNumberMatchesIdentifier,
  boundedAccountIdentifier,
  normalizeAccountNumber,
} from "./bank-account-identifier";

describe("normalizeAccountNumber", () => {
  it("removes spaces and dashes and upper-cases", () => {
    expect(normalizeAccountNumber("pl61 1090-1014 0000 0712 1981 2874")).toBe(
      "PL61109010140000071219812874",
    );
  });

  it("removes tabs, line breaks and control characters too", () => {
    expect(normalizeAccountNumber(" 12\t34\n56\u0001 ")).toBe("123456");
  });

  it.each([null, undefined, 42, {}, "", "   ", " - - "])(
    "is null for %p",
    (value) => {
      expect(normalizeAccountNumber(value)).toBeNull();
    },
  );
});

describe("boundedAccountIdentifier", () => {
  it("keeps an identifier of exactly the bound", () => {
    const sixtyFour = "A".repeat(ACCOUNT_IDENTIFIER_MAX_LENGTH);
    expect(boundedAccountIdentifier(sixtyFour.toLowerCase())).toBe(sixtyFour);
  });

  it("is no identifier, not a cut one, past the bound", () => {
    expect(
      boundedAccountIdentifier("A".repeat(ACCOUNT_IDENTIFIER_MAX_LENGTH + 1)),
    ).toBeNull();
  });

  it("counts the length after the spaces are gone", () => {
    expect(
      boundedAccountIdentifier("1 ".repeat(ACCOUNT_IDENTIFIER_MAX_LENGTH)),
    ).toBe("1".repeat(ACCOUNT_IDENTIFIER_MAX_LENGTH));
  });
});

describe("accountNumberMatchesIdentifier", () => {
  const IBAN = "PL61109010140000071219812874";
  const NRB = "61 1090 1014 0000 0712 1981 2874";

  it("matches an IBAN written with spaces against the stored one", () => {
    expect(
      accountNumberMatchesIdentifier(
        "PL61 1090 1014 0000 0712 1981 2874",
        IBAN,
      ),
    ).toBe(true);
  });

  it("matches a Polish NRB, the IBAN without its country prefix", () => {
    expect(accountNumberMatchesIdentifier(NRB, IBAN)).toBe(true);
    expect(
      accountNumberMatchesIdentifier("61-1090-1014-0000-0712-1981-2874", IBAN),
    ).toBe(true);
  });

  it("does not match a different number", () => {
    expect(
      accountNumberMatchesIdentifier("61 1090 1014 0000 0712 1981 2875", IBAN),
    ).toBe(false);
  });

  it("does not match a number that merely contains or ends the identifier", () => {
    expect(accountNumberMatchesIdentifier(`X${IBAN}`, IBAN)).toBe(false);
    expect(accountNumberMatchesIdentifier("1981 2874", IBAN)).toBe(false);
  });

  it("strips only a two-letter prefix, and only from the bank's side", () => {
    // A numeric identifier has no country prefix to remove.
    expect(accountNumberMatchesIdentifier("1234", "12345678")).toBe(false);
    // The Monize number is never stripped: it is compared as typed.
    expect(
      accountNumberMatchesIdentifier(IBAN, "61109010140000071219812874"),
    ).toBe(false);
  });

  it("is false when either side is missing or blank", () => {
    expect(accountNumberMatchesIdentifier(null, IBAN)).toBe(false);
    expect(accountNumberMatchesIdentifier(NRB, null)).toBe(false);
    expect(accountNumberMatchesIdentifier("  ", "  ")).toBe(false);
  });

  it("does not match a bare country code against an empty remainder", () => {
    expect(accountNumberMatchesIdentifier("", "PL")).toBe(false);
    expect(accountNumberMatchesIdentifier("PL", "PL")).toBe(true);
  });
});
