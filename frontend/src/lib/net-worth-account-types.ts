import type { AccountType } from '@/types/account';
import type { MonthlyNetWorth } from '@/types/net-worth';
import { chartColors } from '@/lib/chart-colors';
import { isLiabilityAccountType } from '@/types/account';

/**
 * The Net Worth Over Time bar chart, stacked by account type: which types to
 * draw, in which order and colour. The figures are the server's
 * (`MonthlyNetWorth.byAccountType`); nothing here adds them up.
 */

/**
 * Stacking and legend order: what is held first, then what is owed, the order
 * the Accounts page groups them in. OTHER is last and neutral, as an
 * unclassified series is everywhere else.
 */
export const NET_WORTH_ACCOUNT_TYPE_ORDER: readonly AccountType[] = [
  'CHEQUING',
  'SAVINGS',
  'CASH',
  'CRYPTO',
  'INVESTMENT',
  'ASSET',
  'CREDIT_CARD',
  'LINE_OF_CREDIT',
  'LOAN',
  'MORTGAGE',
  'OTHER',
];

/**
 * How strongly each step of a ramp holds its base colour, the rest being the
 * card behind the chart: the first type in its group at full strength, each
 * later one paler. Mixing toward the card rather than toward white keeps the
 * ramp legible in dark mode too, where paler means closer to the dark card.
 * One step per held type (six), the palest kept at 30% so it stays legible.
 */
const RAMP_STRENGTHS = ['100%', '80%', '64%', '50%', '39%', '30%'] as const;

/** `base` at `strength` (a CSS percentage), the rest the chart's card colour. */
function rampStep(base: string, strength: (typeof RAMP_STRENGTHS)[number]): string {
  if (strength === '100%') return base;
  return `color-mix(in srgb, ${base} ${strength}, ${chartColors.surface})`;
}

/**
 * One account type's colour, drawn from the active theme: what is held is a
 * ramp of the theme accent, what is owed a ramp of its expense colour, so the
 * bars read as the theme's own and the two sides of zero never share a hue.
 * Each type keeps its step whichever others a reader holds, since the step is
 * fixed by the type's place in the order. OTHER is neutral, as an unclassified
 * series is everywhere else.
 */
export function netWorthAccountTypeColor(type: AccountType): string {
  if (type === 'OTHER') return chartColors.neutral;
  const liability = isLiabilityAccountType(type);
  const group = NET_WORTH_ACCOUNT_TYPE_ORDER.filter(
    (t) => t !== 'OTHER' && isLiabilityAccountType(t) === liability,
  );
  const step = RAMP_STRENGTHS[Math.min(group.indexOf(type), RAMP_STRENGTHS.length - 1)];
  return rampStep(liability ? chartColors.expense : chartColors.primary, step);
}

/**
 * The net worth line across the stacked bars. Not the accent: the asset bars
 * are a ramp of it, and a line in their own colour would vanish into them.
 */
export const NET_WORTH_LINE_COLOR = chartColors.axis;

/**
 * The account types any month of the series holds a non-zero amount in, in
 * stacking order. A type that is zero in every month (an emptied or paid-off
 * account) has nothing to draw, so it gets no bar and no legend entry. Empty
 * when no month carries the breakdown (an older backend mid-deploy), which the
 * chart reads as "draw net worth alone".
 */
export function netWorthAccountTypes(
  months: readonly Pick<MonthlyNetWorth, 'byAccountType'>[],
): AccountType[] {
  const present = new Set<AccountType>();
  for (const month of months) {
    for (const [type, value] of Object.entries(month.byAccountType ?? {})) {
      if (value !== undefined && value !== 0) present.add(type as AccountType);
    }
  }
  return NET_WORTH_ACCOUNT_TYPE_ORDER.filter((type) => present.has(type));
}

/**
 * Where a month's bar ends above zero: the sum of what its asset types hold,
 * the height a value label sits on. Only a position -- the figure printed there
 * is the server's `netWorth`. A month without the breakdown draws net worth as
 * one bar, which ends at net worth.
 */
export function netWorthStackTop(
  month: Pick<MonthlyNetWorth, 'byAccountType' | 'netWorth'>,
): number {
  if (!month.byAccountType) return month.netWorth;
  let top = 0;
  for (const value of Object.values(month.byAccountType)) {
    if (value !== undefined && value > 0) top += value;
  }
  return top;
}
