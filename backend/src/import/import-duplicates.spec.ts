import type { EntityManager } from "typeorm";
import type { DuplicateCandidate } from "../import-preview/possible-duplicates";
import { TransactionStatus } from "../transactions/entities/transaction.entity";
import {
  fileDuplicateIncoming,
  fileDuplicateRows,
  mergeFileRow,
} from "./import-duplicates";
import type { HeldBankRow } from "./ofx-external-id";
import type { QifTransaction } from "./qif-parser";

function fileRow(over: Partial<QifTransaction> = {}): QifTransaction {
  return {
    date: "2026-11-10",
    amount: -42.5,
    payee: "Hydro",
    memo: "",
    number: "",
    cleared: false,
    reconciled: false,
    category: "",
    isTransfer: false,
    transferAccount: "",
    splits: [],
    security: "",
    action: "",
    price: 0,
    quantity: 0,
    commission: 0,
    ...over,
  };
}

function existing(over: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    id: "tx-1",
    transactionDate: "2026-11-09",
    amount: -42.5,
    payeeName: "Hydro",
    categoryName: null,
    description: null,
    referenceNumber: null,
    status: TransactionStatus.UNRECONCILED,
    isTransfer: false,
    isSplit: false,
    transferAccountName: null,
    hasExternalId: false,
    ...over,
  };
}

describe("fileDuplicateIncoming", () => {
  it("names each compared row by its 0-based position in the file", () => {
    expect(
      fileDuplicateIncoming([fileRow(), fileRow({ amount: 7 })], new Map()),
    ).toEqual([
      { ref: 0, date: "2026-11-10", amount: -42.5 },
      { ref: 1, date: "2026-11-10", amount: 7 },
    ]);
  });

  it("leaves out a transfer row and a void row", () => {
    expect(
      fileDuplicateIncoming(
        [fileRow({ isTransfer: true }), fileRow({ void: true }), fileRow()],
        new Map(),
      ).map((row) => row.ref),
    ).toEqual([2]);
  });

  it("leaves out a row whose bank id the account holds on the same row, not one held on another", () => {
    const held = new Map<string, HeldBankRow>([
      ["ofx:A", { transactionDate: "2026-11-10", amount: -42.5 }],
      ["ofx:B", { transactionDate: "2026-01-01", amount: -42.5 }],
    ]);
    expect(
      fileDuplicateIncoming(
        [fileRow({ fitId: "A" }), fileRow({ fitId: "B" })],
        held,
      ).map((row) => row.ref),
    ).toEqual([1]);
  });
});

describe("fileDuplicateRows", () => {
  it("answers the pairs in file order, with the row's text and the allowed actions", () => {
    const rows = [
      fileRow({ payee: "", memo: "Paid", number: "77" }),
      fileRow({ amount: 9 }),
    ];
    const answer = fileDuplicateRows(
      rows,
      new Map([
        [1, existing({ id: "tx-2", amount: 9, isTransfer: true })],
        [0, existing()],
      ]),
      4,
    );
    expect(answer.map((row) => row.row)).toEqual([0, 1]);
    expect(answer[0]).toMatchObject({
      payee: null,
      memo: "Paid",
      referenceNumber: "77",
      existingTransaction: { id: "tx-1", amount: "-42.5000" },
      duplicateActions: ["import", "merge", "keep", "replace"],
    });
    expect(answer[1].duplicateActions).toEqual(["import", "merge", "keep"]);
  });
});

describe("mergeFileRow", () => {
  const managerRecording = () => {
    const query = jest.fn().mockResolvedValue([]);
    return { m: { query } as unknown as EntityManager, query };
  };

  it("stores the row's bank id on an existing row without one, and holds it", async () => {
    const { m, query } = managerRecording();
    const held = new Map<string, HeldBankRow>();
    await mergeFileRow(
      m,
      "user-1",
      existing(),
      fileRow({ fitId: "A", number: "12" }),
      held,
    );
    expect(query.mock.calls[0][1]).toEqual([
      "tx-1",
      "user-1",
      true,
      "2026-11-10",
      "12",
      TransactionStatus.CLEARED,
      "ofx:A",
    ]);
    expect(held.has("ofx:A")).toBe(true);
  });

  it("stores no bank id when the existing row has one, or another row holds it", async () => {
    const { m, query } = managerRecording();
    await mergeFileRow(
      m,
      "user-1",
      existing({ hasExternalId: true }),
      fileRow({ fitId: "A" }),
      new Map(),
    );
    await mergeFileRow(
      m,
      "user-1",
      existing(),
      fileRow({ fitId: "A" }),
      new Map([["ofx:A", { transactionDate: "2026-01-01", amount: 1 }]]),
    );
    expect(query.mock.calls[0][1][6]).toBeNull();
    expect(query.mock.calls[1][1][6]).toBeNull();
  });

  it("does not move a split parent's date", async () => {
    const { m, query } = managerRecording();
    await mergeFileRow(
      m,
      "user-1",
      existing({ isSplit: true }),
      fileRow(),
      new Map(),
    );
    expect(query.mock.calls[0][1][2]).toBe(false);
    expect(query.mock.calls[0][1][4]).toBeNull();
  });
});
