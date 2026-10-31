import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { transactionsApi } from "@/lib/transactions";
import type { Transaction } from "@/types/transaction";
import type {
  SharedBankPaymentInput,
  SharedOriginalBank,
} from "@/types/shared-expense";
import { SharedBankPaymentEditor } from "./SharedBankPaymentEditor";

vi.mock("@/lib/transactions", () => ({
  transactionsApi: { getById: vi.fn() },
}));
const original: SharedOriginalBank = {
  id: "bank-row",
  isSplit: true,
  splits: [
    {
      id: "food",
      amount: "-160.0000",
      categoryId: "food-category",
      memo: null,
    },
    {
      id: "private",
      amount: "-40.0000",
      categoryId: "private-category",
      memo: "Personal shopping",
    },
  ],
};
const changed = vi.fn();
function Editor({
  originalBanks,
  initial = { bankTransactionId: "bank-row" },
}: {
  originalBanks?: SharedOriginalBank[];
  initial?: SharedBankPaymentInput;
}) {
  const [input, setInput] = useState(initial);
  return (
    <SharedBankPaymentEditor
      input={input}
      originalBanks={originalBanks}
      accounts={[]}
      categories={[{ value: "food-category", label: "Food" }]}
      groupCurrency="USD"
      originalCurrency="USD"
      multiple={false}
      onChange={(patch) => {
        changed(patch);
        setInput({ ...input, ...patch });
      }}
    />
  );
}
describe("Explicit bank category portions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(transactionsApi.getById).mockResolvedValue({
      ...original,
      amount: -200,
      currencyCode: "USD",
      accountId: "bank",
      description: "Groceries",
    } as unknown as Transaction);
  });
  it("sends the selected line amount and leaves unselected categories untouched", async () => {
    await act(async () => {
      render(<Editor />);
    });
    fireEvent.change(screen.getByLabelText("Shared part of Food"), {
      target: { value: "140" },
    });
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith({
        sourceSplits: [{ splitId: "food", amount: "140" }],
        sharedBankAmount: undefined,
      }),
    );
    expect(
      screen.getByLabelText("Shared part of Personal shopping"),
    ).toHaveValue("");
    expect(
      screen.queryByLabelText("Category for the private part"),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Shared part of Food"), {
      target: { value: "" },
    });
    expect(changed).toHaveBeenLastCalledWith({
      sourceSplits: [],
      sharedBankAmount: undefined,
    });
  });
  it("reopens the original allocation even when the linked bank entry now has a transfer split", async () => {
    vi.mocked(transactionsApi.getById).mockResolvedValue({
      id: "bank-row",
      amount: -200,
      currencyCode: "USD",
      isSplit: true,
      splits: [
        { id: "transfer", kind: "transfer", amount: -140 },
        { id: "food", kind: "category", amount: -20 },
      ],
    } as Transaction);
    await act(async () => {
      render(
        <Editor
          originalBanks={[original]}
          initial={{
            bankTransactionId: "bank-row",
            sourceSplits: [{ splitId: "food", amount: "140" }],
          }}
        />,
      );
    });
    expect(screen.getByLabelText("Shared part of Food")).toHaveValue(
      "140.0000",
    );
    expect(
      screen.getByLabelText("Shared part of Personal shopping"),
    ).toBeInTheDocument();
    expect(screen.getByText("$160.00")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Record a new payment" }),
      );
    });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceSplits: undefined,
        bankTransactionId: undefined,
      }),
    );
    expect(
      screen.queryByLabelText("Shared part of Food"),
    ).not.toBeInTheDocument();
  });
});
