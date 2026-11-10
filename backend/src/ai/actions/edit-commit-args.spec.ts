import {
  updateTransactionCommitArgs,
  updateTransferCommitArgs,
} from "./edit-commit-args";
import {
  BatchUpdateTransactionRow,
  UpdateTransactionDescriptor,
  UpdateTransferDescriptor,
} from "./ai-action.types";

const envelope = { userId: "u1", actionId: "a1", expiresAt: 1 };

const edit: UpdateTransactionDescriptor = {
  ...envelope,
  type: "update_transaction",
  transactionId: "t1",
  accountId: "acc-1",
  amount: -30,
  transactionDate: "2026-02-01",
  payeeId: null,
  payeeName: "Store",
  createPayee: true,
  categoryId: "c1",
  description: null,
  currencyCode: "USD",
};

describe("updateTransactionCommitArgs", () => {
  it("maps a plain edit, leaving tags and splits out", () => {
    expect(updateTransactionCommitArgs(edit)).toEqual({
      dto: {
        accountId: "acc-1",
        transactionDate: "2026-02-01",
        amount: -30,
        currencyCode: "USD",
        payeeId: undefined,
        payeeName: "Store",
        categoryId: "c1",
        description: undefined,
        splits: undefined,
      },
      options: { createPayeeIfMissing: true },
    });
  });

  it("carries the tags a card adds and removes", () => {
    const { options } = updateTransactionCommitArgs({
      ...edit,
      tagNames: ["Trip"],
      removeTagIds: ["tag-o"],
    });
    expect(options).toEqual({
      createPayeeIfMissing: true,
      addTagNames: ["Trip"],
      removeTagIds: ["tag-o"],
    });
  });

  it("keeps the split lines' tags, and gives the parent no category", () => {
    const { dto } = updateTransactionCommitArgs({
      ...edit,
      splits: [
        { categoryId: "c1", amount: -20, memo: null, tagIds: ["tag-1"] },
        { categoryId: "c2", amount: -10, memo: "soap" },
      ],
    });
    expect(dto.categoryId).toBeUndefined();
    expect(dto.splits).toEqual([
      { categoryId: "c1", amount: -20, memo: undefined, tagIds: ["tag-1"] },
      { categoryId: "c2", amount: -10, memo: "soap" },
    ]);
  });

  it("writes only the tags of a tag-only edit, never its snapshot", () => {
    expect(
      updateTransactionCommitArgs({
        ...edit,
        tagNames: ["Trip"],
        tagsOnly: true,
      }),
    ).toEqual({
      dto: {},
      options: { createPayeeIfMissing: true, addTagNames: ["Trip"] },
    });
  });

  it("sets a reference number only when the card does", () => {
    expect(
      updateTransactionCommitArgs({ ...edit, referenceNumber: "A-1" }).dto,
    ).toMatchObject({ referenceNumber: "A-1" });
    expect(updateTransactionCommitArgs(edit).dto).not.toHaveProperty(
      "referenceNumber",
    );
  });

  it("maps a batch row the same way as the singular descriptor", () => {
    const row: BatchUpdateTransactionRow = {
      transactionId: "t1",
      accountId: "acc-1",
      amount: -30,
      transactionDate: "2026-02-01",
      payeeId: null,
      payeeName: "Store",
      createPayee: true,
      categoryId: null,
      description: null,
      currencyCode: "USD",
      splits: [{ categoryId: "c1", amount: -30, memo: null, tagIds: ["x"] }],
      tagNames: ["Trip"],
      removeTagIds: ["tag-o"],
    };
    const {
      type: _t,
      userId: _u,
      actionId: _a,
      expiresAt: _e,
      ...rest
    } = {
      ...edit,
      ...row,
    };
    expect(updateTransactionCommitArgs(row)).toEqual(
      updateTransactionCommitArgs({ ...edit, ...rest }),
    );
  });
});

describe("updateTransferCommitArgs", () => {
  const transfer: UpdateTransferDescriptor = {
    ...envelope,
    type: "update_transfer",
    transactionId: "t1",
    fromAccountId: "a1",
    toAccountId: "a2",
    amount: 100,
    transactionDate: "2026-02-01",
    exchangeRate: 1,
    toAmount: 100,
    description: null,
    payeeId: null,
    payeeName: null,
    createPayee: false,
    categoryId: null,
  };

  it("maps the edit with the resolved payee and an empty tag change", () => {
    expect(updateTransferCommitArgs(transfer, "p1")).toEqual({
      dto: {
        amount: 100,
        transactionDate: "2026-02-01",
        exchangeRate: 1,
        toAmount: 100,
        description: undefined,
        payeeId: "p1",
        payeeName: undefined,
        categoryId: null,
      },
      tagChange: {},
    });
  });

  it("writes no field of a tag-only transfer edit", () => {
    expect(
      updateTransferCommitArgs(
        { ...transfer, removeTagIds: ["tag-o"], tagsOnly: true },
        "p1",
      ),
    ).toEqual({ dto: {}, tagChange: { removeTagIds: ["tag-o"] } });
  });

  it("carries the tags a card adds and removes on both legs", () => {
    expect(
      updateTransferCommitArgs(
        { ...transfer, tagNames: ["Trip"], removeTagIds: ["tag-o"] },
        undefined,
      ).tagChange,
    ).toEqual({ addTagNames: ["Trip"], removeTagIds: ["tag-o"] });
  });
});
