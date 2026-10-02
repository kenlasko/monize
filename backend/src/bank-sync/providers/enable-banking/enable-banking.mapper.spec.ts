import { BankSyncProviderError } from "../bank-sync-provider.errors";
import {
  maskIdentifier,
  mapAccountDetails,
  mapApplication,
  mapAuthorizationUrl,
  mapBalance,
  mapInstitutions,
  mapSession,
  mapTransaction,
  mapTransactionsPage,
} from "./enable-banking.mapper";

/** Wire JSON in, provider-neutral shapes out. Every value is synthetic. */

const invalid = { kind: "invalid_response" } as const;

describe("maskIdentifier", () => {
  it("keeps the last four characters", () => {
    expect(maskIdentifier("XX00 0000 0000 0000 0000 1234")).toBe("**** 1234");
    expect(maskIdentifier("XX00000000000000001234")).toBe("**** 1234");
  });

  it("shows nothing of an identifier too short to hide anything", () => {
    expect(maskIdentifier("12345")).toBe("****");
  });

  it("is null for anything that is not a non-empty string", () => {
    for (const value of [null, undefined, 42, {}, [], "", "   "]) {
      expect(maskIdentifier(value)).toBeNull();
    }
  });
});

describe("mapApplication", () => {
  it("reads the name and the registered redirect URLs", () => {
    expect(
      mapApplication({
        name: "  My Monize  ",
        redirect_urls: ["https://monize.example/settings/bank-sync/callback"],
      }),
    ).toEqual({
      applicationName: "My Monize",
      redirectUrls: ["https://monize.example/settings/bank-sync/callback"],
    });
  });

  it("tolerates absent and mistyped fields", () => {
    expect(mapApplication({})).toEqual({
      applicationName: null,
      redirectUrls: [],
    });
    expect(
      mapApplication({
        name: 5,
        redirect_urls: ["https://a.example", 7, null],
      }),
    ).toEqual({ applicationName: null, redirectUrls: ["https://a.example"] });
    expect(mapApplication({ redirect_urls: "https://a.example" })).toEqual({
      applicationName: null,
      redirectUrls: [],
    });
  });

  it.each([null, "text", 5, []])(
    "raises invalid_response for %p",
    (payload) => {
      expect(() => mapApplication(payload)).toThrow(
        expect.objectContaining(invalid),
      );
    },
  );
});

