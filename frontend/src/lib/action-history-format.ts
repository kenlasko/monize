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
  'lookedUpPayeeContact',
  'createdReport', 'updatedReport', 'deletedReport',
  'createdScheduledTransaction', 'updatedScheduledTransaction', 'deletedScheduledTransaction',
  'postedScheduledTransaction',
  'createdSecurity', 'updatedSecurity', 'deletedSecurity',
  'createdTag', 'updatedTag', 'deletedTag',
  'createdTransaction', 'updatedTransaction', 'deletedTransaction',
  'createdTransfer',
  'convertedToTransfer', 'convertedToTransaction',
  'createdInvestmentTransaction', 'updatedInvestmentTransaction', 'deletedInvestmentTransaction',
  'transferredSecurity', 'updatedSecurityTransfer',
  'ranTransactionRule',
]);

// Description keys whose `action` param carries an InvestmentAction enum value
// (e.g. "BUY") that must be localized before it is interpolated into the
// template, otherwise the raw English enum leaks into the rendered string.
const ACTION_PARAM_KEYS = new Set<string>([
  'createdInvestmentTransaction',
  'updatedInvestmentTransaction',
  'deletedInvestmentTransaction',
]);

// InvestmentAction enum values that have a label under
// `layout.actionHistory.actionLabels`. Keep in sync with the backend enum
// (backend/src/securities/entities/investment-transaction.entity.ts).
const KNOWN_INVESTMENT_ACTIONS = new Set<string>([
  'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'SPLIT',
  'TRANSFER_IN', 'TRANSFER_OUT', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES',
  'REINVEST_INTEREST', 'REINVEST_CAPITAL_GAIN_SHORT',
  'REINVEST_CAPITAL_GAIN_LONG', 'CAPITAL_GAIN_SHORT', 'CAPITAL_GAIN_LONG',
  'REDEEM', 'RETURN_OF_CAPITAL',
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
 *
 * `formatCurrency` is `useNumberFormat().formatCurrency`. It is optional
 * because two of the five call sites render into a toast where the money is
 * incidental, and because a row written before the structured amount landed has
 * nothing to format -- but supply it wherever you can: without it the money in
 * the sentence is the server's deterministic `en-US` string sitting inside
 * translated copy (issue #1316).
 */
export function renderActionDescription(
  t: LayoutTranslator,
  item: DescribableAction | null | undefined,
  formatCurrency?: (amount: number, currencyCode?: string) => string,
): string {
  if (item?.descriptionKey && KNOWN_DESCRIPTION_KEYS.has(item.descriptionKey)) {
    return t(
      `actionHistory.descriptions.${item.descriptionKey}` as never,
      localizeParams(
        t,
        item.descriptionKey,
        item.descriptionParams,
        formatCurrency,
      ) as never,
    );
  }
  return item?.description ?? '';
}

/**
 * Localize interpolation params that are not free text: an enum value that
 * needs translating, and a money amount that needs the reader's number locale.
 *
 * The money case is structural rather than a re-parse of the stored string: the
 * server sends `amountValue` (a number) and `amountCurrency` beside the English
 * `amount`, and only when both are present is `amount` replaced. A row written
 * by an older backend carries neither, so it keeps the English rendering rather
 * than losing the figure -- which is also what makes this safe mid-deploy.
 */
function localizeParams(
  t: LayoutTranslator,
  descriptionKey: string,
  params: DescribableAction['descriptionParams'],
  formatCurrency?: (amount: number, currencyCode?: string) => string,
): Record<string, string | number> {
  let safeParams = params ?? {};
  const amountValue = safeParams.amountValue;
  const amountCurrency = safeParams.amountCurrency;
  if (
    formatCurrency &&
    typeof amountValue === 'number' &&
    Number.isFinite(amountValue) &&
    typeof amountCurrency === 'string' &&
    amountCurrency !== ''
  ) {
    safeParams = {
      ...safeParams,
      amount: formatCurrency(amountValue, amountCurrency),
    };
  }
  if (!ACTION_PARAM_KEYS.has(descriptionKey)) {
    return safeParams;
  }
  const action = safeParams.action;
  if (typeof action !== 'string' || !KNOWN_INVESTMENT_ACTIONS.has(action)) {
    return safeParams;
  }
  return {
    ...safeParams,
    action: t(`actionHistory.actionLabels.${action}` as never),
  };
}
