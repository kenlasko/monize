/**
 * The payee of a Quick Add entry (`docs/future-plans/quick-add.md`, "Leftover
 * words"): resolved before the rest of the fill because its history fills
 * the account, the category and the kind.
 */
import type { QuickAddReading } from "./quick-add-parse.util";
import type { QuickAddPayeeRef } from "./quick-add.types";
import {
  QUICK_ADD_PAYEE_NAME_MAX_LENGTH,
  QuickAddPayeeResolution,
  QuickAddPins,
  QuickAddUsage,
  clearedField,
  field,
  payeeRef,
  rankByUsage,
  withoutIds,
} from "./quick-add-fill-shared.util";

/** Leftover words cut at a word boundary to `max` characters, the rest returned. */
function splitAtWord(words: string, max: number): [string, string | null] {
  if (words.length <= max) return [words, null];
  const parts = words.split(" ");
  const kept: string[] = [];
  for (const part of parts) {
    if ([...kept, part].join(" ").length > max) break;
    kept.push(part);
  }
  const head = kept.length > 0 ? kept.join(" ") : words.slice(0, max);
  const rest = words.slice(head.length).trim();
  return [head, rest === "" ? null : rest];
}

/**
 * The memo beside a payee the reader pinned (or cleared): the words that
 * produced the text's own payee are replaced by the pin, so they are not the
 * memo. A payee read from the text already left them out of the leftover;
 * without one, the leftover was the new payee's name, and only what did not
 * fit in a name is left.
 */
function memoBesidePinnedPayee(reading: QuickAddReading): string | null {
  if (reading.payee || !reading.leftover) return reading.leftover;
  return splitAtWord(reading.leftover, QUICK_ADD_PAYEE_NAME_MAX_LENGTH)[1];
}

/**
 * The payee: pinned, else cleared, else typed (a whole name or alias), else
 * inferred (a typed word starting payee names, ranked by use; a tie is
 * ambiguous), else the leftover words as a new payee. With a payee, the
 * leftover is the memo.
 */
export function resolveQuickAddPayee(
  reading: QuickAddReading,
  pins: QuickAddPins,
  usage: QuickAddUsage,
): QuickAddPayeeResolution {
  const collisions = rankByUsage(reading.payeeAlternatives, usage);
  if (pins.payee) {
    return {
      field: field(payeeRef(pins.payee), "pinned"),
      payee: pins.payee,
      memo: memoBesidePinnedPayee(reading),
    };
  }
  if (pins.payeeName) {
    return {
      field: field({ id: null, name: pins.payeeName }, "pinned"),
      payee: null,
      memo: memoBesidePinnedPayee(reading),
    };
  }
  if (pins.clearPayee) {
    return {
      field: clearedField<QuickAddPayeeRef>(),
      payee: null,
      memo: memoBesidePinnedPayee(reading),
    };
  }
  if (reading.payee) {
    const ranked = rankByUsage(reading.payee.candidates, usage);
    const top = ranked[0];
    const tie =
      ranked.length > 1 &&
      (usage.get(ranked[1].id) ?? 0) === (usage.get(top.id) ?? 0);
    const ambiguous = reading.payee.partial ? tie : ranked.length > 1;
    const alternatives = withoutIds(
      [...ranked.slice(1), ...collisions],
      [top.id],
    );
    return {
      field: field(
        payeeRef(top),
        reading.payee.partial ? "inferred" : "typed",
        alternatives.map(payeeRef),
        ambiguous,
      ),
      payee: top,
      memo: reading.leftover,
    };
  }
  if (reading.leftover) {
    const [name, memo] = splitAtWord(
      reading.leftover,
      QUICK_ADD_PAYEE_NAME_MAX_LENGTH,
    );
    return {
      field: field({ id: null, name }, "typed", collisions.map(payeeRef)),
      payee: null,
      memo,
    };
  }
  return {
    field: field<QuickAddPayeeRef>(null, "none", collisions.map(payeeRef)),
    payee: null,
    memo: null,
  };
}
