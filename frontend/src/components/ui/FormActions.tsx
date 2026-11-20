'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from './Button';
import { SplitSubmitButton, SubmitOption } from './SplitSubmitButton';
import { cn } from '@/lib/utils';

interface FormActionsProps {
  onCancel?: () => void;
  submitLabel?: string;
  isSubmitting?: boolean;
  submitDisabled?: boolean;
  className?: string;
  /**
   * Attributes (a `data-tour-id`) for the button pair itself. The row is
   * full-width, so anchoring a guided tour on it would ring the whole width of
   * the form; this wraps just the buttons, and only when asked.
   */
  anchorProps?: Record<string, string>;
  /**
   * Two or more behaviours the submit button can carry (e.g. save-and-close vs
   * save-and-enter-another). Supplied together with `selectedSubmitOptionId`,
   * `onSubmitOptionChange` and `submitOptionsLabel`, the submit button becomes
   * a `SplitSubmitButton` labelled with the selected option and `submitLabel`
   * is unused. Omitted -- the usual case -- the row keeps its single submit
   * button.
   */
  submitOptions?: readonly SubmitOption[];
  selectedSubmitOptionId?: string;
  onSubmitOptionChange?: (id: string) => void;
  /**
   * Accessible name for the chevron that opens the option list. Required
   * alongside `submitOptions`: it names the choice in the caller's own words
   * ("what happens after creating"), which the generic row cannot know, and
   * without it the chevron is an unlabelled control.
   */
  submitOptionsLabel?: string;
  /**
   * Buttons drawn between Cancel and the submit, such as Quick Add's Full
   * Form, a hand-off to a fuller form. Outline buttons: the submit stays the
   * row's one primary.
   */
  secondaryActions?: ReactNode;
}

/**
 * Standardized Cancel + Submit button row for form modals.
 */
export function FormActions({
  onCancel,
  submitLabel,
  isSubmitting = false,
  submitDisabled = false,
  className,
  anchorProps,
  submitOptions,
  selectedSubmitOptionId,
  onSubmitOptionChange,
  submitOptionsLabel,
  secondaryActions,
}: FormActionsProps) {
  const t = useTranslations('common');
  const resolvedSubmitLabel = submitLabel ?? t('formActions.save');
  const hasOptions =
    !!submitOptions &&
    submitOptions.length > 1 &&
    !!selectedSubmitOptionId &&
    !!onSubmitOptionChange &&
    !!submitOptionsLabel;
  const buttons = (
    <>
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          {t('formActions.cancel')}
        </Button>
      )}
      {secondaryActions}
      {hasOptions ? (
        <SplitSubmitButton
          options={submitOptions}
          selectedId={selectedSubmitOptionId}
          onSelect={onSubmitOptionChange}
          optionsLabel={submitOptionsLabel}
          isSubmitting={isSubmitting}
          disabled={submitDisabled}
        />
      ) : (
        <Button type="submit" isLoading={isSubmitting} disabled={submitDisabled || isSubmitting}>
          {resolvedSubmitLabel}
        </Button>
      )}
    </>
  );
  return (
    <div className={cn('flex justify-end space-x-3 pt-4', className)}>
      {anchorProps ? (
        <div className="flex space-x-3" {...anchorProps}>
          {buttons}
        </div>
      ) : (
        buttons
      )}
    </div>
  );
}
