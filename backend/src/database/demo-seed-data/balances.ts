export interface DemoMonthlyBalance {
  accountKey: string;
  month: string;
  balance: number;
}

/**
 * Generate 12 months of end-of-month account balance snapshots
 * for the net worth report.
 */
export function generateMonthlyBalances(
  referenceDate: Date,
): DemoMonthlyBalance[] {
  const balances: DemoMonthlyBalance[] = [];

  // Starting balances 12 months ago
  const accountTrajectories: {
    key: string;
    start: number;
    end: number;
    volatility: number;
  }[] = [
    { key: "chequing", start: 3200, end: 5420, volatility: 800 },
    { key: "savings", start: 9000, end: 15000, volatility: 200 },
    { key: "vacation", start: 800, end: 3200, volatility: 100 },
    { key: "visa", start: -1800, end: -1250, volatility: 400 },
    { key: "mastercard", start: -650, end: -487, volatility: 200 },
    { key: "mortgage", start: -392000, end: -385000, volatility: 0 },
    { key: "rrsp", start: 35000, end: 42500, volatility: 1500 },
    { key: "tfsa", start: 22000, end: 28750, volatility: 1000 },
    { key: "us_stocks", start: 9500, end: 12300, volatility: 800 },
    { key: "cash", start: 100, end: 150, volatility: 30 },
  ];

  let seed = 123;
  const seededRand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  for (const acct of accountTrajectories) {
    for (let i = 0; i < 12; i++) {
      const monthDate = new Date(referenceDate);
      monthDate.setMonth(monthDate.getMonth() - (11 - i));
      // Set to first of that month for the snapshot
      const snapshotMonth = new Date(
        monthDate.getFullYear(),
        monthDate.getMonth(),
        1,
      );

      // Linear interpolation with some noise
      const progress = i / 11;
      const baseValue = acct.start + (acct.end - acct.start) * progress;
      const noise = (seededRand() - 0.5) * 2 * acct.volatility;
      const balance = Math.round((baseValue + noise) * 100) / 100;

      balances.push({
        accountKey: acct.key,
        month: snapshotMonth.toISOString().split("T")[0],
        balance,
      });
    }
  }

  return balances;
}
