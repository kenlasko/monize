import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { ReceiptStateBadge } from './ReceiptStateBadge';
import { EMAIL_RECEIPT_SHOWN_STATES } from '@/lib/email-receipts-format';
import en from '@/i18n/messages/en/emailReceipts.json';

describe('ReceiptStateBadge', () => {
  it('names the status of an email that is not in review', () => {
    render(<ReceiptStateBadge receipt={{ status: 'no_parser', displayState: null }} />);
    expect(screen.getByText('No parser')).toBeInTheDocument();
  });

  it('names what the request says for an email in review', () => {
    render(<ReceiptStateBadge receipt={{ status: 'review', displayState: 'proposed' }} />);
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
  });

  it('does not show a review email with no request state as waiting for approval', () => {
    render(<ReceiptStateBadge receipt={{ status: 'review', displayState: null }} />);
    expect(screen.getByText('Request missing')).toBeInTheDocument();
  });

  it('has a label for every state an email can be shown in', () => {
    const labels = en.state as Record<string, string>;
    for (const state of EMAIL_RECEIPT_SHOWN_STATES) {
      expect(labels[state], `no label for ${state}`).toBeTruthy();
    }
  });
});
