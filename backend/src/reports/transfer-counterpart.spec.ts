import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import {
  convertAtTransferAmounts,
  transferCounterpartOf,
} from "./transfer-counterpart";

const row = (overrides: Partial<Transaction>): Transaction =>
  ({
    id: "tx-out",
    amount: -100,
    currencyCode: "USD",
    isTransfer: true,
    isSplit: false,
    linkedTransactionId: "tx-in",
    linkedTransaction: null,
    splits: [],
    ...overrides,
  }) as unknown as Transaction;

const line = (overrides: Partial<TransactionSplit>): TransactionSplit =>
  ({
    id: "s-1",
    amount: -100,
    transferAccountId: "acc-eur",
    linkedTransactionId: "tx-in",
    linkedTransaction: null,
    ...overrides,
  }) as unknown as TransactionSplit;

describe("transferCounterpartOf", () => {
  it("reads a plain leg's mirror leg when it links back", () => {
    const tx = row({
      linkedTransaction: {
        amount: "90.0000",
        currencyCode: "EUR",
        isSplit: false,
        linkedTransactionId: "tx-out",
      } as never,
    });

    expect(transferCounterpartOf(tx)).toEqual({
      amount: 90,
      currencyCode: "EUR",
    });
  });

  it("has none for a row that is not a transfer leg", () => {
    expect(
      transferCounterpartOf(
        row({
          isTransfer: false,
          linkedTransaction: {
            amount: 90,
            currencyCode: "EUR",
            linkedTransactionId: "tx-out",
          } as never,
        }),
      ),
    ).toBeNull();
  });

  it("has none for a split parent read as a whole", () => {
    expect(transferCounterpartOf(row({ isSplit: true }))).toBeNull();
  });

  it("reads the parent's line that links back, never the parent's amount", () => {
    const tx = row({
      id: "tx-in",
      amount: 90,
      currencyCode: "EUR",
      linkedTransactionId: "tx-split",
      linkedTransaction: {
        amount: -160,
        currencyCode: "USD",
        isSplit: true,
        splits: [
          { amount: -60, transferAccountId: null, linkedTransactionId: null },
          {
            amount: -100,
            transferAccountId: "acc-eur",
            linkedTransactionId: "tx-in",
          },
        ],
      } as never,
    });

    expect(transferCounterpartOf(tx)).toEqual({
      amount: -100,
      currencyCode: "USD",
    });
  });

  it("has none when no line of the linked parent links back", () => {
    const tx = row({
      id: "tx-in",
      linkedTransaction: {
        isSplit: true,
        currencyCode: "USD",
        splits: [{ transferAccountId: "acc-eur", linkedTransactionId: "x" }],
      } as never,
    });

    expect(transferCounterpartOf(tx)).toBeNull();
  });

  it("reads a split transfer line's counterpart when it links to the parent", () => {
    const parent = row({ id: "tx-split", isSplit: true, isTransfer: false });
    const split = line({
      linkedTransaction: {
        amount: 90,
        currencyCode: "EUR",
        linkedTransactionId: "tx-split",
      } as never,
    });

    expect(transferCounterpartOf(parent, split)).toEqual({
      amount: 90,
      currencyCode: "EUR",
    });
  });

  it("has none for a split line that is not a transfer, or does not link back", () => {
    const parent = row({ id: "tx-split", isSplit: true });
    const counterpart = {
      amount: 90,
      currencyCode: "EUR",
      linkedTransactionId: "tx-split",
    } as never;

    expect(
      transferCounterpartOf(
        parent,
        line({ transferAccountId: null, linkedTransaction: counterpart }),
      ),
    ).toBeNull();
    expect(
      transferCounterpartOf(
        parent,
        line({
          linkedTransaction: {
            amount: 90,
            currencyCode: "EUR",
            linkedTransactionId: "tx-other",
          } as never,
        }),
      ),
    ).toBeNull();
    expect(transferCounterpartOf(parent, line({}))).toBeNull();
  });
});

describe("convertAtTransferAmounts", () => {
  const sent = { amount: -100, currencyCode: "USD" };
  const received = { amount: 90, currencyCode: "EUR" };

  it("answers the counterpart's amount, signed as the amount asked", () => {
    expect(convertAtTransferAmounts(-100, sent, received, "EUR")).toBe(-90);
    expect(convertAtTransferAmounts(100, sent, received, "EUR")).toBe(90);
  });

  it("converts any other amount of the leg in proportion", () => {
    expect(convertAtTransferAmounts(-50, sent, received, "EUR")).toBe(-45);
  });

  it("answers nothing without a counterpart in the reporting currency", () => {
    expect(convertAtTransferAmounts(-100, sent, null, "EUR")).toBeNull();
    expect(convertAtTransferAmounts(-100, sent, received, "CAD")).toBeNull();
  });

  it("answers nothing for a leg already in the reporting currency", () => {
    expect(convertAtTransferAmounts(90, received, sent, "EUR")).toBeNull();
  });

  it("refuses amounts that are not a transfer's two sides", () => {
    expect(
      convertAtTransferAmounts(
        -100,
        sent,
        { amount: -90, currencyCode: "EUR" },
        "EUR",
      ),
    ).toBeNull();
    expect(
      convertAtTransferAmounts(
        -100,
        sent,
        { amount: 0, currencyCode: "EUR" },
        "EUR",
      ),
    ).toBeNull();
    expect(
      convertAtTransferAmounts(
        -100,
        { amount: 0, currencyCode: "USD" },
        received,
        "EUR",
      ),
    ).toBeNull();
    expect(
      convertAtTransferAmounts(
        -100,
        sent,
        { amount: Number.NaN, currencyCode: "EUR" },
        "EUR",
      ),
    ).toBeNull();
    expect(
      convertAtTransferAmounts(
        -100,
        { amount: -Infinity, currencyCode: "USD" },
        received,
        "EUR",
      ),
    ).toBeNull();
  });
});
