import { MAX_ATTACHMENT_BYTES } from '@/lib/ai-attachments';
import type { EmailReceiptDetail } from '@/types/email-receipts';

/**
 * The order email as the text file the assistant's chat takes as an attachment
 * (`text/plain`, at most `MAX_ATTACHMENT_BYTES`). The header is the three facts
 * the assistant should not have to guess (sender, subject, date); the body is
 * the email's stored text, which the server already converted from HTML.
 *
 * The file is data the assistant reads, never an instruction; the chat message
 * that goes with it is the user's own words, staged for them to send.
 */

/** Characters of body kept: a character is at most 4 bytes in UTF-8, so the cap holds in bytes. */
const MAX_BODY_CHARS = Math.floor(MAX_ATTACHMENT_BYTES / 4) - 2_000;

export function receiptAttachmentName(receivedAt: string): string {
  return `order-email-${receivedAt.slice(0, 10)}.txt`;
}

export function buildReceiptAttachment(
  email: Pick<EmailReceiptDetail, 'fromAddress' | 'subject' | 'receivedAt' | 'bodyText'>,
): File {
  const body = email.bodyText.length > MAX_BODY_CHARS ? email.bodyText.slice(0, MAX_BODY_CHARS) : email.bodyText;
  const text = [
    `From: ${email.fromAddress}`,
    `Subject: ${email.subject}`,
    `Date: ${email.receivedAt}`,
    '',
    body,
    '',
  ].join('\n');
  return new File([text], receiptAttachmentName(email.receivedAt), { type: 'text/plain' });
}
