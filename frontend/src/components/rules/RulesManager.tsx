'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { BoltIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { RunRuleDialog } from '@/components/rules/RunRuleDialog';
import { RulesList, type RuleMoveDirection } from '@/components/rules/RulesList';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { TOUR_ANCHORS, tourAnchor, type TourAnchorId } from '@/lib/tours/anchors';
import { getErrorCode, getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { TransactionRule } from '@/types/transaction-rule';

const logger = createLogger('Rules');

/** Longest rule name the API accepts (`MAX_RULE_NAME_LENGTH`). */
const MAX_RULE_NAME_LENGTH = 100;

/** The API answers 409 `RULE_LIST_CHANGED` when the list moved under a reorder. */
function isListChanged(error: unknown): boolean {
  return (
    getErrorCode(error) === 'RULE_LIST_CHANGED' ||
    (error instanceof AxiosError && error.response?.status === 409)
  );
}

export const NEW_RULE_HREF = '/rules/new';

export function CreateRuleLink({
  label,
  anchor,
}: {
  label: string;
  /** The `tourAnchor(...)` attribute a guided tour points at. */
  anchor?: { 'data-tour-id': TourAnchorId };
}) {
  return (
    <Link href={NEW_RULE_HREF} className={buttonClassName('primary', 'md', 'w-full sm:w-auto')} {...anchor}>
      {label}
    </Link>
  );
}

/**
 * The rules page body: loads the list, owns every write the list can make
 * (enable, reorder, duplicate, delete) and tells "no rules" apart from "the
 * request failed". `rules === null` means not loaded yet; it never stands in
 * for an empty list.
 */
export function RulesManager() {
  const t = useTranslations('rules');
  const tc = useTranslations('common');
  const [rules, setRules] = useState<TransactionRule[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [reordering, setReordering] = useState(false);
  const [deleteRule, setDeleteRule] = useState<TransactionRule | null>(null);
  const [runRule, setRunRule] = useState<TransactionRule | null>(null);
  // Only the newest request may write the list: a reload after a 409 must not
  // be overwritten by a slower answer to an earlier one.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const data = await transactionRulesApi.getAll();
      if (request !== latestLoad.current) return;
      setRules(data);
      setLoadFailed(false);
    } catch (error) {
      if (request !== latestLoad.current) return;
      setLoadFailed(true);
      toast.error(getErrorMessage(error, t('toasts.loadFailed')));
      logger.error(error);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useOnUndoRedo(load);
  // Refresh on AI chat-bubble writes the same way as undo/redo.
  useOnAiAction(load);

  const retry = () => {
    setLoadFailed(false);
    void load();
  };

  const withPending = async (id: string, work: () => Promise<void>) => {
    setPendingIds((prev) => new Set(prev).add(id));
    try {
      await work();
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleToggle = (rule: TransactionRule, enabled: boolean) =>
    withPending(rule.id, async () => {
      try {
        const updated = await transactionRulesApi.setEnabled(rule.id, enabled);
        setRules((prev) => prev && prev.map((r) => (r.id === updated.id ? updated : r)));
        toast.success(enabled ? t('toasts.enabled') : t('toasts.disabled'));
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.toggleFailed')));
        logger.error(error);
      }
    });

  const handleMove = async (rule: TransactionRule, direction: RuleMoveDirection) => {
    if (!rules || reordering) return;
    const from = rules.findIndex((r) => r.id === rule.id);
    const to = direction === 'up' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= rules.length) return;
    const ids = rules.map((r) => r.id);
    const reordered = ids.map((id, i) => (i === from ? ids[to] : i === to ? ids[from] : id));
    setReordering(true);
    try {
      setRules(await transactionRulesApi.reorder(reordered));
    } catch (error) {
      if (isListChanged(error)) {
        toast.error(t('toasts.listChanged'));
        await load();
      } else {
        toast.error(getErrorMessage(error, t('toasts.reorderFailed')));
        logger.error(error);
      }
    } finally {
      setReordering(false);
    }
  };

  const handleDuplicate = (rule: TransactionRule) =>
    withPending(rule.id, async () => {
      // Leave room for the suffix so a long name still fits the API's limit.
      const overhead = t('duplicate.name', { name: '' }).length;
      const name = t('duplicate.name', {
        name: rule.name.slice(0, Math.max(1, MAX_RULE_NAME_LENGTH - overhead)),
      });
      try {
        await transactionRulesApi.create({
          name,
          // Two identical live rules would both run; the copy waits to be enabled.
          enabled: false,
          triggers: rule.triggers,
          condition: rule.condition,
          actions: rule.actions,
          stopProcessing: rule.stopProcessing,
          // An open side is left out, so a backend that predates the window still accepts the copy.
          ...(rule.activeFrom ? { activeFrom: rule.activeFrom } : {}),
          ...(rule.activeTo ? { activeTo: rule.activeTo } : {}),
        });
        toast.success(t('toasts.duplicated'));
        await load();
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.duplicateFailed')));
        logger.error(error);
      }
    });

  const handleConfirmDelete = async () => {
    const target = deleteRule;
    if (!target) return;
    try {
      await transactionRulesApi.delete(target.id);
      setRules((prev) => prev && prev.filter((r) => r.id !== target.id));
      toast.success(t('toasts.deleted'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.deleteFailed')));
      logger.error(error);
    } finally {
      setDeleteRule(null);
    }
  };

  let body;
  if (rules === null && loadFailed) {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={<Button onClick={retry}>{t('error.retry')}</Button>}
        />
      </div>
    );
  } else if (rules === null) {
    body = <LoadingSpinner text={t('page.loading')} />;
  } else if (rules.length === 0) {
    body = (
      <EmptyState
        icon={<BoltIcon />}
        title={t('empty.title')}
        description={t('empty.body')}
        action={<CreateRuleLink label={t('empty.createButton')} />}
      />
    );
  } else {
    body = (
      <RulesList
        rules={rules}
        pendingIds={pendingIds}
        reordering={reordering}
        onToggle={handleToggle}
        onDuplicate={handleDuplicate}
        onRun={setRunRule}
        onMove={handleMove}
        onDelete={setDeleteRule}
      />
    );
  }

  return (
    <>
      <Card className="overflow-hidden" {...tourAnchor(TOUR_ANCHORS.rulesList)}>
        {body}
      </Card>
      {rules !== null && rules.length > 0 && (
        <div className="mt-4 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('page.totalCount', { count: rules.length })}
        </div>
      )}
      <RunRuleDialog rule={runRule} onClose={() => setRunRule(null)} />
      <ConfirmDialog
        isOpen={deleteRule !== null}
        title={t('delete.title')}
        message={t('delete.message', { name: deleteRule?.name ?? '' })}
        confirmLabel={tc('delete')}
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteRule(null)}
      />
    </>
  );
}