describe("mapInstitutions", () => {
  it("maps a bank", () => {
    expect(
      mapInstitutions({
        aspsps: [
          {
            name: "Example Bank",
            country: "pl",
            logo: "https://enablebanking.com/brands/PL/Example%20Bank/",
            psu_types: ["personal", "business"],
            // In seconds (GetAspspsResponse / ASPSPData); 15552000 is 180 days.
            maximum_consent_validity: 15_552_000,
            // Documented fields the adapter does not read.
            auth_methods: [
              { approach: "REDIRECT", name: "MTA", psu_type: "personal" },
            ],
            beta: false,
            bic: "EXAMPLEXXX",
            required_psu_headers: ["Psu-Ip-Address", "Psu-User-Agent"],
          },
        ],
      }),
    ).toEqual([
      {
        name: "Example Bank",
        country: "PL",
        logoUrl: "https://enablebanking.com/brands/PL/Example%20Bank/",
        psuTypes: ["personal", "business"],
        maximumConsentValiditySeconds: 15_552_000,
      },
    ]);
  });

  it("skips a row without a name or a two-letter country, and non-objects", () => {
    const result = mapInstitutions({
      aspsps: [
        null,
        "bank",
        { country: "PL" },
        { name: "No Country" },
        { name: "Long Country", country: "POL" },
        { name: "Digits", country: "P1" },
        { name: "Kept", country: "DE" },
      ],
    });
    expect(result.map((bank) => bank.name)).toEqual(["Kept"]);
  });

  it("nulls what is absent or mistyped", () => {
    expect(
      mapInstitutions({
        aspsps: [
          {
            name: "Bare Bank",
            country: "DE",
            logo: 5,
            psu_types: "personal",
            maximum_consent_validity: "90",
          },
        ],
      }),
    ).toEqual([
      {
        name: "Bare Bank",
        country: "DE",
        logoUrl: null,
        psuTypes: [],
        maximumConsentValiditySeconds: null,
      },
    ]);
  });

  it("keeps only an https logo, and only a positive finite validity", () => {
    const [http, script, zero, negative, nan] = mapInstitutions({
      aspsps: [
        { name: "A", country: "DE", logo: "http://logos.example/a.png" },
        { name: "B", country: "DE", logo: "javascript:alert(1)" },
        { name: "C", country: "DE", maximum_consent_validity: 0 },
        { name: "D", country: "DE", maximum_consent_validity: -5 },
        { name: "E", country: "DE", maximum_consent_validity: NaN },
      ],
    });
    expect(http.logoUrl).toBeNull();
    expect(script.logoUrl).toBeNull();
    expect(zero.maximumConsentValiditySeconds).toBeNull();
    expect(negative.maximumConsentValiditySeconds).toBeNull();
    expect(nan.maximumConsentValiditySeconds).toBeNull();
  });

  it("bounds a name to 255 characters and strips control characters", () => {
    const [bank] = mapInstitutions({
      aspsps: [{ name: `Bank\u0000\n${"x".repeat(400)}`, country: "DE" }],
    });
    expect(bank.name).toBe(`Bank ${"x".repeat(250)}`);
  });

  it("returns an empty list for an empty answer", () => {
    expect(mapInstitutions({ aspsps: [] })).toEqual([]);
  });

  it.each([null, [], "x", { aspsps: "x" }, { aspsps: null }, {}])(
    "raises invalid_response for %p",
    (payload) => {
      expect(() => mapInstitutions(payload)).toThrow(
        expect.objectContaining(invalid),
      );
    },
  );
});

describe("mapAuthorizationUrl", () => {
  it("returns an https URL", () => {
    expect(mapAuthorizationUrl({ url: "https://bank.example/auth?x=1" })).toBe(
      "https://bank.example/auth?x=1",
    );
  });

  it.each([
    { url: "http://bank.example/auth" },
    { url: "javascript:alert(1)" },
    { url: "not a url" },
    { url: "" },
    { url: 5 },
    {},
    null,
  ])("raises invalid_response for %p", (payload) => {
    expect(() => mapAuthorizationUrl(payload)).toThrow(
      expect.objectContaining(invalid),
    );
  });
});

