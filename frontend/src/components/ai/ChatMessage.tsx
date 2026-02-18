'use client';

interface ToolInfo {
  name: string;
  summary: string;
}

interface SourceInfo {
  type: string;
  description: string;
  dateRange?: string;
}

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: ToolInfo[];
  sources?: SourceInfo[];
  isStreaming?: boolean;
  error?: string;
}

const TOOL_LABELS: Record<string, string> = {
  query_transactions: 'Transactions',
  get_account_balances: 'Account Balances',
  get_spending_by_category: 'Spending by Category',
  get_income_summary: 'Income Summary',
  get_net_worth_history: 'Net Worth History',
  compare_periods: 'Period Comparison',
};

export function ChatMessage({
  role,
  content,
  toolsUsed,
  sources,
  isStreaming,
  error,
}: ChatMessageProps) {
  if (role === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%] px-4 py-3 rounded-2xl rounded-br-sm bg-blue-600 text-white">
          <p className="text-sm whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-[85%]">
        {/* Tool badges */}
        {toolsUsed && toolsUsed.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {toolsUsed.map((tool, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                title={tool.summary}
              >
                <svg
                  className="w-3 h-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4.5 12.75l6 6 9-13.5"
                  />
                </svg>
                {TOOL_LABELS[tool.name] || tool.name}
              </span>
            ))}
          </div>
        )}

        {/* Message content */}
        <div className="px-4 py-3 rounded-2xl rounded-bl-sm bg-gray-100 dark:bg-gray-700/60 text-gray-900 dark:text-gray-100">
          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : (
            <div className="text-sm whitespace-pre-wrap leading-relaxed">
              {content}
              {isStreaming && (
                <span className="inline-block w-1.5 h-4 ml-0.5 bg-gray-400 dark:bg-gray-500 animate-pulse" />
              )}
            </div>
          )}
        </div>

        {/* Sources */}
        {sources && sources.length > 0 && (
          <div className="mt-1.5 px-2">
            <div className="flex flex-wrap gap-1">
              {sources.map((source, i) => (
                <span
                  key={i}
                  className="text-xs text-gray-400 dark:text-gray-500"
                >
                  {source.description}
                  {source.dateRange && ` (${source.dateRange})`}
                  {i < sources.length - 1 && ' · '}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
