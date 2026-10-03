'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RuleActionGuide } from '@/components/rules/RuleActionGuide';
import { RuleCardShell } from '@/components/rules/RuleCardShell';
import { ConvertToTransferFields, SplitFields } from '@/components/rules/RuleStructuralActions';
import { RuleSwitchRow as SwitchRow } from '@/components/rules/RuleSwitchRow';
import { RuleTemplateInput } from '@/components/rules/RuleTemplateInput';
import type { RuleOptions } from '@/components/rules/use-rule-options';
import { Combobox } from '@/components/ui/Combobox';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { Select } from '@/components/ui/Select';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import {
  DESCRIPTION_MODES,
  changeActionType,
  isDescriptionMode,
  isEditableActionType,
  isStructuralActionType,
  type EditableActionType,
  type EditorAction,
} from '@/lib/rule-actions';
import { checkTemplate } from '@/lib/rule-captures';
import type { StructuralFieldErrors } from '@/lib/rule-errors';
import {
  MAX_RULE_AI_INSTRUCTION_LENGTH,
  MAX_RULE_DESCRIPTION_TEMPLATE_LENGTH,
  MAX_RULE_PAYEE_TEMPLATE_LENGTH,
} from '@/lib/rule-fields';
import { cn, inputBaseClasses } from '@/lib/utils';

interface RuleActionCardProps {
  action: EditorAction;
  /** The types this card may be set to (`availableActionTypes`). */
  types: readonly EditableActionType[];
  options: RuleOptions;
  actions: RowAction[];
  errors: readonly string[];
  onChange: (action: EditorAction) => void;
  /** The capture names the rule's patterns define; the text actions offer them as placeholders, a split as its amounts. */
  captures?: readonly string[];
  /**
   * For a transfer or a split: the server's errors split into the card's own
   * list and the field each names (`structuralFieldErrors`). Without it every
   * error in `errors` is the card's own.
   */
  fieldErrors?: StructuralFieldErrors;
}

/** The "Only if empty" switch of the actions that fill a field, with its explanation. */
function OnlyIfEmpty({
  checked,
  onChange,
  help,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The explanation; the default one is about the category and the payee. */
  help?: string;
}) {
  const t = useTranslations('rules.editor.action');
  return <SwitchRow checked={checked} onChange={onChange} label={t('onlyIfEmpty')} help={help ?? t('onlyIfEmptyHelp')} />;
}

/**
 * The codes of a text action's own inline message (`RuleTemplateInput`), so the
 * card's error list does not say the same thing twice.
 */
function inlineCodes(action: EditorAction, captures: readonly string[]): string[] {
  if (action.type !== 'set_payee_from_text' && action.type !== 'set_description') return [];
  const { malformed, unknown } = checkTemplate(action.template, captures);
  return [...(malformed.length > 0 ? ['INVALID_CAPTURE'] : []), ...(unknown.length > 0 ? ['UNKNOWN_CAPTURE'] : [])];
}

const NO_FIELDS: StructuralFieldErrors['fields'] = {};

