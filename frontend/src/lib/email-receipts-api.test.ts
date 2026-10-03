import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emailReceiptsApi } from './email-receipts-api';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('./api', () => ({ default: client }));

describe('emailReceiptsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mailbox', () => {
    it('reads the mailbox, and an empty body is "no mailbox"', async () => {
      client.get.mockResolvedValueOnce({ data: '' });
      expect(await emailReceiptsApi.mailbox.get()).toBeNull();
      expect(client.get).toHaveBeenCalledWith('/email-receipts/mailbox');

      const mailbox = { id: 'mb-1', host: 'imap.example.com' };
      client.get.mockResolvedValueOnce({ data: mailbox });
      expect(await emailReceiptsApi.mailbox.get()).toBe(mailbox);
    });

    it('replaces the mailbox with a PUT of the whole configuration', async () => {
      const payload = {
        host: 'imap.example.com',
        port: 993,
        security: 'tls' as const,
        username: 'me',
        enabled: true,
        aiMode: 'off' as const,
        autoApply: false,
      };
      client.put.mockResolvedValue({ data: { id: 'mb-1' } });
      expect(await emailReceiptsApi.mailbox.upsert(payload)).toEqual({ id: 'mb-1' });
      expect(client.put).toHaveBeenCalledWith('/email-receipts/mailbox', payload);
    });

    it('changes settings with a PATCH to /settings', async () => {
      client.patch.mockResolvedValue({ data: { id: 'mb-1', enabled: false } });
      await emailReceiptsApi.mailbox.updateSettings({ enabled: false });
      expect(client.patch).toHaveBeenCalledWith('/email-receipts/mailbox/settings', { enabled: false });
    });

    it('deletes, tests and polls', async () => {
      client.delete.mockResolvedValue({});
      await emailReceiptsApi.mailbox.remove();
      expect(client.delete).toHaveBeenCalledWith('/email-receipts/mailbox');

      client.post.mockResolvedValueOnce({ data: { ok: true, messages: 3 } });
      expect(await emailReceiptsApi.mailbox.test({ host: 'h' })).toEqual({ ok: true, messages: 3 });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/mailbox/test', { host: 'h' });

      client.post.mockResolvedValueOnce({ data: { ok: true, fetched: 1, skipped: 0, processed: 1 } });
      await emailReceiptsApi.mailbox.pollNow();
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/mailbox/poll');
    });

    it('tests the stored settings when given no draft', async () => {
      client.post.mockResolvedValue({ data: { ok: false, error: 'nope' } });
      await emailReceiptsApi.mailbox.test();
      expect(client.post).toHaveBeenCalledWith('/email-receipts/mailbox/test', {});
    });
  });

  describe('oauth', () => {
    it('lists the providers the operator configured', async () => {
      client.get.mockResolvedValue({ data: { google: true, microsoft: false, redirectUri: 'https://x/cb' } });
      expect(await emailReceiptsApi.oauth.providers()).toEqual({
        google: true,
        microsoft: false,
        redirectUri: 'https://x/cb',
      });
      expect(client.get).toHaveBeenCalledWith('/email-receipts/mailbox/oauth/providers');
    });

    it('starts, completes and disconnects', async () => {
      client.post.mockResolvedValueOnce({ data: { authorizationUrl: 'https://accounts.example/auth' } });
      expect(await emailReceiptsApi.oauth.start('google')).toEqual({ authorizationUrl: 'https://accounts.example/auth' });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/mailbox/oauth/start', { provider: 'google' });

      client.post.mockResolvedValueOnce({ data: { id: 'mb-1' } });
      await emailReceiptsApi.oauth.complete('the-code', 'the-state');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/mailbox/oauth/complete', {
        code: 'the-code',
        state: 'the-state',
      });

      client.delete.mockResolvedValue({});
      await emailReceiptsApi.oauth.disconnect();
      expect(client.delete).toHaveBeenCalledWith('/email-receipts/mailbox/oauth');
    });
  });

  describe('receipts', () => {
    it('lists with an optional status and limit, sending no params when there are none', async () => {
      client.get.mockResolvedValue({ data: [] });
      await emailReceiptsApi.receipts.list();
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', { params: undefined });
      await emailReceiptsApi.receipts.list('unmatched', 20);
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts', { params: { status: 'unmatched', limit: 20 } });
    });

    it('addresses one email by id', async () => {
      client.get.mockResolvedValue({ data: { id: 'r-1' } });
      await emailReceiptsApi.receipts.get('r-1');
      expect(client.get).toHaveBeenLastCalledWith('/email-receipts/r-1');

      client.post.mockResolvedValue({ data: {} });
      await emailReceiptsApi.receipts.reprocess('r-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/reprocess');
      await emailReceiptsApi.receipts.link('r-1', 'tx-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/link', { transactionId: 'tx-1' });
      await emailReceiptsApi.receipts.ignore('r-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/ignore');
      await emailReceiptsApi.receipts.askAi('r-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/ask-ai', {});
      await emailReceiptsApi.receipts.askAi('r-1', 'tx-9');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/ask-ai', { transactionId: 'tx-9' });
      await emailReceiptsApi.receipts.draftParser('r-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipts/r-1/draft-parser');

      client.delete.mockResolvedValue({});
      await emailReceiptsApi.receipts.remove('r-1');
      expect(client.delete).toHaveBeenCalledWith('/email-receipts/r-1');
    });
  });

  describe('parsers', () => {
    const definition = { version: 1 as const, total: ['Total {amount}'] };

    it('lists, reads, creates, updates and deletes', async () => {
      client.get.mockResolvedValue({ data: [] });
      await emailReceiptsApi.parsers.list();
      expect(client.get).toHaveBeenLastCalledWith('/email-receipt-parsers');
      await emailReceiptsApi.parsers.get('p-1');
      expect(client.get).toHaveBeenLastCalledWith('/email-receipt-parsers/p-1');

      client.post.mockResolvedValue({ data: { id: 'p-1' } });
      await emailReceiptsApi.parsers.create({ name: 'Shop', fromDomains: ['shop.example'], definition });
      expect(client.post).toHaveBeenLastCalledWith('/email-receipt-parsers', {
        name: 'Shop',
        fromDomains: ['shop.example'],
        definition,
      });

      client.patch.mockResolvedValue({ data: { id: 'p-1' } });
      await emailReceiptsApi.parsers.update('p-1', { name: 'Shop 2', expectedRevision: 3 });
      expect(client.patch).toHaveBeenCalledWith('/email-receipt-parsers/p-1', { name: 'Shop 2', expectedRevision: 3 });

      client.delete.mockResolvedValue({});
      await emailReceiptsApi.parsers.remove('p-1');
      expect(client.delete).toHaveBeenCalledWith('/email-receipt-parsers/p-1');
    });

    it('approves with the revision the person read, when there is one', async () => {
      client.post.mockResolvedValue({ data: { id: 'p-1' } });
      await emailReceiptsApi.parsers.approve('p-1', 4);
      expect(client.post).toHaveBeenLastCalledWith('/email-receipt-parsers/p-1/approve', { expectedRevision: 4 });
      await emailReceiptsApi.parsers.approve('p-1');
      expect(client.post).toHaveBeenLastCalledWith('/email-receipt-parsers/p-1/approve', {});
    });

    it('tests a definition against a stored email', async () => {
      client.post.mockResolvedValue({ data: { candidateCount: 0 } });
      await emailReceiptsApi.parsers.test({ definition, receiptId: 'r-1' });
      expect(client.post).toHaveBeenCalledWith('/email-receipt-parsers/test', { definition, receiptId: 'r-1' });
    });
  });
});
