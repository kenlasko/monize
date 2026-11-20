import type {
  QuickAddField,
  QuickAddInterpretation,
  QuickAddPins,
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
 * The tier of one chip, exactly the plan's table. "Needs you" outranks every
 * source: a value missing (`none`), a value that matched several candidates
 * equally, or a payee the save would create.
 */
export function chipState(
  interpretation: QuickAddInterpretation,
  chip: QuickAddChipField,
): QuickAddChipState {
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
 */
export function mergePins(prev: QuickAddPins, patch: Partial<QuickAddPins>): QuickAddPins {
  const next: Record<string, unknown> = { ...prev, ...patch };
  for (const key of Object.keys(next)) {
    const value = next[key];
    if (value === undefined || value === null || value === '') delete next[key];
  }
  return next as QuickAddPins;
}

export function hasPins(pins: QuickAddPins): boolean {
  return Object.keys(pins).length > 0;
}
