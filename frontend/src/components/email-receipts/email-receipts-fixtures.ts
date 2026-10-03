import type {
  EmailReceiptDetail,
  EmailReceiptListItem,
  EmailReceiptMailbox,
  EmailReceiptParser,
} from '@/types/email-receipts';

/** A password mailbox as `GET /email-receipts/mailbox` answers it; `overrides` win. */
export function makeMailbox(overrides: Partial<EmailReceiptMailbox> = {}): EmailReceiptMailbox {
  return {
    id: 'mb-1',
    host: 'imap.example.com',
    port: 993,
    security: 'tls',
    username: 'receipts@example.com',
    folder: 'INBOX',
    enabled: true,
    aiMode: 'off',
    autoApply: false,
    passwordSet: true,
    encryptionConfigured: true,
    authMethod: 'password',
    oauthProvider: null,
    oauthConnected: false,
    lastPolledAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** An OAuth mailbox: the host, port and security are the provider's own. */
export function makeOAuthMailbox(overrides: Partial<EmailReceiptMailbox> = {}): EmailReceiptMailbox {
  return makeMailbox({
    host: 'imap.gmail.com',
    username: 'me@gmail.com',
    passwordSet: false,
    authMethod: 'oauth2',
    oauthProvider: 'google',
    oauthConnected: true,
    ...overrides,
  });
}

export function makeParser(overrides: Partial<EmailReceiptParser> = {}): EmailReceiptParser {
  return {
    id: 'p-1',
    name: 'Allegro parser',
    payeeId: 'payee-1',
    fromDomains: ['allegro.pl'],
    subjectContains: [],
    definition: { version: 1, total: ['Total {amount}'] },
    definitionValid: true,
    definitionErrors: [],
    status: 'approved',
    source: 'manual',
    approvedAt: '2026-09-02T10:00:00.000Z',
    revision: 2,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    ...overrides,
  };
}

export function makeReceipt(overrides: Partial<EmailReceiptListItem> = {}): EmailReceiptListItem {
  return {
    id: 'r-1',
    fromAddress: 'orders@allegro.pl',
    fromDomain: 'allegro.pl',
    subject: 'Your order 123',
    receivedAt: '2026-09-01T10:00:00.000Z',
    status: 'unmatched',
    statusReason: null,
    matchKind: null,
    parserId: null,
    parserName: null,
    aiReviewRequestId: null,
    displayState: null,
    requestNote: null,
    transaction: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

export function makeDetail(overrides: Partial<EmailReceiptDetail> = {}): EmailReceiptDetail {
  return {
    ...makeReceipt(),
    bodyText: 'Thank you for your order.\nTotal 25.00',
    parsed: null,
    candidates: [],
    ...overrides,
  };
}

/** A `ParsedReceipt` as the API stores it: amounts in 1/10000 units. */
export const PARSED_RECEIPT = {
  orderId: '123',
  total: 250_000,
  shipping: 50_000,
  discount: null,
  items: [
    { name: 'USB-C cable', qty: 2, amount: 199_800, categoryId: 'cat-1' },
    { name: 'Mystery item', qty: 1, amount: 0, categoryId: null },
  ],
  shippingCategoryId: null,
  discountCategoryId: null,
  complete: false,
  reason: 'items_unbalanced',
};
