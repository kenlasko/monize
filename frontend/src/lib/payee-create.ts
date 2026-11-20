import { payeesApi } from './payees';
import type { Payee } from '@/types/payee';

/**
 * Turning a typed name into a payee happens in two places: the transaction
 * form's payee field ("Create", `TransactionForm`'s `handlePayeeCreate`) and
 * Quick Add's save of a line whose payee nobody has yet
 * (`docs/future-plans/quick-add.md`, "Leftover words"). Both ask first
 * whether an inactive payee holds the name, so the reader is offered that one
 * back rather than a second payee of the same name, which the server refuses.
 * What to do with an inactive match is the caller's: each asks the reader
 * through `ReactivatePayeeDialog`.
 *
 * It lives beside `payees.ts` rather than inside it, as `category-create.ts`
 * does beside `categories.ts`: that module is a typed axios wrapper, and suites
 * that replace `@/lib/payees` with a mock still run this against their mock.
 */
export type PayeeFromName =
  /** A deactivated payee already has the name; nothing was written. */
  | { kind: 'inactive'; payee: Payee }
  | { kind: 'created'; payee: Payee };

export interface CreatePayeeFromNameOptions {
  /**
   * The caller runs the contact lookup itself and asks the reader about what
   * it finds, so the server must not run its own background lookup too.
   */
  deferContactLookup?: boolean;
}

/** The payee `name` names, created when no inactive one does; null for a blank name. */
export async function createPayeeFromName(
  name: string,
  options: CreatePayeeFromNameOptions = {},
): Promise<PayeeFromName | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const inactive = await payeesApi.findInactiveByName(trimmed);
  if (inactive) return { kind: 'inactive', payee: inactive };
  const payee = await payeesApi.create({
    name: trimmed,
    ...(options.deferContactLookup ? { deferContactLookup: true } : {}),
  });
  return { kind: 'created', payee };
}
