'use client';

const SUGGESTED_QUERIES = [
  { label: 'Monthly spending', query: 'How much did I spend last month?' },
  { label: 'Top categories', query: 'What are my top 5 expense categories this year?' },
  { label: 'Account balances', query: 'What are my current account balances?' },
  { label: 'Compare months', query: 'Compare my spending this month vs last month' },
  { label: 'Net worth trend', query: 'Show my net worth trend for the last 12 months' },
  { label: 'Savings rate', query: 'How much have I saved this year compared to my income?' },
];

interface SuggestedQueriesProps {
  onSelect: (query: string) => void;
  disabled?: boolean;
}

export function SuggestedQueries({ onSelect, disabled = false }: SuggestedQueriesProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4">
      <div className="mb-2">
        <svg
          className="w-12 h-12 text-blue-500 dark:text-blue-400 mx-auto"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.625 9.75a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.294 48.294 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"
          />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        Ask about your finances
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 text-center max-w-md">
        I can answer questions about your spending, income, account balances, net worth, and more.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
        {SUGGESTED_QUERIES.map((suggestion) => (
          <button
            key={suggestion.label}
            onClick={() => onSelect(suggestion.query)}
            disabled={disabled}
            className="text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-gray-200 dark:disabled:hover:border-gray-700 disabled:hover:bg-transparent"
          >
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {suggestion.label}
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {suggestion.query}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
