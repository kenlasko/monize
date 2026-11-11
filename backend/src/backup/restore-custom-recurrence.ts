import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { normalizeCustomRecurrence } from "../common/custom-recurrence";

/**
 * The Custom frequency's pairing on a restored `scheduled_transactions` row
 * (docs/specs/custom-recurrence.md section 2): a restore inserts rows as the
 * file stores them, past the service that enforces it on every other write.
 * A `CUSTOM` row needs a rule the stepper can walk, or every surface that
 * expands the schedule throws; any other row stores none. An artifact written
 * before the column existed has no key, which reads as no rule.
 */

function invalidSchedule(): never {
  throw new BadRequestException(
    tr(
      "errors.backup.invalidCustomRecurrence",
      "Invalid backup scheduled transaction: a custom frequency needs a valid recurrence rule",
    ),
  );
}

/** Refuse an unwalkable Custom schedule before authentication, staging or destructive SQL. */
export function validateRestoredSchedules(rows: unknown): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const fields = row as Record<string, unknown>;
    if (
      fields.frequency === "CUSTOM" &&
      !normalizeCustomRecurrence(fields.custom_recurrence).ok
    ) {
      invalidSchedule();
    }
  }
}

/** The row with its rule canonical while Custom and cleared otherwise. */
export function withPairedCustomRecurrence(
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (row.frequency !== "CUSTOM") {
    return "custom_recurrence" in row
      ? { ...row, custom_recurrence: null }
      : row;
  }
  const result = normalizeCustomRecurrence(row.custom_recurrence);
  if (!result.ok) invalidSchedule();
  return { ...row, custom_recurrence: result.rule };
}
