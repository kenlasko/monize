'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { RuleSection } from '@/components/rules/RuleSection';
import { useRuleChangeText } from '@/components/rules/use-rule-change-text';
import type { RuleOptions } from '@/components/rules/use-rule-options';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { RuleApplication } from '@/types/transaction-rule-run';

const logger = createLogger('RuleApplications');

const SOURCE_VARIANTS: Record<string, BadgeVariant> = {
  create: 'blue',
  import: 'purple',
  manual: 'green',
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; applications: RuleApplication[] };

/** The register's deep link: the list jumps to the row and flashes it. */
export const transactionHref = (transactionId: string): string =>
  `/transactions?targetTransactionId=${encodeURIComponent(transactionId)}`;

interface RuleApplicationsProps {
  ruleId: string;
  /** The pickers' lists, which name the ids a trace holds. */
  options: RuleOptions;
}

/**
 * The trace of a saved rule: its latest applications, newest first, each with
 * the change it made and a link to the transaction. A failed load is an error
 * with a retry, never the "not applied yet" message.
 */
export function RuleApplications({ ruleId, options }: RuleApplicationsProps) {
  const t = useTranslations('rules.applications');
  const { formatDate, formatDateTime } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const changeText = useRuleChangeText();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    transactionRulesApi
      .getApplications(ruleId)
      .then((applications) => {
        if (!cancelled) setState({ status: 'ready', applications });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [ruleId, attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const names = useMemo(() => {
    const byValue = (list: readonly { value: string; label: string }[]) => new Map(list.map((o) => [o.value, o.label]));
    const categories = byValue(options.categories);
    const payees = byValue(options.payees);
    const tags = byValue(options.tags);
    const accounts = byValue(options.accounts);
    return {
      category: (id: string) => categories.get(id),
      payee: (id: string) => payees.get(id),
      tag: (id: string) => tags.get(id),
      account: (id: string) => accounts.get(id),
    };
  }, [options]);

  const sourceLabel = (source: string) =>
    source === 'create' || source === 'import' || source === 'manual' ? t(`source.${source}`) : t('source.other');

  let body;
  if (state.status === 'loading') {
    body = <LoadingSpinner text={t('loading')} />;
  } else if (state.status === 'error') {
    body = (
      <div role="alert">
        <EmptyState
          className="py-6"
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={<Button onClick={retry}>{t('error.retry')}</Button>}
        />
      </div>
    );
  } else if (state.applications.length === 0) {
    body = <EmptyState className="py-6" title={t('empty.title')} description={t('empty.body')} />;
  } else {
    body = (
      <div className="max-h-96 overflow-auto">
        <table className={TABLE_CLASS}>
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <Th>{t('table.date')}</Th>
              <Th>{t('table.payee')}</Th>
              <Th align="right">{t('table.amount')}</Th>
              <Th>{t('table.source')}</Th>
              <Th>{t('table.change')}</Th>
              <Th>{t('table.appliedAt')}</Th>
              <Th>
                <span className="sr-only">{t('table.open')}</span>
              </Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {state.applications.map((application) => (
              <tr key={application.id}>
                <Td className="whitespace-nowrap">{formatDate(application.date)}</Td>
                <Td>
                  {application.payeeName ?? (
                    <span className="text-gray-500 dark:text-gray-400">{t('table.noPayee')}</span>
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {formatCurrency(application.amount, application.currencyCode)}
                </Td>
                <Td>
                  <Badge variant={SOURCE_VARIANTS[application.source] ?? 'gray'} size="sm">
                    {sourceLabel(application.source)}
                  </Badge>
                </Td>
                <Td>
                  <ul className="space-y-0.5">
                    {changeText(application.changes, names, { done: true, currencyCode: application.currencyCode }).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Td>
                <Td className="whitespace-nowrap">{formatDateTime(application.appliedAt)}</Td>
                <Td className="whitespace-nowrap">
                  <Link
                    href={transactionHref(application.transactionId)}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {t('table.view')}
                    <span className="sr-only"> {formatDate(application.date)}</span>
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <RuleSection title={t('title')} description={t('description')}>
      {body}
    </RuleSection>
  );
}
