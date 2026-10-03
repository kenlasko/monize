import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@/test/render';
import { ParsedReceiptView } from './ParsedReceiptView';
import { PARSED_RECEIPT } from './email-receipts-fixtures';
import { readParsedReceipt } from '@/lib/email-receipts-format';
import type { ParsedReceipt } from '@/types/email-receipts';

const parsed = readParsedReceipt(PARSED_RECEIPT) as ParsedReceipt;
const labels = new Map([['cat-1', 'Electronics: Cables']]);

describe('ParsedReceiptView', () => {
  it('divides every 1/10000 amount by 10000 exactly once', () => {
    render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    // total 250000 -> 25.00, shipping 50000 -> 5.00, cable line 199800 -> 19.98
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$25.00');
    expect(screen.getByText('Shipping').nextElementSibling).toHaveTextContent('$5.00');
    const row = screen.getByRole('row', { name: /USB-C cable/ });
    expect(within(row).getByText('$19.98')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(screen.queryByText(/250,000|199,800|\$250000|19980/)).not.toBeInTheDocument();
  });

  it('shows a figure the email did not state as "Not found", never as a zero', () => {
    render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Discount').nextElementSibling).toHaveTextContent('Not found');
  });

  it('shows a stated zero as a number', () => {
    const free = { ...parsed, shipping: 0 };
    render(<ParsedReceiptView parsed={free} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Shipping').nextElementSibling).toHaveTextContent('$0.00');
  });

  it('names categories, and says so for one that is missing or unknown', () => {
    const { rerender } = render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Electronics: Cables')).toBeInTheDocument();
    expect(screen.getByText('No category')).toBeInTheDocument();

    rerender(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={new Map()} />);
    expect(screen.getByText('Unknown category')).toBeInTheDocument();

    rerender(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={null} />);
    expect(screen.getByText('Categories not loaded')).toBeInTheDocument();
    expect(screen.queryByText('Unknown category')).not.toBeInTheDocument();
  });

  it('says whether the read is complete, and why not', () => {
    const { rerender } = render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Not read completely')).toBeInTheDocument();
    expect(screen.getByText('The line items do not add up to the total.')).toBeInTheDocument();

    rerender(<ParsedReceiptView parsed={{ ...parsed, complete: true, reason: null }} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Read completely')).toBeInTheDocument();
    expect(screen.queryByText(/do not add up/)).not.toBeInTheDocument();
  });

  it('says so when no item was read', () => {
    render(<ParsedReceiptView parsed={{ ...parsed, items: [] }} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('No line items were read.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says when the AI read the email, and says nothing for a parser', () => {
    const { rerender } = render(
      <ParsedReceiptView parsed={{ ...parsed, source: 'ai' }} currencyCode="USD" categoryLabels={labels} />,
    );
    expect(screen.getByText('Read by the AI')).toBeInTheDocument();

    rerender(<ParsedReceiptView parsed={{ ...parsed, source: 'parser' }} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.queryByText('Read by the AI')).not.toBeInTheDocument();
    rerender(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.queryByText('Read by the AI')).not.toBeInTheDocument();
  });
});
