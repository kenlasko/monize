import type { useTranslations } from 'next-intl';
import type { ActionHistoryItem } from './action-history';

// Stable description keys the backend emits (it sets `descriptionKey` to one of
// these on every recorded action). Each maps to a template under
// `layout.actionHistory.descriptions`. Anything outside this set -- a row
// written before localization, or a key newer than this client -- falls back to
// the stored English `description`. Keep in sync with the backend call sites.
export const KNOWN_DESCRIPTION_KEYS = new Set<string>([
  'createdAccount', 'updatedAccount', 'deletedAccount',
  'createdBudget', 'updatedBudget', 'deletedBudget',
  'createdCategory', 'updatedCategory', 'deletedCategory',
  'createdInstitution', 'updatedInstitution', 'deletedInstitution',
  'createdInvestmentReport', 'updatedInvestmentReport', 'deletedInvestmentReport',
  'createdPayee', 'updatedPayee', 'deletedPayee',
  'createdReport', 'updatedReport', 'deletedReport',
  'createdScheduledTransaction', 'updatedScheduledTransaction', 'deletedScheduledTransaction',
  'createdSecurity', 'updatedSecurity', 'deletedSecurity',
  'createdTag', 'updatedTag', 'deletedTag',
  'createdTransaction', 'updatedTransaction', 'deletedTransaction',
  'createdTransfer',
  'createdInvestmentTransaction', 'updatedInvestmentTransaction', 'deletedInvestmentTransaction',
  'transferredSecurity', 'updatedSecurityTransfer',
]);

type LayoutTranslator = ReturnType<typeof useTranslations<'layout'>>;

type DescribableAction = Pick<
  ActionHistoryItem,
  'description' | 'descriptionKey' | 'descriptionParams'
>;

/**
 * Render an action's description in the active locale. Prefers the localizable
 * `descriptionKey` + params; falls back to the stored English `description` for
 * legacy rows or unknown keys so nothing renders blank.
 */
export function renderActionDescription(
  t: LayoutTranslator,
  item: DescribableAction | null | undefined,
): string {
  if (item?.descriptionKey && KNOWN_DESCRIPTION_KEYS.has(item.descriptionKey)) {
    return t(
      `actionHistory.descriptions.${item.descriptionKey}` as never,
      (item.descriptionParams ?? {}) as never,
    );
  }
  return item?.description ?? '';
}
