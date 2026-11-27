import type { ClaimedLoanOccurrence } from "../loan-installments/claim-loan-occurrence";
import type { LoanSettlementPlan } from "../loan-installments/loan-settlement.types";
import type { ScheduleCursorChange } from "../scheduled-transactions/schedule-cursor";
import { RuleEffects } from "./rule-effects";
import { CandidateUnit } from "./rule-run-candidates";
import { RuleStructurePlan } from "./rule-structure";

/** A unit the rule changes, with what to write. */
export interface PlannedUnit {
  readonly unit: CandidateUnit;
  readonly effects: RuleEffects;
}

/** The fields of one row a run changes, in the shape the undo reads. */
export type RowSnapshot = Record<string, unknown> & { id: string };

/**
 * What the undo of a structural row needs: the kind and the counterpart legs
 * the write created (one for a transfer, one per transfer part of a split).
 * Before the write the ids are not known; the size check measures a row with
 * placeholders of the length a stored uuid has.
 */
export interface StructureSnapshot {
  readonly kind: "transfer" | "split";
  readonly counterpartIds: readonly string[];
  /** A split's lines the write created, in part order (absent for a transfer). */
  readonly lineIds?: readonly string[];
  /**
   * A settlement's claim (`docs/specs/loan-installment-settlement.md` section
   * 12.4): the claim the undo releases, the schedule and slot it was on,
   * whether it advanced the cursor and, when it did, the advance to rewind.
   * Absent on a transfer or a plain split.
   */
  readonly claimId?: string;
  readonly scheduledTransactionId?: string;
  readonly dueDate?: string;
  readonly cursorAdvanced?: boolean;
  readonly cursor?: ScheduleCursorChange;
}

const UUID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const DATE_PLACEHOLDER = "0000-00-00";

/**
 * The cursor record measured before the write: the shape the written one has,
 * with the dates and counts the row will hold. The overrides an advance prunes
 * are not known before it runs; the size is checked again on the written
 * snapshot, as it is for a created payee's id.
 */
function cursorPlaceholder(): ScheduleCursorChange {
  const state = {
    nextDueDate: DATE_PLACEHOLDER,
    occurrencesRemaining: null,
    isActive: true,
    lastPostedDate: DATE_PLACEHOLDER,
  };
  return { before: state, after: state, prunedOverrides: [] };
}

function structureSnapshot(
  structure: RuleStructurePlan,
  settlement: LoanSettlementPlan | undefined,
  claim: ClaimedLoanOccurrence | undefined,
): StructureSnapshot {
  const expected =
    structure.kind === "transfer"
      ? 1
      : structure.parts.filter((part) => part.transferAccountId !== null)
          .length;
  const placeholders = (count: number): string[] =>
    Array.from({ length: count }, () => UUID_PLACEHOLDER);
  return {
    kind: structure.kind,
    counterpartIds: structure.counterpartIds ?? placeholders(expected),
    ...(structure.kind === "split"
      ? { lineIds: structure.lineIds ?? placeholders(structure.parts.length) }
      : {}),
    ...(settlement !== undefined ? settlementSnapshot(settlement, claim) : {}),
  };
}

/** The claim part of a settled row's snapshot: the written claim, or placeholders of its shape before the write. */
function settlementSnapshot(
  settlement: LoanSettlementPlan,
  claim: ClaimedLoanOccurrence | undefined,
): Pick<
  StructureSnapshot,
  "claimId" | "scheduledTransactionId" | "dueDate" | "cursorAdvanced" | "cursor"
> {
  if (claim !== undefined) {
    return {
      claimId: claim.claimId,
      scheduledTransactionId: claim.scheduledTransactionId,
      dueDate: claim.dueDate,
      cursorAdvanced: claim.cursorAdvanced,
      ...(claim.cursor !== undefined ? { cursor: claim.cursor } : {}),
    };
  }
  return {
    claimId: UUID_PLACEHOLDER,
    scheduledTransactionId: settlement.scheduledTransactionId,
    dueDate: settlement.dueDate,
    cursorAdvanced: settlement.advancesCursor,
    ...(settlement.advancesCursor ? { cursor: cursorPlaceholder() } : {}),
  };
}