describe("mapSession", () => {
  // The shape of an AuthorizeSessionResponse (API reference, POST /sessions),
  // with synthetic values. `name` is the account HOLDER's name.
  const session = {
    session_id: "session-1",
    access: { valid_until: "2026-06-01T12:00:00.000000+00:00" },
    aspsp: { name: "Example Bank", country: "PL" },
    psu_type: "personal",
    accounts: [
      {
        uid: "07cc67f4-45d6-494b-adac-09b5cbc7e2b5",
        identification_hash: "hash-1",
        identification_hashes: ["hash-1", "hash-1b"],
        name: "Holder Name",
        details: "Everyday Account",
        product: "Current account",
        usage: "PRIV",
        cash_account_type: "CACC",
        currency: "eur",
        account_id: { iban: "XX00000000000000001234" },
        all_account_ids: [{ identification: "00001234", scheme_name: "BBAN" }],
      },
    ],
  };

  it("maps the session and its accounts", () => {
    expect(mapSession(session)).toEqual({
      sessionId: "session-1",
      validUntil: new Date("2026-06-01T12:00:00.000Z"),
      accounts: [
        {
          externalAccountId: "07cc67f4-45d6-494b-adac-09b5cbc7e2b5",
          identificationHash: "hash-1",
          displayName: "Everyday Account",
          identifierMasked: "**** 1234",
          accountIdentifier: "XX00000000000000001234",
          cashAccountType: "CACC",
          currencyCode: "EUR",
        },
      ],
    });
  });

  it("keeps the full identifier only in accountIdentifier, never in the label or the mask", () => {
    const [account] = mapSession(session).accounts;
    const { accountIdentifier, ...shown } = account;
    expect(accountIdentifier).toBe("XX00000000000000001234");
    expect(JSON.stringify(shown)).not.toContain("XX0000000000");
    expect(JSON.stringify(account)).not.toContain("Holder Name");
  });

  it("labels an account with its details, then its product, and the holder's name last", () => {
    const label = (account: Record<string, unknown>) =>
      mapSession({ session_id: "s", accounts: [{ uid: "u", ...account }] })
        .accounts[0].displayName;
    expect(label({ name: "Holder", product: "Prod", details: "Pot" })).toBe(
      "Pot",
    );
    expect(label({ name: "Holder", product: "Prod" })).toBe("Prod");
    expect(label({ name: "Holder" })).toBe("Holder");
    expect(label({})).toBeNull();
  });

  it("falls back to other.identification, then to all_account_ids, for the number", () => {
    const number = (account: Record<string, unknown>) =>
      mapSession({ session_id: "s", accounts: [{ uid: "u", ...account }] })
        .accounts[0].identifierMasked;
    expect(
      number({ account_id: { other: { identification: "ACC-00001234567" } } }),
    ).toBe("**** 4567");
    expect(
      number({
        account_id: {},
        all_account_ids: [
          { scheme_name: "BBAN" },
          { identification: "99990000", scheme_name: "BBAN" },
        ],
      }),
    ).toBe("**** 0000");
    expect(number({ all_account_ids: "x" })).toBeNull();
  });

  it("reads XXX, the ISO code for no currency, as an unknown currency", () => {
    const [account] = mapSession({
      session_id: "s",
      accounts: [{ uid: "u", currency: "xxx" }],
    }).accounts;
    expect(account.currencyCode).toBeNull();
  });

  it("nulls every optional field and skips a row without a uid", () => {
    const result = mapSession({
      session_id: "s",
      accounts: [
        null,
        "uid",
        { name: "no uid" },
        { uid: "uid-3", currency: "EURO", account_id: "x", name: 5 },
      ],
    });
    expect(result.accounts).toEqual([
      {
        externalAccountId: "uid-3",
        identificationHash: null,
        displayName: null,
        identifierMasked: null,
        accountIdentifier: null,
        cashAccountType: null,
        currencyCode: null,
      },
    ]);
  });

  describe("the identifier (spec section 5a)", () => {
    const identifier = (account: Record<string, unknown>) =>
      mapSession({ session_id: "s", accounts: [{ uid: "u", ...account }] })
        .accounts[0].accountIdentifier;

    it("is the IBAN, normalized: spaces and dashes removed, upper case", () => {
      expect(
        identifier({
          account_id: { iban: "pl61 1090-1014 0000 0712 1981 2874" },
        }),
      ).toBe("PL61109010140000071219812874");
    });

    it("is account_id.other.identification when there is no IBAN", () => {
      expect(
        identifier({
          account_id: { other: { identification: "61 1090 1014-0000" } },
          all_account_ids: [{ identification: "ignored" }],
        }),
      ).toBe("6110901014" + "0000");
    });

    it("is the first all_account_ids entry that carries one when account_id has none", () => {
      expect(
        identifier({
          account_id: {},
          all_account_ids: [
            { scheme_name: "BBAN" },
            { identification: "ab 12", scheme_name: "BBAN" },
            { identification: "zz" },
          ],
        }),
      ).toBe("AB12");
    });

    it("does not let an empty IBAN hide the number beside it", () => {
      expect(
        identifier({
          account_id: { iban: "  ", other: { identification: "12-34" } },
        }),
      ).toBe("1234");
    });

    it("is null when the bank gave none, or only something unusable", () => {
      expect(identifier({})).toBeNull();
      expect(identifier({ account_id: { iban: 5 } })).toBeNull();
      expect(identifier({ account_id: { iban: " - " } })).toBeNull();
    });

    it("is bounded to 64 characters: longer is no identifier, not a cut one", () => {
      expect(identifier({ account_id: { iban: "1".repeat(64) } })).toBe(
        "1".repeat(64),
      );
      expect(identifier({ account_id: { iban: "1".repeat(65) } })).toBeNull();
    });
  });

  describe("the account type", () => {
    const type = (value: unknown) =>
      mapSession({
        session_id: "s",
        accounts: [{ uid: "u", cash_account_type: value }],
      }).accounts[0].cashAccountType;

    it.each([
      ["CARD", "CARD"],
      ["card", "CARD"],
      [" svgs ", "SVGS"],
    ])("reads %p as %p", (value, expected) => {
      expect(type(value)).toBe(expected);
    });

    it.each([null, 5, "", "C4RD", "CARD CARD", "ABCDEFGHIJK", {}])(
      "is null for %p",
      (value) => {
        expect(type(value)).toBeNull();
      },
    );
  });

  it("has a null validUntil when the expiry is absent or unreadable", () => {
    expect(mapSession({ session_id: "s", accounts: [] }).validUntil).toBeNull();
    expect(
      mapSession({
        session_id: "s",
        accounts: [],
        access: { valid_until: "soon" },
      }).validUntil,
    ).toBeNull();
    expect(
      mapSession({ session_id: "s", accounts: [], access: "x" }).validUntil,
    ).toBeNull();
  });

  it.each([
    null,
    "x",
    {},
    { session_id: "" },
    { session_id: 5, accounts: [] },
    { session_id: "s" },
    { session_id: "s", accounts: "x" },
  ])("raises invalid_response for %p", (payload) => {
    expect(() => mapSession(payload)).toThrow(expect.objectContaining(invalid));
  });
});

