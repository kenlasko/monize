'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRuleChangeText } from '@/components/rules/use-rule-change-text';
import type { PendingActionRuleEffects } from '@/types/ai';

/**
 * "Your rules will also:" under a created transaction or transfer, one line per
 * thing the rules will do when it is saved, with names and never ids. Renders
 * nothing when no rule has an effect, so a card without rule effects keeps its
 * layout. A name the server could not resolve reads as a deleted item.
 */
export function RuleEffectsLines({
  effects,
  currencyCode,
}: {
  effects: PendingActionRuleEffects | undefined;
  /** The row's currency: the parts of a split are written in it. */
  currencyCode?: string;
}) {
  const t = useTranslations('ai.confirmAction.ruleEffects');
  const tr = useTranslations('rules.run.change');
  const tw = useTranslations('rules.words');
  const format = useFormatter();
  const changeText = useRuleChangeText();
  if (!effects) return null;

  const { changes, labels } = effects;
  const tagNames = (ids: readonly string[]) =>
    format.list(
      ids.map((id) => labels.tags[id] ?? tr('unknown')),
      { type: 'conjunction' },
    );

  const lines: string[] = [];
  if (changes.categoryId !== undefined) {
    lines.push(
      t('category', {
        name: changes.categoryId === null ? tr('none') : (labels.categories[changes.categoryId] ?? tr('unknown')),
      }),
    );
  }
  if (changes.payeeId !== undefined) {
    lines.push(
      t('payee', {
        name: changes.payeeId === null ? tr('none') : (labels.payees[changes.payeeId] ?? tr('unknown')),
      }),
    );
  } else if (changes.createPayee !== undefined) {
    // A payee named by text that does not exist yet: the save creates it.
    lines.push(tr('payeeCreated', { done: 'no', name: changes.createPayee }));
  } else if (changes.payeeName !== undefined) {
    lines.push(t('payee', { name: changes.payeeName }));
  }
  if (typeof changes.description === 'string') {
    lines.push(tr('descriptionSet', { value: tw('text', { value: changes.description }) }));
  }
  if (changes.addTagIds.length > 0) lines.push(tr('tagsAdded', { tags: tagNames(changes.addTagIds) }));
  if (changes.removeTagIds.length > 0) lines.push(tr('tagsRemoved', { tags: tagNames(changes.removeTagIds) }));
  if (effects.aiReviewRequests.length > 0) {
    lines.push(t('aiReview', { count: effects.aiReviewRequests.length }));
  }
  // A transfer or a split moves another account's balance: never left off the card.
  if (changes.structure) {
    lines.push(
      ...changeText(
        { structure: { before: null, after: changes.structure } },
        {
          category: (id) => labels.categories[id],
          payee: (id) => labels.payees[id],
          tag: (id) => labels.tags[id],
          account: (id) => labels.accounts?.[id],
        },
        { currencyCode },
      ),
    );
  }
  if (lines.length === 0) return null;

  return (
    <div className="pt-1 text-sm" data-testid="rule-effects">
      <p className="text-gray-500 dark:text-gray-400">{t('title')}</p>
      <ul className="list-disc pl-5 text-gray-900 dark:text-gray-100">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
