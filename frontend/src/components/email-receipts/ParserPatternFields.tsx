'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';
import type { ParserFormChange, ParserFormState } from '@/lib/receipt-parser-form';
import { RECEIPT_LINES_SOURCES, RECEIPT_PARSER_LIMITS, type ReceiptLinesSource } from '@/types/email-receipts';

interface PatternAreaProps {
  id: string;
  label: string;
  hint: string;
  value: string;
  rows?: number;
  placeholder?: string;
  /** What is wrong with the value: the box is outlined in red and the text is shown under it. */
  error?: string;
  /** Outline the box in red without a text of its own, when the problem is said beside it already. */
  invalid?: boolean;
  onChange: (value: string) => void;
}

/** A textarea holding one entry per line. Patterns and domains are code-like, so the face is monospaced. */
export function PatternArea({ id, label, hint, value, rows = 3, placeholder, error, invalid, onChange }: PatternAreaProps) {
  const errorId = `${id}-error`;
  const flagged = invalid === true || error !== undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={flagged || undefined}
        aria-describedby={error !== undefined ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          inputBaseClasses,
          'border px-3 py-2 font-mono text-sm',
          flagged && inputErrorClasses,
        )}
      />
      {error !== undefined && (
        <p id={errorId} className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
    </div>
  );
}

interface ParserPatternFieldsProps {
  form: ParserFormState;
  onChange: ParserFormChange;
}

/** Which rendering of the email the patterns read (text or HTML), with the rule-glob help under it: shared by both kinds of profile. */
export function ParserSourceField({ form, onChange }: ParserPatternFieldsProps) {
  const t = useTranslations('emailReceipts.editor.patterns');
  return (
    <>
      <div>
        <Select
          id="parser-source"
          label={t('sourceLabel')}
          value={form.source}
          onChange={(e) => onChange({ source: e.target.value as ReceiptLinesSource })}
          options={RECEIPT_LINES_SOURCES.map((source) => ({ value: source, label: t(`sourceOptions.${source}`) }))}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('sourceHint')}</p>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('globHelp', {
          star: '*',
          capture: '{name}',
          max: RECEIPT_PARSER_LIMITS.maxPatternsPerField,
          lineBreak: '\\n',
          example: 'Receipt from *\\n{amount}\\nPaid',
        })}
      </p>
    </>
  );
}

/**
 * The extraction patterns of a parser: what to read the order id and the
 * amounts from, and how to read the line items. Every pattern is a rule glob
 * matched against one whole line (`*` any text, `{name}` a capture; `\n`
 * joins the parts of a pattern over consecutive lines); the hint
 * under each box names the captures that field accepts, because the server
 * refuses any other.
 */
export function ParserPatternFields({ form, onChange }: ParserPatternFieldsProps) {
  const t = useTranslations('emailReceipts.editor.patterns');

  return (
    <div className="space-y-4">
      <ParserSourceField form={form} onChange={onChange} />

      <PatternArea
        id="parser-order-id"
        label={t('orderIdLabel')}
        hint={t('orderIdHint', { capture: '{orderid}' })}
        value={form.orderId}
        onChange={(orderId) => onChange({ orderId })}
      />
      <PatternArea
        id="parser-total"
        label={t('totalLabel')}
        hint={t('amountHint', { capture: '{amount}' })}
        value={form.total}
        onChange={(total) => onChange({ total })}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <PatternArea
          id="parser-shipping"
          label={t('shippingLabel')}
          hint={t('amountHint', { capture: '{amount}' })}
          value={form.shipping}
          rows={2}
          onChange={(shipping) => onChange({ shipping })}
        />
        <PatternArea
          id="parser-discount"
          label={t('discountLabel')}
          hint={t('amountHint', { capture: '{amount}' })}
          value={form.discount}
          rows={2}
          onChange={(discount) => onChange({ discount })}
        />
        <PatternArea
          id="parser-fees"
          label={t('feesLabel')}
          hint={t('amountHint', { capture: '{amount}' })}
          value={form.fees}
          rows={2}
          onChange={(fees) => onChange({ fees })}
        />
      </div>

      <div className="space-y-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('itemsHeading')}</h4>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Input
              id="parser-start-after"
              label={t('startAfterLabel')}
              value={form.startAfter}
              maxLength={RECEIPT_PARSER_LIMITS.maxSectionMarkerLength}
              onChange={(e) => onChange({ startAfter: e.target.value })}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('startAfterHint')}</p>
          </div>
          <div>
            <Input
              id="parser-stop-at"
              label={t('stopAtLabel')}
              value={form.stopAt}
              maxLength={RECEIPT_PARSER_LIMITS.maxSectionMarkerLength}
              onChange={(e) => onChange({ stopAt: e.target.value })}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('stopAtHint')}</p>
          </div>
        </div>
        <PatternArea
          id="parser-item-patterns"
          label={t('itemPatternsLabel')}
          hint={t('itemPatternsHint', {
            name: '{name}',
            amount: '{amount}',
            price: '{price}',
            qty: '{qty}',
          })}
          rows={4}
          value={form.itemPatterns}
          onChange={(itemPatterns) => onChange({ itemPatterns })}
        />
      </div>
    </div>
  );
}
