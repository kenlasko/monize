import { describe, expect, it } from "vitest";
import type { Transaction } from "@/types/transaction";
import {
  canShareBankTransaction,
  hasShareableBankStructure,
} from "./shared-bank-eligibility";

const bank = (patch: Partial<Transaction> = {}): Transaction =>
  ({
    userId: "owner",
    amount: -200,
    status: "UNRECONCILED",
    isSplit: true,
    splits: [
      { id: "a", kind: "category", amount: -160 },
      { id: "b", kind: "category", amount: -40 },
    ],
    account: { accountType: "CHEQUING", isClosed: false },
    ...patch,
  }) as Transaction;
describe("Shared bank entry points", () => {
  it("offers owned plain and category-only split payments", () => {
    expect(canShareBankTransaction(bank(), "owner", null)).toBe(true);
    expect(
      canShareBankTransaction(
        bank({ isSplit: false, splits: undefined }),
        "owner",
        null,
      ),
    ).toBe(true);
  });
  it.each([
    { splits: undefined },
    { splits: [] },
    { isTransfer: true },
    { linkedInvestmentTransactionId: "investment" },
    { sharedExpensePostingId: "posting" },
    { status: "RECONCILED" },
    { status: "VOID" },
    { splits: [{ kind: "transfer" }] },
    { splits: [{ kind: "investment" }] },
    { splits: [{ kind: "category", linkedTransactionId: "other" }] },
  ])("refuses incomplete or structural bank sources: %j", (patch) => {
    expect(hasShareableBankStructure(bank(patch as Partial<Transaction>))).toBe(
      false,
    );
  });
  it("keeps the existing ownership and acting-profile boundary", () => {
    expect(canShareBankTransaction(bank(), "other", null)).toBe(false);
    expect(canShareBankTransaction(bank(), "owner", "other")).toBe(false);
  });
});
