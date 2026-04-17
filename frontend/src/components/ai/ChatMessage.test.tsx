import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { ChatMessage } from './ChatMessage';

// Mock recharts so the ResultChart rendered indirectly by ChatMessage does
// not attempt to lay out SVG in jsdom. Matches the mocks in ResultChart.test.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: () => null,
  PieChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  AreaChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="area-chart">{children}</div>
  ),
  Area: () => null,
}));

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

    it('renders markdown formatting in assistant content', () => {
      const { container } = render(
        <ChatMessage
          role="assistant"
          content="You spent **$3,000** on *groceries* last month."
        />,
      );
      const strong = container.querySelector('strong');
      const em = container.querySelector('em');
      expect(strong?.textContent).toBe('$3,000');
      expect(em?.textContent).toBe('groceries');
    });

    it('renders markdown lists in assistant content', () => {
      const { container } = render(
        <ChatMessage
          role="assistant"
          content={'Top categories:\n\n- Groceries\n- Dining\n- Gas'}
        />,
      );
      const ul = container.querySelector('ul');
      expect(ul).not.toBeNull();
      expect(container.querySelectorAll('li')).toHaveLength(3);
    });

    it('does not apply markdown formatting to user messages', () => {
      const { container } = render(
        <ChatMessage role="user" content="I want **bold** text" />,
      );
      expect(container.querySelector('strong')).toBeNull();
      expect(
        screen.getByText('I want **bold** text'),
      ).toBeInTheDocument();
    });

    it('still shows streaming cursor alongside markdown content', () => {
      const { container } = render(
        <ChatMessage
          role="assistant"
          content="**Loading**"
          isStreaming
        />,
      );
      expect(container.querySelector('strong')?.textContent).toBe('Loading');
      expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
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

    it('shows a success checkmark by default', () => {
      render(
        <ChatMessage
          role="assistant"
          content="ok"
          toolsUsed={[{ name: 'query_transactions', summary: 'Found 1' }]}
        />,
      );
      expect(screen.getByLabelText('Tool succeeded')).toBeInTheDocument();
      expect(screen.queryByLabelText('Tool failed')).not.toBeInTheDocument();
    });

    it('shows a red X and red-themed container when the tool errored', () => {
      const { container } = render(
        <ChatMessage
          role="assistant"
          content="ok"
          toolsUsed={[
            {
              name: 'query_transactions',
              summary: 'Invalid input for query_transactions: ...',
              isError: true,
            },
          ]}
        />,
      );
      expect(screen.getByLabelText('Tool failed')).toBeInTheDocument();
      expect(screen.queryByLabelText('Tool succeeded')).not.toBeInTheDocument();
      // The surrounding container uses the red theme.
      const errored = container.querySelector('.border-red-200');
      expect(errored).not.toBeNull();
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

    it('expands to reveal input and result when the tool button is clicked', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Results."
          toolsUsed={[
            {
              name: 'query_transactions',
              summary: 'Found 45 transactions from Jan to Feb',
              input: {
                startDate: '2026-01-01',
                endDate: '2026-02-28',
              },
            },
          ]}
        />,
      );

      // Collapsed by default — details are not in the DOM yet
      expect(screen.queryByText('Input')).not.toBeInTheDocument();
      expect(screen.queryByText('Result')).not.toBeInTheDocument();

      const toggle = screen.getByRole('button', { name: /Transactions/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Input')).toBeInTheDocument();
      expect(screen.getByText('Result')).toBeInTheDocument();
      expect(screen.getByText(/2026-01-01/)).toBeInTheDocument();
      expect(
        screen.getByText('Found 45 transactions from Jan to Feb'),
      ).toBeInTheDocument();
    });

    it('disables expand toggle when there is no input and no summary', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Results."
          toolsUsed={[{ name: 'query_transactions', summary: '' }]}
        />,
      );

      const toggle = screen.getByRole('button', { name: /Transactions/i });
      expect(toggle).toBeDisabled();
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

  describe('charts', () => {
    const sampleChart = {
      type: 'bar' as const,
      title: 'Spending by Category',
      data: [
        { label: 'Groceries', value: 500 },
        { label: 'Dining', value: 250 },
      ],
    };

    it('renders a ResultChart when charts are provided', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Here is the breakdown."
          charts={[sampleChart]}
        />,
      );

      expect(screen.getByText('Spending by Category')).toBeInTheDocument();
      expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    });

    it('renders multiple charts in order', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Two views."
          charts={[
            { ...sampleChart, type: 'pie', title: 'Pie View' },
            { ...sampleChart, type: 'area', title: 'Trend View' },
          ]}
        />,
      );

      expect(screen.getByText('Pie View')).toBeInTheDocument();
      expect(screen.getByText('Trend View')).toBeInTheDocument();
      expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });

    it('does not render a chart container when charts is empty', () => {
      render(
        <ChatMessage role="assistant" content="No chart." charts={[]} />,
      );

      expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
      expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
      expect(screen.queryByTestId('area-chart')).not.toBeInTheDocument();
    });

    it('does not render a chart container when charts is undefined', () => {
      render(<ChatMessage role="assistant" content="No chart." />);

      expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
    });

    it('does not render charts for user messages', () => {
      render(
        <ChatMessage
          role="user"
          content="My query"
          charts={[sampleChart]}
        />,
      );

      expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
      expect(screen.queryByText('Spending by Category')).not.toBeInTheDocument();
    });

    it('renders the render_chart tool badge label correctly', () => {
      render(
        <ChatMessage
          role="assistant"
          content="Chart rendered."
          toolsUsed={[
            {
              name: 'render_chart',
              summary: 'Rendered bar chart "Spending" with 5 data points.',
            },
          ]}
        />,
      );

      expect(screen.getByText('Chart')).toBeInTheDocument();
    });
  });
});
