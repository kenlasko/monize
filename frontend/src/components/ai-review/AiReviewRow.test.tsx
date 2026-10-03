import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { AiReviewRow } from './AiReviewRow';
import { makeReviewItem } from './ai-review-fixtures';
import type { AiReviewItem } from '@/types/ai-review';

function renderRow(item: AiReviewItem) {
  return render(
    <table>
      <tbody>
        <AiReviewRow item={item} dismissing={false} onApprove={vi.fn()} onDismiss={vi.fn()} />
      </tbody>
    </table>,
  );
}

const emailReceiptItem = (overrides: Partial<AiReviewItem> = {}) =>
  makeReviewItem({
    kind: 'email_receipt',
    ruleId: null,
    ruleName: null,
    instruction: 'Enrich this transaction from the order email',
    emailReceipt: {
      id: 'r-1',
      fromAddress: 'orders@allegro.pl',
      subject: 'Your order 123',
      receivedAt: '2026-09-01T10:00:00.000Z',
    },
    ...overrides,
  });

describe('AiReviewRow', () => {
  it('names the rule for a request a rule raised', () => {
    renderRow(makeReviewItem());
    expect(screen.getByText('Rule: Allegro orders')).toBeInTheDocument();
    expect(screen.queryByText(/Email receipt/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View email receipts' })).not.toBeInTheDocument();
  });

  it('says it was requested manually for a request with neither rule nor email', () => {
    renderRow(makeReviewItem({ ruleId: null, ruleName: null }));
    expect(screen.getByText('Requested manually')).toBeInTheDocument();
  });

  it('shows the subject and sender of the email instead of the rule or manual line', () => {
    renderRow(emailReceiptItem());
    expect(screen.getByText(/Email receipt: Your order 123 from orders@allegro\.pl/)).toBeInTheDocument();
    expect(screen.queryByText('Requested manually')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Rule:/)).not.toBeInTheDocument();
  });

  it('links to the receipts page from an email receipt row', () => {
    renderRow(emailReceiptItem());
    expect(screen.getByRole('link', { name: 'View email receipts' })).toHaveAttribute('href', '/email-receipts');
  });

  it('shows the email as it is, as plain text', () => {
    const { container } = renderRow(
      emailReceiptItem({
        emailReceipt: { id: 'r-1', fromAddress: 'x@y.example', subject: '<b>Hi</b>', receivedAt: '2026-09-01T10:00:00.000Z' },
      }),
    );
    expect(screen.getByText(/Email receipt: <b>Hi<\/b> from x@y\.example/)).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it('says the email was deleted when the request outlived it, and still links to the receipts page', () => {
    renderRow(emailReceiptItem({ emailReceipt: null }));
    expect(screen.getByText(/Email receipt \(the email was deleted\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View email receipts' })).toBeInTheDocument();
  });

  it('keeps the transaction link and the instruction on an email receipt row', () => {
    renderRow(emailReceiptItem());
    expect(screen.getByText('Enrich this transaction from the order email')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View transaction' })).toHaveAttribute(
      'href',
      '/transactions?targetTransactionId=tx-1',
    );
  });

  describe('a pending email receipt request', () => {
    it('says it waits for an AI agent and links to the AI settings', () => {
      renderRow(emailReceiptItem({ status: 'pending' }));
      expect(screen.getByText(/Waiting for an AI agent\./)).toBeInTheDocument();
      expect(screen.getByText(/or let an MCP client claim it\./)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Connect an AI provider in Settings' })).toHaveAttribute(
        'href',
        '/settings/ai',
      );
    });

    it.each(['claimed', 'proposed', 'applied', 'rejected', 'expired'] as const)(
      'says nothing about waiting once the request is %s',
      (status) => {
        renderRow(emailReceiptItem({ status }));
        expect(screen.queryByText(/Waiting for an AI agent/)).not.toBeInTheDocument();
      },
    );

    it('says nothing for a pending request a rule raised', () => {
      renderRow(makeReviewItem({ status: 'pending' }));
      expect(screen.queryByText(/Waiting for an AI agent/)).not.toBeInTheDocument();
    });
  });
});