describe("mapAccountDetails", () => {
  // GET /accounts/{uid}/details answers one AccountResource, synthetic values.
  const details = {
    uid: "11111111-2222-4333-8444-555555555555",
    identification_hash: "hash-2",
    name: "Holder Name",
    cash_account_type: "CARD",
    currency: "pln",
    account_id: { other: { identification: "5276 0000 0000 2743" } },
  };

  it("maps the account like a session lists it", () => {
    expect(
      mapAccountDetails(details, "11111111-2222-4333-8444-555555555555"),
    ).toEqual({
      externalAccountId: "11111111-2222-4333-8444-555555555555",
      identificationHash: "hash-2",
      displayName: "Holder Name",
      identifierMasked: "**** 2743",
      accountIdentifier: "5276000000002743",
      cashAccountType: "CARD",
      currencyCode: "PLN",
    });
  });

  it("names the account that was asked for, even when the answer has no uid or another one", () => {
    const { uid: _uid, ...withoutUid } = details;
    expect(mapAccountDetails(withoutUid, "ext-asked").externalAccountId).toBe(
      "ext-asked",
    );
    expect(
      mapAccountDetails({ ...details, uid: "other" }, "ext-asked")
        .externalAccountId,
    ).toBe("ext-asked");
  });

  it("nulls what the bank did not say", () => {
    expect(mapAccountDetails({}, "ext-1")).toEqual({
      externalAccountId: "ext-1",
      identificationHash: null,
      displayName: null,
      identifierMasked: null,
      accountIdentifier: null,
      cashAccountType: null,
      currencyCode: null,
    });
  });

  it.each([null, "x", 5, []])("raises invalid_response for %p", (payload) => {
    expect(() => mapAccountDetails(payload, "ext-1")).toThrow(
      expect.objectContaining(invalid),
    );
  });
});

