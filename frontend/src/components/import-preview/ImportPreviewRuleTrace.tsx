'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRuleChangeText } from '@/components/rules/use-rule-change-text';
import { useSkipReasonText } from '@/components/rules/RuleRunPreviewTable';
import type { ImportPreviewLabels, ImportPreviewRule } from '@/types/import-preview';
import {
  IMPORT_PREVIEW_HEADING_CLASS,
  IMPORT_PREVIEW_LINK_CLASS,
  IMPORT_PREVIEW_LINK_PROPS,
  ImportPreviewNewTabIcon,
} from './ImportPreviewPayeeMapping';

function RuleTraceItem({ rule, labels }: { rule: ImportPreviewRule; labels: ImportPreviewLabels }) {
  const t = useTranslations('import.preview.rules');
  const tAction = useTranslations('rules.editor.actionTypes');
  const changeText = useRuleChangeText();
  const skipReason = useSkipReasonText();
  const names = {
    category: (id: string) => labels.categories[id],
    payee: (id: string) => labels.payees[id],
    tag: (id: string) => labels.tags[id],
  };
  // A type this client has no name for still reads as what the server said.
  const actionName = (type: string) => (tAction.has(type) ? tAction(type) : type);
  const ruleName = rule.ruleName ?? t('unnamed');
  const changes = changeText(rule.changes, names);
  const notes = [
    ...rule.skipped.map((action) =>
      t('skipped', { action: actionName(action.type), reason: skipReason(action.reason) }),
    ),
    ...(rule.stopped ? [t('stopped')] : []),
  ];

  return (
    <li>
      <Link
        href={`/rules/${rule.ruleId}`}
        {...IMPORT_PREVIEW_LINK_PROPS}
        aria-label={t('openNewTab', { name: ruleName })}
        className={IMPORT_PREVIEW_LINK_CLASS}
      >
        {ruleName}
        <ImportPreviewNewTabIcon />
      </Link>
      {(changes.length > 0 || notes.length > 0) && (
        <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-gray-700 dark:text-gray-300">
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
      {changes.length === 0 && notes.length === 0 && rule.applied.length > 0 && (
        <p className="mt-0.5 text-gray-500 dark:text-gray-400">
          {t('applied', { actions: rule.applied.map((action) => actionName(action.type)).join(', ') })}
        </p>
      )}
    </li>
  );
}

/**
 * The import rules that matched an import preview row: each by name (linked to
 * the rule), with what it changed in words, the actions it skipped and why, and
 * whether it ended the pass. Everything is the server's own answer for the row;
 * nothing is worked out in the browser.
 */
export function ImportPreviewRuleTrace({
  rules,
  labels,
}: {
  rules: readonly ImportPreviewRule[];
  labels: ImportPreviewLabels;
}) {
  const t = useTranslations('import.preview.rules');
  return (
    <section aria-label={t('heading')} className="space-y-1">
      <h4 className={IMPORT_PREVIEW_HEADING_CLASS}>{t('heading')}</h4>
      {rules.length === 0 ? (
        <p className="text-gray-600 dark:text-gray-300">{t('none')}</p>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <RuleTraceItem key={rule.ruleId} rule={rule} labels={labels} />
          ))}
        </ul>
      )}
    </section>
  );
}
