import { createHash } from "node:crypto";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../common/transaction-note";
import {
  BANK_IMPORT_REFUSAL_REASONS,
  BankImportContext,
  explainBankImport,
  planBankImport,
} from "./bank-transaction-planner";
import { NO_BANK_OPERATION } from "./bank-operation";
import type { BankTransaction } from "./providers/bank-sync-provider.interface";

/**
 * The mapping truth table of docs/specs/bank-sync.md section 6, one line at a
 * time, then the amount, the text fields and the external key. Every row is
 * synthetic.
 */

const CTX: BankImportContext = {
  accountCurrencyCode: "EUR",
  syncFromDate: "2026-03-01",
  today: "2026-03-20",
};

const row = (overrides: Partial<BankTransaction> = {}): BankTransaction => ({
  entryReference: null,
  transactionId: null,
  bankReference: null,
  amount: "10.00",
  currencyCode: "EUR",
  direction: "debit",
  booked: true,
  bookingDate: "2026-03-10",
  valueDate: null,
  transactionDate: null,
  counterpartyName: null,
  remittance: [],
  operation: { ...NO_BANK_OPERATION },
  ...overrides,
});

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const plan = (rows: BankTransaction[], ctx: BankImportContext = CTX) =>
  planBankImport(rows, ctx);

const noRefusals = Object.fromEntries(
  BANK_IMPORT_REFUSAL_REASONS.map((reason) => [reason, 0]),
);

