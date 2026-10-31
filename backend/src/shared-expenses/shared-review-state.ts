import type { SharedJournalEntry } from "./shared-journal";
import type { SharedPosting } from "./shared-finance-types";
import { personalEffect, personalFingerprint } from "./shared-projection";
import { fixedUnits } from "./shared-money";

export type SharedReviewReason = "CHANGED" | "NOT_BOOKED" | "MISSING_RATE";

/** The same participant-specific comparison drives group and report disclosures. */
export function sharedReviewState(
  entry: SharedJournalEntry,
  participantId: string,
  posting: SharedPosting | null,
) {
  const effect = personalEffect(entry, participantId);
  const affected =
    entry.fromParticipantId === participantId ||
    entry.toParticipantId === participantId ||
    entry.allocations.some(
      (row) =>
        row.participantId === participantId &&
        fixedUnits(row.originalAmount, 4) !== 0n,
    );
  const reviewReason: SharedReviewReason | null =
    entry.draftReason === "MISSING_RATE" && (affected || posting)
      ? "MISSING_RATE"
      : posting
        ? !effect || personalFingerprint(effect) !== posting.fingerprint
          ? "CHANGED"
          : null
        : effect !== null &&
            (effect.originalCash !== "0.0000" || effect.personal !== "0.0000")
          ? "NOT_BOOKED"
          : null;
  // Connecting a group does not opt its owner into every entry. Review protects
  // accepted private postings; an unbooked entry remains an optional addition.
  return {
    effect,
    reviewReason,
    needsReview: posting !== null && reviewReason !== null,
  };
}