function ActionParameters({
  action,
  options,
  onChange,
  captures,
  fields,
}: Pick<RuleActionCardProps, 'action' | 'options' | 'onChange'> & {
  captures: readonly string[];
  fields: StructuralFieldErrors['fields'];
}) {
  const t = useTranslations('rules.editor');

  switch (action.type) {
    case 'add_tags':
    case 'remove_tags':
      return (
        <MultiSelect
          label={t('action.tags')}
          options={options.tags}
          value={[...action.tagIds]}
          onChange={(tagIds) => onChange({ ...action, tagIds })}
          placeholder={t('value.tags')}
        />
      );
    case 'set_category':
      return (
        <div>
          <Combobox
            label={t('action.category')}
            placeholder={t('value.category')}
            options={options.categories}
            value={action.categoryId}
            onChange={(categoryId) => onChange({ ...action, categoryId })}
            valueIsId
            usePortal
          />
          <OnlyIfEmpty checked={action.onlyIfEmpty} onChange={(onlyIfEmpty) => onChange({ ...action, onlyIfEmpty })} />
        </div>
      );
    case 'set_payee':
      return (
        <div>
          <Combobox
            label={t('action.payee')}
            placeholder={t('value.payee')}
            options={options.payees}
            value={action.payeeId}
            onChange={(payeeId) => onChange({ ...action, payeeId })}
            valueIsId
            usePortal
          />
          <OnlyIfEmpty checked={action.onlyIfEmpty} onChange={(onlyIfEmpty) => onChange({ ...action, onlyIfEmpty })} />
        </div>
      );
    case 'set_payee_from_text':
      return (
        <div className="space-y-2">
          <RuleTemplateInput
            id={`${action.uid}-template`}
            label={t('action.payeeTemplate')}
            value={action.template}
            maxLength={MAX_RULE_PAYEE_TEMPLATE_LENGTH}
            captures={captures}
            help={t('action.templateHelp')}
            onChange={(template) => onChange({ ...action, template })}
          />
          <div>
            <SwitchRow
              checked={action.createIfMissing}
              onChange={(createIfMissing) => onChange({ ...action, createIfMissing })}
              label={t('action.createIfMissing')}
              help={t('action.createIfMissingHelp')}
            />
            <OnlyIfEmpty checked={action.onlyIfEmpty} onChange={(onlyIfEmpty) => onChange({ ...action, onlyIfEmpty })} />
          </div>
        </div>
      );
    case 'set_description':
      return (
        <div className="space-y-2">
          <Select
            id={`${action.uid}-mode`}
            label={t('action.mode')}
            value={action.mode}
            options={DESCRIPTION_MODES.map((mode) => ({ value: mode, label: t(`action.modes.${mode}`) }))}
            onChange={(e) => {
              if (isDescriptionMode(e.target.value)) onChange({ ...action, mode: e.target.value });
            }}
          />
          <RuleTemplateInput
            id={`${action.uid}-template`}
            label={t('action.descriptionTemplate')}
            value={action.template}
            maxLength={MAX_RULE_DESCRIPTION_TEMPLATE_LENGTH}
            captures={captures}
            help={t('action.templateHelp')}
            note={action.mode === 'replace' ? undefined : t('action.joinHelp')}
            onChange={(template) => onChange({ ...action, template })}
          />
          <OnlyIfEmpty
            checked={action.onlyIfEmpty}
            onChange={(onlyIfEmpty) => onChange({ ...action, onlyIfEmpty })}
            help={t('action.onlyIfEmptyDescriptionHelp')}
          />
        </div>
      );
    case 'convert_to_transfer':
      return <ConvertToTransferFields action={action} options={options} onChange={onChange} fields={fields} />;
    case 'split':
      return <SplitFields action={action} options={options} captures={captures} onChange={onChange} fields={fields} />;
    case 'request_ai_review':
      return (
        <div>
          <label htmlFor={`${action.uid}-instruction`} className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('action.instruction')}
          </label>
          <textarea
            id={`${action.uid}-instruction`}
            rows={2}
            maxLength={MAX_RULE_AI_INSTRUCTION_LENGTH}
            value={action.instruction}
            placeholder={t('action.instructionPlaceholder')}
            onChange={(e) => onChange({ ...action, instruction: e.target.value })}
            className={cn(inputBaseClasses, 'border px-3 py-2 font-sans focus-visible:ring-1 focus-visible:outline-none')}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('action.instructionHelp')}</p>
          <Link href="/ai-reviews" className="mt-1 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400">
            {t('action.reviewInbox')}
          </Link>
        </div>
      );
  }
}

/**
 * One action: its type, and the parameters that type takes. Changing the type
 * starts the parameters over (the card keeps its place). The type list leaves
 * out `request_ai_review` when another card already holds it, and the two
 * structural actions when another card holds either, because the server
 * allows one of each kind per rule.
 */
export function RuleActionCard({
  action,
  types,
  options,
  actions,
  errors,
  onChange,
  captures = [],
  fieldErrors,
}: RuleActionCardProps) {
  const t = useTranslations('rules.editor');
  const shownInline = inlineCodes(action, captures);
  // A transfer or a split shows each error at its field; the card keeps only what names no field.
  const structural = isStructuralActionType(action.type) && fieldErrors !== undefined;
  const cardErrors = structural ? fieldErrors.shell : errors.filter((code) => !shownInline.includes(code));

  return (
    <RuleCardShell label={t('action.title')} actions={actions} errors={cardErrors}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="space-y-3">
          <Select
            id={`${action.uid}-type`}
            label={t('action.type')}
            value={action.type}
            options={types.map((type) => ({ value: type, label: t(`actionTypes.${type}`) }))}
            onChange={(e) => {
              if (isEditableActionType(e.target.value)) onChange(changeActionType(action, e.target.value));
            }}
          />
          <RuleActionGuide type={action.type} />
        </div>
        <ActionParameters
          action={action}
          options={options}
          onChange={onChange}
          captures={captures}
          fields={structural ? fieldErrors.fields : NO_FIELDS}
        />
      </div>
    </RuleCardShell>
  );
}
