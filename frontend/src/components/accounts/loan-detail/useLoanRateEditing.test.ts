import { describe, it, expect } from 'vitest';
import { buildScheduledUpdateMessage } from './useLoanRateEditing';
import { ScheduledPaymentPreview } from '@/types/loan-rate-change';

const formatDate = (date: Date | string) => String(date);
const formatCurrency = (value: number) => value.toFixed(2);
const t = (key: string, values?: Record<string, string | number>) =>
  `${key}:${JSON.stringify(values ?? {})}`;

const basePreview: ScheduledPaymentPreview = {
  scheduledTransactionId: 'sched-1',
  scheduledTransactionName: 'Mortgage',
  currencyCode: 'CAD',
  dueDate: '2023-02-03',
  currentPaymentAmount: 584.59,
  proposedPaymentAmount: 584.59,
  currentPrincipal: 167.92,
  proposedPrincipal: 167.92,
  currentInterest: 416.67,
  proposedInterest: 416.67,
  extraPrincipal: 0,
  upcomingPaymentChanges: [],
};

describe('buildScheduledUpdateMessage', () => {
  it('returns an empty string when there is no preview', () => {
    expect(buildScheduledUpdateMessage(null, { t, formatDate, formatCurrency })).toBe('');
  });

  it('names the due date as unchanged when the sync would not move the payment', () => {
    const message = buildScheduledUpdateMessage(basePreview, { t, formatDate, formatCurrency });
    expect(message).toContain('scheduledUpdateNextPaymentUnchanged');
    expect(message).toContain('"date":"2023-02-03"');
    expect(message).toContain('"payment":"584.59"');
  });

  it('shows a before/after figure when the sync would move the payment', () => {
    const preview: ScheduledPaymentPreview = {
      ...basePreview,
      currentPaymentAmount: 560,
      proposedPaymentAmount: 584.59,
    };
    const message = buildScheduledUpdateMessage(preview, { t, formatDate, formatCurrency });
    expect(message).toContain('scheduledUpdateNextPaymentChanged');
    expect(message).toContain('"before":"560.00"');
    expect(message).toContain('"after":"584.59"');
  });

  it('shows only the proposed figure when no current payment is known', () => {
    const preview: ScheduledPaymentPreview = { ...basePreview, currentPaymentAmount: null };
    const message = buildScheduledUpdateMessage(preview, { t, formatDate, formatCurrency });
    expect(message).toContain('scheduledUpdateNextPaymentNew');
  });

  // Timeline A of docs/specs/scheduled-loan-installment-pricing.md 7.5: the
  // bill becomes 560.00 from 2023-05-03.
  it('appends the upcoming-change line when the timeline states a later payment', () => {
    const preview: ScheduledPaymentPreview = {
      ...basePreview,
      upcomingPaymentChanges: [{ dueDate: '2023-05-03', paymentAmount: 560 }],
    };
    const message = buildScheduledUpdateMessage(preview, { t, formatDate, formatCurrency });
    expect(message).toContain('scheduledUpdateUpcomingChange');
    expect(message).toContain('"date":"2023-05-03"');
    expect(message).toContain('"amount":"560.00"');
  });

  // A second change added after Timeline A: the message names both later
  // payments, not the first one twice.
  it('appends one upcoming-change line per later payment, in date order', () => {
    const preview: ScheduledPaymentPreview = {
      ...basePreview,
      upcomingPaymentChanges: [
        { dueDate: '2023-05-03', paymentAmount: 560 },
        { dueDate: '2023-09-03', paymentAmount: 575 },
      ],
    };
    const message = buildScheduledUpdateMessage(preview, { t, formatDate, formatCurrency });
    const first = message.indexOf('"date":"2023-05-03","amount":"560.00"');
    const second = message.indexOf('"date":"2023-09-03","amount":"575.00"');
    expect(message.split('scheduledUpdateUpcomingChange')).toHaveLength(3);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it('omits the upcoming-change line when the timeline states no later payment', () => {
    const message = buildScheduledUpdateMessage(basePreview, { t, formatDate, formatCurrency });
    expect(message).not.toContain('scheduledUpdateUpcomingChange');
  });
});
