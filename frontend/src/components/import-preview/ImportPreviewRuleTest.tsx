'use client';

import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useRuleChangeText } from '@/components/rules/use-rule-change-text';
import { useSkipReasonText } from '@/components/rules/RuleRunPreviewTable';
import type { ImportPreviewRuleInput } from '@/types/import-preview';
import type { ExplainedRule, RuleExplainLabels } from '@/types/transaction-rule-explain';
import {
  IMPORT_PREVIEW_HEADING_CLASS,
  IMPORT_PREVIEW_LINK_CLASS,
  IMPORT_PREVIEW_LINK_PROPS,
  ImportPreviewNewTabIcon,
} from './ImportPreviewPayeeMapping';
import { ImportPreviewRuleTestCondition } from './ImportPreviewRuleTestCondition';
import { useRuleTestStore } from './ImportPreviewRuleTestProvider';

/** The planner's reasons for leaving an action undone, in words: the run's reasons where they exist, this catalog's where not. */
function usePlannerSkipReason(): (reason: string) => string {
  const runReason = useSkipReasonText();
  const t = useTranslations('import.preview.ruleTest.skipReasons');
  return (reason) => {
    switch (reason) {
      case 'category_does_not_fit':
        return runReason('transfer_category_on_category_row');
      case 'row_has_splits':
        return runReason('split_category');
      case 'cross_owner_transfer_leg':
        return runReason('cross_owner_transfer_payee');
      case 'already_set':
      case 'no_change':
      case 'payee_unresolved':
        return t(reason);
      default:
        // `empty_render`, `payee_not_found` and a structural action's
        // `row_is_transfer_leg` are the run's own; anything newer reads as "cannot change it".
        return runReason(reason);
    }
  };
}

