export const STRATEGY_LABELS: Record<string, string> = {
  FIXED: 'Fixed',
  ROLLOVER: 'Rollover',
  ZERO_BASED: 'Zero-Based',
  FIFTY_THIRTY_TWENTY: '50/30/20',
};

export const BUDGET_TYPE_LABELS: Record<string, string> = {
  MONTHLY: 'Monthly',
  ANNUAL: 'Annual',
  PAY_PERIOD: 'Pay Period',
};

export const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  FIXED: 'Fixed amounts per category. Unspent budget resets each period.',
  ROLLOVER: 'Unspent budget carries forward per category rules.',
  ZERO_BASED: 'Every dollar assigned. Income minus expenses should be zero.',
  FIFTY_THIRTY_TWENTY: '50% needs, 30% wants, 20% savings.',
};
