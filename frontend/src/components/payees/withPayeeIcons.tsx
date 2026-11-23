import type { ReactNode } from 'react';
import { PayeeLogo, type PayeeLogoData } from '@/components/payees/PayeeLogo';

/** The mark a payee row carries in a picker: its favicon, else its initial. */
export function payeeOptionIcon(payee: PayeeLogoData): ReactNode {
  return <PayeeLogo payee={payee} size={20} />;
}

interface PayeePickerSource extends PayeeLogoData {
  defaultCategory?: { name: string } | null;
}

/**
 * The payee picker's option list: name, icon, and optionally the default
 * category as subtitle and the payee's aliases as search keywords. Callers
 * memoise it on `payees` and `aliases`, so a form re-render (an amount
 * keystroke) does not rebuild one option and one logo per payee.
 */
export function payeePickerOptions(
  payees: readonly PayeePickerSource[],
  { aliases, withCategory = false }: { aliases?: Record<string, string[]>; withCategory?: boolean } = {},
) {
  return payees.map((payee) => ({
    value: payee.id,
    label: payee.name,
    icon: payeeOptionIcon(payee),
    ...(withCategory ? { subtitle: payee.defaultCategory?.name } : {}),
    ...(aliases ? { keywords: aliases[payee.id] } : {}),
  }));
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
