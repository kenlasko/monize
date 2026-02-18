import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { ChatMessage } from './ChatMessage';

describe('ChatMessage', () => {
  describe('user messages', () => {
    it('renders user message content', () => {
      render(<ChatMessage role="user" content="How much did I spend?" />);
      expect(
        screen.getByText('How much did I spend?'),
      ).toBeInTheDocument();
    });

    it('preserves whitespace in user messages', () => {
      render(<ChatMessage role="user" content={'Line 1\nLine 2'} />);
      const el = screen.getByText((_content, element) =>
        element?.tagName === 'P' && element?.textContent === 'Line 1\nLine 2',
      );
      expect(el).toBeInTheDocument();
      expect(el.className).toContain('whitespace-pre-wrap');
    });
  });

  describe('assistant messages', () => {
    it('renders assistant message content', () => {
      render(
        <ChatMessage
          role="assistant"
          content="You spent $3,000 last month."
        />,
      );
      expect(
        screen.getByText('You spent $3,000 last month.'),
      ).toBeInTheDocument();
    });

    it('shows streaming cursor when isStreaming is true', () => {
      const { container } = render(
        <ChatMessage role="assistant" content="Loading..." isStreaming />,
      );
      const cursor = container.querySelector('.animate-pulse');
      expect(cursor).toBeInTheDocument();
    });

    it('does not show streaming cursor when isStreaming is false', () => {
      const { container } = render(
        <ChatMessage role="assistant" content="Done." isStreaming={false} />,
      );
      const cursor = container.querySelector('.animate-pulse');
      expect(cursor).toBeNull();
    });

    it('shows error message when error prop is provided', () => {
      render(
        <ChatMessage
          role="assistant"
          content=""
          error="No AI provider configured"
        />,
      );
      expect(
        screen.getByText('No AI provider configured'),
      ).toBeInTheDocument();
    });

    it('shows error instead of content when both provided', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Some content"
          error="Error occurred"
        />,
      );
      expect(screen.getByText('Error occurred')).toBeInTheDocument();
      expect(screen.queryByText('Some content')).not.toBeInTheDocument();
    });
  });

  describe('tool badges', () => {
    it('renders tool badges with friendly labels', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Here are your results."
          toolsUsed={[
            {
              name: 'query_transactions',
              summary: 'Found 45 transactions',
            },
            {
              name: 'get_account_balances',
              summary: '3 accounts found',
            },
          ]}
        />,
      );

      expect(screen.getByText('Transactions')).toBeInTheDocument();
      expect(screen.getByText('Account Balances')).toBeInTheDocument();
    });

    it('falls back to raw tool name for unknown tools', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Results."
          toolsUsed={[
            { name: 'unknown_tool', summary: 'Did something' },
          ]}
        />,
      );

      expect(screen.getByText('unknown_tool')).toBeInTheDocument();
    });

    it('renders all known tool labels correctly', () => {
      const tools = [
        { name: 'query_transactions', expected: 'Transactions' },
        { name: 'get_account_balances', expected: 'Account Balances' },
        { name: 'get_spending_by_category', expected: 'Spending by Category' },
        { name: 'get_income_summary', expected: 'Income Summary' },
        { name: 'get_net_worth_history', expected: 'Net Worth History' },
        { name: 'compare_periods', expected: 'Period Comparison' },
      ];

      render(
        <ChatMessage
          role="assistant"
          content="All tools."
          toolsUsed={tools.map((t) => ({
            name: t.name,
            summary: 'summary',
          }))}
        />,
      );

      for (const tool of tools) {
        expect(screen.getByText(tool.expected)).toBeInTheDocument();
      }
    });

    it('does not show tool badges when toolsUsed is empty', () => {
      render(
        <ChatMessage role="assistant" content="No tools." toolsUsed={[]} />,
      );

      // Should not have any badge elements
      expect(screen.queryByText('Transactions')).not.toBeInTheDocument();
      expect(
        screen.queryByText('Account Balances'),
      ).not.toBeInTheDocument();
    });

    it('does not show tool badges for user messages', () => {
      render(
        <ChatMessage
          role="user"
          content="My query"
          toolsUsed={[
            { name: 'query_transactions', summary: 'test' },
          ]}
        />,
      );

      expect(screen.queryByText('Transactions')).not.toBeInTheDocument();
    });

    it('shows tool summary in title attribute', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Results."
          toolsUsed={[
            {
              name: 'query_transactions',
              summary: 'Found 45 transactions from Jan to Feb',
            },
          ]}
        />,
      );

      const badge = screen.getByText('Transactions');
      expect(badge.closest('[title]')?.getAttribute('title')).toBe(
        'Found 45 transactions from Jan to Feb',
      );
    });
  });

  describe('sources', () => {
    it('renders source descriptions', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Answer."
          sources={[
            {
              type: 'transactions',
              description: 'Transaction summary',
              dateRange: '2026-01-01 to 2026-01-31',
            },
          ]}
        />,
      );

      expect(screen.getByText(/Transaction summary/)).toBeInTheDocument();
      expect(
        screen.getByText(/2026-01-01 to 2026-01-31/),
      ).toBeInTheDocument();
    });

    it('renders multiple sources with separators', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Answer."
          sources={[
            {
              type: 'transactions',
              description: 'Transactions',
            },
            {
              type: 'accounts',
              description: 'Account balances',
            },
          ]}
        />,
      );

      expect(screen.getByText(/Transactions/)).toBeInTheDocument();
      expect(screen.getByText(/Account balances/)).toBeInTheDocument();
    });

    it('does not show sources section when sources is empty', () => {
      render(
        <ChatMessage role="assistant" content="Answer." sources={[]} />,
      );

      // No sources container should be rendered
      expect(screen.queryByText(/·/)).not.toBeInTheDocument();
    });

    it('shows source without dateRange', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Answer."
          sources={[
            { type: 'accounts', description: 'All account balances' },
          ]}
        />,
      );

      expect(
        screen.getByText('All account balances'),
      ).toBeInTheDocument();
    });
  });
});