describe("mapTransaction", () => {
  const wire = {
    entry_reference: "E-1",
    transaction_id: "T-1",
    reference_number: "REF-1",
    transaction_amount: { amount: "12.34", currency: "EUR" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    booking_date: "2026-03-10",
    value_date: "2026-03-11",
    transaction_date: "2026-03-09",
    creditor: { name: "Example Cafe" },
    debtor: { name: "Me" },
    remittance_information: ["Latte", "Card 1234"],
  };

  it("maps a booked debit and picks the creditor as the counterparty", () => {
    expect(mapTransaction(wire)).toEqual({
      entryReference: "E-1",
      transactionId: "T-1",
      bankReference: "REF-1",
      amount: "12.34",
      currencyCode: "EUR",
      direction: "debit",
      booked: true,
      bookingDate: "2026-03-10",
      valueDate: "2026-03-11",
      transactionDate: "2026-03-09",
      counterpartyName: "Example Cafe",
      remittance: ["Latte", "Card 1234"],
      operation: {
        code: null,
        subCode: null,
        description: null,
        remittanceCode: null,
      },
    });
  });

  describe("the bank's operation type (spec section 7b)", () => {
    it("reads bank_transaction_code, bounded, and the code of a remittance line", () => {
      const row = mapTransaction({
        ...wire,
        bank_transaction_code: {
          description: "Card payment",
          code: "PMNT",
          sub_code: "CCRD",
        },
        remittance_information: [
          "Latte",
          "Op 1 MOBILE-PAYMENT-POS-NO-CARD-TX-CODE",
        ],
      });
      expect(row?.operation).toEqual({
        code: "PMNT",
        subCode: "CCRD",
        description: "Card payment",
        remittanceCode: "MOBILE-PAYMENT-POS-NO-CARD-TX-CODE",
      });
    });

    it("leaves the remittance lines exactly as the bank sent them (they are the duplicate key's input)", () => {
      const lines = ["Latte CARD-PAYMENT", "TRANSFER-IN"];
      const row = mapTransaction({ ...wire, remittance_information: lines });
      expect(row?.remittance).toEqual(lines);
      expect(row?.operation.remittanceCode).toBe("CARD-PAYMENT");
    });

    it("bounds every operation text", () => {
      const row = mapTransaction({
        ...wire,
        bank_transaction_code: {
          code: "c".repeat(500),
          sub_code: "s".repeat(500),
          description: "d".repeat(500),
        },
      });
      expect(row?.operation.code).toHaveLength(100);
      expect(row?.operation.subCode).toHaveLength(100);
      expect(row?.operation.description).toHaveLength(100);
    });

    it("tolerates a bank_transaction_code of the wrong type", () => {
      for (const bad of ["PMNT", 5, [], null]) {
        expect(
          mapTransaction({ ...wire, bank_transaction_code: bad })?.operation,
        ).toMatchObject({ code: null, subCode: null, description: null });
      }
    });
  });

  it("picks the debtor as the counterparty for a credit", () => {
    const row = mapTransaction({
      ...wire,
      credit_debit_indicator: "CRDT",
      debtor: { name: "Employer Ltd" },
    });
    expect(row).toMatchObject({
      direction: "credit",
      counterpartyName: "Employer Ltd",
    });
  });

  it("has no counterparty when the direction is unknown", () => {
    const row = mapTransaction({ ...wire, credit_debit_indicator: "???" });
    expect(row).toMatchObject({ direction: null, counterpartyName: null });
  });

  describe("booked", () => {
    it("is true only for BOOK", () => {
      expect(mapTransaction({ ...wire, status: "BOOK" })?.booked).toBe(true);
      expect(mapTransaction({ ...wire, status: "book" })?.booked).toBe(true);
      for (const status of ["PDNG", "INFO", "HOLD", "OTHR", "RJCT"]) {
        expect(mapTransaction({ ...wire, status })?.booked).toBe(false);
      }
    });

    it("with no status, is true only when a booking date is present", () => {
      expect(mapTransaction({ ...wire, status: undefined })?.booked).toBe(true);
      expect(
        mapTransaction({ ...wire, status: undefined, booking_date: undefined })
          ?.booked,
      ).toBe(false);
      expect(
        mapTransaction({ ...wire, status: 5, booking_date: null })?.booked,
      ).toBe(false);
    });

    it("an explicit non-booked status wins over a booking date", () => {
      expect(
        mapTransaction({ ...wire, status: "PDNG", booking_date: "2026-03-10" })
          ?.booked,
      ).toBe(false);
    });
  });

  it("tolerates an empty object: every field null, nothing thrown", () => {
    expect(mapTransaction({})).toEqual({
      entryReference: null,
      transactionId: null,
      bankReference: null,
      amount: null,
      currencyCode: null,
      direction: null,
      booked: false,
      bookingDate: null,
      valueDate: null,
      transactionDate: null,
      counterpartyName: null,
      remittance: [],
      operation: {
        code: null,
        subCode: null,
        description: null,
        remittanceCode: null,
      },
    });
  });

  it("tolerates wrong types in every field", () => {
    expect(() =>
      mapTransaction({
        entry_reference: 5,
        transaction_id: {},
        reference_number: [],
        transaction_amount: "12",
        credit_debit_indicator: 7,
        status: {},
        booking_date: 20260310,
        creditor: "Example",
        debtor: [],
        remittance_information: { line: 1 },
      }),
    ).not.toThrow();
  });

  it("skips a row that is not an object", () => {
    for (const row of [null, undefined, 5, "x", []]) {
      expect(mapTransaction(row)).toBeNull();
    }
  });

  it("keeps an amount only when it is a plain decimal", () => {
    const amountOf = (amount: unknown) =>
      mapTransaction({
        ...wire,
        transaction_amount: { amount, currency: "EUR" },
      })?.amount;
    expect(amountOf("12.34")).toBe("12.34");
    expect(amountOf(" 7 ")).toBe("7");
    expect(amountOf(12.5)).toBe("12.5");
    expect(amountOf("1e3")).toBeNull();
    expect(amountOf("12,50")).toBeNull();
    expect(amountOf(NaN)).toBeNull();
    expect(amountOf(null)).toBeNull();
  });

  it("accepts a bare string as the remittance, and bounds the lines", () => {
    expect(
      mapTransaction({ ...wire, remittance_information: "Rent" })?.remittance,
    ).toEqual(["Rent"]);
    const lines = mapTransaction({
      ...wire,
      remittance_information: Array.from({ length: 50 }, () =>
        "x".repeat(2000),
      ),
    })?.remittance;
    expect(lines).toHaveLength(20);
    expect(lines?.[0]).toHaveLength(750);
  });

  it("drops non-string and blank remittance lines", () => {
    expect(
      mapTransaction({
        ...wire,
        remittance_information: ["a", 5, null, "  ", "b"],
      })?.remittance,
    ).toEqual(["a", "b"]);
  });

  it("bounds references and names to 255 characters", () => {
    const row = mapTransaction({
      ...wire,
      entry_reference: "e".repeat(400),
      transaction_id: "t".repeat(400),
      reference_number: "r".repeat(400),
      creditor: { name: "n".repeat(400) },
    });
    expect(row?.entryReference).toHaveLength(255);
    expect(row?.transactionId).toHaveLength(255);
    expect(row?.bankReference).toHaveLength(255);
    expect(row?.counterpartyName).toHaveLength(255);
  });

  it("upper-cases the currency and nulls one that is not three letters", () => {
    const currencyOf = (currency: unknown) =>
      mapTransaction({
        ...wire,
        transaction_amount: { amount: "1", currency },
      })?.currencyCode;
    expect(currencyOf("eur")).toBe("EUR");
    expect(currencyOf("EU")).toBeNull();
    expect(currencyOf("E1R")).toBeNull();
    expect(currencyOf(978)).toBeNull();
  });
});

describe("mapTransactionsPage", () => {
  it("maps the rows and the continuation key", () => {
    const page = mapTransactionsPage({
      transactions: [{ entry_reference: "E-1", status: "BOOK" }, null, "x"],
      continuation_key: "next-page",
    });
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0].entryReference).toBe("E-1");
    expect(page.continuationKey).toBe("next-page");
  });

  it("has no continuation key on the last page", () => {
    for (const continuation_key of [null, undefined, "", "  ", 5]) {
      expect(
        mapTransactionsPage({ transactions: [], continuation_key })
          .continuationKey,
      ).toBeNull();
    }
  });

  it.each([null, [], "x", {}, { transactions: null }, { transactions: {} }])(
    "raises invalid_response for %p",
    (payload) => {
      expect(() => mapTransactionsPage(payload)).toThrow(
        expect.objectContaining(invalid),
      );
    },
  );

  it("throws the typed error class", () => {
    expect(() => mapTransactionsPage(null)).toThrow(BankSyncProviderError);
  });
});

