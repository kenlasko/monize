import apiClient from './api';
import type {
  CreateEmailReceiptParserPayload,
  EmailReceiptAskAiResult,
  EmailReceiptDetail,
  EmailReceiptListItem,
  EmailReceiptMailbox,
  EmailReceiptMailboxTestResult,
  EmailReceiptOAuthProvider,
  EmailReceiptOAuthProviders,
  EmailReceiptParser,
  EmailReceiptParserTestResult,
  EmailReceiptPollResult,
  EmailReceiptStatus,
  TestEmailReceiptMailboxPayload,
  TestEmailReceiptParserPayload,
  UpdateEmailReceiptMailboxSettingsPayload,
  UpdateEmailReceiptParserPayload,
  UpsertEmailReceiptMailboxPayload,
} from '@/types/email-receipts';

/**
 * Email receipts: the mailbox, its OAuth login, the stored emails and the
 * parsers that read them. Deliberately uncached, like `aiReviewApi`: the poll
 * runs on the server's schedule and a receipt's state changes under the page
 * (a poll stores mail, an approval closes a request), so a cached list would
 * offer an action for a state the email has already left.
 *
 * Nothing here moves money. A proposal is committed from the review inbox by
 * `aiApi.confirmAction`, which owns the cache invalidation for it.
 */

const MAILBOX = '/email-receipts/mailbox';
const RECEIPTS = '/email-receipts';
const PARSERS = '/email-receipt-parsers';

/** A mailbox answer is a view object; anything else (an empty body) is "no mailbox". */
function readMailbox(data: unknown): EmailReceiptMailbox | null {
  return typeof data === 'object' && data !== null && 'id' in data ? (data as EmailReceiptMailbox) : null;
}

