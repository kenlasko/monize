import {
  RAW_LOG_CHUNK_CHARS,
  lastFour,
  maskAccountNumber,
  maskRawPayload,
  rawLogLines,
} from "./enable-banking-raw-log";

/** A high surrogate with no low one after it, or a low one with no high one before. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("maskAccountNumber", () => {
  it("keeps the country code and the last four characters", () => {
    expect(maskAccountNumber("PL61109010140000071219812874")).toBe(
      `PL${"*".repeat(22)}2874`,
    );
  });

  it("ignores spaces and dashes, so the grouping is not left behind", () => {
    expect(maskAccountNumber("PL61 1090 1014 0000 0712 1981 2874")).toBe(
      `PL${"*".repeat(22)}2874`,
    );
    expect(maskAccountNumber("61-1090-1014-0000-0712-1981-2874")).toBe(
      `${"*".repeat(22)}2874`,
    );
  });

  it("masks a short value wholly rather than showing most of it", () => {
    expect(maskAccountNumber("1234")).toBe("****");
    expect(maskAccountNumber("PL12")).toBe("PL**");
    expect(maskAccountNumber("")).toBe("");
  });
});

describe("lastFour", () => {
  it("keeps the last four characters and masks the rest", () => {
    expect(lastFour("session-abcdef")).toBe("**********cdef");
  });

  it("masks a value of four characters or fewer wholly", () => {
    expect(lastFour("abcd")).toBe("****");
    expect(lastFour("ab")).toBe("**");
  });
});

describe("maskRawPayload", () => {
  const IBAN = "DE89370400440532013000";

  it("masks the identifier keys wherever they sit", () => {
    const masked = JSON.stringify(
      maskRawPayload({
        account_id: {
          iban: IBAN,
          bban: "0532013000",
          other: { identification: "9999888877776666" },
        },
        all_account_ids: [{ identification: "1111222233334444" }],
        creditor_account: { iban: IBAN },
        account_number: 1234567890,
      }),
    );
    for (const secret of [
      IBAN,
      "0532013000",
      "9999888877776666",
      "1111222233334444",
      "1234567890",
    ]) {
      expect(masked).not.toContain(secret);
    }
    expect(masked).toContain("3000");
    expect(masked).toContain("DE");
  });

  it("masks an IBAN or an NRB inside free text and keeps the rest of it", () => {
    const masked = maskRawPayload({
      remittance_information: [
        `Faktura 12/2026 na ${IBAN} dziekujemy`,
        "Przelew 61 1090 1014 0000 0712 1981 2874 tytul",
      ],
    }) as { remittance_information: string[] };
    expect(masked.remittance_information[0]).toBe(
      `Faktura 12/2026 na DE${"*".repeat(16)}3000 dziekujemy`,
    );
    expect(masked.remittance_information[1]).toBe(
      `Przelew ${"*".repeat(22)}2874 tytul`,
    );
  });

  it("does not mask a plain amount, date or reference", () => {
    const payload = {
      transaction_amount: { amount: "12345.67", currency: "PLN" },
      booking_date: "2026-09-10",
      entry_reference: "E-123456789012",
      remittance_information: ["Card payment 4111 ok"],
    };
    expect(maskRawPayload(payload)).toEqual(payload);
  });

  it("cuts the session id, the account handle and the identification hash to their last four", () => {
    expect(
      maskRawPayload({
        session_id: "session-1234567890",
        accounts: [{ uid: "uid-abcdefgh", identification_hash: "hash-wxyz" }],
      }),
    ).toEqual({
      session_id: `${"*".repeat(14)}7890`,
      accounts: [
        { uid: `${"*".repeat(8)}efgh`, identification_hash: `*****wxyz` },
      ],
    });
  });

  it("removes a token wherever it appears", () => {
    const masked = JSON.stringify(
      maskRawPayload({ note: "x eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln y" }),
    );
    expect(masked).not.toContain("eyJ");
    expect(masked).toContain("[redacted]");
  });

  it("does not mutate its input and passes other types through", () => {
    const payload = Object.freeze({
      iban: IBAN,
      n: 1,
      b: true,
      z: null,
      a: [1, "x"],
    });
    expect(() => maskRawPayload(payload)).not.toThrow();
    expect(payload.iban).toBe(IBAN);
    expect(maskRawPayload(5)).toBe(5);
    expect(maskRawPayload(null)).toBeNull();
    expect(maskRawPayload(undefined)).toBeUndefined();
  });
});

describe("rawLogLines", () => {
  it("tags one line with what was read, the account's last four and the page", () => {
    const lines = rawLogLines({
      label: "transactions",
      accountUid: "uid-abc-1234",
      page: 3,
      payload: { ok: true },
    });
    expect(lines).toEqual([
      'Enable Banking raw transactions account ...1234 page 3 part 1/1: {"ok":true}',
    ]);
  });

  it("omits the account and the page when there are none", () => {
    expect(
      rawLogLines({ label: "session", accountUid: null, payload: {} }),
    ).toEqual(["Enable Banking raw session part 1/1: {}"]);
  });

  it("splits a larger answer into numbered parts that put the JSON back together", () => {
    const payload = { text: "a".repeat(250) };
    const lines = rawLogLines({
      label: "balances",
      accountUid: "u-0001",
      payload,
      chunkChars: 100,
    });
    expect(lines.length).toBeGreaterThan(2);
    const joined = lines.map((line) => line.replace(/^[^:]*: /, "")).join("");
    expect(JSON.parse(joined)).toEqual(payload);
    expect(lines[0]).toContain(`part 1/${lines.length}`);
    expect(lines[lines.length - 1]).toContain(
      `part ${lines.length}/${lines.length}`,
    );
  });

  it("never cuts a surrogate pair in two", () => {
    const payload = { text: "\u{1F600}".repeat(60) };
    const lines = rawLogLines({
      label: "x",
      accountUid: null,
      payload,
      chunkChars: 11,
    });
    for (const line of lines) {
      const part = line.replace(/^[^:]*: /, "");
      expect(part).not.toMatch(LONE_SURROGATE);
    }
  });

  it("keeps one part of the default size within 64 KB, the widest characters included", () => {
    const [line] = rawLogLines({
      label: "x",
      accountUid: null,
      payload: { text: "\u{1F600}".repeat(RAW_LOG_CHUNK_CHARS) },
    });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(64 * 1024);
  });
});
