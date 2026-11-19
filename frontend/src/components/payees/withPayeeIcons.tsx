import type { ReactNode } from 'react';
import { PayeeLogo, type PayeeLogoData } from '@/components/payees/PayeeLogo';

/** The mark a payee row carries in a picker: its favicon, else its initial. */
export function payeeOptionIcon(payee: PayeeLogoData): ReactNode {
  return <PayeeLogo payee={payee} size={20} />;
}

/**
 * `options` with each payee row carrying its picker icon, for an option list
 * built elsewhere that knows only ids and labels. A row whose value is not a
 * payee (a placeholder) is left without one.
 */
export function withPayeeIcons<T extends { value: string }>(
  options: readonly T[],
  payees: readonly PayeeLogoData[],
): (T & { icon?: ReactNode })[] {
  const byId = new Map(payees.map((payee) => [payee.id, payee]));
  return options.map((option) => {
    const payee = byId.get(option.value);
    return payee ? { ...option, icon: payeeOptionIcon(payee) } : option;
  });
}
