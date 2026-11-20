import { entryDecimalPlaces, withCurrencyCode } from '@/lib/format';
import {
  QUICK_ADD_CLEARABLE,
  type QuickAddClearable,
  type QuickAddField,
  type QuickAddInterpretation,
  type QuickAddPins,
} from '@/types/quick-add';

/** A field the reading shows as a chip the reader can change. */
export type QuickAddChipField =
  | 'kind'
  | 'amount'
  | 'date'
  | 'account'
  | 'toAccount'
  | 'payee'
  | 'category';

/**
 * How sure the reading is of a chip's value (`docs/future-plans/quick-add.md`,
 * "Chips"): typed or pinned by the reader, guessed from history, assumed by
 * default, or needing the reader.
 */
export type QuickAddTier = 'typed' | 'guessed' | 'assumed' | 'needs';

/** The short badge a "needs you" chip carries, and why. */
export type QuickAddNeed =
  | { kind: 'missing' }
  | { kind: 'matches'; count: number }
  | { kind: 'new' };

export interface QuickAddChipState {
  tier: QuickAddTier;
  need: QuickAddNeed | null;
}

/** The chips in the order the dialog draws them; transfers swap category for a to-account. */
export function chipFields(interpretation: QuickAddInterpretation): QuickAddChipField[] {
  const transfer = interpretation.kind.value === 'transfer';
  return transfer
    ? ['kind', 'amount', 'date', 'account', 'toAccount', 'payee']
    : ['kind', 'amount', 'date', 'account', 'payee', 'category'];
}

/** The reading's field behind a chip. */
export function fieldOf(
  interpretation: QuickAddInterpretation,
  chip: QuickAddChipField,
): QuickAddField<unknown> {
  return interpretation[chip] as QuickAddField<unknown>;
}

/**
 * Whether `chip` is a field the reader cleared by hand: the reading answers it
 * with no value, and the reader asked for that (`pins.clear`, or the server
 * marking the empty value as the reader's own). Only a payee or a category can
 * be cleared.
 */
export function isClearedChip(
  interpretation: QuickAddInterpretation,
  chip: QuickAddChipField,
  pins: QuickAddPins,
): boolean {
  if (chip !== 'payee' && chip !== 'category') return false;
  const field = fieldOf(interpretation, chip);
  return field.value === null && (field.source === 'pinned' || !!pins.clear?.includes(chip));
}

/**
 * The tier of one chip, exactly the plan's table. "Needs you" outranks every
 * source: a value missing (`none`), a value that matched several candidates
 * equally, or a payee the save would create. A field the reader cleared is
 * their own choice of none, so it is Typed.
 */
export function chipState(
  interpretation: QuickAddInterpretation,
  chip: QuickAddChipField,
  pins: QuickAddPins = {},
): QuickAddChipState {
  if (isClearedChip(interpretation, chip, pins)) return { tier: 'typed', need: null };
  const field = fieldOf(interpretation, chip);
  if (field.value === null || field.source === 'none') {
    return { tier: 'needs', need: { kind: 'missing' } };
  }
  if (field.ambiguous) {
    return { tier: 'needs', need: { kind: 'matches', count: field.alternatives.length + 1 } };
  }
  const newPayee = chip === 'payee' && (field.value as { id: string | null }).id === null;
  // A new payee the reader set by hand is theirs; the badge still says the
  // save creates it. Read from the words alone, it needs the reader.
  if (field.source === 'pinned') return { tier: 'typed', need: newPayee ? { kind: 'new' } : null };
  if (newPayee) return { tier: 'needs', need: { kind: 'new' } };
  if (field.source === 'typed') return { tier: 'typed', need: null };
  return { tier: field.source === 'inferred' ? 'guessed' : 'assumed', need: null };
}

/**
 * `prev` with `patch` applied and every unset pin removed, so the request
 * body never carries an empty pin the server would have to read as a value.
 *
 * `patch.clear` adds to the fields already cleared rather than replacing
 * them, and a field cleared carries no value pin. Setting a payee or a
 * category takes it off the cleared list again. The list goes in a fixed
 * order, so one set of choices is always one request.
 */
export function mergePins(prev: QuickAddPins, patch: Partial<QuickAddPins>): QuickAddPins {
  const cleared = new Set<QuickAddClearable>([...(prev.clear ?? []), ...(patch.clear ?? [])]);
  if (patch.payeeId || patch.payeeName) cleared.delete('payee');
  if (patch.categoryId) cleared.delete('category');
  const next: Record<string, unknown> = { ...prev, ...patch };
  if (cleared.has('payee')) {
    delete next.payeeId;
    delete next.payeeName;
  }
  if (cleared.has('category')) delete next.categoryId;
  next.clear = QUICK_ADD_CLEARABLE.filter((field) => cleared.has(field));
  for (const key of Object.keys(next)) {
    const value = next[key];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      delete next[key];
    }
  }
  return next as QuickAddPins;
}

/**
 * The pins without any id: what is left to hand on once the server refused a
 * pin (an account, payee or category gone since it was chosen), since which
 * one it refused is not said. The kind, amount, date and a typed payee name
 * name nothing that can be gone.
 */
export function pinsWithoutIds(pins: QuickAddPins): QuickAddPins {
  return mergePins(
    {},
    { kind: pins.kind, amount: pins.amount, date: pins.date, payeeName: pins.payeeName, clear: pins.clear },
  );
}

export function hasPins(pins: QuickAddPins): boolean {
  return Object.keys(pins).length > 0;
}

/** The formatters `quickAddFigure` draws with: `useNumberFormat()`'s. */
export interface QuickAddFigureFormat {
  formatCurrency: (value: number, currencyCode?: string) => string;
  formatNumber: (value: number, decimals?: number) => string;
  defaultCurrency: string;
}

/**
 * The reading's amount as the reader reads it, on the amount chip and the
 * palette's row. A figure typed in another currency reads in that currency,
 * with its code, since a shared symbol ($) would pass for the account's; when
 * the typed symbol names more than one currency it is a bare figure. It is
 * never drawn as an account-currency figure. Without an account the currency
 * is not known yet, so the figure carries no symbol rather than the reader's
 * default one.
 */
export function quickAddFigure(
  reading: QuickAddInterpretation,
  amount: number,
  { formatCurrency, formatNumber, defaultCurrency }: QuickAddFigureFormat,
): string {
  const accountCurrency = reading.account.value?.currencyCode;
  const foreign = reading.foreignAmount;
  if (foreign) {
    return foreign.currencyCode
      ? withCurrencyCode(
          formatCurrency(foreign.amount, foreign.currencyCode),
          foreign.currencyCode,
          accountCurrency ?? defaultCurrency,
        )
      : formatNumber(foreign.amount, entryDecimalPlaces(defaultCurrency));
  }
  return accountCurrency
    ? formatCurrency(amount, accountCurrency)
    : formatNumber(amount, entryDecimalPlaces(defaultCurrency));
}
