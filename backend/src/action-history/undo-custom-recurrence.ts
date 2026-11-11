import { ConflictException } from "@nestjs/common";
import { normalizeCustomRecurrence } from "../common/custom-recurrence";
import { tr } from "../i18n/translate";

/**
 * A scheduled-transaction snapshot as an undo or redo writes it back: the
 * Custom frequency's pairing (docs/specs/custom-recurrence.md section 2) holds
 * on this write as on every other one. A `CUSTOM` snapshot keeps its rule in
 * canonical form; any other frequency writes `customRecurrence = null`, so an
 * undo that puts a fixed frequency back over a Custom row clears the rule the
 * row holds now. A `CUSTOM` snapshot whose rule is missing or invalid is
 * refused before anything is written: replaying it would store a schedule no
 * walker can step. A snapshot without a frequency (none is recorded that way)
 * is returned unchanged.
 */
export function withPairedScheduleRecurrence(
  snapshot: Record<string, any>,
): Record<string, any> {
  if (!("frequency" in snapshot)) return snapshot;
  if (snapshot.frequency !== "CUSTOM") {
    return { ...snapshot, customRecurrence: null };
  }
  const result = normalizeCustomRecurrence(snapshot.customRecurrence);
  if (!result.ok) {
    throw new ConflictException(
      tr(
        "errors.actionHistory.customRecurrenceMissing",
        "This change cannot be undone or redone: the scheduled transaction's custom schedule rule is missing from its history",
      ),
    );
  }
  return { ...snapshot, customRecurrence: result.rule };
}