describe("mapBalance", () => {
  const balance = (type: string, amount: string, extra = {}) => ({
    balance_type: type,
    balance_amount: { amount, currency: "EUR" },
    reference_date: "2026-03-10",
    ...extra,
  });

  it("picks CLBD, then ITBD, then ITAV, then CLAV, then XPCD", () => {
    const all = [
      balance("XPCD", "5"),
      balance("CLAV", "4"),
      balance("ITAV", "3"),
      balance("ITBD", "2"),
      balance("CLBD", "1"),
    ];
    expect(mapBalance({ balances: all })?.amount).toBe("1");
    expect(mapBalance({ balances: all.slice(0, 4) })?.amount).toBe("2");
    expect(mapBalance({ balances: all.slice(0, 3) })?.amount).toBe("3");
    expect(mapBalance({ balances: all.slice(0, 2) })?.amount).toBe("4");
    expect(mapBalance({ balances: all.slice(0, 1) })?.amount).toBe("5");
  });

  it("never shows an opening, previous-period or forward balance as the balance", () => {
    for (const type of ["OPBD", "OPAV", "PRCD", "FWAV"]) {
      expect(mapBalance({ balances: [balance(type, "7")] })).toBeNull();
    }
    // Skipped in favour of any balance of another type, in the bank's order.
    expect(
      mapBalance({
        balances: [balance("OPBD", "7"), balance("INFO", "8")],
      })?.amount,
    ).toBe("8");
  });

  it("falls back to the first readable balance of another type", () => {
    const result = mapBalance({
      balances: [
        { balance_type: "BROKEN" },
        balance("FWAV", "8"),
        balance("OTHR", "9"),
      ],
    });
    expect(result?.amount).toBe("9");
  });

  it("maps all four fields and keeps a negative amount", () => {
    expect(mapBalance({ balances: [balance("clbd", "-250.75")] })).toEqual({
      amount: "-250.75",
      currencyCode: "EUR",
      referenceDate: "2026-03-10",
      balanceType: "CLBD",
    });
  });

  it("skips a balance without a readable amount or currency", () => {
    const result = mapBalance({
      balances: [
        {
          balance_type: "CLBD",
          balance_amount: { amount: "x", currency: "EUR" },
        },
        {
          balance_type: "CLBD",
          balance_amount: { amount: "1", currency: "?" },
        },
        { balance_type: "CLBD", balance_amount: "1" },
        null,
        balance("ITBD", "5"),
      ],
    });
    expect(result?.amount).toBe("5");
  });

  it("is null, not zero, when the bank reported no balance", () => {
    expect(mapBalance({ balances: [] })).toBeNull();
    expect(mapBalance({ balances: [{ balance_type: "CLBD" }] })).toBeNull();
  });

  it.each([null, "x", {}, { balances: {} }, { balances: null }])(
    "raises invalid_response for %p",
    (payload) => {
      expect(() => mapBalance(payload)).toThrow(
        expect.objectContaining(invalid),
      );
    },
  );
});
