'use client';

import { useMemo, useState } from 'react';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { ParserCategoryFields } from '@/components/email-receipts/ParserCategoryFields';
import { ParserPatternFields, PatternArea } from '@/components/email-receipts/ParserPatternFields';
import { ParserProblems } from '@/components/email-receipts/ParserProblems';
import { ParserTestPanel } from '@/components/email-receipts/ParserTestPanel';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import type { ReceiptParserLookups, ReceiptParserLookupsState } from '@/hooks/useReceiptParserLookups';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import {
  buildParserDefinition,
  buildParserPayload,
  emptyParserForm,
  parseValidationProblems,
  parserToForm,
  type ParserFormChange,
  type ParserFormState,
} from '@/lib/receipt-parser-form';
import { RECEIPT_PARSER_LIMITS, type EmailReceiptParser } from '@/types/email-receipts';

interface ParserEditorDialogProps {
  /** The parser being edited; null writes a new one. */
  parser: EmailReceiptParser | null;
  /** Starting values for a new parser, such as the domain of the email it is for. */
  prefill?: Partial<ParserFormState>;
  /** A stored email the test panel starts on. */
  initialReceiptId?: string;
  lookups: ReceiptParserLookupsState;
  onReloadLookups: () => void;
  onClose: () => void;
  onSaved: (parser: EmailReceiptParser) => void;
  /** The parser moved on under the editor (a 409): the list is reloaded and the dialog closed. */
  onConflict: () => void;
}

/**
 * The dialog around the parser form. Mount it only while it is open: the form
 * state starts from the parser (or the prefill) each time, so there is no state
 * to reset when a different parser is opened. The pickers need the payee and
 * category lists, so the form itself waits for them; a failed read is an error
 * with a retry, never a form whose pickers would show a stored id as blank.
 */
export function ParserEditorDialog({
  parser,
  prefill,
  initialReceiptId,
  lookups,
  onReloadLookups,
  onClose,
  onSaved,
  onConflict,
}: ParserEditorDialogProps) {
  const t = useTranslations('emailReceipts.editor');

  let body;
  if (lookups.status === 'error') {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('lookupsError.title')}
          description={t('lookupsError.body')}
          action={<Button onClick={onReloadLookups}>{t('lookupsError.retry')}</Button>}
        />
      </div>
    );
  } else if (lookups.status === 'loading') {
    body = <LoadingSpinner text={t('loading')} />;
  } else {
    body = (
      <ParserEditorForm
        parser={parser}
        prefill={prefill}
        initialReceiptId={initialReceiptId}
        lookups={lookups.lookups}
        onClose={onClose}
        onSaved={onSaved}
        onConflict={onConflict}
      />
    );
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidth="3xl"
      padding="md"
      pushHistory
      title={parser ? t('editTitle') : t('createTitle')}
    >
      {body}
    </Modal>
  );
}

interface ParserEditorFormProps extends Pick<ParserEditorDialogProps, 'parser' | 'prefill' | 'initialReceiptId' | 'onClose' | 'onSaved' | 'onConflict'> {
  lookups: ReceiptParserLookups;
}

function ParserEditorForm({
  parser,
  prefill,
  initialReceiptId,
  lookups,
  onClose,
  onSaved,
  onConflict,
}: ParserEditorFormProps) {
  const t = useTranslations('emailReceipts.editor');
  const tc = useTranslations('common');
  const [form, setForm] = useState<ParserFormState>(() =>
    parser ? parserToForm(parser) : emptyParserForm(prefill),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; problems: ReturnType<typeof parseValidationProblems> } | null>(null);
  const [conflict, setConflict] = useState(false);

  const change: ParserFormChange = (changes) =>
    setForm((prev) => ({ ...prev, ...(typeof changes === 'function' ? changes(prev) : changes) }));

  const categoryLabels = useMemo(
    () => new Map(lookups.categories.map((option) => [option.value, option.label])),
    [lookups.categories],
  );
  const payees = useMemo(() => [...lookups.payees], [lookups.payees]);
  // What the test panel reads: the form as it is now, saved or not.
  const definition = useMemo(() => buildParserDefinition(form), [form]);

  const handleSave = async () => {
    const payload = buildParserPayload(form);
    setIsSaving(true);
    setSaveError(null);
    setConflict(false);
    try {
      const saved = parser
        ? await emailReceiptsApi.parsers.update(parser.id, { ...payload, expectedRevision: parser.revision })
        : await emailReceiptsApi.parsers.create(payload);
      toast.success(parser ? t('updated') : t('created'));
      onSaved(saved);
    } catch (error) {
      if (parser && error instanceof AxiosError && error.response?.status === 409) {
        setConflict(true);
      } else {
        const message = getErrorMessage(error, t('saveFailed'));
        setSaveError({ message, problems: parseValidationProblems(message) });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const canSave = form.name.trim() !== '' && form.fromDomains.trim() !== '' && !conflict;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave && !isSaving) void handleSave();
      }}
    >
      {parser?.status === 'draft' && (
        <p
          role="note"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          {parser.source === 'ai' ? t('draftAiNote') : t('draftNote')}
        </p>
      )}

      <section aria-label={t('identityHeading')} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            id="parser-name"
            label={t('nameLabel')}
            value={form.name}
            maxLength={RECEIPT_PARSER_LIMITS.maxNameLength}
            onChange={(e) => change({ name: e.target.value })}
          />
          <Combobox
            label={t('payeeLabel')}
            aria-label={t('payeeLabel')}
            placeholder={t('payeePlaceholder')}
            options={payees}
            value={form.payeeId}
            onChange={(value) => change({ payeeId: value })}
            valueIsId
            usePortal
            openOnFocus={false}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PatternArea
            id="parser-domains"
            label={t('domainsLabel')}
            hint={t('domainsHelp', { max: RECEIPT_PARSER_LIMITS.maxFromDomains })}
            value={form.fromDomains}
            rows={2}
            placeholder="shop.example.com"
            onChange={(fromDomains) => change({ fromDomains })}
          />
          <PatternArea
            id="parser-subject"
            label={t('subjectLabel')}
            hint={t('subjectHelp', { max: RECEIPT_PARSER_LIMITS.maxSubjectWords })}
            value={form.subjectContains}
            rows={2}
            onChange={(subjectContains) => change({ subjectContains })}
          />
        </div>
      </section>

      <ParserPatternFields form={form} onChange={change} />
      <ParserCategoryFields form={form} categories={lookups.categories} onChange={change} />

      <ParserTestPanel
        definition={definition}
        payeeId={form.payeeId}
        initialReceiptId={initialReceiptId}
        categoryLabels={categoryLabels}
      />

      {saveError &&
        (saveError.problems.length > 0 ? (
          <ParserProblems problems={saveError.problems} />
        ) : (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {saveError.message}
          </p>
        ))}

      {conflict && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-900/20">
          <p className="text-sm text-red-800 dark:text-red-200">{t('conflict')}</p>
          <div className="mt-2">
            <Button type="button" variant="outline" size="sm" onClick={onConflict}>
              {t('conflictReload')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-700">
        <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
          {tc('cancel')}
        </Button>
        <Button type="submit" isLoading={isSaving} disabled={!canSave}>
          {t('saveButton')}
        </Button>
      </div>
    </form>
  );
}
