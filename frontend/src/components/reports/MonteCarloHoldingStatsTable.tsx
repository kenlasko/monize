'use client';

import { AccountHoldingStats } from '@/lib/monte-carlo';

export function HoldingStatsTable({
  data,
  loading,
  formatCurrency,
}: {
  data: AccountHoldingStats[] | null;
  loading: boolean;
  formatCurrency: (v: number) => string;
}) {
  if (loading) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Loading holding stats…
      </p>
    );
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Select one or more accounts to see per-holding historical returns.
      </p>
    );
  }

  const fmtPct = (v: number | null) =>
    v == null ? '—' : `${(v * 100).toFixed(2)}%`;

  return (
    <div className="space-y-3 mb-3">
      {data.map((acct) => (
        <div
          key={acct.accountId}
          className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden"
        >
          <div className="bg-gray-50 dark:bg-gray-900/50 px-3 py-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            {acct.accountName}{' '}
            <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
              ({acct.currencyCode})
            </span>
          </div>
          {acct.holdings.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
              No active holdings.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-900/30 text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Symbol</th>
                    {/* Name is decorative; hide on small screens so the
                        numeric columns fit on a phone without horizontal
                        scroll. */}
                    <th className="px-3 py-1.5 text-left font-medium hidden sm:table-cell">
                      Name
                    </th>
                    <th className="px-3 py-1.5 text-right font-medium">Value</th>
                    <th className="px-3 py-1.5 text-right font-medium whitespace-nowrap">
                      Mean
                    </th>
                    <th className="px-3 py-1.5 text-right font-medium">
                      Volatility
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {acct.holdings.map((h) => (
                    <tr key={`${acct.accountId}-${h.symbol}`}>
                      <td className="px-3 py-1.5 font-mono text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {h.symbol}
                      </td>
                      <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300 truncate max-w-[200px] hidden sm:table-cell">
                        {h.name}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {formatCurrency(h.marketValue)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {fmtPct(h.meanReturn)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {fmtPct(h.volatility)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
