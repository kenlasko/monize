import type { useTranslations } from 'next-intl';
import type { PendingActionSplitTagChange } from '@/types/ai';

type AiTranslator = ReturnType<typeof useTranslations<'ai'>>;

/**
 * One split line's tag change as both confirmation cards say it: the line
 * (category, amount and memo, so two lines alike in category and amount are
 * told apart, and for a transfer line the other account whose transaction
 * changes too) and the tags it gains (new ones marked) and loses. The
 * punctuation lives in the catalog, so each locale writes its own.
 */
export function splitTagChangeText(
  line: PendingActionSplitTagChange,
  t: AiTranslator,
  formatAmount: (amount: number) => string,
): string {
  const category = line.categoryName || t('confirmAction.uncategorized');
  const amount = formatAmount(line.amount);
  const lineName = line.memo
    ? t('confirmAction.splitLineNameWithMemo', { category, amount, memo: line.memo })
    : t('confirmAction.splitLineName', { category, amount });
  // A transfer line's tags are mirrored on its transaction in the other
  // account, which this approval changes too: the card says which.
  const name = line.legAccountName
    ? t('confirmAction.splitLineWithLeg', { line: lineName, account: line.legAccountName })
    : lineName;
  const added =
    line.tagNames && line.tagNames.length > 0
      ? t('confirmAction.bulkTagsAdded', {
          tags: line.tagNames
            .map((tag) =>
              line.newTagNames?.includes(tag) ? `${tag} ${t('confirmAction.newTag')}` : tag,
            )
            .join(', '),
        })
      : null;
  const removed =
    line.removeTagNames && line.removeTagNames.length > 0
      ? t('confirmAction.bulkTagsRemoved', { tags: line.removeTagNames.join(', ') })
      : null;
  const changes =
    added && removed
      ? t('confirmAction.splitLineTagChangeBoth', { added, removed })
      : (added ?? removed ?? '');
  return t('confirmAction.splitLineTagChange', { line: name, changes });
}