function RuleTestItem({
  rule,
  labels,
  afterStop,
}: {
  rule: ExplainedRule;
  labels: RuleExplainLabels;
  afterStop: boolean;
}) {
  const t = useTranslations('import.preview.ruleTest');
  const tRules = useTranslations('import.preview.rules');
  const tAction = useTranslations('rules.editor.actionTypes');
  const changeText = useRuleChangeText();
  const skipReason = usePlannerSkipReason();
  const actionName = (type: string) => (tAction.has(type) ? tAction(type) : type);

  const notRun = !rule.evaluated;
  const badge: { variant: BadgeVariant; label: string } = notRun
    ? { variant: 'amber', label: t('badge.notEvaluated') }
    : rule.matched
      ? { variant: 'green', label: t('badge.matched') }
      : { variant: 'gray', label: t('badge.notMatched') };
  const why = rule.skippedRule ? t(`notEvaluated.${rule.skippedRule}`) : afterStop ? t('notEvaluated.afterStop') : null;

  const changes = rule.effects
    ? changeText(rule.effects.changes, {
        category: (id) => labels.categories[id],
        payee: (id) => labels.payees[id],
        tag: (id) => labels.tags[id],
        account: (id) => labels.accounts[id],
      })
    : [];
  const notes = rule.effects
    ? [
        ...rule.effects.skipped.map((action) =>
          tRules('skipped', { action: actionName(action.type), reason: skipReason(action.reason) }),
        ),
        ...(rule.stopped ? [tRules('stopped')] : []),
      ]
    : [];

  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/rules/${rule.ruleId}`}
          {...IMPORT_PREVIEW_LINK_PROPS}
          aria-label={tRules('openNewTab', { name: rule.ruleName })}
          className={IMPORT_PREVIEW_LINK_CLASS}
        >
          {rule.ruleName}
          <ImportPreviewNewTabIcon />
        </Link>
        <Badge variant={badge.variant} size="sm">
          {badge.label}
        </Badge>
      </div>
      {why !== null && <p className="text-gray-500 dark:text-gray-400">{why}</p>}
      {rule.condition !== null && (
        <div className="pl-1">
          <ImportPreviewRuleTestCondition condition={rule.condition} labels={labels} />
        </div>
      )}
      {rule.evaluated && rule.matched && (
        <div className="pl-1">
          {changes.length === 0 && notes.length === 0 && rule.effects !== null ? (
            <p className="text-gray-500 dark:text-gray-400">
              {rule.effects.applied.length > 0
                ? tRules('applied', { actions: rule.effects.applied.map((action) => actionName(action.type)).join(', ') })
                : t('noChanges')}
            </p>
          ) : (
            <ul className="list-disc space-y-0.5 pl-5 text-gray-700 dark:text-gray-300">
              {changes.map((line) => (
                <li key={line}>{line}</li>
              ))}
              {notes.map((line) => (
                <li key={line} className="text-gray-500 dark:text-gray-400">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function RuleTestResult({ rules, labels }: { rules: readonly ExplainedRule[]; labels: RuleExplainLabels }) {
  const t = useTranslations('import.preview.ruleTest');
  const tRules = useTranslations('import.preview.rules');
  const [showOthers, setShowOthers] = useState(false);
  const othersId = useId();

  if (rules.length === 0) return <p className="text-gray-600 dark:text-gray-300">{t('noRules')}</p>;

  const stoppedAt = rules.findIndex((rule) => rule.stopped);
  const item = (rule: ExplainedRule) => (
    <RuleTestItem
      key={rule.ruleId}
      rule={rule}
      labels={labels}
      afterStop={!rule.evaluated && stoppedAt !== -1 && rules.indexOf(rule) > stoppedAt}
    />
  );
  const matched = rules.filter((rule) => rule.matched);
  const others = rules.filter((rule) => !rule.matched);

  return (
    <div className="space-y-2">
      {matched.length === 0 ? (
        <p className="text-gray-600 dark:text-gray-300">{tRules('none')}</p>
      ) : (
        <ul className="space-y-3">{matched.map(item)}</ul>
      )}
      {others.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            className={IMPORT_PREVIEW_LINK_CLASS}
            aria-expanded={showOthers}
            aria-controls={othersId}
            onClick={() => setShowOthers((open) => !open)}
          >
            {showOthers ? t('hideNotMatched', { count: others.length }) : t('showNotMatched', { count: others.length })}
          </button>
          {showOthers && (
            <ul id={othersId} className="space-y-3">
              {others.map(item)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The full rule test of one import preview row: every import rule in the order
 * it runs, whether it matched, each condition node with its answer and what this
 * transaction had, and what the rule would change. It is asked for as soon as
 * the row is expanded, once per row while the preview is open, and is the
 * server's own evaluation (`POST /transaction-rules/explain-row`) of the row's
 * `ruleInput`. A load that failed says so and offers a retry; it is never shown
 * as "no rules".
 */
export function ImportPreviewRuleTest({
  rowKey,
  ruleInput,
}: {
  rowKey: string;
  /** What the rules are planned over for the row; null for a row that has none to test. */
  ruleInput: ImportPreviewRuleInput | null;
}) {
  const t = useTranslations('import.preview.ruleTest');
  const tRules = useTranslations('import.preview.rules');
  const store = useRuleTestStore();
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.get(rowKey),
    () => undefined,
  );

  // A failed row is asked again when it is expanded again; a loaded row never is.
  useEffect(() => {
    if (ruleInput !== null) store.request(rowKey, ruleInput, { retry: true });
  }, [store, rowKey, ruleInput]);

  if (ruleInput === null) return null;
  // Before the effect has asked, the row is about to load.
  const current = state ?? { status: 'loading' as const };

  return (
    <section aria-label={tRules('heading')} aria-busy={current.status === 'loading'} className="space-y-1">
      <h4 className={IMPORT_PREVIEW_HEADING_CLASS}>{tRules('heading')}</h4>
      {current.status === 'loading' && (
        <div role="status">
          <LoadingSpinner size="sm" fullContainer={false} text={t('loading')} />
        </div>
      )}
      {current.status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-red-700 dark:text-red-300">
          <span>{t('error')}</span>
          <Button size="sm" variant="outline" onClick={() => store.request(rowKey, ruleInput, { retry: true })}>
            {t('retry')}
          </Button>
        </div>
      )}
      {current.status === 'ready' && (
        <RuleTestResult rules={current.explanation.rules} labels={current.explanation.labels} />
      )}
    </section>
  );
}
