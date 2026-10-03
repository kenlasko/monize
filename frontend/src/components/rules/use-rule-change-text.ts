'use client';

import { useCallback } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { RuleRunChanges, RuleStructurePlan } from '@/types/transaction-rule-run';

/** Names for the ids a change mentions; `undefined` means the id is not known. */
export interface RuleChangeNames {
  category: (id: string) => string | undefined;
  payee: (id: string) => string | undefined;
  tag: (id: string) => string | undefined;
  /** The account a transfer or a split part names. */
  account: (id: string) => string | undefined;
}

export interface RuleChangeTextOptions {
  /** The change was written (the history), not planned (a preview): a created payee reads in the past tense. */
  done?: boolean;
  /** The row's currency: the amounts of a split's parts are written in it. */
  currencyCode?: string;
}

/**
 * Turns the `{field: {before, after}}` a preview or a trace holds into one
 * sentence per changed field, using names and never raw ids. An id with no
 * name (deleted since) reads as such instead of leaking the id. A payee named
 * by text has no id until it exists: it reads by name, with a note when the
 * rule creates it. A description reads in quotes. A transfer reads as the
 * account it goes to, a split as one line per part with its signed amount.
 */
export function useRuleChangeText(): (
  changes: RuleRunChanges,
  names: RuleChangeNames,
  options?: RuleChangeTextOptions,
) => string[] {
  const t = useTranslations('rules.run.change');
  const tw = useTranslations('rules.words');
  const format = useFormatter();
  const { formatCurrency, formatNumber } = useNumberFormat();

  return useCallback(
    (changes, names, options = {}) => {
      const lines: string[] = [];
      const one = (id: string | null, resolve: (id: string) => string | undefined) =>
        id === null ? t('none') : (resolve(id) ?? t('unknown'));

      const structureLines = (
        plan: RuleStructurePlan,
        known: RuleChangeNames,
        done: boolean,
        currencyCode: string | undefined,
      ): string[] => {
        const doneKey = done ? 'yes' : 'no';
        const account = (id: string) => known.account(id) ?? t('unknown');
        if (plan.kind === 'transfer') return [t('transfer', { done: doneKey, account: account(plan.accountId) })];
        const amount = (value: number) =>
          currencyCode ? formatCurrency(value, currencyCode) : formatNumber(value, 2);
        return [
          t('split', { done: doneKey, count: plan.parts.length }),
          ...plan.parts.map((part, index) => {
            const payee = part.payeeId === null ? null : (known.payee(part.payeeId) ?? t('unknown'));
            const target =
              part.transferAccountId !== null
                ? payee === null
                  ? t('splitToTransfer', { account: account(part.transferAccountId) })
                  : t('splitToTransferPayee', { account: account(part.transferAccountId), payee })
                : part.categoryId !== null
                  ? t('splitToCategory', { category: one(part.categoryId, known.category) })
                  : t('splitUncategorised');
            const head = t('splitPart', { number: index + 1, amount: amount(part.amount), target });
            return part.memo === null || part.memo === '' ? head : `${head}${t('splitPartMemo', { memo: part.memo })}`;
          }),
        ];
      };

      if (changes.categoryId) {
        lines.push(
          t('category', {
            before: one(changes.categoryId.before, names.category),
            after: one(changes.categoryId.after, names.category),
          }),
        );
      }
      const creation = changes.payeeCreated === true ? (changes.payeeName?.after ?? null) : null;
      if (creation) {
        // One line: the payee row P becomes the payee the rule creates, never "none".
        const text = (name: string | null) => (name === null || name === '' ? t('none') : name);
        const before = changes.payeeId
          ? one(changes.payeeId.before, names.payee)
          : text(changes.payeeName?.before ?? null);
        lines.push(t('payeeNew', { before, name: creation }));
      } else if (changes.payeeId) {
        lines.push(
          t('payee', {
            before: one(changes.payeeId.before, names.payee),
            after: one(changes.payeeId.after, names.payee),
          }),
        );
      }
      if (changes.payeeName && !changes.payeeId && !creation) {
        const text = (name: string | null) => (name === null || name === '' ? t('none') : name);
        lines.push(t('payee', { before: text(changes.payeeName.before), after: text(changes.payeeName.after) }));
      }
      if (changes.payeeCreated === true && changes.payeeName?.after) {
        lines.push(t('payeeCreated', { done: options.done === true ? 'yes' : 'no', name: changes.payeeName.after }));
      }
      if (changes.description) {
        const text = (value: string | null) => (value === null || value.trim() === '' ? t('none') : tw('text', { value }));
        lines.push(t('description', { before: text(changes.description.before), after: text(changes.description.after) }));
      }
      if (changes.tagIds) {
        const before = new Set(changes.tagIds.before);
        const after = new Set(changes.tagIds.after);
        const list = (ids: string[]) =>
          format.list(
            ids.map((id) => names.tag(id) ?? t('unknown')),
            { type: 'conjunction' },
          );
        const added = changes.tagIds.after.filter((id) => !before.has(id));
        const removed = changes.tagIds.before.filter((id) => !after.has(id));
        if (added.length > 0) lines.push(t('tagsAdded', { tags: list(added) }));
        if (removed.length > 0) lines.push(t('tagsRemoved', { tags: list(removed) }));
      }
      const structure = changes.structure?.after;
      if (structure) lines.push(...structureLines(structure, names, options.done === true, options.currencyCode));
      return lines;
    },
    [t, tw, format, formatCurrency, formatNumber],
  );
}
