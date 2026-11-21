import type { ReactNode } from 'react';

/** What the Accounts page's summary shows, worked out by the page. */
export interface AccountsSummaryViewProps {
  accountCount: number;
  /** Each money figure is the page's own total (a `PartialTotal` around a `MoneyFigure display`). */
  netWorth: ReactNode;
  assets: ReactNode;
  liabilities: ReactNode;
  /** Net worth is known to be negative; false when it is a subtotal with an uncertain sign. */
  netWorthNegative: boolean;
  labels: {
    accounts: string;
    netWorth: string;
    assets: string;
    liabilities: string;
  };
  /** The Standard card grid, which the Standard style keeps as it is. */
  children: ReactNode;
}
