'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { RuleActionCard } from '@/components/rules/RuleActionCard';
import type { RuleTreeEnv } from '@/components/rules/RuleConditionGroup';
import { RuleEditorBanners } from '@/components/rules/RuleEditorBanners';
import { RuleErrorList } from '@/components/rules/RuleCardShell';
import { RuleIfSection } from '@/components/rules/RuleIfSection';
import { RuleApplications } from '@/components/rules/RuleApplications';
import { RuleSection } from '@/components/rules/RuleSection';
import { RuleTestPanel, type RuleTestOutcome } from '@/components/rules/RuleTestPanel';
import { RunRuleDialog } from '@/components/rules/RunRuleDialog';
import { RuleWhenSection } from '@/components/rules/RuleWhenSection';
import { createTreeHandlers } from '@/components/rules/rule-tree-handlers';
import { useCardActions } from '@/components/rules/use-rule-card-actions';
import { useRuleErrorMessage } from '@/components/rules/use-rule-error-message';
import { useRuleExpression } from '@/components/rules/use-rule-expression';
import { useRuleOptions } from '@/components/rules/use-rule-options';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { RuleLookups } from '@/hooks/useRuleLookups';
import { getErrorMessage } from '@/lib/errors';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { createLogger } from '@/lib/logger';
import { EntityIndex, buildCatalog } from '@/lib/rule-cel';
import { scanCaptures } from '@/lib/rule-captures';
import {
  availableActionTypes,
  canAddAction,
  canDuplicateAction,
  canMoveAction,
  createAction,
  duplicateAction,
  moveAction,
  removeAction,
  updateAction,
  actionKey,
  isStructuralActionType,
} from '@/lib/rule-actions';
import { draftFromRule, draftSignature, draftToPayload, emptyDraft, type RuleDraft } from '@/lib/rule-draft';
import {
  ACTIONS_LIST_KEY,
  NAME_KEY,
  NO_ERRORS,
  draftGaps,
  isRevisionConflict,
  placeErrors,
  readRuleApiError,
  structuralFieldErrors,
  type PlacedErrors,
} from '@/lib/rule-errors';
import { MAX_RULE_ACTIONS, MAX_RULE_NAME_LENGTH } from '@/lib/rule-fields';
import { treeCapacity, type EditorGroup } from '@/lib/rule-tree';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { TransactionRule } from '@/types/transaction-rule';

const logger = createLogger('RuleEditor');

interface RuleEditorBodyProps {
  /** The stored rule being edited; null for a new one. */
  rule: TransactionRule | null;
  lookups: RuleLookups;
  /** An existing rule was saved; the parent adopts the answer. */
  onSaved: (rule: TransactionRule) => void;
  /** Fetch the rule again (after a revision conflict). */
  onReload: () => void;
}

/**
 * The editor proper: the draft, its four panels and the save. The draft is
 * local until Save; Save is the one write, and while it is in flight the whole
 * form is disabled so an answer can only ever describe the draft that was sent.
 *
 * Errors follow the draft: the ones a save brought back stay on their cards
 * until the next edit, because after an edit their paths may point elsewhere.
 */
