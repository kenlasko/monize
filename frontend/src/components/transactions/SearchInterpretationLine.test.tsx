import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { SearchInterpretationLine } from './SearchInterpretationLine';
import { SearchTermEcho } from '@/types/transaction';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatNumber: (n: number, decimals = 2) => n.toFixed(decimals),
    }),
  };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (iso: string) => `D(${iso})` }),
}));

const term = (overrides: Partial<SearchTermEcho>): SearchTermEcho => ({
  field: 'any',
  op: 'contains',
  value: '',
  negated: false,
  raw: '',
  ...overrides,
});

describe('SearchInterpretationLine', () => {
  it('renders nothing without an interpretation, as from an older server', () => {
    const { container } = render(<SearchInterpretationLine interpretation={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each<[SearchTermEcho, string]>([
    [term({ value: 'costco', raw: 'costco' }), '“costco” anywhere'],
    [term({ field: 'ref', op: 'exact', value: '10', raw: '#10' }), 'Reference is “10”'],
    [term({ field: 'payee', op: 'contains', value: 'cost' }), 'Payee contains “cost”'],
    [term({ field: 'ref', op: 'glob', value: '10*' }), 'Reference matches “10*”'],
    [term({ field: 'amount', op: 'gt', value: '100' }), 'Amount over 100.00'],
    [term({ field: 'amount', op: 'lte', value: '5' }), 'Amount 5.00 or less'],
    [term({ field: 'amount', op: 'eq', value: '12.345' }), 'Amount is 12.345'],
    [
      term({ field: 'amount', op: 'between', value: '50', valueTo: '100' }),
      'Amount from 50.00 to 100.00',
    ],
    [term({ field: 'date', op: 'eq', value: '2026-03-15' }), 'Date is D(2026-03-15)'],
    [term({ field: 'date', op: 'gte', value: '2026-03-01' }), 'Date D(2026-03-01) or more'],
    [term({ field: 'status', op: 'eq', value: 'cleared' }), 'Status is Cleared'],
    [term({ field: 'is', op: 'eq', value: 'split' }), 'Split transactions'],
    [term({ field: 'is', op: 'eq', value: 'provisional' }), 'Estimated amounts'],
    [
      term({ field: 'is', op: 'eq', value: 'provisional', negated: true }),
      'not Estimated amounts',
    ],
    [term({ field: 'has', op: 'eq', value: 'attachment' }), 'Has an attachment'],
    [term({ field: 'has', op: 'eq', value: 'warranty' }), 'Has a warranty'],
    [
      term({ field: 'cat', op: 'contains', value: 'transfer', negated: true }),
      'not Category contains “transfer”',
    ],
  ])('describes %o', (echo, text) => {
    render(<SearchInterpretationLine interpretation={{ terms: [echo] }} />);
    expect(screen.getByRole('listitem')).toHaveTextContent(text);
  });

  it('strikes through a term the server could not use, with the reason', () => {
    render(
      <SearchInterpretationLine
        interpretation={{
          terms: [
            term({ value: 'status:pending', raw: 'status:pending', ignored: 'malformed' }),
            term({ field: 'ref', raw: 'ref:', ignored: 'empty' }),
          ],
        }}
      />,
    );
    const [malformed, empty] = screen.getAllByRole('listitem');
    expect(malformed).toHaveTextContent('status:pending (not understood, searched as text)');
    expect(malformed).toHaveClass('line-through');
    expect(empty).toHaveTextContent('ref: (empty, ignored)');
  });

  it('labels the line and announces changes politely', () => {
    render(<SearchInterpretationLine interpretation={{ terms: [term({ value: 'a', raw: 'a' })] }} />);
    expect(screen.getByRole('list', { name: 'Searching:' })).toBeInTheDocument();
    expect(screen.getByText('Searching:').parentElement).toHaveAttribute('aria-live', 'polite');
  });
});
