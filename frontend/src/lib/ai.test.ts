import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { aiApi } from './ai';

// Mock the apiClient
vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  attemptTokenRefresh: vi.fn(),
}));

vi.mock('js-cookie', () => ({
  default: {
    get: vi.fn().mockReturnValue('csrf-test-token'),
  },
}));

import apiClient, { attemptTokenRefresh } from './api';

describe('aiApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getStatus()', () => {
    it('calls GET /ai/status', async () => {
      const mockData = { configured: true, encryptionAvailable: true, activeProviders: 1 };
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockData });

      const result = await aiApi.getStatus();

      expect(apiClient.get).toHaveBeenCalledWith('/ai/status');
      expect(result).toEqual(mockData);
    });
  });

  describe('getConfigs()', () => {
    it('calls GET /ai/configs', async () => {
      const mockData = [{ id: 'c1', provider: 'anthropic' }];
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockData });

      const result = await aiApi.getConfigs();

      expect(apiClient.get).toHaveBeenCalledWith('/ai/configs');
      expect(result).toEqual(mockData);
    });
  });

  describe('createConfig()', () => {
    it('calls POST /ai/configs with data', async () => {
      const input = { provider: 'anthropic' as const, apiKey: 'sk-key' };
      const mockData = { id: 'c1', provider: 'anthropic' };
      vi.mocked(apiClient.post).mockResolvedValue({ data: mockData });

      const result = await aiApi.createConfig(input);

      expect(apiClient.post).toHaveBeenCalledWith('/ai/configs', input);
      expect(result).toEqual(mockData);
    });
  });

  describe('updateConfig()', () => {
    it('calls PATCH /ai/configs/:id with data', async () => {
      const input = { model: 'gpt-4o' };
      const mockData = { id: 'c1', model: 'gpt-4o' };
      vi.mocked(apiClient.patch).mockResolvedValue({ data: mockData });

      const result = await aiApi.updateConfig('c1', input);

      expect(apiClient.patch).toHaveBeenCalledWith('/ai/configs/c1', input);
      expect(result).toEqual(mockData);
    });
  });

  describe('deleteConfig()', () => {
    it('calls DELETE /ai/configs/:id', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });

      await aiApi.deleteConfig('c1');

      expect(apiClient.delete).toHaveBeenCalledWith('/ai/configs/c1');
    });
  });

  describe('testConnection()', () => {
    it('calls POST /ai/configs/:id/test', async () => {
      const mockData = { available: true };
      vi.mocked(apiClient.post).mockResolvedValue({ data: mockData });

      const result = await aiApi.testConnection('c1');

      expect(apiClient.post).toHaveBeenCalledWith('/ai/configs/c1/test');
      expect(result).toEqual(mockData);
    });
  });

  describe('getUsage()', () => {
    it('calls GET /ai/usage without params when days not specified', async () => {
      const mockData = { totalRequests: 5 };
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockData });

      const result = await aiApi.getUsage();

      expect(apiClient.get).toHaveBeenCalledWith('/ai/usage', { params: {} });
      expect(result).toEqual(mockData);
    });

    it('passes days parameter when specified', async () => {
      const mockData = { totalRequests: 3 };
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockData });

      const result = await aiApi.getUsage(30);

      expect(apiClient.get).toHaveBeenCalledWith('/ai/usage', { params: { days: 30 } });
      expect(result).toEqual(mockData);
    });
  });

  describe('testDraft()', () => {
    it('posts to /ai/configs/test-draft', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { available: true } });
      const draft = { provider: 'anthropic', apiKey: 'sk-test' };
      await aiApi.testDraft(draft as any);
      expect(apiClient.post).toHaveBeenCalledWith('/ai/configs/test-draft', draft);
    });
  });

  describe('query()', () => {
    it('posts to /ai/query with 120s timeout and conversation history', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { answer: 'response' } });
      const history = [{ role: 'user' as const, content: 'prev' }];
      await aiApi.query('hello', history);
      expect(apiClient.post).toHaveBeenCalledWith(
        '/ai/query',
        { query: 'hello', conversationHistory: history },
        { timeout: 120000 },
      );
    });

    it('omits conversationHistory when undefined', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: {} });
      await aiApi.query('hi');
      expect(apiClient.post).toHaveBeenCalledWith(
        '/ai/query',
        { query: 'hi', conversationHistory: undefined },
        { timeout: 120000 },
      );
    });

    it('includes attachments in the body when provided', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: {} });
      const attachments = [
        { kind: 'image' as const, mediaType: 'image/png', filename: 'r.png', data: 'AAAA' },
      ];
      await aiApi.query('hi', undefined, attachments);
      expect(apiClient.post).toHaveBeenCalledWith(
        '/ai/query',
        { query: 'hi', conversationHistory: undefined, attachments },
        { timeout: 120000 },
      );
    });
  });

  describe('insights', () => {
    it('getInsights without params calls /ai/insights with empty queryParams', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: { insights: [] } });
      await aiApi.getInsights();
      expect(apiClient.get).toHaveBeenCalledWith('/ai/insights', { params: {} });
    });

    it('getInsights forwards type, severity, and includeDismissed flag', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: { insights: [] } });
      await aiApi.getInsights({
        type: 'spending_anomaly' as any,
        severity: 'high' as any,
        includeDismissed: true,
      });
      expect(apiClient.get).toHaveBeenCalledWith('/ai/insights', {
        params: {
          type: 'spending_anomaly',
          severity: 'high',
          includeDismissed: 'true',
        },
      });
    });

    it('getInsights omits includeDismissed when false', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: { insights: [] } });
      await aiApi.getInsights({ includeDismissed: false });
      const params = vi.mocked(apiClient.get).mock.calls[0][1]!.params;
      expect(params.includeDismissed).toBeUndefined();
    });

    it('generateInsights posts to /ai/insights/generate', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: undefined });
      await aiApi.generateInsights();
      expect(apiClient.post).toHaveBeenCalledWith('/ai/insights/generate');
    });

    it('dismissInsight patches /ai/insights/:id/dismiss', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({ data: undefined });
      await aiApi.dismissInsight('i-1');
      expect(apiClient.patch).toHaveBeenCalledWith('/ai/insights/i-1/dismiss');
    });
  });

  describe('queryStream()', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function makeBodyStream(events: string[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i >= events.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(events[i]));
          i++;
        },
      });
    }

    it('returns an AbortController and parses streamed events', async () => {
      const sse =
        'data: {"type":"thinking","message":"working"}\n\n' +
        'data: {"type":"content","text":"hello"}\n\n' +
        'data: {"type":"done"}\n\n';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: makeBodyStream([sse]),
      });
      globalThis.fetch = mockFetch as any;

      const events: any[] = [];
      let done = false;
      const controller = aiApi.queryStream(
        'q',
        {
          onEvent: (e) => events.push(e),
          onDone: () => {
            done = true;
          },
          onError: () => {},
        },
        [],
      );

      // Allow the async stream loop to drain
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(controller).toBeInstanceOf(AbortController);
      expect(events.map((e) => e.type)).toEqual(['thinking', 'content', 'done']);
      expect(done).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/ai/query/stream', expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-CSRF-Token': 'csrf-test-token',
        }),
      }));
    });

    it('includes attachments in the request body on the direct path', async () => {
      const sse = 'data: {"type":"done"}\n\n';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: makeBodyStream([sse]),
      });
      globalThis.fetch = mockFetch as any;

      const attachments = [
        { kind: 'image' as const, mediaType: 'image/png', filename: 'r.png', data: 'AAAA' },
      ];
      aiApi.queryStream('q', { onEvent: () => {} }, [], undefined, attachments);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/ai/query/stream');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.attachments).toEqual(attachments);
    });

    it('includes attachments on the relay path', async () => {
      const sse = 'data: {"type":"done"}\n\n';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: makeBodyStream([sse]),
      });
      globalThis.fetch = mockFetch as any;

      const attachments = [
        { kind: 'image' as const, mediaType: 'image/png', filename: 'r.png', data: 'AAAA' },
      ];
      aiApi.queryStream('q', { onEvent: () => {} }, [], { relay: true }, attachments);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The backend stores them and exposes each to the agent as an
      // monize-attachment:// MCP resource, so they ride the relay path too.
      expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/ai/relay/query/stream');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.attachments).toEqual(attachments);
    });

    it('retries the request after a token refresh on 401', async () => {
      vi.mocked(attemptTokenRefresh).mockResolvedValue(true);

      const sse = 'data: {"type":"done"}\n\n';
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve('') })
        .mockResolvedValueOnce({ ok: true, status: 200, body: makeBodyStream([sse]) });
      globalThis.fetch = mockFetch as any;

      const events: any[] = [];
      aiApi.queryStream('q', {
        onEvent: (e) => events.push(e),
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(attemptTokenRefresh).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(events).toEqual([{ type: 'done' }]);
    });

    it('reports an error when the response is not ok and refresh did not happen', async () => {
      vi.mocked(attemptTokenRefresh).mockResolvedValue(false);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('{"message":"boom"}'),
      });
      globalThis.fetch = mockFetch as any;

      let captured: Error | null = null;
      aiApi.queryStream('q', {
        onEvent: () => {},
        onError: (err) => {
          captured = err;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(captured).toBeInstanceOf(Error);
      expect(captured!.message).toBe('boom');
    });

    it('reports an error when the response is not ok and message body is invalid JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('not json'),
      });
      globalThis.fetch = mockFetch as any;

      let captured: Error | null = null;
      aiApi.queryStream('q', {
        onEvent: () => {},
        onError: (err) => {
          captured = err;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(captured).toBeInstanceOf(Error);
      expect(captured!.message).toBe('Request failed: 500');
    });

    it('reports an error when there is no response body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: null,
      });
      globalThis.fetch = mockFetch as any;

      let captured: Error | null = null;
      aiApi.queryStream('q', {
        onEvent: () => {},
        onError: (err) => {
          captured = err;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(captured!.message).toBe('No response body');
    });

    it('skips malformed JSON inside data lines without crashing', async () => {
      const sse =
        'data: {bad json}\n\n' +
        'data: {"type":"done"}\n\n';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: makeBodyStream([sse]),
      });
      globalThis.fetch = mockFetch as any;

      const events: any[] = [];
      aiApi.queryStream('q', {
        onEvent: (e) => events.push(e),
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual([{ type: 'done' }]);
    });

    it('does not call onError when the user aborts', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });
      globalThis.fetch = mockFetch as any;

      let errorCalled = false;
      aiApi.queryStream('q', {
        onEvent: () => {},
        onError: () => {
          errorCalled = true;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(errorCalled).toBe(false);
    });

    it('calls onError for non-abort fetch failures', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));

      let captured: Error | null = null;
      aiApi.queryStream('q', {
        onEvent: () => {},
        onError: (err) => {
          captured = err;
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(captured!.message).toBe('network down');
    });
  });
});