describe("planBankImport", () => {
  describe("the truth table, line by line", () => {
    it("1. a row that is not booked is counted as pending and nothing else", () => {
      // Every other field is bad too: line 1 wins.
      const result = plan([
        row({
          booked: false,
          bookingDate: null,
          amount: "abc",
          direction: null,
          currencyCode: "USD",
        }),
      ]);
      expect(result.pending).toBe(1);
      expect(result.planned).toEqual([]);
      expect(result.refused).toEqual(noRefusals);
      expect(result.beforeCutoff).toBe(0);
    });

    it("2. a row with no valid date is refused as missing_date", () => {
      const result = plan([
        row({ bookingDate: null }),
        row({ bookingDate: "2026-13-45", valueDate: "yesterday" }),
        row({ bookingDate: "", valueDate: "2026-02-30" }),
      ]);
      expect(result.refused.missing_date).toBe(3);
      expect(result.planned).toEqual([]);
    });

    it("2. missing_date wins over every later line", () => {
      const result = plan([
        row({
          bookingDate: null,
          amount: "abc",
          direction: null,
          currencyCode: "USD",
        }),
      ]);
      expect(result.refused).toEqual({ ...noRefusals, missing_date: 1 });
    });

    it("3. a date before the cut-off is counted as beforeCutoff, not refused", () => {
      const result = plan([
        row({ bookingDate: "2026-02-28" }),
        // Wins over the later lines: bad amount, unknown direction.
        row({ bookingDate: "2026-01-01", amount: "abc", direction: null }),
      ]);
      expect(result.beforeCutoff).toBe(2);
      expect(result.planned).toEqual([]);
      expect(result.refused).toEqual(noRefusals);
    });

    it("3. a row dated exactly on the cut-off is planned", () => {
      const result = plan([row({ bookingDate: "2026-03-01" })]);
      expect(result.beforeCutoff).toBe(0);
      expect(result.planned).toHaveLength(1);
    });

    it("4. a date after today + 1 day is refused as future_date", () => {
      const result = plan([
        row({ bookingDate: "2026-03-22" }),
        // Wins over the later lines.
        row({ bookingDate: "2026-04-01", amount: "abc" }),
      ]);
      expect(result.refused).toEqual({ ...noRefusals, future_date: 2 });
      expect(result.planned).toEqual([]);
    });

    it("4. today and today + 1 are planned", () => {
      const result = plan([
        row({ bookingDate: "2026-03-20" }),
        row({ bookingDate: "2026-03-21", amount: "11.00" }),
      ]);
      expect(result.planned.map((p) => p.transactionDate)).toEqual([
        "2026-03-20",
        "2026-03-21",
      ]);
    });

    it("4. today + 1 crosses a month boundary correctly", () => {
      const ctx = { ...CTX, today: "2026-03-31" };
      expect(
        plan([row({ bookingDate: "2026-04-01" })], ctx).planned,
      ).toHaveLength(1);
      expect(
        plan([row({ bookingDate: "2026-04-02" })], ctx).refused.future_date,
      ).toBe(1);
    });

    it("5. an amount that does not match the pattern is refused as invalid_amount", () => {
      const bad: Array<string | null> = [
        null,
        "",
        "   ",
        "abc",
        "-5",
        "+5",
        "1e3",
        "12,50",
        ".5",
        "5.",
        "1 000",
        "1.123456789",
        "12345678901234567",
        "NaN",
        "Infinity",
      ];
      const result = plan(bad.map((amount) => row({ amount })));
      expect(result.refused.invalid_amount).toBe(bad.length);
      expect(result.planned).toEqual([]);
    });

    it("5. invalid_amount wins over unknown_direction and currency_mismatch", () => {
      const result = plan([
        row({ amount: "abc", direction: null, currencyCode: "USD" }),
      ]);
      expect(result.refused).toEqual({ ...noRefusals, invalid_amount: 1 });
    });

    it("6. a direction that is neither credit nor debit is refused as unknown_direction", () => {
      const result = plan([
        row({ direction: null }),
        // Wins over currency_mismatch.
        row({ direction: null, currencyCode: "USD" }),
      ]);
      expect(result.refused).toEqual({ ...noRefusals, unknown_direction: 2 });
    });

    it("7. a currency that differs from the account's is refused as currency_mismatch", () => {
      const result = plan([row({ currencyCode: "USD" })]);
      expect(result.refused).toEqual({ ...noRefusals, currency_mismatch: 1 });
      expect(result.planned).toEqual([]);
    });

    it("7. a row with no currency is refused as currency_mismatch, never assumed", () => {
      const result = plan([
        row({ currencyCode: null }),
        row({ currencyCode: "  " }),
      ]);
      expect(result.refused.currency_mismatch).toBe(2);
      expect(result.planned).toEqual([]);
    });

    it("7. the currency comparison ignores case and surrounding space", () => {
      const result = plan([row({ currencyCode: " eur " })]);
      expect(result.planned).toHaveLength(1);
      const lower = plan([row()], { ...CTX, accountCurrencyCode: " eur" });
      expect(lower.planned).toHaveLength(1);
    });

    it("8. otherwise the row is planned", () => {
      const result = plan([row()]);
      expect(result.planned).toHaveLength(1);
      expect(result.refused).toEqual(noRefusals);
      expect(result.pending).toBe(0);
      expect(result.beforeCutoff).toBe(0);
    });

    it("counts every outcome in one call, in provider order for the planned rows", () => {
      const result = plan([
        row({ bookingDate: "2026-03-05", amount: "1.00" }),
        row({ booked: false }),
        row({ bookingDate: null }),
        row({ bookingDate: "2026-01-05" }),
        row({ bookingDate: "2026-03-06", amount: "2.00" }),
        row({ currencyCode: "GBP" }),
      ]);
      expect(result.planned.map((p) => p.amount)).toEqual([-1, -2]);
      expect(result.pending).toBe(1);
      expect(result.beforeCutoff).toBe(1);
      expect(result.refused).toEqual({
        ...noRefusals,
        missing_date: 1,
        currency_mismatch: 1,
      });
    });
  });

  describe("the planned row", () => {
    it("negates a debit and keeps a credit", () => {
      const result = plan([
        row({ direction: "credit", amount: "1000" }),
        row({ direction: "debit", amount: "12.50" }),
      ]);
      expect(result.planned.map((p) => p.amount)).toEqual([1000, -12.5]);
    });

    it("rounds with roundMoney, the money precision of four decimals", () => {
      // The spec text quotes -12.35 for this input, which is a two-decimal
      // rounding; `roundMoney` (the helper the spec names) keeps four, the
      // precision of decimal(20,4). See the report.
      const result = plan([
        row({ direction: "debit", amount: "12.345" }),
        row({ direction: "debit", amount: "12.34565" }),
        row({ direction: "credit", amount: "0.1" }),
      ]);
      expect(result.planned.map((p) => p.amount)).toEqual([
        -12.345, -12.3457, 0.1,
      ]);
    });

    it("trims the amount before matching it", () => {
      const result = plan([row({ direction: "credit", amount: " 5.25 " })]);
      expect(result.planned[0].amount).toBe(5.25);
    });

    it("accepts the widest amount the pattern allows", () => {
      const result = plan([
        row({ direction: "credit", amount: "1234567890123456.12345678" }),
      ]);
      expect(result.planned).toHaveLength(1);
      expect(Number.isFinite(result.planned[0].amount)).toBe(true);
    });

    it("plans a debit of zero as 0, not -0", () => {
      const result = plan([row({ direction: "debit", amount: "0.00" })]);
      expect(Object.is(result.planned[0].amount, 0)).toBe(true);
    });

    it("dates the row by the first valid of booking, value and transaction date", () => {
      const result = plan([
        row({
          bookingDate: "2026-03-10",
          valueDate: "2026-03-11",
          transactionDate: "2026-03-12",
          amount: "1",
        }),
        row({
          bookingDate: "not a date",
          valueDate: "2026-03-11",
          transactionDate: "2026-03-12",
          amount: "2",
        }),
        row({
          bookingDate: null,
          valueDate: null,
          transactionDate: "2026-03-12",
          amount: "3",
        }),
      ]);
      expect(result.planned.map((p) => p.transactionDate)).toEqual([
        "2026-03-10",
        "2026-03-11",
        "2026-03-12",
      ]);
    });

    it("applies the cut-off to the date the row is planned under", () => {
      // The booking date is invalid, so the (earlier) value date decides.
      const result = plan([
        row({ bookingDate: "bad", valueDate: "2026-02-27" }),
      ]);
      expect(result.beforeCutoff).toBe(1);
    });

    describe("payee text", () => {
      it("uses the counterparty the adapter chose for the direction", () => {
        const result = plan([
          row({ counterpartyName: "  Example Cafe  ", remittance: ["Latte"] }),
        ]);
        expect(result.planned[0].payeeText).toBe("Example Cafe");
      });

      it("falls back to the first remittance line", () => {
        const result = plan([
          row({ counterpartyName: null, remittance: ["", " Card 1234 ", "x"] }),
        ]);
        expect(result.planned[0].payeeText).toBe("Card 1234");
      });

      it("is null when nothing names a payee", () => {
        const result = plan([
          row({ counterpartyName: "   ", remittance: ["  "] }),
        ]);
        expect(result.planned[0].payeeText).toBeNull();
      });

      it("is bounded to 100 characters", () => {
        const result = plan([row({ counterpartyName: "A".repeat(150) })]);
        expect(result.planned[0].payeeText).toBe("A".repeat(100));
      });

      it("does not split a surrogate pair at the bound", () => {
        const name = `${"A".repeat(99)}\u{1F600}tail`;
        const result = plan([row({ counterpartyName: name })]);
        expect(result.planned[0].payeeText).toBe("A".repeat(99));
      });
    });

    describe("description", () => {
      it("joins the remittance lines with a space", () => {
        const result = plan([
          row({ remittance: ["Invoice 42", "March rent"] }),
        ]);
        expect(result.planned[0].description).toBe("Invoice 42 March rent");
      });

      it("drops blank lines, and is null when nothing is left", () => {
        expect(
          plan([row({ remittance: [" a ", "", "  ", "b"] })]).planned[0]
            .description,
        ).toBe("a b");
        expect(
          plan([row({ remittance: [] })]).planned[0].description,
        ).toBeNull();
        expect(
          plan([row({ remittance: ["   "] })]).planned[0].description,
        ).toBeNull();
      });

      it("is bounded by TRANSACTION_NOTE_MAX_LENGTH", () => {
        const result = plan([
          row({ remittance: ["x".repeat(TRANSACTION_NOTE_MAX_LENGTH + 100)] }),
        ]);
        expect(result.planned[0].description).toHaveLength(
          TRANSACTION_NOTE_MAX_LENGTH,
        );
      });
    });

    describe("reference number", () => {
      it("is the bank's reference, trimmed", () => {
        const result = plan([row({ bankReference: " REF-77 " })]);
        expect(result.planned[0].referenceNumber).toBe("REF-77");
      });

      it("is null when absent or blank, and bounded to 100 characters", () => {
        expect(plan([row()]).planned[0].referenceNumber).toBeNull();
        expect(
          plan([row({ bankReference: "  " })]).planned[0].referenceNumber,
        ).toBeNull();
        expect(
          plan([row({ bankReference: "R".repeat(300) })]).planned[0]
            .referenceNumber,
        ).toBe("R".repeat(100));
      });

      it("is display data only: the key does not use it", () => {
        const withRef = plan([row({ bankReference: "SAME" })]).planned[0];
        const other = plan([row({ bankReference: "OTHER" })]).planned[0];
        expect(withRef.externalKey).toBe(other.externalKey);
      });
    });
  });

  describe("external key", () => {
    it("prefers ref: over the hash", () => {
      const result = plan([
        row({ entryReference: "E-1" }),
        row({ entryReference: null, amount: "2" }),
      ]);
      expect(result.planned[0].externalKey).toBe("ref:E-1");
      expect(result.planned[1].externalKey).toMatch(/^hash:[0-9a-f]{64}:0$/);
    });

    it("never keys on the provider's transaction id, which may change between list fetches", () => {
      const first = plan([row({ transactionId: "T-1" })]).planned[0];
      const second = plan([row({ transactionId: "T-2" })]).planned[0];
      const none = plan([row({ transactionId: null })]).planned[0];
      expect(first.externalKey).toMatch(/^hash:/);
      expect(first.externalKey).toBe(second.externalKey);
      expect(first.externalKey).toBe(none.externalKey);
    });

    it("keeps the ref: key when only the transaction id differs between two fetches", () => {
      const first = plan([row({ entryReference: "E-1", transactionId: "T-1" })])
        .planned[0];
      const second = plan([
        row({ entryReference: "E-1", transactionId: "T-CHANGED" }),
      ]).planned[0];
      expect(first.externalKey).toBe("ref:E-1");
      expect(second.externalKey).toBe("ref:E-1");
    });

    it("skips a blank reference and falls through to the hash", () => {
      const result = plan([
        row({ entryReference: "   ", transactionId: "T-3" }),
      ]);
      expect(result.planned[0].externalKey).toMatch(/^hash:[0-9a-f]{64}:0$/);
    });

    it("trims the reference", () => {
      const result = plan([row({ entryReference: "  E-9  " })]);
      expect(result.planned[0].externalKey).toBe("ref:E-9");
    });

    describe("a row repeated within one fetch", () => {
      it("is planned once when the entry reference repeats, the first occurrence winning", () => {
        const result = plan([
          row({ entryReference: "E-1", amount: "5.00" }),
          row({ entryReference: "E-2", amount: "6.00" }),
          row({ entryReference: "E-1", amount: "5.00" }),
        ]);
        expect(result.planned.map((p) => p.externalKey)).toEqual([
          "ref:E-1",
          "ref:E-2",
        ]);
        expect(result.planned.map((p) => p.amount)).toEqual([-5, -6]);
      });

      it("compares the trimmed reference", () => {
        const result = plan([
          row({ entryReference: "E-1" }),
          row({ entryReference: " E-1 " }),
        ]);
        expect(result.planned).toHaveLength(1);
      });

      it("counts a repeated refused row once", () => {
        const result = plan([
          row({ entryReference: "E-1", amount: "bad" }),
          row({ entryReference: "E-1", amount: "bad" }),
        ]);
        expect(result.refused.invalid_amount).toBe(1);
        expect(result.planned).toEqual([]);
      });

      it("never drops rows that carry no entry reference: identical coffees stay two", () => {
        const result = plan([row(), row()]);
        expect(result.planned.map((p) => p.externalKey.slice(-2))).toEqual([
          ":0",
          ":1",
        ]);
      });

      it("compares the content too: a repeat that differs is a second transaction, not a duplicate", () => {
        // Enable Banking's FAQ: some banks "provide duplicate values even
        // though they should not". Dropping the second row would lose a real
        // transaction without a trace.
        const first = row({ entryReference: "E-1", amount: "5.00" });
        const second = row({ entryReference: "E-1", amount: "6.00" });
        const result = plan([first, second]);
        expect(result.planned.map((p) => p.amount)).toEqual([-5, -6]);
        const keys = result.planned.map((p) => p.externalKey);
        expect(new Set(keys).size).toBe(2);
        for (const key of keys) expect(key).toMatch(/^ref:E-1#[0-9a-f]{64}$/);
      });

      it("keys each row of a contested reference by its content, whatever order the bank lists them", () => {
        const a = row({ entryReference: "E-1", amount: "5.00" });
        const b = row({ entryReference: "E-1", amount: "6.00" });
        const keyOf = (rows: BankTransaction[], amount: number) =>
          plan(rows).planned.find((p) => p.amount === amount)?.externalKey;
        expect(keyOf([a, b], -5)).toBe(keyOf([b, a], -5));
        expect(keyOf([a, b], -6)).toBe(keyOf([b, a], -6));
      });

      it("drops an exact repeat inside a contested reference and keeps the rest", () => {
        const result = plan([
          row({ entryReference: "E-1", amount: "5.00" }),
          row({ entryReference: "E-1", amount: "6.00" }),
          row({ entryReference: "E-1", amount: "5.00" }),
        ]);
        expect(result.planned.map((p) => p.amount)).toEqual([-5, -6]);
      });

      it("treats another transaction_id or the same reference on another row as no difference", () => {
        const result = plan([
          row({ entryReference: "E-1", transactionId: "T-1" }),
          row({ entryReference: "E-1", transactionId: "T-2" }),
        ]);
        expect(result.planned.map((p) => p.externalKey)).toEqual(["ref:E-1"]);
      });

      it("keeps an uncontested reference's plain ref: key", () => {
        const result = plan([
          row({ entryReference: "E-1", amount: "5.00" }),
          row({ entryReference: "E-2", amount: "6.00" }),
        ]);
        expect(result.planned.map((p) => p.externalKey)).toEqual([
          "ref:E-1",
          "ref:E-2",
        ]);
      });

      it("fits a long contested key to the column", () => {
        const reference = "R".repeat(250);
        const result = plan([
          row({ entryReference: reference, amount: "5.00" }),
          row({ entryReference: reference, amount: "6.00" }),
        ]);
        for (const { externalKey } of result.planned) {
          expect(externalKey.length).toBeLessThanOrEqual(255);
          expect(externalKey).toMatch(/^ref:[0-9a-f]{64}$/);
        }
        expect(new Set(result.planned.map((p) => p.externalKey)).size).toBe(2);
      });

      it("does not let a pending row shadow the booked row with the same reference", () => {
        const result = plan([
          row({ entryReference: "E-1", booked: false }),
          row({ entryReference: "E-1" }),
        ]);
        expect(result.pending).toBe(1);
        expect(result.planned.map((p) => p.externalKey)).toEqual(["ref:E-1"]);
      });
    });

    it("builds hash: + SHA-256 of date|amount|currency|direction|payee|description + :0", () => {
      const result = plan([
        row({
          amount: "4.50",
          counterpartyName: "Example Cafe",
          remittance: ["Latte"],
        }),
      ]);
      const expected = sha256("2026-03-10|4.5|EUR|debit|Example Cafe|Latte");
      expect(result.planned[0].externalKey).toBe(`hash:${expected}:0`);
    });

    it("uses empty strings for a missing payee and description", () => {
      const result = plan([row({ amount: "3" })]);
      const expected = sha256("2026-03-10|3|EUR|debit||");
      expect(result.planned[0].externalKey).toBe(`hash:${expected}:0`);
    });

    it("is stable: the same row gives the same key, a different row another", () => {
      const a = plan([row()]).planned[0].externalKey;
      const b = plan([row()]).planned[0].externalKey;
      const c = plan([row({ amount: "10.01" })]).planned[0].externalKey;
      const d = plan([row({ direction: "credit" })]).planned[0].externalKey;
      const e = plan([row({ bookingDate: "2026-03-11" })]).planned[0]
        .externalKey;
      expect(a).toBe(b);
      expect(new Set([a, c, d, e]).size).toBe(4);
    });

    it("numbers identical rows from 0 in the order the provider returned them", () => {
      const coffee = row({ amount: "2.80", counterpartyName: "Example Cafe" });
      const other = row({ amount: "9.99", counterpartyName: "Other Shop" });
      const result = plan([coffee, other, coffee, coffee]);
      const keys = result.planned.map((p) => p.externalKey);
      const coffeeHash = sha256("2026-03-10|2.8|EUR|debit|Example Cafe|");
      const otherHash = sha256("2026-03-10|9.99|EUR|debit|Other Shop|");
      expect(keys).toEqual([
        `hash:${coffeeHash}:0`,
        `hash:${otherHash}:0`,
        `hash:${coffeeHash}:1`,
        `hash:${coffeeHash}:2`,
      ]);
    });

    it("gives two identical coffees on one day the same keys on every fetch", () => {
      const coffee = row({ amount: "2.80", counterpartyName: "Example Cafe" });
      const first = plan([coffee, coffee]).planned.map((p) => p.externalKey);
      // A later fetch has a wider window and more rows before and after them.
      const later = plan([
        row({ bookingDate: "2026-03-09", amount: "1" }),
        coffee,
        coffee,
        row({ bookingDate: "2026-03-11", amount: "1" }),
      ]).planned.map((p) => p.externalKey);
      expect(later.slice(1, 3)).toEqual(first);
    });

    it("counts only the rows that are planned", () => {
      const coffee = row({ amount: "2.80" });
      const result = plan([
        coffee,
        // Same content but pending: never counted.
        { ...coffee, booked: false },
        coffee,
      ]);
      const hash = sha256("2026-03-10|2.8|EUR|debit||");
      expect(result.planned.map((p) => p.externalKey)).toEqual([
        `hash:${hash}:0`,
        `hash:${hash}:1`,
      ]);
    });

    it("keeps a payee containing the separator from reading as the description", () => {
      const a = plan([row({ counterpartyName: "A|B", remittance: ["C"] })])
        .planned[0].externalKey;
      const b = plan([row({ counterpartyName: "A", remittance: ["B|C"] })])
        .planned[0].externalKey;
      expect(a).not.toBe(b);
    });

    it("keeps a backslash in a field from disguising a separator", () => {
      const key = (counterpartyName: string, description: string) =>
        plan([row({ counterpartyName, remittance: [description] })]).planned[0]
          .externalKey;
      expect(key("A\\", "|B")).not.toBe(key("A\\|", "B"));
      expect(key("A\\", "|B")).not.toBe(key("A", "\\|B"));
      expect(key("A\\|B", "C")).not.toBe(key("A", "B\\|C"));
    });

    describe("the 255-character bound", () => {
      it("leaves a key of exactly 255 characters alone", () => {
        const reference = "R".repeat(251);
        const key = plan([row({ entryReference: reference })]).planned[0]
          .externalKey;
        expect(key).toBe(`ref:${reference}`);
        expect(key).toHaveLength(255);
      });

      it("replaces a longer ref: key by its prefix and the SHA-256 of the whole key", () => {
        const reference = "R".repeat(252);
        const key = plan([row({ entryReference: reference })]).planned[0]
          .externalKey;
        expect(key).toBe(`ref:${sha256(`ref:${reference}`)}`);
        expect(key.length).toBeLessThanOrEqual(255);
      });

      it("never produces a key over 255 characters", () => {
        const result = plan([
          row({ entryReference: "E".repeat(5000) }),
          row({ entryReference: "F".repeat(5000), amount: "2" }),
          row({
            amount: "3",
            counterpartyName: "N".repeat(500),
            remittance: ["D".repeat(5000)],
          }),
        ]);
        for (const planned of result.planned) {
          expect(planned.externalKey.length).toBeLessThanOrEqual(255);
        }
      });
    });
  });

  describe("the bank's operation type (spec section 7b)", () => {
    // The description is part of the `hash:` key (section 6), so reading the
    // operation type must not touch it: a changed description would import
    // every row a second time. These keys were computed BEFORE the operation
    // type was read, and are pinned as strings, not derived.
    const PIN_CTX: BankImportContext = {
      accountCurrencyCode: "PLN",
      syncFromDate: "2026-08-01",
      today: "2026-10-02",
    };
    const FIXTURE = row({
      transactionId: "tx-1",
      bankReference: "REF-1",
      amount: "12.34",
      currencyCode: "PLN",
      bookingDate: "2026-09-10",
      counterpartyName: "Biedronka",
      remittance: ["Groceries CARD-PAYMENT"],
    });
    const WITH_OPERATION: BankTransaction = {
      ...FIXTURE,
      operation: {
        code: "PMNT",
        subCode: "CCRD",
        description: "Card payment",
        remittanceCode: "CARD-PAYMENT",
      },
    };
    const PINNED_HASH =
      "hash:46af6c6121558eb9badd3815eb662edd99127d36c10fe807d44a502b3bc330b9";

    it("keeps the external key of a fixture row byte for byte", () => {
      const keys = (rows: BankTransaction[]) =>
        planBankImport(rows, PIN_CTX).planned.map((p) => p.externalKey);
      expect(keys([FIXTURE, FIXTURE])).toEqual([
        `${PINNED_HASH}:0`,
        `${PINNED_HASH}:1`,
      ]);
      expect(keys([{ ...FIXTURE, entryReference: "E-1" }])).toEqual([
        "ref:E-1",
      ]);
    });

    it("gives a row the same key and description whatever operation the bank reported", () => {
      const without = planBankImport([FIXTURE], PIN_CTX).planned[0];
      const withIt = planBankImport([WITH_OPERATION], PIN_CTX).planned[0];
      expect(withIt.externalKey).toBe(without.externalKey);
      expect(withIt.externalKey).toBe(`${PINNED_HASH}:0`);
      // The code stays in the description: it is part of what the key hashes.
      expect(withIt.description).toBe("Groceries CARD-PAYMENT");
      expect(withIt.payeeText).toBe(without.payeeText);
    });

    describe("the description without the operation code line", () => {
      // A synthetic row shaped like a bank that sends [free text, OPERATION-CODE].
      const KEY_CTX: BankImportContext = {
        accountCurrencyCode: "PLN",
        syncFromDate: "2026-08-01",
        today: "2026-10-02",
      };
      const SHOP_LINES = ["SOMECITYSHOP NAME  10PL", "CARD-PAYMENT"];
      const SHOP = row({
        entryReference: null,
        amount: "25.50",
        currencyCode: "PLN",
        bookingDate: "2026-09-10",
        counterpartyName: null,
        remittance: SHOP_LINES,
        operation: { ...NO_BANK_OPERATION, remittanceCode: "CARD-PAYMENT" },
      });
      // Computed over the raw two-line text, before the description was split
      // from the code, and pinned as a string, not derived.
      const PINNED_SHOP_HASH =
        "hash:57a60c833d66d319aeab6955c7cdcdf3db408e7804199ab5ca2890d5d547281d";

      it("leaves the code line out of the description", () => {
        expect(planBankImport([SHOP], KEY_CTX).planned[0].description).toBe(
          "SOMECITYSHOP NAME  10PL",
        );
      });

      it("keeps the hash-form key of the raw two-line text", () => {
        const { externalKey } = planBankImport([SHOP], KEY_CTX).planned[0];
        expect(externalKey).toBe(`${PINNED_SHOP_HASH}:0`);
        expect(externalKey).toBe(
          `hash:${sha256(
            [
              "2026-09-10",
              "25.5",
              "PLN",
              "debit",
              SHOP_LINES[0],
              SHOP_LINES.join(" "),
            ].join("|"),
          )}:0`,
        );
      });

      it("keys a row the same whether or not the bank's operation was read", () => {
        const unread = { ...SHOP, operation: { ...NO_BANK_OPERATION } };
        expect(planBankImport([unread], KEY_CTX).planned[0].externalKey).toBe(
          planBankImport([SHOP], KEY_CTX).planned[0].externalKey,
        );
        // Unread, nothing identifies the code, so nothing is left out.
        expect(planBankImport([unread], KEY_CTX).planned[0].description).toBe(
          "SOMECITYSHOP NAME  10PL CARD-PAYMENT",
        );
      });

      it("keeps a code that is only the last word of a longer line in the text", () => {
        const planned = planBankImport(
          [
            {
              ...SHOP,
              remittance: ["SOMECITYSHOP NAME  10PL CARD-PAYMENT"],
            },
          ],
          KEY_CTX,
        ).planned[0];
        expect(planned.description).toBe(
          "SOMECITYSHOP NAME  10PL CARD-PAYMENT",
        );
      });

      it("leaves out only the line the operation was identified on", () => {
        // The first line holding a code is "A CARD-PAYMENT" (last word), so the
        // whole-line code after it was not the one identified and stays.
        const planned = planBankImport(
          [
            {
              ...SHOP,
              remittance: ["Free text", "A CARD-PAYMENT", "TRANSFER-IN"],
            },
          ],
          KEY_CTX,
        ).planned[0];
        expect(planned.description).toBe(
          "Free text A CARD-PAYMENT TRANSFER-IN",
        );
      });

      it("leaves the code line out wherever it sits, and every other line in", () => {
        const planned = planBankImport(
          [
            {
              ...SHOP,
              remittance: ["CARD-PAYMENT", "SOMECITYSHOP", "NAME  10PL"],
            },
          ],
          KEY_CTX,
        ).planned[0];
        expect(planned.description).toBe("SOMECITYSHOP NAME  10PL");
      });

      it("has no description when the code was the only line, and still keys over it", () => {
        const only = {
          ...SHOP,
          counterpartyName: "Example Cafe",
          remittance: ["CARD-PAYMENT"],
        };
        const planned = planBankImport([only], KEY_CTX).planned[0];
        expect(planned.description).toBeNull();
        expect(planned.externalKey).toBe(
          `hash:${sha256(
            [
              "2026-09-10",
              "25.5",
              "PLN",
              "debit",
              "Example Cafe",
              "CARD-PAYMENT",
            ].join("|"),
          )}:0`,
        );
      });

      it("does not leave the code line out for a row whose key is the entry reference", () => {
        const planned = planBankImport(
          [{ ...SHOP, entryReference: "O;0000001" }],
          KEY_CTX,
        ).planned[0];
        expect(planned.externalKey).toBe("ref:O;0000001");
        expect(planned.description).toBe("SOMECITYSHOP NAME  10PL");
      });

      it("lists the same description the writer will write, planned or not", () => {
        const { plan: explained, entries } = explainBankImport(
          [SHOP, { ...SHOP, booked: false }, { ...SHOP, currencyCode: "USD" }],
          KEY_CTX,
        );
        expect(entries.map((e) => e.outcome)).toEqual([
          "planned",
          "pending",
          "refused",
        ]);
        expect(entries[0].description).toBe(explained.planned[0].description);
        expect(entries[0].description).toBe("SOMECITYSHOP NAME  10PL");
        expect(entries[1].description).toBe("SOMECITYSHOP NAME  10PL");
        expect(entries[2].description).toBe("SOMECITYSHOP NAME  10PL");
      });

      it("carries the direction on the planned row and on every entry that has one", () => {
        const { plan: explained, entries } = explainBankImport(
          [
            SHOP,
            { ...SHOP, direction: "credit", amount: "1" },
            { ...SHOP, direction: null },
          ],
          KEY_CTX,
        );
        expect(explained.planned.map((p) => p.direction)).toEqual([
          "debit",
          "credit",
        ]);
        expect(entries.map((e) => e.direction)).toEqual([
          "debit",
          "credit",
          null,
        ]);
      });
    });

    it("carries the operation on the planned row and on the entry, planned or not", () => {
      const { plan: planned, entries } = explainBankImport(
        [WITH_OPERATION, { ...WITH_OPERATION, booked: false }],
        PIN_CTX,
      );
      expect(planned.planned[0].operation).toEqual(WITH_OPERATION.operation);
      expect(entries[0].operation).toEqual(WITH_OPERATION.operation);
      expect(entries[1].outcome).toBe("pending");
      expect(entries[1].operation).toEqual(WITH_OPERATION.operation);
    });
  });

  it("does not modify its input", () => {
    const rows: readonly BankTransaction[] = Object.freeze([
      Object.freeze(
        row({ remittance: Object.freeze(["a", "b"]) as unknown as string[] }),
      ),
      Object.freeze(row({ booked: false })),
    ]);
    expect(() => planBankImport(rows, CTX)).not.toThrow();
  });

  it("returns a zeroed plan for no rows", () => {
    expect(plan([])).toEqual({
      planned: [],
      refused: noRefusals,
      pending: 0,
      beforeCutoff: 0,
    });
  });
});

describe("explainBankImport (the preview's view of the same classification)", () => {
  const explain = (rows: BankTransaction[], ctx: BankImportContext = CTX) =>
    explainBankImport(rows, ctx);

  const MIXED: BankTransaction[] = [
    row({ entryReference: "r1", amount: "12.5", counterpartyName: "Shop" }),
    row({ entryReference: "r2", booked: false, amount: "3" }),
    row({ entryReference: "r3", bookingDate: "2026-02-01", amount: "4" }),
    row({ entryReference: "r4", currencyCode: "USD", amount: "5" }),
    row({ entryReference: "r5", amount: "abc" }),
    row({ entryReference: "r6", direction: "credit", amount: "1000" }),
    row({ entryReference: "r7", bookingDate: null }),
  ];

  it("returns the very plan planBankImport returns: nothing the preview shows is planned differently", () => {
    expect(explain(MIXED).plan).toEqual(planBankImport(MIXED, CTX));
    expect(explain([]).plan).toEqual(planBankImport([], CTX));
  });

  it("lists one entry per row, in the provider's order, with its outcome", () => {
    expect(explain(MIXED).entries.map((e) => [e.outcome, e.reason])).toEqual([
      ["planned", null],
      ["pending", null],
      ["before_cutoff", null],
      ["refused", "currency_mismatch"],
      ["refused", "invalid_amount"],
      ["planned", null],
      ["refused", "missing_date"],
    ]);
  });

  it("gives a planned entry the planner's own fields and its external key", () => {
    const { plan, entries } = explain(MIXED);
    expect(entries[0]).toEqual({
      outcome: "planned",
      reason: null,
      externalKey: "ref:r1",
      transactionDate: "2026-03-10",
      amount: -12.5,
      currencyCode: "EUR",
      payeeText: "Shop",
      description: null,
      referenceNumber: null,
      direction: "debit",
      operation: NO_BANK_OPERATION,
    });
    // The planned entries are the planned rows, one for one, in order.
    expect(
      entries.filter((e) => e.outcome === "planned").map((e) => e.externalKey),
    ).toEqual(plan.planned.map((p) => p.externalKey));
  });

  it("reads what it can of a row it did not plan, signed and bounded, null where it cannot", () => {
    const { entries } = explain(MIXED);
    // pending: a debit of 3
    expect(entries[1]).toMatchObject({
      outcome: "pending",
      externalKey: null,
      transactionDate: "2026-03-10",
      amount: -3,
      currencyCode: "EUR",
    });
    // before the cut-off, still dated and signed
    expect(entries[2]).toMatchObject({
      outcome: "before_cutoff",
      transactionDate: "2026-02-01",
      amount: -4,
    });
    // a foreign currency is shown as the bank sent it, never as the account's
    expect(entries[3]).toMatchObject({ currencyCode: "USD", amount: -5 });
    // an unreadable amount is unknown, not zero
    expect(entries[4]).toMatchObject({ outcome: "refused", amount: null });
    // no date at all
    expect(entries[6]).toMatchObject({ transactionDate: null });
  });

  it("does not sign an amount whose direction is unknown", () => {
    const { entries } = explain([
      row({ entryReference: "x", direction: null, amount: "9" }),
    ]);
    expect(entries[0]).toMatchObject({
      outcome: "refused",
      reason: "unknown_direction",
      amount: null,
    });
  });

  it("shows a zero amount as 0, not -0", () => {
    const { entries } = explain([
      row({ entryReference: "z", amount: "0", booked: false }),
    ]);
    expect(Object.is(entries[0].amount, 0)).toBe(true);
  });

  it("falls back to the first remittance line for the payee and joins the lines for the description", () => {
    const { entries } = explain([
      row({
        entryReference: "p",
        booked: false,
        counterpartyName: null,
        remittance: ["First line", "Second line"],
        bankReference: "REF-9",
      }),
    ]);
    expect(entries[0]).toMatchObject({
      payeeText: "First line",
      description: "First line Second line",
      referenceNumber: "REF-9",
    });
  });

  it("assigns the occurrence counters the way the plan does, so a duplicate coffee keeps its key", () => {
    const coffee = row({ amount: "3", counterpartyName: "Cafe" });
    const { plan, entries } = explain([coffee, coffee]);
    expect(entries.map((e) => e.externalKey)).toEqual(
      plan.planned.map((p) => p.externalKey),
    );
    expect(entries[0].externalKey).toMatch(/:0$/);
    expect(entries[1].externalKey).toMatch(/:1$/);
  });

  it("lists a pagination overlap once, as the plan counts it", () => {
    const one = row({ entryReference: "dup", amount: "7" });
    const { plan, entries } = explain([one, { ...one }]);
    expect(plan.planned).toHaveLength(1);
    expect(entries).toHaveLength(1);
  });
});
