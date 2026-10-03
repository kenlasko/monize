'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmationCardShell } from '@/components/ai/ConfirmationCardShell';
import { RuleTestResult } from '@/components/ai/RuleTestResult';
import {
  RuleActionsInWords,
  RuleActiveWindowInWords,
  RuleConditionInWords,
  RuleInWords,
  RuleTriggersInWords,
  type RuleWordsLabels,
} from '@/components/rules/RuleInWords';
import { RuleRunSkippedList } from '@/components/rules/RuleRunPreviewTable';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { changedRuleParts, type RulePart } from '@/lib/rule-diff';
import type { PendingAction, PendingActionRule, PendingActionRuleState } from '@/types/ai';

interface RuleConfirmationCardProps {
  action: PendingAction;
  onConfirm: () => void;
  onCancel: () => void;
}

const HEADING_CLASS = 'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-gray-900 dark:text-gray-100 text-right break-words">{children}</span>
    </div>
  );
}

/** One side (was or now) of a changed part of a rule. */
function PartValue({ part, rule, labels }: { part: RulePart; rule: PendingActionRuleState; labels: RuleWordsLabels }) {
  const t = useTranslations('rules.editor');
  switch (part) {
    case 'name':
      return <p className="text-sm text-gray-900 dark:text-gray-100 break-words">{rule.name}</p>;
    case 'enabled':
      return <p className="text-sm text-gray-900 dark:text-gray-100">{rule.enabled ? t('value.yes') : t('value.no')}</p>;
    case 'stopProcessing':
      return (
        <p className="text-sm text-gray-900 dark:text-gray-100">
          {rule.stopProcessing ? t('value.yes') : t('value.no')}
        </p>
      );
    case 'activeWindow':
      return <RuleActiveWindowInWords activeFrom={rule.activeFrom} activeTo={rule.activeTo} />;
    case 'triggers':
      return <RuleTriggersInWords triggers={rule.triggers} labels={labels} />;
    case 'condition':
      return <RuleConditionInWords condition={rule.condition} labels={labels} />;
    case 'actions':
      return <RuleActionsInWords actions={rule.actions} labels={labels} />;
  }
}

