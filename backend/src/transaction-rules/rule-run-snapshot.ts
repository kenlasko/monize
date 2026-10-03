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
}

const UUID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

function structureSnapshot(structure: RuleStructurePlan): StructureSnapshot {
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
 * with the effects `writeEffects` returned.
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
        const structure = structureSnapshot(changes.structure);
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
      before.push(was);
      after.push(will);
    }
  }
  return { before, after };
}
