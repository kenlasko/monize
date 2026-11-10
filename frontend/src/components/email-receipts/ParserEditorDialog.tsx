'use client';

import { useMemo, useState } from 'react';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { ParserCategoryFields } from '@/components/email-receipts/ParserCategoryFields';
import { ParserMatchFields } from '@/components/email-receipts/ParserMatchFields';
import { ParserPatternFields, PatternArea } from '@/components/email-receipts/ParserPatternFields';
import { ParserProposalFields } from '@/components/email-receipts/ParserProposalFields';
import { ParserProblems } from '@/components/email-receipts/ParserProblems';
import { ParserTestPanel } from '@/components/email-receipts/ParserTestPanel';
import { ParserTradeFields } from '@/components/email-receipts/ParserTradeFields';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import type { ReceiptParserLookups, ReceiptParserLookupsState } from '@/hooks/useReceiptParserLookups';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import {
  buildParserDefinition,
  buildParserPayload,
  definitionToFormFields,
  emptyParserForm,
  formatDefinitionJson,
  formCanRepresent,
  isTradeDefinition,
  parseDefinitionJson,
  parseValidationProblems,
  parserToForm,
  type ParserFormChange,
  type ParserFormState,
  type ParserKind,
} from '@/lib/receipt-parser-form';
import { RECEIPT_PARSER_LIMITS, type EmailReceiptParser, type ReceiptParserDefinition } from '@/types/email-receipts';

type EditorMode = 'form' | 'json';

const PARSER_KINDS: readonly ParserKind[] = ['receipt', 'trade'];

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
  const tc = useTranslations('common');

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
      // 3xl (48rem) plus a quarter, for the profile's field rows.
      className="!max-w-[60rem]"
      padding="md"
      pushHistory
      title={parser ? t('editTitle') : t('createTitle')}
      footer={
        // The form draws its own Cancel; until it is there, this is the way out.
        lookups.status === 'ready' ? undefined : (
          <Button type="button" variant="outline" onClick={onClose}>
            {tc('cancel')}
          </Button>
        )
      }
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
  // A definition the form cannot show opens as JSON: the form would drop the rest.
  const [mode, setMode] = useState<EditorMode>(() => (parser && !formCanRepresent(parser.definition) ? 'json' : 'form'));
  const [jsonText, setJsonText] = useState(() =>
    formatDefinitionJson(
      parser && !formCanRepresent(parser.definition)
        ? parser.definition
        : buildParserDefinition(parser ? parserToForm(parser) : emptyParserForm(prefill)),
    ),
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
  const json = useMemo(() => parseDefinitionJson(jsonText), [jsonText]);
  // What the test panel reads and Save sends: the form or the JSON as it is now,
  // saved or not. The server's validator is the authority on the JSON's content.
  const definition = useMemo<ReceiptParserDefinition | null>(() => {
    if (mode === 'form') return buildParserDefinition(form);
    return json.ok ? (json.definition as unknown as ReceiptParserDefinition) : null;
  }, [mode, form, json]);
  // A trade profile in either mode: the JSON says so by its `trade` section.
  const isTrade = definition !== null ? isTradeDefinition(definition) : form.kind === 'trade';
  // The form can be shown only for JSON that parses into something it can hold.
  const formAvailable = mode === 'form' || (json.ok && formCanRepresent(json.definition));
  const modeNote = formAvailable ? null : json.ok ? t('mode.formUnavailable') : t('mode.jsonInvalid');

  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    if (next === 'json') {
      setJsonText(formatDefinitionJson(buildParserDefinition(form)));
    } else if (json.ok && formCanRepresent(json.definition)) {
      change(definitionToFormFields(json.definition));
    } else {
      return;
    }
    setMode(next);
  };

  const handleSave = async () => {
    if (definition === null) return;
    const payload = buildParserPayload(form, definition);
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

  const canSave = form.name.trim() !== '' && form.fromDomains.trim() !== '' && definition !== null && !conflict;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave && !isSaving) void handleSave();
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div role="group" aria-label={t('mode.label')} className={SEGMENTED_GROUP_CLASS}>
          <button
            type="button"
            aria-pressed={mode === 'form'}
            aria-describedby={modeNote ? 'parser-mode-note' : undefined}
            disabled={!formAvailable}
            onClick={() => switchMode('form')}
            className={`${segmentClass(mode === 'form')} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {t('mode.form')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'json'}
            onClick={() => switchMode('json')}
            className={segmentClass(mode === 'json')}
          >
            {t('mode.json')}
          </button>
        </div>
        {modeNote && (
          <p id="parser-mode-note" className="text-xs text-gray-500 dark:text-gray-400">
            {modeNote}
          </p>
        )}
      </div>

      {/* What a new profile reads; a stored one keeps the kind its definition has. */}
      {parser === null && mode === 'form' && (
        <div className="space-y-1">
          <div role="group" aria-label={t('kind.label')} className={SEGMENTED_GROUP_CLASS}>
            {PARSER_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={form.kind === kind}
                onClick={() => change({ kind })}
                className={segmentClass(form.kind === kind)}
              >
                {t(`kind.${kind}`)}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t(`kind.${form.kind}Help`)}</p>
        </div>
      )}

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
          {/* A trade books an investment transaction, which has no payee. */}
          {!isTrade && (
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
          )}
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

      {/* A profile for mail that is never wanted: it ignores or deletes what it matches instead of reading it. */}
      {mode === 'form' && (form.kind === 'receipt' || form.discard !== '') && (
        <div>
          <Select
            id="parser-discard"
            label={t('discard.label')}
            value={form.discard}
            onChange={(e) => change({ discard: e.target.value as ParserFormState['discard'] })}
            options={[
              { value: '', label: t('discard.read') },
              { value: 'ignore', label: t('discard.ignore') },
              { value: 'delete', label: t('discard.delete') },
            ]}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t(form.discard === '' ? 'discard.readHelp' : form.discard === 'ignore' ? 'discard.ignoreHelp' : 'discard.deleteHelp')}
          </p>
        </div>
      )}

      {mode === 'form' && form.discard !== '' ? (
        <p role="note" className="rounded-lg border border-gray-200 p-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
          {t('discard.noReading')}
        </p>
      ) : mode === 'form' && form.kind === 'trade' ? (
        <ParserTradeFields
          form={form}
          accounts={lookups.accounts}
          currencyCodes={lookups.currencyCodes}
          onChange={change}
        />
      ) : mode === 'form' ? (
        <>
          <ParserPatternFields form={form} onChange={change} />
          <ParserCategoryFields form={form} categories={lookups.categories} onChange={change} />
          <ParserMatchFields form={form} onChange={change} />
          <ParserProposalFields form={form} onChange={change} />
        </>
      ) : (
        <div className="space-y-2">
          <PatternArea
            id="parser-json"
            label={t('json.label')}
            hint={t('json.help')}
            value={jsonText}
            rows={18}
            onChange={setJsonText}
          />
          {!json.ok && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {t('json.parseError')}
            </p>
          )}
        </div>
      )}

      <ParserTestPanel
        definition={definition}
        payeeId={isTrade ? '' : form.payeeId}
        initialReceiptId={initialReceiptId}
        categoryLabels={categoryLabels}
        accounts={lookups.accounts}
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