/** What an edit changes: for each part that differs, the stored value and the new one. */
function RuleDiff({ rule, current }: { rule: PendingActionRule; current: PendingActionRuleState }) {
  const t = useTranslations('rules.editor');
  const tc = useTranslations('ai.confirmAction.rule');
  const parts = changedRuleParts(current, rule);
  const partLabel: Record<RulePart, string> = {
    name: t('name.label'),
    enabled: t('enabled.label'),
    triggers: t('sections.when'),
    condition: t('sections.if'),
    actions: t('sections.then'),
    stopProcessing: t('when.stopProcessing'),
    activeWindow: t('when.window.title'),
  };

  if (parts.length === 0) {
    return <p className="text-sm text-gray-900 dark:text-gray-100">{tc('noChanges')}</p>;
  }
  return (
    <div className="space-y-2" data-testid="rule-diff">
      <h4 className={HEADING_CLASS}>{tc('changesTitle')}</h4>
      {parts.map((part) => (
        <div key={part} className="space-y-1" data-testid={`rule-diff-${part}`}>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{partLabel[part]}</p>
          <div className="pl-3 space-y-1">
            <p className="text-xs text-gray-500 dark:text-gray-400">{tc('was')}</p>
            <PartValue part={part} rule={current} labels={rule.labels} />
            <p className="text-xs text-gray-500 dark:text-gray-400">{tc('now')}</p>
            <PartValue part={part} rule={rule} labels={rule.labels} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Which transactions a run looks at. */
function RunFilters({ rule }: { rule: PendingActionRule }) {
  const t = useTranslations('rules.run.filters');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const filters = rule.filters ?? {};
  const accountIds = filters.accountIds ?? [];
  const unknown = useTranslations('rules.run.change')('unknown');
  const accounts =
    accountIds.length === 0 ? t('allAccounts') : accountIds.map((id) => rule.labels.accounts[id] ?? unknown).join(', ');

  return (
    <div className="space-y-1" data-testid="rule-run-filters">
      <Row label={t('accounts')}>{accounts}</Row>
      {filters.startDate !== undefined && <Row label={t('startDate')}>{formatDate(filters.startDate)}</Row>}
      {filters.endDate !== undefined && <Row label={t('endDate')}>{formatDate(filters.endDate)}</Row>}
      {filters.limit !== undefined && <Row label={t('limit')}>{formatNumber(filters.limit, 0)}</Row>}
    </div>
  );
}

/**
 * Confirmation card for the four transaction-rule actions. The rule is read in
 * words from the structure the server signed and the names it resolved
 * (`preview.rule.labels`); no id reaches the screen. An update shows what
 * changes against the stored rule, a run shows the filters and the test result
 * the commit will be held to, and a confirmed run shows what it changed.
 */
export function RuleConfirmationCard({ action, onConfirm, onCancel }: RuleConfirmationCardProps) {
  const t = useTranslations('ai.confirmAction');
  const tr = useTranslations('rules.run');
  const te = useTranslations('rules.editor');
  const { type, preview } = action;
  const rule = preview.rule;

  const titles: Record<string, string> = {
    create_transaction_rule: t('createRuleTitle'),
    update_transaction_rule: t('updateRuleTitle'),
    delete_transaction_rule: t('deleteRuleTitle'),
    run_transaction_rule: t('runRuleTitle'),
  };
  const successes: Record<string, string> = {
    create_transaction_rule: t('createdRule'),
    update_transaction_rule: t('updatedRule'),
    delete_transaction_rule: t('deletedRule'),
    run_transaction_rule: t('ranRule'),
  };
  const ran = action.resultRuleRun;

  const confirmed = (
    <div className="space-y-1 text-sm" aria-live="polite">
      {type === 'run_transaction_rule' && ran ? (
        <>
          <p className="text-green-700 dark:text-green-400 font-medium">{tr('done.summary', { count: ran.changed })}</p>
          <RuleRunSkippedList skipped={ran.skipped} />
        </>
      ) : (
        <p className="text-green-700 dark:text-green-400 font-medium">{successes[type] ?? t('unknownDone')}</p>
      )}
      {type === 'run_transaction_rule' && <p className="text-gray-600 dark:text-gray-300">{tr('done.undo')}</p>}
      <Link href="/rules" className="text-blue-600 dark:text-blue-400 hover:underline">
        {t('viewRules')}
      </Link>
    </div>
  );

  return (
    <ConfirmationCardShell
      title={titles[type] ?? t('unknownTitle')}
      action={action}
      onConfirm={onConfirm}
      onCancel={onCancel}
      confirmed={confirmed}
    >
      {!rule ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">{t('rule.noPreview')}</p>
      ) : (
        <>
          <Row label={te('name.label')}>{rule.name}</Row>
          {type === 'create_transaction_rule' && (
            <Row label={te('enabled.label')}>{rule.enabled ? te('value.yes') : te('value.no')}</Row>
          )}
          {type === 'update_transaction_rule' && rule.current ? (
            <RuleDiff rule={rule} current={rule.current} />
          ) : (
            <RuleInWords rule={rule} labels={rule.labels} />
          )}
          {type === 'run_transaction_rule' && (
            <section className="space-y-1">
              <h4 className={HEADING_CLASS}>{t('rule.filtersTitle')}</h4>
              <RunFilters rule={rule} />
            </section>
          )}
          {rule.test && (
            <RuleTestResult
              test={rule.test}
              title={type === 'run_transaction_rule' ? t('rule.runPreviewTitle') : t('rule.testTitle')}
            />
          )}
          {type === 'run_transaction_rule' && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{tr('done.undo')}</p>
          )}
        </>
      )}
    </ConfirmationCardShell>
  );
}
