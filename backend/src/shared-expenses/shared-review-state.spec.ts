import { sharedEntryFixture } from "./__fixtures__/shared-entry";
import { sharedPostingFixture } from "./__fixtures__/shared-finance";
import { sharedReviewState } from "./shared-review-state";

describe("Shared personal review state", () => {
  it("leaves a new expense optional even after another entry was accepted", () => {
    expect(sharedReviewState(sharedEntryFixture(), "me", null)).toMatchObject({
      needsReview: false,
      reviewReason: "NOT_BOOKED",
    });
    const missing = sharedEntryFixture({
      state: "DRAFT",
      draftReason: "MISSING_RATE",
    });
    expect(sharedReviewState(missing, "me", null).needsReview).toBe(false);
    expect(
      sharedReviewState(missing, "me", sharedPostingFixture()),
    ).toMatchObject({
      needsReview: true,
      reviewReason: "MISSING_RATE",
    });
  });
  it("identifies an optional unbooked personal effect but not somebody else's expense", () => {
    expect(
      sharedReviewState(sharedEntryFixture(), "me", null).reviewReason,
    ).toBe("NOT_BOOKED");
    expect(
      sharedReviewState(sharedEntryFixture(), "unrelated", null).needsReview,
    ).toBe(false);
  });
  it("does not ask again for the accepted input when only metadata or the revision changed", () => {
    expect(
      sharedReviewState(
        sharedEntryFixture({
          title: "New label",
          note: "Receipt added",
          revision: 5,
        }),
        "me",
        sharedPostingFixture(),
      ),
    ).toMatchObject({ needsReview: false, reviewReason: null });
  });
  it("asks before an amended share or a reversal can replace accepted personal rows", () => {
    const entry = sharedEntryFixture();
    const amended = {
      ...entry,
      allocations: entry.allocations.map((row) =>
        row.kind === "SHARE"
          ? { ...row, originalAmount: "150.0000", groupAmount: "150.0000" }
          : row,
      ),
    };
    expect(
      sharedReviewState(amended, "me", sharedPostingFixture()).reviewReason,
    ).toBe("CHANGED");
    expect(
      sharedReviewState(
        { ...entry, state: "REVERSED" },
        "me",
        sharedPostingFixture(),
      ).reviewReason,
    ).toBe("CHANGED");
    expect(
      sharedReviewState({ ...entry, state: "REVERSED" }, "me", null)
        .needsReview,
    ).toBe(false);
  });
  it("names a missing rate only for an affected participant; a future draft is not a current cost", () => {
    const missing = sharedEntryFixture({
      state: "DRAFT",
      draftReason: "MISSING_RATE",
      groupAmount: null,
      fxRate: null,
      fxSource: null,
      allocations: sharedEntryFixture().allocations.map((row) => ({
        ...row,
        groupAmount: null,
      })),
    });
    expect(sharedReviewState(missing, "me", null)).toEqual({
      effect: null,
      needsReview: false,
      reviewReason: "MISSING_RATE",
    });
    expect(sharedReviewState(missing, "unrelated", null).needsReview).toBe(
      false,
    );
    expect(
      sharedReviewState({ ...missing, draftReason: "FUTURE_DATE" }, "me", null)
        .needsReview,
    ).toBe(false);
    expect(
      sharedReviewState(
        { ...missing, draftReason: "FUTURE_DATE" },
        "me",
        sharedPostingFixture(),
      ).reviewReason,
    ).toBe("CHANGED");
  });
  it("includes repayments only for their sender and recipient", () => {
    const entry = sharedEntryFixture({
      type: "REPAYMENT",
      fromParticipantId: "me",
      toParticipantId: "anna",
      allocations: [],
    });
    expect(sharedReviewState(entry, "me", null).reviewReason).toBe(
      "NOT_BOOKED",
    );
    expect(sharedReviewState(entry, "anna", null).reviewReason).toBe(
      "NOT_BOOKED",
    );
    expect(sharedReviewState(entry, "ben", null).needsReview).toBe(false);
  });
});