/**
 * What each written row held before and holds after, for the fields the plan
 * changes only: category, payee (with its name), description and the tag set.
 * The undo restores exactly these; redo replays the after side. `changes` must
 * already hold a created payee's id (`resolveCreatedPayee`), never the name
 * still to create. A same-owner transfer
 * contributes one entry per leg, because both legs are written.
 *
 * A structural row (a conversion or a split) also records `structure` and the
 * structural fields it had (`isTransfer`, `isSplit`, `linkedTransactionId`)
 * and its category on both sides, so the undo can delete the counterpart legs
 * and the split lines and put the row back. The after side repeats the shape
 * with what the run wrote. The `after` ids are the written ones, so call this
 * with the effects `writeEffects` returned. A settled row's structure also
 * records its claim and the cursor advance (`settlementClaim`), so the undo
 * can release the one and rewind the other.
 */
export function buildRunSnapshots(
  writable: readonly PlannedUnit[],
  tagsByRow: ReadonlyMap<string, readonly string[]>,
  payeeNames: Readonly<Record<string, string>>,
): { before: RowSnapshot[]; after: RowSnapshot[] } {
  const before: RowSnapshot[] = [];
  const after: RowSnapshot[] = [];
  for (const { unit, effects } of writable) {
    const { changes } = effects;
    for (const leg of unit.legs) {
      const was: RowSnapshot = { id: leg.id };
      const will: RowSnapshot = { id: leg.id };
      if (changes.categoryId !== undefined) {
        was.categoryId = leg.categoryId;
        will.categoryId = changes.categoryId;
      }
      if (changes.payeeId !== undefined) {
        was.payeeId = leg.payeeId;
        was.payeeName = leg.payeeName;
        will.payeeId = changes.payeeId;
        will.payeeName =
          changes.payeeId === null
            ? null
            : (changes.payeeName ?? payeeNames[changes.payeeId] ?? null);
      }
      if (changes.description !== undefined) {
        was.description = leg.description;
        will.description = changes.description;
      }
      if (changes.addTagIds.length + changes.removeTagIds.length > 0) {
        const current = tagsByRow.get(leg.id) ?? [];
        was.tagIds = [...current];
        will.tagIds = [
          ...current.filter((id) => !changes.removeTagIds.includes(id)),
          ...changes.addTagIds.filter((id) => !current.includes(id)),
        ];
      }
      if (changes.structure !== undefined) {
        const structure = structureSnapshot(
          changes.structure,
          changes.loanSettlement,
          changes.settlementClaim,
        );
        // The category is recorded whether or not a rule set one: a split or a
        // conversion that clears it must be able to put it back.
        was.categoryId = leg.categoryId;
        will.categoryId =
          changes.categoryId !== undefined
            ? changes.categoryId
            : changes.structure.kind === "split" ||
                changes.structure.clearCategory
              ? null
              : leg.categoryId;
        was.isTransfer = leg.isTransfer;
        was.isSplit = leg.isSplit;
        was.linkedTransactionId = leg.linkedTransactionId;
        will.isTransfer = changes.structure.kind === "transfer";
        will.isSplit = changes.structure.kind === "split";
        will.linkedTransactionId =
          changes.structure.kind === "transfer"
            ? (structure.counterpartIds[0] ?? null)
            : null;
        // Both sides carry the ids: the undo reads the before side.
        was.structure = structure;
        will.structure = structure;
      }
      // The other side of a transfer the category reached and the run did
      // not write as a leg of its own (a split's transfer line), recorded on
      // the leg whose write reached it so the undo returns it.
      if (leg === unit.primary && effects.categoryPartner) {
        was.categoryPartner = effects.categoryPartner.before;
        will.categoryPartner = effects.categoryPartner.after;
      }
      before.push(was);
      after.push(will);
    }
  }
  return { before, after };
}
