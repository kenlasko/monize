'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import type { Account } from '@/types/account';
import type { Category } from '@/types/category';
import type { Payee } from '@/types/payee';
import type {
  QuickAddAccountRef,
  QuickAddCategoryRef,
  QuickAddInterpretation,
  QuickAddKind,
  QuickAddPayeeRef,
  QuickAddPins,
} from '@/types/quick-add';
import { QuickAddFieldControl, type QuickAddOnPin } from './QuickAddFieldControls';
import { fieldOf, type QuickAddChipField } from './quick-add-chips';

interface QuickAddFieldEditorProps {
  id: string;
  field: QuickAddChipField;
  fieldLabel: string;
  reading: QuickAddInterpretation;
  /** The reading is being replaced: its candidates are not offered meanwhile. */
  stale: boolean;
  accounts: Account[];
  payees: Payee[];
  categories: Category[];
  /** A value as its chip shows it, for the alternatives' buttons. */
  formatValue: (field: QuickAddChipField, value: unknown) => string;
  onPin: QuickAddOnPin;
  onClose: () => void;
}

/** The pin a value of `field` becomes. */
function pinFor(field: QuickAddChipField, value: unknown): Partial<QuickAddPins> {
  switch (field) {
    case 'kind':
      return { kind: value as QuickAddKind };
    case 'amount':
      return { amount: value as number };
    case 'date':
      return { date: value as string };
    case 'account':
      return { accountId: (value as QuickAddAccountRef).id };
    case 'toAccount':
      return { toAccountId: (value as QuickAddAccountRef).id };
    case 'category':
      return { categoryId: (value as QuickAddCategoryRef).id };
    case 'payee': {
      const payee = value as QuickAddPayeeRef;
      return payee.id
        ? { payeeId: payee.id, payeeName: undefined }
        : { payeeId: undefined, payeeName: payee.name };
    }
  }
}

/**
 * The control the full form uses for one chip's field, with the reading's
 * other candidates listed first as one-press picks. Whatever the reader sets
 * here is pinned: it is sent with every later request and never read from the
 * text again.
 */
export function QuickAddFieldEditor({
  id,
  field,
  fieldLabel,
  reading,
  stale,
  accounts,
  payees,
  categories,
  formatValue,
  onPin,
  onClose,
}: QuickAddFieldEditorProps) {
  const t = useTranslations('transactions');
  const controlRef = useRef<HTMLDivElement>(null);
  const alternatives = fieldOf(reading, field).alternatives;

  // An editor opened from its chip takes the focus, as a popover does.
  useEffect(() => {
    controlRef.current
      ?.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([tabindex="-1"]), select:not([tabindex="-1"]), button',
      )
      ?.focus();
  }, []);

  return (
    <div
      id={id}
      role="group"
      aria-label={fieldLabel}
      className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700"
      // Enter in a field of the editor applies that field; it never saves the entry.
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
        }
      }}
    >
      {alternatives.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            {t('quickAdd.editor.alternatives')}
          </p>
          <div className="flex flex-wrap gap-2">
            {alternatives.map((value, index) => (
              <Button
                key={index}
                type="button"
                size="sm"
                variant="outline"
                disabled={stale}
                onClick={() => onPin(pinFor(field, value), true)}
              >
                {formatValue(field, value)}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div ref={controlRef}>
        <QuickAddFieldControl
          id={`${id}-control`}
          field={field}
          fieldLabel={fieldLabel}
          reading={reading}
          accounts={accounts}
          payees={payees}
          categories={categories}
          onPin={onPin}
        />
      </div>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          {t('quickAdd.editor.done')}
        </Button>
      </div>
    </div>
  );
}