export function RuleEditorBody({ rule, lookups, onSaved, onReload }: RuleEditorBodyProps) {
  const t = useTranslations('rules.editor');
  const tc = useTranslations('common');
  const tr = useTranslations('rules.run');
  const router = useRouter();
  const options = useRuleOptions(lookups);
  const cardActions = useCardActions();
  const errorMessage = useRuleErrorMessage();

  const [initial] = useState(() => (rule ? draftFromRule(rule) : { draft: emptyDraft(), repaired: 0 }));
  const [draft, setDraft] = useState<RuleDraft>(initial.draft);
  // The draft an existing rule was opened with; a new rule has none.
  const loadedDraft = rule ? initial.draft : null;
  // A repaired definition differs from what is stored, so it is always saveable.
  const [baseline] = useState(() => (initial.repaired > 0 ? null : draftSignature(initial.draft)));
  const [errors, setErrors] = useState<PlacedErrors>(() =>
    rule?.invalid ? placeErrors(rule.invalidReasons) : NO_ERRORS,
  );
  const [refused, setRefused] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  // The last finished Test, so Save can say that the rule matched nothing (it never blocks).
  const [testOutcome, setTestOutcome] = useState<RuleTestOutcome | null>(null);

  const dirty = baseline === null || draftSignature(draft) !== baseline;

  const edit = (fn: (current: RuleDraft) => RuleDraft) => {
    setDraft(fn);
    setErrors(NO_ERRORS);
    setRefused(false);
    setMessage(null);
  };
  const editCondition = (fn: (root: EditorGroup) => EditorGroup) =>
    edit((current) => ({ ...current, condition: fn(current.condition) }));

  const handlers = createTreeHandlers(editCondition);
  const index = useMemo(() => new EntityIndex(buildCatalog(lookups)), [lookups]);
  // The names the patterns of this rule capture: what a text action may use as `{name}`.
  const captures = useMemo(() => scanCaptures(draft.condition).names, [draft.condition]);
  const expression = useRuleExpression({
    condition: draft.condition,
    index,
    onCondition: (condition) => editCondition(() => condition),
  });
  // The expression view has no cards, so every condition error is listed under its box.
  const conditionCodes = [
    ...new Set(Object.entries(errors.byKey).flatMap(([key, codes]) => (key.startsWith('c:') ? codes : []))),
  ];

  const env: RuleTreeEnv = {
    root: draft.condition,
    options,
    errors: errors.byKey,
    capacity: treeCapacity(draft.condition),
    handlers,
  };

  const setActions = (fn: (actions: RuleDraft['actions']) => RuleDraft['actions']) =>
    edit((current) => ({ ...current, actions: fn(current.actions) }));

  const fail = (entries: Parameters<typeof placeErrors>[0], text: string | null) => {
    setErrors(placeErrors(entries));
    setRefused(entries.length > 0);
    setMessage(text);
  };

  const save = async () => {
    if (expression.error !== null) return;
    const gaps = draftGaps(draft, loadedDraft);
    if (gaps.length > 0) {
      fail(gaps, null);
      return;
    }
    setSaving(true);
    try {
      const payload = draftToPayload(draft, loadedDraft);
      if (rule) {
        const saved = await transactionRulesApi.update(rule.id, {
          ...payload,
          revision: rule.revision,
        });
        toast.success(t('save.savedToast'));
        onSaved(saved);
      } else {
        const saved = await transactionRulesApi.create(payload);
        toast.success(t('save.createdToast'));
        router.replace(`/rules/${saved.id}`);
      }
    } catch (error) {
      const api = readRuleApiError(error);
      if (isRevisionConflict(api)) {
        setConflict(true);
      } else if (api.entries.length > 0) {
        fail(api.entries, null);
      } else {
        fail([], getErrorMessage(error, t('save.failedToast')));
        logger.error(error);
      }
    } finally {
      setSaving(false);
    }
  };

  const nameErrors = errors.byKey[NAME_KEY] ?? [];
  const listErrors = errors.byKey[ACTIONS_LIST_KEY] ?? [];

  return (
    <div className="space-y-6">
      <RuleEditorBanners
        rule={rule}
        repaired={initial.repaired}
        conflict={conflict}
        onReload={onReload}
        refused={refused}
        unplaced={errors.unplaced}
        message={message}
      />
      <fieldset disabled={saving} aria-busy={saving} className="m-0 min-w-0 space-y-6 border-0 p-0">
        <Card padding="md">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Input
                id="rule-name"
                label={t('name.label')}
                value={draft.name}
                maxLength={MAX_RULE_NAME_LENGTH}
                placeholder={t('name.placeholder')}
                error={nameErrors[0] ? errorMessage(nameErrors[0]) : undefined}
                onChange={(e) => edit((current) => ({ ...current, name: e.target.value }))}
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <ToggleSwitch
                checked={draft.enabled}
                label={t('enabled.label')}
                onChange={(enabled) => edit((current) => ({ ...current, enabled }))}
              />
              <span className="text-sm text-gray-800 dark:text-gray-200">{t('enabled.label')}</span>
            </div>
          </div>
        </Card>

        <RuleWhenSection
          triggers={draft.triggers}
          stopProcessing={draft.stopProcessing}
          onTriggersChange={(triggers) => edit((current) => ({ ...current, triggers }))}
          onStopProcessingChange={(stopProcessing) => edit((current) => ({ ...current, stopProcessing }))}
          activeFrom={draft.activeFrom}
          activeTo={draft.activeTo}
          onActiveFromChange={(activeFrom) => edit((current) => ({ ...current, activeFrom }))}
          onActiveToChange={(activeTo) => edit((current) => ({ ...current, activeTo }))}
        />

        <RuleIfSection expression={expression} env={env} index={index} conditionCodes={conditionCodes} />

        <RuleSection
          title={t('sections.then')}
          description={t('then.description')}
          anchor={tourAnchor(TOUR_ANCHORS.ruleEditorThen)}
        >
          <div className="space-y-3">
            {draft.actions.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('then.empty')}</p>
            )}
            {draft.actions.map((action, index) => (
              <RuleActionCard
                key={action.uid}
                action={action}
                types={availableActionTypes(draft.actions, index)}
                options={options}
                captures={captures}
                errors={errors.byKey[actionKey(index)] ?? []}
                fieldErrors={isStructuralActionType(action.type) ? structuralFieldErrors(errors, index) : undefined}
                onChange={(next) => setActions((list) => updateAction(list, index, next))}
                actions={cardActions({
                  canDuplicate: canDuplicateAction(draft.actions, index),
                  canMoveUp: canMoveAction(draft.actions, index, -1),
                  canMoveDown: canMoveAction(draft.actions, index, 1),
                  onDuplicate: () => setActions((list) => duplicateAction(list, index)),
                  onMoveUp: () => setActions((list) => moveAction(list, index, -1)),
                  onMoveDown: () => setActions((list) => moveAction(list, index, 1)),
                  onDelete: () => setActions((list) => removeAction(list, index)),
                })}
              />
            ))}
            <RuleErrorList errors={listErrors} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canAddAction(draft.actions)}
              onClick={() => setActions((list) => [...list, createAction()])}
            >
              {t('action.add')}
            </Button>
            {!canAddAction(draft.actions) && (
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('then.limit', { max: MAX_RULE_ACTIONS })}</p>
            )}
          </div>
        </RuleSection>

        <RuleTestPanel
          draft={draft}
          accountOptions={options.accounts}
          blocked={expression.error !== null}
          loaded={loadedDraft}
          ruleId={rule?.id}
          onResult={setTestOutcome}
        />

        {rule && <RuleApplications ruleId={rule.id} options={options} />}

        {testOutcome &&
          !testOutcome.stale &&
          testOutcome.conditionMatched === 0 &&
          testOutcome.scanned > 0 && (
            <p role="status" className="text-sm text-amber-700 dark:text-amber-400 sm:text-right">
              {tr('matchesNone', { scanned: testOutcome.scanned })}
            </p>
          )}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
          {rule && (
            <div className="flex flex-col gap-1 sm:mr-auto">
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                disabled={saving || dirty}
                onClick={() => setRunOpen(true)}
              >
                {t('run.button')}
              </Button>
              {dirty && <p className="text-xs text-gray-500 dark:text-gray-400">{t('run.saveFirst')}</p>}
            </div>
          )}
          <Link href="/rules" className={buttonClassName('outline', 'md', 'w-full sm:w-auto')}>
            {tc('cancel')}
          </Link>
          <Button
            type="button"
            className="w-full sm:w-auto"
            isLoading={saving}
            disabled={saving || expression.error !== null || (rule !== null && !dirty)}
            onClick={() => void save()}
          >
            {t('save.button')}
          </Button>
        </div>
      </fieldset>
      <RunRuleDialog
        rule={runOpen && rule ? { id: rule.id, name: rule.name } : null}
        accountOptions={options.accounts}
        onClose={() => setRunOpen(false)}
      />
    </div>
  );
}
