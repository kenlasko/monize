'use client';

import { memo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AssistantMarkdown } from './AssistantMarkdown';
import { ResultChart } from './ResultChart';
import { TransactionConfirmationCard } from './TransactionConfirmationCard';
import { BulkConfirmationCard } from './BulkConfirmationCard';
import { useAiChatStore } from '@/store/aiChatStore';
import type { PendingAction } from '@/types/ai';

interface ToolInfo {
  name: string;
  summary: string;
  input?: Record<string, unknown>;
  isError?: boolean;
}

interface SourceInfo {
  type: string;
  description: string;
  dateRange?: string;
}

interface ChartInfo {
  type: 'bar' | 'pie' | 'line' | 'area';
  title: string;
  data: Array<{ label: string; value: number }>;
}

interface ChatMessageProps {
  // Message id, used to route confirm/cancel of pending action cards back to
  // the store. Always supplied by ChatInterface; optional for simpler tests.
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: ToolInfo[];
  sources?: SourceInfo[];
  charts?: ChartInfo[];
  pendingActions?: PendingAction[];
  isStreaming?: boolean;
  error?: string;
}

const TOOL_LABELS: Record<string, string> = {
  list_transactions: 'Transactions',
  list_accounts: 'Accounts',
  list_investment_transactions: 'Investment Transactions',
  compare_periods: 'Period Comparison',
  get_budget_status: 'Budget Status',
  calculate: 'Calculation',
  render_chart: 'Chart',
  manage_transactions: 'Manage Transactions',
  categorize_transaction: 'Categorize Transaction',
  manage_payees: 'Manage Payees',
  manage_securities: 'Manage Securities',
  lookup_securities: 'Look Up Securities',
};

function ToolDetails({ tool }: { tool: ToolInfo }) {
  const t = useTranslations('ai');
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[tool.name] || tool.name;
  const hasInput = tool.input && Object.keys(tool.input).length > 0;
  const hasSummary = !!tool.summary;
  const hasDetails = hasInput || hasSummary;
  const isError = !!tool.isError;

  const containerClasses = isError
    ? 'rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/20 overflow-hidden'
    : 'rounded-lg border border-blue-100 dark:border-blue-900/50 bg-blue-50/60 dark:bg-blue-900/20 overflow-hidden';
  const buttonClasses = isError
    ? 'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs text-red-700 dark:text-red-300 hover:bg-red-100/60 dark:hover:bg-red-900/30 disabled:cursor-default disabled:hover:bg-transparent transition-colors'
    : 'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-100/60 dark:hover:bg-blue-900/30 disabled:cursor-default disabled:hover:bg-transparent transition-colors';
  const detailsClasses = isError
    ? 'border-t border-red-200 dark:border-red-900/50 px-2.5 py-2 space-y-2 bg-white/40 dark:bg-black/20'
    : 'border-t border-blue-100 dark:border-blue-900/50 px-2.5 py-2 space-y-2 bg-white/40 dark:bg-black/20';
  const labelClasses = isError
    ? 'text-[10px] uppercase tracking-wide text-red-600 dark:text-red-400 font-semibold mb-0.5'
    : 'text-[10px] uppercase tracking-wide text-blue-600 dark:text-blue-400 font-semibold mb-0.5';

  return (
    <div className={containerClasses}>
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        disabled={!hasDetails}
        aria-expanded={expanded}
        className={buttonClasses}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {isError ? (
            <svg
              className="w-3 h-3 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              aria-label={t('toolDetails.toolFailedAriaLabel')}
              role="img"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          ) : (
            <svg
              className="w-3 h-3 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              aria-label={t('toolDetails.toolSucceededAriaLabel')}
              role="img"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 12.75l6 6 9-13.5"
              />
            </svg>
          )}
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
        <div className={detailsClasses}>
          {hasInput && (
            <div>
              <div className={labelClasses}>{t('toolDetails.inputLabel')}</div>
              <pre className="text-[11px] text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words font-mono">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {hasSummary && (
            <div>
              <div className={labelClasses}>{t('toolDetails.resultLabel')}</div>
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

// Memoized: the input box and the rest of ChatInterface re-render on every
// keystroke, but a message only changes when its own (store-stable) props do.
// Without this, typing re-parses every message's markdown and the box lags.
export const ChatMessage = memo(function ChatMessage({
  id,
  role,
  content,
  toolsUsed,
  sources,
  charts,
  pendingActions,
  isStreaming,
  error,
}: ChatMessageProps) {
  const confirmAction = useAiChatStore((s) => s.confirmAction);
  const cancelAction = useAiChatStore((s) => s.cancelAction);

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
            <div className="text-sm leading-relaxed">
              <AssistantMarkdown content={content} />
              {isStreaming && (
                <span className="inline-block w-1.5 h-4 ml-0.5 bg-gray-400 dark:bg-gray-500 animate-pulse" />
              )}
            </div>
          )}
        </div>

        {/* Charts emitted by the render_chart tool */}
        {charts && charts.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {charts.map((chart, i) => (
              <ResultChart
                key={i}
                type={chart.type}
                title={chart.title}
                data={chart.data}
              />
            ))}
          </div>
        )}

        {/* Human-in-the-loop write actions the assistant proposed */}
        {pendingActions && pendingActions.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {pendingActions.map((action) => {
              const isBulk =
                action.type === 'create_transactions' ||
                action.type === 'create_investment_transactions' ||
                action.type === 'batch_actions';
              const Card = isBulk
                ? BulkConfirmationCard
                : TransactionConfirmationCard;
              return (
                <Card
                  key={action.actionId}
                  action={action}
                  onConfirm={() => confirmAction(id ?? '', action.actionId)}
                  onCancel={() => cancelAction(id ?? '', action.actionId)}
                />
              );
            })}
          </div>
        )}

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
});