export const emailReceiptsApi = {
  mailbox: {
    /** `null` when the user has no mailbox: the server answers an empty body, never a 404. */
    get: async (): Promise<EmailReceiptMailbox | null> => {
      const response = await apiClient.get<unknown>(MAILBOX);
      return readMailbox(response.data);
    },

    /** Create or replace. The password goes only when the user typed one; it is never returned. */
    upsert: async (payload: UpsertEmailReceiptMailboxPayload): Promise<EmailReceiptMailbox> => {
      const response = await apiClient.put<EmailReceiptMailbox>(MAILBOX, payload);
      return response.data;
    },

    /** The settings an OAuth mailbox has (folder, enabled, AI mode, auto-apply). */
    updateSettings: async (payload: UpdateEmailReceiptMailboxSettingsPayload): Promise<EmailReceiptMailbox> => {
      const response = await apiClient.patch<EmailReceiptMailbox>(`${MAILBOX}/settings`, payload);
      return response.data;
    },

    remove: async (): Promise<void> => {
      await apiClient.delete(MAILBOX);
    },

    /** Test a draft (or, with an empty body, the stored settings) without saving. */
    test: async (payload: TestEmailReceiptMailboxPayload = {}): Promise<EmailReceiptMailboxTestResult> => {
      const response = await apiClient.post<EmailReceiptMailboxTestResult>(`${MAILBOX}/test`, payload);
      return response.data;
    },

    pollNow: async (): Promise<EmailReceiptPollResult> => {
      const response = await apiClient.post<EmailReceiptPollResult>(`${MAILBOX}/poll`);
      return response.data;
    },
  },

  oauth: {
    providers: async (): Promise<EmailReceiptOAuthProviders> => {
      const response = await apiClient.get<EmailReceiptOAuthProviders>(`${MAILBOX}/oauth/providers`);
      return response.data;
    },

    /** The provider's consent URL; the caller navigates the browser to it. */
    start: async (provider: EmailReceiptOAuthProvider): Promise<{ authorizationUrl: string }> => {
      const response = await apiClient.post<{ authorizationUrl: string }>(`${MAILBOX}/oauth/start`, { provider });
      return response.data;
    },

    /** Exchange the `code` and `state` the provider returned. Single use: a retry is refused. */
    complete: async (code: string, state: string): Promise<EmailReceiptMailbox> => {
      const response = await apiClient.post<EmailReceiptMailbox>(`${MAILBOX}/oauth/complete`, { code, state });
      return response.data;
    },

    /** Forget the stored token. The grant itself is revoked at the provider. */
    disconnect: async (): Promise<void> => {
      await apiClient.delete(`${MAILBOX}/oauth`);
    },
  },

  receipts: {
    list: async (status?: EmailReceiptStatus, limit?: number): Promise<EmailReceiptListItem[]> => {
      const params = { ...(status ? { status } : {}), ...(limit ? { limit } : {}) };
      const response = await apiClient.get<EmailReceiptListItem[]>(RECEIPTS, {
        params: Object.keys(params).length > 0 ? params : undefined,
      });
      return response.data;
    },

    get: async (id: string): Promise<EmailReceiptDetail> => {
      const response = await apiClient.get<EmailReceiptDetail>(`${RECEIPTS}/${id}`);
      return response.data;
    },

    reprocess: async (id: string): Promise<EmailReceiptDetail> => {
      const response = await apiClient.post<EmailReceiptDetail>(`${RECEIPTS}/${id}/reprocess`);
      return response.data;
    },

    link: async (id: string, transactionId: string): Promise<EmailReceiptDetail> => {
      const response = await apiClient.post<EmailReceiptDetail>(`${RECEIPTS}/${id}/link`, { transactionId });
      return response.data;
    },

    ignore: async (id: string): Promise<EmailReceiptDetail> => {
      const response = await apiClient.post<EmailReceiptDetail>(`${RECEIPTS}/${id}/ignore`);
      return response.data;
    },

    remove: async (id: string): Promise<void> => {
      await apiClient.delete(`${RECEIPTS}/${id}`);
    },

    /**
     * Queue an AI review request for the email, for its own transaction or the
     * one named. No provider is called: the request waits, pending, for the
     * assistant in the chat (or an MCP agent) to claim it by id.
     */
    askAi: async (id: string, transactionId?: string): Promise<EmailReceiptAskAiResult> => {
      const response = await apiClient.post<EmailReceiptAskAiResult>(
        `${RECEIPTS}/${id}/ask-ai`,
        transactionId === undefined ? {} : { transactionId },
      );
      return response.data;
    },

    /** A draft parser for the email's sender; it reads nothing until approved. */
    draftParser: async (id: string): Promise<EmailReceiptParser> => {
      const response = await apiClient.post<EmailReceiptParser>(`${RECEIPTS}/${id}/draft-parser`);
      return response.data;
    },
  },

  parsers: {
    list: async (): Promise<EmailReceiptParser[]> => {
      const response = await apiClient.get<EmailReceiptParser[]>(PARSERS);
      return response.data;
    },

    get: async (id: string): Promise<EmailReceiptParser> => {
      const response = await apiClient.get<EmailReceiptParser>(`${PARSERS}/${id}`);
      return response.data;
    },

    /** A parser a person wrote is approved on creation. */
    create: async (payload: CreateEmailReceiptParserPayload): Promise<EmailReceiptParser> => {
      const response = await apiClient.post<EmailReceiptParser>(PARSERS, payload);
      return response.data;
    },

    /** `expectedRevision` is a compare-and-swap: a parser that moved on answers 409. */
    update: async (id: string, payload: UpdateEmailReceiptParserPayload): Promise<EmailReceiptParser> => {
      const response = await apiClient.patch<EmailReceiptParser>(`${PARSERS}/${id}`, payload);
      return response.data;
    },

    remove: async (id: string): Promise<void> => {
      await apiClient.delete(`${PARSERS}/${id}`);
    },

    approve: async (id: string, expectedRevision?: number): Promise<EmailReceiptParser> => {
      const response = await apiClient.post<EmailReceiptParser>(
        `${PARSERS}/${id}/approve`,
        expectedRevision === undefined ? {} : { expectedRevision },
      );
      return response.data;
    },

    /** Read a stored email with a definition that is not saved; writes nothing. */
    test: async (payload: TestEmailReceiptParserPayload): Promise<EmailReceiptParserTestResult> => {
      const response = await apiClient.post<EmailReceiptParserTestResult>(`${PARSERS}/test`, payload);
      return response.data;
    },
  },
};
