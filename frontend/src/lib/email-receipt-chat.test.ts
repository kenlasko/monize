import { describe, it, expect } from 'vitest';
import { MAX_ATTACHMENT_BYTES, resolveMediaType } from './ai-attachments';
import { buildReceiptAttachment, receiptAttachmentName } from './email-receipt-chat';

const email = {
  fromAddress: 'orders@shop.example.com',
  subject: 'Your order ABCD1234',
  receivedAt: '2026-09-10T10:00:00.000Z',
  bodyText: 'Widget 12.00\nOrder total: 15.00',
};

describe('receiptAttachmentName', () => {
  it('is order-email-YYYY-MM-DD.txt from the day the email arrived', () => {
    expect(receiptAttachmentName('2026-09-10T23:59:59.000Z')).toBe('order-email-2026-09-10.txt');
  });
});

describe('buildReceiptAttachment', () => {
  it('is a text/plain file the chat accepts, holding From, Subject, Date and the body', async () => {
    const file = buildReceiptAttachment(email);
    expect(file.name).toBe('order-email-2026-09-10.txt');
    expect(file.type).toBe('text/plain');
    expect(resolveMediaType(file)).toBe('text/plain');
    expect(await file.text()).toBe(
      [
        'From: orders@shop.example.com',
        'Subject: Your order ABCD1234',
        'Date: 2026-09-10T10:00:00.000Z',
        '',
        'Widget 12.00\nOrder total: 15.00',
        '',
      ].join('\n'),
    );
  });

  it('cuts a body so the file stays within the attachment limit, even in 4-byte characters', () => {
    const file = buildReceiptAttachment({ ...email, bodyText: '\u{1F600}'.repeat(2_000_000) });
    expect(file.size).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES);
    expect(file.size).toBeGreaterThan(MAX_ATTACHMENT_BYTES / 4);
  });
});
