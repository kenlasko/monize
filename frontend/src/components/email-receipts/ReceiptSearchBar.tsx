'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/DateInput';
import { Input } from '@/components/ui/Input';
import { LabelSpacer } from '@/components/ui/LabelSpacer';
import { Select } from '@/components/ui/Select';
import { isReceiptSearchField, type ReceiptSearchInput } from '@/lib/receipt-search';
import { EMAIL_RECEIPT_SEARCH_FIELDS, EMAIL_RECEIPT_SEARCH_MAX_LENGTH } from '@/types/email-receipts';

interface ReceiptSearchBarProps {
  input: ReceiptSearchInput;
  onChange: (patch: Partial<ReceiptSearchInput>) => void;
  onClear: () => void;
  /** Whether anything is typed or chosen: the clear button is offered only then. */
  canClear: boolean;
  /** The end date is before the start date: the range is not applied, and the field says so. */
  rangeBackwards: boolean;
}

/**
 * The receipts list's search: free text over the subject, the sender or the
 * content, and a date range on the date the list shows. First in the toolbar,
 * the text field unlabelled (its placeholder names what is searched) and
 * applied as the person types. A controlled view; the text's delay and the URL
 * are `useReceiptSearch`'s.
 */
export function ReceiptSearchBar({ input, onChange, onClear, canClear, rangeBackwards }: ReceiptSearchBarProps) {
  const t = useTranslations('emailReceipts.receipts.search');

  return (
    <div role="search" aria-label={t('label')} className="flex flex-wrap items-start gap-x-3 gap-y-3">
      {/* No label above the search: the placeholder says what is searched. The spacer only lines it up with the labelled fields beside it. */}
      <div className="flex w-full flex-col sm:w-96">
        <div className="hidden sm:block">
          <LabelSpacer />
        </div>
        <Input
          id="receipt-search-text"
          type="search"
          aria-label={t('placeholder')}
          placeholder={t('placeholder')}
          value={input.text}
          maxLength={EMAIL_RECEIPT_SEARCH_MAX_LENGTH}
          autoComplete="off"
          onChange={(event) => onChange({ text: event.target.value })}
        />
      </div>
      <div className="w-full sm:w-44">
        <Select
          id="receipt-search-in"
          label={t('in')}
          value={input.searchIn}
          options={EMAIL_RECEIPT_SEARCH_FIELDS.map((field) => ({ value: field, label: t(`fields.${field}`) }))}
          onChange={(event) => {
            if (isReceiptSearchField(event.target.value)) onChange({ searchIn: event.target.value });
          }}
        />
      </div>
      <div className="w-full sm:w-48">
        <DateInput
          id="receipt-search-from"
          label={t('from')}
          value={input.dateFrom}
          onDateChange={(dateFrom) => onChange({ dateFrom })}
        />
      </div>
      <div className="w-full sm:w-48">
        <DateInput
          id="receipt-search-to"
          label={t('to')}
          value={input.dateTo}
          error={rangeBackwards ? t('rangeBackwards') : undefined}
          onDateChange={(dateTo) => onChange({ dateTo })}
        />
      </div>
      {canClear && (
        <div className="flex w-full flex-col sm:w-auto">
          <div className="hidden sm:block">
            <LabelSpacer />
          </div>
          <Button variant="outline" onClick={onClear} className="w-full sm:w-auto">
            {t('clear')}
          </Button>
        </div>
      )}
    </div>
  );
}
