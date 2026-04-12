'use client';

import { useState } from 'react';

interface ToolInfo {
  name: string;
  summary: string;
  input?: Record<string, unknown>;
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
  get_budget_status: 'Budget Status',
};

function ToolDetails({ tool }: { tool: ToolInfo }) {
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[tool.name] || tool.name;
  const hasInput = tool.input && Object.keys(tool.input).length > 0;
  const hasSummary = !!tool.summary;
  const hasDetails = hasInput || hasSummary;

  return (
    <div className="rounded-lg border border-blue-100 dark:border-blue-900/50 bg-blue-50/60 dark:bg-blue-900/20 overflow-hidden">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        disabled={!hasDetails}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-100/60 dark:hover:bg-blue-900/30 disabled:cursor-default disabled:hover:bg-transparent transition-colors"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <svg
            className="w-3 h-3 flex-shrink-0"
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
          <span className="font-medium truncate">{label}</span>
        </span>
        {hasDetails && (
          <svg
            className={`w-3 h-3 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 8.25l-7.5 7.5-7.5-7.5"
            />
          </svg>
        )}
      </button>
      {expanded && hasDetails && (
        <div className="border-t border-blue-100 dark:border-blue-900/50 px-2.5 py-2 space-y-2 bg-white/40 dark:bg-black/20">
          {hasInput && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-blue-600 dark:text-blue-400 font-semibold mb-0.5">
                Input
              </div>
              <pre className="text-[11px] text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words font-mono">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {hasSummary && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-blue-600 dark:text-blue-400 font-semibold mb-0.5">
                Result
              </div>
              <p className="text-[11px] text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">
                {tool.summary}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
        {/* Tool calls — click to expand and see input/result */}
        {toolsUsed && toolsUsed.length > 0 && (
          <div className="flex flex-col gap-1 mb-2">
            {toolsUsed.map((tool, i) => (
              <ToolDetails key={i} tool={tool} />
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
