import {
  personalEffect,
  personalFingerprint,
  sharedBankBreakdown,
} from "./shared-projection";
import { SharedJournalEntry } from "./shared-journal";

const entry = (
  type: SharedJournalEntry["type"] = "EXPENSE",
): SharedJournalEntry => ({
  id: "entry",
  groupId: "group",
  createdByUserId: "owner",
  type,
  state: "POSTED",
  draftReason: null,
  title: "Dinner",
  note: null,
  categoryLabel: null,
  date: "2026-01-01",
  originalAmount: "300.0000",
  currencyCode: "PLN",
  groupAmount: "300.0000",
  fxRate: "1.0000000000",
  fxRateDate: null,
  fxSource: "IDENTITY",
  splitMode: "EXACT",
  roundingSeed: "seed",
  revision: 1,
  financialRevision: 1,
  sourceEntryId: null,
  fromParticipantId: null,
  toParticipantId: null,
  allocations: [
    {
      entryId: "entry",
      participantId: "me",
      kind: "CONTRIBUTION",
      originalAmount: "300.0000",
      groupAmount: "300.0000",
      instructionValue: "300",
    },
    {
      entryId: "entry",
      participantId: "me",
      kind: "SHARE",
      originalAmount: "100.0000",
      groupAmount: "100.0000",
      instructionValue: "100",
    },
  ],
});

describe("Private shared-expense projection (SE-003/004/006)", () => {
  it("keeps a 300 payment, 100 cost and 200 receivable distinct", () => {
    expect(personalEffect(entry(), "me")).toMatchObject({
      cash: "-300.0000",
      personal: "-100.0000",
      position: "200.0000",
    });
  });
  it("books a nonpayer's cost without inventing a bank movement", () => {
    const e = {
      ...entry(),
      allocations: entry().allocations.filter((a) => a.kind === "SHARE"),
    };
    expect(personalEffect(e, "me")).toMatchObject({
      cash: "0.0000",
      personal: "-100.0000",
      position: "-100.0000",
    });
  });
  it("reverses expenses on refund and treats received group income as a liability for others' shares", () => {
    for (const type of ["REFUND", "INCOME"] as const)
      expect(personalEffect(entry(type), "me")).toMatchObject({
        cash: "300.0000",
        personal: "100.0000",
        position: "-200.0000",
      });
  });
  it("reduces a receivable on repayment without adding income", () => {
    const e = {
      ...entry("REPAYMENT"),
      fromParticipantId: "anna",
      toParticipantId: "me",
      groupAmount: "100.0000",
      originalAmount: "100.0000",
      allocations: [],
    };
    expect(personalEffect(e, "me")).toMatchObject({
      cash: "100.0000",
      personal: "0.0000",
      position: "-100.0000",
    });
  });
  it("makes notes, names and another person's unchanged attribution irrelevant to private review", () => {
    const before = personalFingerprint(personalEffect(entry(), "me")!);
    const after = {
      ...entry(),
      title: "Renamed",
      note: "Receipt",
      revision: 2,
      financialRevision: 2,
      allocations: [
        ...entry().allocations,
        {
          ...entry().allocations[1],
          participantId: "ben",
          originalAmount: "200.0000",
          groupAmount: "200.0000",
        },
      ],
    };
    expect(personalFingerprint(personalEffect(after, "me")!)).toBe(before);
    expect(
      personalFingerprint(
        personalEffect({ ...after, date: "2026-01-02" }, "me")!,
      ),
    ).not.toBe(before);
  });
  it("keeps unknown drafts unbookable and a reversed entry known zero", () => {
    expect(
      personalEffect({ ...entry(), state: "DRAFT", groupAmount: null }, "me"),
    ).toBeNull();
    expect(
      personalEffect({ ...entry(), state: "REVERSED" }, "me"),
    ).toMatchObject({ cash: "0.0000", personal: "0.0000", position: "0.0000" });
  });
  it("preserves the imported 350 row and separates the private 50", () => {
    expect(sharedBankBreakdown("-350", "-300", "-300")).toMatchObject({
      bankTotal: "-350.0000",
      privateRemainder: "-50.0000",
      fxDifference: "0.0000",
    });
  });
  it("separates a bank's 440 debit from an agreed 430 and retains 4dp bank residues", () => {
    expect(sharedBankBreakdown("-440", "-440", "-430").fxDifference).toBe(
      "-10.0000",
    );
    expect(
      sharedBankBreakdown("-100.0001", "-100", "-100").privateRemainder,
    ).toBe("-0.0001");
  });
  it("refuses an allocation beyond the source and a mismatched direction", () => {
    expect(() => sharedBankBreakdown("-300", "-350", "-300")).toThrow();
    expect(() => sharedBankBreakdown("300", "-300", "-300")).toThrow();
  });
});
